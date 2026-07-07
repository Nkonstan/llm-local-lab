// ─────────────────────────────────────────────────────────────────────────────
//  Lab Eval — past runs list
//
//  New in this version, paralleling Lab UI's conversation history: with the
//  backend persisting every eval run, this lets you reopen an old run (to
//  re-export it or score it with a scorer that didn't exist when it ran)
//  without re-generating anything.
// ─────────────────────────────────────────────────────────────────────────────

import { listEvalRuns, getEvalRun } from '../../../shared/api-client.js';
import { escHtml } from '../../../shared/markdown.js';

export function initEvalHistory({ baseUrl, showToast, onLoadRun }) {
  const $btn     = document.getElementById('eval-history-btn');
  const $overlay = document.getElementById('eval-history-modal-overlay');
  const $list    = document.getElementById('eval-history-list');
  const $close   = document.getElementById('eval-history-close-btn');

  function relativeTime(iso) {
    const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.round(hrs / 24)}d ago`;
  }

  async function refresh() {
    $list.innerHTML = '<div class="modal-empty">Loading…</div>';
    try {
      const runs = await listEvalRuns(baseUrl);
      if (runs.length === 0) {
        $list.innerHTML = '<div class="modal-empty">No saved runs yet.</div>';
        return;
      }
      $list.innerHTML = '';
      for (const run of runs) {
        const axisSummary = run.axes.length
          ? run.axes.map(a => `${a.param} (${a.values.length})`).join(' × ')
          : (run.base_config?.model || 'single config');
        const row = document.createElement('div');
        row.className = 'history-row';
        row.innerHTML = `
          <div class="history-row-main">
            <div class="history-row-title">${escHtml(axisSummary)}</div>
            <div class="history-row-meta">${run.cell_count} cell${run.cell_count !== 1 ? 's' : ''} × ${run.prompt_count} prompt${run.prompt_count !== 1 ? 's' : ''} · ${escHtml(run.status)} · ${relativeTime(run.updated_at)}</div>
          </div>
        `;
        row.addEventListener('click', async () => {
          const full = await getEvalRun(baseUrl, run.id);
          onLoadRun(full);
          closeModal();
        });
        $list.appendChild(row);
      }
    } catch (e) {
      $list.innerHTML = `<div class="modal-empty">Could not load runs: ${escHtml(e.message)}</div>`;
    }
  }

  function openModal() { $overlay.classList.add('open'); refresh(); }
  function closeModal() { $overlay.classList.remove('open'); }

  $btn.addEventListener('click', openModal);
  $close.addEventListener('click', closeModal);
  $overlay.addEventListener('click', e => { if (e.target === $overlay) closeModal(); });
}
