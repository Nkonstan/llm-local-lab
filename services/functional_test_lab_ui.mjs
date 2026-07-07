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

// Build a fake NDJSON streaming body for /api/chat, matching Ollama's shape:
// a couple of content chunks, then a final "done" chunk with stats.
function fakeChatStream() {
  const lines = [
    JSON.stringify({ model: 'qwen3:2b', message: { role: 'assistant', content: 'Hello' } }),
    JSON.stringify({ model: 'qwen3:2b', message: { role: 'assistant', content: ' there!' } }),
    JSON.stringify({
      model: 'qwen3:2b', done: true,
      total_duration: 500_000_000, load_duration: 0,
      prompt_eval_count: 5, prompt_eval_duration: 100_000_000,
      eval_count: 3, eval_duration: 300_000_000,
    }),
  ];
  const body = lines.map(l => l + '\n').join('');
  const bytes = new TextEncoder().encode(body);
  let sent = false;
  return {
    getReader() {
      return {
        async read() {
          if (sent) return { done: true, value: undefined };
          sent = true;
          return { done: false, value: bytes };
        },
      };
    },
  };
}

window.fetch = async (url, opts) => {
  const u = String(url);
  if (u.includes('/api/tags')) {
    return { ok: true, json: async () => ({ models: [{ name: 'qwen3:2b' }] }), status: 200 };
  }
  if (u.includes('/api/chat')) {
    return { ok: true, body: fakeChatStream(), status: 200 };
  }
  if (u.includes('/api/conversations')) {
    return { ok: true, json: async () => ([]), status: 200 };
  }
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

// Let init (loadModels, etc.) settle.
await new Promise(r => setTimeout(r, 200));

const doc = window.document;
const modelSelect = doc.getElementById('model-select-CHAT');
console.log('Models loaded into dropdown:', [...modelSelect.options].map(o => o.value));

const userInput = doc.getElementById('user-input-chat');
const sendBtn = doc.getElementById('send-btn-chat');

userInput.value = 'Say hi';
sendBtn.dispatchEvent(new window.Event('click', { bubbles: true }));

// Wait for the fake stream to be consumed and the message finalised.
await new Promise(r => setTimeout(r, 300));

const messages = [...doc.querySelectorAll('#messages-chat .message')];
console.log(`Rendered message elements: ${messages.length}`);
messages.forEach((m, i) => {
  const role = m.querySelector('.role-badge')?.textContent;
  const bodyText = m.querySelector('.message-body')?.textContent.trim();
  console.log(`  [${i}] ${role}: "${bodyText}"`);
});

// Regression check: the STATIC welcome screen (index.html's #welcome-chat,
// present before any message is ever sent) must actually disappear once the
// first message arrives — it used to only match a different id
// (#welcome), so removeWelcome() silently no-op'd on this exact scenario.
const welcomeGoneAfterFirstMessage = doc.querySelector('#messages-chat .welcome') == null;
console.log('Welcome screen gone after first message:', welcomeGoneAfterFirstMessage);

const statsCard = doc.querySelector('.stats-card');
console.log('Stats card rendered:', !!statsCard);
if (statsCard) {
  console.log('  tok/s pill text:', statsCard.querySelector('.stats-pill .val')?.textContent);
}

const assistantText = messages.find(m => m.querySelector('.role-badge')?.textContent === 'Assistant')
  ?.querySelector('.message-body')?.textContent.trim();

// ── Enter-to-send / Shift+Enter-does-not-send ─────────────────────────────

const messageCountBeforeKeyTests = doc.querySelectorAll('#messages-chat .message').length;

userInput.value = 'Shift enter should not send this';
userInput.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true }));
await new Promise(r => setTimeout(r, 50));
const messageCountAfterShiftEnter = doc.querySelectorAll('#messages-chat .message').length;
console.log('Message count after Shift+Enter (should be unchanged):', messageCountAfterShiftEnter);

userInput.value = 'Plain enter should send this';
userInput.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', shiftKey: false, bubbles: true, cancelable: true }));
await new Promise(r => setTimeout(r, 300));
const messageCountAfterPlainEnter = doc.querySelectorAll('#messages-chat .message').length;
console.log('Message count after plain Enter (should be +2, user+assistant):', messageCountAfterPlainEnter);
console.log('DEBUG all messages:', [...doc.querySelectorAll('#messages-chat .message')].map(m => ({
  id: m.id, cls: m.className,
  role: m.querySelector('.role-badge')?.textContent,
  text: m.querySelector('.message-body')?.textContent?.trim(),
})));

const shiftEnterDidNotSend = messageCountAfterShiftEnter === messageCountBeforeKeyTests;
const plainEnterDidSend = messageCountAfterPlainEnter === messageCountBeforeKeyTests + 2;

const pass =
  errors.length === 0 &&
  messages.length === 2 &&
  assistantText === 'Hello there!' &&
  !!statsCard &&
  welcomeGoneAfterFirstMessage &&
  shiftEnterDidNotSend &&
  plainEnterDidSend;

console.log('\nErrors during interaction:', errors.length);
errors.forEach(e => console.log('  -', e));
console.log('Shift+Enter did not send:', shiftEnterDidNotSend, '| Plain Enter did send:', plainEnterDidSend);

console.log(pass ? '\n✅ PASS — end-to-end send/stream/render worked' : '\n❌ FAIL');
process.exit(pass ? 0 : 1);
