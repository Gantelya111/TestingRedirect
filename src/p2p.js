import { createLibp2p } from 'libp2p';
import { webRTC } from '@libp2p/webrtc';
import { webSockets } from '@libp2p/websockets';
import { mplex } from '@libp2p/mplex';
import { noise } from '@chainsafe/libp2p-noise';
import { kadDHT } from '@libp2p/kad-dht';
import { gossipsub } from '@chainsafe/libp2p-gossipsub';
import { identify } from '@libp2p/identify';
import { ping } from '@libp2p/ping';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { fromString as uint8ArrayFromString, toString as uint8ArrayToString } from 'uint8arrays';
import { multiaddr as Multiaddr } from '@multiformats/multiaddr';
import { logger } from '@libp2p/logger';
import { createHash } from 'crypto';

// Локальний логер
const debugLogger = logger('p2p-app');

// Перевірка середовища
const isSecureContext = typeof window !== 'undefined' && window.isSecureContext;
const isCryptoAvailable = typeof crypto !== 'undefined' && crypto.subtle && typeof crypto.subtle.digest === 'function';
const isLocalhost = typeof window !== 'undefined' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');
const isHttps = typeof window !== 'undefined' && window.location.protocol === 'https:';
debugLogger('INFO: Environment - SecureContext: %o, CryptoAvailable: %o, Localhost: %o, HTTPS: %o',
    isSecureContext, isCryptoAvailable, isLocalhost, isHttps);

if (!isHttps && !isLocalhost) {
    debugLogger('WARN: Running on HTTP (not localhost). WebRTC prioritized.');
}

let node = null;
const redirectsCache = new Map();
const topic = 'redirects-changes-v4';
const REPUBLISH_INTERVAL_MS = 10 * 60 * 1000;
const DHT_PUT_OPTIONS = { timeout: 8000 };
const DHT_GET_OPTIONS = { timeout: 4000 };
const MAX_SHORTCODE_ATTEMPTS = 15;
const KEY_PREFIX = '/redirect-p2p/entry/';
const STATIC_FILES_PROTOCOL = '/static-files/1.0.0';

let republishIntervalId = null;
let nodeStatus = 'idle';
let startNodePromise = null;
let pollingIntervalId = null;

// Зберігання та відновлення кешу
function saveRedirectsCache() {
    try {
        const cacheObject = Object.fromEntries(redirectsCache);
        localStorage.setItem('redirectsCache', JSON.stringify(cacheObject));
        debugLogger('INFO: Saved redirectsCache: %o', cacheObject);
    } catch (err) {
        debugLogger('ERROR: Failed to save redirectsCache: %o', err);
    }
}

function loadRedirectsCache() {
    try {
        const cacheData = localStorage.getItem('redirectsCache');
        if (cacheData) {
            const cacheObject = JSON.parse(cacheData);
            for (const [key, value] of Object.entries(cacheObject)) {
                redirectsCache.set(key, value);
            }
            debugLogger('INFO: Loaded redirectsCache: %o', cacheObject);
        }
    } catch (err) {
        debugLogger('ERROR: Failed to load redirectsCache: %o', err);
    }
}

function clearOldRedirectData() {
    try {
        for (const key in localStorage) {
            if (key.startsWith('redirect_') && key.endsWith('_hash')) {
                localStorage.removeItem(key);
                debugLogger(`INFO: Removed old redirect data: ${key}`);
            }
        }
    } catch (err) {
        debugLogger(`ERROR: Failed to clear old redirect data:`, err);
    }
}

clearOldRedirectData();
loadRedirectsCache();

/**
 * Публікація адреси вузла в DHT
 */
async function publishNodeAddress() {
    if (!node || node.status !== 'started' || !node.services?.dht) {
        debugLogger('WARN: Cannot publish node address: node or DHT not ready');
        return;
    }
    const nodeKey = `/p2p-nodes/${node.peerId.toString()}`;
    const nodeValue = JSON.stringify({
        multiaddrs: node.getMultiaddrs().map(ma => ma.toString()),
        timestamp: Date.now()
    });
    try {
        await node.services.dht.put(
            uint8ArrayFromString(nodeKey),
            uint8ArrayFromString(nodeValue),
            DHT_PUT_OPTIONS
        );
        debugLogger('INFO: Published node address: %s', nodeKey);
    } catch (err) {
        debugLogger('ERROR: Failed to publish node address: %o', err);
    }
}

