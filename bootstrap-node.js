import { createLibp2p } from 'libp2p';
import { webSockets } from '@libp2p/websockets';
import { mplex } from '@libp2p/mplex';
import { noise } from '@chainsafe/libp2p-noise';
import { kadDHT } from '@libp2p/kad-dht';
import { gossipsub } from '@chainsafe/libp2p-gossipsub';
import { identify } from '@libp2p/identify';
import { ping } from '@libp2p/ping';
import { logger } from '@libp2p/logger';

// Увімкнути детальне логування
process.env.LIBP2P_LOGGER = 'debug';

const debugLogger = logger('bootstrap-node');

console.log('Starting bootstrap node...');

async function startBootstrapNode() {
  try {
    const node = await createLibp2p({
      addresses: {
        listen: ['/ip4/0.0.0.0/tcp/4001/wss'],
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

    return node;
  } catch (err) {
    console.error('Failed to start bootstrap node:', err.stack);
    debugLogger('ERROR: Failed to start bootstrap node: %s', err.stack);
    throw err;
  }
}

startBootstrapNode().catch((err) => {
  console.error('Bootstrap node crashed:', err.stack);
  process.exit(1);
});