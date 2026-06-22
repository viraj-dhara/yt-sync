let shouldInitialize = true;
if (window.hasYouTubeSyncLoaded) {
  try {
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
  window.checkYouTubeSyncContext = () => {
    return !!(typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id);
  };
  (async () => {
    console.log('YouTube Sync content script loaded.');

  let videoElement = null;
  let lastSentState = {
    url: '',
    state: '',
    time: -1
  };

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

  // Check and report state if we are the host
  async function handleVideoEvent(e) {
    const { role = 'follower' } = await chrome.storage.local.get('role');
    if (role !== 'host') return;

    sendHostState(e ? e.type : 'periodic');
  }

  function sendHostState(trigger = 'periodic') {
    const video = findVideoElement();
    if (!video) return;

    const currentUrl = window.location.href;
    const currentState = video.paused ? 'paused' : 'playing';
    const currentTime = video.currentTime;

    // Avoid duplicate triggers unless it's a periodic sync or a significant change
    const timeDiff = Math.abs(currentTime - lastSentState.time);
    if (
      trigger !== 'periodic' ||
      lastSentState.url !== currentUrl ||
      lastSentState.state !== currentState ||
      timeDiff > 2.0
    ) {
      lastSentState = { url: currentUrl, state: currentState, time: currentTime };

      chrome.runtime.sendMessage({
        type: 'hostStateUpdate',
        payload: {
          currentUrl,
          state: currentState,
          currentTime
        }
      }).catch((err) => {
        console.error('Error sending host state update:', err);
      });
    }
  }

  // Keep looking for video elements periodically (useful for SPAs like YouTube)
  setInterval(() => {
    const video = findVideoElement();
    if (video && !video.hasSyncListeners) {
      setupEventListeners();
      video.hasSyncListeners = true;
    }
  }, 1000);

  // Send periodic sync state if we are the host
  setInterval(async () => {
    const { role = 'follower' } = await chrome.storage.local.get('role');
    if (role === 'host') {
      sendHostState('periodic');
    }
  }, 2000);

  // Listen to custom YouTube navigation events to capture URL transitions
  document.addEventListener('yt-navigate-finish', () => {
    handleVideoEvent();
  });

  // Listen to sync messages from the background service worker (for Followers)
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'syncPlayback') {
      applyFollowerSync(message.payload);
      sendResponse({ ack: true });
    }
    return true;
  });

  // Apply playback and time synchronization
  function applyFollowerSync(payload) {
    const video = findVideoElement();
    if (!video) return;

    const { state, currentTime, updatedAt } = payload;

    // 1. Sync play/pause state
    if (state === 'playing' && video.paused) {
      video.play().catch((e) => console.log('Playback start prevented:', e));
    } else if (state === 'paused' && !video.paused) {
      video.pause();
    }

    // 2. Sync elapsed time (accounting for latency/drift)
    let targetTime = currentTime;
    if (state === 'playing') {
      const latencySeconds = (Date.now() - updatedAt) / 1000;
      targetTime += latencySeconds;
    }

    const drift = Math.abs(video.currentTime - targetTime);
    // If the local playback is off by more than 1.5 seconds, seek
    if (drift > 1.5) {
      console.log(`Syncing time. Drift: ${drift.toFixed(2)}s. Seeking to: ${targetTime.toFixed(2)}s`);
      video.currentTime = targetTime;
    }
  }
})();
}
