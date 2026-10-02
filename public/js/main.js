// Kabo client: keeps the connection, holds the latest view from the server,
// and redraws the screen. The server decides everything; this only shows it.

import { h, morph } from './h.js';
import { cardEl, backEl } from './cards.js';
import { describe, namer } from './text.js';
import { sfx, haptic, speak, unlockAudio, isMuted, setMuted } from './sound.js';
import { snapshot, fly, keyed, wiggle } from './anim.js';
import { renderHome } from './screens/home.js';
import { renderLobby } from './screens/lobby.js';
import { renderTable } from './screens/table.js';
import { renderSheet, resultsSheet, gameOverSheet, claimSheet } from './screens/sheets.js';

const store = {
  get(k, d = null) {
    try {
      return localStorage.getItem(k) ?? d;
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, v);
    } catch {}
  },
  del(k) {
    try {
      localStorage.removeItem(k);
    } catch {}
  },
};

function newToken() {
  const t = crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
  store.set('kabo.token', t);
  return t;
}

const pathCode = (location.pathname.match(/^\/([A-Za-z]{4})\/?$/) || [])[1]?.toUpperCase() ?? null;

const S = {
  view: null,
  ui: { key: '', mode: null, own: [], other: null, caboArmed: 0 },
  log: [],
  sheet: null, // { name, data } opened by the player
  hidden: null, // results/game-over sheet tucked away to look at the table
  forced: null, // 'results' | 'gameover' when asked for again
  connected: false,
  busy: false,
  homeError: null,
  deadline: 0,
  token: store.get('kabo.token') || newToken(),
  name: store.get('kabo.name', ''),
  joinCode: '',
  urlCode: pathCode,
};

// --------------------------------------------------------------- network

const socket = io({ reconnectionDelayMax: 4000 });

function emit(event, data) {
  return new Promise((resolve) => {
    if (!socket.connected) return resolve({ ok: false, error: 'Not connected. Trying to reconnect…' });
    socket.timeout(8000).emit(event, data, (err, res) => resolve(err ? { ok: false, error: 'No answer from the server. Check your connection.' } : res));
  });
}

async function send(type, args = {}) {
  unlockAudio();
  const res = await emit('cmd', { type, ...args });
  if (!res?.ok) {
    toast(res?.error ?? 'Something went wrong', 'error');
    sfx.error();
  }
  return res;
}

socket.on('connect', async () => {
  S.connected = true;
  const code = S.view?.code ?? store.get('kabo.room');
  if (code && (!S.urlCode || S.urlCode === code || S.view)) {
    const res = await emit('rejoin', { code, token: S.token });
    if (!res.ok) {
      store.del('kabo.room');
      if (S.view || S.urlCode === code) toast(res.error, 'error');
      if (/closed/.test(res.error ?? '') && S.urlCode === code) {
        S.urlCode = null;
        history.replaceState(null, '', '/');
      }
      S.view = null;
    }
  }
  render();
});

socket.on('disconnect', () => {
  S.connected = false;
  render();
});

socket.on('removed', ({ why }) => {
  store.del('kabo.room');
  S.view = null;
  S.sheet = null;
  S.urlCode = null;
  S.log = [];
  history.replaceState(null, '', '/');
  toast(why === 'kicked' ? 'The host removed you from the room' : 'You left the room');
  keepAwake(false);
  render();
});

socket.on('state', ({ view, events, replay }) => {
  const before = S.view && !replay ? snapshot() : null;
  const prevGame = S.view?.game ?? null;
  S.view = view;
  S.urlCode = view.code;
  store.set('kabo.room', view.code);
  if (location.pathname !== `/${view.code}`) history.replaceState(null, '', `/${view.code}`);
  if (view.timer) S.deadline = performance.now() + view.timer.left;

  if (replay) S.log = [];
  for (const ev of events) {
    const text = describe(ev, view);
    if (text) S.log.push({ seq: ev.seq, text });
  }
  if (S.log.length > 150) S.log.splice(0, S.log.length - 150);

  syncUi(view, prevGame);
  render();
  if (before && events.length) {
    animate(events, before, view);
    react(events, view);
  }
  keepAwake(Boolean(view.game));
});

