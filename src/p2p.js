import { createLibp2p } from 'libp2p';
import { webSockets } from '@libp2p/websockets';
import { webRTC } from '@libp2p/webrtc';
import { mplex } from '@libp2p/mplex';
import { noise } from '@chainsafe/libp2p-noise';
import { kadDHT } from '@libp2p/kad-dht';
import { gossipsub } from '@chainsafe/libp2p-gossipsub';
import { identify } from '@libp2p/identify';
import { ping } from '@libp2p/ping';
import { bootstrap } from '@libp2p/bootstrap';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { fromString as uint8ArrayFromString, toString as uint8ArrayToString } from 'uint8arrays';
import { multiaddr } from '@multiformats/multiaddr';
import { logger } from '@libp2p/logger';
import { createHash } from 'crypto';

// Локальний логер
const debugLogger = logger('p2p-app');

// Перевірка середовища
const isSecureContext = typeof window !== 'undefined' && window.isSecureContext;
const isCryptoAvailable = typeof crypto !== 'undefined' && crypto.subtle && typeof crypto.subtle.digest === 'function';
const isLocalhost = typeof window !== 'undefined' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');
const isHttps = typeof window !== 'undefined' && window.location.protocol === 'https:';
debugLogger('INFO: Environment check - SecureContext: %o, CryptoAvailable: %o, Localhost: %o, HTTPS: %o', 
    isSecureContext, isCryptoAvailable, isLocalhost, isHttps);

if (!isHttps && !isLocalhost) {
    debugLogger('WARN: Running on HTTP (not localhost). Consider using HTTPS for full functionality.');
}

let node;
const redirectsCache = new Map();
const topic = 'redirects-changes-v3';
const REPUBLISH_INTERVAL_MS = 10 * 60 * 1000;
const DHT_PUT_OPTIONS = { timeout: 60000 };
const DHT_GET_OPTIONS = { timeout: 30000 };
const MAX_SHORTCODE_GENERATION_ATTEMPTS = 15;
const KEY_PREFIX = '/redirect-p2p/entry/';

let republishIntervalId = null;
let nodeInitializationStatus = 'idle';
let startNodePromise = null;

// Зберігання redirectsCache у localStorage
function saveRedirectsCacheToLocalStorage() {
    try {
        const cacheObject = {};
        for (const [key, value] of redirectsCache) {
            cacheObject[key] = value;
        }
        localStorage.setItem('redirectsCache', JSON.stringify(cacheObject));
        debugLogger('INFO: Saved redirectsCache to localStorage: %o', cacheObject);
    } catch (err) {
        debugLogger(`ERROR: Failed to save redirectsCache to localStorage:`, err);
    }
}

// Відновлення redirectsCache із localStorage
function loadRedirectsCacheFromLocalStorage() {
    try {
        const cacheData = localStorage.getItem('redirectsCache');
        if (cacheData) {
            const cacheObject = JSON.parse(cacheData);
            for (const key in cacheObject) {
                if (cacheObject.hasOwnProperty(key)) {
                    redirectsCache.set(key, cacheObject[key]);
                }
            }
            debugLogger('INFO: Loaded redirectsCache from localStorage: %o', cacheObject);
        } else {
            debugLogger('INFO: No redirectsCache found in localStorage');
        }
    } catch (err) {
        debugLogger(`ERROR: Failed to load redirectsCache from localStorage:`, err);
    }
}

// Очищення старих даних
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
loadRedirectsCacheFromLocalStorage();

/**
 * Отримання адреси bootstrap-вузла
 * @returns {Promise<string[]>}
 */
