export function reasoningLevels(provider, model) {
  if (!['openai', 'codex'].includes(provider)) return [];
  if (/^gpt-6/.test(model)) return ['low', 'medium', 'high', 'xhigh', 'max'];
  if (/^gpt-5/.test(model)) return ['low', 'medium', 'high'];
  return [];
}
