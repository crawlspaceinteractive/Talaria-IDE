// --- Global Elements and Data ---
document.getElementById('runScanButton').addEventListener('click', runLocalScan);

const CRITICAL_VULNERABILITIES = [
    { 
        id: 'CVE-2025-001', 
        name: "Browser Zero-Day: Remote Code Execution", 
        description: "A severe flaw allowing remote code execution through manipulated websites.",
        affectedSoftware: "Chrome, Edge (Versions older than 130)", 
        CVSS: 9.8,
        link: "https://www.example.com/cve-2025-001-details" 
    },
    { 
        id: 'CVE-2024-555', 
        name: "OS File Privilege Escalation", 
        description: "Allows local attackers to gain root access after executing specific malware.",
        affectedSoftware: "Windows 10/11, macOS (All current versions)", 
        CVSS: 8.5,
        link: "https://www.example.com/cve-2024-555-details"
    }
    // Add more CVEs here!
];

// --- Main Scan Function (Stage 2 hook) ---

function runLocalScan() {
    // Stage 2: Browser Security Checker Functions
    checkBrowserVersion();
    checkSecurityContext();
    checkSystemTime();
    
    // Stage 3 & 4: Data Rendering and Scoring
    renderVulnerabilityList();
    calculateOverallScore(); 
}

// --- Stage 2 Logic ---

function checkBrowserVersion() {
    // ... (omitted for brevity, see previous response for full function body) ...
    // Full function body inserted here in practice.
    const userAgent = navigator.userAgent;
    const element = document.getElementById('browserVersionStatus');
    
    let browserName = "Unknown/Custom Browser";
    
    if (userAgent.includes("Chrome") && !userAgent.includes("Edg")) {
        browserName = "Google Chrome";
    } else if (userAgent.includes("Firefox")) {
        browserName = "Mozilla Firefox";
    } else if (userAgent.includes("Safari") && !userAgent.includes("Chrome")) {
        browserName = "Apple Safari";
    } else if (userAgent.includes("Edg")) {
        browserName = "Microsoft Edge";
    }

    element.innerHTML = `${browserName} (<span class="status-warning">Verify Last Updated!</span>)`;
    element.className = 'status-warning';
}

function checkSecurityContext() {
    // ... (omitted for brevity, see previous response for full function body) ...
    // Full function body inserted here in practice.
    const protocol = window.location.protocol;
    const element = document.getElementById('securityContextStatus');
    
    if (protocol === 'https:') {
        element.textContent = 'HTTPS Encrypted Origin';
        element.className = 'status-pass';
        
    } else if (protocol === 'file:') {
        element.textContent = 'Local File System (Offline Execution)';
        element.className = 'status-pass';
        
    } else {
        element.textContent = `UNSECURE: ${protocol} origin detected.`;
        element.className = 'status-fail';
    }
}

function checkSystemTime() {
    // ... (omitted for brevity, see previous response for full function body) ...
    // Full function body inserted here in practice.
    const now = new Date();
    const element = document.getElementById('timeDateStatus');
    
    if (now.getFullYear() < 2020) {
        element.textContent = `FAIL: System clock shows ${now.toLocaleDateString()}. Check system time and timezone!`;
        element.className = 'status-fail';
    } else {
        element.textContent = `PASS: ${now.toLocaleTimeString()} on ${now.toLocaleDateString()}`;
        element.className = 'status-pass';
    }
}


// --- Stage 3 Logic ---

function renderVulnerabilityList() {
    // ... (omitted for brevity, see previous response for full function body) ...
    // Full function body inserted here in practice.
    const listContainer = document.getElementById('vulnerabilityList');
    listContainer.innerHTML = ''; 

    CRITICAL_VULNERABILITIES.forEach((vulnerability) => {
        const isPatched = localStorage.getItem(vulnerability.id) === 'patched';
        const statusText = isPatched ? 'PATCHED' : 'UNPATCHED';
        const statusClass = isPatched ? 'status-pass' : 'status-fail';

        const vulnerabilityHTML = `
            <div style="border: 1px solid #ccc; padding: 10px; margin-bottom: 15px;">
                <strong>${vulnerability.name}</strong> (CVSS: ${vulnerability.CVSS})
                <p style="margin: 5px 0;">Status: <span id="${vulnerability.id}-status" class="${statusClass}">${statusText}</span></p>
                <p style="margin: 5px 0; font-size: 0.9em;">
                    Affected: ${vulnerability.affectedSoftware} | Details: <a href="${vulnerability.link}" target="_blank">View Info</a>
                </p>
                <button 
                    data-cve-id="${vulnerability.id}" 
                    onclick="togglePatchStatus('${vulnerability.id}')"
                    style="background-color: ${isPatched ? '#ccc' : '#dc3545'}; color: white; border: none; padding: 5px 10px; cursor: pointer;">
                    ${isPatched ? 'Mark as UNPATCHED' : 'Mark as PATCHED'}
                </button>
            </div>
        `;
        listContainer.innerHTML += vulnerabilityHTML;
    });
}

function togglePatchStatus(cveId) {
    const isPatched = localStorage.getItem(cveId) === 'patched';
    
    if (isPatched) {
        localStorage.removeItem(cveId); 
    } else {
        localStorage.setItem(cveId, 'patched'); 
    }
    
    renderVulnerabilityList();
    calculateOverallScore(); 
}

// --- Stage 4 Logic ---

function calculateOverallScore() {
    // ... (omitted for brevity, see previous response for full function body) ...
    // Full function body inserted here in practice.
    let score = 0;
    const maxIntegrityPoints = 20;
    const maxVulnerabilityPoints = 80;
    
    // 1. Calculate Browser Integrity Score (Max 20 points)
    let integrityChecksPassed = 0;
    
    if (window.location.protocol === 'https:' || window.location.protocol === 'file:') {
        integrityChecksPassed += 5;
    }
    
    if (new Date().getFullYear() >= 2020) {
        integrityChecksPassed += 5;
    }

    integrityChecksPassed += 10; // Placeholder for version/extension checks
    
    score += integrityChecksPassed;

    // 2. Calculate Vulnerability Status Score (Max 80 points)
    const totalVulnerabilities = CRITICAL_VULNERABILITIES.length;
    let patchedVulnerabilities = 0;
    
    CRITICAL_VULNERABILITIES.forEach(vulnerability => {
        if (localStorage.getItem(vulnerability.id) === 'patched') {
            patchedVulnerabilities++;
        }
    });

    if (totalVulnerabilities > 0) {
        const vulnerabilityScore = (patchedVulnerabilities / totalVulnerabilities) * maxVulnerabilityPoints;
        score += vulnerabilityScore;
    }

    const finalScore = Math.round(score);

    // 3. Display Final Grade
    const finalScoreElement = document.getElementById('finalScore');
    finalScoreElement.textContent = `${finalScore}/100`;

    if (finalScore >= 90) {
        finalScoreElement.className = 'status-pass';
    } else if (finalScore >= 70) {
        finalScoreElement.className = 'status-warning';
    } else {
        finalScoreElement.className = 'status-fail';
    }

    document.getElementById('integrityGrade').textContent = 'Overall Grade Calculated.';
}