async function fetchBootstrapAddress() {
    const bootstrapUrl = isLocalhost
        ? 'http://localhost:4001/bootstrap-address'
        : 'https://my-p2p-bootstrap.onrender.com/bootstrap-address';
    const fallbackMultiaddrs = [
        '/dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN',
        '/dnsaddr/bootstrap.libp2p.io/p2p/QmbLHAnMoJPWSCR5i1FxheG2QeQcg3EsxS7bL63wQXoJYH',
        '/dnsaddr/bootstrap.libp2p.io/p2p/QmZa1sAx2BN6o2jYP7M3s7d4T3XgC7v1eGU5dwV3a3H6TU',
    ];

    try {
        debugLogger('INFO: Fetching bootstrap address from %s', bootstrapUrl);
        const response = await fetch(bootstrapUrl, { timeout: 5000 });
        if (!response.ok) {
            throw new Error(`HTTP error: ${response.status}`);
        }
        const data = await response.json();
        if (data.address) {
            debugLogger('INFO: Received bootstrap address: %s', data.address);
            return [data.address, ...fallbackMultiaddrs];
        }
        throw new Error('Invalid bootstrap address received');
    } catch (err) {
        debugLogger('ERROR: Failed to fetch bootstrap address: %o', err);
        debugLogger('INFO: Falling back to public bootstrap nodes');
        return fallbackMultiaddrs;
    }
}

/**
 * Оновлення статусу P2P у UI
 * @param {string} status - Статус
 * @param {boolean} isError - Чи є помилкою
 */
function updateP2PStatus(status, isError = false) {
    debugLogger(`INFO: Updating P2P status: ${status}, isError: ${isError}`);
    const statusElement = document.getElementById('p2p-status');
    if (statusElement) {
        statusElement.textContent = `P2P Status: ${status}`;
        statusElement.style.color = isError ? 'red' : 'green';
        debugLogger(`INFO: P2P Status set in UI: ${status}`);
    } else {
        debugLogger(`INFO: P2P Status (UI element not found): ${status}`);
    }
}

/**
 * Запуск Libp2p вузла
 * @returns {Promise<import('libp2p').Libp2p>}
 */
