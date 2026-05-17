/**
 * GemLog Next — Storage Manager
 * チャットログの保存・取得・削除、検索、タグ、お気に入りを管理する。
 */
class GemLogStorage {
  static SETTINGS_KEY   = 'gemlog_settings';
  static CHAT_INDEX_KEY = 'gemlog_chat_index';
  static CHAT_PREFIX    = 'gemlog_chat_';

  static DEFAULT_SETTINGS = {
    loggingMode:  'all',
    whitelist:    [],
    blacklist:    [],
    favorites:    [],
    apiProvider:  'none',
    apiKey:       '',
    apiModel:     '',
    apiEndpoint:  '',
    exportFormat: 'markdown'
  };

  // ===== 設定 =====

  static async getSettings() {
    const result = await chrome.storage.local.get(this.SETTINGS_KEY);
    return { ...this.DEFAULT_SETTINGS, ...(result[this.SETTINGS_KEY] || {}) };
  }

  static async saveSettings(settings) {
    await chrome.storage.local.set({
      [this.SETTINGS_KEY]: { ...this.DEFAULT_SETTINGS, ...settings }
    });
  }

  // ===== チャットインデックス =====

  static async getChatIndex() {
    const result = await chrome.storage.local.get(this.CHAT_INDEX_KEY);
    return result[this.CHAT_INDEX_KEY] || {};
  }

  // ===== チャット取得 =====

  static async getChat(chatId) {
    const key = this.CHAT_PREFIX + chatId;
    const result = await chrome.storage.local.get(key);
    return result[key] || null;
  }

  // ===== メッセージ保存 =====

  static async saveMessage(chatId, chatTitle, message) {
    const key = this.CHAT_PREFIX + chatId;
    const existing = await this.getChat(chatId);

    const chatData = existing || {
      id:           chatId,
      title:        chatTitle,
      tags:         [],
      created:      new Date().toISOString(),
      messages:     []
    };

    // より良いタイトルで更新
    const genericTitles = ['Google Gemini', 'Gemini', 'Untitled', ''];
    if (
      chatTitle &&
      !genericTitles.includes(chatTitle) &&
      (!chatData.title || genericTitles.includes(chatData.title) || chatData.title.startsWith('Chat '))
    ) {
      chatData.title = chatTitle;
    }

    // 重複チェック
    const exists = chatData.messages.some(
      m => m.turnId === message.turnId && m.role === message.role
    );
    if (exists) return false;

    chatData.messages.push(message);
    chatData.updated      = new Date().toISOString();
    chatData.messageCount = chatData.messages.length;

    await chrome.storage.local.set({ [key]: chatData });

    // インデックス更新
    const index = await this.getChatIndex();
    index[chatId] = {
      id:           chatId,
      title:        chatData.title,
      tags:         chatData.tags || [],
      created:      chatData.created,
      updated:      chatData.updated,
      messageCount: chatData.messageCount
    };
    await chrome.storage.local.set({ [this.CHAT_INDEX_KEY]: index });

    return true;
  }

  // ===== チャット削除 =====

  static async deleteChat(chatId) {
    await chrome.storage.local.remove(this.CHAT_PREFIX + chatId);
    const index = await this.getChatIndex();
    delete index[chatId];
    await chrome.storage.local.set({ [this.CHAT_INDEX_KEY]: index });

    // お気に入りからも除去
    const settings = await this.getSettings();
    settings.favorites = (settings.favorites || []).filter(id => id !== chatId);
    await this.saveSettings(settings);
  }

  static async deleteAllChats() {
    const index = await this.getChatIndex();
    const keys = Object.keys(index).map(id => this.CHAT_PREFIX + id);
    keys.push(this.CHAT_INDEX_KEY);
    await chrome.storage.local.remove(keys);

    const settings = await this.getSettings();
    settings.favorites = [];
    await this.saveSettings(settings);
  }

  // ===== ログ判定 =====

  static async shouldLog(chatId) {
    const settings = await this.getSettings();
    switch (settings.loggingMode) {
      case 'whitelist': return (settings.whitelist || []).includes(chatId);
      case 'blacklist': return !(settings.blacklist || []).includes(chatId);
      default:          return !(settings.blacklist || []).includes(chatId);
    }
  }

  // ===== お気に入り =====

  static async toggleFavorite(chatId) {
    const settings  = await this.getSettings();
    const favorites = settings.favorites || [];
    const idx       = favorites.indexOf(chatId);
    if (idx === -1) {
      favorites.push(chatId);
    } else {
      favorites.splice(idx, 1);
    }
    await this.saveSettings({ ...settings, favorites });
    return idx === -1; // true=追加, false=解除
  }

  static async isFavorite(chatId) {
    const settings = await this.getSettings();
    return (settings.favorites || []).includes(chatId);
  }

  // ===== タグ =====

  static async addTag(chatId, tag) {
    const key      = this.CHAT_PREFIX + chatId;
    const chatData = await this.getChat(chatId);
    if (!chatData) return;

    if (!chatData.tags) chatData.tags = [];
    const normalized = tag.trim().toLowerCase();
    if (!normalized || chatData.tags.includes(normalized)) return;

    chatData.tags.push(normalized);
    await chrome.storage.local.set({ [key]: chatData });

    const index = await this.getChatIndex();
    if (index[chatId]) {
      index[chatId].tags = chatData.tags;
      await chrome.storage.local.set({ [this.CHAT_INDEX_KEY]: index });
    }
  }

