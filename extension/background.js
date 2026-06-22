const SERVER_URL = 'ws://yt-sync.viraj-homelab.online';
let ws = null;
let connectionStatus = 'disconnected';
let reconnectTimeout = null;
let reconnectDelay = 1000;

// Track follower's sync tab ID
let syncTabId = null;

// Initialize connection
connect();

function setConnectionStatus(status) {
  connectionStatus = status;
  // Notify any open popups of status update
  chrome.runtime.sendMessage({ type: 'statusUpdate', status }).catch(() => {
    // Ignore errors when popup is closed
  });
}

function connect() {
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

    // Send role registration immediately
    const { role = 'follower' } = await chrome.storage.local.get('role');
    sendWSMessage({ type: 'setRole', role });
  };

  ws.onmessage = async (event) => {
    try {
      const message = JSON.parse(event.data);
      console.log('WebSocket message received:', message);

      if (message.type === 'syncState') {
        const { role = 'follower' } = await chrome.storage.local.get('role');
        if (role === 'follower') {
          await handleFollowerSync(message.payload);
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
    scheduleReconnect();
  };

  ws.onerror = (err) => {
    console.error('WebSocket error:', err);
    setConnectionStatus('disconnected');
  };
}

function scheduleReconnect() {
  if (reconnectTimeout) clearTimeout(reconnectTimeout);

  // Cap exponential backoff at 16 seconds
  reconnectDelay = Math.min(reconnectDelay * 2, 16000);
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

// Handles Follower tab selection and synchronization
async function handleFollowerSync(payload) {
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

  // 2. If no valid syncTabId, try to find any existing YouTube tab
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
        payload
      });
    } catch (err) {
      // Content script might not be loaded yet, retry shortly or ignore
      console.log('Could not send message to tab content script:', err.message);
    }
  }
}

// Automatically re-inject content script when the synced tab navigates/reloads.
// Since the extension does not declare static content script match patterns (to avoid CWS host permission prompt),
// we must programmatically inject content.js.
// When the sync tab navigates to a new video (triggering a page reload) or is newly created,
// the previous content script context is destroyed.
// This listener detects when the tab has finished loading ('complete' status) and executes the injection.
// The activeTab permission remains active for this tab as long as the origin (youtube.com) does not change.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (tabId === syncTabId && changeInfo.status === 'complete') {
    console.log('Sync tab reloaded/navigated, injecting content script...');
    chrome.scripting.executeScript({
      target: { tabId: tabId },
      files: ['content.js']
    }).catch((err) => {
      console.warn('Failed to auto-inject content script on tab update:', err);
    });
  }
});

// Listen for messages from popup or content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'getConnectionStatus') {
    sendResponse({ status: connectionStatus });
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
    chrome.storage.local.get('role').then(({ role = 'follower' }) => {
      if (role === 'host') {
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
