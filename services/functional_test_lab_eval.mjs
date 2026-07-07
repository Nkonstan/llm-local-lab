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

function fakeStream(text, model) {
  const lines = [
    JSON.stringify({ model, message: { role: 'assistant', content: text } }),
    JSON.stringify({
      model, done: true,
      total_duration: 400_000_000, load_duration: 0,
      prompt_eval_count: 4, prompt_eval_duration: 50_000_000,
      eval_count: 2, eval_duration: 200_000_000,
    }),
  ];
  const body = lines.map(l => l + '\n').join('');
  const bytes = new TextEncoder().encode(body);
  let sent = false;
  return { getReader: () => ({ async read() { if (sent) return { done: true }; sent = true; return { done: false, value: bytes }; } }) };
}

window.fetch = async (url, opts) => {
  const u = String(url);
  if (u.includes('/api/tags')) {
    return { ok: true, json: async () => ({ models: [{ name: 'model-a' }, { name: 'model-b' }] }), status: 200 };
  }
  if (u.includes('/api/chat')) {
    const body = JSON.parse(opts.body);
    const reply = body.model === 'model-a' ? 'Response from A' : 'Response from B';
    return { ok: true, body: fakeStream(reply, body.model), status: 200 };
  }
  if (u.includes('/api/scorers')) return { ok: true, json: async () => ([]), status: 200 };
  if (u.includes('/api/conversations')) return { ok: true, json: async () => ([]), status: 200 };
  if (u.includes('/api/eval/runs')) return { ok: true, json: async () => ([]), status: 200 };
  return { ok: false, status: 404, text: async () => 'not found' };
};

const errors = [];
window.addEventListener('error', (e) => errors.push(e.error?.stack || e.message));
window.addEventListener('unhandledrejection', (e) => errors.push(e.reason?.stack || String(e.reason)));

global.window = window;
global.document = window.document;
global.location = window.location;
global.HTMLElement = window.HTMLElement;
global.fetch = window.fetch;
global.URL = window.URL;
global.Blob = window.Blob;

for (const tag of [...window.document.querySelectorAll('script[type="module"]')]) {
  const abs = path.resolve(dir, tag.getAttribute('src'));
  await import(`file://${abs}?t=${Date.now()}`);
}

await new Promise(r => setTimeout(r, 200));

const doc = window.document;
const selL = doc.getElementById('model-select-L');
const selR = doc.getElementById('model-select-R');
console.log('Left options:', [...selL.options].map(o => o.value));
console.log('Right options:', [...selR.options].map(o => o.value));
// Defaults per DEFAULT_MODEL_INDEX: L=index0, R=index1 -> model-a / model-b
console.log('Left selected:', selL.value, '| Right selected:', selR.value);

const userInput = doc.getElementById('user-input-diff');
const sendBtn = doc.getElementById('send-btn-diff');
userInput.value = 'Compare yourselves';
sendBtn.dispatchEvent(new window.Event('click', { bubbles: true }));

await new Promise(r => setTimeout(r, 300));

const leftText  = doc.querySelector('#messages-L .message.assistant .message-body')?.textContent.trim();
const rightText = doc.querySelector('#messages-R .message.assistant .message-body')?.textContent.trim();
console.log('Left response:', JSON.stringify(leftText));
console.log('Right response:', JSON.stringify(rightText));

const leftStats  = !!doc.querySelector('#messages-L .stats-card');
const rightStats = !!doc.querySelector('#messages-R .stats-card');
console.log('Left stats card:', leftStats, '| Right stats card:', rightStats);

const diffPill = doc.getElementById('diff-summary-pill');
console.log('Diff summary pill:', diffPill?.textContent);

const pass =
  errors.length === 0 &&
  leftText === 'Response from A' &&
  rightText === 'Response from B' &&
  leftStats && rightStats &&
  diffPill && diffPill.textContent.includes('differ'); // model differs between L/R by default

console.log('\nErrors during interaction:', errors.length);
errors.forEach(e => console.log('  -', e));

console.log(pass ? '\n✅ PASS — parallel A/B diff send/stream/render worked' : '\n❌ FAIL');
process.exit(pass ? 0 : 1);
