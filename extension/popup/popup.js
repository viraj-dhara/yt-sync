// MARK: - DOM Content Loaded Initialization

document.addEventListener('DOMContentLoaded', async () => {
  const btnHost = document.getElementById('btn-host');
  const btnFollower = document.getElementById('btn-follower');
  const statusDot = document.getElementById('status-dot');
  const statusText = document.getElementById('status-text');
  const syncToggle = document.getElementById('sync-enable-toggle');
  const roleCard = document.getElementById('role-card');

  // Load the current enabled and role state
  const { enabled = false, role = 'follower' } = await chrome.storage.local.get(['enabled', 'role']);
  syncToggle.checked = enabled;
  updateRoleUI(role);
  updateToggleUI(enabled);

  // Initialize active tab synchronization ONLY if enabled
  if (enabled) {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab && tab.url && tab.url.includes('youtube.com')) {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content.js']
        });
        await chrome.runtime.sendMessage({ type: 'registerSyncTab', tabId: tab.id });
      }
    } catch (err) {
      console.error('Failed to initialize active tab synchronization:', err);
    }
  }

  // Ask background service worker for current connection status
  try {
    const response = await chrome.runtime.sendMessage({ type: 'getConnectionStatus' });
    if (response && response.status) {
      updateStatusUI(response.status);
    }
  } catch (err) {
    console.error('Failed to contact background script:', err);
  }



  // MARK: - UI Event Listeners

  // Handle master toggle switch
  syncToggle.addEventListener('change', async () => {
    const isEnabled = syncToggle.checked;
    await chrome.storage.local.set({ enabled: isEnabled });
    updateToggleUI(isEnabled);

    try {
      await chrome.runtime.sendMessage({ type: 'toggleEnabled', enabled: isEnabled });
    } catch (err) {
      console.error('Failed to notify toggle change:', err);
    }

    // Auto-inject script immediately if enabled on a YouTube page
    if (isEnabled) {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab && tab.url && tab.url.includes('youtube.com')) {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['content.js']
          });
          await chrome.runtime.sendMessage({ type: 'registerSyncTab', tabId: tab.id });
        }
      } catch (err) {
        console.error('Failed to auto-inject on toggle enable:', err);
      }
    }
  });

  // Handle role selections
  btnHost.addEventListener('click', () => setRole('host'));
  btnFollower.addEventListener('click', () => setRole('follower'));

  // MARK: - Extension Message Receivers
  // Listen to status updates from background service worker
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'statusUpdate') {
      updateStatusUI(message.status);
    }
  });


  // MARK: - State Management Functions

  async function setRole(newRole) {
    await chrome.storage.local.set({ role: newRole });
    updateRoleUI(newRole);

    // Notify background script about the change
    try {
      await chrome.runtime.sendMessage({ type: 'roleChanged', role: newRole });
    } catch (err) {
      console.error('Failed to notify role change:', err);
    }
  }

  // MARK: - UI Rendering Helpers
  function updateRoleUI(activeRole) {
    if (activeRole === 'host') {
      btnHost.classList.add('active');
      btnFollower.classList.remove('active');
    } else {
      btnFollower.classList.add('active');
      btnHost.classList.remove('active');
    }
  }

  function updateToggleUI(isEnabled) {
    if (isEnabled) {
      roleCard.classList.remove('disabled');
    } else {
      roleCard.classList.add('disabled');
      updateStatusUI('disconnected');
    }
  }

  function updateStatusUI(status) {
    const isEnabled = syncToggle.checked;
    statusDot.className = 'status-dot';
    if (isEnabled && status === 'connected') {
      statusDot.classList.add('connected');
      statusText.textContent = 'Online';
    } else if (isEnabled && status === 'connecting') {
      statusDot.classList.add('connecting');
      statusText.textContent = 'Connecting';
    } else {
      statusText.textContent = 'Offline';
    }
  }
});
