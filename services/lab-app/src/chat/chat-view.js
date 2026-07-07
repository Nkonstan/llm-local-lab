// ─────────────────────────────────────────────────────────────────────────────
//  Lab UI — chat view (sendMessage, message rendering, New Chat)
//
//  Mechanically extracted from the original inline <script>, with two real
//  behavioural changes (both intentional, both part of adding the backend):
//    1. The inline fetch+stream-reading loop is replaced by a call to the
//       shared streamChat() — same NDJSON parsing, same live-thinking-panel
//       logic, just no longer duplicated per app. The "build/update the live
//       thinking block" code was duplicated twice in the original (once for
//       native message.thinking, once for <think>-tag fallback); it's
//       factored into one renderLiveThinking() helper here, mirroring the
//       pattern Lab Eval's diff view already used.
//    2. Every turn is now tagged with a conversationId and persisted by the
//       backend (Lab UI previously kept `messages` in memory only — closing
//       the tab lost everything).
//    3. The half-dozen leftover console.log('[DEBUG] ...') calls from the
//       original inline loop are dropped, since that loop no longer exists
//       in this file — streamChat() (already used by Lab Eval) never had
//       them. Flagging this explicitly since it's the one place this refactor
//       silently changes something instead of just moving it.
// ─────────────────────────────────────────────────────────────────────────────

import { escHtml, renderMarkdown, parseThinking } from '../../../shared/markdown.js';
import { buildStatsCard } from '../../../shared/stats-card.js';
import { streamChat, isGptOss } from '../../../shared/api-client.js';
import { getParams } from '../params-panel.js';

