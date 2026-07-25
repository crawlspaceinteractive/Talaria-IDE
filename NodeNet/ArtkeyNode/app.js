// --- Initial Setup and Compatibility Check ---

const imageInput = document.getElementById('imageInput');
const outputKey = document.getElementById('outputKey');
const statusMessage = document.getElementById('statusMessage');

// Check for required API support before proceeding
if (!window.crypto || !window.crypto.subtle) {
    statusMessage.textContent = 
        "ERROR: Browser does not support the Web Cryptography API. Please update to a modern browser.";
    imageInput.disabled = true;
    // Do not proceed with the rest of the script
} else {
    // Stage 2: Input and File Reading (Event Listener)
    imageInput.addEventListener('change', handleFileSelect);
}


/**
 * Main function to handle file selection, reading, hashing, and formatting.
 */
function handleFileSelect(event) {
    const file = event.target.files[0];

    if (!file) {
        outputKey.value = '';
        statusMessage.textContent = 'Awaiting file selection...';
        return;
    }

    statusMessage.textContent = `Reading "${file.name}" locally...`;
    outputKey.value = 'Initiating key calculation...';

    // Stage 2: FileReader for local binary data access
    const reader = new FileReader();

    reader.onload = async function(e) {
        const arrayBuffer = e.target.result;
        
        try {
            // Stage 3: Core Security Logic (Native SHA-256 Hashing)
            const hashBuffer = await crypto.subtle.digest('SHA-256', arrayBuffer);
            
            // Stage 4: Output and Formatting (Convert binary hash to Hex string)
            
            // 1. Convert ArrayBuffer to Uint8Array
            const hashArray = Array.from(new Uint8Array(hashBuffer));
            
            // 2. Convert each byte to a 2-digit Hex string and join
            const hashHex = hashArray.map(b => 
                b.toString(16).padStart(2, '0')
            ).join('');

            // Display final output
            outputKey.value = hashHex;
            statusMessage.textContent = `Key successfully generated! (SHA-256, 64 characters)`;

        } catch (error) {
            statusMessage.textContent = `Security Error: Could not generate key. ${error.message}`;
            outputKey.value = 'ERROR';
        }
    };

    // Begin reading the file as a raw binary buffer
    reader.readAsArrayBuffer(file);
}