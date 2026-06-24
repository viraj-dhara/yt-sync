const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Single global state for YouTube sync
let globalState = {
  currentUrl: '',
  state: 'paused', // 'playing' | 'paused'
  currentTime: 0,
  updatedAt: Date.now()
};

// Track the current host connection
let hostSocket = null;

// Basic HTTP health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', hasHost: !!hostSocket, clientsCount: wss.clients.size });
});

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
  
  // Assign a temporary role as follower until they register
  ws.role = 'follower';

  // Send the current global state immediately on connection
  ws.send(JSON.stringify({
    type: 'syncState',
    payload: globalState
  }));

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
            console.log('Host registered');
          } else {
            ws.role = 'follower';
            if (hostSocket === ws) {
              hostSocket = null;
              console.log('Host unregistered');
            }
          }
          break;

        case 'updateState':
          // Only the registered host can update the global state
          if (ws.role === 'host') {
            globalState = {
              currentUrl: message.payload.currentUrl,
              state: message.payload.state,
              currentTime: message.payload.currentTime,
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
    console.log('Client disconnected');
    if (ws === hostSocket) {
      hostSocket = null;
      console.log('Host disconnected');
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
