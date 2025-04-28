import Peer from 'peerjs';
import { createHash } from 'crypto';
import { fromString as uint8ArrayFromString, toString as uint8ArrayToString } from 'uint8arrays';

// Локальний логер
const debugLogger = console.log.bind(console, '[p2p-app]');

// Перевірка середовища
const isBrowser = typeof window !== 'undefined';
const isSecureContext = isBrowser && window.isSecureContext;
const isCryptoAvailable = typeof globalThis.crypto !== 'undefined' && globalThis.crypto.subtle && typeof globalThis.crypto.subtle.digest === 'function';
const isLocalhost = isBrowser && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');
const isHttps = isBrowser && window.location.protocol === 'https:';
debugLogger('INFO: Environment check - Browser: %o, SecureContext: %o, CryptoAvailable: %o, Localhost: %o, HTTPS: %o',
    isBrowser, isSecureContext, isCryptoAvailable, isLocalhost, isHttps);

if (!isHttps && !isLocalhost) {
    debugLogger('WARN: Running on HTTP (not localhost). WebRTC may require HTTPS.');
}

let peer;
const redirectsCache = new Map();
const topic = 'redirects-changes-v3';
const REPUBLISH_INTERVAL_MS = 10 * 60 * 1000;
const MAX_SHORTCODE_GENERATION_ATTEMPTS = 15;
const KEY_PREFIX = '/redirect-p2p/entry/';
let republishIntervalId = null;
let pollingIntervalId = null;
let syncIntervalId = null;
const connections = new Map(); // Зберігаємо DataChannel для кожного піра

// Збереження кешу в localStorage
function saveRedirectsCacheToLocalStorage() {
    try {
        const cacheObject = {};
        for (const [key, value] of redirectsCache) {
            cacheObject[key] = value;
        }
        localStorage.setItem('redirectsCache', JSON.stringify(cacheObject));
        debugLogger('INFO: Saved redirectsCache to localStorage: %o', cacheObject);
    } catch (err) {
        debugLogger('ERROR: Failed to save redirectsCache to localStorage:', err);
    }
}

// Завантаження кешу з localStorage
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
        debugLogger('ERROR: Failed to load redirectsCache from localStorage:', err);
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
        debugLogger('ERROR: Failed to clear old redirect data:', err);
    }
}

clearOldRedirectData();
loadRedirectsCacheFromLocalStorage();

