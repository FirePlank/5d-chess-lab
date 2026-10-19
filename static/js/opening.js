// Opening classification is independent of whether engine book play is enabled.
import { el } from './util.js';
import { openingUrl } from './opening-tree.js';

export function openingAt(rules, node) {
  try { return rules.call({ cmd: 'book', node }).opening || null; }
  catch (e) { return null; }
}

/** Link a classified position back to its book line, when its starting variant is known. */
export function openingLink(tree, opening, variants) {
  const variant = variants?.find(v => v.position === tree?.start)?.name;
  if (!variant || opening?.node == null) return null;
  const moves = [];
  for (let at = opening.node; at; at = tree.nodes[at].parent) moves.push(tree.nodes[at].lan);
  return openingUrl(variant, moves.reverse());
}

/** Lila-style opening title, linked to the corresponding opening page. */
export function renderOpening(root, opening, href = null) {
  const name = opening?.name || '';
  root.classList.toggle('hidden', !name);
  if (root.dataset.opening === name && root.dataset.href === (href || '')) return;
  root.dataset.opening = name;
  root.dataset.href = href || '';
  root.title = name;
  if (!name) { root.replaceChildren(); return; }
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#i-book');
  icon.append(use);
  root.replaceChildren(icon, el(href ? 'a' : 'strong', { class: 'opening-title', href, text: name }));
}
