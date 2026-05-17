/**
 * GemLog Next — Background Service Worker
 *
 * 役割:
 *   1. content scriptにtab IDを返す
 *   2. ポート切断 → セッションを自動削除（ページ離脱・tab close検出）
 *   3. tab close → セッションを削除（onRemoved）
 *   4. AI要約リクエストの処理
 */

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

// ===== ポート管理: 切断時にセッションを削除 =====
// content.js が接続し、ページ離脱またはtabクローズ時に自動切断される
chrome.runtime.onConnect.addListener(port => {
  const match = port.name.match(/^gemlog-session-(\d+)$/);
  if (!match) return;

  const tabId = parseInt(match[1], 10);

  port.onDisconnect.addListener(() => {
    // ページ離脱 or tab close → セッションデータを削除
    chrome.storage.session.remove(`gemlog_session_${tabId}`);
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

  // content script から tab ID を要求
  if (request.action === 'getTabId') {
    sendResponse({ tabId: sender.tab?.id ?? null });
    return false;
  }

  // AI要約リクエスト
  if (request.action === 'summarize') {
    handleSummarize(request.sessionData, request.settings)
      .then(summary => sendResponse({ success: true, summary }))
      .catch(err   => sendResponse({ success: false, error: err.message }));
    return true; // 非同期
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
  if (!res.ok) throw new Error(`API Error ${res.status}: ${await res.text()}`);

  const data = await res.json();
  switch (settings.apiProvider) {
    case 'google':    return data.candidates?.[0]?.content?.parts?.[0]?.text || 'No response';
    case 'openai':
    case 'custom':    return data.choices?.[0]?.message?.content || 'No response';
    case 'anthropic': return data.content?.[0]?.text || 'No response';
    default:          return 'Unknown provider';
  }
}
