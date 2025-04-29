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

const MAX_CACHE_SIZE = 200;
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
server.setMaxListeners(15); // Можна залишити або повернути до 10 (default)

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

app.get('/', (req, res) => {
    debugLogger('INFO: Serving index.html');
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use(express.static(path.join(__dirname, 'public')));

// --- Покращене логування PeerServer ---
debugLogger('INFO: Attempting to initialize PeerServer...');
let peerServerInstance = null;
try {
    peerServerInstance = PeerServer({
        path: '/peerjs-server',
        proxied: isProduction,
        // Не вказуємо port, коли передаємо server
        server,
        debug: 3, // Високий рівень дебагу для сервера
        allow_discovery: true // Дозволимо пошук пірів через сервер (може бути корисно)
    });
    debugLogger('INFO: PeerServer instance created.');

    if (peerServerInstance) {
        debugLogger('INFO: PeerServer instance seems valid. Attaching listeners...');
        peerServerInstance.on('connection', (client) => {
            debugLogger('SERVER LOG: Peer connected: ID=%s', client.getId());
            // Можна додати більше деталей про клієнта, якщо потрібно
            // debugLogger('SERVER LOG: Peer connected details: %o', client);
        });
        peerServerInstance.on('disconnect', (client) => {
            // Перевіряємо, чи client існує і має метод getId
            const clientId = client && typeof client.getId === 'function' ? client.getId() : 'unknown';
            debugLogger('SERVER LOG: Peer disconnected: ID=%s', clientId);
        });
        peerServerInstance.on('message', (client, message) => {
             const clientId = client && typeof client.getId === 'function' ? client.getId() : 'unknown';
             // Логуємо тип повідомлення, щоб бачити активність
             debugLogger('SERVER LOG: Message received from ID=%s, type=%s', clientId, message?.type || 'unknown');
        });
        peerServerInstance.on('error', (err) => {
            // Дуже важливо логувати помилки самого PeerServer
            debugLogger('SERVER LOG: PeerServer ERROR: %o', err);
        });
        debugLogger('INFO: PeerServer listeners attached.');
    } else {
        // Це не повинно статися, але перевіримо
        debugLogger('ERROR: PeerServer initialization returned undefined/null!');
    }
} catch (error) {
    // Ловимо можливі помилки під час самого виклику PeerServer()
    debugLogger('FATAL ERROR: Exception during PeerServer initialization: %o', error);
    // Якщо тут помилка, сервер, ймовірно, не запрацює
}
// ---------------------------------------

app.get('/health', (req, res) => {
    debugLogger('INFO: Health check');
    // Додамо перевірку, чи існує інстанс PeerServer
    const isPeerServerRunning = !!peerServerInstance;
    res.json({ status: 'ok', peerServerRunning: isPeerServerRunning });
});

app.get('/port', (req, res) => {
    const port = server.address()?.port || HTTP_PORT;
    debugLogger('INFO: Returning active port: %d', port);
    res.json({ port });
});

app.get('/peers', (req, res) => {
    // Перевіряємо, чи peerServerInstance ініціалізовано і має метод getClients
    if (peerServerInstance && typeof peerServerInstance.getClients === 'function') {
        try {
            // PeerServer з бібліотеки 'peer' може повертати Map або об'єкт
            const clients = peerServerInstance.getClients();
            let peers = [];
            if (clients instanceof Map) {
                peers = Array.from(clients.keys());
            } else if (typeof clients === 'object' && clients !== null) {
                // Якщо це об'єкт { id1: client1, id2: client2 }
                peers = Object.keys(clients);
            } else {
                 debugLogger('WARN: Unexpected format returned by getClients: %o', clients);
            }
            debugLogger('INFO: Returning peers: %o', peers);
            res.json(peers);
        } catch (err) {
            debugLogger('ERROR: Failed to get peers: %o', err);
            res.status(500).json({ error: 'Failed to get peers' });
        }
    } else {
        debugLogger('ERROR: Cannot get peers, PeerServer instance is not valid or lacks getClients method.');
        res.status(500).json({ error: 'PeerServer not ready' });
    }
});


// --- Решта маршрутів (redirects) залишаються без змін ---
app.get('/redirects', (req, res) => {
    const redirects = Array.from(redirectsCache.entries()).map(([shortCode, redirect]) => ({
        shortCode,
        destinationUrl: redirect.destinationUrl,
        description: redirect.description || '',
        createdAt: redirect.createdAt,
        updatedAt: redirect.updatedAt
    }));
    // debugLogger('INFO: Returning redirects: %o', redirects); // Можна закоментувати, щоб не спамити логи
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
        passwordHash: passwordHash || '', // Зберігаємо хеш
        createdAt: Date.now(),
        updatedAt: Date.now()
    };
    redirectsCache.set(shortCode, redirect);
    pruneCacheIfNeeded();
    debugLogger('INFO: Created redirect: %s', shortCode);
    res.json({ shortCode }); // Повертаємо тільки shortCode
});

app.put('/redirects/:shortCode', (req, res) => {
    const { shortCode } = req.params;
    // Оновлюємо тільки destinationUrl та description, не чіпаємо хеш тут
    const { destinationUrl, description } = req.body;
    if (!redirectsCache.has(shortCode)) {
        debugLogger('ERROR: Redirect not found for update: %s', shortCode);
        return res.status(404).json({ error: 'Redirect not found' });
    }
    const redirect = redirectsCache.get(shortCode);
    redirect.destinationUrl = destinationUrl || redirect.destinationUrl;
    redirect.description = description !== undefined ? description : redirect.description;
    redirect.updatedAt = Date.now();
    redirectsCache.set(shortCode, redirect); // Зберігаємо оновлений об'єкт
    debugLogger('INFO: Updated redirect: %s', shortCode);
    res.json({ success: true });
});

app.delete('/redirects/:shortCode', (req, res) => {
    const { shortCode } = req.params;
    if (!redirectsCache.has(shortCode)) {
        // Якщо не знайдено, це не помилка для DELETE запиту
        debugLogger('INFO: Redirect not found for deletion: %s', shortCode);
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
// -------------------------------------------------------

function startServer(port, host) {
    server.removeAllListeners('listening'); // Запобігаємо дублюванню слухачів при перезапуску
    server.removeAllListeners('error');

    server.listen(port, host, () => {
        const actualPort = server.address()?.port || port;
        debugLogger('INFO: HTTP Server started on %s:%d', host, actualPort);
        // Лог про PeerJS сервер залишаємо, але тепер ми маємо детальніші логи вище
        debugLogger('INFO: PeerJS Server should be running at path /peerjs-server on the same host/port.');
    });

    server.on('error', (err) => {
        debugLogger('FATAL ERROR: HTTP Server error: %o', err);
        if (err.code === 'EADDRINUSE') {
            debugLogger('ERROR: Port %d in use. Cannot start server.', port);
            // Не намагаємось перезапустити автоматично, це може спричинити проблеми на Render
            // setTimeout(() => { server.close(); startServer(port, host); }, 5000);
        } else {
            // Інші помилки сервера можуть бути критичними
            // throw err; // Не кидаємо throw, щоб сервер не впав повністю, але логуємо
        }
    });
}

// Запускаємо сервер
startServer(HTTP_PORT, HOST);

process.on('SIGTERM', () => {
    debugLogger('INFO: Received SIGTERM, shutting down gracefully...');
    // Закриваємо PeerServer, якщо він існує
    if (peerServerInstance && typeof peerServerInstance.close === 'function') {
         debugLogger('INFO: Closing PeerServer...');
         peerServerInstance.close(); // Метод close може не існувати в 'peer', перевіряємо документацію
         // peerServerInstance = null; // Очищаємо змінну
    }
    server.close(() => {
        debugLogger('INFO: HTTP Server stopped.');
        process.exit(0); // Вихід після закриття сервера
    });
    // Додатковий таймаут для примусового виходу, якщо сервер "завис"
    setTimeout(() => {
        debugLogger('WARN: Forcing exit after timeout.');
        process.exit(1);
    }, 5000); // 5 секунд на закриття
});
