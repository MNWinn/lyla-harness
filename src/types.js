/**
 * Lyla's small public protocol. Providers translate these messages to their own API.
 * Keep provider-native continuation data in assistant.opaque, tagged by provider/model.
 *
 * @typedef {{name: string, description: string, parameters: Object}} ToolDefinition
 * @typedef {{id: string, name: string, arguments: Object}} ToolCall
 * @typedef {{role: 'user', content: string} |
 *   {role: 'assistant', content: string, toolCalls?: ToolCall[], opaque?: Object} |
 *   {role: 'tool', content: string, toolCallId: string, name: string, isError: boolean}} Message
 * @typedef {{inputTokens: number, outputTokens: number}} Usage
 * @typedef {{message: Message, usage?: Usage, finishReason: 'stop'|'tool_calls'|'length'}} Completion
 * @typedef {{system: string, messages: Message[], tools: ToolDefinition[], signal?: AbortSignal}} Request
 * @typedef {{id: string, model: string, complete(request: Request): Promise<Completion>}} Provider
 * @typedef {{cwd: string, signal?: AbortSignal}} ToolContext
 * @typedef {ToolDefinition & {execute(args: Object, context: ToolContext): Promise<string>}} Tool
 */
export {};
