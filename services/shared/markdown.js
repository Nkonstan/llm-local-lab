// ─────────────────────────────────────────────────────────────────────────────
//  Shared markdown / escaping / <think> parsing
//
//  Extracted verbatim from the original apps' inline scripts. Lab UI and Lab
//  Eval had byte-identical copies of renderMarkdown/parseThinking, and near-
//  identical escHtml (Lab Eval's wrapped the input in String(); that's the
//  version kept here since it's strictly safer and behaves identically for
//  the string inputs both apps always pass it).
// ─────────────────────────────────────────────────────────────────────────────

export function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function renderMarkdown(raw) {
  let text = raw;

  // Fenced code blocks
  text = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) =>
    `<pre><code class="lang-${lang || 'text'}">${escHtml(code.trimEnd())}</code></pre>`
  );

  // Inline code
  text = text.replace(/`([^`\n]+)`/g, (_, c) => `<code>${escHtml(c)}</code>`);

  // Bold / italic
  text = text.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  text = text.replace(/\*\*(.+?)\*\*/g,  '<strong>$1</strong>');
  text = text.replace(/\*(.+?)\*/g,       '<em>$1</em>');

  // Headings
  text = text.replace(/^### (.+)$/gm,  '<h3>$1</h3>');
  text = text.replace(/^## (.+)$/gm,   '<h2>$1</h2>');
  text = text.replace(/^# (.+)$/gm,    '<h1>$1</h1>');

  // Horizontal rule
  text = text.replace(/^---+$/gm, '<hr>');

  // Blockquotes
  text = text.replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>');

  // Unordered lists
  text = text.replace(/((?:^[ \t]*[-*+] .+\n?)+)/gm, block => {
    const items = block.trim().split('\n').map(l =>
      `<li>${l.replace(/^[ \t]*[-*+] /, '')}</li>`
    ).join('');
    return `<ul>${items}</ul>`;
  });

  // Ordered lists
  text = text.replace(/((?:^[ \t]*\d+\. .+\n?)+)/gm, block => {
    const items = block.trim().split('\n').map(l =>
      `<li>${l.replace(/^[ \t]*\d+\. /, '')}</li>`
    ).join('');
    return `<ol>${items}</ol>`;
  });

  // Paragraphs (split on double newlines, skip block elements)
  const blockTags = /^<(pre|ul|ol|h[1-6]|hr|blockquote)/;
  text = text.split(/\n{2,}/).map(chunk => {
    chunk = chunk.trim();
    if (!chunk) return '';
    if (blockTags.test(chunk)) return chunk;
    return `<p>${chunk.replace(/\n/g, '<br>')}</p>`;
  }).join('\n');

  return text;
}

// Parse <think>…</think> blocks (Qwen3 etc.)
export function parseThinking(raw) {
  const thinkMatch = raw.match(/^<think>([\s\S]*?)<\/think>\s*/);
  if (thinkMatch) {
    return {
      thinking: thinkMatch[1].trim(),
      content:  raw.slice(thinkMatch[0].length),
    };
  }
  return { thinking: null, content: raw };
}
