import { escHtml } from './markdown.js';

// ─────────────────────────────────────────────────────────────────────────────
//  Shared response-stats card
//
//  Identical in both original apps except one detail: Lab Eval escaped
//  s.model before interpolating it, Lab UI didn't. Model names come from
//  Ollama's own local /api/tags, so this was never exploitable in practice,
//  but the escaped version is strictly safer with no behavioural difference
//  for normal model names — kept here as the one shared version.
// ─────────────────────────────────────────────────────────────────────────────

export function buildStatsCard(s) {
  const ttftClass = s.ttft < 0.5 ? 'good' : s.ttft < 2 ? '' : 'slow';
  const spdClass  = s.tokensPerSec > 30 ? 'good' : s.tokensPerSec > 10 ? '' : 'slow';

  const card = document.createElement('div');
  card.className = 'stats-card';
  card.innerHTML = `
    <div class="stats-summary">
      <span class="stats-pill"><span class="icon">⏱</span><span class="val">${s.totalTime.toFixed(2)}s</span>&nbsp;total</span>
      <span class="stats-pill"><span class="icon">⚡</span><span class="val">${s.tokensPerSec.toFixed(1)}</span>&nbsp;tok/s</span>
      <span class="stats-pill"><span class="icon">📝</span><span class="val">${s.evalCount}</span>&nbsp;tokens</span>
      <span class="stats-expand-icon">▾</span>
    </div>
    <div class="stats-detail">
      <div class="stat-row"><span class="stat-key">Time to First Token</span><span class="stat-val ${ttftClass}">${s.ttft.toFixed(3)} s</span></div>
      <div class="stat-row"><span class="stat-key">Total Response Time</span><span class="stat-val highlight">${s.totalTime.toFixed(3)} s</span></div>
      <div class="stat-row"><span class="stat-key">Generation Speed</span><span class="stat-val ${spdClass}">${s.tokensPerSec.toFixed(2)} tok/s</span></div>
      <div class="stat-row"><span class="stat-key">Tokens Generated</span><span class="stat-val">${s.evalCount}</span></div>
      <div class="stat-row"><span class="stat-key">Prompt Tokens</span><span class="stat-val">${s.promptEvalCount}</span></div>
      <div class="stat-row"><span class="stat-key">Prompt Eval Time</span><span class="stat-val">${s.promptEvalDuration.toFixed(3)} s</span></div>
      <div class="stat-row"><span class="stat-key">Pure Generation Time</span><span class="stat-val">${s.evalDuration.toFixed(3)} s</span></div>
      ${s.loadDuration > 0.01 ? `<div class="stat-row"><span class="stat-key">Model Load Time</span><span class="stat-val slow">${s.loadDuration.toFixed(3)} s</span></div>` : ''}
      <div class="stat-row"><span class="stat-key">Model</span><span class="stat-val" style="color:var(--text-muted);font-weight:400;font-size:11px">${escHtml(s.model)}</span></div>
    </div>
  `;
  card.querySelector('.stats-summary').addEventListener('click', () => card.classList.toggle('open'));
  return card;
}
