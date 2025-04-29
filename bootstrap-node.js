import express from 'express';
import cors from 'cors';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import { generateShortCode, generatePassword, hashPassword, verifyRedirectPassword } from './src/utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const db = new Database('redirects.db');
const PORT = process.env.PORT || 8080;

// Налаштування довіри до одного рівня проксі (для Render)
app.set('trust proxy', 1);

// Ініціалізація бази даних
db.exec(`
    CREATE TABLE IF NOT EXISTS redirects (
        short_code VARCHAR(8) PRIMARY KEY,
        destination_url TEXT NOT NULL,
        description TEXT,
        password_hash TEXT,
        created_at INTEGER,
        updated_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_short_code ON redirects(short_code);
`);

// Middleware
app.use(compression());
app.use(cors({
    origin: ['https://libp2p.onrender.com', 'http://localhost:8080', 'http://localhost:3000'],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type']
}));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/r/', rateLimit({
    windowMs: 15 * 60 * 1000, // 15 хвилин
    max: 100 // 100 запитів на IP
}));

// Маршрути
app.get('/', (req, res) => {
    res.sendFile('index.html', { root: 'public' });
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
});

app.get('/r/:shortCode', (req, res) => {
    const { shortCode } = req.params;
    console.log(`Processing redirect for shortCode: ${shortCode}`);
    const redirect = db.prepare('SELECT destination_url FROM redirects WHERE short_code = ?').get(shortCode);
    if (redirect) {
        console.log(`Redirecting to: ${redirect.destination_url}`);
        res.redirect(redirect.destination_url);
    } else {
        console.log(`Redirect not found for shortCode: ${shortCode}`);
        res.status(404).send('Redirect not found');
    }
});

app.get('/redirects', (req, res) => {
    const search = req.query.search?.toLowerCase() || '';
    console.log(`Fetching redirects with search: ${search}`);
    const redirects = db.prepare(`
        SELECT short_code, destination_url, description, created_at, updated_at
        FROM redirects
        WHERE short_code LIKE ? OR destination_url LIKE ? OR description LIKE ?
    `).all(`%${search}%`, `%${search}%`, `%${search}%`);
    // Перетворюємо short_code на shortCode, destination_url на destinationUrl
    const formattedRedirects = redirects.map(r => ({
        shortCode: r.short_code,
        destinationUrl: r.destination_url,
        description: r.description,
        createdAt: r.created_at,
        updatedAt: r.updated_at
    }));
    console.log('Redirects fetched:', formattedRedirects);
    res.json(formattedRedirects);
});

app.post('/redirects', async (req, res) => {
    console.log('Received POST /redirects:', req.body);
    const { destinationUrl, description } = req.body;
    if (!destinationUrl) {
        console.log('Missing destinationUrl');
        return res.status(400).json({ error: 'Missing destinationUrl' });
    }
    let shortCode;
    for (let i = 0; i < 15; i++) {
        shortCode = await generateShortCode(destinationUrl + Date.now() + Math.random());
        if (!db.prepare('SELECT 1 FROM redirects WHERE short_code = ?').get(shortCode)) break;
        if (i === 14) {
            console.log('Failed to generate unique shortCode');
            return res.status(500).json({ error: 'Failed to generate unique shortCode' });
        }
    }
    const password = generatePassword();
    const passwordHash = await hashPassword(password);
    try {
        db.prepare(`
            INSERT INTO redirects (short_code, destination_url, description, password_hash, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(shortCode, destinationUrl, description || '', passwordHash, Date.now(), Date.now());
        console.log(`Created redirect: /r/${shortCode}`);
        res.json({ shortCode, password });
    } catch (err) {
        console.error('Error creating redirect:', err);
        res.status(500).json({ error: 'Failed to create redirect' });
    }
});

app.put('/redirects/:shortCode', async (req, res) => {
    const { shortCode } = req.params;
    const { destinationUrl, description, password } = req.body;
    console.log(`Updating redirect: /r/${shortCode}`, { destinationUrl, description });
    const redirect = db.prepare('SELECT password_hash FROM redirects WHERE short_code = ?').get(shortCode);
    if (!redirect) {
        console.log(`Redirect not found: /r/${shortCode}`);
        return res.status(404).json({ error: 'Redirect not found' });
    }
    const isValid = await verifyRedirectPassword(password, redirect.password_hash);
    if (!isValid) {
        console.log('Incorrect password');
        return res.status(401).json({ error: 'Incorrect password' });
    }
    try {
        db.prepare(`
            UPDATE redirects
            SET destination_url = ?, description = ?, updated_at = ?
            WHERE short_code = ?
        `).run(destinationUrl, description || '', Date.now(), shortCode);
        console.log(`Updated redirect: /r/${shortCode}`);
        res.json({ success: true });
    } catch (err) {
        console.error('Error updating redirect:', err);
        res.status(500).json({ error: 'Failed to update redirect' });
    }
});

app.delete('/redirects/:shortCode', async (req, res) => {
    const { shortCode } = req.params;
    const { password } = req.body;
    console.log(`Deleting redirect: /r/${shortCode}`);
    const redirect = db.prepare('SELECT password_hash FROM redirects WHERE short_code = ?').get(shortCode);
    if (!redirect) {
        console.log(`Redirect not found: /r/${shortCode}`);
        return res.json({ success: true, message: 'Redirect not found' });
    }
    const isValid = await verifyRedirectPassword(password, redirect.password_hash);
    if (!isValid) {
        console.log('Incorrect password');
        return res.status(401).json({ error: 'Incorrect password' });
    }
    try {
        db.prepare('DELETE FROM redirects WHERE short_code = ?').run(shortCode);
        console.log(`Deleted redirect: /r/${shortCode}`);
        res.json({ success: true });
    } catch (err) {
        console.error('Error deleting redirect:', err);
        res.status(500).json({ error: 'Failed to delete redirect' });
    }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