/**
 * Пошук пірів через DHT
 */
async function discoverPeers() {
    if (!node || !node.services?.dht) {
        debugLogger('WARN: Cannot discover peers: node or DHT not ready');
        return [];
    }
    const peerAddresses = [];
    const prefix = '/p2p-nodes/';
    try {
        for await (const provider of node.services.dht.findProviders(uint8ArrayFromString(prefix), DHT_GET_OPTIONS)) {
            const key = `/p2p-nodes/${provider.id.toString()}`;
            try {
                const value = await node.services.dht.get(uint8ArrayFromString(key), DHT_GET_OPTIONS);
                const nodeData = JSON.parse(uint8ArrayToString(value));
                if (nodeData.multiaddrs && Array.isArray(nodeData.multiaddrs)) {
                    peerAddresses.push(...nodeData.multiaddrs);
                    debugLogger('INFO: Discovered peer: %s with addresses: %o', key, nodeData.multiaddrs);
                }
            } catch (err) {
                debugLogger('ERROR: Failed to fetch peer data for %s: %o', key, err);
            }
        }
    } catch (err) {
        debugLogger('ERROR: Failed to discover peers: %o', err);
    }
    return peerAddresses;
}

/**
 * Отримання адреси bootstrap-вузла
 */
async function fetchBootstrapAddress() {
    const domain = isLocalhost ? 'localhost' : 'libp2p.onrender.com';
    const port = isLocalhost ? (process.env.PORT || 3000) : 443;
    const bootstrapUrl = isLocalhost ? `http://${domain}:${port}/bootstrap-address` : `https://${domain}/bootstrap-address`;
    try {
        debugLogger('INFO: Fetching bootstrap address from %s', bootstrapUrl);
        const response = await fetch(bootstrapUrl, { signal: AbortSignal.timeout(5000) });
        if (!response.ok) throw new Error(`HTTP error: ${response.status}`);
        const data = await response.json();
        if (data.multiaddr) {
            let addr = data.multiaddr;
            if (!isLocalhost && addr.includes('ws://')) addr = addr.replace('ws://', 'wss://');
            debugLogger('INFO: Received bootstrap address: %s', addr);
            return [addr];
        }
        debugLogger('WARN: No multiaddr in response');
        return [];
    } catch (err) {
        debugLogger('ERROR: Failed to fetch bootstrap address: %o', err);
        return [];
    }
}

/**
 * HTTP Polling для резервної синхронізації
 */
async function syncRedirectsViaPolling() {
    if (!isHttps && !isLocalhost) {
        debugLogger('WARN: HTTP polling disabled in non-HTTPS environment');
        return;
    }
    try {
        const response = await fetch('https://libp2p.onrender.com/redirects', { signal: AbortSignal.timeout(5000) });
        if (!response.ok) throw new Error(`HTTP error: ${response.status}`);
        const redirects = await response.json();
        redirects.forEach(r => {
            if (r.shortCode && r.destinationUrl) redirectsCache.set(r.shortCode, r);
        });
        saveRedirectsCache();
        debugLogger('INFO: Synced redirects via HTTP polling');
        updateP2PStatus('Synced via polling');
    } catch (err) {
        debugLogger('ERROR: Failed to sync redirects via polling: %o', err);
        updateP2PStatus('Failed polling', true);
    }
}

function startPolling() {
    if (pollingIntervalId) clearInterval(pollingIntervalId);
    syncRedirectsViaPolling();
    pollingIntervalId = setInterval(syncRedirectsViaPolling, 5 * 1000);
    debugLogger('INFO: Started HTTP polling');
}

/**
 * Запит статичного файлу
 */
