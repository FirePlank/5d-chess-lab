// The "Game options" dialog behind the home page's three buttons (after infinitechess.org's):
// variant, time (timed with minutes, increment and the 5D per-timeline delay, or unlimited), side,
// rated or casual against people (rated needs an account, a clock and a rated variant), and
// against Kairos its strength and opening book. The last choices are remembered. Submitting
// creates a lobby seek, a private challenge (and opens its page), or a game against Kairos.
import { VariantPicker } from './variant-picker.js';
import { edge, report } from './net.js';
import { MINUTES, INCREMENTS, TL_DELAYS, PRESETS, tcLabel } from './tc.js';
import { account } from './account.js';
import { $, $$, el, store, toast } from './util.js';

/** The variants rated games are played in (the server's private.rated_variant). */
export const RATED_VARIANTS = ['Standard', 'Standard - Turn Zero'];

const SUBMIT = { online: 'Create online game', friend: 'Challenge a friend', computer: 'Play against computer' };
const DEFAULTS = { variant: 'Standard - Turn Zero', timed: true, minutes: 5, inc: 0, tl: 3, side: 'r', level: 4, book: true, rated: true };

export class GameSetup {
  constructor(app, variants) {
    this.app = app;
    this.dialog = $('#dlg-game-setup');
    this.o = { ...DEFAULTS, ...(store('gameSetup') || {}) };
    if (!MINUTES.includes(this.o.minutes)) this.o.minutes = DEFAULTS.minutes;
    if (!INCREMENTS.includes(this.o.inc)) this.o.inc = DEFAULTS.inc;
    if (!TL_DELAYS.includes(this.o.tl)) this.o.tl = DEFAULTS.tl;
    this.custom = null;
    this.picker = new VariantPicker($('#setup-variant'), {
      variants,
      value: variants.some((v) => v.name === this.o.variant) ? this.o.variant : DEFAULTS.variant,
      onChange: (name) => { if (name !== '__custom') { this.o.variant = name; this.save(); } else this.render(); },
    });
    $$('#setup-timed button').forEach((b) => (b.onclick = () => { this.o.timed = b.dataset.v === 'timed'; this.save(); }));
    const slider = (id, list, key) => {
      const input = $(id);
      input.max = list.length - 1;
      input.value = Math.max(0, list.indexOf(this.o[key]));
      input.oninput = () => { this.o[key] = list[+input.value]; this.render(); };
      input.onchange = () => this.save();
    };
    slider('#setup-minutes', MINUTES, 'minutes');
    slider('#setup-inc', INCREMENTS, 'inc');
    slider('#setup-tl', TL_DELAYS, 'tl');
    $('#setup-presets').replaceChildren(...PRESETS.map((p) => el('button', {
      type: 'button', dataset: { m: p.m, i: p.i, tl: p.tl }, title: p.title || '',
      onclick: () => { Object.assign(this.o, { minutes: p.m, inc: p.i, tl: p.tl, timed: true }); this.syncSliders(); this.save(); },
    }, p.label || `${p.m}+${p.i}`)));
    $$('#setup-side button').forEach((b) => (b.onclick = () => { this.o.side = b.dataset.v; this.save(); }));
    $('#setup-level').replaceChildren(...Array.from({ length: 8 }, (_, i) => {
      const level = i + 1;
      return el('label', { title: level === 8 ? 'Level 8 · Full strength' : `Level ${level}` },
        el('input', { type: 'radio', name: 'setup-level', value: level, 'aria-label': `Level ${level}`, onchange: () => { this.o.level = level; this.save(); } }),
        el('span', { text: level }));
    }));
    $('#setup-book').onchange = () => { this.o.book = $('#setup-book').checked; this.save(); };
    $('#setup-rated').onchange = () => { this.o.rated = $('#setup-rated').checked; this.save(); };
    account.onChange(() => { if (this.dialog.open) this.render(); });
    $('#setup-close').onclick = () => this.dialog.close();
    $('#setup-form').onsubmit = (e) => { e.preventDefault(); this.submit(); };
  }

  syncSliders() {
    $('#setup-minutes').value = MINUTES.indexOf(this.o.minutes);
    $('#setup-inc').value = INCREMENTS.indexOf(this.o.inc);
    $('#setup-tl').value = TL_DELAYS.indexOf(this.o.tl);
  }

