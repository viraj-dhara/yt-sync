// MARK: - Injection Guard

// Injection Guard: Check if the content script is already loaded and active.
// When an extension is reloaded or updated, the previous extension context is invalidated.
// Standard content script files still exist on the tab, but attempting to communicate via chrome.runtime throws errors.
// This guard ensures that we only skip initialization if a fully valid, connected script is already running.
var shouldInitialize = true;
if (window.hasYouTubeSyncLoaded) {
  try {
    // If checkYouTubeSyncContext() throws an error (e.g. "Extension context invalidated"),
    // it indicates the previous script instance is dead, and we should proceed with re-initializing.
    if (window.checkYouTubeSyncContext && window.checkYouTubeSyncContext()) {
      console.log('YouTube Sync content script already loaded and active.');
      shouldInitialize = false;
    }
  } catch (e) {
    // Context invalidated, proceed with initialization
  }
}

if (shouldInitialize) {
  window.hasYouTubeSyncLoaded = true;
  // Expose a check function on window. Under a new injection, this function binds to the new context.
  // When called by a future injection, it will run using the context it was created in,
  // throwing an error if that context is no longer active.
  window.checkYouTubeSyncContext = () => {
    return !!(typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id);
  };
  (async () => {
    console.log('YouTube Sync content script loaded.');

    // Clean up any stale prefixes left from previous invalid injections before starting
    try {
      const syncingPrefix = "SYNCING - ";
      const pausedPrefix = "PAUSED - ";
      if (document.title.startsWith(syncingPrefix)) {
        document.title = document.title.substring(syncingPrefix.length);
      } else if (document.title.startsWith(pausedPrefix)) {
        document.title = document.title.substring(pausedPrefix.length);
      }
    } catch (e) { }

    // MARK: - Timing & Synchronization Configs
    const CONFIG = {
      DOM_POLL_INTERVAL: 500,        // Interval (ms) to check and sync Follower state
      HOST_BROADCAST_INTERVAL: 500,  // Interval (ms) to send periodic sync updates as Host
      THROTTLE_THRESHOLD: 200,       // Minimum duration (ms) between consecutive periodic Host updates
      DRIFT_THRESHOLD: 0.5,         // Acceptable playhead difference (s) before forcing a seek on Follower
      FOLLOWER_SYNC_THROTTLE: 1000   // Minimum duration (ms) between consecutive sync applications to Follower video
    };

    // MARK: - State Variables
    let isInitialized = false;
    let isActiveSyncTab = false;
    let keepAlivePort = null;
    let videoObserver = null;

    let videoElement = null;
    let lastSentState = {
      url: '',
      state: '',
      time: -1
    };
    let lastHostStatePayload = null;
    let lastSentTimestamp = 0;
    let lastHostStateWsReceivedAt = 0;
    let isLocalFollowerPaused = false;
    let isApplyingSync = false;
    let lastFollowerSyncedAt = 0;

    let checkInterval = null;
    let hostInterval = null;

    // Page load & navigation transition tracking for Follower jitter prevention
    let currentUrl = window.location.href;
    let urlChangedAt = document.readyState !== 'complete' ? Date.now() : 0;
    let isNavigating = document.readyState !== 'complete';

    // Synchronous role tracking to resolve Follower pause event race condition
    let currentRole = 'follower';
    chrome.storage.local.get('role').then(({ role = 'follower' }) => {
      currentRole = role;
    });

    function handleStorageChange(changes, areaName) {
      if (areaName === 'local') {
        if (changes.role) {
          currentRole = changes.role.newValue || 'follower';
          if (currentRole === 'host') {
            isLocalFollowerPaused = false;
          }
        }
        if (changes.enabled) {
          if (changes.enabled.newValue) {
            initialize();
          } else {
            teardown();
          }
        }

        // Listen to configuration changes and trigger hot reload of intervals
        const configKeys = [
          'domPollInterval',
          'hostBroadcastInterval',
          'throttleThreshold',
          'driftThreshold',
          'followerSyncThrottle'
        ];
        const hasConfigChange = configKeys.some(key => changes[key] !== undefined);
        if (hasConfigChange) {
          syncConfigurations(true);
        }
      }
    }

    async function syncConfigurations(shouldRestartIntervals = false) {
      try {
        const data = await chrome.storage.local.get([
          'domPollInterval',
          'hostBroadcastInterval',
          'throttleThreshold',
          'driftThreshold',
          'followerSyncThrottle'
        ]);

        let hasIntervalChange = false;

        if (data.domPollInterval !== undefined && data.domPollInterval !== CONFIG.DOM_POLL_INTERVAL) {
          CONFIG.DOM_POLL_INTERVAL = data.domPollInterval;
          hasIntervalChange = true;
        }
        if (data.hostBroadcastInterval !== undefined && data.hostBroadcastInterval !== CONFIG.HOST_BROADCAST_INTERVAL) {
          CONFIG.HOST_BROADCAST_INTERVAL = data.hostBroadcastInterval;
          hasIntervalChange = true;
        }

        if (data.throttleThreshold !== undefined) CONFIG.THROTTLE_THRESHOLD = data.throttleThreshold;
        if (data.driftThreshold !== undefined) CONFIG.DRIFT_THRESHOLD = data.driftThreshold;
        if (data.followerSyncThrottle !== undefined) CONFIG.FOLLOWER_SYNC_THROTTLE = data.followerSyncThrottle;

        if (shouldRestartIntervals && hasIntervalChange && isInitialized) {
          console.log('[YouTube Sync] Timing settings changed. Hot-reloading active intervals...');
          startOrRestartIntervals();
        }
      } catch (err) {
        // Suppress errors when context invalidated
      }
    }

    function startOrRestartIntervals() {
      // 1. Follower Check Interval
      if (checkInterval) clearInterval(checkInterval);
      checkInterval = setInterval(async () => {
        if (!chrome.runtime?.id) {
          teardown();
          return;
        }
        try {
          if (window.location.href !== currentUrl) {
            console.log(`[YouTube Sync] URL change detected in poll. Old: ${currentUrl}, New: ${window.location.href}`);
            currentUrl = window.location.href;
            urlChangedAt = Date.now();
            isNavigating = true;
          }

          if (currentRole === 'follower' && isActiveSyncTab) {
            const isWaitingAfterUrlChange = (Date.now() - urlChangedAt < 2000) ||
              (document.readyState !== 'complete') ||
              (isNavigating && (Date.now() - urlChangedAt < 10000));

            if (!isWaitingAfterUrlChange) {
              const video = findVideoElement();
              if (video) {
                const isHostActiveAndPlaying = lastHostStatePayload &&
                  lastHostStatePayload.state === 'playing' &&
                  (Date.now() - lastHostStateWsReceivedAt < 10000);

                if (!video.paused && !isHostActiveAndPlaying) {
                  console.log('[YouTube Sync] Automatically pausing follower tab: no active playing host.');
                  video.pause();
                } else if (lastHostStatePayload) {
                  applyFollowerSync(lastHostStatePayload, lastHostStateWsReceivedAt);
                }
              }
            }
          }
        } catch (err) {
          if (err.message.includes('Extension context invalidated')) {
            teardown();
          } else {
            console.error(err);
          }
        }
      }, CONFIG.DOM_POLL_INTERVAL);

      // 2. Host Broadcast Interval
      if (hostInterval) clearInterval(hostInterval);
      hostInterval = setInterval(async () => {
        if (!chrome.runtime?.id) {
          teardown();
          return;
        }
        try {
          if (currentRole === 'host') {
            sendHostState('periodic');
          }
        } catch (err) {
          if (err.message.includes('Extension context invalidated')) {
            teardown();
          } else {
            console.error(err);
          }
        }
      }, CONFIG.HOST_BROADCAST_INTERVAL);
    }

    // Connect persistent keep-alive port
    function connectKeepAlive() {
      if (!isInitialized || !chrome.runtime?.id) return;
      if (keepAlivePort) return;

      try {
        keepAlivePort = chrome.runtime.connect({ name: 'yt-sync-keepalive' });
        keepAlivePort.onDisconnect.addListener(() => {
          keepAlivePort = null;
          if (isInitialized) {
            setTimeout(connectKeepAlive, 5000);
          }
        });
      } catch (e) {
        console.warn('[YouTube Sync] Failed to connect keepalive port:', e.message);
      }
    }

    // MutationObserver to watch for video element insertion
    function startObservingVideo() {
      if (videoObserver) return;
      const target = document.querySelector('ytd-player') || document.body;
      if (!target) return;

      const video = document.querySelector('video');
      if (video) {
        findVideoElement();
        return;
      }

      videoObserver = new MutationObserver((mutations, obs) => {
        const video = document.querySelector('video');
        if (video) {
          console.log('[YouTube Sync] Video element detected via MutationObserver.');
          findVideoElement();
          obs.disconnect();
          videoObserver = null;
        }
      });
      videoObserver.observe(target, { childList: true, subtree: true });
    }

    // Find the video element on the page
    function findVideoElement() {
      if (videoElement && document.body.contains(videoElement)) {
        return videoElement;
      }
      videoElement = document.querySelector('video');
      if (videoElement) {
        setupEventListeners();
      }
      return videoElement;
    }

    // Setup listeners on the video element
    function setupEventListeners() {
      if (!videoElement) return;

      // Remove any existing listeners first to prevent duplicates
      videoElement.removeEventListener('play', handleVideoEvent);
      videoElement.removeEventListener('pause', handleVideoEvent);
      videoElement.removeEventListener('seeked', handleVideoEvent);

      videoElement.addEventListener('play', handleVideoEvent);
      videoElement.addEventListener('pause', handleVideoEvent);
      videoElement.addEventListener('seeked', handleVideoEvent);
    }

    // MARK: - Host State Extraction & Reporting

    function handleVideoEvent(e) {
      try {
        if (isApplyingSync) return; // Prevent loopbacks from remote sync events

        if (currentRole !== 'host') {
          // If we are a follower, capture user play/pause clicks to manage local override
          if (e && (e.type === 'play' || e.type === 'pause')) {
            if (e.type === 'pause') {
              const isHostActiveAndPlaying = lastHostStatePayload &&
                lastHostStatePayload.state === 'playing' &&
                (Date.now() - lastHostStateWsReceivedAt < 10000);
              if (isHostActiveAndPlaying) {
                isLocalFollowerPaused = true;
                console.log('Follower locally paused playback.');
              }
            } else if (e.type === 'play') {
              isLocalFollowerPaused = false;
              console.log('Follower locally resumed playback, re-syncing...');
              // Immediately sync back to the last known host state
              if (lastHostStatePayload) {
                applyFollowerSync(lastHostStatePayload, lastHostStateWsReceivedAt);
              }
            }
          }
          return;
        }

        sendHostState(e ? e.type : 'periodic');
      } catch (err) {
        // Suppress extension context invalidated errors
      }
    }

    function sendHostState(trigger = 'periodic') {
      const video = findVideoElement();
      if (!video) return;

      const currentUrl = window.location.href;
      const currentState = video.paused ? 'paused' : 'playing';
      const currentTime = video.currentTime;

      // Throttle periodic updates to once per threshold to prevent redundant packets
      if (trigger === 'periodic' && (Date.now() - lastSentTimestamp < CONFIG.THROTTLE_THRESHOLD)) {
        return;
      }

      lastSentState = { url: currentUrl, state: currentState, time: currentTime };
      lastSentTimestamp = Date.now();

      chrome.runtime.sendMessage({
        type: 'hostStateUpdate',
        payload: {
          currentUrl,
          state: currentState,
          currentTime,
          sentAt: lastSentTimestamp
        }
      }).catch((err) => {
        console.error('Error sending host state update:', err);
      });
    }

    // MARK: - YouTube Navigation Listeners
    
    function handleNavigationEvent() {
      handleVideoEvent({ type: 'navigate' });
    }

    function handleNavigationStart() {
      isNavigating = true;
      urlChangedAt = Date.now();
      currentUrl = window.location.href;
      console.log('[YouTube Sync] YouTube navigation started. URL:', currentUrl);
    }

    function handleNavigationFinish() {
      isNavigating = false;
      console.log('[YouTube Sync] YouTube navigation finished.');
      if (isInitialized) {
        findVideoElement();
        startObservingVideo();
        handleNavigationEvent();
      }
    }

    function handleWindowLoad() {
      isNavigating = false;
      console.log('[YouTube Sync] Page load complete.');
    }

    // MARK: - Extension Message Receivers
    
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message.type === 'syncPlayback') {
        lastHostStatePayload = message.payload;
        lastHostStateWsReceivedAt = message.wsReceivedAt;
        if (isInitialized && isActiveSyncTab) {
          applyFollowerSync(message.payload, message.wsReceivedAt);
        }
        sendResponse({ ack: true });
      } else if (message.type === 'setActiveSyncTab') {
        isActiveSyncTab = message.isActive;
        if (isInitialized) {
          updateTabTitle(isActiveSyncTab);
          if (isActiveSyncTab) {
            findVideoElement();
            startObservingVideo();
            if (currentRole === 'follower' && lastHostStatePayload) {
              applyFollowerSync(lastHostStatePayload, lastHostStateWsReceivedAt);
            }
          }
        }
        sendResponse({ ack: true });
      } else if (message.type === 'teardown') {
        teardown();
        sendResponse({ ack: true });
      } else if (message.type === 'getIsLocallyPaused') {
        sendResponse({ isLocallyPaused: isLocalFollowerPaused });
      } else if (message.type === 'showDemotionNotification') {
        if (isInitialized) {
          showDemotionToast();
        }
        sendResponse({ ack: true });
      }
      return true;
    });

    // MARK: - User Interface Toast Helpers
    function showDemotionToast() {
      let toast = document.getElementById('yt-sync-demotion-toast');
      if (toast) toast.remove();

      toast = document.createElement('div');
      toast.id = 'yt-sync-demotion-toast';
      toast.style.position = 'fixed';
      toast.style.bottom = '24px';
      toast.style.right = '24px';
      toast.style.backgroundColor = '#ef4444';
      toast.style.color = '#ffffff';
      toast.style.padding = '12px 20px';
      toast.style.borderRadius = '8px';
      toast.style.fontFamily = 'sans-serif';
      toast.style.fontSize = '14px';
      toast.style.fontWeight = '600';
      toast.style.boxShadow = '0 10px 15px -3px rgba(0, 0, 0, 0.3), 0 4px 6px -2px rgba(0, 0, 0, 0.05)';
      toast.style.zIndex = '999999';
      toast.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(20px)';
      toast.style.display = 'flex';
      toast.style.alignItems = 'center';
      toast.style.gap = '12px';

      const icon = document.createElement('span');
      icon.textContent = '⚠️';
      icon.style.fontSize = '18px';
      toast.appendChild(icon);

      const text = document.createElement('span');
      text.textContent = 'Demoted to Follower (another Host connected)';
      toast.appendChild(text);

      const closeBtn = document.createElement('button');
      closeBtn.textContent = '✕';
      closeBtn.style.background = 'none';
      closeBtn.style.border = 'none';
      closeBtn.style.color = '#ffffff';
      closeBtn.style.cursor = 'pointer';
      closeBtn.style.fontSize = '16px';
      closeBtn.style.padding = '0 4px';
      closeBtn.addEventListener('click', () => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(20px)';
        setTimeout(() => toast.remove(), 300);
      });
      toast.appendChild(closeBtn);

      document.body.appendChild(toast);

      setTimeout(() => {
        toast.style.opacity = '1';
        toast.style.transform = 'translateY(0)';
      }, 50);

      setTimeout(() => {
        if (document.body.contains(toast)) {
          toast.style.opacity = '0';
          toast.style.transform = 'translateY(20px)';
          setTimeout(() => toast.remove(), 300);
        }
      }, 6000);
    }

    // MARK: - Follower Synchronization Logic
    function applyFollowerSync(payload, wsReceivedAt = null) {
      const video = findVideoElement();
      if (!video) return;

      // Jitter prevention: wait at least 2 seconds and until page loads after URL change/init
      const timeSinceUrlChange = Date.now() - urlChangedAt;
      if (timeSinceUrlChange < 2000 || document.readyState !== 'complete' || (isNavigating && timeSinceUrlChange < 10000)) {
        return;
      }

      // Cooldown throttle: do not apply sync mutations more than once per second
      if (Date.now() - lastFollowerSyncedAt < CONFIG.FOLLOWER_SYNC_THROTTLE) {
        return;
      }

      const { state, currentTime, sentAt, updatedAt } = payload;

      // If the Follower has locally paused, and the Host is playing, do not enforce the playback state or seek
      if (isLocalFollowerPaused && state === 'playing') {
        return;
      }

      let didMutate = false;

      isApplyingSync = true;
      try {
        // 1. Sync play/pause state
        if (state === 'playing' && video.paused) {
          didMutate = true;
          video.play().catch((e) => {
            console.log('Playback start prevented:', e);
          });
        } else if (state === 'paused' && !video.paused) {
          didMutate = true;
          video.pause();
        }

        // 2. Sync elapsed time (accounting for network latency/drift)
        let targetTime = currentTime;
        if (state === 'playing') {
          if (wsReceivedAt) {
            const localDelay = (Date.now() - wsReceivedAt) / 1000;
            targetTime += localDelay;
          } else {
            const referenceTime = sentAt || updatedAt;
            const latencySeconds = referenceTime ? (Date.now() - referenceTime) / 1000 : 0;
            targetTime += latencySeconds;
          }
        }

        const drift = Math.abs(video.currentTime - targetTime);
        if (drift > CONFIG.DRIFT_THRESHOLD) {
          console.log(`Syncing time. Drift: ${drift.toFixed(2)}s. Seeking to: ${targetTime.toFixed(2)}s`);
          video.currentTime = targetTime;
          didMutate = true;
        }
      } finally {
        setTimeout(() => {
          isApplyingSync = false;
        }, 100);
      }

      if (didMutate) {
        lastFollowerSyncedAt = Date.now();
      }
    }

    // MARK: - Teardown and Title Management
    function updateTabTitle(syncActive) {
      try {
        const syncingPrefix = "SYNCING - ";
        const pausedPrefix = "PAUSED - ";
        const hasSyncing = document.title.startsWith(syncingPrefix);
        const hasPaused = document.title.startsWith(pausedPrefix);

        if (syncActive) {
          if (isLocalFollowerPaused) {
            if (hasSyncing) {
              document.title = pausedPrefix + document.title.substring(syncingPrefix.length);
            } else if (!hasPaused) {
              document.title = pausedPrefix + document.title;
            }
          } else {
            if (hasPaused) {
              document.title = syncingPrefix + document.title.substring(pausedPrefix.length);
            } else if (!hasSyncing) {
              document.title = syncingPrefix + document.title;
            }
          }
        } else {
          if (hasSyncing) {
            document.title = document.title.substring(syncingPrefix.length);
          } else if (hasPaused) {
            document.title = document.title.substring(pausedPrefix.length);
          }
        }
      } catch (e) {
        // Suppress extension context errors
      }
    }

    async function initialize() {
      if (isInitialized) return;
      
      const { enabled = false } = await chrome.storage.local.get('enabled');
      if (!enabled) return;
      
      isInitialized = true;
      console.log('[YouTube Sync] Initializing active content script state...');
      
      await syncConfigurations(false);
      startOrRestartIntervals();
      connectKeepAlive();
      
      // Determine if we are the active sync tab upon init
      const response = await chrome.runtime.sendMessage({ type: 'checkIsSyncingTab' }).catch(() => null);
      isActiveSyncTab = response ? response.isSyncing : false;
      
      if (isActiveSyncTab) {
        updateTabTitle(true);
        findVideoElement();
        startObservingVideo();
      }
    }

    function teardown() {
      if (!isInitialized) return;
      isInitialized = false;
      console.log('Teardown YouTube Sync content script...');

      // Disconnect keepalive port
      if (keepAlivePort) {
        try { keepAlivePort.disconnect(); } catch (e) {}
        keepAlivePort = null;
      }

      // Clear intervals
      if (checkInterval) clearInterval(checkInterval);
      if (hostInterval) clearInterval(hostInterval);

      // Disconnect MutationObserver
      if (videoObserver) {
        videoObserver.disconnect();
        videoObserver = null;
      }

      // Remove video event listeners
      if (videoElement) {
        try {
          videoElement.removeEventListener('play', handleVideoEvent);
          videoElement.removeEventListener('pause', handleVideoEvent);
          videoElement.removeEventListener('seeked', handleVideoEvent);
          videoElement.hasSyncListeners = false;
        } catch (e) { }
      }

      // Remove active demotion toast
      try {
        const toast = document.getElementById('yt-sync-demotion-toast');
        if (toast) toast.remove();
      } catch (e) { }

      // Restore title
      isLocalFollowerPaused = false;
      updateTabTitle(false);
    }

    // Register persistence listeners & run initialization
    chrome.storage.onChanged.addListener(handleStorageChange);
    document.addEventListener('yt-navigate-start', handleNavigationStart);
    document.addEventListener('yt-navigate-finish', handleNavigationFinish);
    window.addEventListener('load', handleWindowLoad);

    // Initial check
    initialize();
  })();
}
