import { JSDOM } from 'jsdom';
import fs from 'fs';
import path from 'path';

async function testApp(name, htmlPath) {
  console.log(`\n=== Testing ${name} ===`);
  const html = fs.readFileSync(htmlPath, 'utf8');
  const dir = path.dirname(htmlPath);

  const errors = [];

  const dom = new JSDOM(html, {
    url: `http://localhost/${name}/index.html`,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });

  const { window } = dom;

  // Stub fetch so loadModels()/etc don't hit a real network — resolve with an
  // empty-but-valid Ollama-shaped response, or reject cleanly for anything else.
  window.fetch = async (url, opts) => {
    if (String(url).includes('/api/tags')) {
      return { ok: true, json: async () => ({ models: [] }), status: 200 };
    }
    if (String(url).includes('/api/scorers')) {
      return { ok: true, json: async () => ([]), status: 200 };
    }
    if (String(url).includes('/api/conversations')) {
      return { ok: true, json: async () => ([]), status: 200 };
    }
    if (String(url).includes('/api/eval/runs')) {
      return { ok: true, json: async () => ([]), status: 200 };
    }
    return { ok: false, status: 404, text: async () => 'not found' };
  };

  // jsdom provides window.crypto.randomUUID natively — no stub needed.

  window.onerror = (msg, src, line, col, err) => {
    errors.push(`window.onerror: ${msg} at ${src}:${line}:${col}`);
  };
  window.addEventListener('error', (e) => {
    errors.push(`error event: ${e.error?.stack || e.message}`);
  });
  window.addEventListener('unhandledrejection', (e) => {
    errors.push(`unhandled rejection: ${e.reason?.stack || e.reason}`);
  });

  // Provide the globals Node's ESM loader will want when app.js does
  // `import(...)`, and load each <script type="module"> manually since
  // jsdom's runScripts:'outside-only' does not execute module scripts.
  global.window = window;
  global.document = window.document;
  global.location = window.location;
  global.HTMLElement = window.HTMLElement;
  global.fetch = window.fetch;
  global.URL = window.URL;
  global.Blob = window.Blob;
  global.TextDecoder = window.TextDecoder || (await import('util')).TextDecoder;

  const scriptTags = [...window.document.querySelectorAll('script[type="module"]')];
  for (const tag of scriptTags) {
    const src = tag.getAttribute('src');
    const abs = path.resolve(dir, src);
    try {
      await import(`file://${abs}?t=${Date.now()}`);
    } catch (e) {
      errors.push(`import(${src}) threw: ${e.stack || e.message}`);
    }
  }

  // Give any pending microtasks/async init a moment to run and surface errors.
  await new Promise(r => setTimeout(r, 200));

  if (errors.length === 0) {
    console.log(`✅ ${name}: no errors during load + init`);
  } else {
    console.log(`❌ ${name}: ${errors.length} error(s):`);
    errors.forEach(e => console.log('   -', e));
  }
  return errors.length === 0;
}

const okApp = await testApp('lab-app', path.resolve('lab-app/index.html'));

process.exit(okApp ? 0 : 1);
