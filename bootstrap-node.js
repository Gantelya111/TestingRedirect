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

// Налаштування PeerServer
const peerServer = PeerServer({
    path: '/peerjs-server',
    proxied: isProduction,
    ssl: isProduction ? {} : undefined,
    server,
    debug: true // Включаємо дебаг PeerServer
});

app.use(cors({
    origin: ['https://libp2p.onrender.com', 'http://localhost:8080'],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
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
        res.status(404).send('Redirect not found');
    }
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

function startServer(port, host) {
    server.removeAllListeners('listening');
    server.removeAllListeners('error');

    server.listen(port, host, () => {
        const actualPort = server.address()?.port || port;
        debugLogger('INFO: Server started on %s:%d', host, actualPort);
        debugLogger('INFO: PeerJS Server running at %s:%s/peerjs-server', isProduction ? 'libp2p.onrender.com' : 'localhost', isProduction ? '' : `${actualPort}`);
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
            throw err;
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
