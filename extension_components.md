# YouTube Sync Chrome Extension: Core Components & Code Snippets

This document compiles the main conceptual and procedural components of the YouTube Sync extension, separated from surrounding boilerplates, each with a single-line explanation and the corresponding code snippet from their respective files.

---

## 1. WebSocket Communication (Establishment, Transmission, and Reception)
*Establishes a WebSocket connection with the synchronization server and manages packet transmission and reception.*

### [background.js](file:///Users/viraj/Documents/Repositories/yt-sync/extension/background.js)
```javascript
async function connect() {
  const { enabled = false } = await chrome.storage.local.get('enabled');
  if (!enabled) {
    setConnectionStatus('disconnected');
    return;
  }

  if (ws) {
    try {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      ws.close();
    } catch (e) { }
  }

  console.log('Connecting to', SERVER_URL);
  setConnectionStatus('connecting');

  ws = new WebSocket(SERVER_URL);

  ws.onopen = async () => {
    console.log('WebSocket connected');
    setConnectionStatus('connected');
    reconnectDelay = CONFIG.RECONNECT_DELAY_INITIAL;
    startHeartbeat();

    // Send role registration immediately
    const { role = 'follower' } = await chrome.storage.local.get('role');
    sendWSMessage({ type: 'setRole', role });

    // Send initial clock synchronization request
    sendWSMessage({
      type: 'timeSync',
      payload: {
        clientTime: Date.now()
      }
    });
  };

  ws.onmessage = async (event) => {
    try {
      messagesReceivedCount++;
      const wsReceivedAt = Date.now();
      const message = JSON.parse(event.data);
      lastMessagePayload = message;
      console.log('WebSocket message received:', message);

      if (message.type === 'syncState') {
        const { role = 'follower' } = await chrome.storage.local.get('role');
        if (role === 'follower') {
          // Calculate exact or estimated transmission latency to adjust the playback time origin
          let adjustedReceivedAt = wsReceivedAt;
          if (message.payload.sentAt) {
            if (hasSyncedTime) {
              const followerArrivalServerTime = wsReceivedAt + serverTimeOffset;
              const transitDelayMs = Math.max(0, followerArrivalServerTime - message.payload.sentAt);
              adjustedReceivedAt = wsReceivedAt - transitDelayMs;
              console.log(`Clock Synced Transit Latency: ${transitDelayMs}ms`);
            } else {
              const transitDelayMs = CONFIG.DEFAULT_TRANSIT_ESTIMATE; // Fallback estimate
              adjustedReceivedAt = wsReceivedAt - transitDelayMs;
            }
          }
          await handleFollowerSync(message.payload, adjustedReceivedAt);
        }
      } else if (message.type === 'roleDemoted') {
        console.warn('Demoted to follower by server');
        await chrome.storage.local.set({ role: 'follower' });
        chrome.runtime.sendMessage({ type: 'roleChanged', role: 'follower' }).catch(() => { });

        // Notify the content script on the sync tab to show a demotion toast warning
        if (syncTabId !== null) {
          chrome.tabs.sendMessage(syncTabId, { type: 'showDemotionNotification' }).catch(() => {});
        }
      } else if (message.type === 'timeSyncResponse') {
        const t0 = message.payload.clientTime;
        const t1 = message.payload.serverTime;
        const t2 = Date.now();
        const rtt = t2 - t0;
        // offset = estimatedServerTime - clientTime
        serverTimeOffset = (t1 + rtt / 2) - t2;
        hasSyncedTime = true;
        console.log(`Time synced. RTT: ${rtt}ms. Server offset: ${serverTimeOffset}ms`);
      }
    } catch (err) {
      console.error('Error handling WebSocket message:', err);
    }
  };

  ws.onclose = (event) => {
    console.log('WebSocket closed');
    if (event && !event.wasClean) {
      lastErrorMessage = `Closed uncleanly. Code: ${event.code}. Reason: ${event.reason || 'None'}`;
    }
    setConnectionStatus('disconnected');
    hasSyncedTime = false; // Reset clock synchronization status
    stopHeartbeat();
    scheduleReconnect();
  };

  ws.onerror = (err) => {
    console.error('WebSocket error:', err);
    lastErrorMessage = err.message || 'WebSocket Error';
    setConnectionStatus('disconnected');
    stopHeartbeat();
  };
}

function sendWSMessage(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    messagesSentCount++;
    ws.send(JSON.stringify(data));
  } else {
    console.warn('WebSocket not open. Cannot send:', data);
  }
}
```

