// ─────────────────────────────────────────────────────────────────────────────
//  Lab Eval — parameter panel (generalized: backs 4 independent panels,
//  L/R for the Diff view, A/B for the Eval Harness)
//
//  Extracted verbatim from the original inline <script>. Mechanical changes
//  only: isGptOss comes from the shared api-client module; showToast and the
//  "panel changed" hook (which needs to call into diff-view.js's
//  updateDiffSummary) are injected via init() instead of being module-level
//  globals, since this file has no reason to import from diff-view.js itself.
// ─────────────────────────────────────────────────────────────────────────────

import { isGptOss } from '../../shared/api-client.js';
import { escHtml } from '../../shared/markdown.js';

export const DEFAULT_PARAMS = {
  temperature:    0.05,
  top_p:          0.9,
  top_k:          40,
  repeat_penalty: 1.1,
  max_tokens:     65536,
  num_ctx:        65536,
  seed:           -1,
  think_mode:     'off',
};

const THINK_HINTS = {
  on:     'Model reasons internally before answering. Slower but smarter.',
  budget: 'Limits thinking to N tokens. Balances speed and quality.',
  off:    'Skips thinking entirely. Fast responses, less deep reasoning.',
};
const THINK_ACTIVE_CLASS = {
  on:     'active-think',
  budget: 'active-budget',
  off:    'active-nothink',
};

let _showToast = () => {};
let _panelChangedHook = () => {};

/** Call once at startup with the app's showToast and an optional hook that
 *  runs whenever any panel's controls change (Lab Eval's Diff view uses this
 *  to keep the live L/R difference summary current). */
export function initParamsModule({ showToast, onPanelChanged }) {
  _showToast = showToast;
  if (onPanelChanged) _panelChangedHook = onPanelChanged;
}

export function buildParamPanelHTML(prefix, label, collapsible) {
  return `
    <div class="param-side-header">
      <span class="side-badge side-badge-${prefix}" title="${escHtml(label)}">${prefix}</span>
      <select class="model-select" id="model-select-${prefix}" title="Model for ${escHtml(label)}">
        <option value="">Loading models…</option>
      </select>
      ${collapsible ? `<button class="collapse-toggle" id="collapse-toggle-${prefix}" title="Collapse panel">◂</button>` : ''}
    </div>

    <div class="params-scroll">
      <div class="section-title">System Prompt</div>
      <textarea class="system-prompt-input" id="system-prompt-${prefix}" rows="2" placeholder="Optional system instruction…"></textarea>

      <div class="section-title" style="margin-top:6px">Generation Parameters</div>

      <div class="param-block">
        <div class="param-row">
          <span class="param-label">Temperature</span>
          <span class="param-value" id="temperature-val-${prefix}">0.05</span>
        </div>
        <input type="range" id="temperature-${prefix}" min="0" max="2" step="0.05" value="0.05">
        <div class="param-hint">Randomness. 0 = deterministic, 2 = very creative.</div>
      </div>

      <div class="param-block">
        <div class="param-row">
          <span class="param-label">Top-P</span>
          <span class="param-value" id="top_p-val-${prefix}">0.90</span>
        </div>
        <input type="range" id="top_p-${prefix}" min="0" max="1" step="0.05" value="0.9">
        <div class="param-hint">Nucleus sampling cutoff.</div>
      </div>

      <div class="param-block">
        <div class="param-row">
          <span class="param-label">Top-K</span>
          <span class="param-value" id="top_k-val-${prefix}">40</span>
        </div>
        <input type="range" id="top_k-${prefix}" min="1" max="100" step="1" value="40">
        <div class="param-hint">Limit sampling to K most probable tokens.</div>
      </div>

      <div class="param-block">
        <div class="param-row">
          <span class="param-label">Repeat Penalty</span>
          <span class="param-value" id="repeat_penalty-val-${prefix}">1.10</span>
        </div>
        <input type="range" id="repeat_penalty-${prefix}" min="1.0" max="2.0" step="0.05" value="1.1">
        <div class="param-hint">Penalises repetition. 1.0 = disabled.</div>
      </div>

      <div class="param-block">
        <div class="param-row"><span class="param-label">Max Tokens</span></div>
        <input type="number" class="param-number" id="max_tokens-${prefix}" min="64" max="131072" step="64" value="65536">
        <div class="param-hint">Maximum tokens to generate.</div>
      </div>

      <div class="param-block">
        <div class="param-row"><span class="param-label">Context Window</span></div>
        <input type="number" class="param-number" id="num_ctx-${prefix}" min="512" max="131072" step="512" value="65536">
        <div class="param-hint">Total tokens: prompt + reply.</div>
      </div>

      <div class="param-block">
        <div class="param-row"><span class="param-label">Thinking Mode</span></div>
        <div class="think-mode-row">
          <button class="think-mode-btn" data-mode="on"     id="think-btn-on-${prefix}">💭 Think</button>
          <button class="think-mode-btn" data-mode="budget" id="think-btn-budget-${prefix}">⏱ Budget</button>
          <button class="think-mode-btn" data-mode="off"    id="think-btn-off-${prefix}">⚡ No Think</button>
        </div>
        <div class="think-budget-row" id="think-budget-row-${prefix}" style="display:none">
          <button class="think-level-btn active" data-level="low">Low</button>
          <button class="think-level-btn" data-level="medium">Med</button>
          <button class="think-level-btn" data-level="high">High</button>
          <button class="think-level-btn" data-level="max">Max</button>
        </div>
        <div class="param-hint" id="think-mode-hint-${prefix}">Skips thinking entirely. Fast responses, less deep reasoning.</div>
      </div>

      <div class="param-block">
        <div class="param-row"><span class="param-label">Seed</span></div>
        <input type="number" class="param-number" id="seed-${prefix}" min="-1" max="2147483647" value="-1">
        <div class="param-hint">-1 = random. Fixed = reproducible.</div>
      </div>
    </div>

    <div class="panel-actions">
      <button class="btn btn-ghost reset-panel-btn" id="reset-btn-${prefix}">↺ Reset ${escHtml(label)}</button>
    </div>
  `;
}

