// ─────────────────────────────────────────────────────────────────────────────
//  Lab Eval — A/B Diff view
//
//  Extracted verbatim from the original inline <script>. Behavioural changes,
//  both from adding the backend:
//    - streamChat() now comes from the shared api-client (backend-proxied)
//      instead of a local copy, and each side carries its own persisted
//      conversationId.
//    - console/network target is the lab-api backend, not Ollama directly.
// ─────────────────────────────────────────────────────────────────────────────

import { escHtml, renderMarkdown, parseThinking } from '../../../shared/markdown.js';
import { buildStatsCard } from '../../../shared/stats-card.js';
import { streamChat } from '../../../shared/api-client.js';
import { getParams, pEl, copyPanelConfig, formatThinkValue } from '../params-panel.js';
import { formatModelName } from '../model-select.js';

export function initDiffView({ baseUrl, $messagesL, $messagesR, $sendBtn, $stopBtn, $userInput, $diffDivider, showToast }) {
  let historyL = [];
  let historyR = [];
  let conversationIdL = crypto.randomUUID();
  let conversationIdR = crypto.randomUUID();
  let diffGenerating = false;
  let diffAbortControllers = [];

  function messagesContainerFor(prefix) {
    return prefix === 'L' ? $messagesL : $messagesR;
  }

  function scrollToBottom(container) {
    container.scrollTop = container.scrollHeight;
  }

  function nowLabel() {
    return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function removeWelcome(prefix) {
    document.getElementById(`welcome-${prefix}`)?.remove();
  }

  function addUserMessageTo(prefix, content) {
    const container = messagesContainerFor(prefix);
    removeWelcome(prefix);
    const msg = document.createElement('div');
    msg.className = 'message user';
    msg.innerHTML = `
      <div class="message-header">
        <span class="role-badge user">You</span>
        <span class="message-time">${nowLabel()}</span>
      </div>
      <div class="message-body">${escHtml(content)}</div>
    `;
    container.appendChild(msg);
    scrollToBottom(container);
    return msg;
  }

  function addAssistantPlaceholderTo(prefix) {
    const container = messagesContainerFor(prefix);
    const msg = document.createElement('div');
    msg.className = 'message assistant';
    msg.innerHTML = `
      <div class="message-header">
        <span class="role-badge assistant">Assistant</span>
        <span class="message-time">${nowLabel()}</span>
      </div>
      <div class="message-body stream-cursor"></div>
    `;
    container.appendChild(msg);
    scrollToBottom(container);
    return msg;
  }

  // Builds (or updates) the live thinking panel inside a streaming message body.
  function ensureLiveThinkingBlock(body, thinkingText) {
    const toks = Math.round(thinkingText.length / 4);
    let liveBlock = body.querySelector('.live-thinking-block');
    if (!liveBlock) {
      liveBlock = document.createElement('div');
      liveBlock.className = 'thinking-block live-thinking-block open';
      liveBlock.innerHTML = `
        <button class="thinking-toggle">💭 Thinking… <span class="thinking-token-count">(~0 tokens)</span><span class="thinking-chevron">▾</span></button>
        <div class="thinking-content"></div>
      `;
      liveBlock.querySelector('.thinking-toggle').addEventListener('click', () => liveBlock.classList.toggle('open'));
      body.insertBefore(liveBlock, body.firstChild);
    }
    liveBlock.querySelector('.thinking-token-count').textContent = `(~${toks} tokens)`;
    const contentEl = liveBlock.querySelector('.thinking-content');
    contentEl.textContent = thinkingText;
    contentEl.scrollTop = contentEl.scrollHeight;
    return liveBlock;
  }

  function renderLiveThinking(prefix, msgEl, fullThinking) {
    const body = msgEl.querySelector('.message-body');
    ensureLiveThinkingBlock(body, fullThinking);
    scrollToBottom(messagesContainerFor(prefix));
  }

  function renderLiveContent(prefix, msgEl, fullContent) {
    const body = msgEl.querySelector('.message-body');
    const hasOpen  = fullContent.includes('<think>');
    const hasClose = fullContent.includes('</think>');

    if (hasOpen && !hasClose) {
      ensureLiveThinkingBlock(body, fullContent.split('<think>')[1] || '');
      scrollToBottom(messagesContainerFor(prefix));
      return;
    }

    const displayText = (hasOpen && hasClose)
      ? fullContent.split('</think>').slice(1).join('</think>').trimStart()
      : fullContent;

    let answerEl = body.querySelector('.live-answer-text');
    if (!answerEl) {
      answerEl = document.createElement('div');
      answerEl.className = 'live-answer-text';
      body.appendChild(answerEl);
    }
    answerEl.textContent = displayText;
    scrollToBottom(messagesContainerFor(prefix));
  }

  function finaliseAssistantTo(prefix, msgEl, fullContent, fullThinking, stats) {
    const container = messagesContainerFor(prefix);
    const body = msgEl.querySelector('.message-body');
    body.classList.remove('stream-cursor');
    body.textContent = '';

    let thinkingText = fullThinking || null;
    let answerText   = fullContent;
    if (!thinkingText && fullContent.includes('<think>')) {
      const parsed = parseThinking(fullContent);
      thinkingText = parsed.thinking;
      answerText   = parsed.content;
    }

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

    const answerEl = document.createElement('div');
    if (answerText && answerText.trim()) {
      try { answerEl.innerHTML = renderMarkdown(answerText); }
      catch { answerEl.textContent = answerText; }
    } else {
      answerEl.style.cssText = 'color:var(--text-dim);font-size:12px;font-style:italic';
      answerEl.textContent = '(No answer — model used all tokens thinking. Increase Max Tokens or use Budget/No Think mode.)';
    }
    body.appendChild(answerEl);

    if (stats) msgEl.appendChild(buildStatsCard(stats));
    scrollToBottom(container);
  }

  function showTypingIndicatorTo(prefix) {
    const container = messagesContainerFor(prefix);
    const el = document.createElement('div');
    el.className = 'message assistant typing-placeholder';
    el.innerHTML = `
      <div class="message-header"><span class="role-badge assistant">Assistant</span></div>
      <div class="typing-indicator"><div class="typing-dots"><span></span><span></span><span></span></div>Loading model…</div>
    `;
    container.appendChild(el);
    scrollToBottom(container);
    return el;
  }

  function renderSideError(prefix, err) {
    const container = messagesContainerFor(prefix);
    if (err.name === 'AbortError') {
      showToast('⏹ Generation stopped');
      return;
    }
    const errEl = document.createElement('div');
    errEl.className = 'message assistant';
    errEl.innerHTML = `
      <div class="message-header"><span class="role-badge assistant">Error</span></div>
      <div class="message-body" style="border-color:var(--red);color:var(--red)">❌ ${escHtml(err.message)}</div>
    `;
    container.appendChild(errEl);
    scrollToBottom(container);
  }

  function updateDiffSendUI(generating) {
    $sendBtn.style.display = generating ? 'none' : 'flex';
    $stopBtn.style.display = generating ? 'flex' : 'none';
    $sendBtn.disabled = generating;
  }

  async function runDiffSide(prefix, model, history, controller, conversationId) {
    const params = getParams(prefix);
    const apiMessages = [];
    if (params.system_prompt) apiMessages.push({ role: 'system', content: params.system_prompt });
    apiMessages.push(...history);

    const typingEl = showTypingIndicatorTo(prefix);
    let msgEl = null;

    const ensureMsgEl = () => {
      if (!msgEl) {
        typingEl.remove();
        msgEl = addAssistantPlaceholderTo(prefix);
      }
    };

    try {
      const { fullContent, fullThinking, stats } = await streamChat(baseUrl, model, apiMessages, params, controller.signal, {
        onThinking: (t) => { ensureMsgEl(); renderLiveThinking(prefix, msgEl, t); },
        onContent:  (c) => { ensureMsgEl(); renderLiveContent(prefix, msgEl, c); },
      }, conversationId);

      ensureMsgEl();
      history.push({ role: 'assistant', content: fullContent });
      finaliseAssistantTo(prefix, msgEl, fullContent, fullThinking, stats);
    } catch (err) {
      typingEl.remove();
      renderSideError(prefix, err);
    }
  }

  async function sendDiffMessage(userText) {
    if (!userText.trim() || diffGenerating) return;

    const modelL = pEl('L', 'model-select').value;
    const modelR = pEl('R', 'model-select').value;
    if (!modelL || !modelR) { showToast('⚠ Select a model on both sides'); return; }

    historyL.push({ role: 'user', content: userText });
    historyR.push({ role: 'user', content: userText });
    addUserMessageTo('L', userText);
    addUserMessageTo('R', userText);

    $userInput.value = '';
    autoResizeTextarea();

    diffGenerating = true;
    updateDiffSendUI(true);

    const controllerL = new AbortController();
    const controllerR = new AbortController();
    diffAbortControllers = [controllerL, controllerR];

    // The shared primitive, fired twice in parallel with independent configs —
    // this is the core mechanic the Diff view and the Eval Harness both build on.
    await Promise.allSettled([
      runDiffSide('L', modelL, historyL, controllerL, conversationIdL),
      runDiffSide('R', modelR, historyR, controllerR, conversationIdR),
    ]);

    diffGenerating = false;
    diffAbortControllers = [];
    updateDiffSendUI(false);
    $userInput.focus();
  }

  function stopDiffGeneration() {
    diffAbortControllers.forEach(c => c.abort());
  }

  function newDiffChat() {
    historyL = [];
    historyR = [];
    conversationIdL = crypto.randomUUID();
    conversationIdR = crypto.randomUUID();
    $messagesL.innerHTML = `
      <div class="welcome" id="welcome-L">
        <div class="welcome-icon">◀</div>
        <h2>Left</h2>
        <p>Pick a model and tune parameters on the left panel, then send a prompt below.</p>
      </div>`;
    $messagesR.innerHTML = `
      <div class="welcome" id="welcome-R">
        <div class="welcome-icon">▶</div>
        <h2>Right</h2>
        <p>Pick a model and tune parameters on the right panel — independent from the left.</p>
      </div>`;
    $userInput.focus();
    showToast('New diff chat started');
  }

  function autoResizeTextarea() {
    $userInput.style.height = 'auto';
    $userInput.style.height = Math.min($userInput.scrollHeight, 160) + 'px';
  }

  $sendBtn.addEventListener('click', () => { if (!diffGenerating) sendDiffMessage($userInput.value.trim()); });
  $stopBtn.addEventListener('click', stopDiffGeneration);
  $userInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!diffGenerating) sendDiffMessage($userInput.value.trim());
    }
  });
  $userInput.addEventListener('input', autoResizeTextarea);

  // ── Diff summary — "what configuration differs at a glance" ──────────────

  function formatSystemPromptPreview(p) {
    if (!p.system_prompt) return '(none)';
    return p.system_prompt.length > 16 ? p.system_prompt.slice(0, 16) + '…' : p.system_prompt;
  }

  function computeDiffRows(prefixA, prefixB) {
    const a = getParams(prefixA);
    const b = getParams(prefixB);
    return [
      { label: 'Model',        a: formatModelName(a.model || '—'), b: formatModelName(b.model || '—'), differs: a.model !== b.model },
      { label: 'Temp',         a: a.temperature.toFixed(2),    b: b.temperature.toFixed(2),    differs: a.temperature !== b.temperature },
      { label: 'Top-P',        a: a.top_p.toFixed(2),          b: b.top_p.toFixed(2),          differs: a.top_p !== b.top_p },
      { label: 'Top-K',        a: String(a.top_k),             b: String(b.top_k),             differs: a.top_k !== b.top_k },
      { label: 'Rep. Penalty', a: a.repeat_penalty.toFixed(2), b: b.repeat_penalty.toFixed(2), differs: a.repeat_penalty !== b.repeat_penalty },
      { label: 'Max Tokens',   a: String(a.max_tokens),        b: String(b.max_tokens),        differs: a.max_tokens !== b.max_tokens },
      { label: 'Context',      a: String(a.num_ctx),           b: String(b.num_ctx),           differs: a.num_ctx !== b.num_ctx },
      { label: 'Thinking',     a: formatThinkValue(a),         b: formatThinkValue(b),         differs: formatThinkValue(a) !== formatThinkValue(b) },
      { label: 'Seed',         a: String(a.seed),              b: String(b.seed),              differs: a.seed !== b.seed },
      { label: 'Sys. Prompt',  a: formatSystemPromptPreview(a),b: formatSystemPromptPreview(b),differs: a.system_prompt !== b.system_prompt },
    ];
  }

  function updateDiffSummary() {
    const pill = document.getElementById('diff-summary-pill');
    const rowsContainer = document.getElementById('diff-rows');
    if (!pill || !rowsContainer) return; // divider not built yet

    const rows = computeDiffRows('L', 'R');
    const differCount = rows.filter(r => r.differs).length;

    if (differCount === 0) {
      pill.textContent = '✓ Identical';
      pill.className = 'diff-summary-pill identical';
    } else {
      pill.textContent = `${differCount} of ${rows.length} differ`;
      pill.className = 'diff-summary-pill differs';
    }

    rowsContainer.innerHTML = rows.map(r => `
      <div class="diff-row ${r.differs ? 'differs' : ''}">
        <div class="diff-key">${escHtml(r.label)}</div>
        <div class="diff-vals">
          <span class="diff-val-l" title="${escHtml(r.a)}">${escHtml(r.a)}</span>
          <span class="diff-sep">/</span>
          <span class="diff-val-r" title="${escHtml(r.b)}">${escHtml(r.b)}</span>
        </div>
      </div>
    `).join('');
  }

  function initDiffDivider() {
    $diffDivider.innerHTML = `
      <div class="diff-divider-title">Config Diff</div>
      <div class="diff-summary-pill" id="diff-summary-pill">—</div>
      <div class="diff-sync-row">
        <button class="diff-sync-btn" id="sync-l-to-r" title="Copy Left config → Right">L → R</button>
        <button class="diff-sync-btn" id="sync-r-to-l" title="Copy Right config → Left">R → L</button>
      </div>
      <button class="btn btn-ghost" id="new-diff-chat-btn">+ New Chat</button>
      <div id="diff-rows" style="margin-top:10px"></div>
    `;
    document.getElementById('sync-l-to-r').addEventListener('click', () => copyPanelConfig('L', 'R'));
    document.getElementById('sync-r-to-l').addEventListener('click', () => copyPanelConfig('R', 'L'));
    document.getElementById('new-diff-chat-btn').addEventListener('click', newDiffChat);
  }

  initDiffDivider();

  return { updateDiffSummary };
}