async function requestStaticFile(filePath) {
    if (!node || node.status !== 'started' || !node.services?.dht) {
        debugLogger('WARN: Cannot request file: node or DHT not ready');
        return null;
    }
    const fileKey = `/static-files/${filePath}`;
    try {
        const contentBytes = await node.services.dht.get(uint8ArrayFromString(fileKey), DHT_GET_OPTIONS);
        if (contentBytes) {
            const content = uint8ArrayToString(contentBytes);
            localStorage.setItem(`site-file:${filePath}`, content);
            debugLogger('INFO: Fetched file %s from DHT', filePath);
            return content;
        }
    } catch (err) {
        debugLogger('ERROR: Failed to fetch file %s: %o', filePath, err);
    }
    const providers = [];
    for await (const provider of node.services.dht.findProviders(uint8ArrayFromString(fileKey), DHT_GET_OPTIONS)) {
        providers.push(provider);
    }
    for (const provider of providers) {
        try {
            const stream = await node.dialProtocol(provider.id, STATIC_FILES_PROTOCOL);
            await stream.sink(uint8ArrayFromString(filePath));
            const response = [];
            for await (const chunk of stream.source) {
                response.push(chunk.slice());
            }
            const content = uint8ArrayToString(response[0]);
            localStorage.setItem(`site-file:${filePath}`, content);
            debugLogger('INFO: Fetched file %s from peer %s', filePath, provider.id.toString());
            return content;
        } catch (err) {
            debugLogger('ERROR: Failed to fetch file %s from peer %s: %o', filePath, provider.id.toString(), err);
        }
    }
    return null;
}

/**
 * Завантаження index.html
 */
async function loadSiteFromP2P() {
    if (!node || node.status !== 'started') {
        debugLogger('WARN: Cannot load site: node not ready');
        updateP2PStatus('Node not ready for site loading', true);
        return false;
    }
    const criticalFile = 'index.html';
    if (!localStorage.getItem(`site-file:${criticalFile}`)) {
        const content = await requestStaticFile(criticalFile);
        if (!content) {
            debugLogger('ERROR: Failed to load %s', criticalFile);
            updateP2PStatus(`Failed to load ${criticalFile}`, true);
            return false;
        }
    }
    const indexContent = localStorage.getItem(`site-file:${criticalFile}`);
    if (indexContent) {
        document.open();
        document.write(indexContent);
        document.close();
        debugLogger('INFO: Loaded index.html');
        updateP2PStatus('Index loaded');
        return true;
    }
    debugLogger('ERROR: Failed to load index.html');
    updateP2PStatus('Failed to load index.html', true);
    return false;
}

/**
 * Завантаження некритичних файлів
 */
async function loadNonCriticalFiles() {
    if (!node || node.status !== 'started') {
        debugLogger('WARN: Cannot load non-critical files: node not ready');
        return;
    }
    const nonCriticalFiles = ['p2p.js', 'manager.js', 'edit-redirect.js', 'p2p-app.js', 'polyfills.js'];
    for (const file of nonCriticalFiles) {
        if (!localStorage.getItem(`site-file:${file}`)) {
            const content = await requestStaticFile(file);
            if (content) debugLogger('INFO: Fetched background file %s', file);
        }
    }
}

/**
 * Публікація статичних файлів
 */
