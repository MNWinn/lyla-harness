/** A bounded, provider-independent tool loop. Event callbacks are awaited. */
export class Agent {
  #running = false;
  constructor({ provider, tools = [], system = '', cwd = process.cwd(), messages = [], maxSteps = 20, onEvent = async () => {}, beforeRun = async () => {}, beforeRequest = async () => '' }) {
    if (!Number.isInteger(maxSteps) || maxSteps < 1) throw new Error('maxSteps must be a positive integer');
    this.tools = new Map();
    for (const tool of tools) {
      if (!tool.name || typeof tool.execute !== 'function' || this.tools.has(tool.name)) throw new Error('Tools must have unique names and an execute function');
      this.tools.set(tool.name, tool);
    }
    this.system = system;
    this.cwd = cwd;
    this.messages = structuredClone(messages);
    this.maxSteps = maxSteps;
    this.onEvent = onEvent;
    this.beforeRun = beforeRun; this.beforeRequest = beforeRequest;
    this.setProvider(provider);
  }
  setProvider(provider) {
    if (this.#running) throw new Error('Cannot switch providers during a run');
    if (typeof provider?.complete !== 'function') throw new Error('Provider must implement complete');
    this.provider = provider;
  }
  async #emit(event) { await this.onEvent(structuredClone(event)); }
  async #message(message) {
    this.messages.push(structuredClone(message));
    await this.#emit({ type: 'message', message });
  }
  async run(prompt, { signal } = {}) {
    if (this.#running) throw new Error('An agent run is already active');
    if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('Prompt must be a nonempty string');
    this.#running = true;
    let pending = [];
    let result;
    try {
      await this.beforeRun(Object.freeze({ prompt }));
      await this.#emit({ type: 'run_start', provider: this.provider.id, model: this.provider.model });
      await this.#message({ role: 'user', content: prompt });
      for (let step = 0; step < this.maxSteps; step++) {
        if (signal?.aborted) { result = { status: 'cancelled' }; break; }
        const contribution = await this.beforeRequest(Object.freeze({ prompt, requestIndex: step, injectionScope: 'model-request' }));
        if (typeof contribution !== 'string') throw new Error('beforeRequest must return text');
        const completion = await this.provider.complete({
          system: [this.system, contribution].filter(Boolean).join('\n\n'),
          messages: structuredClone(this.messages),
          tools: structuredClone([...this.tools.values()].map(({ name, description, parameters }) => ({ name, description, parameters }))),
          signal,
        });
        validateCompletion(completion);
        const message = structuredClone(completion.message);
        pending = [...(message.toolCalls || [])];
        await this.#message(message);
        if (completion.usage) await this.#emit({ type: 'usage', usage: completion.usage });
        if (completion.finishReason === 'length') throw new Error('Provider output was truncated; no tool calls were executed');
        if (signal?.aborted) { result = { status: 'cancelled' }; break; }
        if (!pending.length) { result = { status: 'completed', message }; break; }
        while (pending.length) {
          if (signal?.aborted) { result = { status: 'cancelled' }; break; }
          const call = pending[0];
          // This callback must complete (e.g. durable journal flush) BEFORE execution.
          await this.#emit({ type: 'tool_start', toolCall: call });
          let content;
          let isError = false;
          try {
            if (signal?.aborted) throw new Error('Run cancelled before tool execution');
            const tool = this.tools.get(call.name);
            if (!tool) throw new Error(`Unknown tool: ${call.name}`);
            content = await tool.execute(structuredClone(call.arguments), { cwd: this.cwd, signal });
            if (typeof content !== 'string') throw new Error('Tool must return a string');
          } catch (error) {
            content = errorText(error);
            isError = true;
          }
          const toolMessage = { role: 'tool', content, toolCallId: call.id, name: call.name, isError };
          // Remove before emitting: a failing sink must not produce a duplicate result.
          pending.shift();
          await this.#message(toolMessage);
          await this.#emit({ type: 'tool_result', message: toolMessage });
        }
        if (signal?.aborted) result = { status: 'cancelled' };
        if (result) break;
      }
      result ||= { status: 'limit' };
    } catch (error) {
      result = { status: signal?.aborted ? 'cancelled' : 'error', error: errorText(error) };
    } finally {
      // Every accepted assistant call receives a result, even after cancellation.
      for (const call of pending) {
        const message = { role: 'tool', content: result?.error || 'Run cancelled before tool execution', toolCallId: call.id, name: call.name, isError: true };
        try { await this.#message(message); await this.#emit({ type: 'tool_result', message }); }
        catch (error) { result = { status: 'error', error: errorText(error) }; }
      }
      try {
        if (result?.status === 'error') await this.#emit({ type: 'run_error', error: result.error });
        await this.#emit({ type: 'run_end', ...result });
      } catch (error) { result = { status: 'error', error: errorText(error) }; }
      this.#running = false;
    }
    return result;
  }
}

function errorText(error) { return error instanceof Error ? error.message : String(error); }
function validateCompletion(completion) {
  const m = completion?.message;
  if (!m || m.role !== 'assistant' || typeof m.content !== 'string' || !['stop', 'tool_calls', 'length'].includes(completion.finishReason)) throw new Error('Malformed provider completion');
  if (m.toolCalls !== undefined && !Array.isArray(m.toolCalls)) throw new Error('Malformed provider tool calls');
  const ids = new Set();
  for (const call of m.toolCalls || []) {
    if (!call || typeof call.id !== 'string' || !call.id || ids.has(call.id) || typeof call.name !== 'string' || !call.name || !call.arguments || typeof call.arguments !== 'object' || Array.isArray(call.arguments)) throw new Error('Malformed provider tool call');
    ids.add(call.id);
  }
  if (completion.finishReason === 'tool_calls' && !m.toolCalls?.length) throw new Error('Provider requested tools without tool calls');
}
