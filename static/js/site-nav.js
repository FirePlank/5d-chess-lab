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
