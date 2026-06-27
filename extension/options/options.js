// MARK: - Default Configuration Constants
const DEFAULT_CONFIGS = {
  serverUrl: 'ws://yt-sync.viraj-homelab.online',
  domPollInterval: 500,
  hostBroadcastInterval: 500,
  throttleThreshold: 200,
  driftThreshold: 0.5,
  keepAliveInterval: 1000,
  followerSyncThrottle: 1000,
  heartbeatInterval: 20000,
  reconnectDelayInitial: 1000,
  reconnectDelayMax: 10000,
  defaultTransitEstimate: 50
};

// MARK: - DOM Elements
const settingsForm = document.getElementById('settings-form');
const btnSaveTop = document.getElementById('btn-save-top');
const btnResetDefaults = document.getElementById('btn-reset-defaults');
const btnReconnect = document.getElementById('btn-reconnect');
const btnClearStats = document.getElementById('btn-clear-stats');
const toast = document.getElementById('toast');

// Form Inputs
const inputKeys = Object.keys(DEFAULT_CONFIGS);

// Diagnostics elements
const diagStatus = document.getElementById('diagnostic-status');
const diagOffset = document.getElementById('diagnostic-offset');
const diagSent = document.getElementById('diagnostic-sent');
const diagReceived = document.getElementById('diagnostic-received');
const diagTabId = document.getElementById('diagnostic-tab-id');
const diagHostUrl = document.getElementById('diagnostic-host-url');
const diagLastError = document.getElementById('diagnostic-last-error');
const diagLastPayload = document.getElementById('diagnostic-last-payload');

// MARK: - Initial Page Setup
document.addEventListener('DOMContentLoaded', async () => {
  displayVersion();
  await loadSettings();
  startDiagnosticLoop();
});

function displayVersion() {
  const versionElement = document.getElementById('ext-version');
  if (versionElement && chrome.runtime?.getManifest) {
    const manifest = chrome.runtime.getManifest();
    versionElement.textContent = `v${manifest.version}`;
  }
}

// Load settings from storage and populate form
async function loadSettings() {
  const settings = await chrome.storage.local.get(inputKeys);
  
  inputKeys.forEach(key => {
    const inputElement = document.getElementById(key);
    if (inputElement) {
      // If setting is not yet defined in storage, fall back to default
      const val = settings[key] !== undefined ? settings[key] : DEFAULT_CONFIGS[key];
      inputElement.value = val;
    }
  });
}

// MARK: - Event Listeners
settingsForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  await saveSettings();
});

btnSaveTop.addEventListener('click', async () => {
  if (settingsForm.reportValidity()) {
    await saveSettings();
  }
});

btnResetDefaults.addEventListener('click', () => {
  if (confirm('Are you sure you want to reset all configurations to their original default values?')) {
    inputKeys.forEach(key => {
      const inputElement = document.getElementById(key);
      if (inputElement) {
        inputElement.value = DEFAULT_CONFIGS[key];
      }
    });
    saveSettings();
  }
});

btnReconnect.addEventListener('click', async () => {
  btnReconnect.disabled = true;
  btnReconnect.textContent = 'Reloading connection...';
  try {
    const response = await chrome.runtime.sendMessage({ type: 'forceReconnect' });
    if (response && response.ack) {
      showToast('WebSocket Connection Reloaded!');
    }
  } catch (err) {
    console.error('Failed to trigger reconnect:', err);
  }
  setTimeout(() => {
    btnReconnect.disabled = false;
    btnReconnect.textContent = 'Reload WebSocket Connection';
  }, 1000);
});

btnClearStats.addEventListener('click', async () => {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'resetCounters' });
    if (response && response.ack) {
      showToast('Diagnostic Counters Cleared!');
      updateDiagnostics();
    }
  } catch (err) {
    console.error('Failed to clear stats:', err);
  }
});

// Save settings to local storage
async function saveSettings() {
  const updatedSettings = {};
  inputKeys.forEach(key => {
    const inputElement = document.getElementById(key);
    if (inputElement) {
      const type = inputElement.getAttribute('type');
      if (type === 'number') {
        updatedSettings[key] = parseFloat(inputElement.value);
      } else {
        updatedSettings[key] = inputElement.value;
      }
    }
  });

  await chrome.storage.local.set(updatedSettings);
  showToast('Settings Saved Successfully!');
}

// Show Toast Alert
function showToast(message) {
  toast.textContent = message;
  toast.classList.add('show');
  setTimeout(() => {
    toast.classList.remove('show');
  }, 3000);
}

// MARK: - Diagnostics Update Loop
function startDiagnosticLoop() {
  // Update diagnostics once immediately, then poll every second
  updateDiagnostics();
  setInterval(updateDiagnostics, 1000);
}

async function updateDiagnostics() {
  try {
    const state = await chrome.runtime.sendMessage({ type: 'getInternalState' });
    if (!state) return;

    // 1. Connection Status Badge
    diagStatus.className = 'badge';
    if (state.connectionStatus === 'connected') {
      diagStatus.classList.add('badge-connected');
      diagStatus.textContent = 'Connected';
    } else if (state.connectionStatus === 'connecting') {
      diagStatus.classList.add('badge-connecting');
      diagStatus.textContent = 'Connecting';
    } else {
      diagStatus.classList.add('badge-disconnected');
      diagStatus.textContent = 'Disconnected';
    }

    // 2. Clock NTP Offset
    if (state.hasSyncedTime) {
      diagOffset.textContent = `${state.serverTimeOffset}ms (calibrated)`;
      diagOffset.style.color = 'var(--success-color)';
    } else {
      diagOffset.textContent = `${state.serverTimeOffset}ms (uncalibrated)`;
      diagOffset.style.color = 'var(--text-secondary)';
    }

    // 3. Sent/Received Metrics
    diagSent.textContent = state.stats.sent;
    diagReceived.textContent = state.stats.received;

    // 4. Current Sync Tab ID
    diagTabId.textContent = state.syncTabId !== null ? state.syncTabId : 'None';

    // 5. Last URL and Error Info
    diagHostUrl.textContent = state.lastKnownHostUrl ? state.lastKnownHostUrl : 'None';
    diagHostUrl.title = state.lastKnownHostUrl ? state.lastKnownHostUrl : 'None';

    diagLastError.textContent = state.stats.lastError ? state.stats.lastError : 'None';
    diagLastError.title = state.stats.lastError ? state.stats.lastError : 'None';

    // 6. Last WebSocket Payload
    if (state.stats.lastMessage) {
      diagLastPayload.value = typeof state.stats.lastMessage === 'object' 
        ? JSON.stringify(state.stats.lastMessage, null, 2) 
        : state.stats.lastMessage;
    } else {
      diagLastPayload.value = 'No payload received yet';
    }
  } catch (err) {
    // Background service worker might be asleep or unavailable
    diagStatus.className = 'badge badge-disconnected';
    diagStatus.textContent = 'Offline';
  }
}
