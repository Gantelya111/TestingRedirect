import { getRedirect, updateRedirect, verifyRedirectPassword } from './p2p.js';

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

function showSuccess(message) {
    const successDiv = document.getElementById('success-message');
    if (successDiv) {
        successDiv.textContent = message;
        successDiv.style.display = 'block';
        setTimeout(() => {
            successDiv.style.display = 'none';
        }, 5000);
    } else {
        console.log('Success:', message);
    }
}

async function loadRedirect() {
    const urlParams = new URLSearchParams(window.location.search);
    const shortCode = urlParams.get('shortCode');
    if (!shortCode) {
        showError('No short code provided');
        return;
    }

    try {
        console.log('DEBUG: Loading redirect:', shortCode);
        const redirect = await getRedirect(shortCode);
        if (!redirect) {
            showError('Redirect not found');
            return;
        }

        document.getElementById('short-code').textContent = redirect.shortCode;
        document.getElementById('redirect-url').value = redirect.destinationUrl;
        document.getElementById('redirect-description').value = redirect.description || '';
    } catch (err) {
        console.error('Error loading redirect:', err);
        showError('Failed to load redirect');
    }
}

async function handleUpdateRedirect(event) {
    event.preventDefault();
    const shortCode = document.getElementById('short-code').textContent;
    const url = document.getElementById('redirect-url').value.trim();
    const description = document.getElementById('redirect-description').value.trim();
    const password = document.getElementById('redirect-password').value.trim();

    if (!url || !password) {
        showError('URL and password are required');
        return;
    }

    try {
        console.log('DEBUG: Updating redirect:', shortCode);
        await updateRedirect(shortCode, url, description, password);
        showSuccess('Redirect updated successfully');
        setTimeout(() => {
            window.location.href = 'manager.html';
        }, 2000);
    } catch (err) {
        console.error('Error updating redirect:', err);
        showError(`Failed to update redirect: ${err.message}`);
    }
}

document.addEventListener('DOMContentLoaded', () => {
    console.log('DEBUG: Edit Redirect DOM loaded');
    const updateForm = document.getElementById('update-redirect-form');
    if (updateForm) {
        updateForm.addEventListener('submit', handleUpdateRedirect);
    } else {
        console.error('Update form not found');
    }
    loadRedirect();
});