/**
 * UI Manager — DOM操作・タブ切替・チャット詳細・設定画面の描画を担当
 */
import { escapeHtml, formatDate, showToast, isValidHttpsUrl } from './utils.js';
import { copySummary, summarizeCurrentChat } from './api-manager.js';

// ===== タブ切替 =====

export function switchTab(tabName) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.panel').forEach(p => {
    p.classList.remove('active');
    p.style.display = 'none';
  });

  const tab = document.querySelector(`.tab[data-tab="${tabName}"]`);
  const panelId = 'panel' + tabName.charAt(0).toUpperCase() + tabName.slice(1);
  const panel   = document.getElementById(panelId);

  if (tab)   tab.classList.add('active');
  if (panel) {
    panel.style.display = '';
    panel.classList.add('active');
  }

  const detailTab = document.getElementById('detailTab');
  detailTab.style.display = tabName === 'detail' ? '' : 'none';
}

// ===== ストレージ使用量 =====

export async function updateStorageUsage() {
  const usage   = await GemLogStorage.getStorageUsage();
  const percent = Math.min((usage.usedBytes / (100 * 1024 * 1024)) * 100, 100);
  document.getElementById('storageUsage').textContent = `${usage.usedMB} MB / 100 MB`;
  document.getElementById('storageBar').style.width   = `${percent.toFixed(1)}%`;
}

// ===== API設定フィールド表示切替 =====

export function toggleApiFields(provider) {
  const apiFields     = document.getElementById('apiFields');
  const endpointGroup = document.getElementById('endpointGroup');
  apiFields.style.display     = provider === 'none' ? 'none' : 'flex';
  endpointGroup.style.display = provider === 'custom' ? 'block' : 'none';
}

// ===== チャット詳細表示 =====

export async function openChatDetail(chatId, setCurrentChatId) {
  setCurrentChatId(chatId);
  const chatData = await GemLogStorage.getChat(chatId);
  if (!chatData) {
    showToast(chrome.i18n.getMessage('errChatNotFound'));
    return;
  }

  document.getElementById('detailTitle').textContent = chatData.title || chrome.i18n.getMessage('untitledChat');
  document.getElementById('summaryCard').classList.remove('visible');

  // お気に入りボタン更新
  const favBtn = document.getElementById('detailFavoriteBtn');
  const isFav  = await GemLogStorage.isFavorite(chatId);
  favBtn.textContent = isFav ? '★' : '☆';
  favBtn.classList.toggle('active', isFav);

  // メッセージリスト描画
  const preview = document.getElementById('messagePreview');
  preview.innerHTML = chatData.messages.map(msg => {
    const roleClass = msg.role === 'model' ? 'model' : '';
    const roleLabel = msg.role === 'user' ? '👤 USER' : '✨ GEMINI';
    const truncated = msg.content.length > 200
      ? msg.content.substring(0, 200) + '…'
      : msg.content;

    const codeInfo = msg.codeBlocks?.length
      ? `<div class="msg-code-badge">📝 ${chrome.i18n.getMessage('codeBlock')} ×${msg.codeBlocks.length}</div>`
      : '';

    return `
      <div class="msg">
        <div class="msg-role ${roleClass}">${roleLabel}</div>
        <div class="msg-content">${escapeHtml(truncated)}</div>
        ${codeInfo}
      </div>`;
  }).join('');

  switchTab('detail');
}

// ===== ホワイト/ブラックリスト描画 =====

export async function renderManagedList(onUpdate) {
  const mode  = document.getElementById('loggingMode').value;
  const area  = document.getElementById('listManagementArea');
  const label = document.getElementById('listManagementLabel');
  const list  = document.getElementById('managedList');

  if (mode === 'all') {
    area.style.display = 'none';
    return;
  }

  area.style.display = 'block';
  label.textContent  = mode === 'whitelist'
    ? chrome.i18n.getMessage('listLabelWhitelist')
    : chrome.i18n.getMessage('listLabelBlacklist');

  const settings   = await GemLogStorage.getSettings();
  const targetIds  = settings[mode] || [];

  if (targetIds.length === 0) {
    list.innerHTML = `<div class="managed-list-empty">${chrome.i18n.getMessage('msgListEmpty')}</div>`;
    return;
  }

  const index = await GemLogStorage.getChatIndex();
  list.innerHTML = targetIds.map(id => {
    const title = index[id]?.title || `ID: ${id.substring(0, 10)}…`;
    return `
      <div class="managed-list-item">
        <span class="managed-list-title">${escapeHtml(title)}</span>
        <button class="btn xs danger remove-list-btn" data-id="${escapeHtml(id)}">
          ${chrome.i18n.getMessage('btnRemove')}
        </button>
      </div>`;
  }).join('');

  list.querySelectorAll('.remove-list-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      await GemLogStorage.toggleChatInList(mode, btn.dataset.id);
      showToast(chrome.i18n.getMessage('toastRemovedFromList'));
      renderManagedList(onUpdate);
      onUpdate?.();
    });
  });
}

// ===== エンドポイントURLバリデーションUI =====

export function validateEndpointUrl() {
  const input  = document.getElementById('apiEndpoint');
  const status = document.getElementById('urlStatus');
  const error  = document.getElementById('endpointError');
  const value  = input.value.trim();

  if (!value) {
    status.textContent = '';
    status.className   = 'url-status';
    error.classList.remove('visible');
    input.classList.remove('error');
    return true;
  }

  if (isValidHttpsUrl(value)) {
    status.textContent = '✓ Valid HTTPS URL';
    status.className   = 'url-status valid';
    error.classList.remove('visible');
    input.classList.remove('error');
    return true;
  } else {
    status.textContent = '✗ Invalid';
    status.className   = 'url-status invalid';
    error.classList.add('visible');
    input.classList.add('error');
    return false;
  }
}
