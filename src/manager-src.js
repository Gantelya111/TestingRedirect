import { showMessage, verifyRedirectPassword } from './utils.js';

const MANAGER_PASSWORD_HASH = "0fc3eacd461c5c008aff6e351c44a57f:043b63104b06d8aa5584a5180542c50c551966958ef8be9f34d8e476494d8f00";

function showPasswordPopup(shortCode, password) {
    const popup = document.createElement("div");
    popup.style.position = "fixed";
    popup.style.top = "10px";
    popup.style.left = "50%";
    popup.style.transform = "translateX(-50%)";
    popup.style.backgroundColor = "#4CAF50";
    popup.style.color = "white";
    popup.style.padding = "15px";
    popup.style.borderRadius = "5px";
    popup.style.zIndex = "1000";
    popup.innerHTML = `
        <strong>Redirect /r/${shortCode} created!</strong><br>
        Password: <strong>${password}</strong><br>
        <small>(This will disappear in 20 seconds)</small>
    `;
    document.body.appendChild(popup);
    setTimeout(() => document.body.removeChild(popup), 20000);
}

function disableInteractions(addForm, searchForm) {
    if (addForm) addForm.style.pointerEvents = 'none';
    if (searchForm) searchForm.style.pointerEvents = 'none';
    document.querySelectorAll('.delete-btn').forEach(btn => btn.disabled = true);
    document.querySelectorAll('.btn-warning').forEach(btn => btn.style.pointerEvents = 'none');
}

async function loadRedirects(redirectsBody, searchQuery = '') {
    try {
        const response = await fetch(`/redirects?search=${encodeURIComponent(searchQuery)}`);
        if (!response.ok) throw new Error(`HTTP error: ${response.status}`);
        const redirects = await response.json();
        console.log('Loaded redirects:', redirects); // Дебагінг
        redirectsBody.innerHTML = '';
        if (redirects.length === 0) {
            redirectsBody.innerHTML = `<tr><td colspan="4">No redirects found</td></tr>`;
            return;
        }
        redirects.forEach(r => {
            const row = document.createElement('tr');
            row.innerHTML = `
                <td><a href="/r/${r.shortCode}" target="_blank">/r/${r.shortCode}</a></td>
                <td>${r.destinationUrl || 'N/A'}</td>
                <td>${r.description || ''}</td>
                <td>
                    <a href="/edit-redirect.html?code=${r.shortCode}" class="btn btn-warning btn-sm">Edit</a>
                    <button class="btn btn-danger btn-sm delete-btn" data-shortcode="${r.shortCode}">Delete</button>
                </td>
            `;
            redirectsBody.appendChild(row);
        });
    } catch (err) {
        throw new Error(`Error loading redirects: ${err.message}`);
    }
}

async function verifyManagerPassword(enteredPassword) {
    return await verifyRedirectPassword(enteredPassword, MANAGER_PASSWORD_HASH);
}

async function initializeManager() {
    const addForm = document.getElementById('add-redirect-form');
    const searchForm = document.getElementById('search-form');
    const redirectsBody = document.getElementById('redirects-body');
    const messagesDiv = document.getElementById('messages');

    if (!addForm || !searchForm || !redirectsBody || !messagesDiv) {
        if (messagesDiv) showMessage(messagesDiv, 'Error: Page elements not found', 'error');
        return;
    }

    try {
        await loadRedirects(redirectsBody);
        setInterval(() => loadRedirects(redirectsBody), 5000);
    } catch (err) {
        showMessage(messagesDiv, err.message, 'error');
    }

    const enteredPassword = prompt('Enter the manager password:');
    let isAuthenticated = false;
    if (!enteredPassword) {
        showMessage(messagesDiv, 'No password provided. Access restricted.', 'error');
        disableInteractions(addForm, searchForm);
    } else {
        try {
            isAuthenticated = await verifyManagerPassword(enteredPassword);
            if (!isAuthenticated) {
                showMessage(messagesDiv, 'Incorrect password. Access restricted.', 'error');
                disableInteractions(addForm, searchForm);
            } else {
                showMessage(messagesDiv, 'Authentication successful!', 'success');
            }
        } catch (err) {
            showMessage(messagesDiv, 'Error verifying password. Access restricted.', 'error');
            disableInteractions(addForm, searchForm);
        }
    }

    if (isAuthenticated) {
        addForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const destinationUrl = document.getElementById('destination_url').value.trim();
            const description = document.getElementById('description').value.trim();
            try {
                const response = await fetch('/redirects', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ destinationUrl, description })
                });
                if (!response.ok) throw new Error(`HTTP error: ${response.status}`);
                const { shortCode, password } = await response.json();
                console.log(`Created redirect: /r/${shortCode}`); // Дебагінг
                showMessage(messagesDiv, `Redirect /r/${shortCode} created`, 'success');
                showPasswordPopup(shortCode, password);
                await loadRedirects(redirectsBody);
                addForm.reset();
            } catch (err) {
                showMessage(messagesDiv, `Error: ${err.message}`, 'error');
            }
        });

        searchForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const searchQuery = document.getElementById('search').value.trim();
            try {
                await loadRedirects(redirectsBody, searchQuery);
            } catch (err) {
                showMessage(messagesDiv, `Error searching redirects: ${err.message}`, 'error');
            }
        });

        redirectsBody.addEventListener('click', async (e) => {
            if (e.target.classList.contains('delete-btn')) {
                const shortCode = e.target.getAttribute('data-shortcode');
                const password = prompt(`Enter the password for /r/${shortCode} to delete:`);
                if (!password) {
                    showMessage(messagesDiv, 'No password provided. Deletion cancelled.', 'error');
                    return;
                }
                try {
                    const response = await fetch(`/redirects/${shortCode}`, {
                        method: 'DELETE',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ password })
                    });
                    if (!response.ok) throw new Error(`HTTP error: ${response.status}`);
                    showMessage(messagesDiv, `Redirect /r/${shortCode} deleted`, 'success');
                    await loadRedirects(redirectsBody);
                } catch (err) {
                    showMessage(messagesDiv, `Error: ${err.message}`, 'error');
                }
            }
        });
    }
}

try {
    initializeManager();
} catch (err) {
    const messagesDiv = document.getElementById('messages');
    if (messagesDiv) {
        showMessage(messagesDiv, `Error initializing manager: ${err.message}`, 'error');
    }
}