import { createLibp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { webSockets } from '@libp2p/websockets';
import { noise } from '@chainsafe/libp2p-noise';
import { mplex } from '@libp2p/mplex';
import { kadDHT } from '@libp2p/kad-dht';
import { gossipsub } from '@chainsafe/libp2p-gossipsub';
import { identify } from '@libp2p/identify';
import { ping } from '@libp2p/ping';
import { circuitRelayServer } from '@libp2p/circuit-relay-v2';
import express from 'express';
import cors from 'cors';
import { multiaddr as Multiaddr } from '@multiformats/multiaddr';
import { fromString as uint8ArrayFromString, toString as uint8ArrayToString } from 'uint8arrays';
import { WebSocketServer } from 'ws';
import http from 'http';
import { logger } from '@libp2p/logger';

// Local logger
const debugLogger = logger('bootstrap-node');

const DHT_PUT_OPTIONS = { timeout: 60000 };
const KEY_PREFIX = '/redirect-p2p/entry/';
const topic = 'redirects-changes-v4';

let node;
let selectedMultiaddr;
const redirectsCache = new Map();

async function publishNodeAddress() {
  if (!node || node.status !== 'started' || !node.services.dht) {
    debugLogger('WARN: Cannot publish node address: node or DHT not ready');
    return;
  }
  const nodeKey = `/p2p-nodes/${node.peerId.toString()}`;
  const nodeValue = JSON.stringify({
    multiaddrs: node.getMultiaddrs().map(ma => ma.toString()),
    timestamp: Date.now(),
  });
  try {
    await node.services.dht.put(
      uint8ArrayFromString(nodeKey),
      uint8ArrayFromString(nodeValue),
      DHT_PUT_OPTIONS
    );
    debugLogger('INFO: Published node address: %s', nodeKey);
  } catch (err) {
    debugLogger('ERROR: Failed to publish node address: %o', err);
  }
}

async function handlePubsubMessage(evt) {
  if (evt.detail.topic !== topic) return;
  try {
    const message = JSON.parse(uint8ArrayToString(evt.detail.data));
    debugLogger('INFO: PubSub message: %o', message);
    if (!message.action || !message.shortCode) return;

    const { action, shortCode, redirect } = message;
    switch (action) {
      case 'create':
      case 'update':
        if (redirect && redirect.destinationUrl) {
          const current = redirectsCache.get(shortCode) || {};
          redirectsCache.set(shortCode, {
            ...current,
            ...redirect,
            passwordHash: current.passwordHash || redirect.passwordHash,
          });
          debugLogger('INFO: Cached %s: %s', action, shortCode);
        }
        break;
      case 'delete':
        redirectsCache.delete(shortCode);
        debugLogger('INFO: Deleted redirect: %s', shortCode);
        break;
    }
  } catch (err) {
    debugLogger('ERROR: Failed to handle PubSub: %o', err);
  }
}

async function startBootstrapNode() {
  try {
    node = await createLibp2p({
      addresses: {
        listen: ['/ip4/0.0.0.0/tcp/4001', '/ip4/0.0.0.0/tcp/4002/ws'],
      },
      transports: [tcp(), webSockets()],
      connectionEncryption: [noise()],
      streamMuxers: [mplex()],
      services: {
        identify: identify(),
        dht: kadDHT({
          protocol: '/p2p-redirect/kad/1.0.0',
          clientMode: false,
        },
        pubsub: gossipsub({
          allowPublishToZeroPeers: true,
        }),
        circuitRelay: circuitRelayServer(),
        ping: ping(),
      },
    });

    await node.start();
    debugLogger('INFO: Bootstrap node started with ID: %s', node.peerId.toString());

    const multiaddrs = node.getMultiaddrs().map(ma => ma.toString());
    debugLogger('INFO: Listening on: %o', multiaddrs);

    // Hardcode environment logic
    const isProduction = false; // Set to true for Render deployment
    const domain = isProduction ? 'libp2p.onrender.com' : 'localhost';
    const tcpPort = isProduction ? 443 : 4002;
    selectedMultiaddr = `/dns4/${domain}/tcp/${tcpPort}/wss/p2p/${node.peerId.toString()}`;
    debugLogger('INFO: Selected multiaddr: %s', selectedMultiaddr);

    if (node.services.pubsub) {
      node.services.pubsub.subscribe(topic);
      debugLogger('INFO: Subscribed to PubSub topic: %s', topic);
      node.services.pubsub.addEventListener('message', handlePubsubMessage);
    }

    await publishNodeAddress();
    setInterval(publishNodeAddress, 5 * 60 * 1000);

    node.addEventListener('peer:discovery', (evt) => {
      debugLogger('INFO: Discovered peer: %s', evt.detail.id.toString());
    });
    node.addEventListener('peer:connect', (evt) => {
      debugLogger('INFO: Connected to peer: %s', evt.detail.toString());
    });

    return node;
  } catch (err) {
    debugLogger('ERROR: Failed to start bootstrap node: %o', err);
    throw err;
  }
}

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  debugLogger('INFO: WebSocket client connected');
  if (node && node.status === 'started' && selectedMultiaddr) {
    ws.send(JSON.stringify({ status: 'ok', multiaddr: selectedMultiaddr }));
  } else {
    ws.send(JSON.stringify({ status: 'error', message: 'Bootstrap node not ready' }));
  }
  ws.on('message', (message) => {
    debugLogger('INFO: WebSocket message: %s', message.toString());
    if (node && node.status === 'started' && selectedMultiaddr) {
      ws.send(JSON.stringify({ status: 'ok', multiaddr: selectedMultiaddr }));
    }
  });
  ws.on('error', (err) => debugLogger('ERROR: WebSocket error: %o', err));
  ws.on('close', () => debugLogger('INFO: WebSocket client disconnected'));
});

app.use(
  cors({
    origin: ['https://libp2p.onrender.com', 'http://localhost:8080'],
    methods: ['GET', 'OPTIONS'],
    allowedHeaders: ['Content-Type'],
  })
);
app.use(express.json());
app.use(express.static('public'));

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    nodeStarted: !!(node && node.status === 'started'),
    selectedMultiaddr,
  });
});

app.get('/bootstrap-address', (req, res) => {
  if (node && node.status === 'started' && selectedMultiaddr) {
    debugLogger('INFO: Serving bootstrap address: %s', selectedMultiaddr);
    res.json({ multiaddr: selectedMultiaddr });
  } else {
    debugLogger('ERROR: Bootstrap node not started');
    res.status(500).json({ error: 'Bootstrap node not started' });
  }
});

app.get('/redirects', (req, res) => {
  const redirects = Array.from(redirectsCache.entries()).map(([shortCode, redirect]) => ({
    shortCode,
    destinationUrl: redirect.destinationUrl,
    description: redirect.description || '',
    createdAt: redirect.createdAt,
    updatedAt: redirect.updatedAt,
  }));
  debugLogger('INFO: Serving redirects: %o', redirects);
  res.json(redirects);
});

const PORT = 4001;
server.listen(PORT, () => {
  debugLogger('INFO: Server running on port %d', PORT);
  debugLogger('INFO: WebSocket URL: ws://localhost:4001/ws');
});

startBootstrapNode().catch((err) => {
  debugLogger('ERROR: Error starting bootstrap node: %o', err);
  process.exit(1);
});

process.on('SIGTERM', async () => {
  debugLogger('INFO: Received SIGTERM, shutting down...');
  if (node) {
    await node.stop();
    debugLogger('INFO: Libp2p node stopped');
  }
  server.close(() => {
    debugLogger('INFO: HTTP server closed');
    process.exit(0);
  });
});
