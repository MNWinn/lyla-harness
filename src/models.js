// Curated API identifiers checked 2026-09-11. These are choices, not access guarantees.
// https://developers.openai.com/api/docs/models
// https://platform.claude.com/docs/en/models/overview
const bundled = {
  openai: [
    ['GPT-5.6 Sol', 'gpt-5.6-sol'],
    ['GPT-5.6 Luna', 'gpt-5.6-luna'],
    ['GPT-5.4', 'gpt-5.4'],
    ['GPT-5.4 Mini', 'gpt-5.4-mini'],
  ],
  anthropic: [
    ['Claude Sonnet 5', 'claude-sonnet-5'],
    ['Claude Opus 5', 'claude-opus-5'],
    ['Claude Fable 5.1', 'claude-fable-5-1'],
    ['Claude Haiku 4.5', 'claude-haiku-4-5-20251001'],
  ],
};

export async function modelChoices(provider, baseUrl, { fetchImpl = fetch } = {}) {
  if (bundled[provider]) return {
    note: 'Built-in model list. Availability depends on your API account.',
    choices: bundled[provider].map(([name, id]) => ({ label: `${name} (${id})`, value: id })),
  };
  try {
    const response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/models`, {
      signal: AbortSignal.timeout(5000), redirect: 'error',
      headers: process.env.OPENAI_COMPATIBLE_API_KEY ? { authorization: `Bearer ${process.env.OPENAI_COMPATIBLE_API_KEY}` } : {},
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error('Unavailable'); }
    const data = await response.json();
    const ids = [...new Set((data.data ?? []).map(m => m.id).filter(id => typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_./:@+-]{0,150}$/.test(id)))].sort();
    if (!ids.length) throw new Error('No models');
    return { note: 'Models reported by your server. The selected model must support tools.', choices: ids.slice(0, 8).map(id => ({ label: id, value: id })) };
  } catch {
    return { note: 'Could not list models from this server. Use its exact model ID below.', choices: [] };
  }
}
