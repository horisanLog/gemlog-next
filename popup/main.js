/**
 * GemLog Next — Main Controller
 * 全モジュールの統合・イベントリスナー登録・初期化を担当する。
 */
import { applyTranslations, showToast, downloadFile, formatDate, escapeHtml, sanitizeFilename, isValidHttpsUrl } from './utils.js';
import { summarizeCurrentChat, copySummary } from './api-manager.js';
import { switchTab, updateStorageUsage, toggleApiFields, openChatDetail, renderManagedList, validateEndpointUrl } from './ui-manager.js';

let currentChatId = null;
const setCurrentChatId = id => { currentChatId = id; };

// ===== チャット一覧描画 =====

async function renderChatList(searchQuery = '') {
  const container = document.getElementById('chatList');
  const settings  = await GemLogStorage.getSettings();
  const favorites = settings.favorites || [];

  // 検索またはインデックス全件取得
  let chats;
  if (searchQuery.trim()) {
    chats = await GemLogStorage.searchChats(searchQuery) || [];
  } else {
    const index = await GemLogStorage.getChatIndex();
    chats = Object.values(index);
  }

  // ソート・フィルタ
  const sortBy   = document.getElementById('sortSelect').value;
  const filterBy = document.getElementById('filterSelect').value;
  chats = applySortFilter(chats, sortBy, filterBy, favorites);

  // カウントバッジ更新
  document.getElementById('chatCountBadge').textContent = chats.length;

  if (chats.length === 0) {
    const isSearch = searchQuery.trim();
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">${isSearch ? '🔍' : '💬'}</div>
        <div class="empty-title">${chrome.i18n.getMessage(isSearch ? 'noSearchResults' : 'noChatsMessage')}</div>
        <div class="empty-sub">${isSearch ? '' : chrome.i18n.getMessage('noChatsSubMessage')}</div>
      </div>`;
    return;
  }

  container.innerHTML = chats.map((chat, i) => {
    const isFav    = favorites.includes(chat.id);
    const tagsHtml = (chat.tags || []).map(t =>
      `<span class="tag" data-tag="${escapeHtml(t)}">#${escapeHtml(t)}</span>`
    ).join('');

    return `
      <div class="chat-item${isFav ? ' favorited' : ''}" data-chatid="${escapeHtml(chat.id)}" style="animation-delay:${i * 35}ms">
        <div class="chat-item-header">
          <button class="favorite-btn${isFav ? ' active' : ''}" data-chatid="${escapeHtml(chat.id)}" title="Favorite">
            ${isFav ? '★' : '☆'}
          </button>
          <div class="chat-title">${escapeHtml(chat.title || chrome.i18n.getMessage('untitledChat'))}</div>
        </div>
        <div class="chat-meta">
          <span>${chat.messageCount || 0} ${chrome.i18n.getMessage('itemCount')}</span>
          <span>·</span>
          <span>${formatDate(chat.updated || chat.created)}</span>
        </div>
        ${tagsHtml ? `<div class="chat-tags">${tagsHtml}</div>` : ''}
        <div class="chat-actions">
          <button class="btn xs copy-md-btn"   data-chatid="${escapeHtml(chat.id)}">📋 MD</button>
          <button class="btn xs copy-json-btn" data-chatid="${escapeHtml(chat.id)}">📋 JSON</button>
          <button class="btn xs export-btn"    data-chatid="${escapeHtml(chat.id)}">⬇</button>
        </div>
      </div>`;
  }).join('');

  // イベント: カードクリック → 詳細
  container.querySelectorAll('.chat-item').forEach(item => {
    item.addEventListener('click', e => {
      if (e.target.closest('.chat-actions, .favorite-btn, .tag')) return;
      openChatDetail(item.dataset.chatid, setCurrentChatId);
    });
  });

  // イベント: お気に入りトグル
  container.querySelectorAll('.favorite-btn').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const added = await GemLogStorage.toggleFavorite(btn.dataset.chatid);
      showToast(chrome.i18n.getMessage(added ? 'toastFavoriteAdded' : 'toastFavoriteRemoved'));
      renderChatList(document.getElementById('searchInput').value);
    });
  });

  // イベント: タグクリック → タグ検索
  container.querySelectorAll('.tag').forEach(tag => {
    tag.addEventListener('click', e => {
      e.stopPropagation();
      const input = document.getElementById('searchInput');
      input.value = tag.dataset.tag;
      document.getElementById('searchBar').classList.add('visible');
      renderChatList(tag.dataset.tag);
    });
  });

  // イベント: コピー・エクスポート
  container.querySelectorAll('.copy-md-btn').forEach(btn => {
    btn.addEventListener('click', e => { e.stopPropagation(); copyChat(btn.dataset.chatid, 'markdown'); });
  });
  container.querySelectorAll('.copy-json-btn').forEach(btn => {
    btn.addEventListener('click', e => { e.stopPropagation(); copyChat(btn.dataset.chatid, 'json'); });
  });
  container.querySelectorAll('.export-btn').forEach(btn => {
    btn.addEventListener('click', e => { e.stopPropagation(); exportChat(btn.dataset.chatid); });
  });
}