// Used by both the Diff view's config-diff summary and the Eval Harness's
// per-run config summary — a single home for it instead of two copies.
export function formatThinkValue(p) {
  if (p.think_mode === 'off') return 'Off';
  if (p.think_mode === 'on') return 'On';
  return `Budget · ${p.think_level}`;
}

// ── Element lookup helpers ─────────────────────────────────────────────────

export function panelRoot(prefix) {
  return document.getElementById(`param-panel-${prefix}`);
}

export function pEl(prefix, id) {
  return document.getElementById(`${id}-${prefix}`);
}

// ── Reading / writing parameters for a given panel ─────────────────────────

export function getParams(prefix) {
  const root = panelRoot(prefix);
  const activeBtn = root.querySelector(
    '.think-mode-btn.active-think, .think-mode-btn.active-budget, .think-mode-btn.active-nothink'
  );
  const think_mode = activeBtn ? activeBtn.dataset.mode : 'off';
  const activeLevelBtn = root.querySelector('.think-level-btn.active');

  return {
    model:          pEl(prefix, 'model-select').value,
    system_prompt:  pEl(prefix, 'system-prompt').value.trim(),
    temperature:    parseFloat(pEl(prefix, 'temperature').value),
    top_p:          parseFloat(pEl(prefix, 'top_p').value),
    top_k:          parseInt(pEl(prefix, 'top_k').value, 10),
    repeat_penalty: parseFloat(pEl(prefix, 'repeat_penalty').value),
    max_tokens:     parseInt(pEl(prefix, 'max_tokens').value, 10),
    num_ctx:        parseInt(pEl(prefix, 'num_ctx').value, 10),
    seed:           parseInt(pEl(prefix, 'seed').value, 10),
    think_mode,
    think_level:    activeLevelBtn ? activeLevelBtn.dataset.level : 'low',
  };
}

export function resetParams(prefix) {
  pEl(prefix, 'temperature').value    = DEFAULT_PARAMS.temperature;
  pEl(prefix, 'top_p').value          = DEFAULT_PARAMS.top_p;
  pEl(prefix, 'top_k').value          = DEFAULT_PARAMS.top_k;
  pEl(prefix, 'repeat_penalty').value = DEFAULT_PARAMS.repeat_penalty;
  pEl(prefix, 'max_tokens').value     = DEFAULT_PARAMS.max_tokens;
  pEl(prefix, 'num_ctx').value        = DEFAULT_PARAMS.num_ctx;
  pEl(prefix, 'seed').value           = DEFAULT_PARAMS.seed;
  pEl(prefix, 'system-prompt').value  = '';

  setThinkMode(prefix, DEFAULT_PARAMS.think_mode);
  panelRoot(prefix).querySelectorAll('.think-level-btn').forEach(b => b.classList.remove('active'));
  panelRoot(prefix).querySelector('.think-level-btn[data-level="low"]').classList.add('active');

  updateParamDisplays(prefix);
  onPanelChanged(prefix);
  _showToast(`Parameters reset — ${prefix}`);
}

export function updateParamDisplays(prefix) {
  const map = [
    ['temperature',     2],
    ['top_p',           2],
    ['top_k',           0],
    ['repeat_penalty',  2],
  ];
  for (const [id, dec] of map) {
    const input = pEl(prefix, id);
    const out   = pEl(prefix, `${id}-val`);
    if (input && out) out.textContent = parseFloat(input.value).toFixed(dec);
  }
}

export function setThinkMode(prefix, mode) {
  const root = panelRoot(prefix);
  root.querySelectorAll('.think-mode-btn').forEach(btn => {
    btn.classList.remove('active-think', 'active-budget', 'active-nothink');
    if (btn.dataset.mode === mode) btn.classList.add(THINK_ACTIVE_CLASS[mode]);
  });
  const budgetRow = pEl(prefix, 'think-budget-row');
  budgetRow.style.display = mode === 'budget' ? 'flex' : 'none';
  pEl(prefix, 'think-mode-hint').textContent = THINK_HINTS[mode];
  if (mode === 'budget') updateThinkModeForModel(prefix);
}

