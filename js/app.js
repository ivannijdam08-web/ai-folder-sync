/* =========================================================================
   AI FOLDER SYNC — CORE APPLICATION LOGIC (js/app.js)
   ========================================================================= */

const mainWindow = window;
let dirHandle = null;
let pendingSavedHandle = null;
let scannedFiles = [];
let pipWindow = null;
let currentLang = 'en';
let currentView = 'workspace';
let isFileDrawerCollapsed = false;
let langAnimTimer = null;
let wsAnimTimer = null;
let continueBtnFeedbackTimer = null;
let isMutatingDisk = false;
let isScanningFolder = false;
let lastFolderConnectTimestamp = 0;
let autoRefreshInterval = null;
let aiBaselineSnapshot = new Map();
let aiBaselineDirs = new Set();
let hasBaselineInitialized = false;

// Version History & Undo State
let versionHistory = [];
let undoTargetVersionId = null;
let lastRestoredVersionMeta = null;

const statusTimers = {};
const buttonFeedbackTimers = new WeakMap();

// === TRANSLATION HELPER ===
function t(key, vars = {}) {
  const dict = I18N[currentLang] || I18N.en;
  let str = dict[key] ?? I18N.en[key] ?? key;
  for (const [k, v] of Object.entries(vars)) {
    str = str.replace(new RegExp(`\\{\\s*${k}\\s*\\}`, 'g'), String(v));
  }
  return str;
}

// === FILE TYPE DETECTION & EXTENSION BADGES ===
async function detectIfFileIsText(filePath, fileObj) {
  const segments = filePath.split('/');
  const baseName = segments[segments.length - 1] || '';
  const lowerBase = baseName.toLowerCase();

  if (KNOWN_TEXT_FILENAMES.has(baseName) || KNOWN_TEXT_FILENAMES.has(lowerBase)) {
    return true;
  }

  if (
    lowerBase.startsWith('.env') ||
    lowerBase.startsWith('.bashrc') ||
    lowerBase.startsWith('.zshrc') ||
    lowerBase.startsWith('.profile') ||
    lowerBase.startsWith('.bash_') ||
    lowerBase.startsWith('.eslint') ||
    lowerBase.startsWith('.prettier') ||
    lowerBase.startsWith('.babel') ||
    lowerBase.startsWith('.stylelint')
  ) {
    return true;
  }

  const dotParts = lowerBase.split('.');
  const ext = dotParts.length > 1 ? dotParts[dotParts.length - 1] : '';

  if (ext && KNOWN_BINARY_EXTENSIONS.has(ext)) {
    return false;
  }
  if (ext && KNOWN_TEXT_EXTENSIONS.has(ext)) {
    return true;
  }

  if (!fileObj || fileObj.size > 5 * 1024 * 1024) {
    return false;
  }
  if (fileObj.size === 0) {
    return true;
  }

  try {
    const sampleBuffer = await fileObj.slice(0, 8192).arrayBuffer();
    const bytes = new Uint8Array(sampleBuffer);
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] === 0) return false;
    }
    return true;
  } catch (e) {
    return false;
  }
}

function getFileExtensionBadge(filePath) {
  const segments = filePath.split('/');
  const baseName = segments[segments.length - 1] || '';
  const lowerBase = baseName.toLowerCase();

  let label = 'FILE';
  if (lowerBase.startsWith('.env')) label = 'ENV';
  else if (lowerBase === 'dockerfile' || lowerBase === 'containerfile') label = 'DOCK';
  else if (lowerBase === 'makefile' || lowerBase === 'gnumakefile' || lowerBase === 'justfile') label = 'MAKE';
  else if (lowerBase.startsWith('.git')) label = 'GIT';
  else {
    const dotParts = baseName.split('.').filter(Boolean);
    if (dotParts.length > 1) {
      label = dotParts[dotParts.length - 1].toLowerCase().slice(0, 5);
    } else if (dotParts.length === 1) {
      label = dotParts[0].toLowerCase().slice(0, 4);
    }
  }

  const ext = label.toLowerCase();
  let cls = 'ext-badge';
  if (['html', 'htm', 'vue', 'svelt', 'astro', 'ejs', 'hbs', 'pug'].includes(ext)) cls += ' ext-html';
  else if (['css', 'scss', 'sass', 'less', 'styl'].includes(ext)) cls += ' ext-css';
  else if (['js', 'jsx', 'mjs', 'cjs'].includes(ext)) cls += ' ext-js';
  else if (['ts', 'tsx', 'mts', 'cts'].includes(ext)) cls += ' ext-ts';
  else if (['py', 'pyw', 'ipynb', 'r', 'jl', 'lua', 'rb', 'php', 'pl', 'sh', 'bash', 'zsh', 'ps1'].includes(ext)) cls += ' ext-py';
  else if (['json', 'jsonc', 'yaml', 'yml', 'toml', 'xml', 'sql', 'prism', 'gql', 'csv'].includes(ext)) cls += ' ext-json';
  else if (['md', 'mdx', 'txt', 'rst', 'adoc', 'tex'].includes(ext)) cls += ' ext-md';
  else if (['rs', 'go', 'c', 'cpp', 'h', 'hpp', 'cs', 'java', 'kt', 'swift', 'dart', 'zig', 'gleam'].includes(ext)) cls += ' ext-sys';
  else if (['env', 'ini', 'cfg', 'conf', 'dock', 'make', 'git', 'lock'].includes(ext)) cls += ' ext-cfg';

  return `<span class="${cls}">${escapeHtml(label)}</span>`;
}

// === CLIPBOARD HELPER & BUTTON FEEDBACK ===
async function writeTextToClipboard(text) {
  const nav = getActiveNavigator();
  if (nav && nav.clipboard && typeof nav.clipboard.writeText === 'function') {
    try {
      await nav.clipboard.writeText(text);
      return;
    } catch (e) {}
  }
  const doc = getDoc();
  const ta = doc.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.top = '-9999px';
  ta.style.opacity = '0';
  doc.body.appendChild(ta);
  ta.focus();
  ta.select();
  const ok = doc.execCommand('copy');
  doc.body.removeChild(ta);
  if (!ok) {
    throw new Error('Clipboard access denied');
  }
}

function flashButtonSuccess(btnEl) {
  if (!btnEl) return;
  const prevTimer = buttonFeedbackTimers.get(btnEl);
  if (prevTimer) mainWindow.clearTimeout(prevTimer);

  btnEl.classList.add('copied-ok');
  const timer = mainWindow.setTimeout(() => {
    btnEl.classList.remove('copied-ok');
  }, 1400);
  buttonFeedbackTimers.set(btnEl, timer);
}

// === DYNAMIC AI OUTPUT LIMIT HELPERS ===
function getSelectedOutputLimitMode() {
  const doc = getDoc();
  const selectEl = doc.getElementById('outputLimitSelect');
  const val = selectEl ? selectEl.value : (mainWindow.localStorage.getItem(STORAGE_KEYS.OUTPUT_LIMIT) || 'standard');
  return VALID_OUTPUT_LIMITS.includes(val) ? val : 'standard';
}

function updateOutputLimitIconUI() {
  const doc = getDoc();
  const iconHolder = doc.getElementById('outputLimitIcon');
  if (!iconHolder) return;
  const mode = getSelectedOutputLimitMode();
  if (mode === 'safe') iconHolder.innerHTML = SVG_ICONS.limitSafe;
  else if (mode === 'high') iconHolder.innerHTML = SVG_ICONS.limitHigh;
  else if (mode === 'unlimited') iconHolder.innerHTML = SVG_ICONS.limitUnlimited;
  else iconHolder.innerHTML = SVG_ICONS.limitStandard;
}

function getOutputLimitInstruction(mode = getSelectedOutputLimitMode()) {
  if (currentLang === 'nl') {
    if (mode === 'safe') {
      return 'MAXIMALE OUTPUT-LIMIET (STRIKT MAX 350 REGELS CODE): Genereer NOOIT meer dan ~350 regels code (of max 2 tot 3 nieuwe bestanden) in één JSON-antwoord. Is de opdracht groter? Stuur dan nu eerst Deel 1 (volledig afgesloten JSON) en vraag mij om Deel 2.';
    }
    if (mode === 'high') {
      return 'MAXIMALE OUTPUT-LIMIET (HOOG - TOT 2.000 REGELS CODE): Je hebt een ruime output-limiet en mag gerust grote of meerdere bestanden in één keer genereren. Splits alleen op in Deel 1 en Deel 2 als het totaal boven de ~2.000 regels code uitkomt.';
    }
    if (mode === 'unlimited') {
      return 'GEEN OUTPUT-LIMIET (ALLES IN ÉÉN KEER): Genereer de volledige code en alle benodigde bestanden direct in één enkel, compleet JSON-antwoord zonder de taak op te splitsen in delen.';
    }
    return 'MAXIMALE OUTPUT-LIMIET (MAX 700 REGELS CODE): Houd je JSON-blok onder de ~700 regels code (of max 4 tot 5 nieuwe bestanden). Overschrijdt de taak deze limiet? Splits de uitvoering dan op in Deel 1 (volledig afgesloten JSON) en vraag mij om Deel 2.';
  }

  if (mode === 'safe') {
    return 'MAXIMUM OUTPUT LIMIT (STRICT MAX 350 LINES OF CODE): NEVER generate more than ~350 lines of code (or max 2 to 3 new files) in a single JSON response. Is the task larger? Send Part 1 now (completely closed JSON) and ask me for Part 2.';
  }
  if (mode === 'high') {
    return 'MAXIMUM OUTPUT LIMIT (HIGH - UP TO 2,000 LINES OF CODE): You have a generous output limit and may freely generate large or multiple files at once. Only split into Part 1 and Part 2 if the total exceeds ~2,000 lines of code.';
  }
  if (mode === 'unlimited') {
    return 'NO OUTPUT LIMIT (EVERYTHING AT ONCE): Generate the complete code and all required files directly in a single, complete JSON response without splitting the task into parts.';
  }
  return 'MAXIMUM OUTPUT LIMIT (MAX 700 LINES OF CODE): Keep your JSON block under ~700 lines of code (or max 4 to 5 new files). Does the task exceed this limit? Split the execution into Part 1 (completely closed JSON) and ask me for Part 2.';
}

// === VIEW & LANGUAGE MANAGEMENT ===
function updateFolderDependentVisibility() {
  const doc = getDoc();
  const grid = doc.getElementById('toolGrid');
  const divider = doc.getElementById('topbarDivider');
  if (grid) {
    grid.classList.toggle('unlinked-mode', !dirHandle);
  }
  if (divider) {
    divider.classList.toggle('active', !!dirHandle);
  }
}

function triggerWorkspaceAnimation(type) {
  const doc = getDoc();
  const panel = doc.getElementById('workspacePanel');
  if (!panel) return;

  if (wsAnimTimer) mainWindow.clearTimeout(wsAnimTimer);
  panel.classList.remove('anim-connect', 'anim-refresh', 'anim-disconnect');
  void panel.offsetWidth;

  if (type === 'connect') {
    panel.classList.add('anim-connect');
    wsAnimTimer = mainWindow.setTimeout(() => panel.classList.remove('anim-connect'), 400);
  } else if (type === 'refresh') {
    panel.classList.add('anim-refresh');
    wsAnimTimer = mainWindow.setTimeout(() => panel.classList.remove('anim-refresh'), 520);
  } else if (type === 'disconnect') {
    panel.classList.add('anim-disconnect');
    wsAnimTimer = mainWindow.setTimeout(() => panel.classList.remove('anim-disconnect'), 220);
  }
}

function cleanUrlHash() {
  if (mainWindow.location.hash) {
    try {
      mainWindow.history.replaceState(null, '', mainWindow.location.pathname + mainWindow.location.search);
    } catch (e) {}
  }
}

function switchPageView(viewName) {
  currentView = (viewName === 'home') ? 'home' : 'workspace';
  try {
    mainWindow.localStorage.setItem(STORAGE_KEYS.VIEW, currentView);
  } catch (e) {}

  cleanUrlHash();

  const doc = mainWindow.document;
  doc.getElementById('viewWorkspace')?.classList.toggle('active', currentView === 'workspace');
  doc.getElementById('viewHome')?.classList.toggle('active', currentView === 'home');

  doc.querySelectorAll('.view-tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-switch-view') === currentView);
  });

  mainWindow.scrollTo({ top: 0, behavior: 'smooth' });
}

function applyTranslationsToRoot(rootDoc) {
  if (!rootDoc) return;

  rootDoc.querySelectorAll('[data-i18n]').forEach(el => {
    el.textContent = t(el.getAttribute('data-i18n'));
  });

  rootDoc.querySelectorAll('[data-i18n-html]').forEach(el => {
    el.innerHTML = t(el.getAttribute('data-i18n-html'));
  });

  rootDoc.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    el.setAttribute('placeholder', t(el.getAttribute('data-i18n-placeholder')));
  });

  rootDoc.querySelectorAll('[data-i18n-title]').forEach(el => {
    el.setAttribute('title', t(el.getAttribute('data-i18n-title')));
  });

  const langSwitchEl = rootDoc.getElementById('mainLangSwitch');
  if (langSwitchEl) {
    langSwitchEl.setAttribute('data-active-lang', currentLang);
  }

  rootDoc.querySelectorAll('[data-lang-switch]').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-lang-switch') === currentLang);
  });

  const codePreview = rootDoc.getElementById('codePreviewBlock');
  if (codePreview) {
    codePreview.textContent = t('code_preview');
  }
}

function applyLanguageContent(lang, persistPreference = false) {
  currentLang = (lang === 'nl') ? 'nl' : 'en';
  if (persistPreference) {
    try {
      mainWindow.localStorage.setItem(STORAGE_KEYS.LANG, currentLang);
    } catch (e) {}
  }

  mainWindow.document.documentElement.lang = currentLang;
  mainWindow.document.title = t('page_title');

  applyTranslationsToRoot(mainWindow.document);
  if (pipWindow && !pipWindow.closed) {
    applyTranslationsToRoot(pipWindow.document);
  }

  const doc = getDoc();
  const connLabel = doc.getElementById('connLabel');
  const pipConnName = doc.getElementById('pipConnName');
  if (dirHandle) {
    if (connLabel) connLabel.textContent = dirHandle.name;
    if (pipConnName) pipConnName.textContent = dirHandle.name;
    renderFileTreeUI();
    renderVersionHistoryUI();
  } else if (pendingSavedHandle) {
    if (connLabel) connLabel.textContent = t('saved_folder_badge', { name: pendingSavedHandle.name });
    if (pipConnName) pipConnName.textContent = t('saved_folder_badge', { name: pendingSavedHandle.name });
    const recText = doc.getElementById('reconnectText');
    const recBtn = doc.getElementById('reconnectBtn');
    if (recText) recText.textContent = t('reconnect_ready', { name: pendingSavedHandle.name });
    if (recBtn) recBtn.textContent = t('reconnect_btn', { name: pendingSavedHandle.name });
  } else {
    if (connLabel) connLabel.textContent = t('no_folder_linked');
    if (pipConnName) pipConnName.textContent = t('no_folder_linked');
    renderDeltaBannerUI();
    renderVersionHistoryUI();
  }
  updateFolderDependentVisibility();
  updateOutputLimitIconUI();
}

function setLanguage(lang, animate = true, persistPreference = false) {
  const nextLang = (lang === 'nl') ? 'nl' : 'en';
  if (!animate || nextLang === currentLang) {
    applyLanguageContent(nextLang, persistPreference);
    return;
  }

  const langSwitchEl = mainWindow.document.getElementById('mainLangSwitch');
  if (langSwitchEl) langSwitchEl.setAttribute('data-active-lang', nextLang);
  mainWindow.document.querySelectorAll('[data-lang-switch]').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-lang-switch') === nextLang);
  });

  if (langAnimTimer) mainWindow.clearTimeout(langAnimTimer);
  mainWindow.document.body.classList.add('lang-switching');
  if (pipWindow && !pipWindow.closed) {
    pipWindow.document.body.classList.add('lang-switching');
  }

  langAnimTimer = mainWindow.setTimeout(() => {
    applyLanguageContent(nextLang, persistPreference);
    mainWindow.requestAnimationFrame(() => {
      mainWindow.document.body.classList.remove('lang-switching');
      if (pipWindow && !pipWindow.closed) {
        pipWindow.document.body.classList.remove('lang-switching');
      }
    });
  }, 140);
}