function applySortFilter(chats, sortBy, filterBy, favorites) {
  let list = filterBy === 'favorites'
    ? chats.filter(c => favorites.includes(c.id))
    : chats;

  switch (sortBy) {
    case 'oldest':
      return list.sort((a, b) => new Date(a.created) - new Date(b.created));
    case 'messages':
      return list.sort((a, b) => (b.messageCount || 0) - (a.messageCount || 0));
    case 'favorites':
      return list.sort((a, b) => {
        const af = favorites.includes(a.id) ? 1 : 0;
        const bf = favorites.includes(b.id) ? 1 : 0;
        return (bf - af) || new Date(b.updated || b.created) - new Date(a.updated || a.created);
      });
    default:
      return list.sort((a, b) => new Date(b.updated || b.created) - new Date(a.updated || a.created));
  }
}

// ===== コピー・エクスポート =====

async function copyChat(chatId, format) {
  const chatData = await GemLogStorage.getChat(chatId);
  if (!chatData) return showToast(chrome.i18n.getMessage('errDataNotFound'));
  const content = format === 'markdown'
    ? GemLogStorage.chatToMarkdown(chatData)
    : GemLogStorage.chatToJSON(chatData);
  try {
    await navigator.clipboard.writeText(content);
    showToast(`${format === 'markdown' ? 'Markdown' : 'JSON'} ${chrome.i18n.getMessage('toastCopied')}`);
  } catch {
    showToast(chrome.i18n.getMessage('toastCopyFailed'));
  }
}

async function exportChat(chatId) {
  const chatData = await GemLogStorage.getChat(chatId);
  if (!chatData) return showToast(chrome.i18n.getMessage('errDataNotFound'));

  const settings  = await GemLogStorage.getSettings();
  const format    = settings.exportFormat || 'markdown';
  const safeName  = sanitizeFilename(chatData.title);
  const timestamp = new Date().toISOString().split('T')[0];

  if (format === 'obsidian') {
    downloadFile(`${safeName}_${timestamp}.md`, GemLogStorage.chatToObsidian(chatData), 'text/markdown');
  } else if (format === 'json') {
    downloadFile(`${safeName}_${timestamp}.json`, GemLogStorage.chatToJSON(chatData), 'application/json');
  } else {
    downloadFile(`${safeName}_${timestamp}.md`, GemLogStorage.chatToMarkdown(chatData), 'text/markdown');
  }
  showToast(`${format} ${chrome.i18n.getMessage('toastExported')}`);
}

// ===== 設定 =====

async function loadSettings() {
  const settings = await GemLogStorage.getSettings();
  document.getElementById('loggingMode').value  = settings.loggingMode;
  document.getElementById('apiProvider').value  = settings.apiProvider;
  document.getElementById('apiKey').value       = settings.apiKey || '';
  document.getElementById('apiModel').value     = settings.apiModel || '';
  document.getElementById('apiEndpoint').value  = settings.apiEndpoint || '';
  document.getElementById('exportFormat').value = settings.exportFormat || 'markdown';
  toggleApiFields(settings.apiProvider);
  validateEndpointUrl();
  renderManagedList(updateCurrentChatAction);
}

