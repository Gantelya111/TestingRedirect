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
import http from 'http';
import cors from 'cors';
import { multiaddr } from '@multiformats/multiaddr';

// Резервна адреса bootstrap-вузла
const BOOTSTRAP_MULTIADDR = '/dns4/libp2p.onrender.com/tcp/443/wss/p2p/12D3KooWQ3e6x9p3R9oCt3oU2KMoS9jWq6y4nFL2qUuhj8q3k3gS';

async function startBootstrapNode() {
  const node = await createLibp2p({
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
      ping: ping() // Додано сервіс ping
    }
  });

  await node.start();
  console.log('Bootstrap node started with ID:', node.peerId.toString());

  // Отримуємо динамічну адресу вузла
  const multiaddrs = node.getMultiaddrs().map(ma => ma.toString());
  console.log('Listening on:', multiaddrs);

  // Вибираємо WebSocket-адресу для клієнтів
  let selectedMultiaddr = multiaddrs.find(addr => addr.includes('/ws')) || multiaddrs[0];
  if (!selectedMultiaddr) {
    console.warn('No WebSocket address found, using default:', BOOTSTRAP_MULTIADDR);
    selectedMultiaddr = BOOTSTRAP_MULTIADDR;
  } else {
    // Додаємо peerId до адреси, якщо його немає
    if (!selectedMultiaddr.includes('/p2p/')) {
      selectedMultiaddr = `${selectedMultiaddr}/p2p/${node.peerId.toString()}`;
    }
  }

  return { node, selectedMultiaddr };
}

// Створюємо HTTP-сервер з оновленим CORS
const server = http.createServer((req, res) => {
  // Налаштування CORS для всіх джерел
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.url === '/bootstrap-address') {
    startBootstrapNode().then(({ selectedMultiaddr }) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ multiaddr: selectedMultiaddr }));
    }).catch(err => {
      console.error('Error starting node for /bootstrap-address:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to start node' }));
    });
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

// Запускаємо сервер
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`HTTP server running on port ${PORT}`);
});

// Запускаємо bootstrap-вузол і зберігаємо його адресу
startBootstrapNode().catch(err => {
  console.error('Error starting bootstrap node:', err);
});