// The player's in-progress choices reset whenever the turn moves on.
function syncUi(v, prevGame) {
  const g = v.game;
  const key = g ? `${g.round}:${g.phase}:${g.turn?.pid ?? ''}:${g.turn?.stage ?? ''}` : 'lobby';
  if (key !== S.ui.key) {
    S.ui = { key, mode: null, own: [], other: null, caboArmed: 0 };
    if (g?.turn?.pid === v.me && g.turn.stage === 'decide' && g.turn.from === 'discard') S.ui.mode = 'exchange';
  }
  if (!g || (prevGame && prevGame.round !== g.round) || (prevGame && prevGame.phase !== g.phase)) {
    S.hidden = null;
    S.forced = null;
  }
  if (!g && S.sheet?.name === 'scores') S.sheet = null;
}

// --------------------------------------------------------------- render

const ctx = {
  S,
  get view() {
    return S.view;
  },
  send,
  render: () => render(),
  setUi(patch) {
    Object.assign(S.ui, patch);
    render();
  },
  openSheet(name, data) {
    S.sheet = { name, data };
    render();
  },
  closeSheet() {
    S.sheet = null;
    render();
  },
  confirm(data) {
    S.sheet = { name: 'confirm', data };
    render();
  },
  confirmLeave() {
    ctx.confirm({ title: 'Leave this room?', text: '', yes: 'Leave', onYes: () => send('leave') });
  },
  armCabo() {
    S.ui.caboArmed = Date.now();
    render();
    setTimeout(render, 3100);
  },
  hideResults() {
    const g = S.view?.game;
    S.hidden = g ? `${g.phase}:${g.round}` : null;
    S.forced = null;
    render();
  },
  showResults() {
    S.hidden = null;
    S.forced = 'results';
    S.sheet = null;
    render();
  },
  showGameOver() {
    S.hidden = null;
    S.forced = 'gameover';
    render();
  },
  toggleSound() {
    setMuted(!isMuted());
    unlockAudio();
    if (!isMuted()) sfx.ping();
    render();
  },
  async start(kind, code) {
    unlockAudio();
    const name = (S.name || '').trim();
    if (!name) {
      S.homeError = 'Please type your name first';
      return render();
    }
    const joinCode = kind === 'join' ? (code || S.joinCode || '').toUpperCase() : null;
    if (kind === 'join' && !/^[A-Z]{4}$/.test(joinCode)) {
      S.homeError = 'Room codes have 4 letters';
      return render();
    }
    store.set('kabo.name', name);
    S.homeError = null;
    S.busy = true;
    render();
    const res = await emit(kind, { name, token: S.token, code: joinCode });
    S.busy = false;
    if (!res.ok) {
      S.homeError = res.error;
      render();
    }
  },
  forgetUrlCode() {
    S.urlCode = null;
    history.replaceState(null, '', '/');
    render();
  },
  roomLink: () => `${location.origin}/${S.view?.code ?? ''}`,
  whatsappLink: () => `https://wa.me/?text=${encodeURIComponent(`Come play Kabo with me! Room ${S.view?.code}: ${ctx.roomLink()}`)}`,
  async shareLink() {
    const url = ctx.roomLink();
    if (navigator.share) {
      try {
        await navigator.share({ title: 'Kabo', text: `Come play Kabo with me! Room ${S.view?.code}`, url });
      } catch {}
    } else ctx.copyLink();
  },
  async copyLink() {
    try {
      await navigator.clipboard.writeText(ctx.roomLink());
      toast('Link copied. Paste it into WhatsApp.');
    } catch {
      window.prompt('Copy this link:', ctx.roomLink());
    }
  },
};

// Redraw by patching the current screen; switching screens starts afresh.
function patch(root, next) {
  const cur = root.firstElementChild;
  if (cur && next && cur.className.split(' ')[1] === next.className.split(' ')[1]) morph(cur, next);
  else root.replaceChildren(...(next ? [next] : []));
}

function render() {
  const v = S.view;
  patch(document.getElementById('app'), !v ? renderHome(ctx) : !v.game ? renderLobby(ctx) : renderTable(ctx));
  renderSheets();
  document.getElementById('conn').hidden = S.connected || !v;
  document.body.classList.toggle('in-game', Boolean(v?.game));
}

