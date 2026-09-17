const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;

// Single global state for YouTube sync
let globalState = {
  currentUrl: '',
  state: 'paused', // 'playing' | 'paused'
  currentTime: 0,
  playbackRate: 1.0,
  updatedAt: Date.now()
};

// Track the current host connection
let hostSocket = null;

// Setup HTTP server with a basic health check handler
const server = http.createServer((req, res) => {
  if (req.url === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', hasHost: !!hostSocket, clientsCount: wss.clients.size }));
  } else {
    res.writeHead(404);
    res.end();
  }
});
const wss = new WebSocket.Server({ server });

// Setup heartbeat check to prune dead clients (e.g. from machine sleep)
const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      console.log('Pruning dead client connection');
      if (ws === hostSocket) {
        hostSocket = null;
        console.log('Host disconnected (pruned)');
      }
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('connection', (ws) => {
  console.log('Client connected');
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  // Assign a unique client ID and temporary role
  ws.clientId = Math.random().toString(36).substring(2, 10);
  ws.role = 'follower';
  console.log(`Client connected: ${ws.clientId}`);

  // Send the assigned clientId to the connecting peer
  ws.send(JSON.stringify({
    type: 'initPeer',
    clientId: ws.clientId,
    hasHost: !!hostSocket,
    hostId: hostSocket ? hostSocket.clientId : null
  }));

  // Send the current global state immediately on connection if there is an active host and the state is fresh
  const isStateFresh = globalState.currentUrl && (Date.now() - globalState.updatedAt < 20000);
  if (hostSocket && isStateFresh) {
    ws.send(JSON.stringify({
      type: 'syncState',
      payload: globalState
    }));
  }

  ws.on('message', (messageText) => {
    try {
      const message = JSON.parse(messageText);

      switch (message.type) {
        case 'setRole':
          if (message.role === 'host') {
            // If another socket was host, demote it
            if (hostSocket && hostSocket !== ws && hostSocket.readyState === WebSocket.OPEN) {
              hostSocket.role = 'follower';
              hostSocket.send(JSON.stringify({ type: 'roleDemoted' }));
            }
            ws.role = 'host';
            hostSocket = ws;
            console.log(`Host registered: ${ws.clientId}`);

            // Broadcast hostAvailable to all followers to kick off WebRTC offer/answer
            const hostNotice = JSON.stringify({
              type: 'hostAvailable',
              hostId: ws.clientId
            });
            wss.clients.forEach((client) => {
              if (client !== ws && client.readyState === WebSocket.OPEN) {
                client.send(hostNotice);
              }
            });
          } else {
            ws.role = 'follower';
            if (hostSocket === ws) {
              hostSocket = null;
              console.log(`Host unregistered: ${ws.clientId}`);
              // Notify followers that host left
              const noHostNotice = JSON.stringify({ type: 'hostUnavailable' });
              wss.clients.forEach((client) => {
                if (client.readyState === WebSocket.OPEN) {
                  client.send(noHostNotice);
                }
              });
            }
          }
          break;

        // WebRTC Signaling: Offer from follower to host, or vice versa
        case 'signalOffer': {
          const target = message.targetId;
          const offerMsg = JSON.stringify({
            type: 'signalOffer',
            fromId: ws.clientId,
            offer: message.offer
          });
          wss.clients.forEach((client) => {
            if (client.clientId === target && client.readyState === WebSocket.OPEN) {
              client.send(offerMsg);
            }
          });
          break;
        }

        // WebRTC Signaling: Answer from peer
        case 'signalAnswer': {
          const target = message.targetId;
          const answerMsg = JSON.stringify({
            type: 'signalAnswer',
            fromId: ws.clientId,
            answer: message.answer
          });
          wss.clients.forEach((client) => {
            if (client.clientId === target && client.readyState === WebSocket.OPEN) {
              client.send(answerMsg);
            }
          });
          break;
        }

        // WebRTC Signaling: ICE Candidate exchange
        case 'signalIceCandidate': {
          const target = message.targetId;
          const candMsg = JSON.stringify({
            type: 'signalIceCandidate',
            fromId: ws.clientId,
            candidate: message.candidate
          });
          wss.clients.forEach((client) => {
            if (client.clientId === target && client.readyState === WebSocket.OPEN) {
              client.send(candMsg);
            }
          });
          break;
        }

        case 'updateState':
          // Only the registered host can update the global state (used as WebSocket relay fallback)
          if (ws.role === 'host') {
            globalState = {
              currentUrl: message.payload.currentUrl,
              state: message.payload.state,
              currentTime: message.payload.currentTime,
              playbackRate: message.payload.playbackRate !== undefined ? message.payload.playbackRate : 1.0,
              sentAt: message.payload.sentAt,
              updatedAt: Date.now()
            };

            // Broadcast to all other connected clients
            const broadcastMessage = JSON.stringify({
              type: 'syncState',
              payload: globalState
            });

            wss.clients.forEach((client) => {
              if (client !== ws && client.readyState === WebSocket.OPEN) {
                client.send(broadcastMessage);
              }
            });
          }
          break;

        case 'timeSync':
          ws.send(JSON.stringify({
            type: 'timeSyncResponse',
            payload: {
              clientTime: message.payload.clientTime,
              serverTime: Date.now()
            }
          }));
          break;

        case 'ping':
          // Silent heartbeat response to keep connection alive
          break;

        default:
          console.warn('Unknown message type:', message.type);
      }
    } catch (err) {
      console.error('Error handling message:', err);
    }
  });

  ws.on('close', () => {
    console.log(`Client disconnected: ${ws.clientId}`);
    if (ws === hostSocket) {
      hostSocket = null;
      console.log('Host disconnected');
      globalState.currentUrl = ''; // Clear stored state URL when host departs
      const noHostNotice = JSON.stringify({ type: 'hostUnavailable' });
      wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(noHostNotice);
        }
      });
    } else {
      // Notify host that a follower peer disconnected
      if (hostSocket && hostSocket.readyState === WebSocket.OPEN) {
        hostSocket.send(JSON.stringify({
          type: 'peerDisconnected',
          peerId: ws.clientId
        }));
      }
    }
  });

  ws.on('error', (err) => {
    console.error('WebSocket client error:', err);
  });
});

wss.on('close', () => {
  clearInterval(heartbeatInterval);
});

server.listen(PORT, () => {
  console.log(`YouTube Sync server listening on port ${PORT}`);
});
