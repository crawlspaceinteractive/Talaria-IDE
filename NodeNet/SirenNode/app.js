// --- Global Elements and Variables ---
document.getElementById('analyzeButton').addEventListener('click', handleAnalysis);

// High-Value Targets for Typosquatting Check (Section 3)
const HIGH_VALUE_TARGETS = [
    'google', 'amazon', 'paypal', 'microsoft', 'apple', 'facebook', 
    'twitter', 'instagram', 'bankofamerica', 'chase', 'wellsfargo'
];

// Utility function to update specific status spans
function updateStatus(elementId, message, className) {
    const element = document.getElementById(elementId);
    if (element) {
        element.textContent = message;
        element.className = className;
    }
}

// Utility function to calculate Levenshtein distance
function calculateDistance(s1, s2) {
    if (s1 === s2) return 0;
    if (s1.length > s2.length) {
        [s1, s2] = [s2, s1];
    }
    
    let costs = new Array(s1.length + 1).fill(0).map((_, i) => i);
    for (let i = 1; i <= s2.length; i++) {
        let lastValue = i;
        for (let j = 1; j <= s1.length; j++) {
            let top = costs[j - 1];
            let topCorner = costs[j];
            let cost = s1[j - 1] === s2[i - 1] ? 0 : 1;
            costs[j] = Math.min(topCorner + 1, lastValue + 1, top + cost);
            lastValue = topCorner;
        }
    }
    return costs[s1.length];
}

let parsedUrl = null; // Global variable for the parsed URL object

// ---------------------------------------------------------------------
// --- Section 2: Normalization Logic (URL Parser) ---
// ---------------------------------------------------------------------

async function analyzeUrl(rawUrlInput) {
    updateStatus('initialStatus', 'Running analysis...', 'status-warning');
    
    // Auto-prepend protocol if missing for URL constructor reliability
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(rawUrlInput)) {
        rawUrlInput = 'http://' + rawUrlInput; 
    }

    try {
        parsedUrl = new URL(rawUrlInput); 
        const hostname = parsedUrl.hostname;

        // Update UI with normalized components
        document.getElementById('normalizationStatus').innerHTML = `PASS: Successfully normalized. Hostname: <strong>${hostname}</strong>`;
        document.getElementById('normalizationStatus').className = 'status-pass';
        
        return { success: true, hostname: hostname };

    } catch (e) {
        document.getElementById('normalizationStatus').textContent = `FAIL: Invalid URL format or parsing error.`;
        document.getElementById('normalizationStatus').className = 'status-fail';
        parsedUrl = null;
        return { success: false };
    }
}

// ---------------------------------------------------------------------
// --- Section 3: Typosquatting Check ---
// ---------------------------------------------------------------------

function checkTyposquatting(hostname) {
    let typosquattingRiskScore = 0;
    
    // Filter out common TLD components to find the core domain name
    const parts = hostname.split('.').filter(p => !['com', 'co', 'uk', 'net', 'org', 'edu', 'gov'].includes(p));
    const mainDomain = parts.length > 0 ? parts[parts.length - 1] : hostname;
    let alertMessage = '';

    for (const target of HIGH_VALUE_TARGETS) {
        const distance = calculateDistance(mainDomain, target);
        
        if (distance === 1) {
            alertMessage = `CRITICAL RISK: Domain '${mainDomain}' is 1 character edit away from '${target}'.`;
            typosquattingRiskScore = 100; 
            break; 
        } else if (distance === 2 && mainDomain.length >= 6) { 
            alertMessage = `HIGH RISK: Domain is 2 edits away from '${target}'.`;
            typosquattingRiskScore = 70;
            break; 
        } else if (distance === 0) {
             alertMessage = `ALERT: Exact match to known target '${target}'. Check context closely.`;
             typosquattingRiskScore = 0; // Reset score if it matches the trusted brand exactly
        }
    }

    if (typosquattingRiskScore === 0) {
        alertMessage = alertMessage || 'PASS: No close typosquatting match found against high-value targets.';
        updateStatus('typosquattingStatus', alertMessage, 'status-pass');
    } else {
        updateStatus('typosquattingStatus', alertMessage, typosquattingRiskScore >= 70 ? 'status-fail' : 'status-warning');
    }
    
    return typosquattingRiskScore;
}