async function publishStaticFiles() {
    if (!node || !node.services?.dht) {
        debugLogger('WARN: Cannot publish files: node or DHT not ready');
        return;
    }
    const staticFiles = [
        { path: 'index.html', key: '/static-files/index.html' },
        { path: 'p2p.js', key: '/static-files/p2p.js' },
        { path: 'manager.js', key: '/static-files/manager.js' },
        { path: 'edit-redirect.js', key: '/static-files/edit-redirect.js' },
        { path: 'p2p-app.js', key: '/static-files/p2p-app.js' },
        { path: 'polyfills.js', key: '/static-files/polyfills.js' }
    ];
    for (const file of staticFiles) {
        const content = localStorage.getItem(`site-file:${file.path}`);
        if (content) {
            try {
                await node.services.dht.put(
                    uint8ArrayFromString(file.key),
                    uint8ArrayFromString(content),
                    DHT_PUT_OPTIONS
                );
                debugLogger('INFO: Published file: %s', file.key);
            } catch (err) {
                debugLogger('ERROR: Failed to publish file %s: %o', file.key, err);
            }
        }
    }
    setInterval(async () => {
        if (!node || !node.services?.dht) return;
        for (const file of staticFiles) {
            const content = localStorage.getItem(`site-file:${file.path}`);
            if (content) {
                node.services.dht.put(
                    uint8ArrayFromString(file.key),
                    uint8ArrayFromString(content),
                    DHT_PUT_OPTIONS
                ).catch(err => debugLogger('ERROR: Failed to republish file %s: %o', file.key, err));
            }
        }
    }, 5 * 60 * 1000);
}

/**
 * Оновлення статусу
 */
function updateP2PStatus(status, isError = false) {
    debugLogger(`INFO: P2P status: ${status}, isError: ${isError}`);
    const statusElement = document.getElementById('p2p-status');
    if (statusElement) {
        statusElement.textContent = `P2P: ${status}`;
        statusElement.style.color = isError ? 'red' : 'green';
    }
}

/**
 * Запуск вузла
 */
