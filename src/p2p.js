import Peer from 'peerjs';
import { Buffer } from 'buffer';
import { createHash } from 'crypto-browserify';
import { fromString as uint8ArrayFromString, toString as uint8ArrayToString } from 'uint8arrays';

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

const debugLogger = console.log.bind(console, '[p2p-app]');
const isProduction = process.env.NODE_ENV === 'production';
const isBrowser = typeof window !== 'undefined';
const isLocalhost = isBrowser && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');
const isHttps = isBrowser && window.location.protocol === 'https:';
const BASE_URL = isLocalhost ? 'http://localhost:8080' : 'https://libp2p.onrender.com';

debugLogger('INFO: Environment - Browser: %o, Localhost: %o, HTTPS: %o, BASE_URL: %s',
    isBrowser, isLocalhost, isHttps, BASE_URL);

if (!isHttps && !isLocalhost) {
    debugLogger('WARN: Running on HTTP (not localhost). WebRTC may require HTTPS.');
}

let peer = null;
const redirectsCache = new Map();
const connections = new Map();
const MAX_CACHE_SIZE = 200; // Зменшено для Render
const MAX_CONNECTIONS = 50;
let pollingIntervalId = null;
let syncIntervalId = null;
let republishIntervalId = null;

function pruneCacheIfNeeded() {
    if (redirectsCache.size > MAX_CACHE_SIZE) {
        const keys = Array.from(redirectsCache.keys()).slice(0, redirectsCache.size - MAX_CACHE_SIZE);
        for (const key of keys) {
            redirectsCache.delete(key);
        }
        debugLogger('INFO: Pruned redirectsCache to %d entries', redirectsCache.size);
        saveRedirectsCacheToLocalStorage();
    }
}

function saveRedirectsCacheToLocalStorage() {
    try {
        const cacheObject = Object.fromEntries(redirectsCache);
        localStorage.setItem('redirectsCache', JSON.stringify(cacheObject));
        debugLogger('INFO: Saved redirectsCache to localStorage');
    } catch (err) {
        debugLogger('ERROR: Failed to save redirectsCache:', err);
    }
}

function loadRedirectsCacheFromLocalStorage() {
    try {
        const cacheData = localStorage.getItem('redirectsCache');
        if (cacheData) {
            const cacheObject = JSON.parse(cacheData);
            for (const key in cacheObject) {
                redirectsCache.set(key, cacheObject[key]);
            }
            pruneCacheIfNeeded();
            debugLogger('INFO: Loaded redirectsCache from localStorage');
        }
    } catch (err) {
        debugLogger('ERROR: Failed to load redirectsCache:', err);
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
        debugLogger('ERROR: Failed to clear old redirect data:', err);
    }
}

clearOldRedirectData();
loadRedirectsCacheFromLocalStorage();

