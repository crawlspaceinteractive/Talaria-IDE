// --- Global Elements and Data ---
document.getElementById('runScanButton').addEventListener('click', runFullViriScan);

// This is the data structure that defines the patterns the scanner looks for.
const SUSPICIOUS_PATTERNS = [
    // Pattern 1: Overly long, complex base64-like strings (potential data exfiltration payload)
    { 
        regex: /[A-Za-z0-9+/]{80,}=+/, 
        name: "Long Base64 Payload", 
        risk: 20 
    },
    // Pattern 2: Known tracker/hijacker ID patterns (e.g., specific ad injector IDs)
    { 
        regex: /tracking_id_\d{8}/i, 
        name: "Known Hijacker ID Pattern", 
        risk: 15 
    }
    // Add more patterns here as threat intelligence evolves!
]; 

// --- Utility function for updating the UI status ---
function updateStatus(elementId, message, className) {
    const element = document.getElementById(elementId);
    if (element) {
        element.textContent = message;
        element.className = className;
    }
}

// --- Main Function to Orchestrate All Checks (Sections 2, 3, 4) ---
function runFullViriScan() {
    let totalRiskScore = 0;
    
    // Reset status messages before running the scan
    updateStatus('environmentSummaryStatus', 'Scanning...', 'status-warning');
    updateStatus('volatileSummaryStatus', 'Scanning...', 'status-warning');
    
    // 1. Environmental Integrity Report (Section 2)
    const envRisk = runEnvironmentalInspection();
    totalRiskScore += envRisk;
    
    // 2. Volatile Data Audit (Section 3)
    const volatileRisk = runVolatileDataAudit();
    totalRiskScore += volatileRisk;

    // 3. Final Output and Alerting (Section 4)
    calculateInfectionRiskScore(totalRiskScore);
}

// ----------------------------------------------------
// --- Section 2: Environmental Inspection Logic ---
// ----------------------------------------------------

function runEnvironmentalInspection() {
    let risksFound = 0;
    
    const timeSkewRisk = checkSystemTimeSkew(); 
    if (timeSkewRisk) { risksFound += 5; } 
    
    const injectionRisk = checkGlobalInjection();
    if (injectionRisk) { risksFound += 25; } 
    
    const debuggerRisk = checkDebuggerPresence();
    if (debuggerRisk) { risksFound += 15; } 
    
    // Report summary to UI
    const scoreElement = document.getElementById('environmentSummaryStatus');
    if (risksFound > 0) {
        scoreElement.textContent = `WARNING: ${risksFound} Environmental Risk Points.`;
        scoreElement.className = 'status-warning';
    } else {
        scoreElement.textContent = 'PASS: Environment looks clean (0 Risk Points).';
        scoreElement.className = 'status-pass';
    }

    return risksFound;
}

function checkSystemTimeSkew() {
    const now = new Date();
    if (now.getFullYear() < 2020) {
        updateStatus('timeSkewStatus', 'FAIL: Check system clock.', 'status-fail');
        return true;
    }
    updateStatus('timeSkewStatus', 'PASS: Clock is plausible.', 'status-pass');
    return false;
}

function checkGlobalInjection() {
    const suspiciousKeys = ['__stolenDataBuffer', '_malware_command', 'trackerID_payload', 'malware_token_v3']; 
    let injectionFound = false;

    for (const key of suspiciousKeys) {
        if (window.hasOwnProperty(key)) {
            updateStatus('injectionStatus', `FAIL: Suspicious global variable '${key}' detected.`, 'status-fail');
            injectionFound = true;
            break; 
        }
    }

    if (!injectionFound) {
        updateStatus('injectionStatus', 'PASS: No known malicious global objects found.', 'status-pass');
    }
    return injectionFound;
}

function checkDebuggerPresence() {
    const start = Date.now();
    
    const antiDebugFunc = new Function("let i = 0; while(new Date() - arguments[0] < 100) { i++; }"); 
    antiDebugFunc(start);
    
    const timeElapsed = Date.now() - start;

    if (timeElapsed > 150) { 
        updateStatus('debuggerStatus', 'WARNING: Significant time anomaly (possible active debugger or heavy load).', 'status-warning');
        return true;
    }
    updateStatus('debuggerStatus', 'PASS: Execution speed is normal.', 'status-pass');
    return false;
}

// ----------------------------------------------------
// --- Section 3: Volatile Data Audit Logic ---
// ----------------------------------------------------

function runVolatileDataAudit() {
    // Note: If running via file:// protocol, document.cookie may be empty or restricted.
    const cookieString = document.cookie; 
    const allCookies = cookieString.split(';').filter(c => c.trim().length > 0);
    
    let patternRisksFound = 0;
    
    // Check A: Volume Check
    const cookieCount = allCookies.length;
    
    if (cookieCount > 50) {
        updateStatus('cookieCountStatus', `WARNING: ${cookieCount} cookies detected (High Volume).`, 'status-warning');
        patternRisksFound += 5; 
    } else {
        updateStatus('cookieCountStatus', `PASS: ${cookieCount} cookies detected (Normal Volume).`, 'status-pass');
    }

    // Check B: Suspicious Patterns
    let patternsDetected = [];
    
    SUSPICIOUS_PATTERNS.forEach(pattern => {
        if (pattern.regex.test(cookieString)) {
            patternsDetected.push(pattern);
            patternRisksFound += pattern.risk; 
        }
    });

    // Report Suspicious Patterns
    if (patternsDetected.length > 0) {
        const names = patternsDetected.map(p => p.name).join(', ');
        updateStatus('patternStatus', `FAIL: Found known malicious patterns: ${names}.`, 'status-fail');
    } else {
        updateStatus('patternStatus', 'PASS: No known malicious patterns detected in cookies.', 'status-pass');
    }

    // Report Volatile Data Summary
    if (patternRisksFound > 0) {
        updateStatus('volatileSummaryStatus', `WARNING: ${patternRisksFound} Volatile Risk Points.`, 'status-warning');
    } else {
        updateStatus('volatileSummaryStatus', 'Volatile Data is Clean (0 Risk Points).', 'status-pass');
    }
    
    return patternRisksFound; 
}


// ----------------------------------------------------
// --- Section 4: Output and Alerting Logic ---
// ----------------------------------------------------

function calculateInfectionRiskScore(totalRiskScore) {
    const scoreElement = document.getElementById('infectionRiskScore');
    const finalSummaryElement = document.getElementById('finalScoreArea').querySelector('h2');
    
    scoreElement.textContent = `${totalRiskScore} Points`;
    
    let advice = 'System appears clear. Monitor status periodically.';
    let gradeClass = 'status-pass';

    // Grading Logic: Total points determine the final alert color
    if (totalRiskScore >= 41) {
        gradeClass = 'status-fail'; // Red
        advice = 'CRITICAL RISK: High risk detected. Run a full anti-virus scan and change passwords immediately.';
    } else if (totalRiskScore >= 11) {
        gradeClass = 'status-warning'; // Yellow
        advice = 'WARNING: Anomalies detected. Review specific failed checks and consider restarting your browser.';
    } 

    scoreElement.className = gradeClass;
    
    // Update the final summary line
    finalSummaryElement.textContent = `System Infection Risk Score: ${totalRiskScore} Points - ${advice}`;
    finalSummaryElement.className = gradeClass;
}
