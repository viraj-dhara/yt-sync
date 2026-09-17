// Offscreen Document WebRTC PeerConnection Manager for yt-sync

const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

let myClientId = null;
let currentRole = 'follower';
let targetHostId = null;

// Map of peer connections: peerId -> { pc, fastChannel, cmdChannel, p2pRtt, clockOffset }
const peers = new Map();

// High resolution P2P clock offset (Host server time - Follower local time)
let p2pClockOffset = 0;
let hasP2PClockSynced = false;

// Connect port to background.js for signaling & command exchange
let bgPort = null;
function connectToBackground() {
  try {
    bgPort = chrome.runtime.connect({ name: 'webrtc-offscreen' });
    bgPort.onMessage.addListener(handleBackgroundMessage);
    bgPort.onDisconnect.addListener(() => {
      bgPort = null;
      setTimeout(connectToBackground, 1000);
    });
  } catch (e) {
    setTimeout(connectToBackground, 1000);
  }
}
connectToBackground();

function postToBackground(msg) {
  if (bgPort) {
    bgPort.postMessage(msg);
  }
}

// MARK: - Signaling Message Handler from Background
function handleBackgroundMessage(msg) {
  switch (msg.type) {
    case 'init':
      myClientId = msg.clientId;
      currentRole = msg.role;
      targetHostId = msg.hostId;
      if (currentRole === 'follower' && targetHostId) {
        initiateFollowerConnection(targetHostId);
      }
      break;

    case 'roleChanged':
      currentRole = msg.role;
      closeAllPeers();
      break;

    case 'hostAvailable':
      targetHostId = msg.hostId;
      if (currentRole === 'follower') {
        initiateFollowerConnection(targetHostId);
      }
      break;

    case 'hostUnavailable':
      if (currentRole === 'follower') {
        closeAllPeers();
        postToBackground({ type: 'webrtcState', state: 'disconnected' });
      }
      break;

    case 'signalOffer':
      handleIncomingOffer(msg.fromId, msg.offer);
      break;

    case 'signalAnswer':
      handleIncomingAnswer(msg.fromId, msg.answer);
      break;

    case 'signalIceCandidate':
      handleIncomingCandidate(msg.fromId, msg.candidate);
      break;

    case 'peerDisconnected':
      closePeer(msg.peerId);
      break;

    // Outgoing sync payload from Host's content script to broadcast to all followers
    case 'broadcastSync':
      broadcastToPeers(msg.channel, msg.payload);
      break;

    default:
      break;
  }
}

// MARK: - Peer Connection Management

function createPeerConnection(peerId) {
  if (peers.has(peerId)) {
    closePeer(peerId);
  }

  const pc = new RTCPeerConnection(RTC_CONFIG);
  const peerRecord = {
    pc,
    fastChannel: null, // Unordered, 0-retransmit channel for 100ms sync ticks
    cmdChannel: null,  // Reliable channel for pause/seek/url and ping/pong
    p2pRtt: 0
  };
  peers.set(peerId, peerRecord);

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      postToBackground({
        type: 'sendSignal',
        signalType: 'signalIceCandidate',
        targetId: peerId,
        candidate: event.candidate
      });
    }
  };

  pc.onconnectionstatechange = () => {
    console.log(`[WebRTC Offscreen] Peer ${peerId} state: ${pc.connectionState}`);
    if (pc.connectionState === 'connected') {
      postToBackground({ type: 'webrtcState', state: 'connected', peerId });
    } else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
      postToBackground({ type: 'webrtcState', state: pc.connectionState, peerId });
      closePeer(peerId);
    }
  };

  return peerRecord;
}

function setupDataChannelListeners(peerId, channel, channelName) {
  channel.onopen = () => {
    console.log(`[WebRTC Offscreen] DataChannel '${channelName}' opened with peer ${peerId}`);
    if (channelName === 'cmd' && currentRole === 'follower') {
      startP2PTimeSync(peerId);
    }
  };

  channel.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      handleDataChannelMessage(peerId, channelName, data);
    } catch (e) {
      console.error('[WebRTC Offscreen] Error parsing datachannel message:', e);
    }
  };

  channel.onerror = (err) => {
    console.warn(`[WebRTC Offscreen] DataChannel '${channelName}' error:`, err);
  };
}

// MARK: - Follower Initiator Workflow
async function initiateFollowerConnection(hostId) {
  console.log(`[WebRTC Offscreen] Follower initiating connection to host ${hostId}`);
  const peerRecord = createPeerConnection(hostId);
  const pc = peerRecord.pc;

  // Follower creates the DataChannels
  // 1. fastChannel: unordered, maxRetransmits: 0 for loss-tolerant 100ms ticks
  const fastChannel = pc.createDataChannel('yt-sync-fast', {
    ordered: false,
    maxRetransmits: 0
  });
  peerRecord.fastChannel = fastChannel;
  setupDataChannelListeners(hostId, fastChannel, 'fast');

  // 2. cmdChannel: ordered, reliable for commands and time sync
  const cmdChannel = pc.createDataChannel('yt-sync-cmd', {
    ordered: true
  });
  peerRecord.cmdChannel = cmdChannel;
  setupDataChannelListeners(hostId, cmdChannel, 'cmd');

  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    postToBackground({
      type: 'sendSignal',
      signalType: 'signalOffer',
      targetId: hostId,
      offer
    });
  } catch (err) {
    console.error('[WebRTC Offscreen] Error creating offer:', err);
  }
}