---

## 2. Extension Service Worker Keep-Alive Loop
*Keeps the background service worker active and prevents the 5-minute inactivity shutdown by maintaining a port connection from the content script and sending regular heartbeat messages.*

### [background.js](file:///Users/viraj/Documents/Repositories/yt-sync/extension/background.js)
```javascript
function startHeartbeat() {
  stopHeartbeat();
  heartbeatInterval = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      // Send time sync to recalibrate and keep active
      sendWSMessage({
        type: 'timeSync',
        payload: {
          clientTime: Date.now()
        }
      });
      // Send ping for backward compatibility with older servers
      sendWSMessage({ type: 'ping' });
    }
  }, CONFIG.HEARTBEAT_INTERVAL); // Keep MV3 Service Worker active
}

// Port Keepalive Handler
let activePorts = new Set();
chrome.runtime.onConnect.addListener(async (port) => {
  if (port.name === 'yt-sync-keepalive') {
    activePorts.add(port);
    port.onDisconnect.addListener(() => {
      activePorts.delete(port);
    });

    if (connectionStatus === 'disconnected') {
      const { enabled = false } = await chrome.storage.local.get('enabled');
      if (enabled) {
        console.log('[YouTube Sync] Keepalive port connected while WS disconnected. Reconnecting...');
        connect();
      }
    }
  }
});
```

### [content.js](file:///Users/viraj/Documents/Repositories/yt-sync/extension/content.js)
```javascript
let keepAlivePort = null;

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

// Inside initialize()
connectKeepAlive();

// Inside teardown()
if (keepAlivePort) {
  try { keepAlivePort.disconnect(); } catch (e) { }
  keepAlivePort = null;
}
```

---

## 3. NTP-Like Clock Synchronization
*Calculates latency and clock offset between client and server using an NTP-like algorithm to accurately align follower video playback time.*

### [background.js](file:///Users/viraj/Documents/Repositories/yt-sync/extension/background.js)
```javascript
let serverTimeOffset = 0;
let hasSyncedTime = false;

// Triggering Time Sync (in ws.onopen)
sendWSMessage({
  type: 'timeSync',
  payload: {
    clientTime: Date.now()
  }
});

// Processing Server Time Sync Response (in ws.onmessage)
if (message.type === 'timeSyncResponse') {
  const t0 = message.payload.clientTime;
  const t1 = message.payload.serverTime;
  const t2 = Date.now();
  const rtt = t2 - t0;
  // offset = estimatedServerTime - clientTime
  serverTimeOffset = (t1 + rtt / 2) - t2;
  hasSyncedTime = true;
  console.log(`Time synced. RTT: ${rtt}ms. Server offset: ${serverTimeOffset}ms`);
}

// Adjusting Follower's Incoming WS Timestamp
if (message.payload.sentAt) {
  if (hasSyncedTime) {
    const followerArrivalServerTime = wsReceivedAt + serverTimeOffset;
    const transitDelayMs = Math.max(0, followerArrivalServerTime - message.payload.sentAt);
    adjustedReceivedAt = wsReceivedAt - transitDelayMs;
    console.log(`Clock Synced Transit Latency: ${transitDelayMs}ms`);
  } else {
    const transitDelayMs = CONFIG.DEFAULT_TRANSIT_ESTIMATE; // Fallback estimate
    adjustedReceivedAt = wsReceivedAt - transitDelayMs;
  }
}

// Injecting Offset Adjusted Timestamp on Host Updates
hostStateUpdate: (message, sender, sendResponse) => {
  chrome.storage.local.get(['enabled', 'role']).then(({ enabled = false, role = 'follower' }) => {
    if (enabled && role === 'host') {
      const payload = message.payload;
      if (hasSyncedTime) {
        payload.sentAt = Date.now() + serverTimeOffset;
      } else {
        payload.sentAt = Date.now();
      }
      sendWSMessage({
        type: 'updateState',
        payload: payload
      });
    }
  });
  sendResponse({ ack: true });
}
```

### [content.js](file:///Users/viraj/Documents/Repositories/yt-sync/extension/content.js)
```javascript
function applyFollowerSync(payload, wsReceivedAt = null) {
  // ...
  const { state, currentTime, playbackRate, sentAt, updatedAt } = payload;
  
  // Sync elapsed time (accounting for speed and latency)
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
  // ...
}
```

---

