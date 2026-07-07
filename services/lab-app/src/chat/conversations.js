// ─────────────────────────────────────────────────────────────────────────────
//  Lab UI — conversation history
//
//  New in this version: with the backend persisting every chat turn, this
//  panel lists saved conversations and lets you reopen or delete them.
//  There was nothing to extract here — Lab UI had no history feature before
//  since everything lived only in a JS variable.
// ─────────────────────────────────────────────────────────────────────────────

import { listConversations, deleteConversation, getConversation } from '../../../shared/api-client.js';
import { escHtml } from '../../../shared/markdown.js';

export function initHistoryPanel({ baseUrl, $historyBtn, showToast, onLoadConversation }) {
  const $overlay = document.getElementById('history-modal-overlay');
  const $list    = document.getElementById('history-list');
  const $close   = document.getElementById('history-close-btn');

  function relativeTime(iso) {
    const diffMs = Date.now() - new Date(iso).getTime();
    const mins = Math.round(diffMs / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.round(hrs / 24)}d ago`;
  }

  async function refresh() {
    $list.innerHTML = '<div class="modal-empty">Loading…</div>';
    try {
      const items = await listConversations(baseUrl);
      if (items.length === 0) {
        $list.innerHTML = '<div class="modal-empty">No saved conversations yet.</div>';
        return;
      }
      $list.innerHTML = '';
      for (const c of items) {
        const row = document.createElement('div');
        row.className = 'history-row';
        row.innerHTML = `
          <div class="history-row-main">
            <div class="history-row-title">${escHtml(c.title || '(untitled)')}</div>
            <div class="history-row-meta">${escHtml(c.model || '')} · ${relativeTime(c.updated_at)}</div>
          </div>
          <button class="header-btn header-btn-danger history-row-delete" title="Delete">🗑</button>
        `;
        row.querySelector('.history-row-main').addEventListener('click', async () => {
          const full = await getConversation(baseUrl, c.id);
          onLoadConversation(full);
          closeModal();
        });
        row.querySelector('.history-row-delete').addEventListener('click', async (e) => {
          e.stopPropagation();
          await deleteConversation(baseUrl, c.id);
          showToast('Conversation deleted');
          refresh();
        });
        $list.appendChild(row);
      }
    } catch (e) {
      $list.innerHTML = `<div class="modal-empty">Could not load history: ${escHtml(e.message)}</div>`;
    }
  }

  function openModal() {
    $overlay.classList.add('open');
    refresh();
  }
  function closeModal() {
    $overlay.classList.remove('open');
  }

  $historyBtn.addEventListener('click', openModal);
  $close.addEventListener('click', closeModal);
  $overlay.addEventListener('click', e => { if (e.target === $overlay) closeModal(); });

  return { refresh };
}
