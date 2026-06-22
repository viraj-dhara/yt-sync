document.addEventListener('DOMContentLoaded', async () => {
  const btnHost = document.getElementById('btn-host');
  const btnFollower = document.getElementById('btn-follower');
  const statusDot = document.getElementById('status-dot');
  const statusText = document.getElementById('status-text');

  // Load the current role from storage (default to 'follower')
  const { role = 'follower' } = await chrome.storage.local.get('role');
  updateRoleUI(role);

  // Initialize active tab synchronization if on YouTube
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

  // Ask background service worker for current connection status
  try {
    const response = await chrome.runtime.sendMessage({ type: 'getConnectionStatus' });
    if (response && response.status) {
      updateStatusUI(response.status);
    }
  } catch (err) {
    console.error('Failed to contact background script:', err);
  }

  // Handle role selections
  btnHost.addEventListener('click', () => setRole('host'));
  btnFollower.addEventListener('click', () => setRole('follower'));

  // Listen to status updates from background service worker
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'statusUpdate') {
      updateStatusUI(message.status);
    }
  });

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

  function updateRoleUI(activeRole) {
    if (activeRole === 'host') {
      btnHost.classList.add('active');
      btnFollower.classList.remove('active');
    } else {
      btnFollower.classList.add('active');
      btnHost.classList.remove('active');
    }
  }

  function updateStatusUI(status) {
    statusDot.className = 'status-dot';
    if (status === 'connected') {
      statusDot.classList.add('connected');
      statusText.textContent = 'Online';
    } else if (status === 'connecting') {
      statusDot.classList.add('connecting');
      statusText.textContent = 'Connecting';
    } else {
      statusText.textContent = 'Offline';
    }
  }
});
