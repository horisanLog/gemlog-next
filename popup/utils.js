/**
 * 共通ユーティリティ
 */

export function applyTranslations() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const msg = chrome.i18n.getMessage(el.getAttribute('data-i18n'));
    if (!msg) return;
    if (el.tagName === 'INPUT' && el.hasAttribute('placeholder')) {
      el.placeholder = msg;
    } else {
      el.textContent = msg;
    }
  });
  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    const msg = chrome.i18n.getMessage(el.getAttribute('data-i18n-title'));
    if (msg) el.title = msg;
  });
}

let toastTimer = null;
export function showToast(message, duration = 2200) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), duration);
}

export function downloadFile(filename, content, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function formatDate(isoString) {
  if (!isoString) return '';
  const d      = new Date(isoString);
  const locale = chrome.i18n.getUILanguage() || 'ja-JP';
  return d.toLocaleDateString(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function escapeHtml(text) {
  const div      = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/** https://から始まる有効なURLかを検証する */
export function isValidHttpsUrl(value) {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

/** ファイル名に使えない文字を除去する */
export function sanitizeFilename(name, maxLen = 50) {
  return (name || 'chat').replace(/[/\\:*?"<>|]/g, '_').substring(0, maxLen);
}
