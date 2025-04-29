// Показує повідомлення в UI
export function showMessage(element, text, type = 'info') {
    const alertClass = type === 'error' ? 'alert-danger' : type === 'success' ? 'alert-success' : 'alert-info';
    element.innerHTML = `<div class="alert ${alertClass}">${text}</div>`;
    if (type !== 'error') setTimeout(() => (element.innerHTML = ''), 5000);
}

// Генерує пароль
export function generatePassword(length = 12) {
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
    return password;
}

// Генерує сіль
export function generateSalt(length = 16) {
    let salt = '';
    if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.getRandomValues) {
        const values = new Uint8Array(length);
        globalThis.crypto.getRandomValues(values);
        salt = Array.from(values, byte => byte.toString(16).padStart(2, '0')).join('');
    } else {
        for (let i = 0; i < length * 2; i++) {
            salt += Math.floor(Math.random() * 16).toString(16);
        }
    }
    return salt;
}

// Хешує пароль
export async function hashPassword(password, salt = null) {
    const currentSalt = salt || generateSalt();
    const encoder = new TextEncoder();
    const data = encoder.encode(password + currentSalt);
    const hashBuffer = await globalThis.crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    return `${currentSalt}:${hashHex}`;
}

// Перевіряє пароль
export async function verifyRedirectPassword(providedPassword, storedSaltAndHash) {
    if (!providedPassword || !storedSaltAndHash || !storedSaltAndHash.includes(':')) {
        return false;
    }
    const [salt, storedHash] = storedSaltAndHash.split(':');
    const providedHashWithStoredSalt = await hashPassword(providedPassword, salt);
    return providedHashWithStoredSalt === storedSaltAndHash;
}

// Генерує короткий код
export async function generateShortCode(inputString) {
    const encoder = new TextEncoder();
    const data = encoder.encode(inputString);
    const hashBuffer = await globalThis.crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const base64 = btoa(String.fromCharCode(...hashArray)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
    return base64.slice(0, 8);
}