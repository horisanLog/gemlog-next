/**
 * GemLog Next — Popup Main Controller (Session-based)
 *
 * セキュリティ設計:
 *   - 永続ストレージを使用しない
 *   - 現在開いているGeminiタブのセッションのみ表示
 *   - ダウンロードはユーザーが明示的に選択したものだけ
 */
import { applyTranslations, showToast, downloadFile, formatDate, escapeHtml, sanitizeFilename, isValidHttpsUrl } from './utils.js';

// ===== 状態管理 =====
let selectedTabIds = new Set();
let allSessions    = [];
let refreshTimer   = null;

// ===== セッション一覧の取得と描画 =====

async function loadSessions() {
  // 開いている全Geminiタブを取得
  const geminiTabs = await chrome.tabs.query({ url: 'https://gemini.google.com/*' });
  const tabMap     = Object.fromEntries(geminiTabs.map(t => [t.id, t]));

  // セッションデータを取得
  const sessions = await GemLogSession.getAll();

  // 存在するタブのセッションのみ表示（孤立セッションは除外）
  allSessions = sessions
    .filter(s => tabMap[s.tabId])
    .map(s => ({ ...s, tab: tabMap[s.tabId] }))
    .sort((a, b) => new Date(b.updatedAt || b.startedAt) - new Date(a.updatedAt || a.startedAt));

  // 選択済みセットを有効なタブIDに絞る
  const validIds = new Set(allSessions.map(s => s.tabId));
  selectedTabIds = new Set([...selectedTabIds].filter(id => validIds.has(id)));

  renderSessionList();
  updateDownloadButton();
  await updateStorageUsage();
}

