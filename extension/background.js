import { getVideoId, isUrlDifferent, isYouTubeUrl } from './modules/utils.js';

// MARK: - State & Configurations
let SERVER_URL = 'ws://yt-sync.viraj-homelab.online';
let lastProgrammaticNavAt = 0;

// Context Menu setup for Picture-in-Picture
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

let CONFIG = {
  HEARTBEAT_INTERVAL: 20000,      // Interval (ms) to send time sync / ping to server
  RECONNECT_DELAY_INITIAL: 1000,  // Starting delay (ms) for WebSocket reconnect attempts
  RECONNECT_DELAY_MAX: 10000,     // Cap (ms) on the reconnect exponential backoff
  DEFAULT_TRANSIT_ESTIMATE: 50    // Default network latency (ms) when NTP clock sync is unavailable
};

// Diagnostics & Metrics Variables
let messagesSentCount = 0;
let messagesReceivedCount = 0;
let lastErrorMessage = '';
let lastMessagePayload = null;

async function syncConfigurations() {
  const data = await chrome.storage.local.get([
    'serverUrl',
    'heartbeatInterval',
    'reconnectDelayInitial',
    'reconnectDelayMax',
    'defaultTransitEstimate'
  ]);

  if (data.serverUrl && data.serverUrl !== SERVER_URL) {
    console.log(`[YouTube Sync] Server URL updated from ${SERVER_URL} to ${data.serverUrl}. Reconnecting WebSocket...`);
    SERVER_URL = data.serverUrl;
    
    const { enabled = false } = await chrome.storage.local.get('enabled');
    if (enabled) {
      if (ws) {
        try {
          ws.close();
        } catch (e) {}
      }
      connect();
    }
  }

  if (data.heartbeatInterval !== undefined) {
    CONFIG.HEARTBEAT_INTERVAL = data.heartbeatInterval;
    if (ws && ws.readyState === WebSocket.OPEN) {
      startHeartbeat();
    }
  }
  if (data.reconnectDelayInitial !== undefined) {
    CONFIG.RECONNECT_DELAY_INITIAL = data.reconnectDelayInitial;
  }
  if (data.reconnectDelayMax !== undefined) {
    CONFIG.RECONNECT_DELAY_MAX = data.reconnectDelayMax;
  }
  if (data.defaultTransitEstimate !== undefined) {
    CONFIG.DEFAULT_TRANSIT_ESTIMATE = data.defaultTransitEstimate;
  }
}

// Initial Sync
syncConfigurations();

// Listen to storage config changes in real-time
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local') {
    const keys = [
      'serverUrl',
      'heartbeatInterval',
      'reconnectDelayInitial',
      'reconnectDelayMax',
      'defaultTransitEstimate'
    ];
    const hasConfigChange = keys.some(key => changes[key] !== undefined);
    if (hasConfigChange) {
      syncConfigurations();
    }
  }
});

let ws = null;
let connectionStatus = 'disconnected';
let reconnectTimeout = null;
let reconnectDelay = CONFIG.RECONNECT_DELAY_INITIAL;
let heartbeatInterval = null;

// Track follower's sync tab ID
let syncTabId = null;
let lastKnownHostUrl = null;

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
    messagesSentCount++;
    ws.send(JSON.stringify(data));
  } else {
    console.warn('WebSocket not open. Cannot send:', data);
  }
}


// MARK: - Follower Synchronization Handler

// MARK: - Follower Synchronization Handler

// Handles Follower tab selection and synchronization
async function handleFollowerSync(payload, wsReceivedAt = null) {
  const { currentUrl } = payload;
  if (!currentUrl) return;

  lastKnownHostUrl = currentUrl;

  // Strictly check if designated syncTabId still exists
  let targetTab = null;
  if (syncTabId !== null) {
    try {
      targetTab = await chrome.tabs.get(syncTabId);
    } catch (e) {
      syncTabId = null;
      return;
    }
  } else {
    return;
  }

  if (isUrlDifferent(targetTab.url, currentUrl)) {
    console.log('Navigating tab', syncTabId, 'to host URL:', currentUrl);
    lastProgrammaticNavAt = Date.now();
    await chrome.tabs.update(syncTabId, { url: currentUrl }).catch(() => {});
  } else {
    try {
      await chrome.tabs.sendMessage(syncTabId, {
        type: 'syncPlayback',
        payload,
        wsReceivedAt
      });
    } catch (err) {
      console.log('Could not send message to tab content script:', err.message);
    }
  }
}


// MARK: - Tab Manager & Port Handlers

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
  } catch (err) {
    // Suppress tab access errors
  }
}

// Listen for tab focus changes
chrome.tabs.onActivated.addListener((activeInfo) => {
  handleTabActivationOrUpdate(activeInfo.tabId);
});

