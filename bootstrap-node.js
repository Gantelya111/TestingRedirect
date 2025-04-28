import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { PeerServer } from 'peerjs-server';
import { logger } from '@libp2p/logger';

const debugLogger = logger('bootstrap-node');

const isProduction = process.env.NODE_ENV === 'production';
const HOST = '0.0.0.0';
const HTTP_PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8080;

const MAX_CACHE_SIZE = 1000;
const redirectsCache = new Map();

function pruneCacheIfNeeded() {
    if (redirectsCache.size > MAX_CACHE_SIZE) {
        const keys = Array.from(redirectsCache.keys()).slice(0, redirectsCache.size - MAX_CACHE_SIZE);
        for (const key of keys) {
            redirectsCache.delete(key);
        }
        debugLogger('INFO: Pruned redirectsCache to %d entries', redirectsCache.size);
    }
}

const app = express();
const server = createServer(app);
server.setMaxListeners(15);

const peerServer = PeerServer({
    port: isProduction ? 0 : HTTP_PORT, // У продакшені порт для PeerServer не потрібен, бо він використовує той самий server
    host: HOST,
    path: '/peerjs-server',
    ssl: isProduction ? {} : undefined,
    proxied: isProduction
});

// Прив’язуємо PeerServer до того ж HTTP-сервера
peerServer.listen(server);

app.use(cors({
    origin: ['https://libp2p.onrender.com', 'http://localhost:8080'],
    methods: ['GET', 'OPTIONS'],
    allowedHeaders: ['Content-Type']
}));
app.use(express.json());
app.use(express.static('public'));

app.get('/health', (req, res) => {
    res.json({ status: 'ok', peerServerRunning: true });
});

app.get('/port', (req, res) => {
    const port = server.address()?.port || HTTP_PORT;
    debugLogger('INFO: Returning active port: %d', port);
    res.json({ port });
});

app.get('/peers', (req, res) => {
    const peers = Array.from(peerServer.getClients().keys());
    debugLogger('INFO: Returning peers: %o', peers);
    res.json(peers);
});

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

app.get('/r/:shortCode', async (req, res) => {
    const shortCode = req.params.shortCode;
    const redirect = redirectsCache.get(shortCode);
    if (redirect) {
        res.redirect(redirect.destinationUrl);
    } else {
        res.status(404).send('Redirect not found');
    }
});

peerServer.on('connection', (client) => {
    debugLogger('INFO: Peer connected: %s', client.getId());
});

peerServer.on('disconnect', (client) => {
    debugLogger('INFO: Peer disconnected: %s', client.getId());
});

function startServer(port, host) {
    server.removeAllListeners('listening');
    server.removeAllListeners('error');

    server.listen(port, host, () => {
        const actualPort = server.address()?.port || port;
        debugLogger('INFO: Server started on %s:%d', host, actualPort);
        debugLogger('INFO: PeerJS Server running at %s:%d/peerjs-server', isProduction ? 'libp2p.onrender.com' : 'localhost', actualPort);
    });

    server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            debugLogger('ERROR: Port %d is in use, retrying in 5 seconds...', port);
            setTimeout(() => {
                server.close();
                startServer(port, host);
            }, 5000);
        } else {
            debugLogger('ERROR: Server error: %o', err);
            throw err; // Для дебагу на Render
        }
    });

    server.on('listening', () => {
        const addr = server.address();
        debugLogger('INFO: Server listening on %s:%d', addr.address, addr.port);
    });
}

startServer(HTTP_PORT, HOST);

process.on('SIGTERM', () => {
    debugLogger('INFO: Received SIGTERM, shutting down...');
    peerServer.close();
    server.close(() => {
        debugLogger('INFO: Server stopped');
        process.exit(0);
    });
});
