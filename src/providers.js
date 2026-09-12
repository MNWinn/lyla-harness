import { createHash } from 'node:crypto';

/** Dependency-free, non-streaming provider adapters. Native state never crosses models. */
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const requireValue = (ok, message = 'Malformed provider response') => { if (!ok) throw new Error(message); };
function call(id, name, args) {
  requireValue(typeof id === 'string' && id.length && typeof name === 'string' && name.length);
  if (typeof args === 'string') {
    try { args = JSON.parse(args); } catch { throw new Error('Provider returned invalid tool argument JSON'); }
  }
  requireValue(object(args), 'Provider tool arguments must be a JSON object');
  return { id, name, arguments: args };
}
function result(id, model, endpoint, content, toolCalls, native, finishReason, usage) {
  requireValue(typeof content === 'string');
  requireValue(finishReason === 'length' || content.trim().length || toolCalls.length, 'Provider returned an empty completion');
  requireValue(new Set(toolCalls.map(x => x.id)).size === toolCalls.length, 'Provider returned duplicate tool call IDs');
  const message = { role: 'assistant', content, ...(toolCalls.length ? { toolCalls } : {}), opaque: { provider: id, model, endpoint, native } };
  return { message, finishReason: finishReason === 'length' ? 'length' : toolCalls.length ? 'tool_calls' : 'stop', ...(usage ? { usage } : {}) };
}
function tokens(usage, input, output) {
  if (!usage) return undefined;
  return { inputTokens: Number.isFinite(usage[input]) ? usage[input] : 0, outputTokens: Number.isFinite(usage[output]) ? usage[output] : 0 };
}
export function createProvider({ provider, model, baseUrl, apiKey, reasoning, maxTokens = 4096, timeoutMs = 120000 } = {}) {
  requireValue(['demo', 'openai', 'anthropic', 'openai-compatible'].includes(provider), 'Unknown provider; choose demo, openai, anthropic, or openai-compatible');
  requireValue(typeof model === 'string' && model.trim(), 'A model is required');
  requireValue(Number.isInteger(maxTokens) && maxTokens > 0, 'maxTokens must be a positive integer');
  requireValue(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 2147483647, 'timeoutMs must be a positive bounded integer');
  if (provider === 'demo') return { id: provider, model, reasoning, async complete({ signal }) {
    signal?.throwIfAborted();
    return { message: { role: 'assistant', content: 'Lyla is running in offline demo mode. Select a provider and model to work on your codebase.' }, finishReason: 'stop', usage: { inputTokens: 0, outputTokens: 0 } };
  } };
  const endpoint = baseUrl || (provider === 'anthropic' ? 'https://api.anthropic.com/v1' : provider === 'openai' ? 'https://api.openai.com/v1' : undefined);
  requireValue(endpoint, 'openai-compatible requires baseUrl (including any /v1 prefix)');
  let url;
  try { url = new URL(endpoint); } catch { throw new Error('Invalid provider base URL'); }
  requireValue(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash, 'Invalid provider base URL');
  const key = apiKey ?? (provider === 'anthropic' ? process.env.ANTHROPIC_API_KEY : provider === 'openai' ? process.env.OPENAI_API_KEY : process.env.OPENAI_COMPATIBLE_API_KEY);
  requireValue(provider === 'openai-compatible' || key, `Set ${provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY'} or supply apiKey`);
  const endpointId = createHash('sha256').update(url.href.replace(/\/$/, '')).digest('hex');
  const native = m => m.opaque?.provider === provider && m.opaque?.model === model && m.opaque?.endpoint === endpointId ? m.opaque.native : undefined;
  async function post(body, signal) {
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const response = await fetch(`${url.href.replace(/\/$/, '')}/${provider === 'anthropic' ? 'messages' : provider === 'openai' ? 'responses' : 'chat/completions'}`, {
        method: 'POST', redirect: 'error', signal: combined,
        headers: { 'content-type': 'application/json', ...(provider === 'anthropic' ? { 'anthropic-version': '2023-06-01', 'x-api-key': key } : key ? { authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify(body)
      });
      if (!response.ok) { await response.body?.cancel(); throw new Error(`Provider HTTP ${response.status}`); }
      let value;
      try { value = await response.json(); } catch { throw new Error('Provider returned invalid JSON'); }
      requireValue(object(value));
      return value;
    } catch (error) {
      if (signal?.aborted) throw new Error('Provider request cancelled');
      if (timeout.aborted) throw new Error('Provider request timed out');
      if (/^(Provider HTTP \d+|Provider returned invalid JSON|Malformed provider response)$/.test(error.message)) throw error;
      throw new Error('Provider request failed; check connection and configuration');
    }
  }
  return { id: provider, model, reasoning, async complete({ system = '', messages = [], tools = [], signal }) {
    // Reasoning-only truncated turns have nothing portable to replay.
    messages = messages.filter(m => m.role !== 'assistant' || native(m) || m.content?.trim() || m.toolCalls?.length);
    // Foreign call IDs may use a different vendor's alphabet or length. Rewrite
    // only canonical fallback calls, and apply the same mapping to their results.
    const ids = new Map();
    for (const m of messages) if (m.role === 'assistant' && !native(m)) {
      for (const t of m.toolCalls || []) ids.set(t.id, `call_${createHash('sha256').update(t.id).digest('hex').slice(0, 40)}`);
    }
    const callId = id => ids.get(id) || id;
    if (provider === 'openai') {
      const input = messages.flatMap(m => {
        if (m.role === 'tool') return [{ type: 'function_call_output', call_id: callId(m.toolCallId), output: m.content }];
        if (m.role === 'assistant' && native(m)) return native(m);
        return [...(m.content ? [{ role: m.role, content: m.content }] : []), ...(m.toolCalls || []).map(t => ({ type: 'function_call', call_id: callId(t.id), name: t.name, arguments: JSON.stringify(t.arguments) }))];
      });
      const data = await post({ model, ...(reasoning ? { reasoning: { effort: reasoning } } : {}), instructions: system, input, store: false, include: ['reasoning.encrypted_content'], max_output_tokens: maxTokens, tools: tools.map(t => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters, strict: false })) }, signal);
      requireValue(Array.isArray(data.output) && ['completed', 'incomplete'].includes(data.status));
      let content = ''; const calls = [];
      for (const item of data.output) {
        requireValue(object(item));
        if (item.type === 'function_call') calls.push(call(item.call_id, item.name, item.arguments));
        else if (item.type === 'message') {
          requireValue(Array.isArray(item.content));
          for (const part of item.content) {
            requireValue(object(part));
            const text = part.type === 'output_text' ? part.text : part.type === 'refusal' ? part.refusal : undefined;
            requireValue(typeof text === 'string'); content += text;
          }
        } else requireValue(item.type === 'reasoning', 'Provider returned unsupported output');
      }
      return result(provider, model, endpointId, content, calls, data.output, data.status === 'incomplete' ? 'length' : 'stop', tokens(data.usage, 'input_tokens', 'output_tokens'));
    }
    if (provider === 'anthropic') {
      const converted = [];
      for (const m of messages) {
        const role = m.role === 'assistant' ? 'assistant' : 'user';
        const content = m.role === 'tool' ? [{ type: 'tool_result', tool_use_id: callId(m.toolCallId), content: m.content, is_error: m.isError }] : native(m) || [...(m.content ? [{ type: 'text', text: m.content }] : []), ...(m.toolCalls || []).map(t => ({ type: 'tool_use', id: callId(t.id), name: t.name, input: t.arguments }))];
        if (converted.at(-1)?.role === role) converted.at(-1).content.push(...content);
        else converted.push({ role, content: [...content] });
      }
      const data = await post({ model, system, messages: converted, max_tokens: maxTokens, tools: tools.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters })) }, signal);
      requireValue(Array.isArray(data.content) && ['end_turn', 'tool_use', 'max_tokens', 'stop_sequence'].includes(data.stop_reason));
      let content = ''; const calls = [];
      for (const item of data.content) {
        requireValue(object(item));
        if (item.type === 'text') { requireValue(typeof item.text === 'string'); content += item.text; }
        else if (item.type === 'tool_use') calls.push(call(item.id, item.name, item.input));
        else requireValue(['thinking', 'redacted_thinking'].includes(item.type), 'Provider returned unsupported output');
      }
      requireValue(data.stop_reason === 'max_tokens' || (data.stop_reason === 'tool_use') === (calls.length > 0), 'Provider returned inconsistent tool stop reason');
      return result(provider, model, endpointId, content, calls, data.content, data.stop_reason === 'max_tokens' ? 'length' : 'stop', tokens(data.usage, 'input_tokens', 'output_tokens'));
    }
    const converted = messages.map(m => m.role === 'tool' ? { role: 'tool', tool_call_id: callId(m.toolCallId), content: m.content } : native(m) || { role: m.role, content: m.content || null, ...(m.toolCalls?.length ? { tool_calls: m.toolCalls.map(t => ({ id: callId(t.id), type: 'function', function: { name: t.name, arguments: JSON.stringify(t.arguments) } })) } : {}) });
    const data = await post({ model, messages: [{ role: 'system', content: system }, ...converted], max_tokens: maxTokens, ...(tools.length ? { tools: tools.map(t => ({ type: 'function', function: t })) } : {}) }, signal);
    const choice = data.choices?.[0];
    requireValue(object(choice?.message) && ['stop', 'tool_calls', 'length'].includes(choice.finish_reason));
    const m = choice.message;
    requireValue(m.role === 'assistant' && (m.content == null || typeof m.content === 'string') && (m.tool_calls == null || Array.isArray(m.tool_calls)));
    const calls = (m.tool_calls || []).map(t => { requireValue(object(t) && t.type === 'function' && object(t.function)); return call(t.id, t.function.name, t.function.arguments); });
    requireValue(choice.finish_reason === 'length' || (choice.finish_reason === 'tool_calls') === (calls.length > 0), 'Provider returned inconsistent tool stop reason');
    return result(provider, model, endpointId, m.content || '', calls, m, choice.finish_reason, tokens(data.usage, 'prompt_tokens', 'completion_tokens'));
  } };
}
