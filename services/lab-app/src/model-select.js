// ─────────────────────────────────────────────────────────────────────────────
//  Lab Eval — model sync across all 4 panels (L/R/A/B)
//
//  Extracted verbatim. Mechanical change: loadModels() now calls the shared
//  getTags() (which hits the lab-api backend) instead of fetching Ollama
//  directly. A "models changed" hook (renderInstalledModelsList +
//  updateDiffSummary in the original) is injected via init() instead of
//  being called by name, since those two live in model-catalog.js and
//  diff-view.js respectively.
// ─────────────────────────────────────────────────────────────────────────────

import { getTags } from '../../shared/api-client.js';
import { pEl, updateThinkModeForModel } from './params-panel.js';

// 'A'/'B' are gone — the Eval Harness has one Base Config panel now ('BASE'),
// with per-axis model selection (when model is swept) handled separately by
// axis-panel.js's setAvailableModels(), not through this per-panel dropdown
// mechanism at all.
//
// 'CHAT' added when Lab UI and Lab Eval merged into one app (Lab App): Chat
// is just another panel as far as this module is concerned — it gets a
// model-select-CHAT dropdown synced from the same single fetch as L/R/BASE.
const ALL_PREFIXES = ['CHAT', 'L', 'R', 'BASE'];

// Preferred default select index per panel so a fresh page load compares two
// different models out of the box on the Diff view rather than the same one
// on both sides.
const DEFAULT_MODEL_INDEX = { CHAT: 0, L: 0, R: 1, BASE: 0 };

export function formatModelName(name) {
  return name.length > 30 ? name.slice(0, 28) + '…' : name;
}

export function setStatus($statusDot, $statusLabel, state, label) {
  $statusDot.className   = `status-dot ${state}`;
  $statusLabel.textContent = label;
}

export function initModelSync({ baseUrl, $statusDot, $statusLabel, setStatus, onModelsLoaded }) {
  async function loadModels() {
    // IMPORTANT: only the actual fetch is inside this try/catch. Everything
    // that happens after a successful fetch — populating dropdowns, and
    // onModelsLoaded's downstream work (model catalog, diff summary,
    // axis-panel, ai-eval-panel) — must NOT be able to trigger the
    // "Ollama unreachable" message. A bug three layers away in a callback
    // is a completely different failure mode than "the fetch failed," and
    // conflating them (as an earlier version of this function did) meant a
    // downstream bug could silently wipe out dropdowns that were already
    // correctly populated moments earlier, mislabel it as a connectivity
    // problem, and — because that catch never logged anything — leave the
    // real error invisible even in the console.
    let models;
    try {
      models = await getTags(baseUrl);
    } catch (e) {
      ALL_PREFIXES.forEach(prefix => {
        pEl(prefix, 'model-select').innerHTML = '<option value="">Cannot reach Ollama</option>';
      });
      setStatus('error', 'Ollama unreachable — is it running?');
      console.error('[model-select] Could not reach Ollama via lab-api:', e);
      return [];
    }

    ALL_PREFIXES.forEach(prefix => {
      const select = pEl(prefix, 'model-select');
      const prevValue = select.value;
      select.innerHTML = '';

      if (models.length === 0) {
        select.innerHTML = '<option value="">No models — pull one above</option>';
      } else {
        models.forEach(m => {
          const opt = document.createElement('option');
          opt.value = m.name;
          opt.textContent = formatModelName(m.name);
          select.appendChild(opt);
        });
        if (prevValue && models.some(m => m.name === prevValue)) {
          select.value = prevValue;
        } else {
          const idx = DEFAULT_MODEL_INDEX[prefix] ?? 0;
          select.value = (models[idx] || models[0]).name;
        }
      }
      updateThinkModeForModel(prefix);
    });

    setStatus('connected', `${models.length} model${models.length !== 1 ? 's' : ''} available`);

    // If this throws, it's a real bug and should be loud (visible in the
    // console, not swallowed) — but the connection succeeded and the
    // dropdowns above are already correctly populated, so it does NOT get
    // to undo that or relabel this as an Ollama-connectivity problem.
    onModelsLoaded?.(models);
    return models;
  }

  return { loadModels };
}
