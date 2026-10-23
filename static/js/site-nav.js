/** Compact navigation keeps the same links and closes on navigation, outside click or Escape. */
export function bindSiteNav() {
  const button = document.getElementById('nav-toggle');
  const nav = document.getElementById('site-nav');
  const compact = matchMedia('(max-width: 900px)');
  const setOpen = open => {
    button.setAttribute('aria-expanded', String(open));
    nav.classList.toggle('open', open);
  };
  button.addEventListener('click', () => setOpen(button.getAttribute('aria-expanded') !== 'true'));
  // A dropdown's title takes no focus from the mouse, so its menu closes when the pointer leaves.
  for (const top of nav.querySelectorAll('.nav-top')) top.addEventListener('pointerdown', (e) => e.preventDefault());
  // Choosing an entry closes its menu at once.
  nav.addEventListener('click', (e) => { const a = e.target.closest('.nav-drop a'); if (a) a.blur(); });
  nav.addEventListener('click', e => { if (e.target.closest('a')) setOpen(false); });
  document.addEventListener('pointerdown', e => {
    if (!nav.contains(e.target) && !button.contains(e.target)) setOpen(false);
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && button.getAttribute('aria-expanded') === 'true') {
      setOpen(false);
      button.focus();
      e.preventDefault();
    }
  });
  document.addEventListener('focusin', e => {
    if (!nav.contains(e.target) && !button.contains(e.target)) setOpen(false);
  });
  compact.addEventListener('change', () => setOpen(false));
  window.addEventListener('hashchange', () => setOpen(false));
}
