// Regression test for a real bug found in production: model-select.js used
// to wrap BOTH the /api/tags fetch AND every downstream callback (axis-panel,
// ai-eval-panel, model-catalog, diff-view) in one try/catch. If anything
// downstream threw — even after a successful fetch had already populated
// the dropdowns correctly — the catch block wiped those same dropdowns back
// to "Cannot reach Ollama" and silently swallowed the real error.
//
// This test forces exactly that: a successful initial load, then a row in
// axis-panel that's been corrupted (simulating some future bug), then a
// SECOND load triggered the way a real user would trigger one — pulling a
// new model, which calls loadModels() again on success. The fix must mean:
//   1. The dropdowns still show the correct (still-connected) model list.
//   2. The status bar still says "available", never "unreachable".
//   3. The real error got logged to console.error instead of vanishing.

import { JSDOM } from 'jsdom';
import fs from 'fs';
import path from 'path';

const dir = path.resolve('lab-app');
const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');

const dom = new JSDOM(html, {
  url: 'http://localhost/lab-app/index.html',
  runScripts: 'outside-only',
  pretendToBeVisual: true,
});
const { window } = dom;

const MODELS_V1 = [{ name: 'gemma2:2b' }, { name: 'qwen2.5:7b' }, { name: 'qwen3:1.7b' }, { name: 'qwen3.5:9b' }];
const MODELS_V2 = [...MODELS_V1, { name: 'new-model:1b' }];
let tagsCallCount = 0;

function fakePullStream() {
  const lines = [JSON.stringify({ status: 'success' })];
  const bytes = new TextEncoder().encode(lines.map(l => l + '\n').join(''));
  let sent = false;
  return { getReader: () => ({ async read() { if (sent) return { done: true }; sent = true; return { done: false, value: bytes }; } }) };
}

window.fetch = async (url, opts) => {
  const u = String(url);
  if (u.includes('/api/tags')) {
    tagsCallCount++;
    const models = tagsCallCount === 1 ? MODELS_V1 : MODELS_V2;
    return { ok: true, json: async () => ({ models }), status: 200 };
  }
  if (u.includes('/api/pull')) return { ok: true, body: fakePullStream(), status: 200 };
  if (u.includes('/api/conversations')) return { ok: true, json: async () => ([]), status: 200 };
  if (u.includes('/api/eval/runs')) return { ok: true, json: async () => ([]), status: 200 };
  if (u.includes('/api/scorers')) return { ok: true, json: async () => ([]), status: 200 };
  return { ok: false, status: 404, text: async () => `unhandled ${u}` };
};

global.window = window;
global.document = window.document;
global.location = window.location;
global.HTMLElement = window.HTMLElement;
global.fetch = window.fetch;
global.URL = window.URL;
global.Blob = window.Blob;

const consoleErrors = [];
const origConsoleError = console.error.bind(console);
console.error = (...args) => { consoleErrors.push(args.map(a => String(a?.stack || a)).join(' ')); origConsoleError(...args); };

const windowErrors = [];
window.addEventListener('error', (e) => windowErrors.push(e.error?.stack || e.message));
window.addEventListener('unhandledrejection', (e) => windowErrors.push(e.reason?.stack || String(e.reason)));

for (const tag of [...window.document.querySelectorAll('script[type="module"]')]) {
  const abs = path.resolve(dir, tag.getAttribute('src'));
  await import(`file://${abs}?t=${Date.now()}`);
}

await new Promise(r => setTimeout(r, 250));

const doc = window.document;
const statusBefore = doc.getElementById('status-label').textContent;
const modelLBefore = doc.getElementById('model-select-L').value;
console.log('Initial load — status:', statusBefore, '| model-select-L:', modelLBefore);

// Corrupt the default axis row's DOM — simulates some future bug leaving a
// row's element in an unexpected shape. This is deliberately artificial;
// what matters is proving the system tolerates *a* downstream throw, not
// reproducing this exact cause.
const firstRow = doc.querySelector('#axis-list .axis-row');
firstRow.querySelector('.axis-values-wrap').remove();

// Trigger a second loadModels() the way a real user would: pull a model
// from the Manage Models modal. model-catalog.js calls loadModels() again
// on a successful pull.
doc.getElementById('manage-models-btn').dispatchEvent(new window.Event('click', { bubbles: true }));
doc.getElementById('modal-custom-input').value = 'new-model:1b';
doc.getElementById('modal-pull-custom').dispatchEvent(new window.Event('click', { bubbles: true }));

await new Promise(r => setTimeout(r, 300));

const statusAfter = doc.getElementById('status-label').textContent;
const modelLAfter = doc.getElementById('model-select-L').value;
console.log('After forced downstream error — status:', statusAfter, '| model-select-L:', modelLAfter);
console.log('tagsCallCount:', tagsCallCount);
console.log('console.error calls:', consoleErrors.length);
consoleErrors.forEach(e => console.log('  -', e.split('\n')[0]));
console.log('window error/unhandledrejection events:', windowErrors.length);

const statusNeverSaysUnreachable = !statusAfter.includes('unreachable') && !statusAfter.toLowerCase().includes('cannot reach');
const dropdownStillValid = MODELS_V2.some(m => m.name === modelLAfter);
const errorWasLogged = consoleErrors.some(e => e.includes('axis-panel'));

const pass =
  tagsCallCount === 2 &&
  statusNeverSaysUnreachable &&
  dropdownStillValid &&
  statusAfter.includes('available') &&
  errorWasLogged;

console.log(pass
  ? '\n✅ PASS — a downstream throw no longer wipes good state or hides the error'
  : '\n❌ FAIL — the old bug (or a regression of the fix) is present');
process.exit(pass ? 0 : 1);
