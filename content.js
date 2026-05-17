/**
 * GemLog Next — Content Script
 * gemini.google.com のチャット画面をMutationObserverで監視し、メッセージを記録する。
 */
(function () {
  'use strict';

  if (window.__gemlog_next_initialized) return;
  window.__gemlog_next_initialized = true;

  let currentChatId = null;
  let observer = null;
  let busyObserver = null;
  const processedTurns = new Set();

  // --- Utilities ---

  function getChatIdFromURL() {
    const match = location.pathname.match(/\/app\/([a-f0-9]+)/);
    return match ? match[1] : location.pathname.replace(/\//g, '_') || 'unknown';
  }

  function getChatTitle() {
    const precise = document.querySelector('[data-test-id="conversation-title"]');
    if (precise) {
      const text = precise.textContent.trim();
      if (text && !['Gemini', 'Google Gemini'].includes(text)) return text;
    }
    const pageTitle = document.title
      .replace(/\s*[-–]\s*Gemini$/i, '')
      .replace(/\s*[-–]\s*Google$/i, '')
      .replace(/^Gemini\s*[-–]?\s*/, '')
      .trim();
    if (pageTitle && !['Gemini', 'Google Gemini'].includes(pageTitle)) return pageTitle;
    return `Chat ${new Date().toLocaleDateString('ja-JP')}`;
  }

  // --- DOM Extractors ---

  function extractUserQuery(container) {
    const lines = container.querySelectorAll('.query-text-line');
    if (lines.length > 0) {
      return Array.from(lines).map(l => l.textContent.trim()).filter(Boolean).join('\n');
    }
    return container.querySelector('.query-text')?.textContent.trim() || '';
  }

  function extractUserImages(container) {
    const imgs = container.querySelectorAll('user-query-file-preview img[data-test-id="uploaded-img"]');
    return Array.from(imgs).map(img => img.src).filter(Boolean);
  }

  function extractModelResponse(container) {
    const markdownEl = container.querySelector('message-content .markdown');
    if (!markdownEl) return '';
    const clone = markdownEl.cloneNode(true);
    clone.querySelectorAll('code-block').forEach((cb, i) => {
      const span = document.createElement('span');
      span.textContent = `[CODE_BLOCK_${i}]`;
      cb.replaceWith(span);
    });
    clone.querySelectorAll('mini-app, response-element').forEach(el => {
      el.textContent = '[Interactive Widget]';
    });
    return clone.textContent.trim();
  }

  function extractCodeBlocks(container) {
    return Array.from(container.querySelectorAll('code-block')).map(cb => {
      const codeEl = cb.querySelector('code[data-test-id="code-content"]');
      const langEl = cb.querySelector('.code-block-decoration span');
      return codeEl ? {
        language: langEl?.textContent.trim().toLowerCase() || '',
        content: codeEl.textContent.trim()
      } : null;
    }).filter(Boolean);
  }

  // --- Core Processing ---

  async function processConversationContainer(container) {
    const turnId = container.id;
    if (!turnId || processedTurns.has(turnId)) return;

    const shouldLog = await GemLogStorage.shouldLog(currentChatId);
    if (!shouldLog) return;

    const userQueryEl = container.querySelector('user-query');
    const modelResponseEl = container.querySelector('model-response');

    if (userQueryEl) {
      const text = extractUserQuery(userQueryEl);
      if (text) {
        const images = extractUserImages(userQueryEl);
        await GemLogStorage.saveMessage(currentChatId, getChatTitle(), {
          turnId,
          role: 'user',
          content: text,
          images: images.length > 0 ? images : undefined,
          timestamp: new Date().toISOString()
        });
      }
    }

    if (modelResponseEl) {
      const responseContainer = modelResponseEl.querySelector('response-container');
      if (!responseContainer || responseContainer.querySelector('[aria-busy="true"]')) return;

      const text = extractModelResponse(modelResponseEl);
      if (text) {
        const codeBlocks = extractCodeBlocks(modelResponseEl);
        const saved = await GemLogStorage.saveMessage(currentChatId, getChatTitle(), {
          turnId,
          role: 'model',
          content: text,
          codeBlocks: codeBlocks.length > 0 ? codeBlocks : undefined,
          timestamp: new Date().toISOString()
        });
        if (saved) processedTurns.add(turnId);
      }
    }
  }

  async function scanExistingConversations() {
    const containers = Array.from(document.querySelectorAll('.conversation-container'));
    for (const container of containers) {
      await processConversationContainer(container);
    }
    const turnIds = containers.map(c => c.id).filter(Boolean);
    if (turnIds.length > 0 && currentChatId) {
      await GemLogStorage.syncDOMOrder(currentChatId, turnIds);
    }
  }

  // --- Toast UI ---

  function showPageToast(msg) {
    let toast = document.getElementById('gemlog-next-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'gemlog-next-toast';
      toast.style.cssText = [
        'position:fixed', 'top:20px', 'left:50%', 'transform:translateX(-50%)',
        'background:#0a0e1a', 'color:#e2e8f0', 'padding:10px 20px',
        'border-radius:20px', 'border:1px solid rgba(16,185,129,0.4)',
        'z-index:9999', 'font-size:13px', 'font-weight:500',
        'box-shadow:0 4px 20px rgba(0,0,0,0.4)', 'transition:opacity 0.3s',
        'backdrop-filter:blur(8px)'
      ].join(';');
      document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.style.opacity = '1';
  }

  function hidePageToast() {
    const toast = document.getElementById('gemlog-next-toast');
    if (toast) toast.style.opacity = '0';
  }

  // --- Auto Scroll ---

  async function autoScrollToTop() {
    const scroller = document.querySelector('infinite-scroller.chat-history')
      || document.querySelector('.chat-history')
      || document.documentElement;

    showPageToast(chrome.i18n.getMessage('toastAutoScrollStart'));

    let lastHeight = scroller.scrollHeight;
    let retries = 0;

    const runScroll = async () => {
      scroller.scrollTop = 0;
      await new Promise(r => setTimeout(r, 1200));

      if (scroller.scrollHeight === lastHeight) {
        retries++;
        if (retries >= 3) {
          showPageToast(chrome.i18n.getMessage('toastAutoScrollReachedTop'));
          await GemLogStorage.clearChatMessages(currentChatId);
          processedTurns.clear();
          await scanExistingConversations();
          showPageToast(chrome.i18n.getMessage('toastAutoScrollDone'));
          setTimeout(hidePageToast, 4000);
          return;
        }
      } else {
        retries = 0;
        lastHeight = scroller.scrollHeight;
        showPageToast(chrome.i18n.getMessage('toastAutoScrollProgress') + lastHeight + 'px)');
      }

      setTimeout(runScroll, 300);
    };

    setTimeout(runScroll, 0);
  }

  // --- MutationObservers ---

  function startObserver() {
    const chatContainer = document.querySelector('infinite-scroller.chat-history');
    if (!chatContainer) return setTimeout(startObserver, 2000);
    if (observer) observer.disconnect();

    observer = new MutationObserver(async (mutations) => {
      let shouldSync = false;
      for (const mutation of mutations) {
        if (mutation.type !== 'childList') continue;
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          if (node.classList?.contains('conversation-container')) {
            await processConversationContainer(node);
            shouldSync = true;
          }
          const nested = node.querySelectorAll?.('.conversation-container');
          if (nested?.length) {
            for (const c of nested) await processConversationContainer(c);
            shouldSync = true;
          }
          if (
            node.tagName === 'MESSAGE-CONTENT' ||
            node.classList?.contains('response-content') ||
            node.querySelector?.('message-content')
          ) {
            const container = node.closest('.conversation-container');
            if (container?.id && !processedTurns.has(container.id)) {
              setTimeout(() => {
                processConversationContainer(container);
                scanExistingConversations();
              }, 500);
            }
          }
        }
      }
      if (shouldSync) setTimeout(scanExistingConversations, 500);
    });

    observer.observe(chatContainer, { childList: true, subtree: true });
    scanExistingConversations();
  }

  function startBusyObserver() {
    const chatArea = document.querySelector('infinite-scroller.chat-history');
    if (!chatArea) return;
    if (busyObserver) busyObserver.disconnect();

    busyObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'attributes' && mutation.attributeName === 'aria-busy') {
          if (mutation.target.getAttribute('aria-busy') === 'false') {
            const container = mutation.target.closest('.conversation-container');
            if (container?.id && !processedTurns.has(container.id)) {
              setTimeout(() => {
                processConversationContainer(container);
                scanExistingConversations();
              }, 300);
            }
          }
        }
      }
    });

    busyObserver.observe(chatArea, { attributes: true, attributeFilter: ['aria-busy'], subtree: true });
  }

  function watchURLChanges() {
    let lastURL = location.href;
    new MutationObserver(() => {
      if (location.href !== lastURL) {
        lastURL = location.href;
        currentChatId = getChatIdFromURL();
        processedTurns.clear();
        setTimeout(scanExistingConversations, 1000);
      }
    }).observe(document.body, { childList: true, subtree: true });
  }

  // --- Message Handler ---

  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    if (request.action === 'getStatus') {
      sendResponse({ active: true, chatId: currentChatId, processedTurns: processedTurns.size });
    } else if (request.action === 'forceScan') {
      scanExistingConversations().then(() => sendResponse({ success: true }));
    } else if (request.action === 'autoScroll') {
      autoScrollToTop();
      sendResponse({ success: true });
    }
    return true;
  });

  // --- Init ---

  function init() {
    currentChatId = getChatIdFromURL();
    if (document.querySelector('infinite-scroller.chat-history')) {
      startObserver();
      startBusyObserver();
    } else {
      const initObserver = new MutationObserver((_, obs) => {
        if (document.querySelector('infinite-scroller.chat-history')) {
          obs.disconnect();
          startObserver();
          startBusyObserver();
        }
      });
      initObserver.observe(document.body, { childList: true, subtree: true });
    }
    watchURLChanges();
  }

  init();
})();
