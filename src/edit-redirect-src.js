import { showMessage } from './utils.js';

async function initializeEditRedirect() {
    const editForm = document.getElementById('edit-redirect-form');
    const messagesDiv = document.getElementById('message');
    const shortCodeDisplay = document.getElementById('shortCodeDisplay');

    if (!editForm || !messagesDiv || !shortCodeDisplay) {
        if (messagesDiv) showMessage(messagesDiv, 'Error: Page elements not found', 'error');
        return;
    }

    const urlParams = new URLSearchParams(window.location.search);
    const shortCode = urlParams.get('code');
    const password = urlParams.get('password') || '';
    if (!shortCode) {
        showMessage(messagesDiv, 'Error: No redirect code provideddx', 'error');
        return;
    }

    shortCodeDisplay.textContent = `/r/${shortCode}`;

    try {
        const response = await fetch(`/redirects?search=${shortCode}`);
        if (!response.ok) throw new Error(`HTTP error: ${response.status}`);
        const redirects = await response.json();
        const redirect = redirects.find(r => r.shortCode === shortCode);
        if (!redirect) {
            showMessage(messagesDiv, `Redirect /r/${shortCode} not found`, 'error');
            return;
        }
        document.getElementById('destination_url').value = redirect.destinationUrl;
        document.getElementById('description').value = redirect.description || '';
        document.getElementById('password').value = password;
    } catch (err) {
        showMessage(messagesDiv, `Error loading redirect: ${err.message}`, 'error');
    }

    editForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const newUrl = document.getElementById('destination_url').value.trim();
        const newDescription = document.getElementById('description').value.trim();
        const password = document.getElementById('password').value.trim();

        if (!password) {
            showMessage(messagesDiv, 'Error: Password is required', 'error');
            return;
        }

        try {
            const response = await fetch(`/redirects/${shortCode}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ destinationUrl: newUrl, description: newDescription, password })
            });
            if (!response.ok) throw new Error(`HTTP error: ${response.status}`);
            showMessage(messagesDiv, `Redirect /r/${shortCode} updated`, 'success');
            setTimeout(() => {
                window.location.href = '/';
            }, 2000);
        } catch (err) {
            showMessage(messagesDiv, `Error: ${err.message}`, 'error');
        }
    });
}

try {
    initializeEditRedirect();
} catch (err) {
    const messagesDiv = document.getElementById('message');
    if (messagesDiv) {
        showMessage(messagesDiv, `Error initializing edit redirect: ${err.message}`, 'error');
    }
}