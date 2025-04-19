import { createLibp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { webSockets } from '@libp2p/websockets';
import { noise } from '@chainsafe/libp2p-noise';
import { mplex } from '@libp2p/mplex';
import { kadDHT } from '@libp2p/kad-dht';
import { gossipsub } from '@chainsafe/libp2p-gossipsub';
import { bootstrap } from '@libp2p/bootstrap';
import { circuitRelayServer } from '@libp2p/circuit-relay-v2';
import { identify } from '@libp2p/identify';
import { ping } from '@libp2p/ping';
import express from 'express';
import cors from 'cors';
import { multiaddr } from '@multiformats/multiaddr';
import { fromString as uint8ArrayFromString } from 'uint8arrays';
import { WebSocketServer } from 'ws';
import http from 'http';

// Резервні адреси bootstrap-вузлів
const BOOTSTRAP_MULTIADDRS = [
  '/dns4/libp2p.onrender.com/tcp/443/wss/p2p/12D3KooWQ3e6x9p3R9oCt3oU2KMoS9jWq6y4nFL2qUuhj8q3k3gS',
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN',
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmbLHAnMoJPWSCR5i1FxheG2QeQcg3EsxS7bL63wQXoJYH'
];
const DHT_PUT_OPTIONS = { timeout: 60000 };

let node;
let selectedMultiaddr;

async function publishNodeAddress() {
  if (!node || node.status !== 'started' || !node.services.dht) {
    console.warn('Cannot publish node address: node or DHT not ready');
    return;
  }

  const nodeKey = `/p2p-nodes/${node.peerId.toString()}`;
  const nodeValue = JSON.stringify({
    multiaddrs: node.getMultiaddrs().map(ma => ma.toString()),
    timestamp: Date.now()
  });

  try {
    await node.services.dht.put(
      uint8ArrayFromString(nodeKey),
      uint8ArrayFromString(nodeValue),
      DHT_PUT_OPTIONS
    );
    console.log('Published node address to DHT:', nodeKey);
  } catch (err) {
    console.error('Failed to publish node address:', err);
  }
}

async function startBootstrapNode() {
  try {
    node = await createLibp2p({
      addresses: {
        listen: ['/ip4/0.0.0.0/tcp/0', '/ip4/0.0.0.0/tcp/0/ws']
      },
      transports: [
        tcp(),
        webSockets({
          filter: (addr) => addr.includes('/ws')
        })
      ],
      connectionEncryption: [noise()],
      streamMuxers: [mplex()],
      peerDiscovery: [
        bootstrap({
          list: BOOTSTRAP_MULTIADDRS,
          timeout: 1000,
          tagName: 'bootstrap',
          tagValue: 50,
          tagTTL: 120000
        })
      ],
      services: {
        identify: identify(),
        dht: kadDHT({
          protocolPrefix: '/p2p-redirect',
          maxInboundStreams: 1000,
          maxOutboundStreams: 1000,
          clientMode: false
        }),
        pubsub: gossipsub({
          allowPublishToZeroTopicPeers: true,
          globalSignaturePolicy: 'StrictSign'
        }),
        circuitRelay: circuitRelayServer(),
        ping: ping()
      }
    });

    await node.start();
    console.log('Bootstrap node started with ID:', node.peerId.toString());

    const multiaddrs = node.getMultiaddrs().map(ma => ma.toString());
    console.log('Listening on:', multiaddrs);

    selectedMultiaddr = multiaddrs.find(addr => addr.includes('/ws')) || multiaddrs[0];
    if (!selectedMultiaddr) {
      console.warn('No valid multiaddr found, falling back to default');
      selectedMultiaddr = BOOTSTRAP_MULTIADDRS[0];
    } else if (!selectedMultiaddr.includes('/p2p/')) {
      selectedMultiaddr = `${selectedMultiaddr}/p2p/${node.peerId.toString()}`;
    }
    console.log('Selected multiaddr:', selectedMultiaddr);

    await publishNodeAddress();
    setInterval(publishNodeAddress, 5 * 60 * 1000);

    node.addEventListener('peer:discovery', (evt) => {
      console.log('Discovered peer:', evt.detail.id.toString());
    });
    node.addEventListener('peer:connect', (evt) => {
      console.log('Connected to peer:', evt.detail.toString());
    });

    return node;
  } catch (err) {
    console.error('Failed to start bootstrap node:', err);
    throw err;
  }
}

// Створюємо Express-додаток
const app = express();
const server = http.createServer(app);

// Налаштування WebSocket
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  console.log('DEBUG: WebSocket client connected');
  ws.on('message', (message) => {
    console.log('DEBUG: WebSocket message received:', message.toString());
    ws.send(JSON.stringify({ status: 'ok', multiaddr: selectedMultiaddr }));
  });
  ws.on('error', (err) => {
    console.error('DEBUG: WebSocket error:', err);
  });
  ws.on('close', () => {
    console.log('DEBUG: WebSocket client disconnected');
  });
});

// Налаштування CORS
app.use(cors({
  origin: ['https://your-client-domain.com', 'http://localhost:3000'], // Замініть на ваш клієнтський домен
  methods: ['GET', 'OPTIONS'],
  allowedHeaders: ['Content-Type']
}));

// Парсинг JSON
app.use(express.json());

// Подаємо статичні файли
app.use(express.static('public'));

// Ендпоінт для перевірки стану
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    nodeStarted: !!(node && node.status === 'started'),
    selectedMultiaddr
  });
});

// Ендпоінт для bootstrap-адреси
app.get('/bootstrap-address', (req, res) => {
  if (node && node.status === 'started' && selectedMultiaddr) {
    console.log('Serving bootstrap address:', selectedMultiaddr);
    res.json({ multiaddr: selectedMultiaddr });
  } else {
    console.error('Bootstrap node not started or multiaddr not set');
    res.status(500).json({ error: 'Bootstrap node not started' });
  }
});

// Запускаємо сервер
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// Запускаємо bootstrap-вузол
startBootstrapNode().catch(err => {
  console.error('Error starting bootstrap node:', err);
  process.exit(1);
});