async function saveSettings() {
  const endpoint = document.getElementById('apiEndpoint').value.trim();
  const provider = document.getElementById('apiProvider').value;

  // カスタムエンドポイントのURLを検証
  if (provider === 'custom' && endpoint && !isValidHttpsUrl(endpoint)) {
    showToast(chrome.i18n.getMessage('errEndpointNotHttps'));
    return;
  }

  const settings = {
    loggingMode:  document.getElementById('loggingMode').value,
    apiProvider:  provider,
    apiKey:       document.getElementById('apiKey').value,
    apiModel:     document.getElementById('apiModel').value,
    apiEndpoint:  endpoint,
    exportFormat: document.getElementById('exportFormat').value
  };
  await GemLogStorage.saveSettings(settings);
  showToast(chrome.i18n.getMessage('toastSettingsSaved'));
  renderManagedList(updateCurrentChatAction);
}

// ===== コンテンツスクリプト連携 =====

async function checkContentScriptStatus() {
  const dot = document.getElementById('statusDot');
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url?.includes('gemini.google.com')) {
      dot.classList.remove('active');
      return;
    }
    chrome.tabs.sendMessage(tab.id, { action: 'getStatus' }, response => {
      if (chrome.runtime.lastError || !response) {
        dot.classList.remove('active');
      } else {
        dot.classList.add('active');
        dot.title = `Active · ${response.processedTurns} turns`;
      }
    });
  } catch {
    dot.classList.remove('active');
  }
}

async function updateCurrentChatAction() {
  const bar = document.getElementById('currentChatBar');
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url?.includes('gemini.google.com')) {
    bar.classList.remove('visible');
    return;
  }

  chrome.tabs.sendMessage(tab.id, { action: 'getStatus' }, async response => {
    if (chrome.runtime.lastError || !response?.chatId) return;
    const chatId   = response.chatId;
    const settings = await GemLogStorage.getSettings();
    const badge    = document.getElementById('loggingBadge');
    const btn      = document.getElementById('toggleLoggingBtn');
    const scrollBtn = document.getElementById('autoScrollBtn');

    bar.classList.add('visible');

    const isIncluded = (settings.whitelist || []).includes(chatId);
    const isExcluded = (settings.blacklist || []).includes(chatId);
    let isLogging = false;

    if (settings.loggingMode === 'whitelist') {
      isLogging = isIncluded;
      btn.style.display  = 'block';
      btn.textContent    = isIncluded ? chrome.i18n.getMessage('btnStopLogging') : chrome.i18n.getMessage('btnStartLogging');
      btn.className      = isIncluded ? 'btn sm danger' : 'btn sm primary';
      badge.textContent  = isIncluded ? chrome.i18n.getMessage('badgeRecording') : chrome.i18n.getMessage('badgeUnrecorded');
      badge.className    = `logging-badge ${isIncluded ? 'recording' : 'stopped'}`;
    } else if (settings.loggingMode === 'blacklist') {
      isLogging = !isExcluded;
      btn.style.display  = 'block';
      btn.textContent    = isExcluded ? chrome.i18n.getMessage('btnResumeLogging') : chrome.i18n.getMessage('btnExcludeChat');
      btn.className      = isExcluded ? 'btn sm primary' : 'btn sm danger';
      badge.textContent  = isExcluded ? chrome.i18n.getMessage('badgeExcluded') : chrome.i18n.getMessage('badgeRecording');
      badge.className    = `logging-badge ${isExcluded ? 'stopped' : 'recording'}`;
    } else {
      isLogging = true;
      btn.style.display  = 'none';
      badge.textContent  = chrome.i18n.getMessage('badgeRecording');
      badge.className    = 'logging-badge recording';
    }

    btn.onclick = async () => {
      const listType = settings.loggingMode === 'whitelist' ? 'whitelist' : 'blacklist';
      await GemLogStorage.toggleChatInList(listType, chatId);
      showToast(chrome.i18n.getMessage('toastSettingsUpdated'));
      if (settings.loggingMode === 'whitelist' && !isIncluded) {
        chrome.tabs.sendMessage(tab.id, { action: 'forceScan' });
      }
      updateCurrentChatAction();
      renderChatList(document.getElementById('searchInput').value);
    };

    scrollBtn.style.display = isLogging ? 'block' : 'none';
    scrollBtn.onclick = () => {
      chrome.tabs.sendMessage(tab.id, { action: 'autoScroll' });
      window.close();
    };
  });
}

// ===== 検索（デバウンス付き） =====

let searchTimer = null;
function onSearchInput(query) {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => renderChatList(query), 200);
}

// ===== イベントリスナー登録 =====

