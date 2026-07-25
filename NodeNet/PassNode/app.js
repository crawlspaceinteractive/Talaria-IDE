// --- Global Constants and Elements ---
document.getElementById('encryptButton').addEventListener('click', handleEncryption);
document.getElementById('decryptButton').addEventListener('click', handleDecryption);

const IV_LENGTH = 12; // 96-bit IV, standard for AES-GCM

// --- Guardrail A: Initial Security Context Check --- This is like a "Reality Check" for the API
(function initialSecurityCheck() {
    const statusElement = document.getElementById('statusMessage');
    const protocol = window.location.protocol;
    
    if (protocol !== 'file:' && protocol !== 'https:') {
        statusElement.textContent = 'SECURITY WARNING: App is running from an UNSECURE origin (' + protocol + '). Use only via HTTPS or local file.';
        statusElement.style.color = 'red';
        document.getElementById('encryptButton').disabled = true;
        document.getElementById('decryptButton').disabled = true;
    } else {
        statusElement.textContent = 'READY. Security context: ' + (protocol === 'file:' ? 'OFFLINE FILE' : 'HTTPS SECURE');
        statusElement.style.color = 'green';
    }
})();

// --- Helper Functions (Essential for Binary <-> Text Conversion) --- Decoder Ring

function base64ToBuffer(base64) {
    // Converts Base64 string to a raw ArrayBuffer
    const binaryString = atob(base64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes.buffer;
}

function bufferToBase64(buf) {
    // Converts a raw ArrayBuffer to a Base64 string
    return btoa(String.fromCharCode.apply(null, new Uint8Array(buf)));
}

function hexToBuffer(hexString) {
    // Converts the 64-char hex string key to a raw ArrayBuffer
    const matches = hexString.match(/.{1,2}/g);
    if (!matches) throw new Error("Invalid hex string format or length.");
    return new Uint8Array(matches.map(byte => parseInt(byte, 16))).buffer;
}

// --- Section 2: Encryption Logic --- Encoder

async function handleEncryption() {
    const keyString = document.getElementById('secretKey').value.trim();
    const plaintext = document.getElementById('messageInput').value.trim();
    const statusElement = document.getElementById('statusMessage');
    
    document.getElementById('messageOutput').value = '';
    statusElement.textContent = 'Encrypting...';

    // Guardrail B: Key Integrity Check
    if (keyString.length !== 64 || !plaintext) {
        statusElement.textContent = 'FAIL: Ensure a 64-char key and a message are provided.';
        return;
    }

    try {
        // Key Prep
        const keyBuffer = hexToBuffer(keyString);
        const key = await crypto.subtle.importKey("raw", keyBuffer, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
        
        // IV Generation & Encoding
        const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
        const encodedPlaintext = new TextEncoder().encode(plaintext);

        // Encryption
        const ciphertextBuffer = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv }, key, encodedPlaintext);

        // Formatting (Combine IV and Ciphertext)
        const combinedBuffer = new Uint8Array(IV_LENGTH + ciphertextBuffer.byteLength);
        combinedBuffer.set(iv, 0); 
        combinedBuffer.set(new Uint8Array(ciphertextBuffer), IV_LENGTH);

        const ciphertextBase64 = bufferToBase64(combinedBuffer);

        document.getElementById('messageOutput').value = ciphertextBase64;
        statusElement.textContent = 'SUCCESS! Ciphertext ready. Share this securely.';

    } catch (e) {
        statusElement.textContent = `Encryption FAILED: Check key integrity. Error: ${e.message}`;
        console.error("Encryption Error:", e);
    }
}

// --- Section 3: Decryption Logic --- Decoder

async function handleDecryption() {
    const keyString = document.getElementById('secretKey').value.trim();
    const ciphertextBase64 = document.getElementById('messageInput').value.trim();
    const statusElement = document.getElementById('statusMessage');
    
    document.getElementById('messageOutput').value = '';
    statusElement.textContent = 'Decrypting...';

    // Guardrail B: Key Integrity Check
    if (keyString.length !== 64 || !ciphertextBase64) {
        statusElement.textContent = 'FAIL: Ensure a 64-char key and ciphertext are provided.';
        return;
    }

    try {
        // Input Parsing & Key Prep
        const combinedBuffer = base64ToBuffer(ciphertextBase64);
        if (combinedBuffer.byteLength < IV_LENGTH) { throw new Error("Ciphertext too short."); }

        const iv = combinedBuffer.slice(0, IV_LENGTH);
        const ciphertextBuffer = combinedBuffer.slice(IV_LENGTH);

        const keyBuffer = hexToBuffer(keyString);
        const key = await crypto.subtle.importKey("raw", keyBuffer, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);

        // Decryption
        const decryptedBuffer = await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv }, key, ciphertextBuffer);

        // Decoding & Output
        const plaintext = new TextDecoder().decode(decryptedBuffer);

        document.getElementById('messageOutput').value = plaintext;
        statusElement.textContent = 'SUCCESS! Message decrypted.';

    } catch (e) {
        // Guardrail D: Catches wrong key, corrupt message, or tamper
        statusElement.textContent = `DECRYPTION FAILED: Invalid key, corrupt message, or tamper detected. Error: ${e.message}`;
        console.error("Decryption Error:", e);
    }
}