// Ініціалізація PeerJS
async function startNodeInternal() {
    debugLogger('INFO: Starting PeerJS initialization');
    if (peer && peer.open) {
        debugLogger('INFO: Peer already initialized');
        updateP2PStatus('Already started');
        return peer;
    }

    updateP2PStatus('Initializing peer...');
    try {
        const peerId = `p2p-redirect-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const peerConfig = {
            host: isLocalhost ? 'localhost' : 'libp2p.onrender.com',
            port: isLocalhost ? 8080 : 443,
            path: '/peerjs',
            secure: !isLocalhost
        };
        debugLogger('INFO: PeerJS config: %o', peerConfig);

        peer = new Peer(peerId, peerConfig);
        await new Promise((resolve, reject) => {
            peer.on('open', () => {
                debugLogger('INFO: PeerJS initialized with ID: %s', peer.id);
                updateP2PStatus('Peer initialized');
                resolve();
            });
            peer.on('error', (err) => {
                debugLogger('ERROR: PeerJS initialization failed: %o', err);
                updateP2PStatus(`Initialization failed: ${err.message}`, true);
                reject(err);
            });
        });

        // Обробка вхідних з’єднань
        peer.on('connection', (conn) => {
            debugLogger('INFO: Incoming connection from peer: %s', conn.peer);
            setupConnection(conn);
        });

        // Підключення до відомих пірів
        const knownPeers = await fetchKnownPeers();
        for (const peerId of knownPeers) {
            if (peerId !== peer.id) {
                try {
                    const conn = peer.connect(peerId);
                    setupConnection(conn);
                } catch (err) {
                    debugLogger('ERROR: Failed to connect to peer %s: %o', peerId, err);
                }
            }
        }

        // Запуск періодичних операцій
        startRepPublishing();
        startSync();
        startPolling();

        debugLogger('INFO: PeerJS node fully initialized');
        updateP2PStatus('Ready');
        return peer;
    } catch (err) {
        debugLogger('ERROR: Node initialization failed: %o', err);
        updateP2PStatus(`Failed to start: ${err.message}`, true);
        peer = null;
        startPolling();
        throw err;
    }
}

// Налаштування DataChannel
function setupConnection(conn) {
    conn.on('open', () => {
        debugLogger('INFO: DataChannel opened with peer: %s', conn.peer);
        connections.set(conn.peer, conn);
        updateP2PStatus(`Connected to peer: ${conn.peer.substring(0, 10)}...`);

        // Надсилаємо всі локальні редіректи новому піру
        for (const [shortCode, redirect] of redirectsCache) {
            const safeRedirect = {
                destinationUrl: redirect.destinationUrl,
                description: redirect.description,
                createdAt: redirect.createdAt,
                updatedAt: redirect.updatedAt
            };
            const message = { action: 'create', shortCode, redirect: safeRedirect };
            conn.send(JSON.stringify(message));
        }
    });

    conn.on('data', (data) => {
        try {
            const message = JSON.parse(data);
            debugLogger('INFO: Received message from %s: %o', conn.peer, message);
            handleMessage(message);
        } catch (err) {
            debugLogger('ERROR: Failed to parse message from %s: %o', conn.peer, err);
        }
    });

    conn.on('close', () => {
        debugLogger('INFO: DataChannel closed with peer: %s', conn.peer);
        connections.delete(conn.peer);
        updateP2PStatus(`Disconnected from peer: ${conn.peer.substring(0, 10)}...`);
    });

    conn.on('error', (err) => {
        debugLogger('ERROR: DataChannel error with peer %s: %o', conn.peer, err);
    });
}

// Обробка повідомлень
function handleMessage(message) {
    if (!message || !message.action || !message.shortCode) {
        debugLogger('WARN: Invalid message structure: %o', message);
        return;
    }

    const { action, shortCode, redirect } = message;
    debugLogger('INFO: Handling action: %s for %s', action, shortCode);

    switch (action) {
        case 'create':
        case 'update':
            if (redirect && redirect.destinationUrl) {
                const current = redirectsCache.get(shortCode) || {};
                if (!current.updatedAt || (redirect.updatedAt && redirect.updatedAt > current.updatedAt)) {
                    redirectsCache.set(shortCode, {
                        ...current,
                        ...redirect,
                        shortCode,
                        passwordHash: current.passwordHash || redirect.passwordHash
                    });
                    saveRedirectsCacheToLocalStorage();
                    debugLogger('INFO: Cached %s: %s', action, shortCode);
                }
            }
            break;
        case 'delete':
            if (redirectsCache.has(shortCode)) {
                redirectsCache.delete(shortCode);
                saveRedirectsCacheToLocalStorage();
                debugLogger('INFO: Deleted redirect: %s', shortCode);
            }
            break;
        case 'get':
            if (redirectsCache.has(shortCode)) {
                const redirect = redirectsCache.get(shortCode);
                const safeRedirect = {
                    destinationUrl: redirect.destinationUrl,
                    description: redirect.description,
                    createdAt: redirect.createdAt,
                    updatedAt: redirect.updatedAt
                };
                const response = { action: 'get_response', shortCode, redirect: safeRedirect };
                const conn = connections.get(message.from);
                if (conn) {
                    conn.send(JSON.stringify(response));
                }
            }
            break;
        case 'get_response':
            if (redirect && redirect.destinationUrl) {
                redirectsCache.set(shortCode, {
                    ...redirect,
                    shortCode,
                    passwordHash: redirectsCache.get(shortCode)?.passwordHash
                });
                saveRedirectsCacheToLocalStorage();
                debugLogger('INFO: Received redirect %s from peer', shortCode);
            }
            break;
    }
}

// Отримання списку відомих пірів
async function fetchKnownPeers() {
    try {
        const url = isLocalhost ? 'http://localhost:8080/peers' : 'https://libp2p.onrender.com/peers';
        const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
        if (!response.ok) throw new Error(`HTTP error: ${response.status}`);
        const peers = await response.json();
        debugLogger('INFO: Fetched known peers: %o', peers);
        return peers;
    } catch (err) {
        debugLogger('ERROR: Failed to fetch known peers: %o', err);
        return [];
    }
}

// HTTP polling
async function syncRedirectsViaPolling() {
    if (!isHttps && !isLocalhost) {
        debugLogger('WARN: HTTP polling disabled in non-HTTPS environment');
        return;
    }
    try {
        const pollingUrl = isLocalhost ? 'http://localhost:8080/redirects' : 'https://libp2p.onrender.com/redirects';
        debugLogger('INFO: Starting HTTP polling to %s', pollingUrl);
        const response = await fetch(pollingUrl, { signal: AbortSignal.timeout(5000) });
        debugLogger('INFO: Polling response status: %d, headers: %o', response.status, Object.fromEntries(response.headers));
        if (!response.ok) throw new Error(`HTTP error: ${response.status}`);
        const redirects = await response.json();
        debugLogger('INFO: Polling fetched redirects: %o', redirects);
        if (!Array.isArray(redirects) || redirects.length === 0) {
            debugLogger('WARN: No redirects received from polling at %s', pollingUrl);
            updateP2PStatus('No redirects available via polling', true);
            return;
        }
        redirects.forEach(r => {
            if (r.shortCode && r.destinationUrl) {
                redirectsCache.set(r.shortCode, r);
                debugLogger('INFO: Added redirect to cache: %s', r.shortCode);
            }
        });
        saveRedirectsCacheToLocalStorage();
        debugLogger('INFO: Synced %d redirects via HTTP polling', redirects.length);
        updateP2PStatus(`Synced ${redirects.length} redirects via polling`);
    } catch (err) {
        debugLogger('ERROR: Failed to sync redirects via polling: %o', err);
        updateP2PStatus('Failed to sync redirects via polling', true);
    }
}

// Періодична синхронізація
async function syncRedirects() {
    debugLogger('INFO: Starting sync, cache size: %d', redirectsCache.size);
    for (const [shortCode] of redirectsCache) {
        const message = { action: 'get', shortCode, from: peer.id };
        broadcastMessage(message);
    }
}

// Розсилка повідомлення всім пірам
function broadcastMessage(message) {
    for (const [peerId, conn] of connections) {
        try {
            conn.send(JSON.stringify(message));
            debugLogger('INFO: Sent message to %s: %o', peerId, message);
        } catch (err) {
            debugLogger('ERROR: Failed to send message to %s: %o', peerId, err);
        }
    }
}

// Оновлення статусу в UI
function updateP2PStatus(status, isError = false) {
    debugLogger(`INFO: Updating P2P status: ${status}, isError: ${isError}`);
    const statusElement = document.getElementById('p2p-status');
    if (statusElement) {
        statusElement.textContent = `P2P Status: ${status}`;
        statusElement.style.color = isError ? 'red' : 'green';
    }
}

// Запуск polling
function startPolling() {
    if (pollingIntervalId) clearInterval(pollingIntervalId);
    debugLogger('INFO: Starting HTTP polling');
    syncRedirectsViaPolling();
    pollingIntervalId = setInterval(syncRedirectsViaPolling, 5 * 1000);
}

// Запуск синхронізації
function startSync() {
    if (syncIntervalId) clearInterval(syncIntervalId);
    syncRedirects();
    syncIntervalId = setInterval(syncRedirects, 10 * 60 * 1000);
}

// Републікація редіректів
function startRepPublishing() {
    debugLogger('INFO: Starting republishing interval');
    if (republishIntervalId) clearInterval(republishIntervalId);
    republishActiveRedirects();
    republishIntervalId = setInterval(republishActiveRedirects, REPUBLISH_INTERVAL_MS);
}

function republishActiveRedirects() {
    debugLogger('INFO: Starting republish cycle');
    if (redirectsCache.size === 0) {
        debugLogger('INFO: Republish: No redirects in cache');
        return;
    }
    for (const [shortCode, redirect] of redirectsCache) {
        const safeRedirect = {
            destinationUrl: redirect.destinationUrl,
            description: redirect.description,
            createdAt: redirect.createdAt,
            updatedAt: redirect.updatedAt
        };
        const message = { action: 'create', shortCode, redirect: safeRedirect };
        broadcastMessage(message);
    }
    debugLogger('INFO: Republish cycle finished');
}

// CRUD-операції
async function createRedirect(url, description = '') {
    debugLogger('INFO: createRedirect called with: %o', { url, description });
    if (!peer || !peer.open) {
        debugLogger('WARN: Peer not ready, waiting for initialization');
        await startNodeInternal();
    }
    if (!url || typeof url !== 'string' || url.length < 5) {
        debugLogger('ERROR: Invalid URL provided: %s', url);
        throw new Error('Invalid URL provided');
    }

    let shortCode;
    let attempts = 0;
    let success = false;

    updateP2PStatus('Generating unique code...');
    while (attempts < MAX_SHORTCODE_GENERATION_ATTEMPTS && !success) {
        attempts++;
        shortCode = await generateShortCode(url + Date.now() + Math.random().toString());
        debugLogger(`INFO: Attempt ${attempts} to generate shortCode: ${shortCode}`);
        if (redirectsCache.has(shortCode)) {
            debugLogger(`WARN: Local cache collision for shortCode ${shortCode}`);
            continue;
        }
        success = true; // PeerJS не має DHT, тому перевіряємо лише локальний кеш
    }

    if (!success) {
        debugLogger('ERROR: Failed to generate unique shortCode after %d attempts', MAX_SHORTCODE_GENERATION_ATTEMPTS);
        throw new Error(`Failed to generate a unique shortCode after ${MAX_SHORTCODE_GENERATION_ATTEMPTS} attempts`);
    }

    updateP2PStatus('Code generated. Creating redirect...');
    const password = generatePassword();
    const passwordHashWithSalt = await hashPassword(password);

    const redirect = {
        shortCode,
        destinationUrl: url,
        description: description || '',
        passwordHash: passwordHashWithSalt,
        createdAt: Date.now(),
        updatedAt: Date.now()
    };

    redirectsCache.set(shortCode, redirect);
    saveRedirectsCacheToLocalStorage();

    const safeRedirect = {
        destinationUrl: redirect.destinationUrl,
        description: redirect.description,
        createdAt: redirect.createdAt,
        updatedAt: redirect.updatedAt
    };
    const message = { action: 'create', shortCode, redirect: safeRedirect };
    broadcastMessage(message);

    updateP2PStatus('Redirect created successfully');
    return { shortCode, password };
}

async function getRedirect(shortCode) {
    debugLogger('INFO: getRedirect called with: %s', shortCode);
    if (!shortCode) {
        debugLogger('WARN: getRedirect: Empty shortCode provided');
        return null;
    }
    if (!peer || !peer.open) {
        await startNodeInternal();
    }

    if (redirectsCache.has(shortCode)) {
        debugLogger(`INFO: getRedirect: Found ${shortCode} in cache`);
        updateP2PStatus(`Redirect ${shortCode} found in cache`);
        return redirectsCache.get(shortCode);
    }

    updateP2PStatus(`Querying network for ${shortCode}...`);
    const message = { action: 'get', shortCode, from: peer.id };
    broadcastMessage(message);

    // Чекаємо відповідь (з таймаутом 5 секунд)
    return new Promise((resolve) => {
        const timeout = setTimeout(() => {
            debugLogger(`WARN: getRedirect: No response for ${shortCode}`);
            updateP2PStatus(`Redirect ${shortCode} not found`, true);
            resolve(null);
        }, 5000);

        const handler = (msg) => {
            if (msg.action === 'get_response' && msg.shortCode === shortCode) {
                clearTimeout(timeout);
                resolve(redirectsCache.get(shortCode));
            }
        };

        for (const [, conn] of connections) {
            conn.on('data', (data) => {
                try {
                    const msg = JSON.parse(data);
                    handler(msg);
                } catch (err) {}
            });
        }
    });
}

async function updateRedirect(shortCode, newUrl, newDescription, redirectPassword) {
    debugLogger('INFO: updateRedirect called with: %o', { shortCode, newUrl, newDescription });
    if (!peer || !peer.open) {
        await startNodeInternal();
    }
    if (!newUrl || typeof newUrl !== 'string' || newUrl.length < 5) {
        debugLogger('ERROR: Invalid new URL: %s', newUrl);
        throw new Error('Invalid new URL provided');
    }

    updateP2PStatus(`Attempting to update ${shortCode}...`);
    const stored = await getRedirect(shortCode);
    if (!stored) {
        debugLogger(`ERROR: Redirect ${shortCode} not found`);
        updateP2PStatus(`Update failed: Redirect ${shortCode} not found`, true);
        throw new Error('Redirect not found');
    }

    const isValidPassword = await verifyRedirectPassword(redirectPassword, stored.passwordHash);
    if (!isValidPassword) {
        debugLogger(`ERROR: Incorrect password for ${shortCode}`);
        updateP2PStatus(`Update failed: Incorrect password for ${shortCode}`, true);
        throw new Error('Incorrect redirect password');
    }

    const updatedRedirect = {
        ...stored,
        destinationUrl: newUrl,
        description: newDescription !== undefined ? newDescription : stored.description,
        updatedAt: Date.now()
    };

    redirectsCache.set(shortCode, updatedRedirect);
    saveRedirectsCacheToLocalStorage();

    const safeRedirect = {
        destinationUrl: updatedRedirect.destinationUrl,
        description: updatedRedirect.description,
        updatedAt: updatedRedirect.updatedAt
    };
    const message = { action: 'update', shortCode, redirect: safeRedirect };
    broadcastMessage(message);

    updateP2PStatus(`Redirect ${shortCode} updated successfully`);
    return { success: true };
}

async function deleteRedirect(shortCode, redirectPassword) {
    debugLogger('INFO: deleteRedirect called with: %o', { shortCode });
    if (!peer || !peer.open) {
        await startNodeInternal();
    }

    updateP2PStatus(`Attempting to delete ${shortCode}...`);
    const stored = redirectsCache.get(shortCode) || await getRedirect(shortCode);
    if (!stored) {
        debugLogger(`WARN: Redirect ${shortCode} not found`);
        updateP2PStatus(`Deletion skipped: Redirect ${shortCode} not found`);
        return { success: true, message: 'Redirect not found' };
    }

    const isValidPassword = await verifyRedirectPassword(redirectPassword, stored.passwordHash);
    if (!isValidPassword) {
        debugLogger(`ERROR: Incorrect password for ${shortCode}`);
        updateP2PStatus(`Deletion failed: Incorrect password for ${shortCode}`, true);
        throw new Error('Incorrect redirect password');
    }

    redirectsCache.delete(shortCode);
    saveRedirectsCacheToLocalStorage();

    const message = { action: 'delete', shortCode };
    broadcastMessage(message);

    updateP2PStatus(`Redirect ${shortCode} deleted successfully`);
    return { success: true };
}

function getLocalRedirects(searchQuery = '') {
    debugLogger('INFO: getLocalRedirects called with query: %s', searchQuery);
    const query = searchQuery.toLowerCase().trim();
    const allCached = Array.from(redirectsCache.values());
    debugLogger('INFO: Cached redirects: %o', allCached);

    if (!query) {
        return allCached;
    }

    const filtered = allCached.filter(r =>
        (r.shortCode && r.shortCode.toLowerCase().includes(query)) ||
        (r.description && r.description.toLowerCase().includes(query)) ||
        (r.destinationUrl && r.destinationUrl.toLowerCase().includes(query))
    );
    debugLogger('INFO: Filtered redirects: %o', filtered);
    return filtered;
}

function generatePassword(length = 12) {
    const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let password = '';
    if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.getRandomValues) {
        const values = new Uint32Array(length);
        globalThis.crypto.getRandomValues(values);
        for (let i = 0; i < length; i++) {
            password += charset[values[i] % charset.length];
        }
    } else {
        for (let i = 0; i < length; i++) {
            password += charset.charAt(Math.floor(Math.random() * charset.length));
        }
    }
    debugLogger('INFO: Generated password: %s', password);
    return password;
}

function generateSalt(length = 16) {
    if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.getRandomValues) {
        const values = new Uint8Array(length);
        globalThis.crypto.getRandomValues(values);
        const salt = Array.from(values, byte => byte.toString(16).padStart(2, '0')).join('');
        debugLogger('INFO: Generated salt: %s', salt);
        return salt;
    } else {
        let salt = '';
        for (let i = 0; i < length * 2; i++) {
            salt += Math.floor(Math.random() * 16).toString(16);
        }
        debugLogger('INFO: Generated salt: %s', salt);
        return salt;
    }
}

async function hashPassword(password, salt = null) {
    const currentSalt = salt || generateSalt();
    if (isCryptoAvailable) {
        const encoder = new TextEncoder();
        const data = encoder.encode(password + currentSalt);
        const hashBuffer = await globalThis.crypto.subtle.digest('SHA-256', data);
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

async function verifyRedirectPassword(providedPassword, storedSaltAndHash) {
    if (!providedPassword || !storedSaltAndHash || !storedSaltAndHash.includes(':')) {
        debugLogger('WARN: Invalid input or hash format for password verification');
        return false;
    }
    const [salt, storedHash] = storedSaltAndHash.split(':');
    if (!salt || !storedHash) {
        debugLogger('WARN: Could not parse salt and hash');
        return false;
    }
    const providedHashWithStoredSalt = await hashPassword(providedPassword, salt);
    return providedHashWithStoredSalt === storedSaltAndHash;
}

async function generateShortCode(inputString) {
    if (isCryptoAvailable) {
        const encoder = new TextEncoder();
        const data = encoder.encode(inputString);
        const hashBuffer = await globalThis.crypto.subtle.digest('SHA-256', data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
        return hashHex.slice(0, 10);
    } else {
        const hash = createHash('sha256');
        hash.update(inputString);
        const hashHex = hash.digest('hex');
        return hashHex.slice(0, 10);
    }
}

// Дебаг
window.debugNodeStatus = () => {
    console.log('Node Status:', {
        initialized: !!peer,
        peerId: peer?.id || 'unknown',
        connections: Array.from(connections.keys()),
        cacheSize: redirectsCache.size
    });
};

window.testP2P = {
    getPeers: () => Array.from(connections.keys()),
    getStatus: () => window.debugNodeStatus(),
    discoverPeers: async () => {
        const peers = await fetchKnownPeers();
        for (const peerId of peers) {
            if (peerId !== peer.id && !connections.has(peerId)) {
                try {
                    const conn = peer.connect(peerId);
                    setupConnection(conn);
                } catch (err) {
                    console.error(`Failed to connect to ${peerId}:`, err);
                }
            }
        }
    }
};

const startNodePromise = startNodeInternal();

// Визначаємо stopNode окремо
async function stopNode() {
    if (peer) {
        peer.destroy();
        peer = null;
        connections.clear();
        redirectsCache.clear();
        localStorage.removeItem('redirectsCache');
        clearOldRedirectData();
        if (pollingIntervalId) clearInterval(pollingIntervalId);
        if (syncIntervalId) clearInterval(syncIntervalId);
        if (republishIntervalId) clearInterval(republishIntervalId);
        updateP2PStatus('Stopped');
    }
}

// Експортуємо всі функції
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