// 検索トグル
document.getElementById('searchToggleBtn').addEventListener('click', () => {
  const bar = document.getElementById('searchBar');
  const btn = document.getElementById('searchToggleBtn');
  const visible = bar.classList.toggle('visible');
  btn.classList.toggle('active', visible);
  if (visible) {
    document.getElementById('searchInput').focus();
  } else {
    document.getElementById('searchInput').value = '';
    renderChatList();
  }
});

document.getElementById('searchInput').addEventListener('input', e => onSearchInput(e.target.value));

// ソート・フィルタ変更
document.getElementById('sortSelect').addEventListener('change',   () => renderChatList(document.getElementById('searchInput').value));
document.getElementById('filterSelect').addEventListener('change', () => renderChatList(document.getElementById('searchInput').value));

// タブ
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => switchTab(tab.dataset.tab));
});

// リフレッシュ
document.getElementById('refreshBtn').addEventListener('click', async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url?.includes('gemini.google.com')) {
      chrome.tabs.sendMessage(tab.id, { action: 'forceScan' });
      showToast(chrome.i18n.getMessage('toastRescanned'));
    }
  } catch { /* Gemini以外のタブ */ }
  await renderChatList(document.getElementById('searchInput').value);
  await updateStorageUsage();
  await checkContentScriptStatus();
  updateCurrentChatAction();
});

// 詳細パネル
document.getElementById('backBtn').addEventListener('click', () => {
  switchTab('chats');
  renderChatList(document.getElementById('searchInput').value);
});

document.getElementById('detailFavoriteBtn').addEventListener('click', async () => {
  if (!currentChatId) return;
  const added = await GemLogStorage.toggleFavorite(currentChatId);
  const btn   = document.getElementById('detailFavoriteBtn');
  btn.textContent = added ? '★' : '☆';
  btn.classList.toggle('active', added);
  showToast(chrome.i18n.getMessage(added ? 'toastFavoriteAdded' : 'toastFavoriteRemoved'));
});

document.getElementById('copyMdBtnDetail').addEventListener('click',   () => { if (currentChatId) copyChat(currentChatId, 'markdown'); });
document.getElementById('copyJsonBtnDetail').addEventListener('click', () => { if (currentChatId) copyChat(currentChatId, 'json'); });
document.getElementById('summarizeBtn').addEventListener('click',      () => summarizeCurrentChat(currentChatId, () => switchTab('settings')));
document.getElementById('copySummaryBtn').addEventListener('click',    copySummary);

document.getElementById('deleteChatBtn').addEventListener('click', async () => {
  if (!currentChatId) return;
  if (!confirm(chrome.i18n.getMessage('confirmDeleteChat'))) return;
  await GemLogStorage.deleteChat(currentChatId);
  showToast(chrome.i18n.getMessage('toastChatDeleted'));
  switchTab('chats');
  renderChatList();
  updateStorageUsage();
});

// 設定
document.getElementById('loggingMode').addEventListener('change', () => renderManagedList(updateCurrentChatAction));
document.getElementById('apiProvider').addEventListener('change', e => toggleApiFields(e.target.value));
document.getElementById('apiEndpoint').addEventListener('input',  validateEndpointUrl);
document.getElementById('saveSettingsBtn').addEventListener('click', saveSettings);

// APIキー表示トグル
document.getElementById('apiKeyToggle').addEventListener('click', () => {
  const input = document.getElementById('apiKey');
  const btn   = document.getElementById('apiKeyToggle');
  if (input.type === 'password') {
    input.type   = 'text';
    btn.textContent = '🙈';
  } else {
    input.type   = 'password';
    btn.textContent = '👁';
  }
});

// 全削除
document.getElementById('deleteAllBtn').addEventListener('click', async () => {
  if (!confirm(chrome.i18n.getMessage('confirmDeleteAll'))) return;
  if (!confirm(chrome.i18n.getMessage('confirmDeleteAllReally'))) return;
  await GemLogStorage.deleteAllChats();
  showToast(chrome.i18n.getMessage('toastAllDeleted'));
  renderChatList();
  updateStorageUsage();
});

// ===== 初期化 =====

async function init() {
  applyTranslations();
  await renderChatList();
  await updateStorageUsage();
  await loadSettings();
  await checkContentScriptStatus();
  updateCurrentChatAction();
}

init();
