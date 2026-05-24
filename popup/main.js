/**
 * GemLog Next — Popup / Side Panel Controller
 */
import { applyTranslations, showToast, downloadFile, formatDate, escapeHtml, sanitizeFilename, isValidHttpsUrl } from './utils.js';

// ===== 状態管理 =====
let currentSession  = null;
let sidebarList     = [];          // Gemini サイドバーから取得した会話一覧
let selectedChatIds = new Set();
let viewMode        = 'current';   // 'current' | 'select'
let refreshTimer    = null;

// バルクダウンロード状態（null = アイドル）
let bulkState = null;

// 現在のチャットのスクロール&ダウンロード状態
let currentScrollState = null;
/* { tabId, format, waitingForScroll, scrollTimeout } */
/* {
     tabId: number,
     queue: [{chatId, title, url}],
     format: string,
     completed: number,
     failed: number,
     waitingForScroll: boolean,
     scrollTimeout: id | null
   } */

// ===== ビュー切替 =====
function switchView(mode) {
  viewMode = mode;
  document.getElementById('currentView').style.display = mode === 'current' ? '' : 'none';
  document.getElementById('selectView').style.display  = mode === 'select'  ? '' : 'none';
}

// ===== 現在のチャット（デフォルトビュー）=====

async function loadCurrentTab() {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const isGemini = activeTab?.url?.startsWith('https://gemini.google.com/');

  if (!isGemini) {
    currentSession = null;
    renderCurrentCard(null);
    document.getElementById('currentDownloadBtn').disabled = true;
    return;
  }

  const allData = await GemLogSession.getAll();
  const found   = allData.find(s => s.tabId === activeTab.id);

  currentSession = found
    ? { ...found, tab: activeTab }
    : {
        tabId:        activeTab.id,
        tab:          activeTab,
        title:        (activeTab.title || '').replace(/\s*[-–]\s*(Gemini|Google).*$/i, '').trim() || 'Gemini',
        messages:     [],
        messageCount: 0,
        noData:       true
      };

  renderCurrentCard(currentSession);
  document.getElementById('currentDownloadBtn').disabled = false;
}