// MARK: - Host Receiver Workflow (Answers Follower's Offer)
async function handleIncomingOffer(followerId, offer) {
  console.log(`[WebRTC Offscreen] Host received offer from follower ${followerId}`);
  const peerRecord = createPeerConnection(followerId);
  const pc = peerRecord.pc;

  pc.ondatachannel = (event) => {
    const channel = event.channel;
    if (channel.label === 'yt-sync-fast') {
      peerRecord.fastChannel = channel;
      setupDataChannelListeners(followerId, channel, 'fast');
    } else if (channel.label === 'yt-sync-cmd') {
      peerRecord.cmdChannel = channel;
      setupDataChannelListeners(followerId, channel, 'cmd');
    }
  };

  try {
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    postToBackground({
      type: 'sendSignal',
      signalType: 'signalAnswer',
      targetId: followerId,
      answer
    });
  } catch (err) {
    console.error('[WebRTC Offscreen] Error handling offer:', err);
  }
}

// MARK: - Follower Receives Host's Answer
async function handleIncomingAnswer(hostId, answer) {
  const peerRecord = peers.get(hostId);
  if (!peerRecord) return;
  try {
    await peerRecord.pc.setRemoteDescription(new RTCSessionDescription(answer));
    console.log(`[WebRTC Offscreen] Follower set remote description from host ${hostId}`);
  } catch (err) {
    console.error('[WebRTC Offscreen] Error setting remote description:', err);
  }
}

// MARK: - ICE Candidate Receiver
async function handleIncomingCandidate(peerId, candidate) {
  const peerRecord = peers.get(peerId);
  if (!peerRecord) return;
  try {
    await peerRecord.pc.addIceCandidate(new RTCIceCandidate(candidate));
  } catch (err) {
    console.error('[WebRTC Offscreen] Error adding ICE candidate:', err);
  }
}

// MARK: - DataChannel Message Processing & P2P Clock Sync

function handleDataChannelMessage(peerId, channelName, msg) {
  if (msg.type === 'p2pPing') {
    // Host replies immediately to follower's ping with local timestamp
    const peerRecord = peers.get(peerId);
    if (peerRecord && peerRecord.cmdChannel && peerRecord.cmdChannel.readyState === 'open') {
      peerRecord.cmdChannel.send(JSON.stringify({
        type: 'p2pPong',
        clientSendTime: msg.clientSendTime,
        hostTime: Date.now()
      }));
    }
    return;
  }

  if (msg.type === 'p2pPong') {
    // Follower calculates RTT and clock offset
    const t0 = msg.clientSendTime;
    const tHost = msg.hostTime;
    const t1 = Date.now();
    const rtt = Math.max(1, t1 - t0);
    p2pClockOffset = (tHost + rtt / 2) - t1;
    hasP2PClockSynced = true;

    const peerRecord = peers.get(peerId);
    if (peerRecord) peerRecord.p2pRtt = rtt;
    console.log(`[WebRTC Offscreen] P2P Clock Synced. RTT: ${rtt}ms, ClockOffset: ${p2pClockOffset}ms`);
    return;
  }

  // Follower received a playback sync packet (either high-frequency tick or command)
  if (msg.type === 'syncPlayback') {
    // Forward directly to background -> content script
    postToBackground({
      type: 'followerPlaybackUpdate',
      payload: msg.payload,
      p2pRtt: peers.get(peerId)?.p2pRtt || 20,
      p2pClockOffset: p2pClockOffset,
      receivedAt: Date.now()
    });
  }
}

function startP2PTimeSync(hostId) {
  // Sync P2P clock periodically every 15s over cmdChannel
  const sendPing = () => {
    const peerRecord = peers.get(hostId);
    if (peerRecord && peerRecord.cmdChannel && peerRecord.cmdChannel.readyState === 'open') {
      peerRecord.cmdChannel.send(JSON.stringify({
        type: 'p2pPing',
        clientSendTime: Date.now()
      }));
    }
  };

  sendPing();
  setInterval(sendPing, 15000);
}

// Broadcast outgoing state from Host to all connected followers
function broadcastToPeers(channelType, payload) {
  const channelKey = channelType === 'fast' ? 'fastChannel' : 'cmdChannel';
  const packet = JSON.stringify({
    type: 'syncPlayback',
    payload
  });

  for (const [peerId, peer] of peers.entries()) {
    const ch = peer[channelKey];
    if (ch && ch.readyState === 'open') {
      try {
        ch.send(packet);
      } catch (e) {
        console.warn(`[WebRTC Offscreen] Failed to send on ${channelType} to ${peerId}:`, e);
      }
    }
  }
}

function closePeer(peerId) {
  const peerRecord = peers.get(peerId);
  if (peerRecord) {
    try {
      if (peerRecord.fastChannel) peerRecord.fastChannel.close();
      if (peerRecord.cmdChannel) peerRecord.cmdChannel.close();
      peerRecord.pc.close();
    } catch (e) { }
    peers.delete(peerId);
  }
}

function closeAllPeers() {
  for (const peerId of peers.keys()) {
    closePeer(peerId);
  }
}
