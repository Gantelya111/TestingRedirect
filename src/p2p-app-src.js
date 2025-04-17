import { startNodePromise, stopNode } from './p2p.js';
import { initializeManager, verifyManagerPassword } from './manager-src.js';

function showError(message) {
    const errorDiv = document.getElementById('error-message');
    if (errorDiv) {
        errorDiv.textContent = message;
        errorDiv.style.display = 'block';
        setTimeout(() => {
            errorDiv.style.display = 'none';
        }, 5000);
    } else {
        console.error('Error:', message);
    }
}

async function handleLogin(event) {
    event.preventDefault();
    const passwordInput = document.getElementById('app-password');
    const password = passwordInput.value.trim();
    if (!password) {
        showError('Please enter a password');
        return;
    }

    try {
        console.log('DEBUG: Starting P2P synchronization');
        await startNodePromise;
        console.log('DEBUG: P2P node started');
        const isValid = await verifyManagerPassword(password);
        if (isValid) {
            console.log('DEBUG: App login successful');
            document.getElementById('app-login-section').style.display = 'none';
            document.getElementById('app-manager-section').style.display = 'block';
            await initializeManager();
        } else {
            showError('Incorrect password');
        }
    } catch (err) {
        console.error('Error starting P2P node:', err);
        showError('Failed to initialize P2P network');
    }
}

function handleLogout() {
    console.log('DEBUG: Logging out');
    stopNode().then(() => {
        console.log('DEBUG: P2P node stopped');
        document.getElementById('app-login-section').style.display = 'block';
        document.getElementById('app-manager-section').style.display = 'none';
        document.getElementById('app-password').value = '';
    }).catch(err => {
        console.error('Error stopping P2P node:', err);
        showError('Failed to stop P2P network');
    });
}

document.addEventListener('DOMContentLoaded', () => {
    console.log('DEBUG: App DOM loaded');
    const loginForm = document.getElementById('app-login-form');
    const logoutBtn = document.getElementById('logout-btn');
    if (loginForm) {
        loginForm.addEventListener('submit', handleLogin);
    } else {
        console.error('App login form not found');
    }
    if (logoutBtn) {
        logoutBtn.addEventListener('click', handleLogout);
    } else {
        console.error('Logout button not found');
    }
});