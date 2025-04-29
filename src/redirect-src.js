import { showMessage } from './utils.js';

async function initializeApp() {
    const statusDiv = document.getElementById('status');
    if (!statusDiv) {
        console.error('Missing statusDiv');
        return;
    }

    const urlParams = new URLSearchParams(window.location.search);
    const shortCode = urlParams.get('code');
    if (!shortCode) {
        showMessage(statusDiv, 'Error: No redirect code provided', 'error');
        return;
    }

    try {
        const response = await fetch(`/r/${shortCode}`);
        if (!response.ok) throw new Error(`HTTP error: ${response.status}`);
        const redirect = await response.json();
        if (!redirect || !redirect.destinationUrl) {
            showMessage(statusDiv, `Redirect /r/${shortCode} not found`, 'error');
            return;
        }

        showMessage(statusDiv, `Redirecting to ${redirect.destinationUrl}...`, 'success');
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

        setTimeout(() => {
            window.location.href = redirect.destinationUrl;
        }, 3000);
    } catch (err) {
        showMessage(statusDiv, `Error: ${err.message}`, 'error');
    }
}

try {
    initializeApp();
} catch (err) {
    const statusDiv = document.getElementById('status');
    if (statusDiv) {
        showMessage(statusDiv, `Error initializing app: ${err.message}`, 'error');
    }
}