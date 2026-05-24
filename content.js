/**
 * GemLog Next — Content Script
 *
 * 設計方針:
 *   - DOM 監視と文字列抽出のみを担当
 *   - ストレージへの書き込みは background へのメッセージで委譲
 *   - tabId の非同期取得が不要になり、v1 と同じタイミングで観察開始できる
 */
(function () {
  'use strict';

  if (window.__gemlog_next_initialized) return;
  window.__gemlog_next_initialized = true;

  let currentChatId = null;
  let observer      = null;
  let busyObserver  = null;
  let scrollStopped = false;
  const processedTurns = new Set();

  // ===== Background への送信ヘルパー =====

  function sendToBg(message) {
    try {
      chrome.runtime.sendMessage(message).catch(() => {});
    } catch {}
  }

  // ===== URL・Chat ID =====

  function getChatIdFromURL() {
    const match = location.pathname.match(/\/app\/([a-f0-9]+)/);
    return match ? match[1] : location.pathname.replace(/\//g, '_') || 'unknown';
  }

  function getChatTitle() {
    const el = document.querySelector('[data-test-id="conversation-title"]');
    if (el) {
      const t = el.textContent.trim();
      if (t && !['Gemini', 'Google Gemini'].includes(t)) return t;
    }
    const pt = document.title
      .replace(/\s*[-–]\s*Gemini$/i, '')
      .replace(/\s*[-–]\s*Google$/i, '')
      .replace(/^Gemini\s*[-–]?\s*/, '')
      .trim();
    if (pt && !['Gemini', 'Google Gemini'].includes(pt)) return pt;
    return `Chat ${new Date().toLocaleDateString('ja-JP')}`;
  }

  // ===== DOM 抽出（v1 と同一）=====

  function extractUserQuery(container) {
    const lines = container.querySelectorAll('.query-text-line');
    if (lines.length > 0) return Array.from(lines).map(l => l.textContent.trim()).filter(Boolean).join('\n');
    const queryText = container.querySelector('.query-text');
    if (queryText) return queryText.textContent.trim();
    return '';
  }

  function extractUserImages(container) {
    const imgs = container.querySelectorAll('user-query-file-preview img[data-test-id="uploaded-img"]');
    return Array.from(imgs).map(img => img.src).filter(Boolean);
  }

  function extractModelResponse(container) {
    const markdownEl =
      container.querySelector('message-content .markdown') ||
      container.querySelector('.markdown') ||
      container.querySelector('message-content');
    if (!markdownEl) return '';

    // シャドウDOM内容をクローン前に事前抽出
    const origInteractives  = Array.from(markdownEl.querySelectorAll('response-element, mini-app'));
    const extractedContents = origInteractives.map(el => extractInteractiveContent(el));

    return nodeToMarkdown(markdownEl, origInteractives, extractedContents)
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  /** DOM ノードを Markdown 文字列に変換する */
  function nodeToMarkdown(node, interactives, contents) {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent;
    if (node.nodeType !== Node.ELEMENT_NODE) return '';

    const tag = node.tagName.toLowerCase();

    // code-block カスタム要素: コードをインライン展開
    if (tag === 'code-block') {
      const codeEl = node.querySelector('code[data-test-id="code-content"]');
      const langEl = node.querySelector('.code-block-decoration span');
      const lang   = langEl ? langEl.textContent.trim().toLowerCase() : '';
      const code   = codeEl ? codeEl.textContent.trim() : node.textContent.trim();
      return code ? `\n\`\`\`${lang}\n${code}\n\`\`\`\n` : '';
    }

    // response-element / mini-app: シャドウDOMから事前抽出した内容を使用
    if (tag === 'response-element' || tag === 'mini-app') {
      const idx  = interactives.indexOf(node);
      const text = idx >= 0 ? (contents[idx] || '') : node.textContent.trim();
      return text ? `\n${text}\n` : '';
    }

    if (['script', 'style', 'button', 'svg', 'path'].includes(tag)) return '';

    const inner = () =>
      Array.from(node.childNodes).map(n => nodeToMarkdown(n, interactives, contents)).join('');

    switch (tag) {
      case 'h1': return `\n# ${inner().trim()}\n\n`;
      case 'h2': return `\n## ${inner().trim()}\n\n`;
      case 'h3': return `\n### ${inner().trim()}\n\n`;
      case 'h4': return `\n#### ${inner().trim()}\n\n`;
      case 'h5': return `\n##### ${inner().trim()}\n\n`;
      case 'h6': return `\n###### ${inner().trim()}\n\n`;
      case 'p':  return `\n${inner().trim()}\n\n`;
      case 'br': return '\n';
      case 'strong':
      case 'b':  return `**${inner()}**`;
      case 'em':
      case 'i':  return `*${inner()}*`;
      case 'del':
      case 's':  return `~~${inner()}~~`;
      case 'code': return `\`${inner()}\``;
      case 'a': {
        const href = node.href || node.getAttribute('href') || '';
        const text = inner();
        return (href && !href.startsWith('javascript')) ? `[${text}](${href})` : text;
      }
      case 'ul': {
        const items = Array.from(node.childNodes)
          .filter(n => n.nodeType === Node.ELEMENT_NODE && n.tagName.toLowerCase() === 'li')
          .map(li => `- ${nodeToMarkdown(li, interactives, contents).trim().replace(/\n(?=\S)/g, '\n  ')}`);
        return items.length ? `\n${items.join('\n')}\n` : '';
      }
      case 'ol': {
        const items = Array.from(node.childNodes)
          .filter(n => n.nodeType === Node.ELEMENT_NODE && n.tagName.toLowerCase() === 'li')
          .map((li, i) => `${i + 1}. ${nodeToMarkdown(li, interactives, contents).trim().replace(/\n(?=\S)/g, '\n   ')}`);
        return items.length ? `\n${items.join('\n')}\n` : '';
      }
      case 'li': return inner();
      case 'table': return `\n${tableToMarkdown(node)}\n`;
      case 'blockquote': return `\n${inner().trim().replace(/^/gm, '> ')}\n`;
      case 'hr': return '\n---\n';
      case 'pre': {
        const codeEl = node.querySelector('code');
        if (codeEl) {
          const lang = (codeEl.className.match(/language-(\w+)/) || [])[1] || '';
          return `\n\`\`\`${lang}\n${codeEl.textContent.trim()}\n\`\`\`\n`;
        }
        return `\n\`\`\`\n${node.textContent.trim()}\n\`\`\`\n`;
      }
      default: return inner();
    }
  }

  /** response-element / mini-app から実コンテンツを取得する */
  function extractInteractiveContent(el) {
    // 1. オープンな shadow DOM をネスト含めて再帰検索
    if (el.shadowRoot) {
      const shadowText = extractFromShadow(el.shadowRoot);
      if (shadowText) return shadowText;
    }
    // 2. ライト DOM 内の <table> を検索
    const lightTables = Array.from(el.querySelectorAll('table'));
    if (lightTables.length) {
      return lightTables.map(tableToMarkdown).join('\n\n');
    }
    // 3. テキストフォールバック（CSV → Markdown 変換を試みる）
    const text = el.textContent.trim();
    return textToMarkdownTable(text) || text;
  }

  function extractFromShadow(shadowRoot) {
    // ネストされた shadow DOM も含めて <table> を再帰検索
    const tables = findTablesDeep(shadowRoot);
    if (tables.length) {
      return tables.map(tableToMarkdown).join('\n\n');
    }
    // CSV 形式テキストを Markdown テーブルに変換
    const text = shadowRoot.textContent.trim();
    return textToMarkdownTable(text) || text;
  }

  /** shadow DOM をネスト込みで <table> を探す */
  function findTablesDeep(root) {
    const direct = Array.from(root.querySelectorAll('table'));
    if (direct.length) return direct;
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) {
        const nested = findTablesDeep(el.shadowRoot);
        if (nested.length) return nested;
      }
    }
    return [];
  }

  /**
   * Gemini が shadow DOM のテキストとして出力する CSV 形式を
   * Markdown テーブルに変換する。変換できなければ null を返す。
   */
  function textToMarkdownTable(text) {
    if (!text) return null;
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length < 2) return null;
    const rows = lines.map(l => l.split(',').map(c => c.trim()));
    const colCount = rows[0].length;
    if (colCount < 2) return null;
    if (!rows.every(r => r.length === colCount)) return null;
    const header = '| ' + rows[0].join(' | ') + ' |';
    const sep    = '| ' + Array(colCount).fill('---').join(' | ') + ' |';
    const body   = rows.slice(1).map(r => '| ' + r.join(' | ') + ' |');
    return [header, sep, ...body].join('\n');
  }

  function tableToMarkdown(table) {
    const rows = Array.from(table.querySelectorAll('tr'));
    if (!rows.length) return '';

    const lines = [];
    rows.forEach((row, rowIdx) => {
      const cells = Array.from(row.querySelectorAll('th, td'));
      const isHeader = cells.some(c => c.tagName === 'TH') || rowIdx === 0;
      const line = '| ' + cells.map(c => c.textContent.trim().replace(/\|/g, '\\|')).join(' | ') + ' |';
      lines.push(line);
      if (isHeader) {
        lines.push('| ' + cells.map(() => '---').join(' | ') + ' |');
      }
    });
    return lines.join('\n');
  }

  function extractCodeBlocks(container) {
    const blocks = [];
    container.querySelectorAll('code-block').forEach(cb => {
      const codeEl = cb.querySelector('code[data-test-id="code-content"]');
      const langEl = cb.querySelector('.code-block-decoration span');
      if (codeEl) blocks.push({
        language: langEl ? langEl.textContent.trim().toLowerCase() : '',
        content:  codeEl.textContent.trim()
      });
    });
    return blocks;
  }

  // ===== メッセージ処理 =====

  async function processConversationContainer(container) {
    const turnId = container.id;
    if (!turnId || processedTurns.has(turnId)) return;

    const userEl  = container.querySelector('user-query');
    const modelEl = container.querySelector('model-response');

    if (userEl) {
      const text = extractUserQuery(userEl);
      if (text) {
        const images = extractUserImages(userEl);
        try {
          await chrome.runtime.sendMessage({
            action:    'sessionSaveMessage',
            chatId:    currentChatId,
            chatTitle: getChatTitle(),
            message: {
              turnId, role: 'user', content: text,
              images:    images.length ? images : undefined,
              timestamp: new Date().toISOString()
            }
          });
        } catch {}
      }
    }

    if (modelEl) {
      const responseContainer = modelEl.querySelector('response-container');
      if (!responseContainer || responseContainer.querySelector('[aria-busy="true"]')) return;
      const text = extractModelResponse(modelEl);
      if (text) {
        // v1 と同じく「保存成功時のみ」processedTurns に追加する
        // コードブロックは nodeToMarkdown で content にインライン展開済みのため別送不要
        try {
          const result = await chrome.runtime.sendMessage({
            action:    'sessionSaveMessage',
            chatId:    currentChatId,
            chatTitle: getChatTitle(),
            message: {
              turnId, role: 'model', content: text,
              timestamp:  new Date().toISOString()
            }
          });
          if (result?.success) processedTurns.add(turnId);
        } catch {}
      }
    }
  }

  async function scanExistingConversations() {
    const containers = Array.from(document.querySelectorAll('.conversation-container'));
    for (const c of containers) await processConversationContainer(c);
    const turnIds = containers.map(c => c.id).filter(Boolean);
    if (turnIds.length) {
      sendToBg({ action: 'sessionSyncOrder', chatId: currentChatId, turnIds });
    }
  }

  // ===== ページ内トースト =====

  function showPageToast(msg) {
    let t = document.getElementById('gemlog-next-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'gemlog-next-toast';
      t.style.cssText = [
        'position:fixed','top:20px','left:50%','transform:translateX(-50%)',
        'background:#0a0e1a','color:#e2e8f0','padding:10px 20px',
        'border-radius:20px','border:1px solid rgba(16,185,129,0.4)',
        'z-index:9999','font-size:13px','font-weight:500',
        'box-shadow:0 4px 20px rgba(0,0,0,0.4)','transition:opacity 0.3s',
        'backdrop-filter:blur(8px)'
      ].join(';');
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.style.opacity = '1';
  }

  function hidePageToast() {
    const t = document.getElementById('gemlog-next-toast');
    if (t) t.style.opacity = '0';
  }

  // ===== 過去ログの自動スクロール取得 =====

  async function autoScrollToTop() {
    scrollStopped = false;

    const scroller = document.querySelector('infinite-scroller.chat-history')
      || document.querySelector('.chat-history')
      || document.documentElement;

    showPageToast(chrome.i18n.getMessage('toastAutoScrollStart'));

    let lastHeight = scroller.scrollHeight;
    let retries    = 0;

    const run = async () => {
      if (scrollStopped) { hidePageToast(); return; }

      scroller.scrollTop = 0;
      await new Promise(r => setTimeout(r, 1200));

      if (scrollStopped) { hidePageToast(); return; }

      if (scroller.scrollHeight === lastHeight) {
        retries++;
        if (retries >= 3) {
          showPageToast(chrome.i18n.getMessage('toastAutoScrollReachedTop'));
          // clearSession/processedTurns.clear() は行わない:
          // Gemini の仮想スクロールでDOMから消えたコンテナは MutationObserver が
          // リアルタイムで捕捉してセッションに蓄積済み。クリアするとそのデータが消える。
          // 最後に現在見えているコンテナだけ追加スキャンして補完する。
          await scanExistingConversations();
          showPageToast(chrome.i18n.getMessage('toastAutoScrollDone'));
          setTimeout(hidePageToast, 4000);
          // バルクダウンロード中のサイドパネルへ完了を通知
          sendToBg({ action: 'autoScrollComplete' });
          return;
        }
      } else {
        retries    = 0;
        lastHeight = scroller.scrollHeight;
        showPageToast(chrome.i18n.getMessage('toastAutoScrollProgress') + lastHeight + 'px)');
      }
      setTimeout(run, 300);
    };

    setTimeout(run, 0);
  }

  // ===== MutationObserver（v1 と同一）=====

  function startObserver() {
    const chatContainer = document.querySelector('infinite-scroller.chat-history');
    if (!chatContainer) return setTimeout(startObserver, 2000);
    if (observer) observer.disconnect();

    observer = new MutationObserver(async mutations => {
      let shouldSyncOrder = false;
      for (const mutation of mutations) {
        if (mutation.type !== 'childList') continue;
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          if (node.classList?.contains('conversation-container')) {
            await processConversationContainer(node);
            shouldSyncOrder = true;
          }
          const containers = node.querySelectorAll?.('.conversation-container');
          if (containers?.length) {
            for (const c of containers) await processConversationContainer(c);
            shouldSyncOrder = true;
          }
          if (
            node.tagName === 'MESSAGE-CONTENT' ||
            node.classList?.contains('response-content') ||
            node.querySelector?.('message-content')
          ) {
            const c = node.closest('.conversation-container');
            if (c?.id && !processedTurns.has(c.id)) {
              setTimeout(() => { processConversationContainer(c); scanExistingConversations(); }, 500);
            }
          }
        }
      }
      if (shouldSyncOrder) setTimeout(scanExistingConversations, 500);
    });

    observer.observe(chatContainer, { childList: true, subtree: true });
    scanExistingConversations();
  }

  function startBusyObserver() {
    const chatArea = document.querySelector('infinite-scroller.chat-history');
    if (!chatArea) return;
    if (busyObserver) busyObserver.disconnect();

    busyObserver = new MutationObserver(mutations => {
      for (const m of mutations) {
        if (m.type === 'attributes' && m.attributeName === 'aria-busy' &&
            m.target.getAttribute('aria-busy') === 'false') {
          const c = m.target.closest('.conversation-container');
          if (c?.id && !processedTurns.has(c.id)) {
            setTimeout(() => { processConversationContainer(c); scanExistingConversations(); }, 300);
          }
        }
      }
    });

    busyObserver.observe(chatArea, { attributes: true, attributeFilter: ['aria-busy'], subtree: true });
  }

  function watchURLChanges() {
    let lastURL = location.href;
    new MutationObserver(async () => {
      if (location.href === lastURL) return;
      lastURL = location.href;

      const newChatId = getChatIdFromURL();
      if (newChatId !== currentChatId) {
        sendToBg({ action: 'clearSession' });
        processedTurns.clear();
        currentChatId = newChatId;
        setTimeout(scanExistingConversations, 1000);
      }
    }).observe(document.body, { childList: true, subtree: true });
  }

  // ===== Popup からのメッセージ =====

  // ===== Gemini サイドバーの会話一覧を取得 =====

  function getSidebarConversations() {
    const seen    = new Set();
    const results = [];
    const currentId = getChatIdFromURL();

    document.querySelectorAll('a[href]').forEach(a => {
      let pathname;
      try { pathname = new URL(a.href, location.origin).pathname; } catch { return; }

      const m = pathname.match(/^\/app\/([a-zA-Z0-9_-]+)$/);
      if (!m) return;

      const chatId = m[1];
      if (seen.has(chatId)) return;
      seen.add(chatId);

      const rawTitle = (a.getAttribute('aria-label') || a.textContent || '').trim();
      if (!rawTitle || ['New chat', 'Gemini', 'Google Gemini'].includes(rawTitle)) return;

      results.push({
        chatId,
        title:   rawTitle,
        url:     `https://gemini.google.com/app/${chatId}`,
        current: chatId === currentId
      });
    });

    return results;
  }

  // ===== Popup からのメッセージ =====

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return false;
    if (request.action === 'getStatus') {
      sendResponse({ active: true, chatId: currentChatId, processedTurns: processedTurns.size });
    } else if (request.action === 'forceScan') {
      scanExistingConversations().then(() => sendResponse({ success: true }));
    } else if (request.action === 'autoScroll') {
      autoScrollToTop();
      sendResponse({ success: true });
    } else if (request.action === 'getSidebarList') {
      sendResponse({ conversations: getSidebarConversations() });
    } else if (request.action === 'stopScroll') {
      scrollStopped = true;
      hidePageToast();
      sendResponse({ success: true });
    }
    return true;
  });

  // ===== 初期化（v1 と同一構造）=====

  function init() {
    currentChatId = getChatIdFromURL();

    // ポート接続: background が tabId を知り、セッションマーカーを作成・管理する
    try {
      chrome.runtime.connect({ name: 'gemlog-session-port' });
    } catch {}

    // v1 と同じタイミングで観察を開始
    if (document.querySelector('infinite-scroller.chat-history')) {
      startObserver();
      startBusyObserver();
    } else {
      const io = new MutationObserver((_, obs) => {
        if (document.querySelector('infinite-scroller.chat-history')) {
          obs.disconnect();
          startObserver();
          startBusyObserver();
        }
      });
      io.observe(document.body, { childList: true, subtree: true });
    }

    watchURLChanges();
  }

  init();
})();