async function startNodeInternal() {
    debugLogger('INFO: Starting PeerJS');
    if (peer && peer.open) {
        debugLogger('INFO: Peer already initialized');
        updateP2PStatus('Already started');
        return peer;
    }

    updateP2PStatus('Initializing peer...');
    const peerConfig = {
        host: isLocalhost ? 'localhost' : 'libp2p.onrender.com',
        path: '/peerjs-server',
        secure: isHttps, // Використовуємо wss:// для HTTPS (isHttps визначено як window.location.protocol === 'https:')
        debug: 3,
        pingInterval: 5000
    };

    if (isLocalhost) {
        try {
            const response = await fetch(`${BASE_URL}/port`, { signal: AbortSignal.timeout(5000) });
            if (response.ok) {
                const data = await response.json();
                peerConfig.port = data.port || 8080;
                debugLogger('INFO: Fetched port: %d', peerConfig.port);
            }
        } catch (err) {
            debugLogger('WARN: Failed to fetch port, using 8080:', err);
            peerConfig.port = 8080;
        }
    } else {
        // На продакшені не вказуємо порт, бо Render використовує 443 для HTTPS
        delete peerConfig.port;
    }

    debugLogger('INFO: PeerJS config:', peerConfig);
    const peerId = `p2p-redirect-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    peer = new Peer(peerId, peerConfig);

    await new Promise((resolve, reject) => {
        peer.on('open', () => {
            debugLogger('INFO: PeerJS initialized with ID:', peer.id);
            updateP2PStatus('Peer initialized');
            resolve();
        });
        peer.on('error', (err) => {
            debugLogger('ERROR: PeerJS initialization failed:', err);
            updateP2PStatus(`Initialization failed: ${err.message}`, true);
            reject(err);
        });
    });

    peer.on('connection', (conn) => {
        debugLogger('INFO: Incoming connection from:', conn.peer);
        setupConnection(conn);
    });

    const knownPeers = await fetchKnownPeers();
    for (const peerId of knownPeers) {
        if (peerId !== peer.id && connections.size < MAX_CONNECTIONS) {
            try {
                const conn = peer.connect(peerId);
                setupConnection(conn);
            } catch (err) {
                debugLogger('ERROR: Failed to connect to peer:', peerId, err);
            }
        }
    }

    startPolling();
    startSync();
    startRepublishing();
    debugLogger('INFO: PeerJS node initialized');
    updateP2PStatus('Ready');
    return peer;
}

function setupConnection(conn) {
    if (connections.size >= MAX_CONNECTIONS) {
        debugLogger('WARN: Max connections reached, rejecting:', conn.peer);
        conn.close();
        return;
    }

    connections.set(conn.peer, conn);
    conn.on('open', () => {
        debugLogger('INFO: DataChannel opened with:', conn.peer);
        updateP2PStatus(`Connected to peer: ${conn.peer.slice(0, 10)}...`);
        for (const [shortCode, redirect] of redirectsCache) {
            const safeRedirect = {
                destinationUrl: redirect.destinationUrl,
                description: redirect.description,
                createdAt: redirect.createdAt,
                updatedAt: redirect.updatedAt
            };
            const message = { action: 'create', shortCode, redirect: safeRedirect };
            try {
                conn.send(JSON.stringify(message));
            } catch (err) {
                debugLogger('ERROR: Failed to send redirect to:', conn.peer, err);
            }
        }
    });

    conn.on('data', (data) => {
        try {
            const message = JSON.parse(data);
            debugLogger('INFO: Received message from:', conn.peer, message);
            handleMessage(message);
        } catch (err) {
            debugLogger('ERROR: Failed to parse message from:', conn.peer, err);
        }
    });

    conn.on('close', () => {
        debugLogger('INFO: DataChannel closed with:', conn.peer);
        connections.delete(conn.peer);
        updateP2PStatus(`Disconnected from peer: ${conn.peer.slice(0, 10)}...`);
    });

    conn.on('error', (err) => {
        debugLogger('ERROR: DataChannel error with:', conn.peer, err);
        connections.delete(conn.peer);
    });
}

function handleMessage(message) {
    if (!message || !message.action || !message.shortCode) {
        debugLogger('WARN: Invalid message:', message);
        return;
    }

    const { action, shortCode, redirect } = message;
    debugLogger('INFO: Handling:', action, shortCode);

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
                    pruneCacheIfNeeded();
                    saveRedirectsCacheToLocalStorage();
                    debugLogger('INFO: Cached:', action, shortCode);
                }
            }
            break;
        case 'delete':
            if (redirectsCache.has(shortCode)) {
                redirectsCache.delete(shortCode);
                saveRedirectsCacheToLocalStorage();
                debugLogger('INFO: Deleted redirect:', shortCode);
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
                    try {
                        conn.send(JSON.stringify(response));
                    } catch (err) {
                        debugLogger('ERROR: Failed to send get_response:', message.from, err);
                    }
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
                pruneCacheIfNeeded();
                saveRedirectsCacheToLocalStorage();
                debugLogger('INFO: Received redirect:', shortCode);
            }
            break;
    }
}

async function fetchKnownPeers() {
    try {
        const response = await fetch(`${BASE_URL}/peers`, { signal: AbortSignal.timeout(5000) });
        if (!response.ok) throw new Error(`HTTP error: ${response.status}`);
        const peers = await response.json();
        debugLogger('INFO: Fetched peers:', peers);
        return peers;
    } catch (err) {
        debugLogger('ERROR: Failed to fetch peers:', err);
        return [];
    }
}

async function syncRedirectsViaPolling() {
    try {
        const response = await fetch(`${BASE_URL}/redirects`, { signal: AbortSignal.timeout(5000) });
        if (!response.ok) throw new Error(`HTTP error: ${response.status}`);
        const redirects = await response.json();
        if (!Array.isArray(redirects)) {
            debugLogger('WARN: Invalid redirects response');
            return;
        }
        redirects.forEach(r => {
            if (r.shortCode && r.destinationUrl) {
                redirectsCache.set(r.shortCode, r);
            }
        });
        pruneCacheIfNeeded();
        saveRedirectsCacheToLocalStorage();
        debugLogger('INFO: Synced redirects:', redirects.length);
        updateP2PStatus(`Synced ${redirects.length} redirects`);
    } catch (err) {
        debugLogger('ERROR: Failed to sync redirects:', err);
        updateP2PStatus('Failed to sync redirects', true);
    }
}

async function syncRedirects() {
    debugLogger('INFO: Syncing redirects');
    for (const [shortCode] of redirectsCache) {
        const message = { action: 'get', shortCode, from: peer.id };
        broadcastMessage(message);
    }
}

function broadcastMessage(message) {
    for (const [peerId, conn] of connections) {
        try {
            conn.send(JSON.stringify(message));
            debugLogger('INFO: Sent to:', peerId, message);
        } catch (err) {
            debugLogger('ERROR: Failed to send to:', peerId, err);
        }
    }
}

function updateP2PStatus(status, isError = false) {
    debugLogger(`INFO: P2P status: ${status}, isError: ${isError}`);
    const statusElement = document.getElementById('p2p-status');
    if (statusElement) {
        statusElement.textContent = `P2P Status: ${status}`;
        statusElement.style.color = isError ? 'red' : 'green';
    }
}

function startPolling() {
    if (pollingIntervalId) clearInterval(pollingIntervalId);
    debugLogger('INFO: Starting polling');
    syncRedirectsViaPolling();
    pollingIntervalId = setInterval(syncRedirectsViaPolling, 10 * 1000); // Збільшено інтервал
}

function startSync() {
    if (syncIntervalId) clearInterval(syncIntervalId);
    syncRedirects();
    syncIntervalId = setInterval(syncRedirects, 15 * 60 * 1000); // Збільшено інтервал
}

function startRepublishing() {
    if (republishIntervalId) clearInterval(republishIntervalId);
    debugLogger('INFO: Starting republishing');
    republishActiveRedirects();
    republishIntervalId = setInterval(republishActiveRedirects, 15 * 60 * 1000); // Збільшено інтервал
}

function republishActiveRedirects() {
    debugLogger('INFO: Republishing redirects');
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
}

async function createRedirect(url, description = '') {
    debugLogger('INFO: Creating redirect:', url, description);
    if (!url || typeof url !== 'string' || url.length < 5) {
        throw new Error('Invalid URL');
    }

    updateP2PStatus('Generating code...');
    let shortCode;
    for (let i = 0; i < 15; i++) {
        shortCode = await generateShortCode(url + Date.now() + Math.random());
        if (!redirectsCache.has(shortCode)) break;
        if (i === 14) throw new Error('Failed to generate unique shortCode');
    }

    updateP2PStatus('Creating redirect...');
    const password = generatePassword();
    const passwordHash = await hashPassword(password);

    const redirect = {
        shortCode,
        destinationUrl: url,
        description: description || '',
        passwordHash,
        createdAt: Date.now(),
        updatedAt: Date.now()
    };

    try {
        const response = await fetch(`${BASE_URL}/redirects`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(redirect)
        });
        if (!response.ok) throw new Error(`HTTP error: ${response.status}`);
        redirectsCache.set(shortCode, redirect);
        pruneCacheIfNeeded();
        saveRedirectsCacheToLocalStorage();
        debugLogger('INFO: Created redirect via HTTP:', shortCode);
    } catch (err) {
        debugLogger('ERROR: Failed to create redirect via HTTP:', err);
    }

    if (peer && peer.open) {
        redirectsCache.set(shortCode, redirect);
        pruneCacheIfNeeded();
        saveRedirectsCacheToLocalStorage();
        const safeRedirect = {
            destinationUrl: redirect.destinationUrl,
            description: redirect.description,
            createdAt: redirect.createdAt,
            updatedAt: redirect.updatedAt
        };
        broadcastMessage({ action: 'create', shortCode, redirect: safeRedirect });
    }

    updateP2PStatus('Redirect created');
    return { shortCode, password };
}

async function getRedirect(shortCode) {
    debugLogger('INFO: Getting redirect:', shortCode);
    if (redirectsCache.has(shortCode)) {
        updateP2PStatus(`Redirect ${shortCode} found in cache`);
        return redirectsCache.get(shortCode);
    }

    try {
        const response = await fetch(`${BASE_URL}/redirects`, { signal: AbortSignal.timeout(5000) });
        if (!response.ok) throw new Error(`HTTP error: ${response.status}`);
        const redirects = await response.json();
        const redirect = redirects.find(r => r.shortCode === shortCode);
        if (redirect) {
            redirectsCache.set(shortCode, redirect);
            pruneCacheIfNeeded();
            saveRedirectsCacheToLocalStorage();
            updateP2PStatus(`Redirect ${shortCode} found via server`);
            return redirect;
        }
    } catch (err) {
        debugLogger('ERROR: Failed to get redirect via HTTP:', err);
    }

    if (peer && peer.open) {
        updateP2PStatus(`Querying network for ${shortCode}...`);
        const message = { action: 'get', shortCode, from: peer.id };
        broadcastMessage(message);

        return new Promise((resolve) => {
            const timeout = setTimeout(() => {
                updateP2PStatus(`Redirect ${shortCode} not found`, true);
                resolve(null);
            }, 5000);

            const handler = (data) => {
                try {
                    const msg = JSON.parse(data);
                    if (msg.action === 'get_response' && msg.shortCode === shortCode) {
                        clearTimeout(timeout);
                        resolve(redirectsCache.get(shortCode));
                    }
                } catch (err) {
                    debugLogger('ERROR: Failed to parse get_response:', err);
                }
            };

            for (const [, conn] of connections) {
                conn.removeAllListeners('data');
                conn.on('data', handler);
            }
        });
    }

    updateP2PStatus(`Redirect ${shortCode} not found`, true);
    return null;
}

async function updateRedirect(shortCode, newUrl, newDescription, redirectPassword) {
    debugLogger('INFO: Updating redirect:', shortCode, newUrl, newDescription);
    if (!newUrl || typeof newUrl !== 'string' || newUrl.length < 5) {
        throw new Error('Invalid URL');
    }

    updateP2PStatus(`Updating ${shortCode}...`);
    const stored = await getRedirect(shortCode);
    if (!stored) {
        updateP2PStatus(`Update failed: Redirect ${shortCode} not found`, true);
        throw new Error('Redirect not found');
    }

    const isValidPassword = await verifyRedirectPassword(redirectPassword, stored.passwordHash);
    if (!isValidPassword) {
        updateP2PStatus(`Update failed: Incorrect password`, true);
        throw new Error('Incorrect password');
    }

    const updatedRedirect = {
        ...stored,
        destinationUrl: newUrl,
        description: newDescription !== undefined ? newDescription : stored.description,
        updatedAt: Date.now()
    };

    try {
        const response = await fetch(`${BASE_URL}/redirects/${shortCode}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ destinationUrl: newUrl, description: newDescription })
        });
        if (!response.ok) throw new Error(`HTTP error: ${response.status}`);
        redirectsCache.set(shortCode, updatedRedirect);
        pruneCacheIfNeeded();
        saveRedirectsCacheToLocalStorage();
        debugLogger('INFO: Updated redirect via HTTP:', shortCode);
    } catch (err) {
        debugLogger('ERROR: Failed to update redirect via HTTP:', err);
    }

    if (peer && peer.open) {
        redirectsCache.set(shortCode, updatedRedirect);
        pruneCacheIfNeeded();
        saveRedirectsCacheToLocalStorage();
        const safeRedirect = {
            destinationUrl: updatedRedirect.destinationUrl,
            description: updatedRedirect.description,
            updatedAt: updatedRedirect.updatedAt
        };
        broadcastMessage({ action: 'update', shortCode, redirect: safeRedirect });
    }

    updateP2PStatus(`Redirect ${shortCode} updated`);
    return { success: true };
}

