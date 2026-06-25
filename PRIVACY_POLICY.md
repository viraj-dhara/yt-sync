# Privacy Policy for YouTube Sync

**Last Updated:** June 25, 2026

This Privacy Policy explains how the **YouTube Sync** Chrome Extension collects, uses, stores, and shares data when you use our product. We are committed to protecting your privacy and being transparent about our data handling practices.

---

## 1. Overview of the Extension
YouTube Sync is designed to synchronize YouTube playback (play, pause, seek) and navigation (video URL transitions) in real-time between multiple browser clients. The extension functions in two user-selected modes:
*   **Host Mode:** Broadcasts playback events to other connected users.
*   **Follower Mode:** Listens to broadcasts and adjusts local playback to match the Host.

---

## 2. What Data We Process and Collect
To perform its core function, the extension processes the following information:

*   **YouTube Playback State:** If synchronization is enabled, we read the current YouTube video URL, playback state (playing/paused), video player current time (timestamp), and a client-side millisecond timestamp.
*   **Extension Configuration Settings:** Your synchronization state (enabled/disabled) and your selected role (Host or Follower) are stored on your device.

### 🚫 Personally Identifiable Information (PII)
YouTube Sync **does not collect, store, or transmit** any personal or sensitive information, including but not limited to:
*   Your name, email address, physical address, or phone number.
*   Browser history (except for active YouTube video URLs when sync is enabled).
*   Search history, cookies, or account credentials.
*   Device information, location data, or network telemetry.

---

## 3. How We Use and Share the Data
We use the YouTube playback state data **strictly to provide and maintain the synchronization feature**. 

*   **Data Transmission:** When in **Host Mode**, the extension transmits the active YouTube URL, playback state, and timestamp to our relay server (`ws://yt-sync.viraj-homelab.online`) via a WebSocket connection.
*   **Data Sharing:** The relay server broadcasts this state in real-time to other active users connected to the same server who are running the extension in **Follower Mode**.
*   **No Third-Party Sharing:** We do not sell, rent, trade, or share your data with any third-party advertisers, data brokers, or marketing networks. No analytics or tracking packages are included in this extension.

---

## 4. How Data Is Stored
We practice data minimization and do not store historical browsing data:

*   **Local Storage:** All configuration settings (such as activation state and role selection) are stored locally on your device using the Chrome Extension `chrome.storage.local` API. This data never leaves your device.
*   **Transient Server Memory:** The WebSocket relay server holding the sync state (`ws://yt-sync.viraj-homelab.online`) stores the playback state **only in temporary memory (RAM)**. No databases, persistent disks, or logs are used to record history. When the connection closes or the host changes, the old playback state is discarded.

---

## 5. User Controls and Data Deletion
You have complete control over your data:
*   **Toggle Off:** You can stop all data collection and WebSocket transmissions instantly by switching the "Enable Synchronization" toggle to "Off" in the extension popup UI.
*   **Role Change:** Switching your role to "Follower" instantly stops your device from publishing any YouTube playback state.
*   **Uninstall:** You can remove the extension at any time by right-clicking the icon and choosing "Remove from Chrome". This wipes all local settings from your device.

---

## 6. Policy Changes
We may update this Privacy Policy from time to time. Any changes will be posted on this page with an updated "Last Updated" date.

---

## 7. Contact Information
If you have any questions or concerns regarding this Privacy Policy or our data handling practices, please contact us at:
*   **Email:** [Your Support/Developer Email]
*   **GitHub Repository:** [Your GitHub Project Link]