function renderSessionList() {
  const container = document.getElementById('sessionList');

  if (allSessions.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">💬</div>
        <div class="empty-title" data-i18n="noSessionsTitle">Geminiのタブが開いていません</div>
        <div class="empty-sub" data-i18n="noSessionsSub">Geminiでチャットを始めると、セッションが表示されます</div>
        <div class="empty-hint" data-i18n="noSessionsHint">→ gemini.google.com を開いてください</div>
      </div>`;
    applyTranslations();
    return;
  }

  container.innerHTML = allSessions.map((s, i) => {
    const isSelected = selectedTabIds.has(s.tabId);
    const count      = s.messageCount || s.messages?.length || 0;
    const time       = s.updatedAt ? formatDate(s.updatedAt) : formatDate(s.startedAt);
    const title      = s.title || chrome.i18n.getMessage('untitledChat');

    return `
      <div class="session-item${isSelected ? ' selected' : ''}" data-tabid="${s.tabId}" style="animation-delay:${i * 40}ms">
        <input type="checkbox" class="session-checkbox" data-tabid="${s.tabId}" ${isSelected ? 'checked' : ''}>
        <div class="session-info">
          <div class="session-title">${escapeHtml(title)}</div>
          <div class="session-meta">
            <span class="msg-badge">${count} ${chrome.i18n.getMessage('itemCount')}</span>
            <span class="dot">·</span>
            <span>${time}</span>
            <span class="dot">·</span>
            <span>Tab ${s.tabId}</span>
          </div>
        </div>
        <div class="session-actions">
          <button class="btn xs single-dl-btn" data-tabid="${s.tabId}" title="Download this session">⬇</button>
        </div>
      </div>`;
  }).join('');

  // イベント: チェックボックス
  container.querySelectorAll('.session-checkbox').forEach(chk => {
    chk.addEventListener('change', () => {
      const id = parseInt(chk.dataset.tabid);
      if (chk.checked) selectedTabIds.add(id);
      else              selectedTabIds.delete(id);

      // カードの selected クラスを更新
      chk.closest('.session-item').classList.toggle('selected', chk.checked);
      updateDownloadButton();
      updateSelectAllCheckbox();
    });
  });

  // イベント: カードクリック（チェックボックス以外の領域）
  container.querySelectorAll('.session-item').forEach(item => {
    item.addEventListener('click', e => {
      if (e.target.classList.contains('session-checkbox') ||
          e.target.closest('.session-actions')) return;
      const chk = item.querySelector('.session-checkbox');
      chk.checked = !chk.checked;
      chk.dispatchEvent(new Event('change'));
    });
  });

  // イベント: 単体ダウンロードボタン
  container.querySelectorAll('.single-dl-btn').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const tabId = parseInt(btn.dataset.tabid);
      const s     = allSessions.find(x => x.tabId === tabId);
      if (s) await downloadSessions([s]);
    });
  });

  updateSelectAllCheckbox();
}

function updateDownloadButton() {
  const btn   = document.getElementById('downloadBtn');
  const count = selectedTabIds.size;
  btn.disabled  = count === 0;
  btn.textContent = `⬇ ${chrome.i18n.getMessage('btnDownloadLabel')} (${count})`;
}

function updateSelectAllCheckbox() {
  const chk = document.getElementById('selectAllChk');
  if (allSessions.length === 0) {
    chk.checked       = false;
    chk.indeterminate = false;
  } else if (selectedTabIds.size === allSessions.length) {
    chk.checked       = true;
    chk.indeterminate = false;
  } else if (selectedTabIds.size > 0) {
    chk.checked       = false;
    chk.indeterminate = true;
  } else {
    chk.checked       = false;
    chk.indeterminate = false;
  }
}

// ===== ダウンロード =====

async function downloadSessions(sessions) {
  if (!sessions.length) return;

  const format = document.getElementById('downloadFormat').value;

  for (let i = 0; i < sessions.length; i++) {
    const s        = sessions[i];
    const safeName = sanitizeFilename(s.title || 'chat');
    const date     = (s.startedAt || new Date().toISOString()).split('T')[0];
    const filename = `${safeName}_${date}`;

    let content, mime;
    if (format === 'json') {
      content = GemLogSession.chatToJSON(s);
      mime    = 'application/json';
      downloadFile(`${filename}.json`, content, mime);
    } else if (format === 'obsidian') {
      content = GemLogSession.chatToObsidian(s);
      mime    = 'text/markdown';
      downloadFile(`${filename}.md`, content, mime);
    } else {
      content = GemLogSession.chatToMarkdown(s);
      mime    = 'text/markdown';
      downloadFile(`${filename}.md`, content, mime);
    }

    // 複数ファイルを連続ダウンロードする場合に少し間隔を空ける
    if (i < sessions.length - 1) {
      await new Promise(r => setTimeout(r, 250));
    }
  }

  showToast(`${sessions.length} ${chrome.i18n.getMessage('toastDownloaded')}`);
}

// ===== ストレージ使用量 =====

async function updateStorageUsage() {
  try {
    // chrome.storage.session の使用量（getBytesInUse はセッションも対応）
    const bytes   = await new Promise(r => chrome.storage.session.getBytesInUse(null, r));
    const kb      = (bytes / 1024).toFixed(1);
    const percent = Math.min((bytes / (10 * 1024 * 1024)) * 100, 100); // 上限10MB
    document.getElementById('storageUsage').textContent = `${kb} KB / 10 MB`;
    document.getElementById('storageBar').style.width   = `${percent.toFixed(1)}%`;
  } catch {
    // getBytesInUse が session に未対応の Chrome バージョン対策
    document.getElementById('storageUsage').textContent = '—';
  }
}

// ===== 設定 =====

async function loadSettings() {
  const s = await GemLogSettings.get();
  document.getElementById('apiProvider').value  = s.apiProvider;
  document.getElementById('apiKey').value       = s.apiKey || '';
  document.getElementById('apiModel').value     = s.apiModel || '';
  document.getElementById('apiEndpoint').value  = s.apiEndpoint || '';
  document.getElementById('exportFormat').value = s.exportFormat || 'markdown';
  toggleApiFields(s.apiProvider);
  validateEndpointUrl();
}

async function saveSettings() {
  const provider = document.getElementById('apiProvider').value;
  const endpoint = document.getElementById('apiEndpoint').value.trim();

  if (provider === 'custom' && endpoint && !isValidHttpsUrl(endpoint)) {
    showToast(chrome.i18n.getMessage('errEndpointNotHttps'));
    return;
  }

  await GemLogSettings.save({
    apiProvider:  provider,
    apiKey:       document.getElementById('apiKey').value,
    apiModel:     document.getElementById('apiModel').value,
    apiEndpoint:  endpoint,
    exportFormat: document.getElementById('exportFormat').value
  });

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
    return true;
  }
  if (isValidHttpsUrl(value)) {
    status.textContent = '✓ Valid HTTPS URL'; status.className = 'url-status valid';
    error.classList.remove('visible'); input.classList.remove('error');
    return true;
  }
  status.textContent = '✗ Invalid'; status.className = 'url-status invalid';
  error.classList.add('visible'); input.classList.add('error');
  return false;
}

// ===== タブ切替 =====

function switchTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.panel').forEach(p => {
    const active = p.id === 'panel' + name.charAt(0).toUpperCase() + name.slice(1);
    p.classList.toggle('active', active);
    p.style.display = active ? '' : 'none';
  });
}

// ===== 自動リフレッシュ =====

function startAutoRefresh() {
  stopAutoRefresh();
  refreshTimer = setInterval(loadSessions, 5000);
}

function stopAutoRefresh() {
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
}

// ===== イベントリスナー =====

document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => switchTab(tab.dataset.tab));
});

document.getElementById('refreshBtn').addEventListener('click', () => {
  loadSessions();
  showToast(chrome.i18n.getMessage('toastRescanned'));
});

// セッションパネルの「すべて選択」
document.getElementById('selectAllChk').addEventListener('change', e => {
  if (e.target.checked) {
    selectedTabIds = new Set(allSessions.map(s => s.tabId));
  } else {
    selectedTabIds.clear();
  }
  renderSessionList();
  updateDownloadButton();
});

// ダウンロードボタン
document.getElementById('downloadBtn').addEventListener('click', async () => {
  const targets = allSessions.filter(s => selectedTabIds.has(s.tabId));
  await downloadSessions(targets);
});

// 設定
document.getElementById('apiProvider').addEventListener('change', e => toggleApiFields(e.target.value));
document.getElementById('apiEndpoint').addEventListener('input',  validateEndpointUrl);
document.getElementById('saveSettingsBtn').addEventListener('click', saveSettings);

document.getElementById('apiKeyToggle').addEventListener('click', () => {
  const input = document.getElementById('apiKey');
  const btn   = document.getElementById('apiKeyToggle');
  input.type       = input.type === 'password' ? 'text' : 'password';
  btn.textContent  = input.type === 'password' ? '👁' : '🙈';
});

// ===== 初期化 =====

async function init() {
  applyTranslations();
  await loadSettings();
  await loadSessions();
  startAutoRefresh();

  // popupが閉じたら自動リフレッシュを停止
  window.addEventListener('unload', stopAutoRefresh);
}

init();
