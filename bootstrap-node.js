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

// Локальний логер
const debugLogger = logger('bootstrap-node');

const DHT_PUT_OPTIONS = { timeout: 60000 };
const KEY_PREFIX = '/redirect-p2p/entry/';
const topic = 'redirects-changes-v3'; // Синхронізовано з p2p.js

let node;
let selectedMultiaddr;
const redirectsCache = new Map();

async function publishNodeAddress() {
  if (!node || node.status !== 'started' || !node.services.dht) {
    debugLogger('WARN: Не можу опублікувати адресу вузла: вузол або DHT не готові');
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
    debugLogger('INFO: Опубліковано адресу вузла: %s', nodeKey);
  } catch (err) {
    debugLogger('ERROR: Не вдалося опублікувати адресу вузла: %o', err);
  }
}

async function handlePubsubMessage(evt) {
  if (evt.detail.topic !== topic) return;
  try {
    const message = JSON.parse(uint8ArrayToString(evt.detail.data));
    debugLogger('INFO: Повідомлення PubSub: %o', message);
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
          debugLogger('INFO: Закешовано %s: %s', action, shortCode);
        }
        break;
      case 'delete':
        redirectsCache.delete(shortCode);
        debugLogger('INFO: Видалено редирект: %s', shortCode);
        break;
    }
  } catch (err) {
    debugLogger('ERROR: Не вдалося обробити PubSub: %o', err);
  }
}

async function startBootstrapNode() {
  debugLogger('INFO: Починаю запуск бутстрап-вузла');
  try {
    debugLogger('INFO: Налаштування Libp2p...');
    node = await createLibp2p({
      addresses: {
        listen: ['/ip4/0.0.0.0/tcp/4002', '/ip4/0.0.0.0/tcp/4003/ws'],
      },
      transports: [tcp(), webSockets()],
      connectionEncryption: [noise()],
      streamMuxers: [mplex()],
      transportManager: {
        faultTolerance: 'NO_FATAL' // Ігнорувати помилки прив’язки до портів
      },
      services: {
        identify: identify(),
        dht: kadDHT({
          protocol: '/p2p-redirect/kad/1.0.0',
          clientMode: false
        }),
        pubsub: gossipsub({ allowPublishToZeroPeers: true }),
        circuitRelay: circuitRelayServer(),
        ping: ping()
      }
    });

    debugLogger('INFO: Запускаю вузол...');
    await node.start();
    debugLogger('INFO: Бутстрап-вузол запущено з ID: %s', node.peerId.toString());

    const multiaddrs = node.getMultiaddrs().map(ma => ma.toString());
    debugLogger('INFO: Слухаю на адресах: %o', multiaddrs);

    // Логіка оточення
    const isProduction = true; // Для деплою на Render
    const domain = isProduction ? 'libp2p.onrender.com' : 'localhost';
    const tcpPort = isProduction ? 443 : 4003; // 443 для wss на Render
    selectedMultiaddr = `/dns4/${domain}/tcp/${tcpPort}/wss/p2p/${node.peerId.toString()}`;
    debugLogger('INFO: Вибрана адреса: %s', selectedMultiaddr);

    if (node.services.pubsub) {
      node.services.pubsub.subscribe(topic);
      debugLogger('INFO: Підписано на PubSub тему: %s', topic);
      node.services.pubsub.addEventListener('message', handlePubsubMessage);
    }

    await publishNodeAddress();
    setInterval(publishNodeAddress, 5 * 60 * 1000);

    node.addEventListener('peer:discovery', (evt) => {
      debugLogger('INFO: Виявлено піра: %s', evt.detail.id.toString());
    });
    node.addEventListener('peer:connect', (evt) => {
      debugLogger('INFO: Підключено до піра: %s', evt.detail.toString());
    });

    debugLogger('INFO: Бутстрап-вузол успішно запущено');
    return node;
  } catch (err) {
    debugLogger('ERROR: Помилка запуску бутстрап-вузла: %o', err);
    console.error('Помилка запуску бутстрап-вузла:', err.stack);
    throw err;
  }
}

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  debugLogger('INFO: Підключено WebSocket клієнта');
  if (node && node.status === 'started' && selectedMultiaddr) {
    ws.send(JSON.stringify({ status: 'ok', multiaddr: selectedMultiaddr }));
  } else {
    ws.send(JSON.stringify({ status: 'error', message: 'Бутстрап-вузол не готовий' }));
  }
  ws.on('message', (message) => {
    debugLogger('INFO: Повідомлення WebSocket: %s', message.toString());
    if (node && node.status === 'started' && selectedMultiaddr) {
      ws.send(JSON.stringify({ status: 'ok', multiaddr: selectedMultiaddr }));
    }
  });
  ws.on('error', (err) => debugLogger('ERROR: Помилка WebSocket: %o', err));
  ws.on('close', () => debugLogger('INFO: WebSocket клієнт відключений'));
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
    debugLogger('INFO: Повертаю адресу бутстрапа: %s', selectedMultiaddr);
    res.json({ multiaddr: selectedMultiaddr });
  } else {
    debugLogger('ERROR: Бутстрап-вузол не запущено');
    res.status(500).json({ error: 'Бутстрап-вузол не запущено' });
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
  debugLogger('INFO: Повертаю редиректи: %o', redirects);
  res.json(redirects);
});

// Використовуємо PORT із змінної оточення або 8080
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  debugLogger('INFO: Сервер запущено на порту %d', PORT);
  debugLogger('INFO: WebSocket URL: ws://localhost:%d/ws', PORT);
});

startBootstrapNode().catch((err) => {
  debugLogger('ERROR: Критична помилка запуску бутстрап-вузла: %o', err);
  console.error('Критична помилка:', err.stack);
  process.exit(1);
});

process.on('SIGTERM', async () => {
  debugLogger('INFO: Отримано SIGTERM, завершую роботу...');
  if (node) {
    await node.stop();
    debugLogger('INFO: Вузол Libp2p зупинено');
  }
  server.close(() => {
    debugLogger('INFO: HTTP сервер зупинено');
    process.exit(0);
  });
});