async function deleteRedirect(shortCode, redirectPassword) {
    debugLogger('INFO: Deleting redirect:', shortCode);
    updateP2PStatus(`Deleting ${shortCode}...`);
    const stored = redirectsCache.get(shortCode) || await getRedirect(shortCode);
    if (!stored) {
        updateP2PStatus(`Redirect ${shortCode} not found`);
        return { success: true, message: 'Redirect not found' };
    }

    const isValidPassword = await verifyRedirectPassword(redirectPassword, stored.passwordHash);
    if (!isValidPassword) {
        updateP2PStatus(`Deletion failed: Incorrect password`, true);
        throw new Error('Incorrect password');
    }

    try {
        const response = await fetch(`${BASE_URL}/redirects/${shortCode}`, { method: 'DELETE' });
        if (!response.ok && response.status !== 404) throw new Error(`HTTP error: ${response.status}`);
        redirectsCache.delete(shortCode);
        saveRedirectsCacheToLocalStorage();
        debugLogger('INFO: Deleted redirect via HTTP:', shortCode);
    } catch (err) {
        debugLogger('ERROR: Failed to delete redirect via HTTP:', err);
    }

    if (peer && peer.open) {
        redirectsCache.delete(shortCode);
        saveRedirectsCacheToLocalStorage();
        broadcastMessage({ action: 'delete', shortCode });
    }

    updateP2PStatus(`Redirect ${shortCode} deleted`);
    return { success: true };
}

