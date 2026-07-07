// ─────────────────────────────────────────────────────────────────────────────
//  Lab App — entry point
//
//  Replaces Lab UI (:3001) + Lab Eval (:3002) as two separate Docker
//  containers/ports with one app, one port, three tabs — Chat / A/B Diff /
//  Eval Harness — using the exact same button-toggle pattern Lab Eval
//  already used internally between its Diff and Eval views. Nothing about
//  how any of the three tools WORKS changed in this merge; what changed is
//  which document they live in and how their shared pieces (model sync,
//  model management, parameter panels) are wired together once instead of
//  twice.
//
//  Model dropdowns: one initModelSync() call now drives four panels instead
//  of three (CHAT/L/R/BASE) — see model-select.js.
//  Model management: one merged "Manage Models" modal replaces Lab UI's
//  "Browse & Pull Models" and Lab Eval's simpler pull/delete modal — see
//  model-catalog.js. The header no longer has separate "Pull Model" /
//  "Delete Model" buttons; that's all through Manage Models now.
//  Params: Chat's panel is built by the same buildParamPanelHTML/wirePanel
//  generator that already backed L/R/BASE — see params-panel.js.
// ─────────────────────────────────────────────────────────────────────────────

import { createToast } from '../../shared/toast.js';
import {
  initParamsModule, buildParamPanelHTML, wirePanel, panelRoot, pEl,
} from './params-panel.js';
import { setStatus, initModelSync } from './model-select.js';
import { initModelCatalog } from './model-catalog.js';
import { initChatView } from './chat/chat-view.js';
import { initHistoryPanel } from './chat/conversations.js';
import { initDiffView } from './diff/diff-view.js';
import { initAxisPanel } from './eval/axis-panel.js';
import { initGridView } from './eval/grid-view.js';
import { initAiEvalGrid } from './eval/ai-eval-grid.js';
import { initEvalHarness } from './eval/eval-harness.js';
import { initAiEvalPanel } from './eval/ai-eval-panel.js';
import { initEvalHistory } from './eval/eval-history.js';

const LAB_API_BASE = window.LAB_API_BASE || `http://${location.hostname}:8000`;

// ── Header-level DOM refs (shared by every view) ────────────────────────────
const $statusDot   = document.getElementById('status-dot');
const $statusLabel = document.getElementById('status-label');
const $toast        = document.getElementById('toast');
const $historyBtn   = document.getElementById('history-btn');

const showToast = createToast($toast);

// ── Params: build Chat's panel alongside Diff's L/R (BASE is built inside
//    initAxisPanel() itself, same as before this merge). ────────────────────
let diffView;
initParamsModule({
  showToast,
  onPanelChanged: (prefix) => { if (prefix === 'L' || prefix === 'R') diffView?.updateDiffSummary(); },
});

panelRoot('CHAT').innerHTML = buildParamPanelHTML('CHAT', 'Chat', false);
panelRoot('L').innerHTML    = buildParamPanelHTML('L', 'Left', true);
panelRoot('R').innerHTML    = buildParamPanelHTML('R', 'Right', true);

wirePanel('CHAT', false);
wirePanel('L', true);
wirePanel('R', true);

// Chat gets one action the generalized panel doesn't build for anyone else:
// "New Chat". Diff's equivalent lives in the diff-divider (resets both L and
// R together); Eval has no per-run "start over" concept. Rather than teach
// buildParamPanelHTML a chat-only button, it's appended here, once, right
// next to the Reset button the generator already gives every panel.
const $newChatBtn = document.createElement('button');
$newChatBtn.className = 'btn btn-primary';
$newChatBtn.id = 'new-chat-btn';
$newChatBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 5v14M5 12h14"/></svg> New Chat';
panelRoot('CHAT').querySelector('.panel-actions').prepend($newChatBtn);

