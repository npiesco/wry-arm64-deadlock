import { invoke } from '@tauri-apps/api/core';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';

const appWindow = getCurrentWebviewWindow();

// State
let tabs = [];
let activeTabId = null;
let timerInterval = null;
let timerStart = null;
const HUNG_THRESHOLD_MS = 5000; // after 5s consider it hung

// DOM refs
const urlInput    = document.getElementById('urlInput');
const goBtn       = document.getElementById('goBtn');
const newTabBtn   = document.getElementById('newTabBtn');
const closeAllBtn = document.getElementById('closeAllBtn');
const tabBar      = document.getElementById('tabBar');
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
    if (state === 'idle' || state === 'done') {
        stopTimer();
    }
}

function startTimer() {
    stopTimer();
    timerStart = performance.now();
    statusTimer.textContent = '0.0s';
    timerInterval = setInterval(() => {
        const elapsed = ((performance.now() - timerStart) / 1000);
        statusTimer.textContent = elapsed.toFixed(1) + 's';
        // Escalate to "hung" after threshold
        if (elapsed * 1000 >= HUNG_THRESHOLD_MS && statusBar.classList.contains('loading')) {
            statusBar.className = 'status-bar hung';
            const url = statusText.textContent.replace(/^Navigating to /, '').replace(/\.\.\.$/, '');
            statusText.textContent = 'DEADLOCK DETECTED \u2014 navigate_tab has not returned (' + url + ')';
            log('DEADLOCK: .build() has not returned \u2014 wry wait_with_pump() is stuck', 'err');
        }
    }, 100);
}

function stopTimer() {
    if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = null;
    }
}

// ---- Event log ----
function log(msg, cls = '') {
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

async function refreshTabs() {
    const json = await invoke('get_all_tabs');
    tabs = JSON.parse(json);
    activeTabId = tabs.find(t => t.is_active)?.id ?? null;
    renderTabs();
    instructions.style.display = tabs.length === 0 ? '' : 'none';
}

function renderTabs() {
    tabBar.querySelectorAll('.tab').forEach(el => el.remove());
    for (const t of tabs) {
        const el = document.createElement('div');
        el.className = 'tab' + (t.is_active ? ' active' : '');
        el.innerHTML =
            '<span class="tab-title">' + (t.title || 'New Tab') + '</span>' +
            '<span class="tab-close" data-id="' + t.id + '">\u00d7</span>';
        el.addEventListener('click', e => {
            if (e.target.classList.contains('tab-close')) {
                closeTab(e.target.dataset.id);
            } else {
                switchTab(t.id);
            }
        });
        tabBar.insertBefore(el, newTabBtn);
    }
}

// ---- Tab operations ----
async function openUrl(rawUrl) {
    const url = normalizeUrl(rawUrl);
    if (!url) return;

    if (activeTabId) {
        // This is the deadlock path
        log('navigate_tab(\u2026) \u2014 closing window + rebuilding SAME label \u2192 ' + url, 'nav');
        setStatus('loading', 'Navigating to ' + url + '...');
        startTimer();
        try {
            await invoke('navigate_tab', { tabId: activeTabId, url });
            const elapsed = ((performance.now() - timerStart) / 1000).toFixed(2);
            setStatus('done', 'Navigated to ' + url + ' (' + elapsed + 's)');
            log('navigate_tab returned OK in ' + elapsed + 's', 'ok');
        } catch (err) {
            setStatus('idle', 'Error: ' + err);
            log('navigate_tab error: ' + err, 'err');
        }
    } else {
        log('create_new_tab(\u2026) \u2192 ' + url, 'nav');
        setStatus('loading', 'Creating tab for ' + url + '...');
        startTimer();
        try {
            await invoke('create_new_tab', { url });
            const elapsed = ((performance.now() - timerStart) / 1000).toFixed(2);
            setStatus('done', 'Tab created (' + elapsed + 's)');
            log('create_new_tab returned OK in ' + elapsed + 's', 'ok');
        } catch (err) {
            setStatus('idle', 'Error: ' + err);
            log('create_new_tab error: ' + err, 'err');
        }
    }
    await refreshTabs();
    urlInput.value = url;
}

async function switchTab(id) {
    await invoke('switch_tab', { tabId: id });
    await refreshTabs();
}

async function closeTab(id) {
    log('close_tab ' + id.substring(0, 8) + '\u2026');
    await invoke('close_tab', { tabId: id });
    await refreshTabs();
    if (tabs.length === 0) setStatus('idle', 'Ready');
}

async function closeAllTabs() {
    log('close_all_tabs');
    await invoke('close_all_tabs');
    tabs = [];
    activeTabId = null;
    renderTabs();
    instructions.style.display = '';
    setStatus('idle', 'Ready');
}

// ---- Event listeners ----
goBtn.addEventListener('click', () => openUrl(urlInput.value));
urlInput.addEventListener('keydown', e => { if (e.key === 'Enter') openUrl(urlInput.value); });

newTabBtn.addEventListener('click', async () => {
    log('create_new_tab (+ button)', 'nav');
    await invoke('create_new_tab', { url: 'https://example.com' });
    await refreshTabs();
});

closeAllBtn.addEventListener('click', closeAllTabs);

toolbar.addEventListener('mousedown', e => {
    if (e.target === toolbar || e.target.classList.contains('app-title')) {
        appWindow.startDragging();
    }
});

// Initial log
log('Ready \u2014 enter a URL and click Go');