## 4. Picture-in-Picture Trigger and Overlay Element Detection
*Detects video elements under the cursor even when obscured by overlays, and toggles Picture-in-Picture mode.*

### [background.js](file:///Users/viraj/Documents/Repositories/yt-sync/extension/background.js)
```javascript
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'yt-sync-pip',
    title: 'Pop out Video (Picture-in-Picture)',
    contexts: ['all']
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'yt-sync-pip' && tab?.id) {
    chrome.tabs.sendMessage(tab.id, {
      type: 'triggerPiPAtPoint'
    }).catch(() => {});
  }
});
```

### [content.js](file:///Users/viraj/Documents/Repositories/yt-sync/extension/content.js)
```javascript
let lastRightClickPoint = { x: 0, y: 0 };
window.addEventListener('contextmenu', (e) => {
  lastRightClickPoint = { x: e.clientX, y: e.clientY };
}, true);

// Message Handler
else if (message.type === 'triggerPiPAtPoint') {
  const targetVideo = findVideoAtPoint(lastRightClickPoint.x, lastRightClickPoint.y) || findVideoElement();
  if (targetVideo) {
    requestPictureInPictureForVideo(targetVideo);
  }
  sendResponse({ ack: true });
}
```

### [modules/pip-handler.js](file:///Users/viraj/Documents/Repositories/yt-sync/extension/modules/pip-handler.js)
```javascript
export function findVideoAtPoint(x, y) {
  // 1. Try elementsFromPoint to penetrate transparent overlays (e.g., Google Meet controls, overlay divs)
  if (document.elementsFromPoint) {
    const elements = document.elementsFromPoint(x, y);
    for (const el of elements) {
      if (el.tagName && el.tagName.toLowerCase() === 'video') {
        return el;
      }
      const childVideo = el.querySelector && el.querySelector('video');
      if (childVideo) {
        return childVideo;
      }
    }
  }

  // 2. Fallback: find all video elements on page and select the one containing or closest to (x, y)
  const videos = Array.from(document.querySelectorAll('video'));
  if (videos.length === 0) return null;
  if (videos.length === 1) return videos[0];

  let closestVideo = null;
  let minDistance = Infinity;

  for (const video of videos) {
    const rect = video.getBoundingClientRect();
    if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
      return video; // Directly inside rect
    }
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const dist = Math.hypot(x - centerX, y - centerY);
    if (dist < minDistance) {
      minDistance = dist;
      closestVideo = video;
    }
  }

  return closestVideo || videos[0];
}

export async function requestPictureInPictureForVideo(video) {
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
```

---

## 5. Video Element Detection and DOM Polling (Sync Loops)
*Regularly polls the DOM and observes mutations to locate active video elements and apply synchronization commands.*

### [content.js](file:///Users/viraj/Documents/Repositories/yt-sync/extension/content.js)
```javascript
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
```

---

## 6. Follower Playback Synchronization State Application
*Aligns a follower's play/pause status, playback rate, and current time offset with the host's state.*

### [content.js](file:///Users/viraj/Documents/Repositories/yt-sync/extension/content.js)
```javascript
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
```

---

## 7. Host Playback Event Tracking and State Throttling
*Monitors play, pause, seek, and playback rate events on the host video to broadcast updates to followers with throttling.*

### [content.js](file:///Users/viraj/Documents/Repositories/yt-sync/extension/content.js)
```javascript
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
```

---

## 8. Network- and Hardware-Based Quality Capping
*Automatically limits YouTube video quality to 720p if low hardware concurrency or RAM is detected.*

### [content.js](file:///Users/viraj/Documents/Repositories/yt-sync/extension/content.js)
```javascript
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
```

---

## 9. Active Tab Synchronization and Lifecycle Coordination
*Coordinates active tab state across focus changes, programmatic navigation, and tab closures.*

