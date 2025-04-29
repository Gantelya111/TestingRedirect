import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { PeerServer } from 'peer';
import { logger } from '@libp2p/logger';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const debugLogger = logger('bootstrap-node');

const isProduction = process.env.NODE_ENV === 'production';
const HOST = '0.0.0.0';
const HTTP_PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8080;

const MAX_CACHE_SIZE = 500; // Зменшено для Render
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

// Виправлення MaxListenersExceededWarning
server.setMaxListeners(20);

// Дебаг запитів
app.use((req, res, next) => {
    debugLogger('INFO: Incoming request: %s %s', req.method, req.url);
    next();
});

app.use(cors({
    origin: ['https://libp2p.onrender.com', 'http://localhost:8080', 'http://localhost:3000'],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type']
}));
app.use(express.json());

// Кореневий маршрут
app.get('/', (req, res) => {
    debugLogger('INFO: Serving index.html for /');
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Інші маршрути
app.get('/health', (req, res) => {
    debugLogger('INFO: Health check requested');
    res.json({ status: 'ok', peerServerRunning: true });
});

app.get('/port', (req, res) => {
    const port = server.address()?.port || HTTP_PORT;
    debugLogger('INFO: Returning active port: %d', port);
    res.json({ port });
});

app.get('/peers', (req, res) => {
    try {
        const clients = peerServer.getClients ? peerServer.getClients() : new Map();
        const peers = Array.from(clients.keys());
        debugLogger('INFO: Returning peers: %o', peers);
        res.json(peers);
    } catch (err) {
        debugLogger('ERROR: Failed to get peers: %o', err);
        res.status(500).json({ error: 'Failed to get peers' });
    }
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

app.post('/redirects', (req, res) => {
    const { shortCode, destinationUrl, description, passwordHash } = req.body;
    if (!shortCode || !destinationUrl) {
        debugLogger('ERROR: Missing shortCode or destinationUrl: %o', req.body);
        return res.status(400).json({ error: 'Missing shortCode or destinationUrl' });
    }
    const redirect = {
        shortCode,
        destinationUrl,
        description: description || '',
        passwordHash: passwordHash || '',
        createdAt: Date.now(),
        updatedAt: Date.now()
    };
    redirectsCache.set(shortCode, redirect);
    pruneCacheIfNeeded();
    debugLogger('INFO: Created redirect: %s', shortCode);
    res.json({ shortCode });
});

app.put('/redirects/:shortCode', (req, res) => {
    const { shortCode } = req.params;
    const { destinationUrl, description } = req.body;
    if (!redirectsCache.has(shortCode)) {
        debugLogger('ERROR: Redirect not found: %s', shortCode);
        return res.status(404).json({ error: 'Redirect not found' });
    }
    const redirect = redirectsCache.get(shortCode);
    redirect.destinationUrl = destinationUrl || redirect.destinationUrl;
    redirect.description = description !== undefined ? description : redirect.description;
    redirect.updatedAt = Date.now();
    redirectsCache.set(shortCode, redirect);
    debugLogger('INFO: Updated redirect: %s', shortCode);
    res.json({ success: true });
});

app.delete('/redirects/:shortCode', (req, res) => {
    const { shortCode } = req.params;
    if (!redirectsCache.has(shortCode)) {
        debugLogger('INFO: Redirect not found, skipping: %s', shortCode);
        return res.json({ success: true, message: 'Redirect not found' });
    }
    redirectsCache.delete(shortCode);
    debugLogger('INFO: Deleted redirect: %s', shortCode);
    res.json({ success: true });
});

app.get('/r/:shortCode', (req, res) => {
    const { shortCode } = req.params;
    const redirect = redirectsCache.get(shortCode);
    if (redirect) {
        debugLogger('INFO: Redirecting %s to %s', shortCode, redirect.destinationUrl);
        res.redirect(redirect.destinationUrl);
    } else {
        debugLogger('ERROR: Redirect not found: %s', shortCode);
        res.status(404).send('Redirect not found');
    }
});

// Статичні файли після маршрутів
app.use(express.static(path.join(__dirname, 'public')));

// Налаштування PeerServer (з документації)
const peerServer = PeerServer({
    port: HTTP_PORT,
    path: '/peerjs-server',
    proxied: isProduction,
    server,
    debug: true,
    generateClientId: () => `peer-${Math.random().toString(36).slice(2)}`
});

peerServer.on('connection', (client) => {
    debugLogger('INFO: Peer connected: %s', client.getId());
});

peerServer.on('disconnect', (client) => {
    debugLogger('INFO: Peer disconnected: %s', client.getId());
});

peerServer.on('error', (err) => {
    debugLogger('ERROR: PeerServer error: %o', err);
});

peerServer.on('message', (client, message) => {
    debugLogger('INFO: WebSocket message from %s: %o', client.getId(), message);
});

function startServer(port, host) {
    server.removeAllListeners('listening');
    server.removeAllListeners('error');

    server.listen(port, host, () => {
        const actualPort = server.address()?.port || port;
        debugLogger('INFO: Server started on %s:%d', host, actualPort);
        debugLogger('INFO: PeerJS Server running at %s:%s/peerjs-server', isProduction ? 'libp2p.onrender.com' : 'localhost', isProduction ? '' : `${actualPort}`);
    });

    server.on('error', (err) => {
        debugLogger('ERROR: Server failed to start: %o', err);
        if (err.code === 'EADDRINUSE') {
            debugLogger('ERROR: Port %d is in use, retrying in 5 seconds...', port);
            setTimeout(() => {
                server.close();
                startServer(port, host);
            }, 5000);
        } else {
            throw err;
        }
    });
}

try {
    debugLogger('INFO: Starting server on port %d', HTTP_PORT);
    startServer(HTTP_PORT, HOST);
} catch (err) {
    debugLogger('ERROR: Failed to start server: %o', err);
    process.exit(1);
}

process.on('SIGTERM', () => {
    debugLogger('INFO: Received SIGTERM, shutting down...');
    peerServer.close();
    server.close(() => {
        debugLogger('INFO: Server stopped');
        process.exit(0);
    });
});
