import { startNodePromise, getRedirect } from './p2p.js';

// Дебаг імпорту
console.log('DEBUG: Imports in p2p-app-src.js:', {
    startNodePromise: !!startNodePromise,
    getRedirect: typeof getRedirect
});

// Показує повідомлення в UI
function showMessage(statusDiv, text, type = 'info') {
    console.log('DEBUG: Showing message:', text, 'Type:', type);
    statusDiv.textContent = text;
    statusDiv.style.color = type === 'error' ? 'red' : type === 'success' ? 'green' : 'blue';
}

// Ініціалізація додатка для redirect.html
async function initializeApp() {
    console.log('DEBUG: Initializing P2P app for redirect');
    const statusDiv = document.getElementById('status');
    const p2pStatusDiv = document.getElementById('p2p-status');

    if (!statusDiv || !p2pStatusDiv) {
        console.error('DEBUG: Missing DOM elements:', {
            statusDiv: !!statusDiv,
            p2pStatusDiv: !!p2pStatusDiv
        });
        return;
    }

    // Запускаємо P2P-вузол
    try {
        await startNodePromise;
        console.log('DEBUG: P2P node initialized');
        p2pStatusDiv.textContent = 'P2P Status: Connected';
    } catch (err) {
        console.error('DEBUG: Error initializing P2P:', err);
        p2pStatusDiv.textContent = `P2P Status: Failed (${err.message})`;
        showMessage(statusDiv, 'Error: No network connection', 'error');
        return;
    }

    // Отримуємо shortCode із URL
    const urlParams = new URLSearchParams(window.location.search);
    const shortCode = urlParams.get('code');
    if (!shortCode) {
        showMessage(statusDiv, 'Error: No redirect code provided', 'error');
        return;
    }

    // Завантажуємо редирект
    try {
        const redirect = await getRedirect(shortCode);
        if (!redirect || !redirect.destinationUrl) {
            showMessage(statusDiv, `Redirect /r/${shortCode} not found`, 'error');
            return;
        }

        showMessage(statusDiv, `Redirecting to ${redirect.destinationUrl}...`, 'success');
        // Додаємо затримку для UI і можливість редагування
        let holdTimeout;
        statusDiv.addEventListener('mousedown', () => {
            holdTimeout = setTimeout(() => {
                const password = prompt(`Enter password for /r/${shortCode} to edit:`);
                if (password) {
                    window.location.href = `/edit-redirect.html?code=${shortCode}&password=${encodeURIComponent(password)}`;
                }
            }, 3000);
        });
        statusDiv.addEventListener('mouseup', () => clearTimeout(holdTimeout));
        statusDiv.addEventListener('mouseleave', () => clearTimeout(holdTimeout));

        // Виконуємо редирект через 3 секунди
        setTimeout(() => {
            window.location.href = redirect.destinationUrl;
        }, 3000);
    } catch (err) {
        console.error('DEBUG: Error fetching redirect:', err);
        showMessage(statusDiv, `Error: ${err.message}`, 'error');
    }
}

// Запускаємо ініціалізацію
try {
    initializeApp();
} catch (err) {
    console.error('DEBUG: Error initializing app:', err);
    const statusDiv = document.getElementById('status');
    if (statusDiv) {
        showMessage(statusDiv, `Error initializing app: ${err.message}`, 'error');
    }
}