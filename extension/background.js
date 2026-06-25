// MARK: - State & Configurations
const SERVER_URL = 'ws://yt-sync.viraj-homelab.online';

const CONFIG = {
  HEARTBEAT_INTERVAL: 20000,      // Interval (ms) to send time sync / ping to server
  RECONNECT_DELAY_INITIAL: 1000,  // Starting delay (ms) for WebSocket reconnect attempts
  RECONNECT_DELAY_MAX: 10000,     // Cap (ms) on the reconnect exponential backoff
  DEFAULT_TRANSIT_ESTIMATE: 50    // Default network latency (ms) when NTP clock sync is unavailable
};

let ws = null;
let connectionStatus = 'disconnected';
let reconnectTimeout = null;
let reconnectDelay = CONFIG.RECONNECT_DELAY_INITIAL;
let heartbeatInterval = null;

// Track follower's sync tab ID
let syncTabId = null;

// Clock synchronization offsets (NTP-like algorithm)
let serverTimeOffset = 0;
let hasSyncedTime = false;


// MARK: - Initialization

// Initialize connection on startup if master switch is ON
chrome.storage.local.get('enabled').then(({ enabled }) => {
  if (enabled) {
    connect();
  } else {
    setConnectionStatus('disconnected');
  }
});


// MARK: - Status & Heartbeat Utilities

function setConnectionStatus(status) {
  connectionStatus = status;
  // Notify any open popups of status update
  chrome.runtime.sendMessage({ type: 'statusUpdate', status }).catch(() => {
    // Ignore errors when popup is closed
  });
}

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

function stopHeartbeat() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
}

// MARK: - WebSocket Connection Logic
async function connect() {
  const { enabled = false } = await chrome.storage.local.get('enabled');
  if (!enabled) {
    setConnectionStatus('disconnected');
    return;
  }

  if (ws) {
    try {
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
      const wsReceivedAt = Date.now();
      const message = JSON.parse(event.data);
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

  ws.onclose = () => {
    console.log('WebSocket closed');
    setConnectionStatus('disconnected');
    hasSyncedTime = false; // Reset clock synchronization status
    stopHeartbeat();
    scheduleReconnect();
  };

  ws.onerror = (err) => {
    console.error('WebSocket error:', err);
    setConnectionStatus('disconnected');
    stopHeartbeat();
  };
}

async function scheduleReconnect() {
  const { enabled = false } = await chrome.storage.local.get('enabled');
  if (!enabled) return;

  if (reconnectTimeout) clearTimeout(reconnectTimeout);

  // Cap exponential backoff at maximum config value
  reconnectDelay = Math.min(reconnectDelay * 2, CONFIG.RECONNECT_DELAY_MAX);
  console.log(`Reconnecting in ${reconnectDelay}ms...`);

  reconnectTimeout = setTimeout(() => {
    connect();
  }, reconnectDelay);
}

function sendWSMessage(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  } else {
    console.warn('WebSocket not open. Cannot send:', data);
  }
}


// MARK: - Follower Synchronization Handler

// Handles Follower tab selection and synchronization
async function handleFollowerSync(payload, wsReceivedAt = null) {
  const { currentUrl } = payload;
  if (!currentUrl) return;

  // Validate that it's a YouTube URL
  try {
    const urlObj = new URL(currentUrl);
    if (!urlObj.hostname.includes('youtube.com')) return;
  } catch (e) {
    return;
  }

  // Strictly check if our designated syncTabId still exists
  let targetTab = null;
  if (syncTabId !== null) {
    try {
      targetTab = await chrome.tabs.get(syncTabId);
    } catch (e) {
      syncTabId = null; // Tab was closed, let the tab listener handle turning it OFF
      return;
    }
  } else {
    // No registered sync tab, do not automatically create one or search
    return;
  }

  // Extract video IDs to see if they are different
  const getVidId = (u) => {
    try {
      return new URL(u).searchParams.get('v');
    } catch (e) {
      return null;
    }
  };

  const targetVid = getVidId(currentUrl);
  const currentVid = targetTab ? getVidId(targetTab.url) : null;

  if (targetVid && targetVid !== currentVid) {
    // Navigate existing tab to new video URL
    console.log('Navigating tab', syncTabId, 'to', currentUrl);
    await chrome.tabs.update(syncTabId, { url: currentUrl });
  } else {
    // Video is same, or no video ID, but let's notify the content script to sync playback state
    try {
      await chrome.tabs.sendMessage(syncTabId, {
        type: 'syncPlayback',
        payload,
        wsReceivedAt
      });
    } catch (err) {
      // Content script might not be loaded yet, retry shortly or ignore
      console.log('Could not send message to tab content script:', err.message);
    }
  }
}


// MARK: - Content Script Auto-Injection

// Automatically re-inject content script when the synced tab navigates/reloads.
// Since the extension does not declare static content script match patterns (to avoid CWS host permission prompt),
// we must programmatically inject content.js.
// When the sync tab navigates to a new video (triggering a page reload) or is newly created,
// the previous content script context is destroyed.
// This listener detects when the tab has finished loading ('complete' status) and executes the injection.
// The activeTab permission remains active for this tab as long as the origin (youtube.com) does not change.
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (tabId === syncTabId && changeInfo.status === 'complete') {
    const { enabled = false } = await chrome.storage.local.get('enabled');
    if (!enabled) return;

    console.log('Sync tab reloaded/navigated, injecting content script...');
    chrome.scripting.executeScript({
      target: { tabId: tabId },
      files: ['content.js']
    }).catch((err) => {
      console.warn('Failed to auto-inject content script on tab update:', err);
    });
  }
});

