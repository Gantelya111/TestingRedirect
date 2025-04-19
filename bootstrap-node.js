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

// Резервна адреса bootstrap-вузла
const BOOTSTRAP_MULTIADDR = '/dns4/libp2p.onrender.com/tcp/443/wss/p2p/12D3KooWQ3e6x9p3R9oCt3oU2KMoS9jWq6y4nFL2qUuhj8q3k3gS';
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
  node = await createLibp2p({
    addresses: {
      listen: ['/ip4/0.0.0.0/tcp/0', '/ip4/0.0.0.0/tcp/0/ws']
    },
    transports: [tcp(), webSockets()],
    connectionEncryption: [noise()],
    streamMuxers: [mplex()],
    peerDiscovery: [
      bootstrap({
        list: [BOOTSTRAP_MULTIADDR],
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
    console.warn('No WebSocket address found, using default:', BOOTSTRAP_MULTIADDR);
    selectedMultiaddr = BOOTSTRAP_MULTIADDR;
  } else if (!selectedMultiaddr.includes('/p2p/')) {
    selectedMultiaddr = `${selectedMultiaddr}/p2p/${node.peerId.toString()}`;
  }

  // Періодична публікація адреси вузла в DHT
  await publishNodeAddress();
  setInterval(publishNodeAddress, 5 * 60 * 1000); // Кожні 5 хвилин

  return node;
}

// Запускаємо bootstrap-вузол
startBootstrapNode().catch(err => {
  console.error('Error starting bootstrap node:', err);
});

// Створюємо Express-додаток
const app = express();

// Вмикаємо CORS
app.use(cors());

// Подаємо статичні файли з папки 'public'
app.use(express.static('public'));

// Ендпоінт для отримання bootstrap-адреси
app.get('/bootstrap-address', (req, res) => {
  if (selectedMultiaddr) {
    res.json({ multiaddr: selectedMultiaddr });
  } else {
    res.status(500).json({ error: 'Bootstrap node not started' });
  }
});

// Запускаємо сервер
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