  save() {
    store('gameSetup', this.o);
    this.render();
  }

  /** The chosen time control in ms (base null: unlimited). */
  timeControl() {
    if (!this.o.timed) return { base_ms: null, inc_ms: 0, delay_ms: 0, tl_delay_ms: 0 };
    return { base_ms: this.o.minutes * 60000, inc_ms: this.o.inc * 1000, delay_ms: 0, tl_delay_ms: this.o.tl * 1000 };
  }

  render() {
    const timed = this.o.timed;
    $$('#setup-timed button').forEach((b) => b.classList.toggle('on', (b.dataset.v === 'timed') === timed));
    $('#setup-clock').classList.toggle('hidden', !timed);
    $('#setup-minutes-v').textContent = this.o.minutes;
    $('#setup-inc-v').textContent = `${this.o.inc} s`;
    $('#setup-tl-v').textContent = `${this.o.tl} s`;
    $$('#setup-presets button').forEach((b) => b.classList.toggle('on', +b.dataset.m === this.o.minutes && +b.dataset.i === this.o.inc && +b.dataset.tl === this.o.tl));
    $$('#setup-side button').forEach((b) => b.classList.toggle('on', b.dataset.v === this.o.side));
    $$('#setup-level input').forEach((i) => { i.checked = +i.value === this.o.level; });
    $('#setup-book').checked = this.o.book !== false;
    const computer = this.mode === 'computer';
    $$('.setup-computer').forEach((n) => n.classList.toggle('hidden', !computer));
    $$('.setup-human').forEach((n) => n.classList.toggle('hidden', computer));
    const why = this.unratedReason();
    $('#setup-rated').disabled = !!why;
    $('#setup-rated').checked = !why && this.o.rated !== false;
    $('#setup-rated-note').textContent = why || '';
    $('#setup-submit').textContent = SUBMIT[this.mode] || SUBMIT.online;
    $('#setup-submit').title = timed ? tcLabel(this.timeControl()) : 'Unlimited time';
  }

  /** Open in `mode` (online | friend | computer), with `position` (5DUCI) offered as a custom start. */
  open(mode, { position = null, onCreated = null } = {}) {
    this.mode = mode;
    this.onCreated = onCreated;
    if (position) {
      this.custom = position;
      this.picker.setCustom('__custom', 'Custom position');
    }
    $('#setup-error').classList.add('hidden');
    this.syncSliders();
    this.render();
    if (!this.dialog.open) this.dialog.showModal();
  }

  /** Why this game can't be rated (no account, no clock, another variant), or null. */
  unratedReason() {
    if (!account.profile) return 'Sign in to play rated';
    if (!this.o.timed) return 'Rated games need a clock';
    if (!RATED_VARIANTS.includes(this.variant())) return 'Rated: Standard and Turn Zero';
    return null;
  }

  /** Whether the game will be rated. */
  rated() { return this.mode !== 'computer' && !this.unratedReason() && this.o.rated !== false; }

  variant() {
    const v = this.picker.value;
    return v === '__custom' ? this.custom : v || DEFAULTS.variant;
  }

  async submit() {
    const btn = $('#setup-submit');
    if (btn.disabled) return;
    btn.disabled = true;
    const color = this.o.side === 'w' ? 1 : this.o.side === 'b' ? 2 : null;
    const body = { variant: this.variant(), color, ...this.timeControl() };
    try {
      let r;
      if (this.mode === 'computer') {
        const build = this.app.build && this.app.build.engine ? this.app.build.engine.sha.slice(0, 7) : 'local';
        r = await edge('create_engine_game', { ...body, level: this.o.level, book: this.o.book !== false, version: build });
      } else {
        r = await edge('create_seek', { ...body, private: this.mode === 'friend', rated: this.rated() });
      }
      this.dialog.close();
      if (this.onCreated) this.onCreated(this.mode, r);
    } catch (e) {
      if (e.user) {
        $('#setup-error').textContent = e.message;
        $('#setup-error').classList.remove('hidden');
      } else report(e);
    } finally {
      btn.disabled = false;
    }
  }
}

