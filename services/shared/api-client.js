import { parseThinking } from './markdown.js';

// ─────────────────────────────────────────────────────────────────────────────
//  Shared API client
//
//  Every network call from both apps used to go straight to Ollama
//  (`http://localhost:11434`). It now goes to the lab-api backend instead,
//  which proxies to Ollama server-side and persists what needs persisting.
//  This is the one file that knows the wire format — swapping the target
//  (or adding auth, retries, etc. later) touches only this module.
//
//  The streaming-consumption logic (read the NDJSON stream, split thinking
//  from content, compute stats) is unchanged from the original streamChat()
//  in Lab Eval — Lab UI had an inline duplicate of the same logic; this is
//  now the single shared version both apps call.
// ─────────────────────────────────────────────────────────────────────────────

// Returns true when `modelName` is gpt-oss — the only model family that accepts
// string budget levels ("low" | "medium" | "high") for the `think` parameter.
// All other models only support think: true | false per official Ollama docs.
export function isGptOss(modelName) {
  return (modelName || '').toLowerCase().startsWith('gpt-oss');
}

// Most models: think: true (full thinking) or think: false (no thinking).
// GPT-OSS only: think: "low" | "medium" | "high" (string budget levels).
// Sending a string level to non-GPT-OSS models is undocumented and causes
// uncontrolled full thinking — so Budget mode maps to true for those models.
export function resolveThinkValue(model, params) {
  if (params.think_mode === 'off') return false;
  if (params.think_mode === 'budget') return isGptOss(model) ? params.think_level : true;
  return true;
}

function buildOptions(params) {
  return {
    temperature:    params.temperature,
    top_p:          params.top_p,
    top_k:          params.top_k,
    repeat_penalty: params.repeat_penalty,
    num_predict:    params.max_tokens,
    num_ctx:        params.num_ctx,
    ...(params.seed !== -1 ? { seed: params.seed } : {}),
  };
}

// Shared low-level streamer: POSTs `body` to `url`, reads the NDJSON stream,
// and reports progress through `handlers`. Used by both streamChat() (persisted
// conversations) and streamEvalGenerate() (one-off eval-harness prompts).
async function consumeChatStream(url, body, signal, handlers = {}) {
  const startTime = performance.now();
  let firstTokenTime = null;
  let fullContent  = '';
  let fullThinking = '';
  let finalChunk   = null;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    throw new Error(`lab-api returned ${res.status}: ${await res.text()}`);
  }

  const reader  = res.body.getReader();
  const decoder = new TextDecoder();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const lines = decoder.decode(value, { stream: true }).split('\n').filter(Boolean);

    for (const line of lines) {
      let chunk;
      try { chunk = JSON.parse(line); } catch { continue; }

      if (firstTokenTime === null && (chunk.message?.content || chunk.message?.thinking)) {
        firstTokenTime = performance.now();
      }

      // Native thinking field (Qwen3, DeepSeek R1, gpt-oss via Ollama 0.24+)
      if (chunk.message?.thinking) {
        fullThinking += chunk.message.thinking;
        handlers.onThinking?.(fullThinking);
      }

      if (chunk.message?.content) {
        fullContent += chunk.message.content;
        handlers.onContent?.(fullContent);
      }

      if (chunk.done) finalChunk = chunk;
    }
  }

  // Fallback for models that emit thinking inline as <think>…</think> inside
  // message.content instead of the native message.thinking field.
  if (!fullThinking && fullContent.includes('<think>')) {
    const parsed = parseThinking(fullContent);
    if (parsed.thinking) {
      fullThinking = parsed.thinking;
      fullContent  = parsed.content;
    }
  }

  let stats = null;
  if (finalChunk) {
    const ns = 1e9;
    const ms = 1000;
    const ttft = firstTokenTime != null
      ? (firstTokenTime - startTime) / ms
      : (finalChunk.prompt_eval_duration || 0) / ns;
    const evalCount    = finalChunk.eval_count || 0;
    const evalDuration = (finalChunk.eval_duration || 0) / ns;
    const tokensPerSec = evalCount > 0 && evalDuration > 0 ? evalCount / evalDuration : 0;

    stats = {
      model:              finalChunk.model || body.model,
      ttft,
      totalTime:          (finalChunk.total_duration || 0) / ns,
      loadDuration:       (finalChunk.load_duration || 0) / ns,
      promptEvalCount:    finalChunk.prompt_eval_count || 0,
      promptEvalDuration: (finalChunk.prompt_eval_duration || 0) / ns,
      evalCount,
      evalDuration,
      tokensPerSec,
    };
  }

  return { fullContent, fullThinking, stats };
}

/**
 * Fires one streaming, persisted chat turn (Lab UI's single chat, Lab Eval's
 * A/B Diff view). `conversationId` is a client-generated id (crypto.randomUUID());
 * the backend creates the conversation row on first use and appends to it
 * afterwards, so there's no separate "create conversation" round trip.
 */
export async function streamChat(baseUrl, model, apiMessages, params, signal, handlers, conversationId) {
  const body = {
    conversation_id: conversationId,
    model,
    messages: apiMessages,
    stream:   true,
    think:    resolveThinkValue(model, params),
    options:  buildOptions(params),
  };
  return consumeChatStream(`${baseUrl}/api/chat`, body, signal, handlers);
}