function getLocalRedirects(searchQuery = '') {
    debugLogger('INFO: Getting local redirects:', searchQuery);
    const query = searchQuery.toLowerCase().trim();
    const allCached = Array.from(redirectsCache.values());

    if (!query) return allCached;

    return allCached.filter(r =>
        (r.shortCode && r.shortCode.toLowerCase().includes(query)) ||
        (r.description && r.description.toLowerCase().includes(query)) ||
        (r.destinationUrl && r.destinationUrl.toLowerCase().includes(query))
    );
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
    debugLogger('INFO: Generated password');
    return password;
}

function generateSalt(length = 16) {
    if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.getRandomValues) {
        const values = new Uint8Array(length);
        globalThis.crypto.getRandomValues(values);
        return Array.from(values, byte => byte.toString(16).padStart(2, '0')).join('');
    }
    let salt = '';
    for (let i = 0; i < length * 2; i++) {
        salt += Math.floor(Math.random() * 16).toString(16);
    }
    debugLogger('INFO: Generated salt');
    return salt;
}

async function hashPassword(password, salt = null) {
    const currentSalt = salt || generateSalt();
    const encoder = new TextEncoder();
    const data = encoder.encode(password + currentSalt);
    const hashBuffer = await globalThis.crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    return `${currentSalt}:${hashHex}`;
}

async function verifyRedirectPassword(providedPassword, storedSaltAndHash) {
    if (!providedPassword || !storedSaltAndHash || !storedSaltAndHash.includes(':')) {
        debugLogger('WARN: Invalid password or hash');
        return false;
    }
    const [salt, storedHash] = storedSaltAndHash.split(':');
    const providedHashWithStoredSalt = await hashPassword(providedPassword, salt);
    return providedHashWithStoredSalt === storedSaltAndHash;
}

async function generateShortCode(inputString) {
    const encoder = new TextEncoder();
    const data = encoder.encode(inputString);
    const hashBuffer = await globalThis.crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    return hashHex.slice(0, 10);
}

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
            if (peerId !== peer.id && !connections.has(peerId) && connections.size < MAX_CONNECTIONS) {
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
