// Card movement: cards fly between their old and new places on screen.
// Elements that take part carry data-key ('deck', 'discard', 'drawn', 's:<player>:<slot>').

const reduced = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

export function snapshot() {
  const map = new Map();
  for (const el of document.querySelectorAll('#app [data-key]')) {
    const r = el.getBoundingClientRect();
    if (r.width > 0) map.set(el.dataset.key, r);
  }
  return map;
}

export const keyed = (key) => document.querySelector(`#app [data-key="${CSS.escape(key)}"]`);

// Fly `card` (an element) from rect `from` to rect `to`; `hide` stays hidden until it lands.
export function fly({ from, to, card, delay = 0, duration = 430, hide = null }) {
  if (!from || !to || !card || reduced()) return;
  const layer = document.getElementById('fx');
  card.removeAttribute('data-key');
  Object.assign(card.style, {
    position: 'fixed',
    left: `${to.left}px`,
    top: `${to.top}px`,
    width: `${to.width}px`,
    height: `${to.height}px`,
    margin: '0',
    transformOrigin: '0 0',
  });
  card.classList.add('flying');
  layer.append(card);
  const dx = from.left - to.left;
  const dy = from.top - to.top;
  const s = from.width / to.width;
  if (hide) hide.style.visibility = 'hidden';
  const anim = card.animate(
    [
      { transform: `translate(${dx}px, ${dy}px) scale(${s})`, offset: 0 },
      { transform: `translate(${dx * 0.45}px, ${dy * 0.45 - 18}px) scale(${(s + 1) / 2 * 1.06})`, offset: 0.5 },
      { transform: 'none', offset: 1 },
    ],
    { duration, delay, easing: 'cubic-bezier(.25,.8,.25,1)', fill: 'backwards' },
  );
  const done = () => {
    card.remove();
    if (hide) hide.style.visibility = '';
  };
  anim.onfinish = done;
  anim.oncancel = done;
}

export function pulse(el, name = 'pulse') {
  if (!el || reduced()) return;
  el.classList.remove(name);
  void el.offsetWidth;
  el.classList.add(name);
}

export function wiggle(el) {
  if (!el || reduced()) return;
  el.animate(
    [{ transform: 'none' }, { transform: 'rotate(-6deg)' }, { transform: 'rotate(5deg)' }, { transform: 'rotate(-3deg)' }, { transform: 'none' }],
    { duration: 600 },
  );
}