// Reflects whether the selected model actually supports string budget levels
// (gpt-oss only) in the Budget row's appearance and hint text.
export function updateThinkModeForModel(prefix) {
  const model = pEl(prefix, 'model-select').value;
  const gptOss = isGptOss(model);
  const budgetRow = pEl(prefix, 'think-budget-row');
  const hint = pEl(prefix, 'think-mode-hint');
  const activeBtn = panelRoot(prefix).querySelector(
    '.think-mode-btn.active-think, .think-mode-btn.active-budget, .think-mode-btn.active-nothink'
  );
  const activeMode = activeBtn ? activeBtn.dataset.mode : null;

  if (budgetRow.style.display !== 'none' && activeMode === 'budget') {
    if (gptOss) {
      budgetRow.style.opacity = '1';
      budgetRow.style.pointerEvents = 'auto';
      hint.textContent = 'Limits thinking to N tokens. Balances speed and quality.';
    } else {
      budgetRow.style.opacity = '0.35';
      budgetRow.style.pointerEvents = 'none';
      hint.textContent = 'Budget levels (Low/Med/High/Max) are only supported by GPT-OSS. Other models use full thinking.';
    }
  }
}

// Copies every control's value from one panel to another (used by the "sync"
// buttons in the diff divider so both sides can start from an identical config).
export function copyPanelConfig(fromPrefix, toPrefix) {
  pEl(toPrefix, 'model-select').value    = pEl(fromPrefix, 'model-select').value;
  pEl(toPrefix, 'system-prompt').value   = pEl(fromPrefix, 'system-prompt').value;
  pEl(toPrefix, 'temperature').value     = pEl(fromPrefix, 'temperature').value;
  pEl(toPrefix, 'top_p').value           = pEl(fromPrefix, 'top_p').value;
  pEl(toPrefix, 'top_k').value           = pEl(fromPrefix, 'top_k').value;
  pEl(toPrefix, 'repeat_penalty').value  = pEl(fromPrefix, 'repeat_penalty').value;
  pEl(toPrefix, 'max_tokens').value      = pEl(fromPrefix, 'max_tokens').value;
  pEl(toPrefix, 'num_ctx').value         = pEl(fromPrefix, 'num_ctx').value;
  pEl(toPrefix, 'seed').value            = pEl(fromPrefix, 'seed').value;

  const fromActiveBtn = panelRoot(fromPrefix).querySelector(
    '.think-mode-btn.active-think, .think-mode-btn.active-budget, .think-mode-btn.active-nothink'
  );
  setThinkMode(toPrefix, fromActiveBtn ? fromActiveBtn.dataset.mode : 'off');

  const fromLevelBtn = panelRoot(fromPrefix).querySelector('.think-level-btn.active');
  const level = fromLevelBtn ? fromLevelBtn.dataset.level : 'low';
  panelRoot(toPrefix).querySelectorAll('.think-level-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.level === level)
  );

  updateParamDisplays(toPrefix);
  updateThinkModeForModel(toPrefix);
  onPanelChanged(toPrefix);
  _showToast(`Copied ${fromPrefix} → ${toPrefix}`);
}

// Called after any control in a panel changes. Diff-view panels (L/R) refresh
// the live diff summary; Eval panels (A/B) don't need a live summary.
function onPanelChanged(prefix) {
  _panelChangedHook(prefix);
}

// ── Wiring: attaches all listeners for one freshly-built panel ─────────────

export function wirePanel(prefix, collapsible) {
  const root = panelRoot(prefix);

  ['temperature', 'top_p', 'top_k', 'repeat_penalty'].forEach(id => {
    pEl(prefix, id).addEventListener('input', () => {
      updateParamDisplays(prefix);
      onPanelChanged(prefix);
    });
  });

  ['max_tokens', 'num_ctx', 'seed'].forEach(id => {
    pEl(prefix, id).addEventListener('input', () => onPanelChanged(prefix));
  });

  pEl(prefix, 'system-prompt').addEventListener('input', () => onPanelChanged(prefix));

  root.querySelectorAll('.think-mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      setThinkMode(prefix, btn.dataset.mode);
      onPanelChanged(prefix);
    });
  });

  root.querySelectorAll('.think-level-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      root.querySelectorAll('.think-level-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      onPanelChanged(prefix);
    });
  });

  pEl(prefix, 'model-select').addEventListener('change', () => {
    updateThinkModeForModel(prefix);
    onPanelChanged(prefix);
  });

  document.getElementById(`reset-btn-${prefix}`).addEventListener('click', () => resetParams(prefix));

  if (collapsible) {
    const toggle = document.getElementById(`collapse-toggle-${prefix}`);
    toggle.addEventListener('click', () => {
      root.classList.toggle('collapsed');
      toggle.textContent = root.classList.contains('collapsed') ? '▸' : '◂';
    });
  }

  setThinkMode(prefix, DEFAULT_PARAMS.think_mode);
  updateParamDisplays(prefix);
}