function renderSheets() {
  const root = document.getElementById('sheets');
  const v = S.view;
  const g = v?.game;
  let el = null;
  const claim = v && v.host === v.me && v.claims.find((c) => c.from !== v.me);
  if (claim) el = claimSheet(ctx, claim);
  else if (S.sheet) el = renderSheet(ctx, S.sheet.name, S.sheet.data);
  else if (g && (g.phase === 'roundEnd' || g.phase === 'gameOver') && S.hidden !== `${g.phase}:${g.round}`) {
    const wantResults = g.phase === 'roundEnd' ? S.forced !== 'gameover' : S.forced === 'results';
    el = wantResults && g.results ? resultsSheet(ctx) : gameOverSheet(ctx);
  }
  const old = root.querySelector('.sheet');
  const same = old && el && old.dataset.sheet === el.querySelector('.sheet')?.dataset.sheet;
  if (same) morph(root.firstElementChild, el);
  else root.replaceChildren(...(el ? [el] : []));
}

// ------------------------------------------------------- feedback

function toast(text, kind = 'info') {
  const root = document.getElementById('toasts');
  const el = h('div.toast', { class: kind }, text);
  root.append(el);
  while (root.children.length > 2) root.firstChild.remove();
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 350);
  }, kind === 'error' ? 3800 : 2800);
}

function banner(title, sub) {
  const el = h('div.banner', h('b', title), sub && h('span', sub));
  document.getElementById('fx').append(el);
  setTimeout(() => el.remove(), 2400);
}

// Sounds, vibration and pop-ups for things worth noticing.
function react(events, v) {
  const name = namer(v);
  const me = v.me;
  for (const ev of events) {
    switch (ev.t) {
      case 'turn':
        if (ev.pid === me) {
          sfx.turn();
          haptic(70);
        }
        break;
      case 'draw':
        sfx.draw();
        break;
      case 'discard':
      case 'exchange':
      case 'power':
      case 'putback':
        sfx.place();
        break;
      case 'match':
        if (ev.shown.length) {
          sfx.oops();
          toast(describe(ev, v), ev.pid === me ? 'error' : 'info');
        } else sfx.place();
        break;
      case 'peek':
      case 'spy':
      case 'look':
        sfx.flip();
        if (ev.pid !== me && (ev.b?.pid === me || ev.a?.pid === me)) toast(describe(ev, v));
        break;
      case 'swap':
        sfx.swap();
        if (ev.pid !== me && (ev.a.pid === me || ev.b.pid === me)) {
          toast(`${describe(ev, v)}!`, 'warn');
          haptic([60, 40, 60]);
        }
        break;
      case 'cabo':
        sfx.cabo();
        speak('Kaabo!');
        haptic([90, 50, 90]);
        banner('KABO!', ev.pid === me ? 'You called it. Everyone else gets one last turn' : `${name(ev.pid)} called it. One last turn each!`);
        break;
      case 'reshuffle':
        sfx.shuffle();
        toast(describe(ev, v));
        break;
      case 'roundEnd':
        sfx.end();
        break;
      case 'gameOver':
        if (ev.winners.includes(me)) sfx.win();
        break;
      case 'timeout':
        if (ev.pid === me) toast('You ran out of time, so your turn was passed', 'warn');
        break;
      case 'join':
        sfx.ping();
        if (!v.game) toast(describe(ev, v));
        break;
      case 'left':
      case 'kicked':
      case 'host':
      case 'pause':
      case 'resume':
      case 'takeover':
      case 'claimDenied': {
        const text = describe(ev, v);
        if (text) toast(text);
        break;
      }
      case 'claim':
        if (v.host === me) sfx.ping();
        break;
      default:
    }
  }
}