/**
 * Fires one streaming, *unpersisted-as-a-conversation* generation for the Eval
 * Harness. The backend resolves the full config itself (base_config + this
 * cell's axis overrides) from run_id/cell_index/prompt_index — the client
 * only ever needs to say WHICH cell/prompt/repeat, never reconstruct options.
 * The backend still saves the result — but into eval_results for the given
 * run, not into the conversations table, so a big sweep doesn't flood chat
 * history.
 */
export async function streamEvalGenerate(baseUrl, { runId, cellIndex, promptIndex, repeatIndex = 0 }, signal, handlers) {
  const body = {
    run_id: runId,
    cell_index: cellIndex,
    prompt_index: promptIndex,
    repeat_index: repeatIndex,
    stream: true,
  };
  return consumeChatStream(`${baseUrl}/api/eval/generate`, body, signal, handlers);
}

// ── Model management (proxied through the backend) ─────────────────────────

export async function getTags(baseUrl) {
  const res = await fetch(`${baseUrl}/api/tags`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return (data.models || []).sort((a, b) => a.name.localeCompare(b.name));
}

export async function pullModel(baseUrl, modelName, onProgress) {
  const res = await fetch(`${baseUrl}/api/pull`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: modelName, stream: true }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const reader  = res.body.getReader();
  const decoder = new TextDecoder();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const lines = decoder.decode(value, { stream: true }).split('\n').filter(Boolean);
    for (const line of lines) {
      let chunk;
      try { chunk = JSON.parse(line); } catch { continue; }

      if (onProgress && chunk.total && chunk.completed) {
        const pct = Math.round((chunk.completed / chunk.total) * 100);
        onProgress(chunk.status || 'downloading', pct);
      } else if (onProgress && chunk.status) {
        onProgress(chunk.status, 100);
      }
    }
  }
}

export async function deleteModel(baseUrl, modelName) {
  const res = await fetch(`${baseUrl}/api/delete`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: modelName }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

// ── Persistence: conversations (new) ────────────────────────────────────────

export async function listConversations(baseUrl) {
  const res = await fetch(`${baseUrl}/api/conversations`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function getConversation(baseUrl, id) {
  const res = await fetch(`${baseUrl}/api/conversations/${id}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function deleteConversation(baseUrl, id) {
  const res = await fetch(`${baseUrl}/api/conversations/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

// ── Persistence: eval runs + scoring (new) ──────────────────────────────────

export async function createEvalSweep(baseUrl, { id, axes, baseConfig, prompts, repeatCount, hostedBaseline }) {
  const res = await fetch(`${baseUrl}/api/eval/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id,
      axes,
      base_config: baseConfig,
      prompts,
      repeat_count: repeatCount,
      hosted_baseline: hostedBaseline || null,
    }),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`HTTP ${res.status}: ${detail}`);
  }
  return res.json();
}

export async function finishEvalRun(baseUrl, id, status) {
  const res = await fetch(`${baseUrl}/api/eval/runs/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

export async function listEvalRuns(baseUrl) {
  const res = await fetch(`${baseUrl}/api/eval/runs`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function getEvalRun(baseUrl, id) {
  const res = await fetch(`${baseUrl}/api/eval/runs/${id}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// Still returns the registry's response-length/refusal-check/llm-judge
// listing — unused by the AI Evaluation panel now, but left in place as a
// discoverability endpoint for whatever future scorer plugs into that
// registry (see app/scoring/base.py).
export async function listScorers(baseUrl) {
  const res = await fetch(`${baseUrl}/api/scorers`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// AI Evaluation (item 3): one combined judge-model call covering every
// dimension in `dimensions`, with the server also computing/storing that
// pass's per-dimension repeat-variance in the SAME request whenever the
// run's repeat_count >= 2 (see eval.py's score_run()) — the returned
// judgments list may include both per-generation dimension scores and
// set-level variance rows.
//
// TRANSPORT: /score streams NDJSON now, not one JSON body (staged-progress
// redesign, item 2 — option (a): a real per-generation counter instead of
// an indeterminate spinner). Each line is one of:
//   {"type": "progress", "completed": N, "total": M}   — after each generation judged
//   {"type": "done", "judgments": [...]}                — exactly once, at the end
// `handlers.onProgress(completed, total)` fires for every progress line;
// the resolved value is always `{ judgments }`, same shape callers got
// before this transport change, so existing callers only need to add the
// (optional) onProgress handler to get the new staged feedback.
export async function scoreEvalRun(baseUrl, runId, dimensions, judgeModel, handlers = {}) {
  const res = await fetch(`${baseUrl}/api/eval/runs/${runId}/score`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dimensions, model: judgeModel || null }),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`HTTP ${res.status}: ${detail}`);
  }

  const reader  = res.body.getReader();
  const decoder = new TextDecoder();
  let judgments = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const lines = decoder.decode(value, { stream: true }).split('\n').filter(Boolean);
    for (const line of lines) {
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.type === 'progress') handlers.onProgress?.(msg.completed, msg.total);
      else if (msg.type === 'done') judgments = msg.judgments;
    }
  }

  return { judgments: judgments || [] };
}
