/**
 * GemLog Next — Background Service Worker
 * API要約リクエストの処理を担当。カスタムエンドポイントのURL検証を追加。
 */

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    chrome.storage.local.set({
      gemlog_settings: {
        loggingMode: 'all',
        whitelist: [],
        blacklist: [],
        favorites: [],
        apiProvider: 'none',
        apiKey: '',
        apiModel: '',
        apiEndpoint: '',
        exportFormat: 'markdown'
      }
    });
  }
});

/**
 * カスタムエンドポイントURLがhttpsか検証する
 * @param {string} url
 * @returns {boolean}
 */
function isValidHttpsUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * AIによるチャット要約を生成する
 * @param {{ messages: Array<{role: string, content: string}> }} chatData
 * @param {{ apiProvider: string, apiKey: string, apiModel: string, apiEndpoint: string }} settings
 * @returns {Promise<string>}
 */
async function summarizeChat(chatData, settings) {
  const messages = chatData.messages
    .map(m => `${m.role === 'user' ? 'User' : 'Gemini'}: ${m.content}`)
    .join('\n\n');

  const prompt = `以下はGeminiとのチャット履歴です。内容を簡潔に要約してください。
要約に含めること：
- メインテーマ
- 重要なポイント（3〜5つ）
- 決定事項やアクション（あれば）
- コード・ツールに関する情報（あれば）

チャット履歴:
${messages}`;

  let apiUrl, headers, body;

  switch (settings.apiProvider) {
    case 'google':
      apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${settings.apiModel || 'gemini-2.0-flash'}:generateContent?key=${settings.apiKey}`;
      headers = { 'Content-Type': 'application/json' };
      body = JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] });
      break;

    case 'openai':
      apiUrl = 'https://api.openai.com/v1/chat/completions';
      headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${settings.apiKey}`
      };
      body = JSON.stringify({
        model: settings.apiModel || 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 2000
      });
      break;

    case 'anthropic':
      apiUrl = 'https://api.anthropic.com/v1/messages';
      headers = {
        'Content-Type': 'application/json',
        'x-api-key': settings.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      };
      body = JSON.stringify({
        model: settings.apiModel || 'claude-sonnet-4-6',
        max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }]
      });
      break;

    case 'custom':
      if (!isValidHttpsUrl(settings.apiEndpoint)) {
        throw new Error(chrome.i18n.getMessage('errEndpointNotHttps'));
      }
      apiUrl = settings.apiEndpoint;
      headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${settings.apiKey}`
      };
      body = JSON.stringify({
        model: settings.apiModel,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 2000
      });
      break;

    default:
      throw new Error('API provider not configured');
  }

  const response = await fetch(apiUrl, { method: 'POST', headers, body });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`API Error ${response.status}: ${errorText}`);
  }

  const data = await response.json();

  switch (settings.apiProvider) {
    case 'google':
      return data.candidates?.[0]?.content?.parts?.[0]?.text || 'No response';
    case 'openai':
    case 'custom':
      return data.choices?.[0]?.message?.content || 'No response';
    case 'anthropic':
      return data.content?.[0]?.text || 'No response';
    default:
      return 'Unknown provider';
  }
}

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request.action === 'summarize') {
    summarizeChat(request.chatData, request.settings)
      .then(summary => sendResponse({ success: true, summary }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }
});