async function startNodeInternal() {
    debugLogger('INFO: Starting node');
    if (node && node.status === 'started') {
        debugLogger('INFO: Node already started');
        updateP2PStatus('Already started');
        return node;
    }
    if (nodeStatus === 'starting') {
        debugLogger('INFO: Node initialization in progress');
        return startNodePromise;
    }

    nodeStatus = 'starting';
    updateP2PStatus('Initializing...');

    try {
        const bootstrapMultiaddrs = await fetchBootstrapAddress();
        debugLogger('INFO: Bootstrap addresses: %o', bootstrapMultiaddrs);

        const config = {
            transports: [
                webRTC({
                    rtcConfiguration: {
                        iceServers: [
                            { urls: 'stun:stun.l.google.com:19302' },
                            { urls: 'stun:stun1.l.google.com:19302' },
                            { urls: 'stun:stun2.l.google.com:19302' },
                            { urls: 'stun:stun3.l.google.com:19302' }
                        ]
                    }
                }),
                webSockets(),
                circuitRelayTransport()
            ],
            streamMuxers: [mplex()],
            connectionEncryption: [noise()],
            services: {
                dht: kadDHT({
                    clientMode: true,
                    protocol: '/p2p-redirect/kad/1.0.0'
                }),
                pubsub: gossipsub({
                    allowPublishToZeroPeers: true,
                    emitSelf: true
                }),
                identify: identify(),
                ping: ping()
            },
            connectionManager: {
                minConnections: 0,
                maxConnections: 50
            }
        };
        debugLogger('INFO: Libp2p config: %o', config);

        node = await createLibp2p(config);
        debugLogger('INFO: Node created, ID: %s', node.peerId.toString());

        node.addEventListener('error', (evt) => {
            debugLogger('ERROR: Node error: %o', evt.detail);
            updateP2PStatus(`Node error: ${evt.detail.message}`, true);
        });

        node.handle(STATIC_FILES_PROTOCOL, async ({ stream, connection }) => {
            try {
                const filePath = uint8ArrayToString((await stream.source.next()).value.slice());
                const content = localStorage.getItem(`site-file:${filePath}`);
                if (content) {
                    await stream.sink([uint8ArrayFromString(content)]);
                    debugLogger('INFO: Served file %s to %s', filePath, connection.remotePeer.toString());
                } else {
                    await stream.close();
                }
            } catch (err) {
                debugLogger('ERROR: Failed to handle file request: %o', err);
                await stream.close();
            }
        });

        node.addEventListener('peer:discovery', (evt) => {
            const peerId = evt.detail.id.toString();
            debugLogger('INFO: Discovered peer: %s', peerId);
            updateP2PStatus(`Discovered: ${peerId.substring(0, 10)}...`);
        });

        node.addEventListener('peer:connect', (evt) => {
            const peerId = evt.detail.toString();
            debugLogger('INFO: Connected to %s', peerId);
            updateP2PStatus(`Connected: ${peerId.substring(0, 10)}...`);
            for (const [shortCode, redirect] of redirectsCache) {
                const message = {
                    action: 'create',
                    shortCode,
                    redirect: {
                        destinationUrl: redirect.destinationUrl,
                        description: redirect.description,
                        createdAt: redirect.createdAt
                    }
                };
                if (node?.services?.pubsub) {
                    node.services.pubsub.publish(
                        topic,
                        uint8ArrayFromString(JSON.stringify(message))
                    ).catch(err => debugLogger('ERROR: Failed to publish redirect: %o', err));
                }
            }
        });

        await node.start();
        nodeStatus = 'started';
        debugLogger('INFO: Node started, ID: %s', node.peerId.toString());
        debugLogger('INFO: Node multiaddrs: %o', node.getMultiaddrs().map(ma => ma.toString()));
        debugLogger('INFO: PubSub topics: %o', node.services?.pubsub?.getTopics() || []);

        // Підключення до bootstrap-вузлів
        let successfulConnections = 0;
        for (const addr of bootstrapMultiaddrs) {
            try {
                await node.dial(Multiaddr(addr), { timeout: 5000 });
                debugLogger('INFO: Dialed bootstrap: %s', addr);
                successfulConnections++;
            } catch (err) {
                debugLogger('ERROR: Failed to dial bootstrap %s: %o', addr, err);
            }
        }

        // Підключення до пірів із DHT
        const dhtAddrs = await discoverPeers();
        for (const addr of dhtAddrs) {
            try {
                await node.dial(Multiaddr(addr), { timeout: 5000 });
                debugLogger('INFO: Dialed DHT peer: %s', addr);
                successfulConnections++;
            } catch (err) {
                debugLogger('ERROR: Failed to dial DHT peer %s: %o', addr, err);
            }
        }

        // Ініціалізація PubSub
        if (node.services?.pubsub) {
            try {
                await node.services.pubsub.subscribe(topic);
                debugLogger('INFO: Subscribed to PubSub topic: %s', topic);
                node.services.pubsub.addEventListener('message', handlePubsubMessage);
            } catch (err) {
                debugLogger('ERROR: Failed to subscribe to PubSub: %o', err);
                updateP2PStatus('PubSub subscription failed', true);
                startPolling();
            }
        } else {
            debugLogger('WARN: PubSub service not available');
            updateP2PStatus('PubSub unavailable, using polling', true);
            startPolling();
        }

        // Виконання критичних операцій після ініціалізації
        const criticalPromises = [
            publishNodeAddress(),
            loadSiteFromP2P(),
            publishStaticFiles()
        ];

        await Promise.all(criticalPromises);

        if (successfulConnections === 0) {
            debugLogger('WARN: No connections established, enabling polling');
            updateP2PStatus('No network connection, using polling', true);
            startPolling();
        } else {
            debugLogger('INFO: Connected to %d peers', successfulConnections);
            updateP2PStatus(`Connected to ${successfulConnections} peers`);
        }

        // Періодичне оновлення пірів
        setInterval(async () => {
            if (!node || node.status !== 'started') return;
            await publishNodeAddress();
            const newAddrs = await discoverPeers();
            for (const addr of newAddrs) {
                try {
                    await node.dial(Multiaddr(addr), { timeout: 5000 });
                    debugLogger('INFO: Dialed discovered peer: %s', addr);
                } catch (err) {
                    debugLogger('ERROR: Failed to dial discovered peer: %o', err);
                }
            }
        }, 3 * 60 * 1000);

        // Фонове завантаження некритичних файлів
        setTimeout(loadNonCriticalFiles, 1000);
        startRepublishing();

        updateP2PStatus(`Ready, peers: ${node.getPeers().length}`);
        return node;
    } catch (err) {
        debugLogger('ERROR: Node initialization failed: %o', err);
        console.error('Node initialization error:', err.stack);
        nodeStatus = 'failed';
        updateP2PStatus(`Failed: ${err.message}`, true);
        startPolling();
        node = null;
        throw err;
    }
}

