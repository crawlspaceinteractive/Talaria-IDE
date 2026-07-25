// --- Global Elements and Variables ---
let selectedFile = null;
let fileName = '';

const fileInput = document.getElementById('fileInput');
const shredButton = document.getElementById('shredButton');
const shredStatus = document.getElementById('shredStatus');
const downloadLink = document.getElementById('downloadLink');

// --- Section 2: File Input and Reading ---

// A. Enable Button on File Selection
fileInput.addEventListener('change', (event) => {
    // Reset previous state
    downloadLink.style.display = 'none';
    shredButton.disabled = true;

    if (event.target.files.length > 0) {
        selectedFile = event.target.files[0];
        
        // B. Get File Metadata
        fileName = selectedFile.name; 
        
        shredButton.disabled = false;
        shredStatus.textContent = `File selected: ${fileName} (${(selectedFile.size / 1024).toFixed(2)} KB). Ready to shred.`;
    } else {
        selectedFile = null;
        fileName = '';
        shredStatus.textContent = `Awaiting file selection...`;
    }
});

// Listener for the Shred action
shredButton.addEventListener('click', handleFileShredding);


function handleFileShredding() {
    if (!selectedFile) {
        shredStatus.textContent = 'Error: No file selected.';
        return;
    }

    shredButton.disabled = true;
    shredStatus.textContent = `Reading ${fileName} into memory for shredding...`;

    // C. Read Binary Data
    const reader = new FileReader();

    reader.onload = async (e) => { 
        const fileArrayBuffer = e.target.result;
        
        try {
            await startSecureWiping(fileArrayBuffer); // Call the wiping logic
        } catch (error) {
            shredStatus.textContent = `Fatal Error during shredding: ${error.message}`;
            shredButton.disabled = false;
        }
    };

    reader.onerror = (e) => {
        shredStatus.textContent = `Error reading file: ${e.message}`;
        shredButton.disabled = false;
    };

    try {
        reader.readAsArrayBuffer(selectedFile);
    } catch (e) {
        shredStatus.textContent = `Error initiating read: ${e.message}`;
        shredButton.disabled = false;
    }
}

// --- Section 3: Secure Wiping Logic (Patched for Chunking) ---

async function startSecureWiping(fileArrayBuffer) {
    const dataView = new Uint8Array(fileArrayBuffer);
    const dataLength = dataView.length;
    let passCount = 0;
    
    shredStatus.textContent = `Starting secure 3-pass wipe on ${dataLength} bytes...`;

    // 1. Zero Pass (0x00)
    await performWipePass(dataView, 0x00, "Zero Pass", ++passCount);

    // 2. One Pass (0xFF)
    await performWipePass(dataView, 0xFF, "One Pass", ++passCount);
    
    // 3. Random Pass (Cryptographically Random Data) - CHUNKED for large files
    shredStatus.textContent = `Pass ${++passCount}/3: Starting CHUNKED Random Pass...`;
    
    const MAX_CHUNK_SIZE = 65536; // The limit set by crypto.getRandomValues()
    
    try {
        for (let i = 0; i < dataLength; i += MAX_CHUNK_SIZE) {
            const end = Math.min(i + MAX_CHUNK_SIZE, dataLength);
            
            // Create a sub-array view of the current chunk
            const chunk = dataView.subarray(i, end);
            
            // Fill the chunk with cryptographically secure random bytes
            crypto.getRandomValues(chunk);
            
            // Update UI periodically to show progress
            if (i % (MAX_CHUNK_SIZE * 10) === 0 || end === dataLength) {
                 shredStatus.textContent = 
                    `Pass ${passCount}/3: Random Pass - ${(end / dataLength * 100).toFixed(2)}% complete.`;
                await new Promise(resolve => setTimeout(resolve, 10)); 
            }
        }
        
        shredStatus.textContent = `Pass ${passCount}/3: Random Pass COMPLETED. Data is shredded in memory.`;
    } catch (e) {
        shredStatus.textContent = `ERROR in Chunked Random Pass: ${e.message}`;
        throw new Error("Wiping failed.");
    }

    // Call the disposal step
    prepareForDisposal(fileArrayBuffer);
}

function performWipePass(dataView, value, name, currentPass) {
    // Returns a Promise to allow UI updates between passes
    return new Promise(resolve => {
        setTimeout(() => {
            shredStatus.textContent = `Pass ${currentPass}/3: Running ${name}...`;
            dataView.fill(value);
            resolve();
        }, 100);
    });
}

// --- Section 4: User-Controlled Disposal ---

function prepareForDisposal(finalArrayBuffer) {
    
    // A. Create Blob
    const shreddedBlob = new Blob([finalArrayBuffer], { type: 'application/octet-stream' });

    // B. Create Download Link
    const url = URL.createObjectURL(shreddedBlob);
    
    // C. Set Metadata
    downloadLink.href = url;
    downloadLink.download = fileName; // Uses original file name
    
    // Clean up previous temporary URL (memory management)
    if (downloadLink.dataset.oldUrl) {
        URL.revokeObjectURL(downloadLink.dataset.oldUrl);
    }
    downloadLink.dataset.oldUrl = url;

    // D. Prompt User
    shredStatus.textContent = 
        `SHREDDING COMPLETE. The file data in memory is now random garbage. 
        Click the link below, save the file, and manually overwrite the original to complete secure deletion.`;
    
    // Show the disposal link and re-enable button
    downloadLink.style.display = 'block'; 
    shredButton.disabled = false; 
    selectedFile = null; 
}
