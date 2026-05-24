/**
 * GemLog Next — Background Service Worker
 *
 * 役割:
 *   1. ポート接続でセッションマーカーを作成・管理
 *   2. content script からのメッセージを受け取りストレージへ保存
 *   3. tab close → セッションを削除
 *   4. AI要約リクエストの処理
 */

importScripts('lib/storage-manager.js');

// ===== サイドパネルの開閉 =====
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(() => {});

// ===== インストール時の初期設定 =====
chrome.runtime.onInstalled.addListener(details => {
  if (details.reason === 'install') {
    chrome.storage.local.set({
      gemlog_settings: {
        apiProvider:  'none',
        apiKey:       '',
        apiModel:     '',
        apiEndpoint:  '',
        exportFormat: 'markdown'
      }
    });
  }
});

// ===== ポート管理: content.js の接続を受け取りセッションを管理 =====
chrome.runtime.onConnect.addListener(port => {
  const tabId = port.sender?.tab?.id;
  if (!tabId) return;

  // ポート名に関わらず tabId で管理する
  const key = `gemlog_session_${tabId}`;

  // セッションマーカーを作成（まだなければ）
  chrome.storage.session.get(key).then(existing => {
    if (!existing[key]) {
      const rawTitle = (port.sender.tab.title || '')
        .replace(/\s*[-–]\s*(Gemini|Google).*$/i, '')
        .trim();
      chrome.storage.session.set({
        [key]: {
          tabId,
          chatId:       'unknown',
          title:        rawTitle || 'Gemini',
          messages:     [],
          messageCount: 0,
          startedAt:    new Date().toISOString()
        }
      });
    }
  });

  port.onDisconnect.addListener(() => {
    chrome.storage.session.remove(key);
  });
});

// ===== Tab Close: セッションを削除 =====
// onConnect の disconnect で処理されるが、念のため二重に保護する
chrome.tabs.onRemoved.addListener(tabId => {
  chrome.storage.session.remove(`gemlog_session_${tabId}`);
});

// ===== URL検証ヘルパー =====
function isValidHttpsUrl(url) {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

// ===== メッセージハンドラ =====
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {

  const tabId = sender.tab?.id;

  // content script からのメッセージ保存
  if (request.action === 'sessionSaveMessage') {
    if (!tabId) { sendResponse({ success: false }); return false; }
    GemLogSession.saveMessage(tabId, request.chatId, request.chatTitle, request.message)
      .then(saved => sendResponse({ success: saved }))
      .catch(() => sendResponse({ success: false }));
    return true;
  }

  // content script からのセッション削除
  if (request.action === 'clearSession') {
    if (!tabId) { sendResponse({ success: false }); return false; }
    GemLogSession.clear(tabId)
      .then(() => sendResponse({ success: true }))
      .catch(() => sendResponse({ success: false }));
    return true;
  }

  // content script からの並び替え
  if (request.action === 'sessionSyncOrder') {
    if (!tabId) { sendResponse({ success: false }); return false; }
    GemLogSession.syncDOMOrder(tabId, request.turnIds)
      .then(() => sendResponse({ success: true }))
      .catch(() => sendResponse({ success: false }));
    return true;
  }

  // autoScroll 完了通知 → session ストレージにシグナルを立てる
  if (request.action === 'autoScrollComplete') {
    if (tabId) {
      chrome.storage.session.set({ [`gemlog_scrolldone_${tabId}`]: Date.now() });
    }
    sendResponse({ success: true });
    return false;
  }

  // AI要約リクエスト（APIキーはストレージから取得し、リクエストには含めない）
  if (request.action === 'summarize') {
    GemLogSettings.get()
      .then(settings => handleSummarize(request.sessionData, settings))
      .then(summary  => sendResponse({ success: true, summary }))
      .catch(err     => sendResponse({ success: false, error: err.message }));
    return true;
  }
});

// ===== AI要約処理 =====
async function handleSummarize(sessionData, settings) {
  const messages = (sessionData.messages || [])
    .map(m => `${m.role === 'user' ? 'User' : 'Gemini'}: ${m.content}`)
    .join('\n\n');

  const prompt = `以下はGeminiとのチャット履歴です。内容を簡潔に要約してください。
含める内容: メインテーマ・重要ポイント(3〜5つ)・決定事項・コード関連情報

チャット履歴:
${messages}`;

  let apiUrl, headers, body;

  switch (settings.apiProvider) {
    case 'google':
      apiUrl   = `https://generativelanguage.googleapis.com/v1beta/models/${settings.apiModel || 'gemini-2.0-flash'}:generateContent?key=${settings.apiKey}`;
      headers  = { 'Content-Type': 'application/json' };
      body     = JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] });
      break;

    case 'openai':
      apiUrl   = 'https://api.openai.com/v1/chat/completions';
      headers  = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${settings.apiKey}` };
      body     = JSON.stringify({ model: settings.apiModel || 'gpt-4o-mini', messages: [{ role: 'user', content: prompt }], max_tokens: 2000 });
      break;

    case 'anthropic':
      apiUrl   = 'https://api.anthropic.com/v1/messages';
      headers  = { 'Content-Type': 'application/json', 'x-api-key': settings.apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' };
      body     = JSON.stringify({ model: settings.apiModel || 'claude-sonnet-4-6', max_tokens: 2000, messages: [{ role: 'user', content: prompt }] });
      break;

    case 'custom':
      if (!isValidHttpsUrl(settings.apiEndpoint)) {
        throw new Error(chrome.i18n.getMessage('errEndpointNotHttps'));
      }
      apiUrl   = settings.apiEndpoint;
      headers  = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${settings.apiKey}` };
      body     = JSON.stringify({ model: settings.apiModel, messages: [{ role: 'user', content: prompt }], max_tokens: 2000 });
      break;

    default:
      throw new Error('API provider not configured');
  }

  const res = await fetch(apiUrl, { method: 'POST', headers, body });
  if (!res.ok) throw new Error(`API Error ${res.status}`);

  const data = await res.json();
  switch (settings.apiProvider) {
    case 'google':    return data.candidates?.[0]?.content?.parts?.[0]?.text || 'No response';
    case 'openai':
    case 'custom':    return data.choices?.[0]?.message?.content || 'No response';
    case 'anthropic': return data.content?.[0]?.text || 'No response';
    default:          return 'Unknown provider';
  }
}
