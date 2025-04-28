import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { PeerServer } from 'peerjs-server';
import { logger } from '@libp2p/logger';

const debugLogger = logger('bootstrap-node');

const isProduction = process.env.NODE_ENV === 'production';
const HTTP_PORT = process.env.PORT || 8080;

const redirectsCache = new Map(); // Локальний кеш редіректів

const app = express();
const server = createServer(app);
const peerServer = PeerServer({
    port: HTTP_PORT,
    path: '/peerjs',
    ssl: isProduction ? {} : undefined, // У продакшені потрібен SSL
    proxied: isProduction
});

app.use(cors({
    origin: ['https://libp2p.onrender.com', 'http://localhost:8080'],
    methods: ['GET', 'OPTIONS'],
    allowedHeaders: ['Content-Type']
}));
app.use(express.json());
app.use(express.static('public'));

// Ендпоінт для перевірки стану
app.get('/health', (req, res) => {
    res.json({ status: 'ok', peerServerRunning: true });
});

// Ендпоінт для отримання списку пірів
app.get('/peers', (req, res) => {
    const peers = Array.from(peerServer.getClients().keys());
    debugLogger('INFO: Returning peers: %o', peers);
    res.json(peers);
});

// Ендпоінт для редіректів (HTTP polling)
app.get('/redirects', (req, res) => {
    const redirects = Array.from(redirectsCache.entries()).map(([shortCode, redirect]) => ({
        shortCode,
        destinationUrl: redirect.destinationUrl,
        description: redirect.description || '',
        createdAt: redirect.createdAt,
        updatedAt: redirect.updatedAt
    }));
    debugLogger('INFO: Returning redirects: %o', redirects);
    res.json(redirects);
});

// Обробка повідомлень від пірів (для оновлення кешу)
peerServer.on('connection', (client) => {
    debugLogger('INFO: Peer connected: %s', client.getId());
});

peerServer.on('disconnect', (client) => {
    debugLogger('INFO: Peer disconnected: %s', client.getId());
});

server.listen(HTTP_PORT, () => {
    debugLogger('INFO: Server started on port %d', HTTP_PORT);
    debugLogger('INFO: PeerJS Server running at %s:%d/peerjs', isProduction ? 'libp2p.onrender.com' : 'localhost', HTTP_PORT);
});

process.on('SIGTERM', () => {
    debugLogger('INFO: Received SIGTERM, shutting down...');
    peerServer.close();
    server.close(() => {
        debugLogger('INFO: Server stopped');
        process.exit(0);
    });
});