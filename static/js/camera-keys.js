// Hold WASD to move the viewport at a consistent screen speed, at any zoom.
export function bindCameraKeys(board, active) {
  const held = new Set();
  let frame = null, previous = 0, fast = false;
  const typing = (target) => target?.closest?.('input, textarea, select, dialog, [contenteditable]:not([contenteditable="false"])');
  const stop = () => {
    held.clear();
    fast = false;
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
  };
  const tick = (now) => {
    if (!active() || document.querySelector('dialog[open]') || typing(document.activeElement)) { stop(); return; }
    const dx = Number(held.has('d')) - Number(held.has('a'));
    const dy = Number(held.has('s')) - Number(held.has('w'));
    const distance = 600 * (fast ? 3 : 1) * Math.min((now - previous) / 1000, 0.05) / board.cam.s / (Math.hypot(dx, dy) || 1);
    previous = now;
    if (dx || dy) {
      board.fitted = false;
      board.moveTo({ ...board.cam, x: board.cam.x + dx * distance, y: board.cam.y + dy * distance }, false);
    }
    frame = requestAnimationFrame(tick);
  };
  document.addEventListener('keydown', (event) => {
    const k = event.key.toLowerCase();
    if (k === 'shift') { fast = event.shiftKey; return; }
    if (!'wasd'.includes(k) || k.length !== 1 || !active() || typing(event.target)
      || document.querySelector('dialog[open]') || event.ctrlKey || event.metaKey || event.altKey) return;
    event.preventDefault();
    fast = !!event.shiftKey;
    held.add(k);
    if (frame === null) { previous = performance.now(); frame = requestAnimationFrame(tick); }
  });
  document.addEventListener('keyup', (event) => {
    fast = !!event.shiftKey;
    held.delete(event.key.toLowerCase());
    if (!held.size) stop();
  });
  window.addEventListener('blur', stop);
  window.addEventListener('hashchange', stop);
  document.addEventListener('visibilitychange', stop);
  document.addEventListener('focusin', (event) => { if (typing(event.target)) stop(); });
}
