// Shared board audio: cached Web Audio buffers, unlocked by a user gesture.
import { store } from './util.js';

const FILES = {
  move: 'Move', capture: 'Capture', start: 'GenericNotify',
  win: 'GenericNotify', loss: 'GenericNotify', draw: 'GenericNotify', end: 'GenericNotify',
};

export function moveSound(san = '') {
  if (san.includes('x')) return 'capture';
  return /O-O|0-0/.test(san) ? 'castle' : 'move';
}

export function givesCheck(san = '') {
  return /[+#]/.test(san.replace(/\([^)]*\)/g, ''));
}

export class Sounds {
  constructor() {
    this.enabled = store('sound') !== false;
    this.volume = 1;
    this.buffers = new Map();
    this.voices = new Set();
    this.generation = 0;
  }

  /** Start listening for the first gesture (browsers only allow audio after one). */
  init() {
    this.volume = Math.min(1, Math.max(0, +(store('soundVolume') ?? 1) || 0));
    const unlock = () => this.unlock();
    window.addEventListener('pointerdown', unlock, { capture: true, passive: true });
    window.addEventListener('keydown', unlock, { capture: true });
  }

  /** Sound on or off (the header menu's Sound). */
  set(enabled) {
    this.enabled = !!enabled;
    this.generation++;
    store('sound', this.enabled);
    if (!this.enabled) for (const voice of this.voices) { try { voice.stop(); } catch (e) { /* already ended */ } }
    if (this.enabled) { this.unlock(); this.play('move'); }
  }

  /** The volume, 0 to 1 (a sample plays at the new level). */
  setVolume(v) {
    this.volume = Math.min(1, Math.max(0, +v || 0));
    store('soundVolume', this.volume);
    if (this.enabled) { this.unlock(); this.play('move'); }
  }

  unlock() {
    if (!this.enabled) return;
    try {
      if (!this.context) {
        const Context = window.AudioContext || window.webkitAudioContext;
        if (!Context) return;
        this.context = new Context();
        for (const name of Object.keys(FILES)) this.load(name).catch(() => {});
      }
      if (this.context.state !== 'running') this.context.resume().catch(() => {});
    } catch (e) { /* Sound must never prevent playing the game. */ }
  }

  load(name) {
    const file = FILES[name];
    if (!this.buffers.has(file)) {
      const loading = fetch(new URL(`../sounds/${file}.mp3`, import.meta.url)).then((r) => {
        if (!r.ok) throw new Error('Sound unavailable');
        return r.arrayBuffer();
      }).then((bytes) => this.context.decodeAudioData(bytes));
      this.buffers.set(file, loading);
      loading.catch(() => this.buffers.delete(file));
    }
    return this.buffers.get(file);
  }

  async play(name, { delay = 0, volume = 1 } = {}) {
    if (!this.enabled || !this.context || !FILES[name]) return;
    const generation = this.generation, requested = performance.now();
    try {
      const buffer = await this.load(name);
      if (!this.enabled || generation !== this.generation || this.context.state !== 'running' || performance.now() - requested > 500 || this.voices.size >= 12) return;
      const source = this.context.createBufferSource();
      const gain = this.context.createGain();
      source.buffer = buffer;
      gain.gain.value = 0.35 * volume * this.volume;
      source.connect(gain).connect(this.context.destination);
      source.onended = () => { this.voices.delete(source); source.disconnect(); gain.disconnect(); };
      this.voices.add(source);
      source.start(this.context.currentTime + delay);
    } catch (e) { /* A missing file or blocked audio is non-fatal. */ }
  }

  action(san, { move = true, check = true } = {}) {
    if (move) {
      const kind = moveSound(san);
      this.play(kind === 'castle' ? 'move' : kind);
      if (kind === 'castle') this.play('move', { delay: 0.08, volume: 0.7 });
    }
    if (check && givesCheck(san)) this.play('check', { delay: move ? 0.12 : 0 });
  }

  end(result, humanColor) {
    const win = humanColor === 'w' ? '1-0' : '0-1';
    this.play(result === '1/2-1/2' ? 'draw' : humanColor ? (result === win ? 'win' : 'loss') : 'end');
  }
}

export const sounds = new Sounds();
