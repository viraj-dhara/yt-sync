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

  // Get active tab info to check if it's YouTube
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const isYouTube = tab && tab.url && tab.url.includes('youtube.com');
  const warningCard = document.getElementById('warning-card');

  if (isYouTube) {
    // Show normal role card, hide warning
    roleCard.style.display = 'block';
    warningCard.style.display = 'none';
  } else {
    // Non-YouTube page: hide role card, show warning
    roleCard.style.display = 'none';
    warningCard.style.display = 'block';

    // Query background script if there is another tab already syncing
    try {
      const response = await chrome.runtime.sendMessage({ type: 'getSyncTabInfo' });
      const warningText = document.getElementById('warning-text');
      const syncTabInfo = document.getElementById('sync-tab-info');
      const syncTabTitle = document.getElementById('sync-tab-title');

      if (response && response.id && response.title) {
        warningText.textContent = "Please open YouTube.com to start synchronization.";
        syncTabInfo.style.display = "block";
        
        let cleanTitle = response.title;
        if (cleanTitle.startsWith("SYNCING - ")) {
          cleanTitle = cleanTitle.substring("SYNCING - ".length);
        }
        syncTabTitle.textContent = cleanTitle;
      } else {
        warningText.textContent = "Please open YouTube.com to start synchronization.";
        syncTabInfo.style.display = "none";
      }
    } catch (err) {
      console.error('Failed to retrieve sync tab info:', err);
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

    // Check if we are on a YouTube tab
    const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const isYT = activeTab && activeTab.url && activeTab.url.includes('youtube.com');

    if (isEnabled && !isYT) {
      // Prevent enabling sync from a non-YouTube page
      syncToggle.checked = false;
      showWarningToast("Please open a youtube.com tab to start syncing.");
      return;
    }

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
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
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

  // Listen to storage changes to keep popup state synced globally
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local') {
      if (changes.enabled) {
        syncToggle.checked = changes.enabled.newValue;
        updateToggleUI(changes.enabled.newValue);
      }
      if (changes.role) {
        updateRoleUI(changes.role.newValue);
      }
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

  // Periodic notice check for local follower pauses
  async function updateSyncTabNotice() {
    const followerNotice = document.getElementById('follower-paused-notice');
    if (!followerNotice) return;

    const { enabled = false, role = 'follower' } = await chrome.storage.local.get(['enabled', 'role']);
    
    if (enabled && role === 'follower') {
      try {
        const response = await chrome.runtime.sendMessage({ type: 'getSyncTabInfo' });
        if (response && response.isLocallyPaused) {
          followerNotice.style.display = 'block';
        } else {
          followerNotice.style.display = 'none';
        }
      } catch (err) {
        followerNotice.style.display = 'none';
      }
    } else {
      followerNotice.style.display = 'none';
    }
  }

  function showWarningToast(message) {
    let toast = document.getElementById('yt-sync-warning-toast');
    if (toast) toast.remove();

    toast = document.createElement('div');
    toast.id = 'yt-sync-warning-toast';
    toast.style.position = 'fixed';
    toast.style.bottom = '12px';
    toast.style.left = '12px';
    toast.style.right = '12px';
    toast.style.backgroundColor = '#ef4444';
    toast.style.color = '#ffffff';
    toast.style.padding = '10px 14px';
    toast.style.borderRadius = '10px';
    toast.style.fontFamily = 'inherit';
    toast.style.fontSize = '12px';
    toast.style.fontWeight = '700';
    toast.style.boxShadow = '0 10px 15px -3px rgba(0, 0, 0, 0.2)';
    toast.style.zIndex = '999999';
    toast.style.transition = 'opacity 0.25s ease, transform 0.25s ease';
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(15px)';
    toast.style.display = 'flex';
    toast.style.alignItems = 'center';
    toast.style.justifyContent = 'space-between';
    toast.style.gap = '8px';

    const content = document.createElement('div');
    content.style.display = 'flex';
    content.style.alignItems = 'center';
    content.style.gap = '8px';

    const icon = document.createElement('span');
    icon.textContent = '⚠️';
    icon.style.fontSize = '14px';
    content.appendChild(icon);

    const text = document.createElement('span');
    text.textContent = message;
    content.appendChild(text);
    toast.appendChild(content);

    const closeBtn = document.createElement('button');
    closeBtn.textContent = '✕';
    closeBtn.style.background = 'none';
    closeBtn.style.border = 'none';
    closeBtn.style.color = '#ffffff';
    closeBtn.style.cursor = 'pointer';
    closeBtn.style.fontSize = '14px';
    closeBtn.style.padding = '0 4px';
    closeBtn.style.fontFamily = 'inherit';
    closeBtn.style.fontWeight = '700';
    closeBtn.addEventListener('click', () => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(15px)';
      setTimeout(() => toast.remove(), 250);
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
        toast.style.transform = 'translateY(15px)';
        setTimeout(() => toast.remove(), 250);
      }
    }, 5000);
  }

  // Run immediately and poll every 1s while popup is open
  updateSyncTabNotice();
  setInterval(updateSyncTabNotice, 1000);
});
