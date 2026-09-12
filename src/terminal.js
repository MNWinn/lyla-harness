import { emitKeypressEvents } from 'node:readline';

// Inline composer: conversation stays in the terminal's normal scrollback.
export const clean = text => String(text).replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|$))/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
const cellWidth = ch => /\p{Mark}/u.test(ch) || ch === '\u200d' ? 0 : /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe6f\uff01-\uff60]|\p{Extended_Pictographic}/u.test(ch) ? 2 : 1;
export class TerminalChat {
  constructor({ input = process.stdin, output = process.stderr, status, onCycle, onInterrupt }) {
    Object.assign(this, { input, output, status, onCycle, onInterrupt });
    this.text = ''; this.cursor = 0; this.drawn = false; this.closed = false;
    this.history = []; this.historyIndex = 0;
    this.raw = input.isRaw; this.flowing = input.readableFlowing;
    this.key = (text, key) => this.handle(text, key);
    this.resize = () => { this.clear(); this.render(); };
    emitKeypressEvents(input);
    input.on('keypress', this.key); output.on('resize', this.resize);
    this.resume();
  }
  clear() {
    if (this.drawn) this.output.write('\r\x1b[1A\x1b[J');
    this.drawn = false;
  }
  render() {
    if (this.closed || this.suspended) return;
    this.clear();
    const width = Math.max(8, (this.output.columns || 80) - 1);
    const { model, reasoning = 'default', busy = false } = this.status();
    if (busy && !this.spinner) {
      this.spinnerFrame = 0;
      this.spinner = setInterval(() => { this.spinnerFrame++; this.render(); }, 100);
      this.spinner.unref();
    } else if (!busy) this.stopSpinner();
    const color = { low: 36, medium: 34, high: 35, xhigh: 33, max: 31 }[reasoning] || 35;
    const paint = s => process.env.NO_COLOR !== undefined ? s : `\x1b[${color}m${s}\x1b[0m`;
    const title = ` ${busy ? `${'⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'[this.spinnerFrame % 10]} Working… · Esc cancel` : 'Lyla'} · ${reasoning} `;
    const top = (title + '─'.repeat(width)).slice(0, width);
    const footer = clean(`${model} · Shift+Tab thinking · Enter send · Alt+Enter newline`).slice(0, width);
    // A horizontally scrolling input keeps the frame stable even in narrow terminals.
    const chars = Array.from(this.text.replace(/\n/g, '↵'));
    let start = this.cursor, cursorCells = 0;
    while (start > 0 && cursorCells + cellWidth(chars[start - 1]) < width - 4) cursorCells += cellWidth(chars[--start]);
    let visible = '', cells = 0;
    for (const ch of chars.slice(start)) {
      if (cells + cellWidth(ch) > width - 3) break;
      visible += ch; cells += cellWidth(ch);
    }
    this.output.write(`${paint(top)}\n› ${visible}\n${paint('─'.repeat(width))}\n${footer}\x1b[2A\r\x1b[${Math.min(width, cursorCells + 3)}G`);
    this.drawn = true;
  }
  log(text) { this.clear(); this.output.write(`${clean(text)}\n`); this.render(); }
  stopSpinner() { clearInterval(this.spinner); this.spinner = undefined; }
  userMessage(text) {
    this.clear();
    const width = Math.max(8, (this.output.columns || 80) - 1);
    const rows = [''];
    for (const line of clean(text).replace(/\t/g, '    ').split('\n')) {
      let row = '', cells = 0;
      for (const ch of line) {
        const size = cellWidth(ch);
        if (cells + size > width - 4) { rows.push('  ' + row + ' '.repeat(width - cells - 2)); row = ''; cells = 0; }
        row += ch; cells += size;
      }
      rows.push('  ' + row + ' '.repeat(width - cells - 2));
    }
    rows.push('');
    const color = process.env.NO_COLOR === undefined;
    this.output.write('\n' + rows.map(row => {
      const padded = row || ' '.repeat(width);
      return color ? `\x1b[48;2;46;46;58m\x1b[38;2;235;235;245m${padded}\x1b[0m` : padded;
    }).join('\n') + '\n\n');
    this.render();
  }
  read() {
    if (this.closed) return Promise.resolve(null);
    this.render();
    return new Promise(resolve => { this.resolve = resolve; });
  }
  handle(text, key = {}) {
    if (this.suspended || this.closed) return;
    if (key.name === 'paste-start') { this.pasting = true; return; }
    if (key.name === 'paste-end') { this.pasting = false; this.render(); return; }
    if (!this.pasting && (key.name === 'escape' || key.ctrl && key.name === 'c')) {
      if (this.status().busy) this.onInterrupt();
      else if (this.text) { this.text = ''; this.cursor = 0; this.render(); }
      else this.close();
      return;
    }
    if (!this.resolve) return;
    if (!this.pasting && key.name === 'tab' && key.shift) { this.onCycle(); this.render(); return; }
    if (!this.pasting && key.ctrl && key.name === 'd' && !this.text) { this.close(); return; }
    if (!this.pasting && (key.name === 'return' || key.name === 'enter') && !key.meta) {
      const value = this.text; this.text = ''; this.cursor = 0;
      if (value.trim()) this.history.push(value);
      this.historyIndex = this.history.length;
      const resolve = this.resolve; this.resolve = undefined; resolve(value); return;
    }
    let chars = Array.from(this.text);
    if (!this.pasting && key.name === 'left') this.cursor = Math.max(0, this.cursor - 1);
    else if (!this.pasting && key.name === 'right') this.cursor = Math.min(chars.length, this.cursor + 1);
    else if (!this.pasting && (key.name === 'home' || key.ctrl && key.name === 'a')) this.cursor = 0;
    else if (!this.pasting && (key.name === 'end' || key.ctrl && key.name === 'e')) this.cursor = chars.length;
    else if (!this.pasting && key.name === 'backspace') { if (this.cursor) chars.splice(--this.cursor, 1); }
    else if (!this.pasting && key.name === 'delete') chars.splice(this.cursor, 1);
    else if (!this.pasting && ['up', 'down'].includes(key.name)) {
      this.historyIndex = Math.max(0, Math.min(this.history.length, this.historyIndex + (key.name === 'up' ? -1 : 1)));
      chars = Array.from(this.history[this.historyIndex] || ''); this.cursor = chars.length;
    } else if (text && (!key.ctrl || this.pasting) && (!key.meta || ['return', 'enter'].includes(key.name))) {
      const inserted = Array.from(clean(text.replace(/\r/g, '\n')));
      if (chars.length + inserted.length <= 100000) { chars.splice(this.cursor, 0, ...inserted); this.cursor += inserted.length; }
    }
    this.text = chars.join('');
    if (!this.pasting) this.render();
  }
  pause() { this.stopSpinner(); this.clear(); this.suspended = true; this.input.setRawMode?.(this.raw || false); this.output.write('\x1b[?2004l'); }
  resume() { this.suspended = false; this.input.setRawMode?.(true); this.input.resume(); this.output.write('\x1b[?2004h'); this.render(); }
  close() {
    if (this.closed) return;
    this.pause(); this.closed = true;
    this.input.off('keypress', this.key); this.output.off('resize', this.resize);
    if (this.flowing !== true) this.input.pause();
    this.resolve?.(null); this.resolve = undefined;
  }
}