function renderCurrentCard(session) {
  const wrap = document.getElementById('currentCardWrap');
  if (!session) {
    wrap.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">💬</div>
        <div class="empty-title" data-i18n="noSessionsTitle"></div>
        <div class="empty-sub"  data-i18n="noSessionsSub"></div>
        <div class="empty-hint" data-i18n="noSessionsHint"></div>
      </div>`;
    applyTranslations();
    document.getElementById('currentDownloadBtn').disabled = true;
    return;
  }
  const count = session.messageCount || session.messages?.length || 0;
  const time  = session.updatedAt  ? formatDate(session.updatedAt)
              : session.startedAt  ? formatDate(session.startedAt) : '—';
  wrap.innerHTML = `
    <div class="current-card">
      <div class="card-title">${escapeHtml(session.title)}</div>
      <div class="card-meta">
        <span class="msg-badge">${count} ${chrome.i18n.getMessage('itemCount')}</span>
        <span class="dot">·</span>
        <span>${time}</span>
      </div>
      ${count === 0 ? `<div class="card-notice">💡 メッセージを取得中です。会話後にリフレッシュしてください。</div>` : ''}
    </div>`;
}

// ===== 選択ビュー: Gemini サイドバー一覧 =====

async function loadSelectView() {
  const list = document.getElementById('sessionList');
  list.innerHTML = '<div class="loading-msg">⏳ Geminiサイドバーを読み込み中...</div>';
  selectedChatIds.clear();
  updateDownloadButton();
  updateSelectAllCheckbox();

  try {
    const tabs = await chrome.tabs.query({ url: 'https://gemini.google.com/*', currentWindow: true });
    if (!tabs.length) {
      showSelectEmpty('Geminiのタブが開いていません');
      return;
    }

    const resp = await chrome.tabs.sendMessage(tabs[0].id, { action: 'getSidebarList' });
    sidebarList = resp?.conversations || [];
    renderSidebarList();
  } catch {
    showSelectEmpty('取得に失敗しました。Geminiタブを開いて再試行してください。');
  }
}

function showSelectEmpty(msg) {
  document.getElementById('sessionList').innerHTML = `
    <div class="empty-state">
      <div class="empty-icon">💬</div>
      <div class="empty-title">${escapeHtml(msg)}</div>
    </div>`;
  updateDownloadButton();
}

function renderSidebarList() {
  const list = document.getElementById('sessionList');
  if (!sidebarList.length) {
    showSelectEmpty('サイドバーに会話が見つかりません');
    return;
  }

  list.innerHTML = sidebarList.map((c, i) => `
    <div class="session-item${selectedChatIds.has(c.chatId) ? ' selected' : ''}${c.current ? ' is-current' : ''}"
         data-chatid="${escapeHtml(c.chatId)}" style="animation-delay:${i * 25}ms">
      <input type="checkbox" class="session-checkbox" data-chatid="${escapeHtml(c.chatId)}"
             ${selectedChatIds.has(c.chatId) ? 'checked' : ''}>
      <div class="session-info">
        <div class="session-title">${escapeHtml(c.title)}</div>
        ${c.current ? '<div class="session-meta"><span class="current-badge">現在のチャット</span></div>' : ''}
      </div>
    </div>`).join('');

  list.querySelectorAll('.session-checkbox').forEach(chk => {
    chk.addEventListener('change', () => {
      const id = chk.dataset.chatid;
      chk.checked ? selectedChatIds.add(id) : selectedChatIds.delete(id);
      chk.closest('.session-item').classList.toggle('selected', chk.checked);
      updateDownloadButton();
      updateSelectAllCheckbox();
    });
  });

  list.querySelectorAll('.session-item').forEach(item => {
    item.addEventListener('click', e => {
      if (e.target.classList.contains('session-checkbox')) return;
      const chk = item.querySelector('.session-checkbox');
      chk.checked = !chk.checked;
      chk.dispatchEvent(new Event('change'));
    });
  });

  updateSelectAllCheckbox();
  updateDownloadButton();
}

function updateDownloadButton() {
  const btn = document.getElementById('downloadBtn');
  const n   = selectedChatIds.size;
  btn.disabled    = n === 0 || !!bulkState;
  btn.textContent = `⬇ ダウンロード (${n})`;
}

function updateSelectAllCheckbox() {
  const chk   = document.getElementById('selectAllChk');
  const total = sidebarList.length;
  if (!total)                              { chk.checked = false; chk.indeterminate = false; }
  else if (selectedChatIds.size === total) { chk.checked = true;  chk.indeterminate = false; }
  else if (selectedChatIds.size > 0)      { chk.checked = false; chk.indeterminate = true;  }
  else                                    { chk.checked = false; chk.indeterminate = false; }
}

// ===== バルクダウンロード（遷移 → autoScroll → キャプチャ → DL）=====

async function startBulkDownload() {
  if (bulkState) return;
  const targets = sidebarList.filter(c => selectedChatIds.has(c.chatId));
  if (!targets.length) return;

  const format = document.getElementById('downloadFormatBulk').value;
  const tabs   = await chrome.tabs.query({ url: 'https://gemini.google.com/*', currentWindow: true });
  if (!tabs.length) { showToast('Geminiのタブが見つかりません'); return; }

  bulkState = {
    tabId:            tabs[0].id,
    queue:            [...targets],
    format,
    completed:        0,
    failed:           0,
    waitingForScroll: false,
    scrollTimeout:    null
  };

  document.getElementById('downloadBtn').disabled      = true;
  document.getElementById('selectAllChk').disabled     = true;
  document.getElementById('sessionList').style.opacity = '0.45';
  document.getElementById('bulkCancelBtn').style.display = '';

  processNextInQueue();
}

async function processNextInQueue() {
  if (!bulkState) return;

  if (!bulkState.queue.length) {
    // 全件完了
    const { completed, failed } = bulkState;
    bulkState = null;
    document.getElementById('selectAllChk').disabled      = false;
    document.getElementById('sessionList').style.opacity  = '';
    document.getElementById('bulkCancelBtn').style.display = 'none';
    updateDownloadButton();
    showToast(
      `✅ ${completed}件ダウンロード完了${failed ? `（${failed}件失敗）` : ''}`,
      5000
    );
    return;
  }

  const next  = bulkState.queue.shift();
  const done  = bulkState.completed + bulkState.failed;
  const total = done + bulkState.queue.length + 1;
  showToast(`📥 (${done + 1}/${total}) ${next.title}`, 120000);

  // 1. 対象 URL へ遷移
  try {
    await chrome.tabs.update(bulkState.tabId, { url: next.url });
  } catch {
    bulkState.failed++;
    processNextInQueue();
    return;
  }

  // 2. ページロード + content script 初期化を待つ
  await new Promise(r => setTimeout(r, 3000));

  // 3. scroll シグナル待機フラグを立ててからタイムアウトをセット
  bulkState.waitingForScroll = true;
  bulkState.scrollTimeout    = setTimeout(onScrollDone, 180000); // 3分タイムアウト

  // 4. autoScroll 送信（ページトップまでスクロールして全履歴取得）
  let sent = false;
  for (let i = 0; i < 3 && !sent; i++) {
    try {
      await chrome.tabs.sendMessage(bulkState.tabId, { action: 'autoScroll' });
      sent = true;
    } catch {
      await new Promise(r => setTimeout(r, 1500));
    }
  }

  if (!sent) {
    // content script に届かなかった
    if (bulkState.scrollTimeout) { clearTimeout(bulkState.scrollTimeout); bulkState.scrollTimeout = null; }
    bulkState.waitingForScroll = false;
    bulkState.failed++;
    processNextInQueue();
  }
}

// autoScroll 完了時（storage.onChanged または タイムアウト）
async function onScrollDone() {
  if (!bulkState?.waitingForScroll) return; // 二重呼び出し防止
  bulkState.waitingForScroll = false;
  if (bulkState.scrollTimeout) { clearTimeout(bulkState.scrollTimeout); bulkState.scrollTimeout = null; }

  const session = await GemLogSession.get(bulkState.tabId);
  if (session?.messages?.length > 0) {
    downloadOneSession(session, bulkState.format);
    bulkState.completed++;
  } else {
    bulkState.failed++;
  }

  await new Promise(r => setTimeout(r, 500));
  processNextInQueue();
}

// background が session ストレージに立てたシグナルを検知
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'session') return;
  for (const key of Object.keys(changes)) {
    if (!key.startsWith('gemlog_scrolldone_') || !changes[key].newValue) continue;
    const tid = parseInt(key.replace('gemlog_scrolldone_', ''), 10);

    if (bulkState?.waitingForScroll && tid === bulkState.tabId) {
      chrome.storage.session.remove(key);
      onScrollDone();
      break;
    }
    if (currentScrollState?.waitingForScroll && tid === currentScrollState.tabId) {
      chrome.storage.session.remove(key);
      onCurrentScrollDone();
      break;
    }
  }
});

// ===== 現在のチャット: スクロール完了 / キャンセル =====

async function onCurrentScrollDone() {
  if (!currentScrollState?.waitingForScroll) return;
  currentScrollState.waitingForScroll = false;
  if (currentScrollState.scrollTimeout) {
    clearTimeout(currentScrollState.scrollTimeout);
    currentScrollState.scrollTimeout = null;
  }

  const { tabId, format } = currentScrollState;
  currentScrollState = null;
  document.getElementById('currentCancelBtn').style.display = 'none';
  document.getElementById('currentDownloadBtn').disabled    = false;

  const session = await GemLogSession.get(tabId);
  if (session?.messages?.length > 0) {
    downloadOneSession(session, format);
    showToast(`1 ${chrome.i18n.getMessage('toastDownloaded')}`);
    currentSession = { ...session };
    renderCurrentCard(currentSession);
  } else {
    showToast('メッセージが取得できませんでした');
  }
}

function cancelCurrentDownload() {
  if (!currentScrollState) return;
  const tabId = currentScrollState.tabId;
  if (currentScrollState.scrollTimeout) clearTimeout(currentScrollState.scrollTimeout);
  currentScrollState = null;
  document.getElementById('currentCancelBtn').style.display = 'none';
  document.getElementById('currentDownloadBtn').disabled    = false;
  chrome.tabs.sendMessage(tabId, { action: 'stopScroll' }).catch(() => {});
  showToast('ダウンロードを中止しました');
}

function cancelBulkDownload() {
  if (!bulkState) return;
  if (bulkState.scrollTimeout) clearTimeout(bulkState.scrollTimeout);
  const { completed, failed, tabId } = bulkState;
  bulkState = null;
  if (tabId) chrome.tabs.sendMessage(tabId, { action: 'stopScroll' }).catch(() => {});
  document.getElementById('selectAllChk').disabled      = false;
  document.getElementById('sessionList').style.opacity  = '';
  document.getElementById('bulkCancelBtn').style.display = 'none';
  updateDownloadButton();
  showToast(
    `中止しました（完了 ${completed}件${failed ? `・失敗 ${failed}件` : ''}）`,
    4000
  );
}

// ===== ダウンロード共通 =====

function downloadOneSession(session, format) {
  const safeName = sanitizeFilename(session.title || 'chat');
  const date     = (session.startedAt || new Date().toISOString()).split('T')[0];
  const filename  = `${safeName}_${date}`;
  let content, mime;
  if (format === 'json') {
    content = GemLogSession.chatToJSON(session);     mime = 'application/json';
    downloadFile(`${filename}.json`, content, mime);
  } else if (format === 'obsidian') {
    content = GemLogSession.chatToObsidian(session); mime = 'text/markdown';
    downloadFile(`${filename}.md`, content, mime);
  } else {
    content = GemLogSession.chatToMarkdown(session); mime = 'text/markdown';
    downloadFile(`${filename}.md`, content, mime);
  }
}

async function downloadCurrentSession() {
  if (currentScrollState) return; // スクロール中は二重実行禁止

  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!activeTab?.url?.startsWith('https://gemini.google.com/')) {
    showToast('Geminiのタブが開いていません'); return;
  }

  const format = document.getElementById('downloadFormat').value;
  const btn    = document.getElementById('currentDownloadBtn');
  btn.disabled = true;
  showToast('⏳ 全履歴をスクロール取得中...', 120000);

  currentScrollState = {
    tabId:            activeTab.id,
    format,
    waitingForScroll: true,
    scrollTimeout:    setTimeout(onCurrentScrollDone, 180000)
  };
  document.getElementById('currentCancelBtn').style.display = '';

  try {
    await chrome.tabs.sendMessage(activeTab.id, { action: 'autoScroll' });
  } catch {
    cancelCurrentDownload();
    showToast('スクロールの送信に失敗しました');
  }
}

// ===== ストレージ使用量 =====

async function updateStorageUsage() {
  try {
    const bytes   = await new Promise(r => chrome.storage.session.getBytesInUse(null, r));
    const kb      = (bytes / 1024).toFixed(1);
    const percent = Math.min((bytes / (10 * 1024 * 1024)) * 100, 100);
    document.getElementById('storageUsage').textContent = `${kb} KB / 10 MB`;
    document.getElementById('storageBar').style.width   = `${percent.toFixed(1)}%`;
  } catch {
    document.getElementById('storageUsage').textContent = '—';
  }
}

// ===== 設定 =====

async function loadSettings() {
  const s = await GemLogSettings.get();
  document.getElementById('apiProvider').value        = s.apiProvider;
  document.getElementById('apiKey').value             = s.apiKey || '';
  document.getElementById('apiModel').value           = s.apiModel || '';
  document.getElementById('apiEndpoint').value        = s.apiEndpoint || '';
  document.getElementById('exportFormat').value       = s.exportFormat || 'markdown';
  document.getElementById('downloadFormat').value     = s.exportFormat || 'markdown';
  document.getElementById('downloadFormatBulk').value = s.exportFormat || 'markdown';
  toggleApiFields(s.apiProvider);
  validateEndpointUrl();
}

async function saveSettings() {
  const provider = document.getElementById('apiProvider').value;
  const endpoint = document.getElementById('apiEndpoint').value.trim();
  if (provider === 'custom' && endpoint && !isValidHttpsUrl(endpoint)) {
    showToast(chrome.i18n.getMessage('errEndpointNotHttps')); return;
  }
  const exportFormat = document.getElementById('exportFormat').value;
  await GemLogSettings.save({
    apiProvider:  provider,
    apiKey:       document.getElementById('apiKey').value,
    apiModel:     document.getElementById('apiModel').value,
    apiEndpoint:  endpoint,
    exportFormat
  });
  document.getElementById('downloadFormat').value     = exportFormat;
  document.getElementById('downloadFormatBulk').value = exportFormat;
  showToast(chrome.i18n.getMessage('toastSettingsSaved'));
}

function toggleApiFields(provider) {
  document.getElementById('apiFields').style.display     = provider === 'none' ? 'none' : 'flex';
  document.getElementById('endpointGroup').style.display = provider === 'custom' ? 'block' : 'none';
}

function validateEndpointUrl() {
  const input  = document.getElementById('apiEndpoint');
  const status = document.getElementById('urlStatus');
  const error  = document.getElementById('endpointError');
  const value  = input.value.trim();
  if (!value) {
    status.textContent = ''; status.className = 'url-status';
    error.classList.remove('visible'); input.classList.remove('error');
    return;
  }
  if (isValidHttpsUrl(value)) {
    status.textContent = '✓ Valid HTTPS URL'; status.className = 'url-status valid';
    error.classList.remove('visible'); input.classList.remove('error');
  } else {
    status.textContent = '✗ Invalid'; status.className = 'url-status invalid';
    error.classList.add('visible'); input.classList.add('error');
  }
}

// ===== タブ切替 =====

function switchTab(name) {
  document.querySelectorAll('.tab').forEach(t =>
    t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.panel').forEach(p => {
    const active = p.id === 'panel' + name.charAt(0).toUpperCase() + name.slice(1);
    p.classList.toggle('active', active);
    p.style.display = active ? '' : 'none';
  });
}

// ===== 自動リフレッシュ（currentView のみ）=====

function startAutoRefresh() {
  stopAutoRefresh();
  refreshTimer = setInterval(() => {
    if (viewMode === 'current') {
      loadCurrentTab();
      updateStorageUsage();
    }
  }, 5000);
}

function stopAutoRefresh() {
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
}

// ===== イベントリスナー =====

document.querySelectorAll('.tab').forEach(tab =>
  tab.addEventListener('click', () => switchTab(tab.dataset.tab)));

document.getElementById('refreshBtn').addEventListener('click', () => {
  if (viewMode === 'current') loadCurrentTab();
  else if (!bulkState)        loadSelectView(); // ダウンロード中は再読み込み禁止
  showToast(chrome.i18n.getMessage('toastRescanned'));
});

document.getElementById('currentDownloadBtn').addEventListener('click', downloadCurrentSession);

document.getElementById('selectModeBtn').addEventListener('click', () => {
  switchView('select');
  loadSelectView();
});

document.getElementById('backBtn').addEventListener('click', () => {
  if (bulkState) return; // ダウンロード中は戻れない
  switchView('current');
  loadCurrentTab();
});

document.getElementById('selectAllChk').addEventListener('change', e => {
  if (e.target.checked) selectedChatIds = new Set(sidebarList.map(c => c.chatId));
  else                  selectedChatIds.clear();
  renderSidebarList();
  updateDownloadButton();
});

document.getElementById('downloadBtn').addEventListener('click', startBulkDownload);
document.getElementById('currentCancelBtn').addEventListener('click', cancelCurrentDownload);
document.getElementById('bulkCancelBtn').addEventListener('click', cancelBulkDownload);

document.getElementById('apiProvider').addEventListener('change', e => toggleApiFields(e.target.value));
document.getElementById('apiEndpoint').addEventListener('input',  validateEndpointUrl);
document.getElementById('saveSettingsBtn').addEventListener('click', saveSettings);

document.getElementById('apiKeyToggle').addEventListener('click', () => {
  const input = document.getElementById('apiKey');
  const btn   = document.getElementById('apiKeyToggle');
  input.type      = input.type === 'password' ? 'text' : 'password';
  btn.textContent = input.type === 'password' ? '👁' : '🙈';
});

// ===== 初期化 =====

async function init() {
  applyTranslations();
  switchView('current');
  await loadSettings();
  await loadCurrentTab();
  await updateStorageUsage();
  startAutoRefresh();
  window.addEventListener('unload', stopAutoRefresh);
}

init();