startNodePromise = startNodeInternal();

async function stopNode() {
    debugLogger('INFO: Stopping node');
    if (republishIntervalId) clearInterval(republishIntervalId);
    if (pollingIntervalId) clearInterval(pollingIntervalId);
    if (node && node.status === 'started') {
        try {
            await node.stop();
            debugLogger('INFO: Node stopped');
            updateP2PStatus('Stopped');
        } catch (err) {
            debugLogger('ERROR: Failed to stop node: %o', err);
            updateP2PStatus('Error stopping node', true);
        }
    }
    node = null;
    nodeStatus = 'idle';
    startNodePromise = null;
    redirectsCache.clear();
    localStorage.removeItem('redirectsCache');
    clearOldRedirectData();
}

async function handlePubsubMessage(evt) {
    if (evt.detail.topic !== topic) return;
    try {
        const message = JSON.parse(uint8ArrayToString(evt.detail.data));
        debugLogger('INFO: PubSub message: %o', message);
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
                        shortCode,
                        passwordHash: current.passwordHash || redirect.passwordHash
                    });
                    saveRedirectsCache();
                    if (node?.services?.dht) {
                        await node.services.dht.put(
                            uint8ArrayFromString(`${KEY_PREFIX}${shortCode}`),
                            uint8ArrayFromString(JSON.stringify(redirectsCache.get(shortCode))),
                            DHT_PUT_OPTIONS
                        );
                    }
                }
                break;
            case 'delete':
                redirectsCache.delete(shortCode);
                saveRedirectsCache();
                break;
        }
    } catch (err) {
        debugLogger('ERROR: Failed to handle PubSub: %o', err);
    }
}

async function republishActiveRedirects() {
    if (!node || node.status !== 'started' || !node.services?.dht) {
        debugLogger('WARN: Cannot republish redirects: node or DHT not ready');
        return;
    }
    let successCount = 0;
    for (const [shortCode, redirect] of redirectsCache) {
        if (redirect.destinationUrl && redirect.passwordHash) {
            try {
                await node.services.dht.put(
                    uint8ArrayFromString(`${KEY_PREFIX}${shortCode}`),
                    uint8ArrayFromString(JSON.stringify(redirect)),
                    DHT_PUT_OPTIONS
                );
                successCount++;
            } catch (err) {
                debugLogger('ERROR: Failed to republish redirect %s: %o', shortCode, err);
            }
        }
    }
    debugLogger('INFO: Republished %d redirects', successCount);
}

function startRepublishing() {
    if (republishIntervalId) clearInterval(republishIntervalId);
    republishActiveRedirects();
    republishIntervalId = setInterval(republishActiveRedirects, REPUBLISH_INTERVAL_MS);
}

async function createRedirect(url, description = '') {
    debugLogger('INFO: Creating redirect: %s', url);
    if (!url || typeof url !== 'string' || url.length < 5) throw new Error('Invalid URL');
    await startNodePromise.catch(err => debugLogger('WARN: Node failed to start, proceeding in local mode: %o', err));
    const isIsolated = !node || !node.services?.dht;
    let shortCode;
    let attempts = 0;
    while (attempts < MAX_SHORTCODE_ATTEMPTS) {
        attempts++;
        shortCode = await generateShortCode(url + Date.now() + Math.random());
        if (redirectsCache.has(shortCode)) continue;
        if (isIsolated) break;
        try {
            await node.services.dht.get(uint8ArrayFromString(`${KEY_PREFIX}${shortCode}`), DHT_GET_OPTIONS);
        } catch (err) {
            if (err.code === 'ERR_NOT_FOUND') break;
        }
    }
    if (attempts >= MAX_SHORTCODE_ATTEMPTS) throw new Error('Failed to generate unique shortCode');
    const password = generatePassword();
    const passwordHash = await hashPassword(password);
    const redirect = {
        shortCode,
        destinationUrl: url,
        description,
        passwordHash,
        createdAt: Date.now()
    };
    try {
        if (!isIsolated) {
            await node.services.dht.put(
                uint8ArrayFromString(`${KEY_PREFIX}${shortCode}`),
                uint8ArrayFromString(JSON.stringify(redirect)),
                DHT_PUT_OPTIONS
            );
        }
        redirectsCache.set(shortCode, redirect);
        saveRedirectsCache();
        if (!isIsolated && node?.services?.pubsub) {
            await node.services.pubsub.publish(
                topic,
                uint8ArrayFromString(JSON.stringify({
                    action: 'create',
                    shortCode,
                    redirect: { destinationUrl: url, description, createdAt: redirect.createdAt }
                }))
            );
        }
        updateP2PStatus('Redirect created');
        return { shortCode, password };
    } catch (err) {
        debugLogger('ERROR: Failed to create redirect: %o', err);
        updateP2PStatus('Failed to create redirect', true);
        throw new Error('Failed to create redirect');
    }
}