// ---------------------------------------------------------------------
// --- Section 4: Deceptive Pattern Check ---
// ---------------------------------------------------------------------

function checkDeceptivePatterns(hostname) {
    let deceptiveRiskScore = 0;

    // Check A: Punycode/Homoglyph
    if (hostname.includes('xn--')) {
        updateStatus('punycodeStatus', 'CRITICAL RISK: Punycode detected (Possible Homoglyph Attack).', 'status-fail');
        deceptiveRiskScore += 100;
    } else {
        updateStatus('punycodeStatus', 'PASS: No Punycode/Homoglyph patterns detected.', 'status-pass');
    }

    // Check B: Misleading Subdomain (Ensure it is actually a subdomain, not the main domain)
    const isMisleading = HIGH_VALUE_TARGETS.some(target => {
        return hostname.includes(target + '.') && !hostname.startsWith(target + '.'); 
    });

    if (isMisleading) {
        updateStatus('misleadingSubdomainStatus', 'HIGH RISK: Misleading brand name found as a subdomain.', 'status-fail');
        deceptiveRiskScore += 75; 
    } else {
        updateStatus('misleadingSubdomainStatus', 'PASS: Subdomain patterns appear normal.', 'status-pass');
    }

    // Check C: Explicit Credentials using reliable native URL properties
    if (parsedUrl && (parsedUrl.username || parsedUrl.password)) {
        updateStatus('credentialsStatus', 'CRITICAL RISK: Explicit user credentials detected in the URL.', 'status-fail');
        deceptiveRiskScore += 75;
    } else {
        updateStatus('credentialsStatus', 'PASS: No explicit credentials found in the URL.', 'status-pass');
    }
    
    return deceptiveRiskScore;
}

// ---------------------------------------------------------------------
// --- Section 5: Output and Scoring (Orchestration) ---
// ---------------------------------------------------------------------

async function handleAnalysis() {
    const urlInputVal = document.getElementById('urlInput').value.trim();
    let totalRiskScore = 0;

    // Reset status checks for a new scan
    updateStatus('typosquattingStatus', 'Scanning...', 'status-warning');
    updateStatus('punycodeStatus', 'Scanning...', 'status-warning');
    updateStatus('misleadingSubdomainStatus', 'Scanning...', 'status-warning');
    updateStatus('credentialsStatus', 'Scanning...', 'status-warning');

    // 1. Normalization Logic
    const parseResult = await analyzeUrl(urlInputVal); 
    if (!parseResult.success) {
        calculatePhishingRiskScore(0, true);
        return; 
    }
    const hostname = parseResult.hostname;
    
    // 2. Typosquatting Check
    totalRiskScore += checkTyposquatting(hostname);
    
    // 3. Deceptive Pattern Check
    totalRiskScore += checkDeceptivePatterns(hostname);
    
    // 4. Final Output and Scoring
    calculatePhishingRiskScore(totalRiskScore, false);
}

function calculatePhishingRiskScore(totalRiskScore, isParseFailure) {
    const scoreElement = document.getElementById('riskScoreDisplay');
    const adviceElement = document.getElementById('adviceDisplay');
    
    if (isParseFailure) {
        scoreElement.textContent = `N/A`;
        adviceElement.textContent = `Analysis Failed. Ensure the input is a valid URL.`;
        scoreElement.className = 'status-warning';
        adviceElement.className = 'status-warning';
        return;
    }

    scoreElement.textContent = `${totalRiskScore} Points`;
    
    let advice = '';
    let gradeClass = ''; 

    // Grading Logic
    if (totalRiskScore >= 151) {
        gradeClass = 'status-fail'; 
        advice = 'CRITICAL ALERT: Detected high-severity phishing indicators. DO NOT PROCEED. Close the page immediately.';
    } else if (totalRiskScore >= 51) {
        gradeClass = 'status-warning'; 
        advice = 'WARNING: Multiple low/medium risk factors detected. Assume malicious intent and avoid clicking.';
    } else {
        gradeClass = 'status-pass'; 
        advice = 'SAFE: URL appears clean based on local analysis. Proceed with normal caution.';
    } 

    // Update the final UI elements
    scoreElement.className = gradeClass;
    adviceElement.textContent = advice;
    adviceElement.className = gradeClass;
}
