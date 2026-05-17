/**
 * GemLog Next — Content Script
 *
 * セキュリティ設計:
 *   - チャット履歴は chrome.storage.session に保存（ブラウザ終了で自動消去）
 *   - background とのポート接続を利用し、ページ離脱時にセッションを自動削除
 *   - Gemini 内でチャットを切り替えた場合も前のセッションを削除
 */
(function () {
  'use strict';

  if (window.__gemlog_next_initialized) return;
  window.__gemlog_next_initialized = true;

  let tabId         = null;   // background から取得
  let currentChatId = null;
  let port          = null;   // background との永続接続（切断=セッション削除のトリガー）
  let observer      = null;
  let busyObserver  = null;
  const processedTurns = new Set();

  // ===== Tab ID の取得と初期化 =====

  async function init() {
    // background に tab ID を要求
    const response = await chrome.runtime.sendMessage({ action: 'getTabId' });
    tabId = response?.tabId;
    if (!tabId) return;

    // ポート接続 — 切断時に background がセッションを削除する
    port = chrome.runtime.connect({ name: `gemlog-session-${tabId}` });

    currentChatId = getChatIdFromURL();
    startExtension();
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

  // ===== DOM 抽出 =====

  function extractUserQuery(container) {
    const lines = container.querySelectorAll('.query-text-line');
    if (lines.length) return Array.from(lines).map(l => l.textContent.trim()).filter(Boolean).join('\n');
    return container.querySelector('.query-text')?.textContent.trim() || '';
  }

  function extractUserImages(container) {
    return Array.from(
      container.querySelectorAll('user-query-file-preview img[data-test-id="uploaded-img"]')
    ).map(img => img.src).filter(Boolean);
  }

  function extractModelResponse(container) {
    const el = container.querySelector('message-content .markdown');
    if (!el) return '';
    const clone = el.cloneNode(true);
    clone.querySelectorAll('code-block').forEach((cb, i) => {
      const s = document.createElement('span');
      s.textContent = `[CODE_BLOCK_${i}]`;
      cb.replaceWith(s);
    });
    clone.querySelectorAll('mini-app, response-element').forEach(e => { e.textContent = '[Interactive Widget]'; });
    return clone.textContent.trim();
  }

  function extractCodeBlocks(container) {
    return Array.from(container.querySelectorAll('code-block')).map(cb => {
      const code = cb.querySelector('code[data-test-id="code-content"]');
      const lang = cb.querySelector('.code-block-decoration span');
      return code ? { language: lang?.textContent.trim().toLowerCase() || '', content: code.textContent.trim() } : null;
    }).filter(Boolean);
  }

  // ===== メッセージ処理 =====

  async function processConversationContainer(container) {
    if (!tabId) return;
    const turnId = container.id;
    if (!turnId || processedTurns.has(turnId)) return;

    const userEl  = container.querySelector('user-query');
    const modelEl = container.querySelector('model-response');

    if (userEl) {
      const text = extractUserQuery(userEl);
      if (text) {
        const images = extractUserImages(userEl);
        await GemLogSession.saveMessage(tabId, currentChatId, getChatTitle(), {
          turnId, role: 'user', content: text,
          images: images.length ? images : undefined,
          timestamp: new Date().toISOString()
        });
      }
    }

    if (modelEl) {
      const rc = modelEl.querySelector('response-container');
      if (!rc || rc.querySelector('[aria-busy="true"]')) return;
      const text = extractModelResponse(modelEl);
      if (text) {
        const codeBlocks = extractCodeBlocks(modelEl);
        const saved = await GemLogSession.saveMessage(tabId, currentChatId, getChatTitle(), {
          turnId, role: 'model', content: text,
          codeBlocks: codeBlocks.length ? codeBlocks : undefined,
          timestamp: new Date().toISOString()
        });
        if (saved) processedTurns.add(turnId);
      }
    }
  }

  async function scanExistingConversations() {
    const containers = Array.from(document.querySelectorAll('.conversation-container'));
    for (const c of containers) await processConversationContainer(c);

    const turnIds = containers.map(c => c.id).filter(Boolean);
    if (turnIds.length && tabId) await GemLogSession.syncDOMOrder(tabId, turnIds);
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
    const scroller = document.querySelector('infinite-scroller.chat-history')
      || document.querySelector('.chat-history')
      || document.documentElement;

    showPageToast(chrome.i18n.getMessage('toastAutoScrollStart'));

    let lastHeight = scroller.scrollHeight;
    let retries    = 0;

    const run = async () => {
      scroller.scrollTop = 0;
      await new Promise(r => setTimeout(r, 1200));

      if (scroller.scrollHeight === lastHeight) {
        retries++;
        if (retries >= 3) {
          showPageToast(chrome.i18n.getMessage('toastAutoScrollReachedTop'));
          // セッションをクリアして再スキャン
          if (tabId) await GemLogSession.clear(tabId);
          processedTurns.clear();
          await scanExistingConversations();
          showPageToast(chrome.i18n.getMessage('toastAutoScrollDone'));
          setTimeout(hidePageToast, 4000);
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

  // ===== MutationObserver =====

  function startObserver() {
    const chat = document.querySelector('infinite-scroller.chat-history');
    if (!chat) return setTimeout(startObserver, 2000);
    if (observer) observer.disconnect();

    observer = new MutationObserver(async mutations => {
      let sync = false;
      for (const m of mutations) {
        if (m.type !== 'childList') continue;
        for (const node of m.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          if (node.classList?.contains('conversation-container')) {
            await processConversationContainer(node);
            sync = true;
          }
          const nested = node.querySelectorAll?.('.conversation-container');
          if (nested?.length) { for (const c of nested) await processConversationContainer(c); sync = true; }
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
      if (sync) setTimeout(scanExistingConversations, 500);
    });

    observer.observe(chat, { childList: true, subtree: true });
    scanExistingConversations();
  }

  function startBusyObserver() {
    const chat = document.querySelector('infinite-scroller.chat-history');
    if (!chat) return;
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

    busyObserver.observe(chat, { attributes: true, attributeFilter: ['aria-busy'], subtree: true });
  }

  /**
   * SPA内のURL変化を監視する。
   * 別チャットに移動したら: セッションを削除して新チャットの記録を開始。
   */
  function watchURLChanges() {
    let lastURL = location.href;

    new MutationObserver(async () => {
      if (location.href === lastURL) return;
      lastURL = location.href;

      const newChatId = getChatIdFromURL();
      if (newChatId !== currentChatId) {
        // 別チャットへ移動 → 前のセッションを削除
        if (tabId) await GemLogSession.clear(tabId);
        processedTurns.clear();
        currentChatId = newChatId;
        setTimeout(scanExistingConversations, 1000);
      }
    }).observe(document.body, { childList: true, subtree: true });
  }

  // ===== Popup からのメッセージ =====

  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    if (request.action === 'getStatus') {
      sendResponse({ active: true, tabId, chatId: currentChatId, processedTurns: processedTurns.size });
    } else if (request.action === 'forceScan') {
      scanExistingConversations().then(() => sendResponse({ success: true }));
    } else if (request.action === 'autoScroll') {
      autoScrollToTop();
      sendResponse({ success: true });
    }
    return true;
  });

  // ===== 拡張機能の開始 =====

  function startExtension() {
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
