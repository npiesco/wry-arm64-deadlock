import { invoke } from '@tauri-apps/api/core';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';

const appWindow = getCurrentWebviewWindow();

// State
let activeTabId = null;
let timerInterval = null;
let timerStart = null;
const HUNG_THRESHOLD_MS = 5000;

// DOM refs
const urlInput    = document.getElementById('urlInput');
const goBtn       = document.getElementById('goBtn');
const instructions = document.getElementById('instructions');
const toolbar     = document.getElementById('toolbar');
const statusBar   = document.getElementById('statusBar');
const statusText  = document.getElementById('statusText');
const statusTimer = document.getElementById('statusTimer');
const logEl       = document.getElementById('log');

// ---- Status bar helpers ----
function setStatus(state, text) {
    statusBar.className = 'status-bar ' + state;
    statusText.textContent = text;
    if (state === 'idle' || state === 'done') stopTimer();
}

function startTimer() {
    stopTimer();
    timerStart = performance.now();
    statusTimer.textContent = '0.0s';
    timerInterval = setInterval(() => {
        const elapsed = ((performance.now() - timerStart) / 1000);
        statusTimer.textContent = elapsed.toFixed(1) + 's';
        if (elapsed * 1000 >= HUNG_THRESHOLD_MS && statusBar.classList.contains('loading')) {
            statusBar.className = 'status-bar hung';
            statusText.textContent = 'DEADLOCK DETECTED \u2014 .build() has not returned';
            addLog('DEADLOCK: .build() stuck in wry wait_with_pump() \u2014 MsgWaitForMultipleObjectsEx not dispatching COM callbacks on ARM64', 'err');
        }
    }, 100);
}

function stopTimer() {
    if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
}

// ---- Event log ----
function addLog(msg, cls = '') {
    const ts = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const entry = document.createElement('div');
    entry.className = 'log-entry ' + cls;
    entry.innerHTML = '<span class="ts">[' + ts + ']</span> ' + msg;
    logEl.appendChild(entry);
    logEl.scrollTop = logEl.scrollHeight;
}

// ---- Helpers ----
function normalizeUrl(raw) {
    let u = raw.trim();
    if (!u) return null;
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
    return u;
}

// ---- Main flow: Go button ----
async function openUrl(rawUrl) {
    const url = normalizeUrl(rawUrl);
    if (!url) return;

    if (activeTabId) {
        // STEP 2: navigate_tab  close + rebuild SAME label  THIS DEADLOCKS
        addLog('navigate_tab \u2192 close() + rebuild SAME label \u2192 ' + url, 'nav');
        setStatus('loading', 'navigate_tab: .build() in progress\u2026');
        startTimer();
        try {
            await invoke('navigate_tab', { tabId: activeTabId, url });
            const elapsed = ((performance.now() - timerStart) / 1000).toFixed(2);
            setStatus('done', 'navigate_tab OK (' + elapsed + 's)');
            addLog('navigate_tab returned OK in ' + elapsed + 's', 'ok');
        } catch (err) {
            setStatus('idle', 'Error: ' + err);
            addLog('navigate_tab error: ' + err, 'err');
        }
    } else {
        // STEP 1: create first tab
        addLog('create_new_tab \u2192 ' + url, 'nav');
        setStatus('loading', 'Creating tab\u2026');
        startTimer();
        try {
            const json = await invoke('create_new_tab', { url });
            const tab = JSON.parse(json);
            activeTabId = tab.id;
            const elapsed = ((performance.now() - timerStart) / 1000).toFixed(2);
            setStatus('done', 'Tab created (' + elapsed + 's) \u2014 now change the URL and click Go again');
            addLog('create_new_tab OK in ' + elapsed + 's \u2014 tab ' + tab.id.substring(0,8) + '\u2026', 'ok');
            instructions.style.display = 'none';
        } catch (err) {
            setStatus('idle', 'Error: ' + err);
            addLog('create_new_tab error: ' + err, 'err');
        }
    }
    urlInput.value = url;
}

// ---- Event listeners ----
goBtn.addEventListener('click', () => openUrl(urlInput.value));
urlInput.addEventListener('keydown', e => { if (e.key === 'Enter') openUrl(urlInput.value); });

toolbar.addEventListener('mousedown', e => {
    if (e.target === toolbar || e.target.classList.contains('app-title')) {
        appWindow.startDragging();
    }
});

addLog('Ready \u2014 enter a URL and click Go');