### [background.js](file:///Users/viraj/Documents/Repositories/yt-sync/extension/background.js)
```javascript
async function setSyncTabId(newTabId) {
  if (syncTabId === newTabId) return;
  const oldTabId = syncTabId;
  syncTabId = newTabId;
  
  if (oldTabId !== null) {
    chrome.tabs.sendMessage(oldTabId, { type: 'setActiveSyncTab', isActive: false }).catch(() => {});
  }
  if (newTabId !== null) {
    chrome.tabs.sendMessage(newTabId, { type: 'setActiveSyncTab', isActive: true }).catch(() => {});
  }
}

async function handleTabActivationOrUpdate(tabId) {
  try {
    const { enabled = false } = await chrome.storage.local.get('enabled');
    if (!enabled) return;

    const tab = await chrome.tabs.get(tabId);
    if (tab && tab.url && (tab.url.startsWith('http://') || tab.url.startsWith('https://'))) {
      await setSyncTabId(tabId);
    }
  } catch (err) { }
}

// Focus changes
chrome.tabs.onActivated.addListener((activeInfo) => {
  handleTabActivationOrUpdate(activeInfo.tabId);
});

// Updates / loads / redirection guard
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (tabId === syncTabId) {
    const { enabled = false, role = 'follower' } = await chrome.storage.local.get(['enabled', 'role']);
    if (enabled && role === 'follower' && lastKnownHostUrl) {
      if (Date.now() - lastProgrammaticNavAt < 5000) return;

      const currentUrl = tab.url || changeInfo.url;
      if (currentUrl && isUrlDifferent(currentUrl, lastKnownHostUrl)) {
        console.log(`[YouTube Sync] Follower navigated away. Redirecting back to Host: ${lastKnownHostUrl}`);
        lastProgrammaticNavAt = Date.now();
        await chrome.tabs.update(syncTabId, { url: lastKnownHostUrl }).catch(() => {});
        return;
      }
    }
  }

  if (changeInfo.status === 'complete') {
    handleTabActivationOrUpdate(tabId);
  }
});

// Closure cleanup
chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  if (tabId === syncTabId) {
    console.log('Syncing tab was closed. Turning synchronization OFF.');
    chrome.storage.local.set({ enabled: false });
    if (ws) {
      try {
        ws.close();
      } catch (e) {}
    }
    setConnectionStatus('disconnected');
    setSyncTabId(null);
  }
});
```

### [popup/popup.js](file:///Users/viraj/Documents/Repositories/yt-sync/extension/popup/popup.js)
```javascript
async function getActiveTab() {
  try {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tabs && tabs.length > 0) {
      const webTab = tabs.find(t => t.url && (t.url.startsWith('http://') || t.url.startsWith('https://')));
      if (webTab) return webTab;
      return tabs[0];
    }
    
    const currentTabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (currentTabs && currentTabs.length > 0) {
      const webTab = currentTabs.find(t => t.url && (t.url.startsWith('http://') || t.url.startsWith('https://')));
      if (webTab) return webTab;
      return currentTabs[0];
    }
  } catch (err) {
    console.error('Error querying active tab:', err);
  }
  return null;
}
```

---

## 10. URL Difference and Video ID Resolution Utilities
*Provides checks to compare URLs for differences (e.g. YouTube video ID vs full URL comparison).*

### [modules/utils.js](file:///Users/viraj/Documents/Repositories/yt-sync/extension/modules/utils.js)
```javascript
export function getVideoId(urlStr) {
  if (!urlStr) return null;
  try {
    const url = new URL(urlStr);
    if (url.hostname.includes('youtube.com')) {
      if (url.pathname.startsWith('/shorts/')) {
        const parts = url.pathname.split('/shorts/');
        if (parts[1]) return parts[1].split('/')[0].split('?')[0];
      }
      if (url.pathname === '/watch') {
        return url.searchParams.get('v');
      }
    }
    return url.href; // Fallback to full URL for generic sites
  } catch (e) {
    return null;
  }
}

export function isUrlDifferent(url1, url2) {
  if (!url1 || !url2) return url1 !== url2;
  if (url1 === url2) return false;
  try {
    const u1 = new URL(url1);
    const u2 = new URL(url2);
    
    if (u1.hostname !== u2.hostname || u1.pathname !== u2.pathname) {
      return true;
    }
    
    if (u1.hostname.includes('youtube.com')) {
      if (u1.pathname === '/watch') {
        return u1.searchParams.get('v') !== u2.searchParams.get('v');
      }
      if (u1.pathname.startsWith('/shorts/')) {
        const id1 = u1.pathname.split('/shorts/')[1]?.split('/')[0];
        const id2 = u2.pathname.split('/shorts/')[1]?.split('/')[0];
        return id1 !== id2;
      }
    }
    return false;
  } catch (e) {
    return url1 !== url2;
  }
}

export function isYouTubeUrl(urlStr) {
  if (!urlStr) return false;
  try {
    return new URL(urlStr).hostname.includes('youtube.com');
  } catch (e) {
    return false;
  }
}
```