async function getRedirect(shortCode) {
    debugLogger('INFO: Getting redirect: %s', shortCode);
    if (!shortCode) return null;
    if (redirectsCache.has(shortCode)) {
        debugLogger('INFO: Found in cache: %s', shortCode);
        return redirectsCache.get(shortCode);
    }
    if (!node || !node.services?.dht) {
        debugLogger('WARN: Node or DHT not ready for %s', shortCode);
        return null;
    }
    try {
        const recordBytes = await node.services.dht.get(uint8ArrayFromString(`${KEY_PREFIX}${shortCode}`), DHT_GET_OPTIONS);
        const redirect = JSON.parse(uint8ArrayToString(recordBytes));
        if (redirect && redirect.destinationUrl) {
            redirectsCache.set(shortCode, redirect);
            saveRedirectsCache();
            debugLogger('INFO: Found in DHT: %s', shortCode);
            return redirect;
        }
        return null;
    } catch (err) {
        debugLogger('ERROR: Failed to get redirect %s: %o', shortCode, err);
        return null;
    }
}

async function updateRedirect(shortCode, newUrl, newDescription, password) {
    debugLogger('INFO: Updating redirect: %s', shortCode);
    if (!newUrl || typeof newUrl !== 'string' || newUrl.length < 5) throw new Error('Invalid URL');
    const stored = await getRedirect(shortCode);
    if (!stored) throw new Error('Redirect not found');
    if (!(await verifyRedirectPassword(password, stored.passwordHash))) throw new Error('Incorrect password');
    const isIsolated = !node || !node.services?.dht;
    const updatedRedirect = {
        ...stored,
        destinationUrl: newUrl,
        description: newDescription || stored.description,
        updatedAt: Date.now()
    };
    try {
        if (!isIsolated) {
            await node.services.dht.put(
                uint8ArrayFromString(`${KEY_PREFIX}${shortCode}`),
                uint8ArrayFromString(JSON.stringify(updatedRedirect)),
                DHT_PUT_OPTIONS
            );
        }
        redirectsCache.set(shortCode, updatedRedirect);
        saveRedirectsCache();
        if (!isIsolated && node?.services?.pubsub) {
            await node.services.pubsub.publish(
                topic,
                uint8ArrayFromString(JSON.stringify({
                    action: 'update',
                    shortCode,
                    redirect: {
                        destinationUrl: newUrl,
                        description: newDescription,
                        updatedAt: updatedRedirect.updatedAt
                    }
                }))
            );
        }
        updateP2PStatus('Redirect updated');
        return { success: true };
    } catch (err) {
        debugLogger('ERROR: Failed to update redirect: %o', err);
        updateP2PStatus('Failed to update redirect', true);
        throw new Error('Failed to update redirect');
    }
}