// Fly cards between their old and new places.
function animate(events, before, v) {
  const after = snapshot();
  const me = v.me;
  const game = v.game;
  const cardFor = (c, size) => (c ? cardEl(c, { size }) : backEl({ size }));
  let delay = 0;
  for (const ev of events) {
    switch (ev.t) {
      case 'draw': {
        const from = after.get(ev.from === 'deck' ? 'deck' : 'discard') ?? before.get(ev.from === 'deck' ? 'deck' : 'discard');
        const face = ev.c ?? (ev.pid === me ? game?.turn?.drawn : null);
        fly({ from, to: after.get('drawn'), card: cardFor(face, 'lg'), delay, hide: keyed('drawn') });
        break;
      }
      case 'discard':
      case 'power':
      case 'putback':
        fly({ from: before.get('drawn'), to: after.get('discard'), card: cardFor(ev.c, 'md'), delay, hide: keyed('discard') });
        break;
      case 'exchange': {
        const into = `s:${ev.pid}:${ev.into}`;
        const target = keyed(into);
        fly({ from: before.get('drawn'), to: after.get(into), card: target ? target.cloneNode(true) : backEl(), delay, hide: target });
        ev.slots.forEach((i, k) => {
          fly({
            from: before.get(`s:${ev.pid}:${i}`),
            to: after.get('discard'),
            card: cardFor(ev.out[k], 'md'),
            delay: delay + 120 + k * 90,
            hide: k === ev.slots.length - 1 ? keyed('discard') : null,
          });
        });
        break;
      }
      case 'match':
        ev.hits.forEach((i, k) => {
          fly({ from: before.get(`s:${ev.pid}:${i}`), to: after.get('discard'), card: cardFor(ev.out[k], 'md'), delay: delay + k * 90 });
        });
        fly({ from: before.get('drawn'), to: after.get('discard'), card: cardFor(ev.c, 'md'), delay: delay + ev.hits.length * 90, hide: keyed('discard') });
        ev.misses.forEach((i) =>
          keyed(`s:${ev.pid}:${i}`)?.animate(
            [{ transform: 'translateX(0)' }, { transform: 'translateX(-5px)' }, { transform: 'translateX(5px)' }, { transform: 'translateX(0)' }],
            { duration: 300, iterations: 2 },
          ),
        );
        ev.added.forEach((i, k) => {
          const key = `s:${ev.pid}:${i}`;
          const target = keyed(key);
          fly({ from: after.get('deck'), to: after.get(key), card: target ? target.cloneNode(true) : backEl(), delay: delay + 300 + k * 160, hide: target });
        });
        break;
      case 'swap': {
        const ka = `s:${ev.a.pid}:${ev.a.slot}`;
        const kb = `s:${ev.b.pid}:${ev.b.slot}`;
        const ea = keyed(ka);
        const eb = keyed(kb);
        fly({ from: before.get(ka), to: after.get(kb), card: eb ? eb.cloneNode(true) : backEl(), delay, duration: 600, hide: eb });
        fly({ from: before.get(kb), to: after.get(ka), card: ea ? ea.cloneNode(true) : backEl(), delay, duration: 600, hide: ea });
        break;
      }
      case 'reshuffle':
        wiggle(keyed('deck'));
        break;
      default:
        continue;
    }
    delay += 140;
  }
}

// --------------------------------------------------------- timers etc.

let lastTick = 0;
setInterval(() => {
  for (const el of document.querySelectorAll('[data-deadline]')) {
    const left = Math.max(0, Number(el.dataset.deadline) - performance.now());
    const total = Number(el.dataset.total) || 1;
    const bar = el.querySelector('.timer i');
    if (bar) bar.style.width = `${Math.min(100, (left / total) * 100)}%`;
    const secs = el.querySelector('.secs');
    if (secs) secs.textContent = `${Math.ceil(left / 1000)}s`;
    el.classList.toggle('low', left < 10_000);
    if (el.dataset.mine === '1' && left > 0 && left < 5_500) {
      const s = Math.ceil(left / 1000);
      if (s !== lastTick) {
        lastTick = s;
        sfx.tick();
      }
    }
  }
}, 200);

// Keep the phone screen on during a game (a locked screen drops the connection).
let wake = null;
async function keepAwake(on) {
  try {
    if (on && !wake && 'wakeLock' in navigator && document.visibilityState === 'visible') {
      wake = await navigator.wakeLock.request('screen');
      wake.addEventListener('release', () => (wake = null));
    } else if (!on && wake) {
      await wake.release();
      wake = null;
    }
  } catch {}
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  keepAwake(Boolean(S.view?.game));
  if (!socket.connected) socket.connect();
});

document.addEventListener('pointerdown', unlockAudio, { passive: true });

render();