// ── Chat view ────────────────────────────────────────────────────────────
const chatView = initChatView({
  baseUrl: LAB_API_BASE,
  $modelSelect:  pEl('CHAT', 'model-select'),
  $messagesEl:   document.getElementById('messages-chat'),
  $userInput:    document.getElementById('user-input-chat'),
  $sendBtn:      document.getElementById('send-btn-chat'),
  $stopBtn:      document.getElementById('stop-btn-chat'),
  $systemPrompt: pEl('CHAT', 'system-prompt'),
  $welcome:      document.getElementById('welcome-chat'),
  showToast,
});
$newChatBtn.addEventListener('click', chatView.newChat);

initHistoryPanel({
  baseUrl: LAB_API_BASE, $historyBtn, showToast,
  onLoadConversation: (conv) => chatView.loadIntoView(conv),
});

// ── A/B Diff view ────────────────────────────────────────────────────────
diffView = initDiffView({
  baseUrl: LAB_API_BASE,
  $messagesL:    document.getElementById('messages-L'),
  $messagesR:    document.getElementById('messages-R'),
  $sendBtn:      document.getElementById('send-btn-diff'),
  $stopBtn:      document.getElementById('stop-btn-diff'),
  $userInput:    document.getElementById('user-input-diff'),
  $diffDivider:  document.getElementById('diff-divider'),
  showToast,
});

// ── Eval Harness ─────────────────────────────────────────────────────────
const axisPanel = initAxisPanel({ showToast });
// aiEvalGrid is referenced inside this callback but assigned further below
// (initAiEvalGrid needs gridView to exist first) — fine, since the callback
// only ever RUNS later, on a user picker interaction, by which point the
// module-level `aiEvalGrid` binding below has already been assigned.
const gridView   = initGridView({ onAxisChange: () => aiEvalGrid.refresh() });
const aiEvalGrid = initAiEvalGrid({ gridView });

// ── Model sync — one fetch drives all four panels (CHAT/L/R/BASE) ───────
const { loadModels } = initModelSync({
  baseUrl: LAB_API_BASE, $statusDot, $statusLabel,
  setStatus: (state, label) => setStatus($statusDot, $statusLabel, state, label),
  onModelsLoaded: (models) => {
    modelCatalog.renderInstalledModelsList(models);
    diffView.updateDiffSummary();
    axisPanel.setAvailableModels(models);
    aiEvalPanel.setAvailableModels(models);
  },
});

const modelCatalog = initModelCatalog({ baseUrl: LAB_API_BASE, showToast, loadModels });

const evalHarness = initEvalHarness({
  baseUrl: LAB_API_BASE, showToast, axisPanel, gridView, aiEvalGrid,
  onRunFinished: () => {},
});

const aiEvalPanel = initAiEvalPanel({
  baseUrl: LAB_API_BASE, showToast,
  getLastRunId: evalHarness.getLastRunId,
  onScored: (judgments) => evalHarness.applyJudgments(judgments),
});

initEvalHistory({
  baseUrl: LAB_API_BASE, showToast,
  onLoadRun: (run) => evalHarness.loadRun(run),
});

// ── View tabs — Chat ⇄ A/B Diff ⇄ Eval Harness ──────────────────────────────
document.getElementById('main-tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.main-tab');
  if (!btn) return;
  const view = btn.dataset.view;
  document.querySelectorAll('.main-tab').forEach(b => b.classList.toggle('active', b === btn));
  document.getElementById('view-chat').classList.toggle('hidden', view !== 'chat');
  document.getElementById('view-diff').classList.toggle('hidden', view !== 'diff');
  document.getElementById('view-eval').classList.toggle('hidden', view !== 'eval');
});

// ── Init ─────────────────────────────────────────────────────────────────────

(async () => {
  evalHarness.refreshDatasetCount();

  setStatus($statusDot, $statusLabel, '', 'Connecting…');
  try {
    await loadModels();
  } catch (e) {
    // loadModels() itself only throws for a downstream bug (see
    // model-select.js) — a real "can't reach Ollama" is handled inside it
    // and never gets here. Log loudly rather than let this silently skip
    // setting up the periodic refresh below.
    console.error('[app] loadModels() threw on initial load:', e);
  }
  diffView.updateDiffSummary();

  // Refresh model list periodically in case a model is pulled via CLI.
  setInterval(loadModels, 30_000);

  document.getElementById('user-input-chat').focus();
})();