// === INDEXED-DB FOR PERSISTENT FOLDER HANDLE, BASELINE & VERSION HISTORY ===
function openHandleDB() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in mainWindow)) return reject(new Error('IndexedDB not supported'));
    const req = mainWindow.indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveDirHandleToDB(handle) {
  try {
    const db = await openHandleDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(handle, HANDLE_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {}
}

async function getDirHandleFromDB() {
  try {
    const db = await openHandleDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(HANDLE_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch (e) {
    return null;
  }
}

async function clearDirHandleFromDB() {
  try {
    const db = await openHandleDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.delete(HANDLE_KEY);
      store.delete(BASELINE_KEY);
      store.delete(VERSION_HISTORY_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {}
}

async function saveBaselineSnapshotToDB() {
  if (!dirHandle) return;
  try {
    const db = await openHandleDB();
    const payload = {
      folderName: dirHandle.name,
      entries: Array.from(aiBaselineSnapshot.entries()),
      dirs: Array.from(aiBaselineDirs)
    };
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(payload, BASELINE_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {}
}

async function saveVersionHistoryToDB() {
  if (!dirHandle) return;
  try {
    const db = await openHandleDB();
    const payload = {
      folderName: dirHandle.name,
      undoTargetVersionId,
      versions: versionHistory
    };
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(payload, VERSION_HISTORY_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {}
}

async function loadVersionHistoryFromDB(folderName) {
  try {
    const db = await openHandleDB();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(VERSION_HISTORY_KEY);
      req.onsuccess = () => {
        const data = req.result;
        if (data && data.folderName === folderName && Array.isArray(data.versions)) {
          resolve(data);
        } else {
          resolve(null);
        }
      };
      req.onerror = () => resolve(null);
    });
  } catch (e) {
    return null;
  }
}

function getUncheckedSet() {
  try {
    const raw = mainWindow.localStorage.getItem(STORAGE_KEYS.UNCHECKED);
    return new Set(raw ? JSON.parse(raw) : []);
  } catch (e) {
    return new Set();
  }
}

function saveUncheckedSet() {
  try {
    const doc = getDoc();
    const checks = doc.querySelectorAll('.file-chk');
    const unchecked = [];
    checks.forEach(chk => {
      const row = chk.closest('.file-item');
      if (row) row.classList.toggle('is-unchecked', !chk.checked);
      const item = scannedFiles[Number(chk.getAttribute('data-idx'))];
      if (item && !chk.checked) unchecked.push(item.path);
    });
    mainWindow.localStorage.setItem(STORAGE_KEYS.UNCHECKED, JSON.stringify(unchecked));
    updateSelectedCountHeader();
  } catch (e) {}
}

// === PROMPT & SETTINGS STATE ===
function updatePromptClearBtnUI() {
  const doc = getDoc();
  const promptEl = doc.getElementById('userPromptInput');
  const clearBtn = doc.getElementById('clearPromptBtn');
  if (!promptEl || !clearBtn) return;

  const hasText = promptEl.value.length > 0;
  clearBtn.classList.toggle('show', hasText);
  promptEl.classList.toggle('has-text', hasText);
}

function clearPromptInput(focusField = true) {
  const doc = getDoc();
  const promptEl = doc.getElementById('userPromptInput');
  if (!promptEl) return;
  promptEl.value = '';
  savePromptState();
  if (focusField) promptEl.focus();
}

function savePromptState() {
  try {
    const doc = getDoc();
    const promptEl = doc.getElementById('userPromptInput');
    const sysChk = doc.getElementById('includePromptChk');
    const limitSelect = doc.getElementById('outputLimitSelect');
    if (promptEl) mainWindow.localStorage.setItem(STORAGE_KEYS.PROMPT, promptEl.value);
    if (sysChk) mainWindow.localStorage.setItem(STORAGE_KEYS.SYSPROMPT, sysChk.checked ? '1' : '0');
    if (limitSelect && VALID_OUTPUT_LIMITS.includes(limitSelect.value)) {
      mainWindow.localStorage.setItem(STORAGE_KEYS.OUTPUT_LIMIT, limitSelect.value);
    }
    updatePromptClearBtnUI();
    updateOutputLimitIconUI();
  } catch (e) {}
}

function restorePromptState() {
  try {
    const doc = getDoc();
    const savedPrompt = mainWindow.localStorage.getItem(STORAGE_KEYS.PROMPT);
    const savedSys = mainWindow.localStorage.getItem(STORAGE_KEYS.SYSPROMPT);
    const savedLimit = mainWindow.localStorage.getItem(STORAGE_KEYS.OUTPUT_LIMIT);
    const savedCollapsed = mainWindow.localStorage.getItem(STORAGE_KEYS.COLLAPSED);

    if (savedPrompt !== null && doc.getElementById('userPromptInput')) {
      doc.getElementById('userPromptInput').value = savedPrompt;
    }
    if (savedSys !== null && doc.getElementById('includePromptChk')) {
      doc.getElementById('includePromptChk').checked = (savedSys !== '0');
    }
    if (doc.getElementById('outputLimitSelect')) {
      doc.getElementById('outputLimitSelect').value = VALID_OUTPUT_LIMITS.includes(savedLimit) ? savedLimit : 'standard';
    }
    isFileDrawerCollapsed = (savedCollapsed === '1');
    updatePromptClearBtnUI();
    updateOutputLimitIconUI();
  } catch (e) {}
}

// === FOLDER CONNECTION & SESSION INITIALIZATION ===
async function verifyRootFolderExists(handle) {
  if (!handle) return false;
  try {
    const perm = await handle.queryPermission({ mode: 'readwrite' });
    if (perm !== 'granted') return false;
    const iter = handle.entries();
    await iter.next();
    return true;
  } catch (err) {
    return false;
  }
}

async function handleMissingRootFolder(customName = '') {
  const missingName = customName || (dirHandle ? dirHandle.name : '') || (pendingSavedHandle ? pendingSavedHandle.name : 'Project');
  await disconnectFolder(true, missingName);
}

async function initSavedSession() {
  cleanUrlHash();
  let initialLang = 'en';
  let savedView = 'workspace';
  try {
    const storedLang = mainWindow.localStorage.getItem(STORAGE_KEYS.LANG);
    if (storedLang === 'nl' || storedLang === 'en') {
      initialLang = storedLang;
    }
    savedView = mainWindow.localStorage.getItem(STORAGE_KEYS.VIEW) || 'workspace';
  } catch (e) {}

  restorePromptState();
  setLanguage(initialLang, false, false);
  switchPageView(savedView);
  updateFolderDependentVisibility();

  const savedHandle = await getDirHandleFromDB();
  if (!savedHandle) return;

  try {
    const perm = await savedHandle.queryPermission({ mode: 'readwrite' });
    if (perm === 'granted') {
      const exists = await verifyRootFolderExists(savedHandle);
      if (!exists) {
        await handleMissingRootFolder(savedHandle.name);
        return;
      }
      await activateConnectedFolder(savedHandle, true, 'none');
    } else {
      pendingSavedHandle = savedHandle;
      const doc = getDoc();
      doc.getElementById('connDot').className = 'status-dot pending';
      doc.getElementById('pipConnDot').className = 'status-dot pending';
      doc.getElementById('connLabel').textContent = t('saved_folder_badge', { name: savedHandle.name });
      doc.getElementById('pipConnName').textContent = t('saved_folder_badge', { name: savedHandle.name });
      doc.getElementById('reconnectText').textContent = t('reconnect_ready', { name: savedHandle.name });
      doc.getElementById('reconnectBtn').textContent = t('reconnect_btn', { name: savedHandle.name });
      doc.getElementById('reconnectBox').classList.add('show');
    }
  } catch (e) {}
}

async function reconnectSavedFolder() {
  if (!pendingSavedHandle) return selectFolder();
  try {
    const perm = await pendingSavedHandle.requestPermission({ mode: 'readwrite' });
    if (perm === 'granted') {
      const handleToActivate = pendingSavedHandle;
      const exists = await verifyRootFolderExists(handleToActivate);
      if (!exists) {
        await handleMissingRootFolder(handleToActivate.name);
        return;
      }
      pendingSavedHandle = null;
      await activateConnectedFolder(handleToActivate, true, 'connect');
    } else {
      showStatus('folderStatus', 'warn', t('st_perm_denied_title'), t('st_perm_denied_desc'));
    }
  } catch (err) {
    showStatus('folderStatus', 'error', t('st_restore_err_title'), t('st_restore_err_desc'));
  }
}

async function activateConnectedFolder(handle, preserveChecks = false, notificationMode = 'connect') {
  stopAutoRefreshWatcher();
  await waitForScanToFinish();
  lastFolderConnectTimestamp = Date.now();
  dirHandle = handle;
  pendingSavedHandle = null;
  scannedFiles = [];
  aiBaselineSnapshot.clear();
  aiBaselineDirs.clear();
  hasBaselineInitialized = false;
  lastRestoredVersionMeta = null;

  // Load saved version history for this folder if available
  const savedHistoryData = await loadVersionHistoryFromDB(handle.name);
  if (savedHistoryData) {
    versionHistory = savedHistoryData.versions;
    undoTargetVersionId = savedHistoryData.undoTargetVersionId || null;
  } else {
    versionHistory = [];
    undoTargetVersionId = null;
  }

  const doc = getDoc();
  doc.getElementById('connDot').className = 'status-dot connected';
  doc.getElementById('pipConnDot').className = 'status-dot connected';
  doc.getElementById('connLabel').textContent = handle.name;
  doc.getElementById('pipConnName').textContent = handle.name;
  doc.getElementById('autoSyncBadge').classList.add('active');
  doc.getElementById('folderCtrlBtns').classList.add('active');
  doc.getElementById('pipFolderCtrlRow').classList.add('active');
  doc.getElementById('reconnectBox').classList.remove('show');
  doc.getElementById('folderEmptyState').style.display = 'none';

  updateFolderDependentVisibility();

  if (notificationMode === 'connect') {
    triggerWorkspaceAnimation('connect');
  }

  await saveDirHandleToDB(handle);
  await refreshFileList(preserveChecks, notificationMode, true);
  renderVersionHistoryUI();
  lastFolderConnectTimestamp = Date.now();
  startAutoRefreshWatcher();
}

// === DOM HELPERS & TOAST NOTIFICATIONS ===
function getDoc() {
  return (pipWindow && !pipWindow.closed) ? pipWindow.document : mainWindow.document;
}

function getActiveNavigator() {
  return (pipWindow && !pipWindow.closed) ? pipWindow.navigator : mainWindow.navigator;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, s => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[s]));
}

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  if (bytes < 1024) return bytes + ' B';
  const kb = bytes / 1024;
  if (kb < 1024) return kb.toFixed(kb >= 10 ? 0 : 1) + ' KB';
  return (kb / 1024).toFixed(1) + ' MB';
}

function formatTimeHMS(timestamp) {
  try {
    const d = new Date(timestamp);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  } catch (e) {
    return '--:--:--';
  }
}

function triggerFileDownload(filename, contentStr, mimeType = 'text/plain;charset=utf-8') {
  const doc = getDoc();
  const blob = new Blob([contentStr], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = doc.createElement('a');
  a.href = url;
  a.download = filename;
  doc.body.appendChild(a);
  a.click();
  doc.body.removeChild(a);
  mainWindow.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function getActiveToastContainer() {
  const doc = getDoc();
  let container = doc.getElementById('toastContainer');
  if (!container) {
    container = doc.createElement('div');
    container.id = 'toastContainer';
    container.className = 'toast-container';
    doc.body.appendChild(container);
  }
  return container;
}

function clearStatusTimer(id) {
  if (statusTimers[id]) {
    if (statusTimers[id].autoTimer) mainWindow.clearTimeout(statusTimers[id].autoTimer);
    if (statusTimers[id].fadeTimer) mainWindow.clearTimeout(statusTimers[id].fadeTimer);
    delete statusTimers[id];
  }
}

function scheduleAutoDismiss(id, delayMs = 3800) {
  clearStatusTimer(id);
  const autoTimer = mainWindow.setTimeout(() => {
    hideStatus(id, true);
  }, delayMs);
  statusTimers[id] = { autoTimer, fadeTimer: null };
}

function showStatus(id, type, title, details = '', logItems = []) {
  clearStatusTimer(id);

  const container = getActiveToastContainer();
  const doc = getDoc();
  const toastId = `toast_${id}`;

  let toastEl = doc.getElementById(toastId);
  if (!toastEl) {
    toastEl = doc.createElement('div');
    toastEl.id = toastId;
    container.appendChild(toastEl);
  }

  const iconMap = {
    success: SVG_ICONS.checkCircle,
    info: SVG_ICONS.infoCircle,
    warn: SVG_ICONS.warnTriangle,
    error: SVG_ICONS.errorCircle
  };
  const iconSvg = iconMap[type] || SVG_ICONS.infoCircle;

  let html = `<button type="button" class="status-close-btn" data-close-status="${escapeHtml(id)}" aria-label="${escapeHtml(t('status_close_aria'))}">${SVG_ICONS.closeX}</button>`;
  html += `<div class="status-title">${iconSvg}<span>${escapeHtml(title)}</span></div>`;
  if (details) {
    html += `<div class="status-details">${escapeHtml(details)}</div>`;
  }
  if (Array.isArray(logItems) && logItems.length > 0) {
    html += `<ul class="status-log-list">` +
      logItems.map(item => `<li>${escapeHtml(item)}</li>`).join('') +
      `</ul>`;
  }

  toastEl.className = 'toast-item';
  void toastEl.offsetWidth;
  toastEl.innerHTML = html;
  toastEl.className = `toast-item ${type}`;

  toastEl.onmouseenter = () => clearStatusTimer(id);
  toastEl.onmouseleave = () => scheduleAutoDismiss(id, 2200);

  scheduleAutoDismiss(id, 3800);
}

function hideStatus(id, smooth = false) {
  clearStatusTimer(id);
  const toastId = `toast_${id}`;
  const elMain = mainWindow.document.getElementById(toastId);
  const elPip = (pipWindow && !pipWindow.closed) ? pipWindow.document.getElementById(toastId) : null;
  const targets = [elMain, elPip].filter(Boolean);

  targets.forEach(el => {
    if (smooth) {
      el.classList.add('closing');
      const fadeTimer = mainWindow.setTimeout(() => {
        el.remove();
      }, 240);
      statusTimers[id] = { autoTimer: null, fadeTimer };
    } else {
      el.remove();
    }
  });
}

// === MASTER SYSTEM PROMPT GENERATOR ===
function getMasterSystemPrompt() {
  const limitRule = getOutputLimitInstruction();

  if (currentLang === 'nl') {
    return `=== SYSTEEM-INSTRUCTIE: LIVE PROJECT-AGENT & SMART DIFF UPDATER (AI FOLDER SYNC) ===
Je werkt via mijn "AI Folder Sync" tool rechtstreeks in mijn lokale projectmap (inclusief alle submappen en alle programmeertalen).

1. HOE JE MIJN PROJECT LEEST & BEGRIJPT:
- Onder "=== VOLLEDIGE MAPPEN- EN SUBMAPPEN-STRUCTUUR ===" zie je alle mappen ([MAP]) en bestanden/afbeeldingen ([BESTAND]) in mijn project.
- Onder "=== GESELECTEERDE BESTANDSINHOUD ===" zie je de volledige broncode van mijn bestanden tussen "--- START BESTAND: pad ---" en "--- EINDE BESTAND: pad ---".
- Onder "=== MIJN OPDRACHT / PROMPT ===" staat wat je nu voor mij moet bouwen, uitbreiden of aanpassen.
- LEEG PROJECT (0 BESTANDEN): Als er staat dat het project nog helemaal leeg is ([LEEG PROJECT - 0 BESTANDEN]), bouw dan een compleet nieuw project vanaf nul op basis van mijn opdracht en maak alle benodigde mappen en bestanden aan via het JSON-blok.

2. LIVE GEHEUGEN BIJHOUDEN (CRUCIAAL!):
- Onthoud mijn volledige project gedurende ons hele gesprek.
- Elke keer dat jij mij een JSON-update stuurt, werk je jouw eigen geheugen direct bij naar die NIEUWE situatie.
- Als ik tussentijds zelf handmatig mappen of bestanden aanpas, hernoem, verplaats, toevoeg, verwijder of een eerdere versie herstel en deze meestuur onder "=== TUSSENTIJDSE HANDMATIGE LOKALE WIJZIGINGEN ===", werk je in jouw geheugen direct de mapnamen, bestandsnamen en de nieuwste code bij voordat je mijn opdracht uitvoert.

3. SLIMME JSON-UPDATES & OUTPUT-LIMIET:
Omdat je mijn bestaande code al volledig hebt ontvangen:
- LAAT ONGEWIJZIGDE BESTANDEN VOLLEDIG WEG uit de JSON!
- HOUD JE JSON ZO COMPACT MOGELIJK: Gebruik voor elke wijziging in een bestaand bestand ALTIJD "edit" met minimale {"search": "...", "replace": "..."} blokken (slechts 2 tot 4 unieke omliggende anker-regels in "search").
- ${limitRule}
- NIEUWE BESTANDEN MAKEN ("files"): Gebruik "files" ALLEEN voor gloednieuwe bestanden die nog niet bestonden.
- MAPPEN MAKEN ("folders"): Array met nieuwe mappen/submappen (bijv. ["css", "js"]).
- BESTANDEN VERPLAATSEN/HERNOEMEN ("move"): Object om bestaande bestanden te verplaatsen (bijv. {"oud.css": "css/style.css"}).
- BESTANDEN VERWIJDEREN ("delete"): Array met paden van bestanden of mappen die weg moeten.

4. VERPLICHT ANTWOORDFORMAAT:
Leg eerst kort en helder uit wat je hebt gebouwd of aangepast. Eindig je antwoord bij elke wijziging ALTIJD met exact één volledig afgesloten, geldig JSON-codeblok (\`\`\`json ... \`\`\`):

\`\`\`json
{
  "folders": ["css", "js"],
  "move": {
    "style.css": "css/style.css"
  },
  "files": {
    "js/nieuw-bestand.js": "// Volledige code voor dit gloednieuwe bestand..."
  },
  "edit": {
    "index.html": [
      {
        "search": "exacte bestaande regels uit index.html...",
        "replace": "nieuwe of aangepaste regels voor index.html..."
      }
    ]
  },
  "delete": ["oud-bestand.txt"]
}
\`\`\``;
  }

  return `=== SYSTEM INSTRUCTION: LIVE PROJECT AGENT & SMART DIFF UPDATER (AI FOLDER SYNC) ===
You are working directly inside my local project folder (including all subfolders and all programming languages) via my "AI Folder Sync" tool.

1. HOW TO READ & UNDERSTAND MY PROJECT:
- Under "=== FULL FOLDER AND SUBFOLDER STRUCTURE ===" you can see all folders ([DIR]) and files/assets ([FILE]) in my project.
- Under "=== SELECTED FILE CONTENTS ===" you can see the full source code of my files between "--- START FILE: path ---" and "--- END FILE: path ---".
- Under "=== MY TASK / PROMPT ===" you will find what you need to build, expand, or modify for me right now.
- EMPTY PROJECT (0 FILES): If it states that the project is completely empty ([EMPTY PROJECT - 0 FILES]), build a complete new project from scratch based on my prompt and create all required folders and files via the JSON block.

2. MAINTAIN LIVE MEMORY (CRUCIAL!):
- Remember my entire project throughout our conversation.
- Every time you send me a JSON update, immediately update your internal memory of the files to reflect that NEW state.
- If I manually edit, rename, move, add, delete folders/files or restore an earlier version locally between messages and send them under "=== MANUAL LOCAL CHANGES SINCE LAST SYNC ===", immediately update your internal memory with those new folder/file paths and latest file contents before executing my new prompt.

3. SMART JSON UPDATES & OUTPUT LIMIT:
Because you have already received my existing code in full:
- COMPLETELY OMIT UNCHANGED FILES from the JSON!
- KEEP YOUR JSON AS COMPACT AS POSSIBLE: For every change in an existing file, ALWAYS use "edit" with minimal {"search": "...", "replace": "..."} blocks (include only 2 to 4 unique surrounding anchor lines in "search").
- ${limitRule}
- CREATING NEW FILES ("files"): Use "files" ONLY for brand-new files that did not exist yet.
- CREATING FOLDERS ("folders"): Array of new folders/subfolders (e.g., ["css", "js"]).
- MOVING/RENAMING FILES ("move"): Object to move or rename existing files (e.g., {"old.css": "css/style.css"}).
- DELETING FILES ("delete"): Array of file or folder paths to delete.

4. REQUIRED RESPONSE FORMAT:
First explain briefly and clearly what you built or modified. End your response for every change ALWAYS with exactly one complete, valid JSON code block (\`\`\`json ... \`\`\`):

\`\`\`json
{
  "folders": ["css", "js"],
  "move": {
    "style.css": "css/style.css"
  },
  "files": {
    "js/new-file.js": "// Full code for this brand-new file..."
  },
  "edit": {
    "index.html": [
      {
        "search": "exact existing lines from index.html...",
        "replace": "new or modified lines for index.html..."
      }
    ]
  },
  "delete": ["old-file.txt"]
}
\`\`\``;
}

// === FLOATING PICTURE-IN-PICTURE WINDOW ===
function injectStylesIntoPiPWindow(targetPipWin) {
  const coreStylesEl = mainWindow.document.getElementById('coreStyles');
  if (coreStylesEl) {
    const clone = coreStylesEl.cloneNode(true);
    if (clone.tagName === 'LINK' && coreStylesEl.href) {
      clone.href = coreStylesEl.href;
    }
    targetPipWin.document.head.appendChild(clone);
  }

  // Also inline active CSS rules for instant zero-FOUC rendering in PiP
  try {
    let cssText = '';
    for (const sheet of Array.from(mainWindow.document.styleSheets)) {
      try {
        for (const rule of Array.from(sheet.cssRules)) {
          cssText += rule.cssText + '\n';
        }
      } catch (corsErr) {}
    }
    if (cssText) {
      const inlineStyle = targetPipWin.document.createElement('style');
      inlineStyle.textContent = cssText;
      targetPipWin.document.head.appendChild(inlineStyle);
    }
  } catch (e) {}
}

async function toggleFloatingPiP() {
  if (!('documentPictureInPicture' in mainWindow)) {
    showStatus('pipNotice', 'warn', t('st_pip_unsupported_title'), t('st_pip_unsupported_desc'));
    return;
  }
  if (pipWindow && !pipWindow.closed) {
    closeFloatingPiP();
    return;
  }
  try {
    const newPipWin = await mainWindow.documentPictureInPicture.requestWindow({ width: 420, height: 630 });
    pipWindow = newPipWin;

    injectStylesIntoPiPWindow(newPipWin);
    newPipWin.document.body.classList.add('pip-mode');

    const pipToastContainer = newPipWin.document.createElement('div');
    pipToastContainer.id = 'toastContainer';
    pipToastContainer.className = 'toast-container';
    newPipWin.document.body.appendChild(pipToastContainer);

    newPipWin.document.body.addEventListener('click', (e) => {
      const closeBtn = e.target.closest('[data-close-status]');
      if (closeBtn) {
        hideStatus(closeBtn.getAttribute('data-close-status'), true);
      }
    });

    newPipWin.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeDisconnectConfirmModal();
      }
    });

    isFileDrawerCollapsed = true;

    const panel = mainWindow.document.getElementById('workspacePanel');
    panel.classList.add('lang-transition-target');
    newPipWin.document.body.appendChild(panel);
    mainWindow.document.getElementById('pipPlaceholder').classList.add('show');

    applyTranslationsToRoot(newPipWin.document);
    updateFolderDependentVisibility();
    renderFileTreeUI();
    renderVersionHistoryUI();
    updatePromptClearBtnUI();
    updateOutputLimitIconUI();

    newPipWin.addEventListener('pagehide', () => {
      restorePanelFromPiP(newPipWin);
    });
  } catch (err) {
    showStatus('pipNotice', 'error', t('st_pip_err_title'), err.message);
  }
}

function restorePanelFromPiP(closingWin = null) {
  const targetWin = closingWin || pipWindow;
  const holder = mainWindow.document.getElementById('workspaceHolder');
  const panel = (targetWin && targetWin.document && targetWin.document.getElementById('workspacePanel'))
    || mainWindow.document.getElementById('workspacePanel');

  if (panel && holder && !holder.contains(panel)) {
    holder.appendChild(panel);
  }
  mainWindow.document.getElementById('pipPlaceholder').classList.remove('show');
  if (!closingWin || pipWindow === closingWin) {
    pipWindow = null;
  }

  try {
    isFileDrawerCollapsed = (mainWindow.localStorage.getItem(STORAGE_KEYS.COLLAPSED) === '1');
  } catch (e) {}

  applyTranslationsToRoot(mainWindow.document);
  updateFolderDependentVisibility();
  updateFileDrawerToggleUI();
  renderVersionHistoryUI();
  updatePromptClearBtnUI();
  updateOutputLimitIconUI();
}

function closeFloatingPiP() {
  const activePiP = pipWindow;
  restorePanelFromPiP(activePiP);
  if (activePiP && !activePiP.closed) {
    try { activePiP.close(); } catch (e) {}
  }
}

// === COPY SYSTEM PROMPT & MANAGE PROJECT FOLDER ===
async function copyPrompt() {
  try {
    await writeTextToClipboard(getMasterSystemPrompt());
    flashButtonSuccess(getDoc().getElementById('copySysPromptBtn'));
    showStatus('exportStatus', 'info', t('st_sys_copied_title'), t('st_sys_copied_desc'));
  } catch (e) {
    showStatus('exportStatus', 'error', t('st_copy_err_title'), e.message);
  }
}

async function selectFolder() {
  try {
    const pickerWindow = (pipWindow && !pipWindow.closed && pipWindow.showDirectoryPicker) ? pipWindow : mainWindow;
    if (!pickerWindow.showDirectoryPicker && !mainWindow.showDirectoryPicker) {
      return showStatus('folderStatus', 'error', t('st_browser_unsupported_title'), t('st_browser_unsupported_desc'));
    }
    const pickerFn = pickerWindow.showDirectoryPicker
      ? pickerWindow.showDirectoryPicker.bind(pickerWindow)
      : mainWindow.showDirectoryPicker.bind(mainWindow);

    const selectedHandle = await pickerFn({ mode: 'readwrite' });
    mainWindow.localStorage.removeItem(STORAGE_KEYS.UNCHECKED);
    await activateConnectedFolder(selectedHandle, false, 'connect');
  } catch (err) {
    if (err && err.name === 'AbortError') return;
    showStatus('folderStatus', 'error', t('st_folder_open_err_title'), err ? err.message : t('st_unknown_err'));
  }
}

function openDisconnectConfirmModal() {
  if (!dirHandle && !pendingSavedHandle) return;
  const doc = getDoc();
  const modal = doc.getElementById('disconnectConfirmModal');
  const intro = doc.getElementById('disconnectModalIntro');
  const folderName = dirHandle ? dirHandle.name : (pendingSavedHandle ? pendingSavedHandle.name : '');
  if (intro) {
    intro.textContent = t('disc_modal_intro', { name: folderName });
  }
  if (modal) {
    modal.classList.add('show');
  }
}

function closeDisconnectConfirmModal() {
  const doc = getDoc();
  doc.getElementById('disconnectConfirmModal')?.classList.remove('show');
}

async function disconnectFolder(isMissingOnDisk = false, missingFolderName = '') {
  closeDisconnectConfirmModal();
  stopAutoRefreshWatcher();
  await waitForScanToFinish();
  triggerWorkspaceAnimation('disconnect');
  await yieldFrame(200);

  dirHandle = null;
  pendingSavedHandle = null;
  scannedFiles = [];
  aiBaselineSnapshot.clear();
  aiBaselineDirs.clear();
  hasBaselineInitialized = false;
  versionHistory = [];
  undoTargetVersionId = null;
  lastRestoredVersionMeta = null;
  await clearDirHandleFromDB();
  mainWindow.localStorage.removeItem(STORAGE_KEYS.UNCHECKED);

  const doc = getDoc();
  doc.getElementById('connDot').className = 'status-dot';
  doc.getElementById('pipConnDot').className = 'status-dot';
  doc.getElementById('connLabel').textContent = t('no_folder_linked');
  doc.getElementById('pipConnName').textContent = t('no_folder_linked');
  doc.getElementById('autoSyncBadge').classList.remove('active');
  doc.getElementById('folderCtrlBtns').classList.remove('active');
  doc.getElementById('pipFolderCtrlRow').classList.remove('active');
  doc.getElementById('reconnectBox').classList.remove('show');
  doc.getElementById('folderEmptyState').style.display = 'flex';
  doc.getElementById('fileTreeWrap').classList.remove('show');
  doc.getElementById('fileSelectorBox').innerHTML = '';
  doc.getElementById('truncatedJsonBox')?.classList.remove('show');
  doc.getElementById('manualPastePanel')?.classList.remove('show');
  doc.getElementById('toggleManualPasteBtn')?.classList.remove('active');
  doc.getElementById('toggleManualPasteBtn')?.setAttribute('aria-expanded', 'false');
  doc.getElementById('versionHistoryPanel')?.classList.remove('show');
  doc.getElementById('toggleVersionHistoryBtn')?.classList.remove('active');
  doc.getElementById('toggleVersionHistoryBtn')?.setAttribute('aria-expanded', 'false');

  updateFolderDependentVisibility();
  renderDeltaBannerUI();
  renderVersionHistoryUI();
  hideStatus('updateStatus');
  hideStatus('exportStatus');

  if (isMissingOnDisk) {
    showStatus(
      'folderStatus',
      'warn',
      t('st_folder_missing_title', { name: missingFolderName }),
      t('st_folder_missing_desc')
    );
  } else {
    showStatus('folderStatus', 'info', t('st_folder_closed_title'), t('st_folder_closed_desc'));
  }
}

async function scanDir(handle, path = '') {
  const rawEntries = [];
  for await (const [name, entry] of handle.entries()) {
    if (/^(node_modules|\.git|\.next|dist|build|__pycache__|\.venv|\.DS_Store|Thumbs\.db)$/i.test(name)) continue;
    rawEntries.push({ name, entry });
  }

  rawEntries.sort((a, b) => {
    if (a.entry.kind !== b.entry.kind) {
      return a.entry.kind === 'directory' ? -1 : 1;
    }
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  });

  let entries = [];
  for (const { name, entry } of rawEntries) {
    const fullPath = path ? `${path}/${name}` : name;
    if (entry.kind === 'directory') {
      entries.push({ path: fullPath + '/', kind: 'dir', handle: entry });
      entries = entries.concat(await scanDir(entry, fullPath));
    } else {
      entries.push({ path: fullPath, kind: 'file', handle: entry });
    }
  }
  return entries;
}

// === SMART DIFF-ENGINE HELPERS (PATH, HASHING & CODE SIMILARITY) ===
function splitFilePathParts(filePath) {
  const clean = String(filePath || '').replace(/\\/g, '/').replace(/\/+$/, '');
  const lastSlash = clean.lastIndexOf('/');
  const dir = lastSlash === -1 ? '' : clean.slice(0, lastSlash);
  const baseName = lastSlash === -1 ? clean : clean.slice(lastSlash + 1);
  const lastDot = baseName.lastIndexOf('.');
  const stem = lastDot > 0 ? baseName.slice(0, lastDot) : baseName;
  const ext = lastDot > 0 ? baseName.slice(lastDot + 1).toLowerCase() : '';
  return { dir, baseName, stem: stem.toLowerCase(), ext };
}

function normalizeTextContent(str) {
  return String(str ?? '').replace(/\r\n/g, '\n');
}

function fastStringHash(str) {
  let h = 2166136261;
  const s = String(str || '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

function fastBufferHash(buffer) {
  if (!buffer) return '0';
  const bytes = new Uint8Array(buffer);
  let h = 2166136261 ^ bytes.length;
  const step = Math.max(1, Math.floor(bytes.length / 512));
  for (let i = 0; i < bytes.length; i += step) {
    h ^= bytes[i];
    h = Math.imul(h, 16777619);
  }
  return `${bytes.length}_${(h >>> 0).toString(36)}`;
}

function computeTrigramDiceSimilarity(strA, strB) {
  const a = String(strA || '').trim();
  const b = String(strB || '').trim();
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < 3 || b.length < 3) {
    return a.toLowerCase() === b.toLowerCase() ? 1 : 0;
  }

  const limit = 25000;
  const s1 = a.length > limit ? a.slice(0, limit) : a;
  const s2 = b.length > limit ? b.slice(0, limit) : b;

  const counts = new Map();
  const len1 = s1.length - 2;
  const len2 = s2.length - 2;

  for (let i = 0; i < len1; i++) {
    const tri = s1.slice(i, i + 3);
    counts.set(tri, (counts.get(tri) || 0) + 1);
  }

  let intersection = 0;
  for (let i = 0; i < len2; i++) {
    const tri = s2.slice(i, i + 3);
    const c = counts.get(tri);
    if (c > 0) {
      intersection++;
      counts.set(tri, c - 1);
    }
  }

  return (2 * intersection) / (len1 + len2);
}

function computeCodeSimilarity(contentA, contentB) {
  const normA = normalizeTextContent(contentA);
  const normB = normalizeTextContent(contentB);
  if (normA === normB) return 1;
  if (!normA.trim() || !normB.trim()) return 0;

  const linesA = normA.split('\n').map(l => l.trim()).filter(Boolean);
  const linesB = normB.split('\n').map(l => l.trim()).filter(Boolean);
  let lineDice = 0;

  if (linesA.length > 0 && linesB.length > 0) {
    const lineMap = new Map();
    for (const line of linesA) {
      lineMap.set(line, (lineMap.get(line) || 0) + 1);
    }
    let matchedLines = 0;
    for (const line of linesB) {
      const count = lineMap.get(line);
      if (count > 0) {
        matchedLines++;
        lineMap.set(line, count - 1);
      }
    }
    lineDice = (2 * matchedLines) / (linesA.length + linesB.length);
  }

  const trigramDice = computeTrigramDiceSimilarity(normA, normB);
  return Math.max(lineDice, trigramDice);
}

function areFilesContentIdentical(baseData, currentItem) {
  if (baseData.isText && currentItem.isText && !currentItem.unreadable) {
    return normalizeTextContent(baseData.content) === normalizeTextContent(currentItem.content);
  }
  if (!baseData.isText && !currentItem.isText) {
    return baseData.size === currentItem.size && baseData.lastModified === currentItem.lastModified;
  }
  return false;
}

// =========================================================================
// === VERSION HISTORY & UNDO SYSTEM (FULL PROJECT SNAPSHOTS) ===
// =========================================================================
function computeCurrentScannedFingerprint() {
  if (!dirHandle) return '';
  const dirList = [];
  const fileSigs = [];
  for (const item of scannedFiles) {
    if (item.kind === 'dir') {
      dirList.push(item.path.replace(/\/+$/, ''));
    } else if (item.kind === 'file') {
      if (item.isText && !item.unreadable) {
        const norm = normalizeTextContent(item.content || '');
        fileSigs.push(`${item.path}:t:${norm.length}:${fastStringHash(norm)}`);
      } else {
        fileSigs.push(`${item.path}:b:${item.size || 0}`);
      }
    }
  }
  dirList.sort();
  fileSigs.sort();
  return `D[${dirList.join('|')}]F[${fileSigs.join('|')}]`;
}

function computeSnapshotFingerprint(dirs, files) {
  const dirList = [...dirs].map(d => d.replace(/\/+$/, '')).sort();
  const fileSigs = files.map(f => {
    if (f.isText) {
      const norm = normalizeTextContent(f.content || '');
      return `${f.path}:t:${norm.length}:${fastStringHash(norm)}`;
    }
    return `${f.path}:b:${f.size || 0}`;
  }).sort();
  return `D[${dirList.join('|')}]F[${fileSigs.join('|')}]`;
}

async function buildCurrentDiskSnapshot(kind = 'manual', changedFiles = []) {
  if (!dirHandle) return null;
  const entries = await scanDir(dirHandle);
  const dirs = [];
  const files = [];

  for (const entry of entries) {
    if (entry.kind === 'dir') {
      const cleanD = entry.path.replace(/\/+$/, '');
      if (cleanD) dirs.push(cleanD);
    } else if (entry.kind === 'file') {
      try {
        const f = await entry.handle.getFile();
        const isText = await detectIfFileIsText(entry.path, f);
        if (isText) {
          const txt = normalizeTextContent(await f.text());
          files.push({
            path: entry.path,
            isText: true,
            content: txt,
            buffer: null,
            size: f.size || 0
          });
        } else {
          const buf = f.size <= 15 * 1024 * 1024 ? await f.arrayBuffer() : null;
          files.push({
            path: entry.path,
            isText: false,
            content: '',
            buffer: buf,
            size: f.size || 0,
            binaryHash: fastBufferHash(buf)
          });
        }
      } catch (e) {}
    }
  }

  const fingerprint = computeSnapshotFingerprint(dirs, files);
  const nextNum = versionHistory.length > 0
    ? Math.max(...versionHistory.map(v => v.versionNumber || 0)) + 1
    : 1;

  return {
    id: `ver_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    versionNumber: nextNum,
    timestamp: Date.now(),
    kind,
    changedFiles: Array.from(new Set(changedFiles.filter(Boolean))),
    fileCount: files.length,
    dirs,
    files,
    fingerprint
  };
}

function findVersionByFingerprint(fp) {
  if (!fp) return null;
  for (let i = versionHistory.length - 1; i >= 0; i--) {
    if (versionHistory[i].fingerprint === fp) {
      return versionHistory[i];
    }
  }
  return null;
}

function addVersionToHistory(snapshot) {
  if (!snapshot) return null;
  const existing = findVersionByFingerprint(snapshot.fingerprint);
  if (existing) {
    return existing;
  }
  versionHistory.push(snapshot);
  if (versionHistory.length > MAX_SAVED_VERSIONS) {
    versionHistory.shift();
  }
  saveVersionHistoryToDB();
  return snapshot;
}

function formatVersionLabel(ver) {
  if (!ver) return '';
  if (ver.kind === 'initial') {
    return t('vh_lbl_initial', { count: ver.fileCount || 0 });
  }
  const list = Array.isArray(ver.changedFiles) ? ver.changedFiles : [];
  if (list.length > 0) {
    const shortNames = list.slice(0, 2).map(p => {
      const clean = String(p).replace(/\/+$/, '');
      const parts = clean.split('/');
      return parts[parts.length - 1] || clean;
    });
    const extra = list.length > 2 ? ` (+${list.length - 2})` : '';
    const filesStr = shortNames.join(', ') + extra;
    return ver.kind === 'ai_update'
      ? t('vh_lbl_update', { files: filesStr })
      : t('vh_lbl_manual', { files: filesStr });
  }
  return t('vh_lbl_manual_generic', { count: ver.fileCount || 0 });
}

function resolveUndoTargetVersion() {
  if (!dirHandle || versionHistory.length === 0) return null;
  const currentFp = computeCurrentScannedFingerprint();

  if (undoTargetVersionId) {
    const explicitTarget = versionHistory.find(v => v.id === undoTargetVersionId);
    if (explicitTarget && explicitTarget.fingerprint !== currentFp) {
      return explicitTarget;
    }
  }

  const currentIdx = versionHistory.findIndex(v => v.fingerprint === currentFp);
  if (currentIdx > 0) {
    return versionHistory[currentIdx - 1];
  }
  if (currentIdx === -1 && versionHistory.length > 0) {
    return versionHistory[versionHistory.length - 1];
  }
  return null;
}

function renderVersionHistoryUI() {
  const doc = getDoc();
  const countBadge = doc.getElementById('versionCountBadge');
  const undoBtn = doc.getElementById('undoLastUpdateBtn');
  const listEl = doc.getElementById('versionHistoryList');

  if (countBadge) {
    countBadge.textContent = String(versionHistory.length);
  }

  const undoTarget = resolveUndoTargetVersion();
  if (undoBtn) {
    undoBtn.disabled = !undoTarget || isMutatingDisk;
  }

  if (!listEl) return;

  if (versionHistory.length === 0) {
    listEl.innerHTML = `<div class="version-empty-msg">${escapeHtml(t('vh_empty_msg'))}</div>`;
    return;
  }

  const currentFp = computeCurrentScannedFingerprint();
  let html = '';

  for (let i = versionHistory.length - 1; i >= 0; i--) {
    const ver = versionHistory[i];
    const isCurrent = (ver.fingerprint === currentFp);
    const timeStr = formatTimeHMS(ver.timestamp);
    const labelStr = formatVersionLabel(ver);
    const activeClass = isCurrent ? ' is-active-version' : '';
    const activeBadgeHtml = isCurrent
      ? `<span class="version-active-pill">${escapeHtml(t('vh_active_badge'))}</span>`
      : '';

    const btnHtml = isCurrent
      ? `<button type="button" class="btn btn-outline btn-xs" disabled>${SVG_ICONS.check}<span>${escapeHtml(t('vh_btn_current'))}</span></button>`
      : `<button type="button" class="btn btn-outline btn-xs" data-restore-version="${escapeHtml(ver.id)}">${SVG_ICONS.restore}<span>${escapeHtml(t('vh_btn_restore'))}</span></button>`;

    html += `<div class="version-item${activeClass}">
      <div class="version-item-info">
        <div class="version-item-top">
          <span class="version-num-badge">v${ver.versionNumber}</span>
          <span class="version-time-text">${escapeHtml(timeStr)}</span>
          ${activeBadgeHtml}
        </div>
        <div class="version-item-label" title="${escapeHtml(labelStr)}">${escapeHtml(labelStr)}</div>
      </div>
      ${btnHtml}
    </div>`;
  }

  listEl.innerHTML = html;
}

async function waitForScanToFinish() {
  let tries = 0;
  while (isScanningFolder && tries < 60) {
    await yieldFrame(25);
    tries++;
  }
}

async function restoreVersionById(versionId) {
  if (isMutatingDisk || !dirHandle) return;
  const targetVersion = versionHistory.find(v => v.id === versionId);
  if (!targetVersion) return;

  const exists = await verifyRootFolderExists(dirHandle);
  if (!exists) {
    await handleMissingRootFolder(dirHandle.name);
    return;
  }

  await waitForScanToFinish();
  isMutatingDisk = true;

  try {
    // 1. Preserve current disk state in Version History if it contains unsaved manual edits
    const currentFp = computeCurrentScannedFingerprint();
    if (!findVersionByFingerprint(currentFp)) {
      const diffBeforeRestore = getManualChangesAgainstBaseline();
      const manualPaths = [
        ...diffBeforeRestore.modified.map(f => f.path),
        ...diffBeforeRestore.added.map(f => f.path),
        ...diffBeforeRestore.renamed.map(r => r.to),
        ...diffBeforeRestore.renamedModified.map(r => r.to),
        ...diffBeforeRestore.deleted
      ];
      const autoSavedCurrent = await buildCurrentDiskSnapshot(
        versionHistory.length === 0 ? 'initial' : 'manual',
        manualPaths
      );
      addVersionToHistory(autoSavedCurrent);
    }

    // 2. Scan current disk state to determine which files/folders must be removed or updated
    const currentEntries = await scanDir(dirHandle);
    const targetDirSet = new Set(targetVersion.dirs.map(d => d.replace(/\/+$/, '')));
    const targetFileMap = new Map(targetVersion.files.map(f => [f.path, f]));

    const filesToDelete = [];
    const dirsToDelete = [];

    for (const entry of currentEntries) {
      if (entry.kind === 'file') {
        if (!targetFileMap.has(entry.path)) {
          filesToDelete.push(entry.path);
        }
      } else if (entry.kind === 'dir') {
        const cleanD = entry.path.replace(/\/+$/, '');
        if (cleanD && !targetDirSet.has(cleanD)) {
          dirsToDelete.push(cleanD);
        }
      }
    }

    // Sort directories deepest first so nested directories are cleanly removed
    dirsToDelete.sort((a, b) => b.split('/').length - a.split('/').length || b.length - a.length);

    const sortedDirsToCreate = [...targetTargetDirsSorted(targetVersion.dirs)];
    const totalOps = filesToDelete.length + dirsToDelete.length + sortedDirsToCreate.length + targetVersion.files.length;
    let completedOps = 0;

    setLiveProgress(true, 0, Math.max(1, totalOps), `v${targetVersion.versionNumber}`, targetVersion.versionNumber);
    await yieldFrame(18);

    // Step A: Delete files that did not exist in the restored version
    for (const filePath of filesToDelete) {
      completedOps++;
      setLiveProgress(true, completedOps, totalOps, filePath, targetVersion.versionNumber);
      try {
        await removeByPath(dirHandle, filePath);
      } catch (e) {}
    }

    // Step B: Delete folders that did not exist in the restored version
    for (const dirPath of dirsToDelete) {
      completedOps++;
      setLiveProgress(true, completedOps, totalOps, dirPath + '/', targetVersion.versionNumber);
      try {
        await removeByPath(dirHandle, dirPath);
      } catch (e) {}
    }

    // Step C: Recreate all directories from the snapshot
    for (const dirPath of sortedDirsToCreate) {
      completedOps++;
      setLiveProgress(true, completedOps, totalOps, dirPath + '/', targetVersion.versionNumber);
      try {
        const parts = dirPath.split('/').filter(Boolean);
        await getDirRecursive(dirHandle, parts, true);
      } catch (e) {}
    }

    // Step D: Restore all files from the snapshot
    const currentScannedMap = new Map(
      scannedFiles.filter(e => e.kind === 'file').map(e => [e.path, e])
    );

    for (const snapFile of targetVersion.files) {
      completedOps++;
      setLiveProgress(true, completedOps, totalOps, snapFile.path, targetVersion.versionNumber);

      const existingItem = currentScannedMap.get(snapFile.path);
      let needsWrite = true;

      if (existingItem && snapFile.isText && existingItem.isText && !existingItem.unreadable) {
        if (normalizeTextContent(existingItem.content) === normalizeTextContent(snapFile.content)) {
          needsWrite = false;
        }
      }

      if (needsWrite) {
        try {
          const fileHandle = await getFileHandleByPath(dirHandle, snapFile.path, true);
          const writable = await fileHandle.createWritable();
          if (snapFile.isText) {
            await writable.write(snapFile.content);
          } else if (snapFile.buffer) {
            await writable.write(snapFile.buffer);
          }
          await writable.close();
        } catch (e) {}
      }
    }

    const restoredIdx = versionHistory.findIndex(v => v.id === targetVersion.id);
    undoTargetVersionId = restoredIdx > 0 ? versionHistory[restoredIdx - 1].id : null;
    await saveVersionHistoryToDB();

    await refreshFileList(true, 'none', false);
    await yieldFrame(180);
    setLiveProgress(false);

    const postDiff = getManualChangesAgainstBaseline();
    if (postDiff.totalCount > 0) {
      lastRestoredVersionMeta = {
        versionNumber: targetVersion.versionNumber,
        time: formatTimeHMS(targetVersion.timestamp)
      };
    } else {
      lastRestoredVersionMeta = null;
    }

    renderVersionHistoryUI();
    triggerWorkspaceAnimation('refresh');

    const timeFormatted = formatTimeHMS(targetVersion.timestamp);
    const syncMsg = postDiff.totalCount === 0
      ? t('st_ver_restored_sync_clean')
      : t('st_ver_restored_sync_diff', { count: postDiff.totalCount });

    showStatus(
      'updateStatus',
      'success',
      t('st_ver_restored_title', { ver: targetVersion.versionNumber, time: timeFormatted }),
      syncMsg
    );
  } catch (err) {
    setLiveProgress(false);
    showStatus('updateStatus', 'error', t('st_ver_restore_err_title'), err ? err.message : t('st_unknown_err'));
  } finally {
    isMutatingDisk = false;
    renderVersionHistoryUI();
  }
}

function targetTargetDirsSorted(dirs) {
  return [...dirs]
    .map(d => d.replace(/\/+$/, ''))
    .filter(Boolean)
    .sort((a, b) => a.split('/').length - b.split('/').length || a.length - b.length);
}

async function undoLastUpdate() {
  const target = resolveUndoTargetVersion();
  if (!target) return;
  flashButtonSuccess(getDoc().getElementById('undoLastUpdateBtn'));
  await restoreVersionById(target.id);
}

// =========================================================================
// === BASELINE CAPTURE & 6-STAGE SMART DIFF ENGINE ===
// =========================================================================
function captureBaselineSnapshot() {
  aiBaselineSnapshot.clear();
  aiBaselineDirs.clear();
  for (const item of scannedFiles) {
    if (item.kind === 'dir') {
      const cleanDir = item.path.replace(/\/+$/, '');
      if (cleanDir) aiBaselineDirs.add(cleanDir);
    } else if (item.kind === 'file') {
      aiBaselineSnapshot.set(item.path, {
        isText: !!item.isText,
        content: item.content || '',
        size: item.size || 0,
        lastModified: item.lastModified || 0
      });
      const segs = item.path.split('/').filter(Boolean);
      for (let i = 1; i < segs.length; i++) {
        aiBaselineDirs.add(segs.slice(0, i).join('/'));
      }
    }
  }
  hasBaselineInitialized = true;
  lastRestoredVersionMeta = null;
  saveBaselineSnapshotToDB();
  renderDeltaBannerUI();
}

function getManualChangesAgainstBaseline() {
  if (!dirHandle || !hasBaselineInitialized) {
    return {
      folderAdded: [],
      folderRenamed: [],
      folderDeleted: [],
      renamed: [],
      renamedModified: [],
      added: [],
      modified: [],
      deleted: [],
      totalCount: 0
    };
  }

  const modified = [];
  const currentFileMap = new Map();
  const currentDirSet = new Set();

  for (const item of scannedFiles) {
    if (item.kind === 'dir') {
      const cleanDir = item.path.replace(/\/+$/, '');
      if (cleanDir) currentDirSet.add(cleanDir);
    } else if (item.kind === 'file') {
      currentFileMap.set(item.path, item);
      const segs = item.path.split('/').filter(Boolean);
      for (let i = 1; i < segs.length; i++) {
        currentDirSet.add(segs.slice(0, i).join('/'));
      }
    }
  }

  const effectiveBaselineDirs = new Set(aiBaselineDirs);
  for (const [oldPath] of aiBaselineSnapshot.entries()) {
    const segs = oldPath.split('/').filter(Boolean);
    for (let i = 1; i < segs.length; i++) {
      effectiveBaselineDirs.add(segs.slice(0, i).join('/'));
    }
  }

  // STAGE 1: Files at the exact same path
  const unmatchedDeletedFiles = new Map();
  const unmatchedAddedFiles = new Map();

  for (const [path, item] of currentFileMap.entries()) {
    if (aiBaselineSnapshot.has(path)) {
      const base = aiBaselineSnapshot.get(path);
      if (!areFilesContentIdentical(base, item)) {
        modified.push(item);
      }
    } else {
      unmatchedAddedFiles.set(path, item);
    }
  }

  for (const [oldPath, baseData] of aiBaselineSnapshot.entries()) {
    if (!currentFileMap.has(oldPath)) {
      unmatchedDeletedFiles.set(oldPath, baseData);
    }
  }

  const disappearedDirs = Array.from(effectiveBaselineDirs)
    .filter(d => d && !currentDirSet.has(d))
    .sort((a, b) => a.split('/').length - b.split('/').length || a.length - b.length);

  const appearedDirs = Array.from(currentDirSet)
    .filter(d => d && !effectiveBaselineDirs.has(d))
    .sort((a, b) => a.split('/').length - b.split('/').length || a.length - b.length);

  const handledOldDirs = new Set();
  const handledNewDirs = new Set();
  const folderRenamed = [];

  // STAGE 2: Smart Subfolder Rename / Move Detection
  if (disappearedDirs.length > 0 && appearedDirs.length > 0) {
    const dirCandidates = [];

    for (const oldDir of disappearedDirs) {
      const oldParts = splitFilePathParts(oldDir);
      const oldDepth = oldDir.split('/').length;
      const oldPrefix = oldDir + '/';

      const oldDirFiles = [];
      for (const [oldPath, baseData] of unmatchedDeletedFiles.entries()) {
        if (oldPath.startsWith(oldPrefix)) {
          oldDirFiles.push({
            oldPath,
            relPath: oldPath.slice(oldPrefix.length),
            baseName: splitFilePathParts(oldPath).baseName,
            ext: splitFilePathParts(oldPath).ext,
            baseData
          });
        }
      }

      const oldSubdirs = disappearedDirs
        .filter(d => d.startsWith(oldPrefix))
        .map(d => d.slice(oldPrefix.length));

      for (const newDir of appearedDirs) {
        const newParts = splitFilePathParts(newDir);
        const newDepth = newDir.split('/').length;
        const newPrefix = newDir + '/';

        const newDirFiles = [];
        const newByRelPath = new Map();
        for (const [newPath, item] of unmatchedAddedFiles.entries()) {
          if (newPath.startsWith(newPrefix)) {
            const relPath = newPath.slice(newPrefix.length);
            const entry = {
              newPath,
              relPath,
              baseName: splitFilePathParts(newPath).baseName,
              ext: splitFilePathParts(newPath).ext,
              item
            };
            newDirFiles.push(entry);
            newByRelPath.set(relPath, entry);
          }
        }

        const newSubdirSet = new Set(
          appearedDirs
            .filter(d => d.startsWith(newPrefix))
            .map(d => d.slice(newPrefix.length))
        );

        let sameRelPathCount = 0;
        for (const ofile of oldDirFiles) {
          if (newByRelPath.has(ofile.relPath)) {
            sameRelPathCount++;
          }
        }

        let contentMatchCount = 0;
        let sameBaseNameCount = 0;
        const usedNewPaths = new Set();

        for (const ofile of oldDirFiles) {
          for (const nfile of newDirFiles) {
            if (usedNewPaths.has(nfile.newPath)) continue;
            if (ofile.baseName === nfile.baseName) {
              sameBaseNameCount++;
            }
            if (areFilesContentIdentical(ofile.baseData, nfile.item)) {
              contentMatchCount++;
              usedNewPaths.add(nfile.newPath);
              break;
            } else if (ofile.baseData.isText && nfile.item.isText && !nfile.item.unreadable) {
              const sim = computeCodeSimilarity(ofile.baseData.content, nfile.item.content);
              if (sim >= 0.35) {
                contentMatchCount += sim;
                usedNewPaths.add(nfile.newPath);
                break;
              }
            }
          }
        }

        let sameSubdirCount = 0;
        for (const sub of oldSubdirs) {
          if (newSubdirSet.has(sub)) sameSubdirCount++;
        }

        const sameParentDir = (oldParts.dir === newParts.dir);
        const sameFolderName = (oldParts.baseName === newParts.baseName);
        const nameSim = computeTrigramDiceSimilarity(oldParts.baseName.toLowerCase(), newParts.baseName.toLowerCase());

        let isValidFolderRename = false;
        if (oldDirFiles.length > 0 && newDirFiles.length > 0) {
          if (sameRelPathCount >= 1 || contentMatchCount >= 0.5) {
            isValidFolderRename = true;
          } else if (sameBaseNameCount >= 1 && (sameParentDir || sameFolderName)) {
            isValidFolderRename = true;
          } else if (
            sameParentDir &&
            oldDirFiles.length === 1 &&
            newDirFiles.length === 1 &&
            oldDirFiles[0].ext === newDirFiles[0].ext
          ) {
            isValidFolderRename = true;
          }
        } else if (oldDirFiles.length === 0 && newDirFiles.length === 0) {
          const sibOldEmpty = disappearedDirs.filter(d => splitFilePathParts(d).dir === oldParts.dir);
          const sibNewEmpty = appearedDirs.filter(d => splitFilePathParts(d).dir === newParts.dir);
          if (sameSubdirCount >= 1 || sameFolderName || (sameParentDir && sibOldEmpty.length === 1 && sibNewEmpty.length === 1)) {
            isValidFolderRename = true;
          }
        }

        if (isValidFolderRename) {
          const score =
            (sameRelPathCount * 5) +
            (contentMatchCount * 4) +
            (sameBaseNameCount * 2) +
            (sameSubdirCount * 2) +
            (sameParentDir ? 2.5 : 0) +
            (sameFolderName ? 2.5 : 0) +
            nameSim;

          dirCandidates.push({
            oldDir,
            newDir,
            minDepth: Math.min(oldDepth, newDepth),
            score
          });
        }
      }
    }

    const outerCandidates = dirCandidates.filter(cand => {
      return !dirCandidates.some(parent =>
        parent !== cand &&
        cand.oldDir.startsWith(parent.oldDir + '/') &&
        cand.newDir.startsWith(parent.newDir + '/') &&
        cand.oldDir.slice(parent.oldDir.length) === cand.newDir.slice(parent.newDir.length)
      );
    });

    outerCandidates.sort((a, b) => a.minDepth - b.minDepth || b.score - a.score);

    for (const cand of outerCandidates) {
      if (handledOldDirs.has(cand.oldDir) || handledNewDirs.has(cand.newDir)) continue;

      handledOldDirs.add(cand.oldDir);
      handledNewDirs.add(cand.newDir);
      for (const d of disappearedDirs) {
        if (d.startsWith(cand.oldDir + '/')) handledOldDirs.add(d);
      }
      for (const d of appearedDirs) {
        if (d.startsWith(cand.newDir + '/')) handledNewDirs.add(d);
      }

      const folderGroup = {
        oldDir: cand.oldDir,
        newDir: cand.newDir,
        from: cand.oldDir + '/',
        to: cand.newDir + '/',
        unchangedCount: 0,
        modifiedCount: 0,
        hasInnerChanges: false
      };

      const oldPrefix = cand.oldDir + '/';
      const newPrefix = cand.newDir + '/';

      for (const [oldPath, baseData] of Array.from(unmatchedDeletedFiles.entries())) {
        if (!oldPath.startsWith(oldPrefix)) continue;
        const relPath = oldPath.slice(oldPrefix.length);
        const expectedNewPath = newPrefix + relPath;

        if (unmatchedAddedFiles.has(expectedNewPath)) {
          const newItem = unmatchedAddedFiles.get(expectedNewPath);
          unmatchedDeletedFiles.delete(oldPath);
          unmatchedAddedFiles.delete(expectedNewPath);

          if (areFilesContentIdentical(baseData, newItem)) {
            folderGroup.unchangedCount++;
          } else {
            folderGroup.modifiedCount++;
            folderGroup.hasInnerChanges = true;
            modified.push(newItem);
          }
        }
      }

      folderRenamed.push(folderGroup);
    }
  }

  // STAGE 3: Individual File Rename / Move Detection
  const rawDeletedList = Array.from(unmatchedDeletedFiles.entries()).map(([path, base]) => ({ path, base }));
  const rawAddedList = Array.from(unmatchedAddedFiles.values());
  const matchedDelIndices = new Set();
  const matchedAddIndices = new Set();
  const renamed = [];
  const renamedModified = [];

  if (rawDeletedList.length > 0 && rawAddedList.length > 0) {
    const exactCandidates = [];

    for (let dIdx = 0; dIdx < rawDeletedList.length; dIdx++) {
      const delEntry = rawDeletedList[dIdx];
      const delParts = splitFilePathParts(delEntry.path);
      const delContentNorm = normalizeTextContent(delEntry.base.content);

      for (let aIdx = 0; aIdx < rawAddedList.length; aIdx++) {
        const addItem = rawAddedList[aIdx];
        const addParts = splitFilePathParts(addItem.path);
        let isExactMatch = false;

        if (delEntry.base.isText && addItem.isText && !addItem.unreadable) {
          const addContentNorm = normalizeTextContent(addItem.content);
          if (delContentNorm === addContentNorm) {
            if (
              delContentNorm.length > 0 ||
              delParts.dir === addParts.dir ||
              delParts.ext === addParts.ext ||
              delParts.baseName === addParts.baseName ||
              (rawDeletedList.length === 1 && rawAddedList.length === 1)
            ) {
              isExactMatch = true;
            }
          }
        } else if (!delEntry.base.isText && !addItem.isText) {
          if (
            delEntry.base.size > 0 &&
            delEntry.base.size === addItem.size &&
            (delParts.ext === addParts.ext || delParts.baseName === addParts.baseName || delEntry.base.lastModified === addItem.lastModified)
          ) {
            isExactMatch = true;
          }
        }

        if (isExactMatch) {
          let tieBreaker = 0;
          if (delParts.baseName === addParts.baseName) tieBreaker += 5;
          if (delParts.dir === addParts.dir) tieBreaker += 4;
          if (delParts.ext === addParts.ext) tieBreaker += 3;
          tieBreaker += computeTrigramDiceSimilarity(delParts.stem, addParts.stem);
          exactCandidates.push({ dIdx, aIdx, tieBreaker });
        }
      }
    }

    exactCandidates.sort((a, b) => b.tieBreaker - a.tieBreaker);
    for (const cand of exactCandidates) {
      if (matchedDelIndices.has(cand.dIdx) || matchedAddIndices.has(cand.aIdx)) continue;
      matchedDelIndices.add(cand.dIdx);
      matchedAddIndices.add(cand.aIdx);
      renamed.push({
        from: rawDeletedList[cand.dIdx].path,
        to: rawAddedList[cand.aIdx].path,
        item: rawAddedList[cand.aIdx]
      });
    }
  }

  if (matchedDelIndices.size < rawDeletedList.length && matchedAddIndices.size < rawAddedList.length) {
    const modCandidates = [];

    const unmatchedDelPerDir = new Map();
    const unmatchedAddPerDir = new Map();
    for (let dIdx = 0; dIdx < rawDeletedList.length; dIdx++) {
      if (matchedDelIndices.has(dIdx)) continue;
      let dir = splitFilePathParts(rawDeletedList[dIdx].path).dir;
      const fg = folderRenamed.find(f => dir === f.oldDir || dir.startsWith(f.oldDir + '/'));
      if (fg) dir = fg.newDir + dir.slice(fg.oldDir.length);
      unmatchedDelPerDir.set(dir, (unmatchedDelPerDir.get(dir) || 0) + 1);
    }
    for (let aIdx = 0; aIdx < rawAddedList.length; aIdx++) {
      if (matchedAddIndices.has(aIdx)) continue;
      const dir = splitFilePathParts(rawAddedList[aIdx].path).dir;
      unmatchedAddPerDir.set(dir, (unmatchedAddPerDir.get(dir) || 0) + 1);
    }

    for (let dIdx = 0; dIdx < rawDeletedList.length; dIdx++) {
      if (matchedDelIndices.has(dIdx)) continue;
      const delEntry = rawDeletedList[dIdx];
      if (!delEntry.base.isText) continue;
      const delParts = splitFilePathParts(delEntry.path);

      let effectiveDelDir = delParts.dir;
      const fg = folderRenamed.find(f => effectiveDelDir === f.oldDir || effectiveDelDir.startsWith(f.oldDir + '/'));
      if (fg) {
        effectiveDelDir = fg.newDir + effectiveDelDir.slice(fg.oldDir.length);
      }

      for (let aIdx = 0; aIdx < rawAddedList.length; aIdx++) {
        if (matchedAddIndices.has(aIdx)) continue;
        const addItem = rawAddedList[aIdx];
        if (!addItem.isText || addItem.unreadable) continue;
        const addParts = splitFilePathParts(addItem.path);

        const codeSim = computeCodeSimilarity(delEntry.base.content, addItem.content);
        const sameDir = (effectiveDelDir === addParts.dir);
        const sameExt = (delParts.ext === addParts.ext);
        const sameBaseName = (delParts.baseName === addParts.baseName);
        const nameSim = computeTrigramDiceSimilarity(delParts.stem, addParts.stem);
        const isSinglePairInDir =
          sameDir &&
          unmatchedDelPerDir.get(effectiveDelDir) === 1 &&
          unmatchedAddPerDir.get(addParts.dir) === 1;

        let isRenameModMatch = false;
        if (codeSim >= 0.42) {
          isRenameModMatch = true;
        } else if (codeSim >= 0.22 && (sameDir || sameExt || sameBaseName || nameSim >= 0.38)) {
          isRenameModMatch = true;
        } else if (sameBaseName && codeSim >= 0.10) {
          isRenameModMatch = true;
        } else if (isSinglePairInDir && sameExt) {
          isRenameModMatch = true;
        }

        if (isRenameModMatch) {
          const totalScore =
            (codeSim * 3) +
            (sameBaseName ? 1.2 : 0) +
            (sameDir ? 0.8 : 0) +
            (sameExt ? 0.5 : 0) +
            (nameSim * 0.4);
          modCandidates.push({ dIdx, aIdx, totalScore });
        }
      }
    }

    modCandidates.sort((a, b) => b.totalScore - a.totalScore);
    for (const cand of modCandidates) {
      if (matchedDelIndices.has(cand.dIdx) || matchedAddIndices.has(cand.aIdx)) continue;
      matchedDelIndices.add(cand.dIdx);
      matchedAddIndices.add(cand.aIdx);
      renamedModified.push({
        from: rawDeletedList[cand.dIdx].path,
        to: rawAddedList[cand.aIdx].path,
        item: rawAddedList[cand.aIdx]
      });
    }
  }

  const added = rawAddedList.filter((_, idx) => !matchedAddIndices.has(idx));
  let remainingDeletedPaths = rawDeletedList
    .filter((_, idx) => !matchedDelIndices.has(idx))
    .map(d => d.path);

  // STAGE 4: Whole Subfolder Deletion & New Empty Subfolder Detection
  const folderDeleted = [];
  const unhandledDisappearedDirs = disappearedDirs.filter(d => !handledOldDirs.has(d));

  for (const delDir of unhandledDisappearedDirs) {
    const coveredByParent = folderDeleted.some(parentDir => delDir.startsWith(parentDir));
    if (coveredByParent) continue;

    const prefix = delDir + '/';
    const filesDeletedInDir = remainingDeletedPaths.filter(p => p.startsWith(prefix));

    let baselineFilesInDir = 0;
    for (const [bPath] of aiBaselineSnapshot.entries()) {
      if (bPath.startsWith(prefix)) baselineFilesInDir++;
    }

    if (filesDeletedInDir.length > 0 || baselineFilesInDir === 0) {
      folderDeleted.push(prefix);
      remainingDeletedPaths = remainingDeletedPaths.filter(p => !p.startsWith(prefix));
    }
  }

  const folderAdded = [];
  const unhandledAppearedDirs = appearedDirs.filter(d => !handledNewDirs.has(d));
  for (const newDir of unhandledAppearedDirs) {
    const prefix = newDir + '/';
    const hasAnyCurrentFileInside = Array.from(currentFileMap.keys()).some(p => p.startsWith(prefix));
    const hasChildDirInAppeared = unhandledAppearedDirs.some(other => other !== newDir && other.startsWith(prefix));
    if (!hasAnyCurrentFileInside && !hasChildDirInAppeared) {
      folderAdded.push(prefix);
    }
  }

  const deleted = remainingDeletedPaths;

  for (const fg of folderRenamed) {
    const hasExtraChanges =
      fg.modifiedCount > 0 ||
      renamed.some(r => r.from.startsWith(fg.from) || r.to.startsWith(fg.to)) ||
      renamedModified.some(r => r.from.startsWith(fg.from) || r.to.startsWith(fg.to)) ||
      added.some(f => f.path.startsWith(fg.to)) ||
      deleted.some(p => p.startsWith(fg.from));
    fg.hasInnerChanges = hasExtraChanges;
  }

  // STAGE 5 & 6: Grouped Total Count for UI Badge & Sync Prompt
  const totalCount =
    folderAdded.length +
    folderRenamed.length +
    folderDeleted.length +
    renamed.length +
    renamedModified.length +
    added.length +
    modified.length +
    deleted.length;

  return {
    folderAdded,
    folderRenamed,
    folderDeleted,
    renamed,
    renamedModified,
    added,
    modified,
    deleted,
    totalCount
  };
}

function renderDeltaBannerUI() {
  const doc = getDoc();
  const banner = doc.getElementById('deltaSyncBanner');
  const textEl = doc.getElementById('deltaSyncText');
  const countBadge = doc.getElementById('deltaCountBadge');
  const syncBtn = doc.getElementById('copyDeltaSyncBtn');
  const syncBtnBadge = doc.getElementById('syncBtnBadge');
  const ongoingCard = doc.getElementById('ongoingChatCard');
  const footerNote = doc.getElementById('deltaFooterNote');

  if (!banner || !textEl || !countBadge) return;

  const diff = getManualChangesAgainstBaseline();
  const hasChanges = diff.totalCount > 0;

  countBadge.textContent = String(diff.totalCount);
  textEl.textContent = hasChanges ? t('delta_pill_changes') : t('delta_pill_clean');
  banner.classList.toggle('has-changes', hasChanges);

  if (syncBtn) {
    syncBtn.classList.toggle('has-unsynced-changes', hasChanges);
  }
  if (syncBtnBadge) {
    syncBtnBadge.textContent = String(diff.totalCount);
  }
  if (ongoingCard) {
    ongoingCard.classList.toggle('has-unsynced-changes', hasChanges);
  }
  if (footerNote) {
    footerNote.classList.toggle('warn', hasChanges);
    const iconHtml = hasChanges ? SVG_ICONS.warnTriangle : SVG_ICONS.checkCircle;
    const msgText = hasChanges
      ? t('delta_footer_warn', { count: diff.totalCount })
      : t('delta_footer_clean');
    footerNote.innerHTML = `${iconHtml}<span>${escapeHtml(msgText)}</span>`;
  }
}

function toggleFileDrawer() {
  isFileDrawerCollapsed = !isFileDrawerCollapsed;
  if (!pipWindow || pipWindow.closed) {
    try {
      mainWindow.localStorage.setItem(STORAGE_KEYS.COLLAPSED, isFileDrawerCollapsed ? '1' : '0');
    } catch (e) {}
  }
  updateFileDrawerToggleUI();
}

function updateFileDrawerToggleUI() {
  const doc = getDoc();
  const btn = doc.getElementById('toggleFileDrawerBtn');
  const txt = doc.getElementById('toggleFileDrawerText');
  const drawer = doc.getElementById('fileExplorerDrawer');
  if (!btn || !txt || !drawer) return;

  const totalItems = scannedFiles.length;
  btn.classList.toggle('collapsed', isFileDrawerCollapsed);
  drawer.classList.toggle('collapsed', isFileDrawerCollapsed);
  txt.textContent = isFileDrawerCollapsed
    ? t('btn_show_files', { count: totalItems })
    : t('btn_hide_files', { count: totalItems });
}

function updateSelectedCountHeader() {
  const doc = getDoc();
  const el = doc.getElementById('selectedFilesCountText');
  if (!el) return;
  const checks = doc.querySelectorAll('.file-chk');
  let checkedCount = 0;
  checks.forEach(c => { if (c.checked) checkedCount++; });
  el.textContent = t('selected_count_lbl', { selected: checkedCount, total: checks.length });
}

// === HIERARCHICAL FILE TREE UI RENDERER ===
function renderFileTreeUI() {
  if (!dirHandle) return { codeFileCount: 0, totalLines: 0, assetCount: 0 };
  const doc = getDoc();
  const wrap = doc.getElementById('fileTreeWrap');
  const box = doc.getElementById('fileSelectorBox');
  const actionBtns = doc.getElementById('treeActionBtns');
  const uncheckedSet = getUncheckedSet();
  const diff = getManualChangesAgainstBaseline();
  const addedPaths = new Set(diff.added.map(f => f.path));
  const modPaths = new Set(diff.modified.map(f => f.path));
  const folderAddedSet = new Set(diff.folderAdded);
  const folderRenamedMap = new Map(diff.folderRenamed.map(fg => [fg.to, fg.from]));
  const renamedMap = new Map(diff.renamed.map(r => [r.to, r.from]));
  const renamedModMap = new Map(diff.renamedModified.map(r => [r.to, r.from]));

  let html = '';
  let totalLines = 0;
  let totalBytes = 0;
  let folderCount = 0;
  let codeFileCount = 0;
  let assetCount = 0;

  for (let i = 0; i < scannedFiles.length; i++) {
    const item = scannedFiles[i];
    const cleanRelPath = item.path.replace(/\/+$/, '');
    const segments = cleanRelPath.split('/');
    const baseName = segments[segments.length - 1];
    const depth = Math.max(0, segments.length - 1);
    const indentPx = 8 + depth * 14;
    const nestedClass = depth > 0 ? ' is-nested' : '';
    const safeFullPath = escapeHtml(item.path);
    const safeBaseName = escapeHtml(baseName);

    totalBytes += item.size || 0;

    if (item.kind === 'dir') {
      folderCount++;
      let folderBadge = '';
      let folderTooltip = item.path;
      if (folderRenamedMap.has(item.path)) {
        const oldFolderFrom = folderRenamedMap.get(item.path);
        folderTooltip = `${oldFolderFrom} -> ${item.path}`;
        folderBadge = `<span class="tree-row-right"><span class="mod-badge renamed">${escapeHtml(t('badge_renamed'))}</span></span>`;
      } else if (folderAddedSet.has(item.path)) {
        folderBadge = `<span class="tree-row-right"><span class="mod-badge added">${escapeHtml(t('badge_new'))}</span></span>`;
      }
      html += `<div class="tree-row folder-item${nestedClass}" style="padding-left:${indentPx}px;" title="${escapeHtml(folderTooltip)}">
        <span class="tree-row-left">
          ${SVG_ICONS.folder}
          <span class="tree-name-text">${safeBaseName}<span class="tree-subpath-hint">/</span></span>
        </span>
        ${folderBadge}
      </div>`;
    } else if (item.kind === 'file' && item.isText) {
      codeFileCount++;
      if (item.unreadable) {
        html += `<div class="tree-row asset-item${nestedClass}" style="padding-left:${indentPx}px;" title="${safeFullPath}">
          <span class="tree-row-left">${SVG_ICONS.warnFile}<span class="tree-name-text">${safeBaseName}</span></span>
          <span class="badge-meta">${escapeHtml(t('unreadable_label'))}</span>
        </div>`;
      } else {
        totalLines += item.lines || 0;
        const isChecked = !uncheckedSet.has(item.path);
        const uncheckedClass = isChecked ? '' : ' is-unchecked';
        let statusBadge = '';
        let rowTooltip = `${item.path} (${formatBytes(item.size)})`;

        if (renamedMap.has(item.path)) {
          const oldFrom = renamedMap.get(item.path);
          rowTooltip = `${oldFrom} -> ${item.path} (${formatBytes(item.size)})`;
          statusBadge = `<span class="mod-badge renamed">${escapeHtml(t('badge_renamed'))}</span>`;
        } else if (renamedModMap.has(item.path)) {
          const oldFrom = renamedModMap.get(item.path);
          rowTooltip = `${oldFrom} -> ${item.path} (${formatBytes(item.size)})`;
          statusBadge = `<span class="mod-badge modified">${escapeHtml(t('badge_renamed_mod'))}</span>`;
        } else if (addedPaths.has(item.path)) {
          statusBadge = `<span class="mod-badge added">${escapeHtml(t('badge_new'))}</span>`;
        } else if (modPaths.has(item.path)) {
          statusBadge = `<span class="mod-badge modified">${escapeHtml(t('badge_mod'))}</span>`;
        }

        html += `<label class="tree-row file-item${nestedClass}${uncheckedClass}" style="padding-left:${indentPx}px;" title="${escapeHtml(rowTooltip)}">
          <span class="tree-row-left">
            <input type="checkbox" class="file-chk" data-idx="${i}" ${isChecked ? 'checked' : ''}>
            ${getFileExtensionBadge(item.path)}
            <span class="tree-name-text">${safeBaseName}</span>
          </span>
          <span class="tree-row-right">
            ${statusBadge}
            <span class="badge-meta">${item.lines || 0} ${escapeHtml(t('lines_short'))}</span>
          </span>
        </label>`;
      }
    } else {
      assetCount++;
      html += `<div class="tree-row asset-item${nestedClass}" style="padding-left:${indentPx}px;" title="${safeFullPath}">
        <span class="tree-row-left">
          ${getFileExtensionBadge(item.path)}
          <span class="tree-name-text">${safeBaseName}</span>
        </span>
        <span class="badge-meta">${formatBytes(item.size)}</span>
      </div>`;
    }
  }

  wrap.classList.add('show');

  const nameEl = doc.getElementById('overviewFolderName');
  const summaryEl = doc.getElementById('treeSummaryText');
  const statFilesEl = doc.getElementById('statFilesVal');
  const statFoldersEl = doc.getElementById('statFoldersVal');
  const statLinesEl = doc.getElementById('statLinesVal');

  if (nameEl) nameEl.textContent = dirHandle.name;
  if (summaryEl) summaryEl.textContent = formatBytes(totalBytes);
  if (statFilesEl) statFilesEl.textContent = String(codeFileCount + assetCount);
  if (statFoldersEl) statFoldersEl.textContent = String(folderCount);
  if (statLinesEl) statLinesEl.textContent = String(totalLines);

  if (scannedFiles.length === 0) {
    actionBtns.style.display = 'none';
    box.innerHTML = `<div class="empty-project-state">
      <div class="empty-project-icon" aria-hidden="true">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
          <line x1="12" y1="11" x2="12" y2="17"></line>
          <line x1="9" y1="14" x2="15" y2="14"></line>
        </svg>
      </div>
      <div class="empty-project-title">${escapeHtml(t('tree_empty_banner_title'))}</div>
      <p class="empty-project-desc">${escapeHtml(t('tree_empty_banner_desc'))}</p>
      <span class="empty-project-pill">${SVG_ICONS.check}<span>${escapeHtml(t('tree_empty_banner_pill'))}</span></span>
    </div>`;
  } else {
    actionBtns.style.display = codeFileCount > 0 ? 'flex' : 'none';
    box.innerHTML = html;
  }

  updateFileDrawerToggleUI();
  updateSelectedCountHeader();
  renderDeltaBannerUI();

  return { codeFileCount, totalLines, assetCount };
}

// === ATOMIC SCAN WITH UNIVERSAL CODE/TEXT DETECTION ===
async function refreshFileList(preserveChecks = true, notificationMode = 'none', resetBaseline = false) {
  if (!dirHandle || isScanningFolder) return;
  isScanningFolder = true;

  try {
    const exists = await verifyRootFolderExists(dirHandle);
    if (!exists) {
      isScanningFolder = false;
      await handleMissingRootFolder(dirHandle.name);
      return;
    }

    if (notificationMode === 'manual_refresh') {
      triggerWorkspaceAnimation('refresh');
    }

    if (!preserveChecks) {
      mainWindow.localStorage.removeItem(STORAGE_KEYS.UNCHECKED);
    }

    let nextScannedFiles = [];
    try {
      nextScannedFiles = await scanDir(dirHandle);
    } catch (scanErr) {
      isScanningFolder = false;
      await handleMissingRootFolder(dirHandle.name);
      return;
    }

    for (let i = 0; i < nextScannedFiles.length; i++) {
      const item = nextScannedFiles[i];
      if (item.kind === 'file') {
        try {
          const f = await item.handle.getFile();
          item.size = f.size || 0;
          item.lastModified = f.lastModified || 0;
          item.isText = await detectIfFileIsText(item.path, f);

          if (item.isText) {
            const txt = await f.text();
            item.lines = txt ? txt.split(/\r\n|\n/).length : 0;
            item.content = txt;
            item.unreadable = false;
          }
        } catch (readErr) {
          item.isText = false;
          item.unreadable = true;
          item.lines = 0;
          item.size = 0;
          item.lastModified = 0;
          item.content = '';
        }
      }
    }

    scannedFiles = nextScannedFiles;

    if (resetBaseline || !hasBaselineInitialized) {
      captureBaselineSnapshot();
    }

    const { codeFileCount, totalLines, assetCount } = renderFileTreeUI();
    renderVersionHistoryUI();
    const assetsText = assetCount > 0 ? t('st_folder_active_assets', { count: assetCount }) : '';

    if (notificationMode === 'connect') {
      if (scannedFiles.length === 0) {
        showStatus('folderStatus', 'success', t('st_empty_linked_title', { name: dirHandle.name }), t('st_empty_linked_desc'));
      } else {
        showStatus(
          'folderStatus',
          'success',
          t('st_folder_active_title', { name: dirHandle.name }),
          t('st_folder_active_desc', { files: codeFileCount, lines: totalLines, assets: assetsText })
        );
      }
    } else if (notificationMode === 'manual_refresh') {
      if (scannedFiles.length === 0) {
        showStatus('folderStatus', 'info', t('st_empty_refreshed_title', { name: dirHandle.name }), t('st_empty_refreshed_desc'));
      } else {
        showStatus(
          'folderStatus',
          'info',
          t('st_folder_refreshed_title', { name: dirHandle.name }),
          t('st_folder_refreshed_desc', { files: codeFileCount, lines: totalLines, assets: assetsText })
        );
      }
    }
  } finally {
    isScanningFolder = false;
  }
}

// === AUTOMATIC LIVE FILE WATCHER ===
function startAutoRefreshWatcher() {
  stopAutoRefreshWatcher();
  autoRefreshInterval = mainWindow.setInterval(() => {
    checkExternalFolderChanges();
  }, 2600);
}

function stopAutoRefreshWatcher() {
  if (autoRefreshInterval) {
    mainWindow.clearInterval(autoRefreshInterval);
    autoRefreshInterval = null;
  }
}

async function checkExternalFolderChanges() {
  if (!dirHandle || isMutatingDisk || isScanningFolder || !hasBaselineInitialized) return;
  if (Date.now() - lastFolderConnectTimestamp < 1200) return;

  const stillExists = await verifyRootFolderExists(dirHandle);
  if (!stillExists) {
    await handleMissingRootFolder(dirHandle.name);
    return;
  }

  try {
    const currentEntries = await scanDir(dirHandle);
    if (currentEntries.length !== scannedFiles.length) {
      triggerWorkspaceAnimation('refresh');
      await refreshFileList(true, 'none', false);
      showStatus('folderStatus', 'info', t('st_auto_refresh_title'), t('st_auto_refresh_desc'));
      return;
    }

    const oldMap = new Map(scannedFiles.map(e => [e.path, e]));
    let changed = false;

    for (const entry of currentEntries) {
      const prev = oldMap.get(entry.path);
      if (!prev || prev.kind !== entry.kind) {
        changed = true;
        break;
      }
      if (entry.kind === 'file') {
        const f = await entry.handle.getFile();
        if (f.lastModified !== prev.lastModified || f.size !== prev.size) {
          changed = true;
          break;
        }
      }
    }

    if (changed) {
      triggerWorkspaceAnimation('refresh');
      await refreshFileList(true, 'none', false);
      showStatus('folderStatus', 'info', t('st_auto_refresh_title'), t('st_auto_refresh_desc'));
    }
  } catch (e) {
    if (e && (e.name === 'NotFoundError' || e.name === 'InvalidStateError')) {
      await handleMissingRootFolder(dirHandle ? dirHandle.name : '');
    }
  }
}

function toggleAllFiles(state) {
  const checks = getDoc().querySelectorAll('.file-chk');
  checks.forEach(c => { c.checked = state; });
  saveUncheckedSet();
}

// === STEP 2: EXPORT PROJECT + PROMPT, SMART DELTA SYNC & FOLLOW-UP ===
async function exportProject(asDownload) {
  const doc = getDoc();
  if (!dirHandle) {
    if (pendingSavedHandle) {
      await reconnectSavedFolder();
      if (!dirHandle) return;
    } else {
      return showStatus('exportStatus', 'warn', t('st_no_folder_title'), t('st_no_folder_desc'));
    }
  }

  await checkExternalFolderChanges();
  if (!dirHandle) return;

  const checks = doc.querySelectorAll('.file-chk');
  const includePrompt = doc.getElementById('includePromptChk')?.checked;
  const userPrompt = (doc.getElementById('userPromptInput')?.value || '').trim();
  const limitRule = getOutputLimitInstruction();

  let out = '';
  if (includePrompt) {
    out += getMasterSystemPrompt() + '\n\n';
  }

  const totalFilesCount = scannedFiles.filter(e => e.kind === 'file').length;
  let selectedCount = 0;

  if (currentLang === 'nl') {
    out += `=== VOLLEDIGE MAPPEN- EN SUBMAPPEN-STRUCTUUR (${dirHandle.name}) ===\n`;
    if (scannedFiles.length === 0) {
      out += `[LEEG PROJECT - 0 BESTANDEN EN 0 MAPPEN]\n` +
             `De gekoppelde projectmap "${dirHandle.name}" is op dit moment nog helemaal leeg.\n` +
             `Er zijn nog geen mappen of bestanden aanwezig. Je moet dit project volledig vanaf nul opbouwen op basis van mijn onderstaande opdracht/prompt!\n`;
    } else if (totalFilesCount === 0) {
      out += scannedFiles.map(e => `[MAP] ${e.path}`).join('\n') + '\n';
      out += `[LET OP: 0 BESTANDEN AANWEZIG - ALLEEN LEGE MAPPEN]\n` +
             `Dit project bevat nog geen enkel bestand. Bouw de benodigde bestanden vanaf nul op volgens mijn onderstaande opdracht/prompt!\n`;
    } else {
      out += scannedFiles.map(e => (e.kind === 'dir' ? `[MAP] ${e.path}` : `[BESTAND] ${e.path}`)).join('\n') + '\n';
    }

    out += `\n=== GESELECTEERDE BESTANDSINHOUD ===\n`;
    if (totalFilesCount === 0) {
      out += `[LEEG PROJECT - 0 BESTANDEN]\n` +
             `Omdat dit project nog helemaal leeg is (0 bestanden), is er nog geen bestaande broncode.\n` +
             `Genereer alle benodigde mappen ("folders") en nieuwe bestanden ("files") vanaf nul in je JSON-codeblok op basis van mijn opdracht hieronder.\n`;
    } else {
      checks.forEach(chk => {
        if (chk.checked) {
          const item = scannedFiles[Number(chk.getAttribute('data-idx'))];
          if (item && item.isText && !item.unreadable) {
            out += `\n--- START BESTAND: ${item.path} (${item.lines} regels) ---\n${item.content}\n--- EINDE BESTAND: ${item.path} ---\n`;
            selectedCount++;
          }
        }
      });
      if (selectedCount === 0) {
        out += `[GEEN CODEBESTANDEN GESELECTEERD VOOR EXPORT]\n` +
               `Er zijn 0 codebestanden aangevinkt om mee te sturen. Gebruik de bovenstaande mappenstructuur en voer mijn onderstaande opdracht uit.\n`;
      }
    }

    out += `\n=== MIJN OPDRACHT / PROMPT ===\n`;
    if (userPrompt) {
      out += `${userPrompt}\n`;
      if (totalFilesCount === 0) {
        out += `\n(Opmerking: Dit project is nog 100% leeg. Bouw de mappen en bestanden vanaf nul op in één geldig \`\`\`json ... \`\`\` codeblok. ${limitRule})`;
      } else {
        out += `\n(Opmerking: Geef je wijzigingen terug in één geldig \`\`\`json ... \`\`\` codeblok. Laat ongewijzigde bestanden volledig weg, gebruik "edit" met compacte zoekblokken, "files" alleen voor gloednieuwe bestanden en "delete" voor verwijderingen. ${limitRule})`;
      }
    } else {
      if (totalFilesCount === 0) {
        out += `Ik heb zojuist mijn lege projectmap "${dirHandle.name}" (0 bestanden) gekoppeld, maar nog geen specifieke opdracht ingevuld. Bevestig kort dat je klaarstaat om een nieuw project vanaf nul te bouwen en vraag mij wat ik precies wil laten maken. (${limitRule})`;
      } else {
        out += `Ik heb mijn project "${dirHandle.name}" (${selectedCount} bestanden) hierboven ingeladen. Bevestig kort dat je de volledige structuur en code hebt begrepen en vraag mij welke aanpassing of uitbreiding ik als eerste wil doorvoeren. (${limitRule})`;
      }
    }
  } else {
    out += `=== FULL FOLDER AND SUBFOLDER STRUCTURE (${dirHandle.name}) ===\n`;
    if (scannedFiles.length === 0) {
      out += `[EMPTY PROJECT - 0 FILES AND 0 FOLDERS]\n` +
             `The linked project folder "${dirHandle.name}" is currently completely empty.\n` +
             `There are no folders or files yet. Please build this project completely from scratch based on my task/prompt below!\n`;
    } else if (totalFilesCount === 0) {
      out += scannedFiles.map(e => `[DIR] ${e.path}`).join('\n') + '\n';
      out += `[NOTE: 0 FILES PRESENT - ONLY EMPTY FOLDERS]\n` +
             `This project does not contain any files yet. Build the required files from scratch according to my task/prompt below!\n`;
    } else {
      out += scannedFiles.map(e => (e.kind === 'dir' ? `[DIR] ${e.path}` : `[FILE] ${e.path}`)).join('\n') + '\n';
    }

    out += `\n=== SELECTED FILE CONTENTS ===\n`;
    if (totalFilesCount === 0) {
      out += `[EMPTY PROJECT - 0 FILES]\n` +
             `Because this project is completely empty (0 files), there is no existing source code yet.\n` +
             `Generate all required folders ("folders") and new files ("files") from scratch in your JSON code block based on my prompt below.\n`;
    } else {
      checks.forEach(chk => {
        if (chk.checked) {
          const item = scannedFiles[Number(chk.getAttribute('data-idx'))];
          if (item && item.isText && !item.unreadable) {
            out += `\n--- START FILE: ${item.path} (${item.lines} lines) ---\n${item.content}\n--- END FILE: ${item.path} ---\n`;
            selectedCount++;
          }
        }
      });
      if (selectedCount === 0) {
        out += `[NO CODE FILES SELECTED FOR EXPORT]\n` +
               `0 code files were checked for export. Use the folder structure above and execute my task below.\n`;
      }
    }

    out += `\n=== MY TASK / PROMPT ===\n`;
    if (userPrompt) {
      out += `${userPrompt}\n`;
      if (totalFilesCount === 0) {
        out += `\n(Note: This project is currently 100% empty. Build the folders and files from scratch in a single valid \`\`\`json ... \`\`\` code block. ${limitRule})`;
      } else {
        out += `\n(Note: Return your changes in a single valid \`\`\`json ... \`\`\` code block. Completely omit unchanged files, use "edit" with compact search blocks, "files" only for brand-new files, and "delete" for removals. ${limitRule})`;
      }
    } else {
      if (totalFilesCount === 0) {
        out += `I just linked my empty project folder "${dirHandle.name}" (0 files), but haven't entered a specific task yet. Briefly confirm that you are ready to build a new project from scratch and ask me what I would like to create. (${limitRule})`;
      } else {
        out += `I have loaded my project "${dirHandle.name}" (${selectedCount} files) above. Briefly confirm that you understand the full structure and code, and ask me what change or feature I would like to implement first. (${limitRule})`;
      }
    }
  }

  const promptSuffix = userPrompt ? t('st_with_prompt') : '';

  if (asDownload) {
    triggerFileDownload('project.txt', out, 'text/plain;charset=utf-8');
    flashButtonSuccess(doc.getElementById('downloadTxtBtn'));
    captureBaselineSnapshot();
    renderFileTreeUI();
    clearPromptInput(false);
    const dlDesc = totalFilesCount === 0
      ? t('st_dl_empty_desc', { prompt: promptSuffix })
      : t('st_dl_files_desc', { count: selectedCount, prompt: promptSuffix });
    showStatus('exportStatus', 'success', t('st_dl_title'), dlDesc);
  } else {
    try {
      await writeTextToClipboard(out);
      flashButtonSuccess(doc.getElementById('copyProjectBtn'));
      captureBaselineSnapshot();
      renderFileTreeUI();
      clearPromptInput(false);
      const desc = totalFilesCount === 0
        ? t('st_copied_empty_desc', { prompt: promptSuffix })
        : t('st_copied_files_desc', { count: selectedCount, prompt: promptSuffix });
      showStatus('exportStatus', 'success', t('st_copied_title'), t('st_copied_Action', { desc }));
    } catch (err) {
      showStatus('exportStatus', 'error', t('st_copy_err_title'), err.message);
    }
  }
}

async function copyDeltaSyncPrompt() {
  const doc = getDoc();
  if (!dirHandle) {
    if (pendingSavedHandle) {
      await reconnectSavedFolder();
      if (!dirHandle) return;
    } else {
      return showStatus('exportStatus', 'warn', t('st_no_folder_title'), t('st_no_folder_desc'));
    }
  }

  await checkExternalFolderChanges();
  if (!dirHandle) return;

  const userPrompt = (doc.getElementById('userPromptInput')?.value || '').trim();

  for (const item of scannedFiles) {
    if (item.kind === 'file' && !item.unreadable) {
      try {
        const f = await item.handle.getFile();
        if (item.isText === undefined) {
          item.isText = await detectIfFileIsText(item.path, f);
        }
        if (item.isText && (f.lastModified !== item.lastModified || f.size !== item.size || item.content === undefined)) {
          const freshText = await f.text();
          item.content = freshText;
          item.lines = freshText ? freshText.split(/\r\n|\n/).length : 0;
          item.size = f.size || 0;
          item.lastModified = f.lastModified || 0;
        }
      } catch (e) {}
    }
  }

  const diff = getManualChangesAgainstBaseline();

  if (diff.totalCount === 0 && !userPrompt) {
    return showStatus('exportStatus', 'warn', t('st_prompt_empty_title'), t('st_prompt_empty_desc'));
  }

  if (diff.totalCount === 0) {
    await copyFollowUpPrompt(true);
    return;
  }

  const renamedModifiedTextFiles = diff.renamedModified.filter(r => r.item && r.item.isText && !r.item.unreadable);
  const addedTextFiles = diff.added.filter(f => f.isText && !f.unreadable);
  const modifiedTextFiles = diff.modified.filter(f => f.isText && !f.unreadable);
  const hasCodeBlocksToSend =
    renamedModifiedTextFiles.length > 0 ||
    addedTextFiles.length > 0 ||
    modifiedTextFiles.length > 0;
  const limitRule = getOutputLimitInstruction();
  let out = '';

  if (currentLang === 'nl') {
    out += `=== TUSSENTIJDSE HANDMATIGE LOKALE WIJZIGINGEN (SYNC MET PROJECTMAP "${dirHandle.name}") ===\n`;
    if (lastRestoredVersionMeta) {
      out += `LET OP: Ik heb mijn projectmap zojuist teruggezet naar een eerdere versie (v${lastRestoredVersionMeta.versionNumber} van ${lastRestoredVersionMeta.time}).\n`;
    } else {
      out += `BELANGRIJK: Sinds ons laatste bericht heb ik zelf handmatig wijzigingen aangebracht in mijn lokale projectmap.\n`;
    }
    out += `Werk EERST jouw interne geheugen bij met onderstaande wijzigingen voordat je mijn nieuwe vervolg-opdracht uitvoert!\n\n`;

    if (diff.folderAdded.length > 0) {
      out += `Nieuwe lege submap toegevoegd (${diff.folderAdded.length}):\n` +
             diff.folderAdded.map(fa => `[+] Nieuwe map aangemaakt: \`${fa}\``).join('\n') + `\n\n`;
    }
    if (diff.folderRenamed.length > 0) {
      out += `Submap hernoemd / verplaatst (${diff.folderRenamed.length}):\n` +
             diff.folderRenamed.map(fg =>
               fg.hasInnerChanges
                 ? `[~>] Map hernoemd/verplaatst (overige onderliggende bestanden en inhoud ongewijzigd): \`${fg.from}\` -> \`${fg.to}\``
                 : `[~>] Map hernoemd/verplaatst (alle onderliggende bestanden en inhoud ongewijzigd): \`${fg.from}\` -> \`${fg.to}\``
             ).join('\n') + `\n\n`;
    }
    if (diff.folderDeleted.length > 0) {
      out += `Submap volledig verwijderd (${diff.folderDeleted.length} - verwijder deze map en alle onderliggende bestanden uit je geheugen):\n` +
             diff.folderDeleted.map(fd => `[-] Map volledig verwijderd (inclusief alle onderliggende bestanden): \`${fd}\``).join('\n') + `\n\n`;
    }
    if (diff.renamed.length > 0) {
      out += `Bestand hernoemd / verplaatst - inhoud ongewijzigd (${diff.renamed.length}):\n` +
             diff.renamed.map(r => `[~>] Bestand hernoemd/verplaatst (inhoud ongewijzigd): \`${r.from}\` -> \`${r.to}\``).join('\n') + `\n\n`;
    }
    if (diff.renamedModified.length > 0) {
      out += `Bestand hernoemd / verplaatst én inhoudelijk gewijzigd (${diff.renamedModified.length}):\n` +
             diff.renamedModified.map(r => `[~>] Bestand hernoemd/verplaatst én inhoudelijk gewijzigd: \`${r.from}\` -> \`${r.to}\``).join('\n') + `\n\n`;
    }
    if (diff.added.length > 0) {
      out += `Nieuw toegevoegd (${diff.added.length}):\n` +
             diff.added.map(f => `[+] Nieuw bestand toegevoegd: \`${f.path}\``).join('\n') + `\n\n`;
    }
    if (diff.modified.length > 0) {
      out += `Inhoudelijk gewijzigd (${diff.modified.length}):\n` +
             diff.modified.map(f => `[~] Bestand inhoudelijk gewijzigd: \`${f.path}\``).join('\n') + `\n\n`;
    }
    if (diff.deleted.length > 0) {
      out += `Losse bestanden verwijderd (${diff.deleted.length} - verwijder deze uit je geheugen):\n` +
             diff.deleted.map(p => `[-] Bestand verwijderd: \`${p}\``).join('\n') + `\n\n`;
    }

    if (hasCodeBlocksToSend) {
      out += `=== NIEUWSTE INHOUD VAN HANDMATIG GEWIJZIGDE / TOEGEVOEGDE BESTANDEN ===\n`;
      for (const r of renamedModifiedTextFiles) {
        out += `\n--- START HERNOEMD EN GEWIJZIGD BESTAND: ${r.from} -> ${r.to} (${r.item.lines} regels) ---\n${r.item.content}\n--- EINDE HERNOEMD EN GEWIJZIGD BESTAND: ${r.to} ---\n`;
      }
      for (const item of modifiedTextFiles) {
        out += `\n--- START GEWIJZIGD BESTAND: ${item.path} (${item.lines} regels) ---\n${item.content}\n--- EINDE GEWIJZIGD BESTAND: ${item.path} ---\n`;
      }
      for (const item of addedTextFiles) {
        out += `\n--- START NIEUW TOEGEVOEGD BESTAND: ${item.path} (${item.lines} regels) ---\n${item.content}\n--- EINDE NIEUW TOEGEVOEGD BESTAND: ${item.path} ---\n`;
      }
    }

    out += `\n=== MIJN VERVOLG-OPDRACHT / PROMPT ===\n`;
    out += userPrompt
      ? `${userPrompt}\n\n(Herinnering voor JSON-output: Gebruik de nieuwste map-/bestandsnamen en code zoals hierboven gesynchroniseerd. Stuur onderaan je antwoord exact één geldig \`\`\`json ... \`\`\` codeblok terug met ALLEEN de toevoegingen, wijzigingen ("edit") en verwijderingen. ${limitRule})`
      : `Ik heb hierboven mijn tussentijdse lokale wijzigingen gesynchroniseerd. Bevestig kort dat je jouw geheugen hebt bijgewerkt met deze nieuwste mappenstructuur en bestandsinhoud.`;
  } else {
    out += `=== MANUAL LOCAL CHANGES SINCE LAST SYNC (PROJECT FOLDER "${dirHandle.name}") ===\n`;
    if (lastRestoredVersionMeta) {
      out += `NOTE: I just restored my project folder to an earlier version (v${lastRestoredVersionMeta.versionNumber} from ${lastRestoredVersionMeta.time}).\n`;
    } else {
      out += `IMPORTANT: Since our last message, I manually modified files/folders locally in my project folder.\n`;
    }
    out += `FIRST update your internal memory with the changes below before executing my new follow-up task!\n\n`;

    if (diff.folderAdded.length > 0) {
      out += `New empty subfolder added (${diff.folderAdded.length}):\n` +
             diff.folderAdded.map(fa => `[+] New folder created: \`${fa}\``).join('\n') + `\n\n`;
    }
    if (diff.folderRenamed.length > 0) {
      out += `Subfolder renamed / moved (${diff.folderRenamed.length}):\n` +
             diff.folderRenamed.map(fg =>
               fg.hasInnerChanges
                 ? `[~>] Folder renamed/moved (all other underlying files and contents unchanged): \`${fg.from}\` -> \`${fg.to}\``
                 : `[~>] Folder renamed/moved (all underlying files and contents unchanged): \`${fg.from}\` -> \`${fg.to}\``
             ).join('\n') + `\n\n`;
    }
    if (diff.folderDeleted.length > 0) {
      out += `Subfolder completely deleted (${diff.folderDeleted.length} - remove this folder and all its underlying files from your memory):\n` +
             diff.folderDeleted.map(fd => `[-] Folder completely deleted (including all underlying files): \`${fd}\``).join('\n') + `\n\n`;
    }
    if (diff.renamed.length > 0) {
      out += `File renamed / moved - content unchanged (${diff.renamed.length}):\n` +
             diff.renamed.map(r => `[~>] File renamed/moved (content unchanged): \`${r.from}\` -> \`${r.to}\``).join('\n') + `\n\n`;
    }
    if (diff.renamedModified.length > 0) {
      out += `File renamed / moved and content modified (${diff.renamedModified.length}):\n` +
             diff.renamedModified.map(r => `[~>] File renamed/moved and content modified: \`${r.from}\` -> \`${r.to}\``).join('\n') + `\n\n`;
    }
    if (diff.added.length > 0) {
      out += `Newly added (${diff.added.length}):\n` +
             diff.added.map(f => `[+] New file added: \`${f.path}\``).join('\n') + `\n\n`;
    }
    if (diff.modified.length > 0) {
      out += `Content modified (${diff.modified.length}):\n` +
             diff.modified.map(f => `[~] File content modified: \`${f.path}\``).join('\n') + `\n\n`;
    }
    if (diff.deleted.length > 0) {
      out += `Individual files deleted (${diff.deleted.length} - remove these from your memory):\n` +
             diff.deleted.map(p => `[-] File deleted: \`${p}\``).join('\n') + `\n\n`;
    }

    if (hasCodeBlocksToSend) {
      out += `=== LATEST CONTENTS OF MANUALLY ADDED / MODIFIED FILES ===\n`;
      for (const r of renamedModifiedTextFiles) {
        out += `\n--- START RENAMED AND MODIFIED FILE: ${r.from} -> ${r.to} (${r.item.lines} lines) ---\n${r.item.content}\n--- END RENAMED AND MODIFIED FILE: ${r.to} ---\n`;
      }
      for (const item of modifiedTextFiles) {
        out += `\n--- START MODIFIED FILE: ${item.path} (${item.lines} lines) ---\n${item.content}\n--- END MODIFIED FILE: ${item.path} ---\n`;
      }
      for (const item of addedTextFiles) {
        out += `\n--- START NEWLY ADDED FILE: ${item.path} (${item.lines} lines) ---\n${item.content}\n--- END NEWLY ADDED FILE: ${item.path} ---\n`;
      }
    }

    out += `\n=== MY FOLLOW-UP TASK / PROMPT ===\n`;
    out += userPrompt
      ? `${userPrompt}\n\n(Reminder for JSON output: Base your folder/file paths and "search" blocks on the latest synced state above. End your response with exactly one valid \`\`\`json ... \`\`\` code block containing ONLY the additions, edits ("edit"), and deletions. ${limitRule})`
      : `I have synced my manual local changes above. Briefly confirm that you have updated your internal memory with this latest folder structure and file contents.`;
  }

  try {
    await writeTextToClipboard(out);
    flashButtonSuccess(doc.getElementById('copyDeltaSyncBtn'));
    clearPromptInput(false);
    captureBaselineSnapshot();
    renderFileTreeUI();
    showStatus('exportStatus', 'success', t('st_delta_copied_title'), t('st_delta_copied_desc', { count: diff.totalCount }));
  } catch (err) {
    showStatus('exportStatus', 'error', t('st_copy_err_title'), err.message);
  }
}

async function copyFollowUpPrompt(fromDeltaFallback = false) {
  const doc = getDoc();
  const userPrompt = (doc.getElementById('userPromptInput')?.value || '').trim();
  if (!userPrompt) {
    return showStatus('exportStatus', 'warn', t('st_prompt_empty_title'), t('st_prompt_empty_desc'));
  }

  const limitRule = getOutputLimitInstruction();
  const out = (currentLang === 'nl')
    ? `=== VERVOLG-OPDRACHT / PROMPT ===\n${userPrompt}\n\n(Herinnering voor JSON-output: Stuur onderaan je antwoord exact één \`\`\`json ... \`\`\` codeblok terug met ALLEEN de toevoegingen, wijzigingen en verwijderingen. Laat ongewijzigde bestanden weg en gebruik "edit" met {"search": "...", "replace": "..."} voor aanpassingen in bestaande bestanden. ${limitRule})`
    : `=== FOLLOW-UP TASK / PROMPT ===\n${userPrompt}\n\n(Reminder for JSON output: End your response with exactly one \`\`\`json ... \`\`\` code block containing ONLY the additions, edits, and deletions. Omit unchanged files and use "edit" with {"search": "...", "replace": "..."} for modifications in existing files. ${limitRule})`;

  try {
    await writeTextToClipboard(out);
    flashButtonSuccess(doc.getElementById(fromDeltaFallback ? 'copyDeltaSyncBtn' : 'copyFollowUpBtn'));
    clearPromptInput(false);
    if (fromDeltaFallback) {
      showStatus('exportStatus', 'info', t('st_delta_none_title'), t('st_delta_none_desc'));
    } else {
      showStatus('exportStatus', 'success', t('st_followup_copied_title'), t('st_followup_copied_desc'));
    }
  } catch (err) {
    showStatus('exportStatus', 'error', t('st_copy_err_title'), err.message);
  }
}

// === AUTOMATIC "CUT-OFF JSON" RECOVERY PROMPT ===
async function copyTruncatedJsonRecoveryPrompt() {
  const out = (currentLang === 'nl')
    ? 'Je vorige JSON-antwoord werd halverwege afgekapt door de maximale output-limiet (het laatste bestand was nog niet compleet). Stuur nu een nieuw, geldig en volledig afgesloten JSON-blok met het bestand waar je gebleven was + de eventuele resterende bestanden!'
    : 'Your previous JSON response was cut off halfway due to the maximum output limit (the last file was not yet complete). Please send a new, valid, and completely closed JSON block containing the file where you left off + any remaining files!';

  try {
    await writeTextToClipboard(out);

    const doc = getDoc();
    const btn = doc.getElementById('copyContinueJsonBtn');
    if (btn) {
      if (continueBtnFeedbackTimer) mainWindow.clearTimeout(continueBtnFeedbackTimer);
      btn.classList.add('copied-ok');
      btn.innerHTML = `${SVG_ICONS.check}<span>${escapeHtml(t('btn_copy_continue_copied'))}</span>`;
      continueBtnFeedbackTimer = mainWindow.setTimeout(() => {
        btn.classList.remove('copied-ok');
        btn.innerHTML = `${SVG_ICONS.copy}<span data-i18n="btn_copy_continue_json">${escapeHtml(t('btn_copy_continue_json'))}</span>`;
      }, 2400);
    }

    showStatus('updateStatus', 'success', t('st_continue_copied_title'), t('st_continue_copied_desc'));
  } catch (err) {
    showStatus('updateStatus', 'error', t('st_copy_err_title'), err.message);
  }
}

// === STEP 3: SMART JSON-DIFF PROCESSOR & TRUNCATION DETECTOR ===
function cleanPath(path, rootName) {
  let p = String(path || '').replace(/\\/g, '/').replace(/^\/+/, '').trim();
  if (rootName && p.startsWith(rootName + '/')) {
    p = p.substring(rootName.length + 1);
  }
  return p.replace(/^\/+/, '');
}

async function getDirRecursive(root, pathParts, create = true) {
  let current = root;
  for (const part of pathParts) {
    if (!part || part === '.') continue;
    current = await current.getDirectoryHandle(part, { create });
  }
  return current;
}

async function getFileHandleByPath(root, fullPath, create = false) {
  const parts = fullPath.split('/').filter(Boolean);
  const fileName = parts.pop();
  if (!fileName) throw new Error('Invalid file path: ' + fullPath);
  const dir = await getDirRecursive(root, parts, create);
  return await dir.getFileHandle(fileName, { create });
}

async function removeByPath(root, fullPath) {
  const parts = fullPath.replace(/\/+$/, '').split('/').filter(Boolean);
  const name = parts.pop();
  if (!name) return false;
  const dir = await getDirRecursive(root, parts, false);
  await dir.removeEntry(name, { recursive: true });
  return true;
}

async function copyDirectoryRecursive(srcDirHandle, destDirHandle) {
  for await (const [name, entry] of srcDirHandle.entries()) {
    if (entry.kind === 'directory') {
      const subDest = await destDirHandle.getDirectoryHandle(name, { create: true });
      await copyDirectoryRecursive(entry, subDest);
    } else {
      const fileData = await entry.getFile();
      const buffer = await fileData.arrayBuffer();
      const destFile = await destDirHandle.getFileHandle(name, { create: true });
      const writable = await destFile.createWritable();
      await writable.write(buffer);
      await writable.close();
    }
  }
}

async function moveEntryByPath(root, srcPath, destPath) {
  const cleanSrc = srcPath.replace(/\/+$/, '');
  const cleanDest = destPath.replace(/\/+$/, '');
  try {
    const srcHandle = await getFileHandleByPath(root, cleanSrc, false);
    const fileData = await srcHandle.getFile();
    const buffer = await fileData.arrayBuffer();
    const destHandle = await getFileHandleByPath(root, cleanDest, true);
    const writable = await destHandle.createWritable();
    await writable.write(buffer);
    await writable.close();
    await removeByPath(root, cleanSrc);
  } catch (fileErr) {
    const srcParts = cleanSrc.split('/').filter(Boolean);
    const destParts = cleanDest.split('/').filter(Boolean);
    const srcDir = await getDirRecursive(root, srcParts, false);
    const destDir = await getDirRecursive(root, destParts, true);
    await copyDirectoryRecursive(srcDir, destDir);
    await removeByPath(root, cleanSrc);
  }
}

function isLikelyTruncatedJson(rawText) {
  const text = (rawText || '').trim();
  const firstBrace = text.indexOf('{');
  if (firstBrace === -1) return false;

  const hasJsonMarkers = /"(?:folders|files|create|edit|move|delete|search|replace)"\s*:/i.test(text) || /```json/i.test(text);
  if (!hasJsonMarkers && !text.startsWith('{')) return false;

  const sub = text.slice(firstBrace);
  let inString = false;
  let escaped = false;
  let openBraces = 0;
  let openBrackets = 0;

  for (let i = 0; i < sub.length; i++) {
    const ch = sub[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (!inString) {
      if (ch === '{') openBraces++;
      else if (ch === '}') openBraces--;
      else if (ch === '[') openBrackets++;
      else if (ch === ']') openBrackets--;
    }
  }

  const fenceCount = (text.match(/```/g) || []).length;
  const unclosedFence = /```json/i.test(text) && (fenceCount % 2 === 1);

  return inString || openBraces > 0 || openBrackets > 0 || unclosedFence;
}

function extractJsonFromText(rawText) {
  const text = (rawText || '').trim();
  if (!text) throw new Error('Empty input.');

  const codeBlockRegex = /```(?:json)?\s*([\s\S]*?)```/gi;
  const matches = [...text.matchAll(codeBlockRegex)];
  if (matches.length > 0) {
    for (let i = matches.length - 1; i >= 0; i--) {
      const candidate = matches[i][1].trim();
      try {
        return JSON.parse(candidate);
      } catch (e) {}
    }
  }

  try {
    return JSON.parse(text);
  } catch (e) {}

  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const candidate = text.slice(firstBrace, lastBrace + 1);
    return JSON.parse(candidate);
  }

  throw new Error('No valid JSON format found.');
}

function applySmartEdit(content, rawSearch, rawReplace) {
  const sNorm = String(rawSearch ?? '').replace(/\r\n/g, '\n');
  const rNorm = String(rawReplace ?? '').replace(/\r\n/g, '\n');

  if (sNorm === '') {
    if (content.trim() === '') {
      return { matched: true, content: rNorm };
    }
    return { matched: false, content };
  }

  let idx = content.indexOf(sNorm);
  if (idx !== -1) {
    const updated = content.slice(0, idx) + rNorm + content.slice(idx + sNorm.length);
    return { matched: true, content: updated };
  }

  const sStrippedNewlines = sNorm.replace(/^\n+|\n+$/g, '');
  const rStrippedNewlines = rNorm.replace(/^\n+|\n+$/g, '');
  if (sStrippedNewlines.length > 0) {
    idx = content.indexOf(sStrippedNewlines);
    if (idx !== -1) {
      const updated = content.slice(0, idx) + rStrippedNewlines + content.slice(idx + sStrippedNewlines.length);
      return { matched: true, content: updated };
    }
  }

  const contentLines = content.split('\n');
  const searchLines = sStrippedNewlines.split('\n');

  if (searchLines.length > 0 && searchLines.some(l => l.trim().length > 0)) {
    for (let i = 0; i <= contentLines.length - searchLines.length; i++) {
      let allMatch = true;
      for (let j = 0; j < searchLines.length; j++) {
        if (contentLines[i + j].trim() !== searchLines[j].trim()) {
          allMatch = false;
          break;
        }
      }
      if (allMatch) {
        const before = contentLines.slice(0, i);
        const after = contentLines.slice(i + searchLines.length);
        const replacementLines = rStrippedNewlines === '' ? [] : rStrippedNewlines.split('\n');
        const updated = [...before, ...replacementLines, ...after].join('\n');
        return { matched: true, content: updated };
      }
    }
  }

  return { matched: false, content };
}

function setLiveProgress(visible, current = 0, total = 0, fileLabel = '', restoreVerNum = null) {
  const doc = getDoc();
  const box = doc.getElementById('updateProgressBox');
  if (!box) return;

  if (!visible) {
    box.classList.remove('show');
    return;
  }

  box.classList.add('show');
  const pct = total > 0 ? Math.min(100, Math.round((current / total) * 100)) : 0;

  const statusEl = doc.getElementById('progressStatusText');
  const pctEl = doc.getElementById('progressPercentText');
  const fillEl = doc.getElementById('progressBarFill');
  const fileEl = doc.getElementById('progressCurrentFile');

  if (statusEl) {
    statusEl.textContent = restoreVerNum !== null
      ? t('prog_restore_status', { ver: restoreVerNum, current, total })
      : t('prog_status', { current, total });
  }
  if (pctEl) pctEl.textContent = `${pct}%`;
  if (fillEl) fillEl.style.width = `${pct}%`;
  if (fileEl) fileEl.textContent = fileLabel ? t('prog_current_file', { file: fileLabel }) : '-';
}

function yieldFrame(ms = 18) {
  return new Promise(resolve => mainWindow.setTimeout(resolve, ms));
}

async function updateFromClipboard() {
  try {
    const clipText = await getActiveNavigator().clipboard.readText();
    if (!clipText || !clipText.trim()) {
      return showStatus('updateStatus', 'warn', t('st_clip_empty_title'), t('st_clip_empty_desc'));
    }
    await updateFolderDirectly(clipText);
  } catch (err) {
    showStatus('updateStatus', 'warn', t('st_clip_denied_title'), t('st_clip_denied_desc'));
  }
}

async function updateFolderDirectly(rawInput) {
  if (isMutatingDisk) return;
  if (!dirHandle) {
    if (pendingSavedHandle) {
      await reconnectSavedFolder();
      if (!dirHandle) return;
    } else {
      return showStatus('updateStatus', 'warn', t('st_no_folder_title'), t('st_no_folder_desc'));
    }
  }

  const exists = await verifyRootFolderExists(dirHandle);
  if (!exists) {
    await handleMissingRootFolder(dirHandle.name);
    return;
  }

  if (!rawInput || !String(rawInput).trim()) {
    return showStatus('updateStatus', 'warn', t('st_no_json_title'), t('st_no_json_desc'));
  }

  const doc = getDoc();
  const truncBox = doc.getElementById('truncatedJsonBox');

  await waitForScanToFinish();
  isMutatingDisk = true;

  try {
    const patch = extractJsonFromText(rawInput);
    if (truncBox) truncBox.classList.remove('show');

    const tasks = [];
    const affectedPaths = [];

    if (patch.folders && Array.isArray(patch.folders)) {
      for (const f of patch.folders) {
        const target = cleanPath(f, dirHandle.name);
        if (target) {
          tasks.push({ type: 'folder', target });
          affectedPaths.push(target + '/');
        }
      }
    }

    if (patch.move && typeof patch.move === 'object') {
      for (const [oldP, newP] of Object.entries(patch.move)) {
        const srcPath = cleanPath(oldP, dirHandle.name);
        const destPath = cleanPath(newP, dirHandle.name);
        if (srcPath && destPath && srcPath !== destPath) {
          tasks.push({ type: 'move', target: `${srcPath} -> ${destPath}`, srcPath, destPath });
          affectedPaths.push(destPath);
        }
      }
    }

    const filesObj = {
      ...(patch.create && typeof patch.create === 'object' ? patch.create : {}),
      ...(patch.files && typeof patch.files === 'object' ? patch.files : {})
    };
    for (const [filePath, fileContent] of Object.entries(filesObj)) {
      const target = cleanPath(filePath, dirHandle.name);
      if (target) {
        tasks.push({ type: 'file', target, fileContent });
        affectedPaths.push(target);
      }
    }

    if (patch.edit && typeof patch.edit === 'object') {
      for (const [filePath, edits] of Object.entries(patch.edit)) {
        const target = cleanPath(filePath, dirHandle.name);
        if (target) {
          tasks.push({ type: 'edit', target, edits });
          affectedPaths.push(target);
        }
      }
    }

    const deleteList = [
      ...(Array.isArray(patch.delete) ? patch.delete : []),
      ...(Array.isArray(patch.remove) ? patch.remove : [])
    ];
    for (const delPath of deleteList) {
      const target = cleanPath(delPath, dirHandle.name);
      if (target) {
        tasks.push({ type: 'delete', target });
        affectedPaths.push(target);
      }
    }

    const totalTasks = tasks.length;
    if (totalTasks === 0) {
      isMutatingDisk = false;
      return showStatus('updateStatus', 'info', t('st_no_changes_title'), t('st_no_changes_desc'));
    }

    // === AUTOMATIC BACKUP SNAPSHOT BEFORE APPLYING AI UPDATE ===
    const preDiff = getManualChangesAgainstBaseline();
    const manualFilesBeforeUpdate = [
      ...preDiff.modified.map(f => f.path),
      ...preDiff.added.map(f => f.path),
      ...preDiff.renamed.map(r => r.to),
      ...preDiff.renamedModified.map(r => r.to),
      ...preDiff.deleted
    ];
    const preSnapshotKind = versionHistory.length === 0 ? 'initial' : 'manual';
    const preSnapshotRaw = await buildCurrentDiskSnapshot(preSnapshotKind, manualFilesBeforeUpdate);
    const savedPreVersion = addVersionToHistory(preSnapshotRaw);

    const logs = [];
    const warnings = [];

    setLiveProgress(true, 0, totalTasks, tasks[0].target);
    await yieldFrame(20);

    for (let idx = 0; idx < totalTasks; idx++) {
      const task = tasks[idx];
      setLiveProgress(true, idx + 1, totalTasks, task.target);
      await yieldFrame(20);

      if (task.type === 'folder') {
        try {
          const parts = task.target.split('/').filter(Boolean);
          await getDirRecursive(dirHandle, parts, true);
          logs.push(t('log_folder_added', { target: task.target }));
        } catch (e) {
          warnings.push(t('log_folder_failed', { target: task.target, msg: e.message }));
        }
      } else if (task.type === 'move') {
        try {
          await moveEntryByPath(dirHandle, task.srcPath, task.destPath);
          logs.push(t('log_moved', { src: task.srcPath, dest: task.destPath }));
        } catch (e) {
          warnings.push(t('log_move_failed', { src: task.srcPath }));
        }
      } else if (task.type === 'file') {
        try {
          const fileHandle = await getFileHandleByPath(dirHandle, task.target, true);
          const writable = await fileHandle.createWritable();
          await writable.write(typeof task.fileContent === 'string' ? task.fileContent : JSON.stringify(task.fileContent, null, 2));
          await writable.close();
          logs.push(t('log_file_added', { target: task.target }));
        } catch (e) {
          warnings.push(t('log_write_failed', { target: task.target, msg: e.message }));
        }
      } else if (task.type === 'edit') {
        const editList = Array.isArray(task.edits) ? task.edits : [task.edits];
        try {
          let fileHandle = null;
          let content = '';
          try {
            fileHandle = await getFileHandleByPath(dirHandle, task.target, false);
            const fileData = await fileHandle.getFile();
            content = (await fileData.text()).replace(/\r\n/g, '\n');
          } catch (notFoundErr) {
            fileHandle = null;
            content = '';
          }

          let editCount = 0;
          for (const item of editList) {
            if (!item || typeof item !== 'object') continue;
            const searchStr = item.search ?? item.find ?? item.old ?? '';
            const replaceStr = item.replace ?? item.new ?? '';

            const result = applySmartEdit(content, searchStr, replaceStr);
            if (result.matched) {
              content = result.content;
              editCount++;
            } else {
              const preview = String(searchStr).trim().split('\n')[0].slice(0, 38);
              warnings.push(t('log_search_not_found', { target: task.target, preview }));
            }
          }

          if (editCount > 0) {
            if (!fileHandle) {
              fileHandle = await getFileHandleByPath(dirHandle, task.target, true);
            }
            const writable = await fileHandle.createWritable();
            await writable.write(content);
            await writable.close();
            const blocksLabel = editCount > 1 ? t('log_block_plural') : t('log_block_singular');
            logs.push(t('log_edited', { target: task.target, count: editCount, blocks: blocksLabel }));
          }
        } catch (e) {
          warnings.push(t('log_err_in', { target: task.target, msg: e.message }));
        }
      } else if (task.type === 'delete') {
        try {
          await removeByPath(dirHandle, task.target);
          logs.push(t('log_deleted', { target: task.target }));
        } catch (e) {
          warnings.push(t('log_delete_failed', { target: task.target }));
        }
      }
    }

    const statusEl = doc.getElementById('progressStatusText');
    if (statusEl) statusEl.textContent = t('prog_done', { total: totalTasks });

    await refreshFileList(true, 'none', true);

    // === SAVE NEW VERSION IN VERSION HISTORY AFTER UPDATE ===
    const postSnapshotRaw = await buildCurrentDiskSnapshot('ai_update', affectedPaths);
    const savedPostVersion = addVersionToHistory(postSnapshotRaw);
    if (savedPreVersion && savedPostVersion && savedPreVersion.id !== savedPostVersion.id) {
      undoTargetVersionId = savedPreVersion.id;
      await saveVersionHistoryToDB();
    }
    renderVersionHistoryUI();

    await yieldFrame(240);
    setLiveProgress(false);

    if (warnings.length === 0) {
      showStatus(
        'updateStatus',
        'success',
        t('st_updated_ok_title', { name: dirHandle.name }),
        t('st_updated_ok_desc', { count: logs.length }),
        logs
      );
    } else {
      showStatus(
        'updateStatus',
        'warn',
        t('st_updated_warn_title', { warns: warnings.length }),
        t('st_updated_warn_desc', { count: logs.length }),
        [...logs, ...warnings]
      );
    }
  } catch (err) {
    setLiveProgress(false);
    if (isLikelyTruncatedJson(rawInput)) {
      if (truncBox) truncBox.classList.add('show');
      showStatus(
        'updateStatus',
        'error',
        t('st_truncated_json_title'),
        t('st_truncated_json_desc')
      );
    } else {
      if (truncBox) truncBox.classList.remove('show');
      showStatus(
        'updateStatus',
        'error',
        t('st_invalid_json_title'),
        t('st_invalid_json_desc', { msg: err.message })
      );
    }
  } finally {
    isMutatingDisk = false;
    renderVersionHistoryUI();
  }
}

// === BIND PERMANENT UI EVENTS ===
function bindPermanentUIEvents() {
  const doc = mainWindow.document;

  doc.getElementById('brandLink')?.addEventListener('click', (e) => {
    e.preventDefault();
    switchPageView('workspace');
  });

  doc.getElementById('scrollToGuideBtn')?.addEventListener('click', (e) => {
    e.preventDefault();
    cleanUrlHash();
    doc.getElementById('stappenplan')?.scrollIntoView({ behavior: 'smooth' });
  });

  doc.addEventListener('click', (e) => {
    const viewBtn = e.target.closest('[data-switch-view]');
    if (viewBtn) {
      e.preventDefault();
      switchPageView(viewBtn.getAttribute('data-switch-view'));
      return;
    }

    const langBtn = e.target.closest('[data-lang-switch]');
    if (langBtn) {
      setLanguage(langBtn.getAttribute('data-lang-switch'), true, true);
      return;
    }

    const closeBtn = e.target.closest('[data-close-status]');
    if (closeBtn) {
      hideStatus(closeBtn.getAttribute('data-close-status'), true);
    }
  });

  mainWindow.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeDisconnectConfirmModal();
    }
  });

  doc.getElementById('closePipPlaceholderBtn')?.addEventListener('click', () => closeFloatingPiP());
  doc.getElementById('closePipFloatingBtn')?.addEventListener('click', () => closeFloatingPiP());
  doc.getElementById('togglePipBtn')?.addEventListener('click', () => toggleFloatingPiP());

  // Topbar & PiP Folder Controls
  doc.getElementById('refreshFolderBtn')?.addEventListener('click', () => refreshFileList(true, 'manual_refresh', false));
  doc.getElementById('pipRefreshBtn')?.addEventListener('click', () => refreshFileList(true, 'manual_refresh', false));
  doc.getElementById('switchFolderBtn')?.addEventListener('click', () => selectFolder());
  doc.getElementById('pipSwitchFolderBtn')?.addEventListener('click', () => selectFolder());
  doc.getElementById('disconnectFolderBtn')?.addEventListener('click', () => openDisconnectConfirmModal());
  doc.getElementById('pipDisconnectBtn')?.addEventListener('click', () => openDisconnectConfirmModal());

  // Disconnect Confirmation Modal
  doc.getElementById('closeDisconnectModalXBtn')?.addEventListener('click', () => closeDisconnectConfirmModal());
  doc.getElementById('cancelDisconnectModalBtn')?.addEventListener('click', () => closeDisconnectConfirmModal());
  doc.getElementById('confirmDisconnectModalBtn')?.addEventListener('click', () => disconnectFolder(false));

  doc.getElementById('copySysPromptBtn')?.addEventListener('click', () => copyPrompt());
  doc.getElementById('reconnectBtn')?.addEventListener('click', () => reconnectSavedFolder());
  doc.getElementById('selectFolderBtn')?.addEventListener('click', () => selectFolder());
  doc.getElementById('toggleFileDrawerBtn')?.addEventListener('click', () => toggleFileDrawer());

  doc.getElementById('selectAllFilesBtn')?.addEventListener('click', () => toggleAllFiles(true));
  doc.getElementById('deselectAllFilesBtn')?.addEventListener('click', () => toggleAllFiles(false));

  // Step 2: Output Limit Dropdown, Prompt & Copy Actions
  doc.getElementById('outputLimitSelect')?.addEventListener('change', () => savePromptState());
  doc.getElementById('userPromptInput')?.addEventListener('input', () => savePromptState());
  doc.getElementById('clearPromptBtn')?.addEventListener('click', () => clearPromptInput(true));
  doc.getElementById('includePromptChk')?.addEventListener('change', () => savePromptState());

  doc.getElementById('copyProjectBtn')?.addEventListener('click', () => exportProject(false));
  doc.getElementById('copyDeltaSyncBtn')?.addEventListener('click', () => copyDeltaSyncPrompt());
  doc.getElementById('copyFollowUpBtn')?.addEventListener('click', () => copyFollowUpPrompt(false));
  doc.getElementById('downloadTxtBtn')?.addEventListener('click', () => exportProject(true));

  // Step 3: Update Actions, Undo, Version History, Manual Paste Toggle & Cut-off JSON Recovery
  doc.getElementById('updateClipboardBtn')?.addEventListener('click', () => updateFromClipboard());
  doc.getElementById('undoLastUpdateBtn')?.addEventListener('click', () => undoLastUpdate());

  doc.getElementById('toggleVersionHistoryBtn')?.addEventListener('click', () => {
    const activeDoc = getDoc();
    const panelEl = activeDoc.getElementById('versionHistoryPanel');
    const toggleBtn = activeDoc.getElementById('toggleVersionHistoryBtn');
    if (panelEl) {
      const isOpen = panelEl.classList.toggle('show');
      if (toggleBtn) {
        toggleBtn.classList.toggle('active', isOpen);
        toggleBtn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
      }
      if (isOpen) {
        renderVersionHistoryUI();
      }
    }
  });

  doc.getElementById('toggleManualPasteBtn')?.addEventListener('click', () => {
    const activeDoc = getDoc();
    const panelEl = activeDoc.getElementById('manualPastePanel');
    const toggleBtn = activeDoc.getElementById('toggleManualPasteBtn');
    if (panelEl) {
      const isOpen = panelEl.classList.toggle('show');
      if (toggleBtn) {
        toggleBtn.classList.toggle('active', isOpen);
        toggleBtn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
      }
      if (isOpen) {
        activeDoc.getElementById('aiPatchInput')?.focus();
      }
    }
  });

  doc.getElementById('copyContinueJsonBtn')?.addEventListener('click', () => copyTruncatedJsonRecoveryPrompt());
  doc.getElementById('manualUpdateBtn')?.addEventListener('click', () => {
    const val = getDoc().getElementById('aiPatchInput')?.value || '';
    updateFolderDirectly(val);
  });

  const panel = doc.getElementById('workspacePanel');
  if (panel) {
    panel.addEventListener('change', (e) => {
      if (e.target && e.target.classList.contains('file-chk')) {
        saveUncheckedSet();
      }
    });

    panel.addEventListener('click', (e) => {
      if (e.target && e.target.id === 'disconnectConfirmModal') {
        closeDisconnectConfirmModal();
        return;
      }
      const restoreBtn = e.target.closest('[data-restore-version]');
      if (restoreBtn) {
        const verId = restoreBtn.getAttribute('data-restore-version');
        if (verId) restoreVersionById(verId);
      }
    });
  }

  mainWindow.addEventListener('focus', () => {
    checkExternalFolderChanges();
  });
  doc.addEventListener('visibilitychange', () => {
    if (!doc.hidden) checkExternalFolderChanges();
  });
}

// === BOOTSTRAP APPLICATION ===
mainWindow.addEventListener('DOMContentLoaded', () => {
  bindPermanentUIEvents();
  initSavedSession();
});