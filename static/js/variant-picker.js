import { el } from './util.js';

const DESCRIPTIONS = {
  Standard: '8×8, the main game',
  Simple: 'Smaller sets, 6×6 and 7×7',
  Small: '5×5',
  'Very Small': '4×4',
  Misc: 'Several timelines, odd sets',
  Focused: 'One kind of piece',
  'Checkmate Practice': 'Mate with a lone piece',
};

function chevron(points, className) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', className);
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.innerHTML = `<polyline points="${points}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;
  return svg;
}

/** The grouped variant picker shared by Analysis and Play; each owns its selection. */
export class VariantPicker {
  constructor(root, { variants, value = null, onChange, flat = false }) {
    this.root = root;
    this.variants = variants;
    this.onChange = onChange;
    this.flat = flat;
    this.groups = [];
    for (const variant of variants) {
      const [name, ...rest] = variant.name.split(' - ');
      let group = this.groups.find((g) => g.name === name);
      if (!group) this.groups.push((group = { name, variants: [] }));
      group.variants.push({ name: variant.name, label: rest.join(' - ') || name });
    }
    this.label = el('span', { class: 'variant-name' });
    this.button = el('button', { type: 'button', class: 'variant-display', 'aria-label': 'Variant', 'aria-haspopup': 'menu', 'aria-expanded': 'false' },
      this.label, chevron('6 9 12 15 18 9', 'selector-arrow'));
    this.menu = el('div', { class: 'variant-dropdown', role: 'menu', 'aria-label': 'Variants' });
    root.replaceChildren(this.button, this.menu);
    this.menu.addEventListener('click', (event) => event.stopPropagation());
    this.setValue(value);
    this.button.onclick = () => {
      if (this.menu.classList.contains('open')) return this.close();
      this.showGroups();
      this.menu.classList.add('open');
      this.button.classList.add('open');
      this.button.setAttribute('aria-expanded', 'true');
    };
    document.addEventListener('click', (event) => { if (!root.contains(event.target)) this.close(); });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && this.menu.classList.contains('open')) {
        this.close();
        this.button.focus();
      }
    });
    window.addEventListener('hashchange', () => this.close());
  }

  setValue(value) {
    this.value = value;
    this.label.textContent = this.custom?.value === value ? this.custom.label
      : this.variants.some((v) => v.name === value) ? value : 'Custom position';
    this.close();
  }

  setCustom(value, label) {
    this.custom = { value, label };
    this.setValue(value);
  }

  close() {
    this.menu.classList.remove('open');
    this.button.classList.remove('open');
    this.button.setAttribute('aria-expanded', 'false');
  }

  choose(name) {
    this.setValue(name);
    this.onChange(name);
  }

  showGroups() {
    if (this.flat) {
      this.menu.replaceChildren(...this.variants.map(variant => el('button', {
        type: 'button', class: 'variant-item' + (variant.name === this.value ? ' on' : ''),
        role: 'menuitem', text: variant.name, onclick: () => this.choose(variant.name),
      })));
      this.menu.scrollTop = 0;
      return;
    }
    const custom = this.custom ? el('button', {
      type: 'button', class: 'variant-item' + (this.value === this.custom.value ? ' on' : ''), role: 'menuitem',
      text: this.custom.label, onclick: () => this.choose(this.custom.value),
    }) : null;
    this.menu.replaceChildren(...[custom, ...this.groups.map((group) => el('button', {
      type: 'button', class: 'variant-group-item' + (group.variants.some((v) => v.name === this.value) ? ' on' : ''), role: 'menuitem',
      onclick: () => this.showGroup(group),
    }, el('span', { class: 'group-name', text: group.name }), el('span', { class: 'group-desc', text: DESCRIPTIONS[group.name] || '' }),
    chevron('9 6 15 12 9 18', 'group-arrow')))].filter(Boolean));
    this.menu.scrollTop = 0;
  }

  showGroup(group) {
    this.menu.replaceChildren(
      el('button', { type: 'button', class: 'variant-list-back', onclick: () => this.showGroups() },
        chevron('15 18 9 12 15 6', 'back-arrow'), el('span', { class: 'group-name', text: group.name }),
        el('span', { class: 'group-desc', text: DESCRIPTIONS[group.name] || '' })),
      ...group.variants.map((variant) => el('button', {
        type: 'button', class: 'variant-item' + (variant.name === this.value ? ' on' : ''), role: 'menuitem', title: variant.name,
        text: variant.label, onclick: () => this.choose(variant.name),
      })));
    this.menu.scrollTop = 0;
  }
}
