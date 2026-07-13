// MARK: - Injection Guard

var shouldInitialize = true;
if (window.hasYouTubeSyncLoaded) {
  try {
    if (window.checkYouTubeSyncContext && window.checkYouTubeSyncContext()) {
      console.log('YouTube Sync content script already loaded and active.');
      shouldInitialize = false;
    }
  } catch (e) {}
}

if (shouldInitialize) {
  window.hasYouTubeSyncLoaded = true;
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

    // Track right click location for Picture-in-Picture selection
    let lastRightClickPoint = { x: 0, y: 0 };
    window.addEventListener('contextmenu', (e) => {
      lastRightClickPoint = { x: e.clientX, y: e.clientY };
    }, true);

    // Helper: find video at (x, y) coordinates penetrating transparent overlays
    function findVideoAtPoint(x, y) {
      if (document.elementsFromPoint) {
        const elements = document.elementsFromPoint(x, y);
        for (const el of elements) {
          if (el.tagName && el.tagName.toLowerCase() === 'video') return el;
          const childVideo = el.querySelector && el.querySelector('video');
          if (childVideo) return childVideo;
        }
      }
      const videos = Array.from(document.querySelectorAll('video'));
      if (videos.length === 0) return null;
      if (videos.length === 1) return videos[0];
      for (const video of videos) {
        const rect = video.getBoundingClientRect();
        if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
          return video;
        }
      }
      return videos[0];
    }

    async function requestPictureInPictureForVideo(video) {
      if (!video) return false;
      try {
        if (document.pictureInPictureElement === video) {
          await document.exitPictureInPicture();
          return true;
        } else {
          await video.requestPictureInPicture();
          return true;
        }
      } catch (err) {
        console.error('[YouTube Sync] PiP Error:', err);
        return false;
      }
    }

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

    function isYouTubeHost() {
      return window.location.hostname.includes('youtube.com');
    }

    function isAdPlaying() {
      if (!isYouTubeHost()) return false;
      return !!(document.querySelector('.ad-showing') || (document.querySelector('.video-ads') && document.querySelector('.video-ads').childElementCount > 0));
    }

    function checkAndApply720pQuality() {
      if (!isYouTubeHost()) return;
      try {
        const cores = navigator.hardwareConcurrency || 8;
        const memory = navigator.deviceMemory || 8;
        const effectiveType = navigator.connection ? navigator.connection.effectiveType : '4g';

        if (cores < 4 || memory < 4 || effectiveType !== '4g') {
          const moviePlayer = document.getElementById('movie_player') || document.querySelector('.html5-video-player');
          if (moviePlayer) {
            if (typeof moviePlayer.setPlaybackQualityRange === 'function') {
              moviePlayer.setPlaybackQualityRange('hd720', 'hd720');
            } else if (typeof moviePlayer.setPlaybackQuality === 'function') {
              moviePlayer.setPlaybackQuality('hd720');
            }
          }
        }
      } catch (e) {}
    }

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
      } catch (err) { }
    }

    function startOrRestartIntervals() {
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

                if (!video.paused && !isHostActiveAndPlaying && !isAdPlaying()) {
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

    function findVideoElement() {
      if (videoElement && document.body.contains(videoElement)) {
        return videoElement;
      }

      if (isYouTubeHost()) {
        const miniplayerVideo = document.querySelector('ytd-miniplayer video');
        if (miniplayerVideo && (!miniplayerVideo.paused || document.querySelector('ytd-miniplayer[active]'))) {
          videoElement = miniplayerVideo;
          setupEventListeners();
          return videoElement;
        }
        const shortsVideo = document.querySelector('ytd-reel-video-renderer[is-active] video, ytd-shorts video');
        if (shortsVideo) {
          videoElement = shortsVideo;
          setupEventListeners();
          return videoElement;
        }
        const mainVideo = document.querySelector('.html5-main-video') || document.querySelector('ytd-player video') || document.querySelector('video');
        if (mainVideo) {
          videoElement = mainVideo;
          setupEventListeners();
          return videoElement;
        }
      } else {
        const genericVideo = document.querySelector('video');
        if (genericVideo) {
          videoElement = genericVideo;
          setupEventListeners();
          return videoElement;
        }
      }
      return null;
    }

    function setupEventListeners() {
      if (!videoElement) return;

      videoElement.removeEventListener('play', handleVideoEvent);
      videoElement.removeEventListener('pause', handleVideoEvent);
      videoElement.removeEventListener('seeked', handleVideoEvent);
      videoElement.removeEventListener('ratechange', handleVideoEvent);

      videoElement.addEventListener('play', handleVideoEvent);
      videoElement.addEventListener('pause', handleVideoEvent);
      videoElement.addEventListener('seeked', handleVideoEvent);
      videoElement.addEventListener('ratechange', handleVideoEvent);
    }

    // MARK: - Host State Extraction & Reporting

    function handleVideoEvent(e) {
      try {
        if (isApplyingSync) return;

        if (currentRole !== 'host') {
          if (e && (e.type === 'play' || e.type === 'pause')) {
            if (e.type === 'pause') {
              const isHostActiveAndPlaying = lastHostStatePayload &&
                lastHostStatePayload.state === 'playing' &&
                (Date.now() - lastHostStateWsReceivedAt < 10000);
              if (isHostActiveAndPlaying && !isAdPlaying()) {
                isLocalFollowerPaused = true;
                console.log('Follower locally paused playback.');
              }
            } else if (e.type === 'play') {
              isLocalFollowerPaused = false;
              console.log('Follower locally resumed playback, re-syncing...');
              if (lastHostStatePayload) {
                applyFollowerSync(lastHostStatePayload, lastHostStateWsReceivedAt);
              }
            }
          }
          return;
        }

        sendHostState(e ? e.type : 'periodic');
      } catch (err) { }
    }

    function sendHostState(trigger = 'periodic') {
      if (isAdPlaying()) {
        console.log('[YouTube Sync] Suppressing host state update during ad playback.');
        return;
      }

      const video = findVideoElement();
      if (!video) return;

      const currentUrl = window.location.href;
      const currentState = video.paused ? 'paused' : 'playing';
      const currentTime = video.currentTime;
      const playbackRate = video.playbackRate || 1.0;

      if (trigger === 'periodic' && (Date.now() - lastSentTimestamp < CONFIG.THROTTLE_THRESHOLD)) {
        return;
      }

      lastSentState = { url: currentUrl, state: currentState, time: currentTime, playbackRate };
      lastSentTimestamp = Date.now();

      chrome.runtime.sendMessage({
        type: 'hostStateUpdate',
        payload: {
          currentUrl,
          state: currentState,
          currentTime,
          playbackRate,
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
      console.log('[YouTube Sync] Navigation started. URL:', currentUrl);
    }

    function handleNavigationFinish() {
      isNavigating = false;
      console.log('[YouTube Sync] Navigation finished.');
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
      } else if (message.type === 'triggerPiPAtPoint') {
        const targetVideo = findVideoAtPoint(lastRightClickPoint.x, lastRightClickPoint.y) || findVideoElement();
        if (targetVideo) {
          requestPictureInPictureForVideo(targetVideo);
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
      if (isAdPlaying()) {
        console.log('[YouTube Sync] Suppressing follower sync state while ad is playing.');
        return;
      }

      const video = findVideoElement();
      if (!video) return;

      checkAndApply720pQuality();

      const timeSinceUrlChange = Date.now() - urlChangedAt;
      if (timeSinceUrlChange < 2000 || document.readyState !== 'complete' || (isNavigating && timeSinceUrlChange < 10000)) {
        return;
      }

      if (Date.now() - lastFollowerSyncedAt < CONFIG.FOLLOWER_SYNC_THROTTLE) {
        return;
      }

      const { state, currentTime, playbackRate, sentAt, updatedAt } = payload;

      if (isLocalFollowerPaused && state === 'playing') {
        return;
      }

      let didMutate = false;

      isApplyingSync = true;
      try {
        // 1. Sync Playback Speed
        const targetRate = playbackRate !== undefined ? playbackRate : 1.0;
        if (Math.abs(video.playbackRate - targetRate) > 0.05) {
          video.playbackRate = targetRate;
          didMutate = true;
        }

        // 2. Sync play/pause state
        if (state === 'playing' && video.paused) {
          didMutate = true;
          video.play().catch((e) => {
            console.log('Playback start prevented:', e);
          });
        } else if (state === 'paused' && !video.paused) {
          didMutate = true;
          video.pause();
        }

        // 3. Sync elapsed time (accounting for speed and latency)
        let targetTime = currentTime;
        if (state === 'playing') {
          const rate = targetRate || 1.0;
          if (wsReceivedAt) {
            const localDelay = ((Date.now() - wsReceivedAt) / 1000) * rate;
            targetTime += localDelay;
          } else {
            const referenceTime = sentAt || updatedAt;
            const latencySeconds = referenceTime ? ((Date.now() - referenceTime) / 1000) * rate : 0;
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
      } catch (e) { }
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
      checkAndApply720pQuality();

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

      if (keepAlivePort) {
        try { keepAlivePort.disconnect(); } catch (e) { }
        keepAlivePort = null;
      }

      if (checkInterval) clearInterval(checkInterval);
      if (hostInterval) clearInterval(hostInterval);

      if (videoObserver) {
        videoObserver.disconnect();
        videoObserver = null;
      }

      if (videoElement) {
        try {
          videoElement.removeEventListener('play', handleVideoEvent);
          videoElement.removeEventListener('pause', handleVideoEvent);
          videoElement.removeEventListener('seeked', handleVideoEvent);
          videoElement.removeEventListener('ratechange', handleVideoEvent);
          videoElement.hasSyncListeners = false;
        } catch (e) { }
      }

      try {
        const toast = document.getElementById('yt-sync-demotion-toast');
        if (toast) toast.remove();
      } catch (e) { }

      isLocalFollowerPaused = false;
      updateTabTitle(false);
    }

    chrome.storage.onChanged.addListener(handleStorageChange);
    document.addEventListener('yt-navigate-start', handleNavigationStart);
    document.addEventListener('yt-navigate-finish', handleNavigationFinish);
    window.addEventListener('load', handleWindowLoad);

    initialize();
  })();
}