  static async removeTag(chatId, tag) {
    const key      = this.CHAT_PREFIX + chatId;
    const chatData = await this.getChat(chatId);
    if (!chatData?.tags) return;

    chatData.tags = chatData.tags.filter(t => t !== tag);
    await chrome.storage.local.set({ [key]: chatData });

    const index = await this.getChatIndex();
    if (index[chatId]) {
      index[chatId].tags = chatData.tags;
      await chrome.storage.local.set({ [this.CHAT_INDEX_KEY]: index });
    }
  }

  // ===== 検索 =====

  /**
   * タイトルまたはタグでチャットを検索する
   * @param {string} query
   * @returns {Promise<object[]|null>} nullは「全件表示」を意味する
   */
  static async searchChats(query) {
    if (!query?.trim()) return null;
    const q     = query.trim().toLowerCase();
    const index = await this.getChatIndex();
    return Object.values(index).filter(chat =>
      (chat.title || '').toLowerCase().includes(q) ||
      (chat.tags  || []).some(t => t.includes(q))
    );
  }

  // ===== ホワイト/ブラックリスト操作 =====

  static async toggleChatInList(listType, chatId) {
    const settings = await this.getSettings();
    const list     = settings[listType] || [];
    const idx      = list.indexOf(chatId);
    if (idx === -1) {
      list.push(chatId);
    } else {
      list.splice(idx, 1);
    }
    settings[listType] = list;
    await this.saveSettings(settings);
    return idx === -1;
  }

  // ===== メッセージ順序の再構築 =====

  static async clearChatMessages(chatId) {
    const key      = this.CHAT_PREFIX + chatId;
    const chatData = await this.getChat(chatId);
    if (chatData) {
      chatData.messages     = [];
      chatData.messageCount = 0;
      await chrome.storage.local.set({ [key]: chatData });
    }
  }

  static async syncDOMOrder(chatId, turnIdsArray) {
    const key      = this.CHAT_PREFIX + chatId;
    const chatData = await this.getChat(chatId);
    if (!chatData?.messages) return;

    chatData.messages.sort((a, b) => {
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

    await chrome.storage.local.set({ [key]: chatData });
  }

  // ===== ストレージ使用量 =====

  static async getStorageUsage() {
    return new Promise(resolve => {
      chrome.storage.local.getBytesInUse(null, bytes => {
        resolve({ usedBytes: bytes, usedMB: (bytes / (1024 * 1024)).toFixed(2) });
      });
    });
  }

  // ===== エクスポート =====

  static chatToMarkdown(chatData) {
    let md = `# ${chatData.title || 'Untitled Chat'}\n\n`;
    md += `- **Chat ID**: ${chatData.id}\n`;
    md += `- **Created**: ${chatData.created}\n`;
    md += `- **Updated**: ${chatData.updated}\n`;
    md += `- **Messages**: ${chatData.messageCount}\n`;
    if (chatData.tags?.length) md += `- **Tags**: ${chatData.tags.join(', ')}\n`;
    md += '\n---\n\n';

    for (const msg of chatData.messages) {
      const roleLabel = msg.role === 'user' ? '👤 User' : '✨ Gemini';
      md += `## ${roleLabel}\n\n${msg.content}\n\n`;
      if (msg.codeBlocks?.length) {
        for (const code of msg.codeBlocks) {
          md += `\`\`\`${code.language || ''}\n${code.content}\n\`\`\`\n\n`;
        }
      }
      if (msg.images?.length) {
        for (const img of msg.images) md += `![uploaded image](${img})\n\n`;
      }
      md += '---\n\n';
    }
    return md;
  }

  /** Obsidian Callout形式のMarkdown */
  static chatToObsidian(chatData) {
    const date = (chatData.created || new Date().toISOString()).split('T')[0];
    const tags = ['gemini', 'chat', ...(chatData.tags || [])];
    let md = `---\ntitle: "${(chatData.title || 'Untitled').replace(/"/g, '\\"')}"\ncreated: ${chatData.created}\nupdated: ${chatData.updated}\ntags: [${tags.join(', ')}]\n---\n\n`;
    md += `# ${chatData.title || 'Untitled Chat'}\n\n`;

    for (const msg of chatData.messages) {
      if (msg.role === 'user') {
        md += `> [!question] User\n> ${msg.content.replace(/\n/g, '\n> ')}\n\n`;
      } else {
        md += `> [!note] Gemini\n> ${msg.content.replace(/\n/g, '\n> ')}\n\n`;
      }
      if (msg.codeBlocks?.length) {
        for (const code of msg.codeBlocks) {
          md += `\`\`\`${code.language || ''}\n${code.content}\n\`\`\`\n\n`;
        }
      }
    }
    return md;
  }

  static chatToJSON(chatData) {
    return JSON.stringify(chatData, null, 2);
  }
}

if (typeof window !== 'undefined') {
  window.GemLogStorage = GemLogStorage;
}
