import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { PeerServer } from 'peerjs-server';
import { logger } from '@libp2p/logger';

const debugLogger = logger('bootstrap-node');

const isProduction = process.env.NODE_ENV === 'production';
// Порт із змінної середовища або автоматичний вибір
const HTTP_PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 0;

const redirectsCache = new Map(); // Локальний кеш редіректів

const app = express();
const server = createServer(app);

// Налаштування PeerServer на тому ж порті
const peerServer = PeerServer({
    port: HTTP_PORT, // Використовуємо той же порт, що й HTTP-сервер
    path: '/peerjs-server', // Унікальний шлях
    ssl: isProduction ? {} : undefined, // SSL у продакшені
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

// Ендпоінт для повернення активного порту
app.get('/port', (req, res) => {
    const port = server.address()?.port || HTTP_PORT;
    debugLogger('INFO: Returning active port: %d', port);
    res.json({ port });
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

// Маршрутизація для /r/<shortCode>
app.get('/r/:shortCode', async (req, res) => {
    const shortCode = req.params.shortCode;
    const redirect = redirectsCache.get(shortCode);
    if (redirect) {
        res.redirect(redirect.destinationUrl);
    } else {
        res.status(404).send('Redirect not found');
    }
});

// Обробка повідомлень від пірів
peerServer.on('connection', (client) => {
    debugLogger('INFO: Peer connected: %s', client.getId());
});

peerServer.on('disconnect', (client) => {
    debugLogger('INFO: Peer disconnected: %s', client.getId());
});

// Запуск сервера з обробкою EADDRINUSE
function startServer(port) {
    server.listen(port, () => {
        const actualPort = server.address()?.port || port;
        debugLogger('INFO: Server started on port %d', actualPort);
        debugLogger('INFO: PeerJS Server running at %s:%d/peerjs-server', isProduction ? 'libp2p.onrender.com' : 'localhost', actualPort);
    });

    server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            debugLogger('ERROR: Port %d is in use, retrying in 5 seconds...', port);
            setTimeout(() => {
                server.close();
                startServer(port || 0); // Спробувати інший порт, якщо не задано
            }, 5000);
        } else {
            debugLogger('ERROR: Server error: %o', err);
        }
    });
}

startServer(HTTP_PORT);

process.on('SIGTERM', () => {
    debugLogger('INFO: Received SIGTERM, shutting down...');
    peerServer.close();
    server.close(() => {
        debugLogger('INFO: Server stopped');
        process.exit(0);
    });
});