async function deleteRedirect(shortCode, password) {
    debugLogger('INFO: Deleting redirect: %s', shortCode);
    const stored = await getRedirect(shortCode);
    if (!stored) return { success: true, message: 'Redirect not found' };
    if (!(await verifyRedirectPassword(password, stored.passwordHash))) throw new Error('Incorrect password');
    const isIsolated = !node || !node.services?.dht;
    try {
        redirectsCache.delete(shortCode);
        saveRedirectsCache();
        if (!isIsolated && node?.services?.pubsub) {
            await node.services.pubsub.publish(
                topic,
                uint8ArrayFromString(JSON.stringify({ action: 'delete', shortCode }))
            );
        }
        updateP2PStatus('Redirect deleted');
        return { success: true };
    } catch (err) {
        debugLogger('ERROR: Failed to delete redirect: %o', err);
        updateP2PStatus('Failed to delete redirect', true);
        throw new Error('Failed to delete redirect');
    }
}

function getLocalRedirects(searchQuery = '') {
    debugLogger('INFO: Getting local redirects with query: %s', searchQuery);
    const query = searchQuery.toLowerCase().trim();
    const redirects = Array.from(redirectsCache.values());
    if (!query) return redirects;
    return redirects.filter(r =>
        r.shortCode.toLowerCase().includes(query) ||
        r.description.toLowerCase().includes(query) ||
        r.destinationUrl.toLowerCase().includes(query)
    );
}

function generatePassword(length = 12) {
    const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const values = new Uint8Array(length);
    crypto.getRandomValues(values);
    return Array.from(values).map(v => charset[v % charset.length]).join('');
}

function generateSalt(length = 16) {
    const values = new Uint8Array(length);
    crypto.getRandomValues(values);
    return Array.from(values, byte => byte.toString(16).padStart(2, '0')).join('');
}

async function hashPassword(password, salt = null) {
    const currentSalt = salt || generateSalt();
    if (isCryptoAvailable) {
        const encoder = new TextEncoder();
        const data = encoder.encode(password + currentSalt);
        const hashBuffer = await crypto.subtle.digest('SHA-256', data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
        return `${currentSalt}:${hashHex}`;
    } else {
        const hash = createHash('sha256');
        hash.update(password + currentSalt);
        const hashHex = hash.digest('hex');
        return `${currentSalt}:${hashHex}`;
    }
}

async function verifyRedirectPassword(password, storedSaltAndHash) {
    if (!password || !storedSaltAndHash || !storedSaltAndHash.includes(':')) return false;
    const [salt, storedHash] = storedSaltAndHash.split(':');
    const providedHash = await hashPassword(password, salt);
    return providedHash === storedSaltAndHash;
}

async function generateShortCode(input) {
    if (isCryptoAvailable) {
        const encoder = new TextEncoder();
        const data = encoder.encode(input);
        const hashBuffer = await crypto.subtle.digest('SHA-256', data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
        return hashHex.slice(0, 10);
    } else {
        const hash = createHash('sha256');
        hash.update(input);
        const hashHex = hash.digest('hex');
        return hashHex.slice(0, 10);
    }
}

window.debugNodeStatus = () => {
    console.log('Node Status:', {
        initialized: !!node,
        status: node?.status || 'not initialized',
        peerId: node?.peerId?.toString() || 'unknown',
        peers: node?.getPeers().map(p => p.toString()) || [],
        multiaddrs: node?.getMultiaddrs().map(ma => ma.toString()) || [],
        pubsubTopics: node?.services?.pubsub?.getTopics() || []
    });
};

window.testP2P = {
    getPeers: () => node?.getPeers().map(p => p.toString()) || [],
    getStatus: () => window.debugNodeStatus(),
    discoverPeers: async () => {
        const addrs = await discoverPeers();
        for (const addr of addrs) {
            try {
                await node.dial(Multiaddr(addr), { timeout: 5000 });
                console.log(`Dialed: ${addr}`);
            } catch (err) {
                console.error(`Failed to dial ${addr}:`, err);
            }
        }
    }
};

export {
    startNodePromise,
    stopNode,
    createRedirect,
    getRedirect,
    updateRedirect,
    deleteRedirect,
    getLocalRedirects,
    verifyRedirectPassword
};
