/**
 * GemLog Next — Storage Manager
 *
 * GemLogSettings : API設定など永続データ（chrome.storage.local）
 * GemLogSession  : チャット履歴（chrome.storage.session — ブラウザ終了で自動消去）
 */

// ===== 設定（永続) =====
class GemLogSettings {
  static KEY = 'gemlog_settings';

  static DEFAULT = {
    apiProvider:  'none',
    apiKey:       '',
    apiModel:     '',
    apiEndpoint:  '',
    exportFormat: 'markdown'
  };

  static async get() {
    const r = await chrome.storage.local.get(this.KEY);
    return { ...this.DEFAULT, ...(r[this.KEY] || {}) };
  }

  static async save(settings) {
    await chrome.storage.local.set({ [this.KEY]: { ...this.DEFAULT, ...settings } });
  }
}

// ===== セッション（ephemeral) =====
class GemLogSession {
  static PREFIX = 'gemlog_session_';

  static keyFor(tabId) { return this.PREFIX + tabId; }

  /** メッセージをセッションに追記する */
  static async saveMessage(tabId, chatId, chatTitle, message) {
    const key    = this.keyFor(tabId);
    const stored = await chrome.storage.session.get(key);
    const data   = stored[key] || {
      tabId,
      chatId,
      title:     chatTitle,
      messages:  [],
      startedAt: new Date().toISOString()
    };

    // タイトルを改善
    const generic = ['Google Gemini', 'Gemini', 'Untitled', ''];
    if (chatTitle && !generic.includes(chatTitle) &&
        (!data.title || generic.includes(data.title) || data.title.startsWith('Chat '))) {
      data.title = chatTitle;
    }

    // 重複スキップ
    const dup = data.messages.some(m => m.turnId === message.turnId && m.role === message.role);
    if (dup) return false;

    data.messages.push(message);
    data.updatedAt    = new Date().toISOString();
    data.messageCount = data.messages.length;

    await chrome.storage.session.set({ [key]: data });
    return true;
  }

  /** タブのセッションデータを取得 */
  static async get(tabId) {
    const r = await chrome.storage.session.get(this.keyFor(tabId));
    return r[this.keyFor(tabId)] || null;
  }

  /** タブのセッションを削除 */
  static async clear(tabId) {
    await chrome.storage.session.remove(this.keyFor(tabId));
  }

  /** 全セッションを取得 */
  static async getAll() {
    const all = await chrome.storage.session.get(null);
    return Object.entries(all)
      .filter(([k]) => k.startsWith(this.PREFIX))
      .map(([, v]) => v);
  }

  /** DOMの表示順にメッセージを並び替える */
  static async syncDOMOrder(tabId, turnIdsArray) {
    const data = await this.get(tabId);
    if (!data?.messages) return;

    data.messages.sort((a, b) => {
      const ia = turnIdsArray.indexOf(a.turnId);
      const ib = turnIdsArray.indexOf(b.turnId);
      if (ia !== -1 && ib !== -1) {
        if (ia === ib) {
          if (a.role === 'user' && b.role !== 'user') return -1;
          if (a.role !== 'user' && b.role === 'user') return  1;
          return 0;
        }
        return ia - ib;
      }
      return 0;
    });

    await chrome.storage.session.set({ [this.keyFor(tabId)]: data });
  }

  /** セッションの「ログ判定」(現在は常にtrue — 必要なら設定で制御) */
  static shouldLog() { return true; }

  // ===== エクスポート形式 =====

  static chatToMarkdown(data) {
    let md = `# ${data.title || 'Untitled Chat'}\n\n`;
    md += `- **Started**: ${data.startedAt}\n- **Messages**: ${data.messageCount}\n\n---\n\n`;
    for (const msg of data.messages) {
      md += `## ${msg.role === 'user' ? '👤 User' : '✨ Gemini'}\n\n${msg.content}\n\n`;
      if (msg.codeBlocks?.length) {
        for (const c of msg.codeBlocks) md += `\`\`\`${c.language || ''}\n${c.content}\n\`\`\`\n\n`;
      }
      if (msg.images?.length) {
        for (const img of msg.images) md += `![image](${img})\n\n`;
      }
      md += '---\n\n';
    }
    return md;
  }

  static chatToObsidian(data) {
    let md = `---\ntitle: "${(data.title || 'Untitled').replace(/"/g, '\\"')}"\nstarted: ${data.startedAt}\ntags: [gemini, chat]\n---\n\n`;
    md += `# ${data.title || 'Untitled Chat'}\n\n`;
    for (const msg of data.messages) {
      const body = msg.content.replace(/\n/g, '\n> ');
      md += msg.role === 'user'
        ? `> [!question] User\n> ${body}\n\n`
        : `> [!note] Gemini\n> ${body}\n\n`;
      if (msg.codeBlocks?.length) {
        for (const c of msg.codeBlocks) md += `\`\`\`${c.language || ''}\n${c.content}\n\`\`\`\n\n`;
      }
    }
    return md;
  }

  static chatToJSON(data) {
    return JSON.stringify(data, null, 2);
  }
}

// content script と popup の両方で使えるようにグローバルに公開
if (typeof window !== 'undefined') {
  window.GemLogSettings = GemLogSettings;
  window.GemLogSession  = GemLogSession;
}
