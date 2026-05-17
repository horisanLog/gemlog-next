/**
 * API Manager — 要約生成とクリップボードコピーを担当
 */
import { showToast } from './utils.js';

export async function summarizeCurrentChat(currentChatId, switchToSettings) {
  if (!currentChatId) return;

  const settings = await GemLogStorage.getSettings();
  if (settings.apiProvider === 'none' || !settings.apiKey) {
    showToast(chrome.i18n.getMessage('errApiNotConfigured'));
    switchToSettings?.();
    return;
  }

  const chatData = await GemLogStorage.getChat(currentChatId);
  if (!chatData) {
    showToast(chrome.i18n.getMessage('errDataNotFound'));
    return;
  }

  const summaryCard = document.getElementById('summaryCard');
  const summaryText = document.getElementById('summaryText');
  const copyBtn     = document.getElementById('copySummaryBtn');

  summaryCard.classList.add('visible');
  copyBtn.style.display = 'none';
  summaryText.textContent = chrome.i18n.getMessage('msgGeneratingSummary');

  try {
    const response = await chrome.runtime.sendMessage({
      action:   'summarize',
      chatData: chatData,
      settings: settings
    });

    if (response.success) {
      summaryText.textContent = response.summary;
      copyBtn.style.display   = 'inline-flex';
    } else {
      summaryText.textContent = `Error: ${response.error}`;
    }
  } catch (error) {
    summaryText.textContent = `Error: ${error.message}`;
  }
}

export async function copySummary() {
  const text = document.getElementById('summaryText').textContent;
  if (!text || text === chrome.i18n.getMessage('msgGeneratingSummary')) return;
  try {
    await navigator.clipboard.writeText(text);
    showToast(chrome.i18n.getMessage('toastSummaryCopied'));
  } catch {
    showToast(chrome.i18n.getMessage('toastCopyFailed'));
  }
}