// Listen for syncing tab closure to automatically turn sync OFF
chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  if (tabId === syncTabId) {
    console.log('Syncing tab was closed. Turning synchronization OFF.');
    chrome.storage.local.set({ enabled: false });

    // Tear down WebSocket connection
    if (ws) {
      try {
        ws.close();
      } catch (e) {}
    }
    setConnectionStatus('disconnected');
    hasSyncedTime = false;
    syncTabId = null;
  }
});


// MARK: - Extension Message Listeners

// Listen for messages from popup or content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'getConnectionStatus') {
    sendResponse({ status: connectionStatus });
  } else if (message.type === 'contentPing') {
    if (connectionStatus === 'disconnected') {
      chrome.storage.local.get('enabled').then(({ enabled = false }) => {
        if (enabled) {
          console.log('Received ping from active content script. Reconnecting WebSocket...');
          connect();
        }
      });
    }
    sendResponse({ ack: true });
  } else if (message.type === 'toggleEnabled') {
    if (message.enabled) {
      connect();
    } else {
      if (ws) {
        try {
          ws.close();
        } catch (e) { }
      }
      setConnectionStatus('disconnected');
      hasSyncedTime = false;

      // Clean up content script on all YouTube tabs
      chrome.tabs.query({ url: '*://*.youtube.com/*' }).then((ytTabs) => {
        for (const tab of ytTabs) {
          chrome.tabs.sendMessage(tab.id, { type: 'teardown' }).catch(() => {});
        }
      });
      syncTabId = null;
    }
    sendResponse({ ack: true });
  } else if (message.type === 'registerSyncTab') {
    syncTabId = message.tabId;
    console.log('Registered sync tab ID:', syncTabId);
    sendResponse({ ack: true });
  } else if (message.type === 'roleChanged') {
    console.log('Role changed to:', message.role);
    sendWSMessage({ type: 'setRole', role: message.role });
    sendResponse({ ack: true });
  } else if (message.type === 'hostStateUpdate') {
    // Only forward state update if we are indeed the host
    chrome.storage.local.get(['enabled', 'role']).then(({ enabled = false, role = 'follower' }) => {
      if (enabled && role === 'host') {
        const payload = message.payload;
        // Adjust timestamp to Server Time if clock sync is active
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
  } else if (message.type === 'getSyncTabInfo') {
    (async () => {
      if (syncTabId !== null) {
        try {
          const tab = await chrome.tabs.get(syncTabId);
          // Ask the content script if it is locally paused
          let isLocallyPaused = false;
          try {
            const response = await chrome.tabs.sendMessage(syncTabId, { type: 'getIsLocallyPaused' });
            isLocallyPaused = response ? response.isLocallyPaused : false;
          } catch (err) {
            // Content script not loaded/responding
          }
          sendResponse({ id: syncTabId, title: tab.title, isLocallyPaused });
          return;
        } catch (e) {
          syncTabId = null;
        }
      }
      sendResponse({ id: null });
    })();
    return true;
  } else if (message.type === 'checkIsSyncingTab') {
    chrome.storage.local.get('enabled').then(({ enabled = false }) => {
      const isSyncing = enabled && sender.tab && (sender.tab.id === syncTabId);
      sendResponse({ isSyncing });
    });
    return true;
  }
  return true; // Keep channel open for async response
});