export function initChatView({ baseUrl, $modelSelect, $messagesEl, $userInput, $sendBtn, $stopBtn, $systemPrompt, $welcome, showToast }) {
  let messages        = [];          // [{role, content}]
  let isGenerating     = false;
  let abortController  = null;
  let sessionStats     = { requests: 0, totalTokens: 0, totalTime: 0 };
  let conversationId   = crypto.randomUUID();

  function nowLabel() {
    return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function scrollToBottom() {
    $messagesEl.scrollTop = $messagesEl.scrollHeight;
  }

  function removeWelcome() {
    // The initial (static, index.html) welcome uses id="welcome-chat"; the
    // one newChat() creates dynamically uses id="welcome" — matching by
    // class instead of either specific id means the very FIRST message of a
    // session (before "New Chat" is ever clicked) actually hides it too.
    $messagesEl.querySelector('.welcome')?.remove();
  }

  function addUserMessage(content) {
    const msg = document.createElement('div');
    msg.className = 'message user';
    msg.innerHTML = `
      <div class="message-header">
        <span class="role-badge user">You</span>
        <span class="message-time">${nowLabel()}</span>
      </div>
      <div class="message-body">${escHtml(content)}</div>
    `;
    removeWelcome();
    $messagesEl.appendChild(msg);
    scrollToBottom();
    return msg;
  }

  function addAssistantPlaceholder() {
    const msg = document.createElement('div');
    msg.className = 'message assistant';
    msg.innerHTML = `
      <div class="message-header">
        <span class="role-badge assistant">Assistant</span>
        <span class="message-time">${nowLabel()}</span>
      </div>
      <div class="message-body stream-cursor" id="streaming-body"></div>
    `;
    $messagesEl.appendChild(msg);
    scrollToBottom();
    return msg;
  }

  function showTypingIndicator() {
    const el = document.createElement('div');
    el.id = 'typing-indicator';
    el.className = 'message assistant';
    el.innerHTML = `
      <div class="message-header">
        <span class="role-badge assistant">Assistant</span>
      </div>
      <div class="typing-indicator">
        <div class="typing-dots">
          <span></span><span></span><span></span>
        </div>
        Loading model…
      </div>
    `;
    $messagesEl.appendChild(el);
    scrollToBottom();
    return el;
  }

  function removeTypingIndicator() {
    document.getElementById('typing-indicator')?.remove();
  }

  // Builds (or updates) the live thinking panel inside a streaming message
  // body. Same behaviour whether thinking arrives via the native field or
  // the <think>...</think> fallback — both call sites pass the text so far.
  function renderLiveThinking(streamBody, thinkingSoFar) {
    const toks = Math.round(thinkingSoFar.length / 4);
    let liveBlock = streamBody.querySelector('.live-thinking-block');
    if (!liveBlock) {
      streamBody.textContent = '';
      liveBlock = document.createElement('div');
      liveBlock.className = 'thinking-block live-thinking-block';
      const toggle = document.createElement('button');
      toggle.className = 'thinking-toggle';
      toggle.innerHTML = `💭 Thinking… <span class="thinking-token-count" id="live-think-count">(~${toks} tokens)</span><span class="thinking-chevron">▾</span>`;
      toggle.addEventListener('click', () => liveBlock.classList.toggle('open'));
      const content = document.createElement('div');
      content.className = 'thinking-content';
      content.id = 'live-think-content';
      liveBlock.appendChild(toggle);
      liveBlock.appendChild(content);
      streamBody.appendChild(liveBlock);
    }
    const countEl   = streamBody.querySelector('#live-think-count');
    const contentEl = streamBody.querySelector('#live-think-content');
    if (countEl)   countEl.textContent = `(~${toks} tokens)`;
    if (contentEl) {
      contentEl.textContent = thinkingSoFar;
      contentEl.scrollTop = contentEl.scrollHeight;
    }
  }

  function finaliseAssistant(msgEl, fullContent, fullThinking, stats) {
    const body = msgEl.querySelector('.message-body');
    // This body is no longer "the" in-progress stream target — clearing the
    // id here is what keeps id="streaming-body" unique to at most one
    // element (the CURRENTLY streaming message, if any) at a time. Without
    // this, every message after the first left its finalized body sitting
    // in the DOM still carrying this id, so two (or more) elements could
    // share it — and a scoped `msgEl.querySelector('#streaming-body')` for
    // a later message could then resolve to null instead of its own child,
    // crashing onContent/onThinking for every message after the first.
    body.removeAttribute('id');
    body.classList.remove('stream-cursor');
    body.textContent = '';

    // thinking may be in fullThinking (native API) or embedded in fullContent (<think> tags)
    let thinkingText = fullThinking || null;
    let answerText   = fullContent;

    if (!thinkingText && fullContent.includes('<think>')) {
      const parsed = parseThinking(fullContent);
      thinkingText = parsed.thinking;
      answerText   = parsed.content;
    }

    // ── Thinking block ────────────────────────────────────────────────────
    if (thinkingText) {
      const tokenEstimate = Math.round(thinkingText.length / 4);
      const block = document.createElement('div');
      block.className = 'thinking-block';
      const toggle = document.createElement('button');
      toggle.className = 'thinking-toggle';
      toggle.innerHTML = `💭 Thinking <span class="thinking-token-count">(~${tokenEstimate} tokens)</span><span class="thinking-chevron">▾</span>`;
      toggle.addEventListener('click', () => block.classList.toggle('open'));
      const thinkContent = document.createElement('div');
      thinkContent.className = 'thinking-content';
      thinkContent.textContent = thinkingText;
      block.appendChild(toggle);
      block.appendChild(thinkContent);
      body.appendChild(block);
    }

    // ── Answer ────────────────────────────────────────────────────────────
    const answerEl = document.createElement('div');
    if (answerText && answerText.trim()) {
      try { answerEl.innerHTML = renderMarkdown(answerText); }
      catch (e) { answerEl.textContent = answerText; }
    } else {
      answerEl.style.cssText = 'color:var(--text-dim);font-size:12px;font-style:italic';
      answerEl.textContent = '(No answer — model used all tokens thinking. Increase Max Tokens or use Budget/No Think mode.)';
    }
    body.appendChild(answerEl);

    if (stats) msgEl.appendChild(buildStatsCard(stats));
    scrollToBottom();
  }

  async function sendMessage(userText) {
    if (!userText.trim()) return;

    const model = $modelSelect.value;
    if (!model) { showToast('⚠ No model selected'); return; }

    const params = getParams('CHAT');

    // Push to history
    messages.push({ role: 'user', content: userText });
    addUserMessage(userText);
    $userInput.value = '';
    autoResizeTextarea();

    // Build request payload
    const apiMessages = [];
    const sys = $systemPrompt.value.trim();
    if (sys) apiMessages.push({ role: 'system', content: sys });
    apiMessages.push(...messages);

    isGenerating = true;
    $sendBtn.style.display = 'none';
    $stopBtn.style.display = 'flex';
    $sendBtn.disabled = true;

    abortController = new AbortController();
    const typingEl = showTypingIndicator();
    let msgEl = null;

    try {
      const { fullContent, fullThinking, stats } = await streamChat(
        baseUrl, model, apiMessages, params, abortController.signal,
        {
          onThinking: (thinkingSoFar) => {
            if (!msgEl) { removeTypingIndicator(); msgEl = addAssistantPlaceholder(); }
            renderLiveThinking(msgEl.querySelector('#streaming-body'), thinkingSoFar);
            scrollToBottom();
          },
          onContent: (contentSoFar) => {
            if (!msgEl) { removeTypingIndicator(); msgEl = addAssistantPlaceholder(); }
            const streamBody = msgEl.querySelector('#streaming-body');
            const hasOpen  = contentSoFar.includes('<think>');
            const hasClose = contentSoFar.includes('</think>');
            if (hasOpen && !hasClose) {
              renderLiveThinking(streamBody, contentSoFar.split('<think>')[1] || '');
            } else if (hasOpen && hasClose) {
              streamBody.textContent = contentSoFar.split('</think>').slice(1).join('</think>').trimStart();
            } else {
              streamBody.textContent = contentSoFar;
            }
            scrollToBottom();
          },
        },
        conversationId,
      );

      if (!msgEl) { removeTypingIndicator(); msgEl = addAssistantPlaceholder(); }

      if (stats) {
        sessionStats.requests++;
        sessionStats.totalTokens += stats.evalCount;
        sessionStats.totalTime   += stats.totalTime;
      }

      // Push assistant reply to history
      messages.push({ role: 'assistant', content: fullContent });

      finaliseAssistant(msgEl, fullContent, fullThinking, stats);

    } catch (err) {
      removeTypingIndicator();
      if (err.name === 'AbortError') {
        showToast('⏹ Generation stopped');
      } else {
        const errEl = document.createElement('div');
        errEl.className = 'message assistant';
        errEl.innerHTML = `
          <div class="message-header">
            <span class="role-badge assistant">Error</span>
          </div>
          <div class="message-body" style="border-color:var(--red);color:var(--red)">
            ❌ ${escHtml(err.message)}
          </div>`;
        $messagesEl.appendChild(errEl);
        scrollToBottom();
      }
    } finally {
      isGenerating = false;
      abortController = null;
      $sendBtn.style.display  = 'flex';
      $stopBtn.style.display  = 'none';
      $sendBtn.disabled = false;
      $userInput.focus();
    }
  }

  function stopGeneration() {
    if (abortController) {
      abortController.abort();
    }
  }

  function newChat() {
    messages = [];
    sessionStats = { requests: 0, totalTokens: 0, totalTime: 0 };
    conversationId = crypto.randomUUID();

    // Clear messages and re-add welcome
    $messagesEl.innerHTML = '';
    const welcome = document.createElement('div');
    welcome.id = 'welcome';
    welcome.className = 'welcome';
    welcome.innerHTML = `
      <div class="welcome-icon">🧪</div>
      <h2>LLM Local Lab</h2>
      <p>A research interface for comparing models and tuning parameters. Select a model above, adjust parameters on the left, then start a conversation.</p>
      <div class="welcome-shortcuts">
        <span class="shortcut-badge">Enter to send · Shift+Enter for a new line</span>
        <span class="shortcut-badge">New Chat resets history</span>
      </div>
    `;
    $messagesEl.appendChild(welcome);
    $userInput.focus();
    showToast('New chat started');
  }

  function autoResizeTextarea() {
    $userInput.style.height = 'auto';
    $userInput.style.height = Math.min($userInput.scrollHeight, 160) + 'px';
  }

  // ── Load an existing conversation back into the view (new: persistence) ──
  function loadIntoView(conv) {
    newChat();
    conversationId = conv.id;
    $messagesEl.innerHTML = '';
    for (const m of conv.messages) {
      if (m.role === 'user') {
        addUserMessage(m.content);
      } else {
        const msgEl = addAssistantPlaceholder();
        finaliseAssistant(msgEl, m.content, m.thinking, m.stats);
      }
      messages.push({ role: m.role, content: m.content });
    }
    showToast('Conversation loaded');
  }

  // Wire input/send/stop/new-chat controls
  $sendBtn.addEventListener('click', () => {
    if (!isGenerating) sendMessage($userInput.value.trim());
  });
  $stopBtn.addEventListener('click', stopGeneration);
  $userInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!isGenerating) sendMessage($userInput.value.trim());
    }
    // Shift+Enter: no preventDefault — falls through to the textarea's
    // default behavior and inserts a normal newline.
  });
  $userInput.addEventListener('input', autoResizeTextarea);

  return { sendMessage, newChat, loadIntoView, getConversationId: () => conversationId };
}
