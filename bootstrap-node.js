import { createLibp2p } from 'libp2p';
import { webSockets } from '@libp2p/websockets';
import { mplex } from '@libp2p/mplex';
import { noise } from '@chainsafe/libp2p-noise';
import { kadDHT } from '@libp2p/kad-dht';
import { gossipsub } from '@chainsafe/libp2p-gossipsub';
import { identify } from '@libp2p/identify';
import { ping } from '@libp2p/ping';
import { logger } from '@libp2p/logger';
import { createServer } from 'http';

// Увімкнути детальне логування
process.env.LIBP2P_LOGGER = 'debug';

const debugLogger = logger('bootstrap-node');

// Визначення портів
const httpPort = process.env.PORT || 10000; // Порт для HTTP (Render)
const wsPort = 4001; // Порт для WebSocket (libp2p)
const hostname = process.env.HOSTNAME || 'my-p2p-bootstrap.onrender.com';

console.log(`Starting bootstrap node on HTTP port ${httpPort} and WS port ${wsPort}...`);

async function startBootstrapNode() {
  try {
    const node = await createLibp2p({
      addresses: {
        listen: [`/ip4/0.0.0.0/tcp/${wsPort}/ws`], // WebSocket на окремому порті
      },
      transports: [webSockets()],
      streamMuxers: [mplex()],
      connectionEncryption: [noise()],
      services: {
        dht: kadDHT({
          clientMode: false,
          protocol: '/ipfs/kad/1.0.0',
        }),
        pubsub: gossipsub({
          allowPublishToZeroPeers: true,
        }),
        identify: identify(),
        ping: ping(),
      },
      connectionManager: {
        minConnections: 0,
      },
    });

    console.log('Attempting to start node...');
    await node.start();
    console.log('Bootstrap node started with ID:', node.peerId.toString());
    debugLogger('INFO: Bootstrap node started with ID: %s', node.peerId.toString());

    // Формуємо Multiaddr для клієнтів
    const bootstrapAddress = `/dns4/${hostname}/tcp/443/wss/p2p/${node.peerId.toString()}`;
    console.log('Bootstrap address:', bootstrapAddress);
    debugLogger('INFO: Bootstrap address: %s', bootstrapAddress);

    // Виводимо всі Multiaddr
    const multiaddrs = node.getMultiaddrs().map((ma) => ma.toString());
    console.log('Listening on:', multiaddrs);
    debugLogger('INFO: Listening on: %o', multiaddrs);

    node.addEventListener('peer:discovery', (evt) => {
      console.log('Discovered peer:', evt.detail.id.toString());
      debugLogger('INFO: Discovered peer: %s', evt.detail.id.toString());
    });

    node.addEventListener('peer:connect', (evt) => {
      console.log('Connected to peer:', evt.detail.toString());
      debugLogger('INFO: Connected to peer: %s', evt.detail.toString());
    });

    node.addEventListener('peer:disconnect', (evt) => {
      console.log('Disconnected from peer:', evt.detail.toString());
      debugLogger('INFO: Disconnected from peer: %s', evt.detail.toString());
    });

    return { node, bootstrapAddress };
  } catch (err) {
    console.error('Failed to start bootstrap node:', err.stack);
    debugLogger('ERROR: Failed to start bootstrap node: %s', err.stack);
    throw err;
  }
}

// Додаємо HTTP-сервер для health check і ендпоінта bootstrap-address
let bootstrapAddress = '';
const server = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200);
    res.end('OK');
  } else if (req.url === '/bootstrap-address') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ address: bootstrapAddress }));
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

// Запускаємо HTTP-сервер на порті Render
server.listen(httpPort, () => {
  console.log(`HTTP server running on port ${httpPort} for health checks and bootstrap address`);
});

// Запускаємо bootstrap-вузол
startBootstrapNode()
  .then(({ node, bootstrapAddress: addr }) => {
    bootstrapAddress = addr; // Зберігаємо адресу для ендпоінта
  })
  .catch((err) => {
    console.error('Bootstrap node crashed:', err.stack);
    process.exit(1);
  });
