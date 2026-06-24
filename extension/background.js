// MARK: - State & Configurations
const SERVER_URL = 'ws://yt-sync.viraj-homelab.online';
let ws = null;
let connectionStatus = 'disconnected';
let reconnectTimeout = null;
let reconnectDelay = 1000;
let heartbeatInterval = null;

// Track follower's sync tab ID
let syncTabId = null;


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
      sendWSMessage({ type: 'ping' });
    }
  }, 20000); // Send ping every 20 seconds to keep MV3 Service Worker active
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
    reconnectDelay = 1000;
    startHeartbeat();

    // Send role registration immediately
    const { role = 'follower' } = await chrome.storage.local.get('role');
    sendWSMessage({ type: 'setRole', role });
  };

  ws.onmessage = async (event) => {
    try {
      const wsReceivedAt = Date.now();
      const message = JSON.parse(event.data);
      console.log('WebSocket message received:', message);

      if (message.type === 'syncState') {
        const { role = 'follower' } = await chrome.storage.local.get('role');
        if (role === 'follower') {
          await handleFollowerSync(message.payload, wsReceivedAt);
        }
      } else if (message.type === 'roleDemoted') {
        console.warn('Demoted to follower by server');
        await chrome.storage.local.set({ role: 'follower' });
        chrome.runtime.sendMessage({ type: 'roleChanged', role: 'follower' }).catch(() => { });
      }
    } catch (err) {
      console.error('Error handling WebSocket message:', err);
    }
  };

  ws.onclose = () => {
    console.log('WebSocket closed');
    setConnectionStatus('disconnected');
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

  // Cap exponential backoff at 10 seconds
  reconnectDelay = Math.min(reconnectDelay * 2, 10000);
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

  // 1. Check if syncTabId still exists
  let targetTab = null;
  if (syncTabId !== null) {
    try {
      targetTab = await chrome.tabs.get(syncTabId);
    } catch (e) {
      syncTabId = null; // Tab was closed
    }
  }

  // 2. If no valid syncTabId, try to find any existing YouTube tab //MARK: Change behaviour to click-only, not automatic
  if (!targetTab) {
    const ytTabs = await chrome.tabs.query({ url: '*://*.youtube.com/*' });
    if (ytTabs.length > 0) {
      targetTab = ytTabs[0];
      syncTabId = targetTab.id;
    }
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

  if (!targetTab) {
    // Create new dedicated sync tab
    console.log('Creating new YouTube sync tab for:', currentUrl);
    const newTab = await chrome.tabs.create({ url: currentUrl });
    syncTabId = newTab.id;
  } else if (targetVid && targetVid !== currentVid) {
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
        sendWSMessage({
          type: 'updateState',
          payload: message.payload
        });
      }
    });
    sendResponse({ ack: true });
  }
  return true; // Keep channel open for async response
});
