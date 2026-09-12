import { emitKeypressEvents } from 'node:readline';
import { createInterface } from 'node:readline/promises';

/** Small dependency-free terminal select; line-based fallback for non-TTY streams. */
export async function select(title, choices, { input = process.stdin, output = process.stderr } = {}) {
  if (!choices.length) throw new Error('Selection needs at least one option.');
  if (!input.isTTY || typeof input.setRawMode !== 'function' || !output.isTTY) {
    const rl = createInterface({ input, output });
    try {
      output.write(`${title}\n${choices.map((c, i) => `  ${i + 1}. ${c.label}`).join('\n')}\n`);
      while (true) {
        const answer = (await rl.question(`Select [1-${choices.length}]: `)).trim();
        const index = Number(answer) - 1;
        if (answer && Number.isInteger(index) && index >= 0 && index < choices.length) return choices[index].value;
        output.write('Choose a number from the list.\n');
      }
    } finally { rl.close(); }
  }
  return new Promise((resolve, reject) => {
    let index = 0;
    let lines = 0;
    const wasRaw = Boolean(input.isRaw);
    const wasPaused = input.readableFlowing !== true;
    const clip = line => line.slice(0, Math.max(8, (output.columns || 80) - 2));
    const clear = () => { if (lines) output.write(`\x1b[${lines}A\r\x1b[J`); };
    const render = () => {
      clear();
      const rows = [title, '↑/↓ move · Enter select · Esc cancel', ...choices.map((c, i) => `${i === index ? '❯' : ' '} ${c.label}`)];
      output.write(`${rows.map(clip).join('\n')}\n`);
      lines = rows.length;
    };
    const finish = (error) => {
      input.removeListener('keypress', onKey);
      input.removeListener('end', onEnd);
      input.setRawMode(wasRaw);
      if (wasPaused) input.pause();
      clear();
      output.write(error ? `${title}: cancelled\n` : `${title}: ${choices[index].label}\n`);
      error ? reject(error) : resolve(choices[index].value);
    };
    const onEnd = () => finish(new Error('Setup cancelled.'));
    const onKey = (text, key = {}) => {
      if (key.name === 'escape' || key.name === 'c' && key.ctrl || key.name === 'd' && key.ctrl) return onEnd();
      if (key.name === 'return' || key.name === 'enter') return finish();
      if (key.name === 'up') index = (index + choices.length - 1) % choices.length;
      else if (key.name === 'down' || key.name === 'tab') index = (index + 1) % choices.length;
      else if (/^[1-9]$/.test(text) && Number(text) <= choices.length) index = Number(text) - 1;
      else return;
      render();
    };
    emitKeypressEvents(input);
    input.setRawMode(true);
    input.on('keypress', onKey);
    input.on('end', onEnd);
    input.resume();
    render();
  });
}