// Listen for tab updates/loads
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (tabId === syncTabId) {
    const { enabled = false, role = 'follower' } = await chrome.storage.local.get(['enabled', 'role']);
    if (enabled && role === 'follower' && lastKnownHostUrl) {
      // Avoid redirect loops if programmatic navigation is in progress
      if (Date.now() - lastProgrammaticNavAt < 5000) return;

      const currentUrl = tab.url || changeInfo.url;
      if (currentUrl && isUrlDifferent(currentUrl, lastKnownHostUrl)) {
        console.log(`[YouTube Sync] Follower navigated away to ${currentUrl}. Redirecting back to Host: ${lastKnownHostUrl}`);
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

// Listen for syncing tab closure to automatically turn sync OFF
chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  if (tabId === syncTabId) {
    console.log('Syncing tab was closed. Turning synchronization OFF.');
    chrome.storage.local.set({ enabled: false });

    // Tear down WebSocket connection
    if (ws) {
      try {
        ws.onopen = null;
        ws.onmessage = null;
        ws.onerror = null;
        ws.onclose = null;
        ws.close();
      } catch (e) {}
    }
    setConnectionStatus('disconnected');
    hasSyncedTime = false;
    setSyncTabId(null);
  }
});

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


// MARK: - Extension Message Dispatcher

const messageHandlers = {
  getConnectionStatus: (message, sender, sendResponse) => {
    sendResponse({ status: connectionStatus });
  },
  toggleEnabled: (message, sender, sendResponse) => {
    if (message.enabled) {
      connect();
    } else {
      if (ws) {
        try {
          ws.onopen = null;
          ws.onmessage = null;
          ws.onerror = null;
          ws.onclose = null;
          ws.close();
        } catch (e) {}
      }
      setConnectionStatus('disconnected');
      hasSyncedTime = false;

      // Clean up content script on all video tabs
      chrome.tabs.query({}).then((tabs) => {
        for (const tab of tabs) {
          if (tab.id) chrome.tabs.sendMessage(tab.id, { type: 'teardown' }).catch(() => {});
        }
      });
      setSyncTabId(null);
    }
    sendResponse({ ack: true });
  },
  registerSyncTab: (message, sender, sendResponse) => {
    setSyncTabId(message.tabId);
    if (chrome.action?.openPopup) {
      chrome.action.openPopup().catch(() => {});
    }
    sendResponse({ ack: true });
  },
  roleChanged: (message, sender, sendResponse) => {
    console.log('Role changed to:', message.role);
    sendWSMessage({ type: 'setRole', role: message.role });
    sendResponse({ ack: true });
  },
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
  },
  getSyncTabInfo: (message, sender, sendResponse) => {
    (async () => {
      if (syncTabId !== null) {
        try {
          const tab = await chrome.tabs.get(syncTabId);
          let isLocallyPaused = false;
          try {
            const response = await chrome.tabs.sendMessage(syncTabId, { type: 'getIsLocallyPaused' });
            isLocallyPaused = response ? response.isLocallyPaused : false;
          } catch (err) {}
          sendResponse({ id: syncTabId, title: tab.title, isLocallyPaused });
          return;
        } catch (e) {
          setSyncTabId(null);
        }
      }
      sendResponse({ id: null });
    })();
    return true; // async handler
  },
  checkIsSyncingTab: (message, sender, sendResponse) => {
    chrome.storage.local.get('enabled').then(({ enabled = false }) => {
      const isSyncing = enabled && sender.tab && (sender.tab.id === syncTabId);
      sendResponse({ isSyncing });
    });
    return true; // async handler
  },
  forceReconnect: (message, sender, sendResponse) => {
    console.log('Forced reconnect triggered from options page.');
    if (ws) {
      try {
        ws.onopen = null;
        ws.onmessage = null;
        ws.onerror = null;
        ws.onclose = null;
        ws.close();
      } catch (e) {}
    }
    connect();
    sendResponse({ ack: true });
  },
  resetCounters: (message, sender, sendResponse) => {
    messagesSentCount = 0;
    messagesReceivedCount = 0;
    lastErrorMessage = '';
    lastMessagePayload = null;
    sendResponse({ ack: true });
  },
  getInternalState: (message, sender, sendResponse) => {
    sendResponse({
      connectionStatus,
      syncTabId,
      lastKnownHostUrl,
      serverTimeOffset,
      hasSyncedTime,
      stats: {
        sent: messagesSentCount,
        received: messagesReceivedCount,
        lastError: lastErrorMessage,
        lastMessage: lastMessagePayload
      }
    });
  }
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = messageHandlers[message.type];
  if (handler) {
    const isAsync = handler(message, sender, sendResponse);
    return isAsync === true;
  }
  return false;
});