async function startNodeInternal() {
    debugLogger("INFO: Starting node initialization");
    if (node && node.status === 'started') {
        debugLogger("INFO: Node already started");
        updateP2PStatus('Already started');
        return node;
    }
    if (nodeInitializationStatus === 'starting') {
        debugLogger("INFO: Node initialization in progress");
        updateP2PStatus('Initialization in progress...');
        return startNodePromise;
    }

    nodeInitializationStatus = 'starting';
    updateP2PStatus('Starting...');

    try {
        debugLogger("INFO: Fetching bootstrap addresses...");
        const bootstrapMultiaddrs = await fetchBootstrapAddress();
        debugLogger("INFO: Bootstrap addresses: %o", bootstrapMultiaddrs);

        debugLogger("INFO: Creating Libp2p configuration...");
        const config = {
            addresses: {
                listen: []
            },
            transports: [
                webSockets(),
                webRTC({
                    rtcConfiguration: {
                        iceServers: [
                            { urls: 'stun:stun.l.google.com:19302' },
                            { urls: 'stun:stun1.l.google.com:19302' },
                            // Додайте TURN-сервер за потреби
                        ]
                    }
                }),
                circuitRelayTransport()
            ],
            streamMuxers: [mplex()],
            connEncryption: [noise()],
            peerDiscovery: [
                bootstrap({
                    list: bootstrapMultiaddrs,
                    interval: 15000,
                    enabled: true
                })
            ],
            services: {
                dht: kadDHT({
                    clientMode: true,
                    protocol: '/ipfs/kad/1.0.0',
                    enabled: isCryptoAvailable
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
        debugLogger("INFO: Libp2p config: %o", config);

        debugLogger("INFO: Creating Libp2p node...");
        node = await createLibp2p(config).catch(err => {
            debugLogger('ERROR: Failed to create Libp2p node:', err);
            throw err;
        });
        if (!node) {
            debugLogger('ERROR: Node creation returned undefined');
            throw new Error('Node creation failed');
        }
        debugLogger("INFO: Libp2p node created with ID: %s", node.peerId.toString());

        // Додаємо обробники подій
        try {
            node.addEventListener('peer:discovery', (evt) => {
                const peerId = evt.detail.id ? evt.detail.id.toString() : 'unknown';
                debugLogger('INFO: Discovered peer: %s with multiaddrs: %o', peerId, evt.detail.multiaddrs.map(ma => ma.toString()));
                updateP2PStatus(`Discovered peer: ${peerId.substring(0, 10)}...`);
            });
            node.addEventListener('peer:connect', (evt) => {
                const peerId = evt.detail.toString();
                debugLogger('INFO: Connected to peer: %s', peerId);
                updateP2PStatus(`Connected to peer: ${peerId.substring(0, 10)}...`);
            });
            node.addEventListener('peer:disconnect', (evt) => {
                const peerId = evt.detail.toString();
                debugLogger('INFO: Disconnected from peer: %s', peerId);
                updateP2PStatus(`Disconnected from peer: ${peerId.substring(0, 10)}...`);
            });
            if (node.connectionManager) {
                node.connectionManager.addEventListener('connectionError', (evt) => {
                    debugLogger('ERROR: Connection error:', evt.detail);
                });
            } else {
                debugLogger('WARN: connectionManager is undefined');
            }
        } catch (err) {
            debugLogger('ERROR: Failed to add event listeners:', err);
        }

        debugLogger("INFO: Starting Libp2p node...");
        await node.start();
        nodeInitializationStatus = 'started';
        debugLogger('INFO: Libp2p node started with ID: %s', node.peerId.toString());
        debugLogger('INFO: Node addresses: %o', node.getMultiaddrs().map(ma => ma.toString()));
        debugLogger('INFO: DHT enabled: %o', !!node.services.dht);

        // Логування DHT подій
        if (node.services && node.services.dht) {
            node.services.dht.addEventListener('put', (evt) => {
                debugLogger('DHT put event: %o', evt.detail);
            });
            node.services.dht.addEventListener('get', (evt) => {
                debugLogger('DHT get event: %o', evt.detail);
            });
        } else {
            debugLogger('WARN: DHT is disabled or unavailable');
        }

        // Підключення до bootstrap-вузлів
        debugLogger('INFO: Dialing bootstrap nodes: %o', bootstrapMultiaddrs);
        updateP2PStatus('Connecting to bootstrap node...');
        let successfulConnections = 0;
        const maxRetries = 5;
        for (let addr of bootstrapMultiaddrs) {
            for (let attempt = 1; attempt <= maxRetries; attempt++) {
                debugLogger(`INFO: Attempt ${attempt} to dial bootstrap node: ${addr}`);
                try {
                    const ma = multiaddr(addr);
                    await node.dial(ma, { timeout: 45000 });
                    debugLogger('INFO: Successfully dialed bootstrap node: %s', addr);
                    successfulConnections++;
                    break;
                } catch (err) {
                    debugLogger(`ERROR: Attempt ${attempt} failed to dial bootstrap node ${addr}:`, {
                        message: err.message,
                        code: err.code,
                        stack: err.stack
                    });
                    if (attempt === maxRetries) {
                        debugLogger(`WARN: All ${maxRetries} attempts failed for ${addr}`);
                    }
                    await new Promise(resolve => setTimeout(resolve, 3000));
                }
            }
        }

        if (successfulConnections === 0) {
            debugLogger("WARN: No bootstrap nodes connected. Using local mode.");
            updateP2PStatus('No network connection. Using local mode.', true);
        } else {
            debugLogger('INFO: Connected to %d bootstrap node(s)', successfulConnections);
            updateP2PStatus(`Connected to ${successfulConnections} bootstrap node(s)`);
        }

        debugLogger('INFO: Network status - Peers: %o', node.getPeers().map(p => p.toString()));
        await new Promise(resolve => setTimeout(resolve, 5000));

        try {
            debugLogger("INFO: Subscribing to PubSub topic: %s", topic);
            await node.services.pubsub.subscribe(topic);
            debugLogger("INFO: Subscribed to PubSub topic: %s", topic);
            node.services.pubsub.addEventListener('message', handlePubsubMessage);
            updateP2PStatus('PubSub subscribed');
        } catch (pubsubError) {
            debugLogger(`ERROR: Failed to subscribe to PubSub topic:`, pubsubError);
            updateP2PStatus('Error subscribing to PubSub.', true);
        }

        debugLogger("INFO: Starting periodic republishing");
        startRepublishing();
        updateP2PStatus('Ready');
        debugLogger("INFO: Node initialization completed");
        return node;
    } catch (error) {
        debugLogger(`ERROR: Node initialization failed:`, error);
        nodeInitializationStatus = 'failed';
        updateP2PStatus(`Failed to start: ${error.message}`, true);
        node = null;
        throw error;
    }
}

startNodePromise = startNodeInternal();

async function stopNode() {
    debugLogger("INFO: Stopping node");
    if (republishIntervalId) {
        clearInterval(republishIntervalId);
        republishIntervalId = null;
        debugLogger("INFO: Stopped republishing interval");
    }
    if (node && node.status === 'started') {
        try {
            await node.stop();
            debugLogger("INFO: Libp2p node stopped");
            updateP2PStatus('Stopped');
        } catch (error) {
            debugLogger(`ERROR: Error stopping node:`, error);
            updateP2PStatus('Error stopping node', true);
        } finally {
            node = null;
            nodeInitializationStatus = 'idle';
            startNodePromise = null;
            redirectsCache.clear();
            localStorage.removeItem('redirectsCache');
            clearOldRedirectData();
            debugLogger("INFO: Node resources cleaned up");
        }
    } else {
        node = null;
        nodeInitializationStatus = 'idle';
        startNodePromise = null;
        redirectsCache.clear();
        localStorage.removeItem('redirectsCache');
        clearOldRedirectData();
        debugLogger("INFO: Node was not running, cleaned up resources");
    }
}

async function handlePubsubMessage(evt) {
    debugLogger("INFO: Received PubSub message for topic: %s", evt.detail.topic);
    if (evt.detail.topic !== topic) {
        return;
    }

    try {
        const message = JSON.parse(uint8ArrayToString(evt.detail.data));
        debugLogger("INFO: Parsed PubSub message: %o", message);
        if (!message || !message.action || !message.shortCode) {
            debugLogger("WARN: Invalid PubSub message structure: %o", message);
            return;
        }

        const { action, shortCode, redirect } = message;
        debugLogger(`INFO: Handling PubSub action: ${action} for ${shortCode}`);

        switch (action) {
            case 'create':
            case 'update':
                if (redirect && redirect.destinationUrl) {
                    const current = redirectsCache.get(shortCode) || {};
                    redirectsCache.set(shortCode, {
                        ...current,
                        ...redirect,
                        passwordHash: current.passwordHash || redirect.passwordHash
                    });
                    saveRedirectsCacheToLocalStorage();
                    debugLogger(`INFO: [PubSub] Cached ${action}: ${shortCode}`);
                } else {
                    debugLogger(`WARN: [PubSub] Invalid redirect data for ${action}: ${shortCode}`);
                }
                break;
            case 'delete':
                if (redirectsCache.has(shortCode)) {
                    redirectsCache.delete(shortCode);
                    saveRedirectsCacheToLocalStorage();
                    debugLogger(`INFO: [PubSub] Deleted redirect from cache: ${shortCode}`);
                }
                break;
            default:
                debugLogger(`WARN: [PubSub] Unknown action: ${action}`);
        }
    } catch (error) {
        debugLogger(`ERROR: Error handling PubSub message:`, error, `data: ${uint8ArrayToString(evt.detail.data)}`);
    }
}

async function republishActiveRedirects() {
    debugLogger("INFO: Starting republish cycle");
    if (!node || node.status !== 'started') {
        debugLogger("WARN: Node not ready");
        return;
    }
    if (redirectsCache.size === 0) {
        debugLogger("INFO: Republish: No redirects in cache");
        return;
    }
    if (!node.services || !node.services.dht) {
        debugLogger("WARN: DHT not available, skipping republish");
        return;
    }

    debugLogger(`INFO: Republishing ${redirectsCache.size} redirects`);
    let successCount = 0;
    let errorCount = 0;

    for (const [shortCode, redirect] of redirectsCache.entries()) {
        if (shortCode && redirect && redirect.destinationUrl && redirect.passwordHash) {
            const key = `${KEY_PREFIX}${shortCode}`;
            const value = uint8ArrayFromString(JSON.stringify(redirect));
            try {
                await node.services.dht.put(key, value, DHT_PUT_OPTIONS);
                debugLogger(`INFO: Republished redirect: ${shortCode}`);
                successCount++;
            } catch (err) {
                debugLogger(`ERROR: Error republishing redirect ${shortCode}:`, err);
                errorCount++;
            }
        } else {
            debugLogger(`WARN: Skipping invalid cache entry: ${shortCode}, redirect: %o`, redirect);
            redirectsCache.delete(shortCode);
            saveRedirectsCacheToLocalStorage();
        }
    }

    debugLogger(`INFO: Republish cycle finished: ${successCount} successes, ${errorCount} errors`);
}

function startRepublishing() {
    debugLogger("INFO: Starting republishing interval");
    if (republishIntervalId) {
        clearInterval(republishIntervalId);
    }
    republishActiveRedirects();
    republishIntervalId = setInterval(republishActiveRedirects, REPUBLISH_INTERVAL_MS);
}

async function createRedirect(url, description = '') {
    debugLogger("INFO: createRedirect called with: %o", { url, description });
    if (!node || node.status !== 'started') {
        debugLogger("WARN: P2P node not ready, using local mode");
        updateP2PStatus('P2P node not ready, using local mode', true);
    }
    if (!url || typeof url !== 'string' || url.length < 5) {
        debugLogger("ERROR: Invalid URL provided: %s", url);
        throw new Error('Invalid URL provided');
    }

    debugLogger("INFO: Checking network connectivity");
    const connectedPeers = node && node.getPeers ? node.getPeers() : [];
    debugLogger("INFO: Connected peers: %o", connectedPeers.map(p => p.toString()));
    const isIsolated = !node || connectedPeers.length === 0 || !node.services || !node.services.dht;
    if (isIsolated) {
        debugLogger("WARN: No peers connected or node not initialized, using local mode");
        updateP2PStatus('No network connection, using local mode', true);
    }

    let shortCode;
    let attempts = 0;
    let success = false;
    let key;

    updateP2PStatus('Generating unique code...');
    debugLogger("INFO: Starting shortCode generation");
    while (attempts < MAX_SHORTCODE_GENERATION_ATTEMPTS && !success) {
        attempts++;
        shortCode = await generateShortCode(url + Date.now() + Math.random().toString());
        debugLogger(`INFO: Attempt ${attempts} to generate shortCode: ${shortCode}`);
        if (redirectsCache.has(shortCode)) {
            debugLogger(`WARN: Local cache collision for shortCode ${shortCode}`);
            continue;
        }
        key = `${KEY_PREFIX}${shortCode}`;
        if (isIsolated) {
            debugLogger(`INFO: Local mode, skipping DHT check for ${shortCode}`);
            success = true;
            debugLogger(`INFO: Generated unique shortCode ${shortCode} in local mode`);
            continue;
        }
        try {
            debugLogger(`INFO: Querying DHT for key: ${key}`);
            const result = await node.services.dht.get(uint8ArrayFromString(key), { ...DHT_GET_OPTIONS, timeout: 10000 });
            debugLogger(`WARN: DHT collision for shortCode ${shortCode} on attempt ${attempts}: %o`, result);
        } catch (err) {
            if (err.code === 'ERR_NOT_FOUND' || err.message.includes('not found')) {
                debugLogger(`INFO: DHT confirmed no collision for ${shortCode}`);
                success = true;
                debugLogger(`INFO: Generated unique shortCode ${shortCode} on attempt ${attempts}`);
            } else {
                debugLogger(`ERROR: DHT check error for ${shortCode} on attempt ${attempts}:`, {
                    message: err.message,
                    code: err.code,
                    stack: err.stack
                });
                if (attempts >= MAX_SHORTCODE_GENERATION_ATTEMPTS) {
                    debugLogger("WARN: Max attempts reached, assuming shortCode is unique");
                    success = true;
                }
            }
        }
    }

    if (!success) {
        debugLogger("ERROR: Failed to generate unique shortCode after %d attempts", MAX_SHORTCODE_GENERATION_ATTEMPTS);
        throw new Error(`Failed to generate a unique shortCode after ${MAX_SHORTCODE_GENERATION_ATTEMPTS} attempts`);
    }
    updateP2PStatus('Code generated. Creating redirect...');
    debugLogger("INFO: ShortCode generated: %s", shortCode);

    debugLogger("INFO: Generating password");
    const password = generatePassword();
    debugLogger("INFO: Hashing password");
    let passwordHashWithSalt;
    try {
        passwordHashWithSalt = await hashPassword(password);
        debugLogger("INFO: Password hashed successfully");
    } catch (err) {
        debugLogger(`ERROR: Error hashing password:`, err);
        throw err;
    }

    const redirect = {
        shortCode,
        destinationUrl: url,
        description: description || '',
        passwordHash: passwordHashWithSalt,
        createdAt: Date.now()
    };
    debugLogger("INFO: Created redirect object: %o", redirect);

    try {
        debugLogger("INFO: Saving redirect to DHT: %s", key);
        if (!isIsolated && node.services && node.services.dht) {
            await node.services.dht.put(uint8ArrayFromString(key), uint8ArrayFromString(JSON.stringify(redirect)), DHT_PUT_OPTIONS);
            debugLogger(`INFO: Redirect ${shortCode} saved to DHT successfully`);
        } else {
            debugLogger(`INFO: Local mode, skipping DHT save for ${shortCode}`);
        }
        updateP2PStatus('Redirect saved to cache');
        redirectsCache.set(shortCode, redirect);
        saveRedirectsCacheToLocalStorage();
    } catch (error) {
        debugLogger(`ERROR: Error saving redirect ${shortCode}:`, error);
        updateP2PStatus('Error saving redirect', true);
        throw new Error(`Failed to save redirect: ${error.message}`);
    }

    debugLogger("INFO: Publishing create message for: %s", shortCode);
    const safeRedirect = { destinationUrl: redirect.destinationUrl, description: redirect.description, createdAt: redirect.createdAt };
    const message = { action: 'create', shortCode, redirect: safeRedirect };
    try {
        if (!isIsolated && node.services && node.services.pubsub) {
            await node.services.pubsub.publish(topic, uint8ArrayFromString(JSON.stringify(message)));
            debugLogger(`INFO: Published create message for ${shortCode}`);
            updateP2PStatus('Published creation message');
        } else {
            debugLogger(`INFO: Local mode, skipping PubSub publish for ${shortCode}`);
            updateP2PStatus('Skipped network publish in local mode');
        }
    } catch (error) {
        debugLogger(`ERROR: Error publishing create message for ${shortCode}:`, error);
        updateP2PStatus('Error publishing creation message', true);
    }

    debugLogger("INFO: Caching redirect locally: %s", shortCode);
    redirectsCache.set(shortCode, redirect);
    saveRedirectsCacheToLocalStorage();

    updateP2PStatus('Redirect created successfully');
    debugLogger("INFO: createRedirect completed with: %o", { shortCode, password });
    return { shortCode, password };
}

async function getRedirect(shortCode) {
    debugLogger("INFO: getRedirect called with: %s", shortCode);
    if (!shortCode) {
        debugLogger("WARN: getRedirect: Empty shortCode provided");
        return null;
    }
    // Решта функції getRedirect залишається без змін
    // ... (додайте ваш оригінальний код getRedirect, якщо він є)
}

// Експортуємо функції для використання в інших модулях
export { startNodeInternal as startNode, stopNode, createRedirect, getRedirect };
