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

    // MARK: - Timing & Synchronization Configs
    const CONFIG = {
      DOM_POLL_INTERVAL: 150,        // Interval (ms) to check for video elements & sync Follower state
      HOST_BROADCAST_INTERVAL: 500,  // Interval (ms) to send periodic sync updates as Host
      THROTTLE_THRESHOLD: 150,       // Minimum duration (ms) between consecutive periodic Host updates
      DRIFT_THRESHOLD: 0.15,         // Acceptable playhead difference (s) before forcing a seek on Follower
      KEEP_ALIVE_INTERVAL: 1000     // Interval (ms) to ping background page for keep-alive
    };

    // MARK: - State Variables
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
    let isProgrammaticAction = false;

    // Page load & navigation transition tracking for Follower jitter prevention
    let currentUrl = window.location.href;
    let urlChangedAt = document.readyState !== 'complete' ? Date.now() : 0;
    let isNavigating = document.readyState !== 'complete';

    // MARK: - DOM Elements & Event Setups
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

    // Setup listeners on the video element for Host mode
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

    // Check and report state if we are the host
    async function handleVideoEvent(e) {
      try {
        const { role = 'follower' } = await chrome.storage.local.get('role');
        if (role !== 'host') {
          // If we are a follower, capture user play/pause clicks to manage local override
          if (e && (e.type === 'play' || e.type === 'pause')) {
            if (isProgrammaticAction) {
              isProgrammaticAction = false;
              return;
            }
            if (e.type === 'pause') {
              isLocalFollowerPaused = true;
              console.log('Follower locally paused playback.');
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

    // MARK: - Periodic Status Check Pollers

    // Keep looking for video elements periodically and check sync status for followers
    const checkInterval = setInterval(async () => {
      if (!chrome.runtime?.id) {
        clearInterval(checkInterval);
        return;
      }
      try {
        // Backup URL change detection
        if (window.location.href !== currentUrl) {
          console.log(`[YouTube Sync] URL change detected in poll. Old: ${currentUrl}, New: ${window.location.href}`);
          currentUrl = window.location.href;
          urlChangedAt = Date.now();
          isNavigating = true;
        }

        // Check if this tab is actively syncing and update title accordingly
        const response = await chrome.runtime.sendMessage({ type: 'checkIsSyncingTab' }).catch(() => null);
        const syncActive = response ? response.isSyncing : false;

        const { role = 'follower' } = await chrome.storage.local.get('role');
        if (role === 'host') {
          isLocalFollowerPaused = false;
        }
        updateTabTitle(syncActive);

        const video = findVideoElement();
        if (video) {
          if (!video.hasSyncListeners) {
            setupEventListeners();
            video.hasSyncListeners = true;
          }
          if (role === 'follower' && lastHostStatePayload) {
            applyFollowerSync(lastHostStatePayload, lastHostStateWsReceivedAt);
          }
        }
      } catch (err) {
        if (err.message.includes('Extension context invalidated')) {
          clearInterval(checkInterval);
        } else {
          console.error(err);
        }
      }
    }, CONFIG.DOM_POLL_INTERVAL);

    // Send periodic sync state if we are the host
    const hostInterval = setInterval(async () => {
      if (!chrome.runtime?.id) {
        clearInterval(hostInterval);
        return;
      }
      try {
        const { role = 'follower' } = await chrome.storage.local.get('role');
        if (role === 'host') {
          sendHostState('periodic');
        }
      } catch (err) {
        if (err.message.includes('Extension context invalidated')) {
          clearInterval(hostInterval);
        } else {
          console.error(err);
        }
      }
    }, CONFIG.HOST_BROADCAST_INTERVAL);

    // MARK: - YouTube Navigation Listeners
    // Listen to custom YouTube navigation events to capture URL transitions
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
      handleNavigationEvent();
    }

    function handleWindowLoad() {
      isNavigating = false;
      console.log('[YouTube Sync] Page load complete.');
    }

    document.addEventListener('yt-navigate-start', handleNavigationStart);
    document.addEventListener('yt-navigate-finish', handleNavigationFinish);
    window.addEventListener('load', handleWindowLoad);


    // MARK: - Extension Message Receivers
    // Listen to sync messages from the background service worker (for Followers)
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message.type === 'syncPlayback') {
        lastHostStatePayload = message.payload;
        lastHostStateWsReceivedAt = message.wsReceivedAt;
        applyFollowerSync(message.payload, message.wsReceivedAt);
        sendResponse({ ack: true });
      } else if (message.type === 'teardown') {
        teardown();
        sendResponse({ ack: true });
      } else if (message.type === 'getIsLocallyPaused') {
        sendResponse({ isLocallyPaused: isLocalFollowerPaused });
      }
      return true;
    });

    // MARK: - Follower Synchronization Logic
    // Apply playback and time synchronization
    function applyFollowerSync(payload, wsReceivedAt = null) {
      const video = findVideoElement();
      if (!video) return;

      // Jitter prevention: wait at least 2 seconds and until page loads after URL change/init
      const timeSinceUrlChange = Date.now() - urlChangedAt;
      if (timeSinceUrlChange < 2000 || document.readyState !== 'complete' || (isNavigating && timeSinceUrlChange < 10000)) {
        return;
      }

      const { state, currentTime, sentAt, updatedAt } = payload;

      // If the Follower has locally paused, and the Host is playing, do not enforce the playback state or seek
      if (isLocalFollowerPaused && state === 'playing') {
        return;
      }

      // 1. Sync play/pause state
      if (state === 'playing' && video.paused) {
        isProgrammaticAction = true;
        video.play()
          .then(() => {
            setTimeout(() => { isProgrammaticAction = false; }, 150);
          })
          .catch((e) => {
            isProgrammaticAction = false;
            console.log('Playback start prevented:', e);
          });
      } else if (state === 'paused' && !video.paused) {
        isProgrammaticAction = true;
        video.pause();
        setTimeout(() => { isProgrammaticAction = false; }, 150);
      }

      // 2. Sync elapsed time (accounting for latency/drift)
      let targetTime = currentTime;
      if (state === 'playing') {
        if (wsReceivedAt) {
          // Calculate delay relative to local receipt time (which already includes network transit)
          const localDelay = (Date.now() - wsReceivedAt) / 1000;
          targetTime += localDelay;
        } else {
          // Fallback to cross-device absolute clock difference if wsReceivedAt is unavailable
          const referenceTime = sentAt || updatedAt;
          const latencySeconds = referenceTime ? (Date.now() - referenceTime) / 1000 : 0;
          targetTime += latencySeconds;
        }
      }

      const drift = Math.abs(video.currentTime - targetTime);
      // If the local playback is off by more than threshold, seek
      if (drift > CONFIG.DRIFT_THRESHOLD) {
        console.log(`Syncing time. Drift: ${drift.toFixed(2)}s. Seeking to: ${targetTime.toFixed(2)}s`);
        video.currentTime = targetTime;
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
            // Should be "PAUSED - "
            if (hasSyncing) {
              document.title = pausedPrefix + document.title.substring(syncingPrefix.length);
            } else if (!hasPaused) {
              document.title = pausedPrefix + document.title;
            }
          } else {
            // Should be "SYNCING - "
            if (hasPaused) {
              document.title = syncingPrefix + document.title.substring(pausedPrefix.length);
            } else if (!hasSyncing) {
              document.title = syncingPrefix + document.title;
            }
          }
        } else {
          // Remove prefixes
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

    function teardown() {
      console.log('Teardown YouTube Sync content script...');
      
      // Clear intervals
      if (checkInterval) clearInterval(checkInterval);
      if (hostInterval) clearInterval(hostInterval);
      if (pingIntervalId) clearInterval(pingIntervalId);

      // Remove video event listeners
      if (videoElement) {
        videoElement.removeEventListener('play', handleVideoEvent);
        videoElement.removeEventListener('pause', handleVideoEvent);
        videoElement.removeEventListener('seeked', handleVideoEvent);
        videoElement.hasSyncListeners = false;
      }

      // Remove document navigation listeners
      document.removeEventListener('yt-navigate-start', handleNavigationStart);
      document.removeEventListener('yt-navigate-finish', handleNavigationFinish);
      window.removeEventListener('load', handleWindowLoad);

      // Restore title
      isLocalFollowerPaused = false;
      isProgrammaticAction = false;
      updateTabTitle(false);

      // Mark as unloaded so a future injection can re-initialize
      window.hasYouTubeSyncLoaded = false;
      window.checkYouTubeSyncContext = null;
    }
    // MARK: - Service Worker Keep-Alive Ping
    // Periodically ping the background service worker to keep it alive or trigger reconnection
    const pingIntervalId = setInterval(() => {
      if (!chrome.runtime?.id) {
        clearInterval(pingIntervalId);
        return;
      }
      chrome.runtime.sendMessage({ type: 'contentPing' }).catch((err) => {
        if (err.message.includes('Extension context invalidated')) {
          clearInterval(pingIntervalId);
        }
      });
    }, CONFIG.KEEP_ALIVE_INTERVAL);
  })();
}
