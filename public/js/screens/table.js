// The game table: other players on top, deck/discard in the middle, your
// cards at the bottom, and buttons for whatever you can do right now.

import { h } from '../h.js';
import { cardEl, backEl, cardText, cardValue, fmtValue, POWERS } from '../cards.js';
import { isMuted } from '../sound.js';

export function renderTable(ctx) {
  const v = ctx.view;
  const g = v.game;
  const me = g.players.find((p) => p.id === v.me) ?? null;
  const at = me ? g.players.indexOf(me) : -1;
  const others = me ? [...g.players.slice(at + 1), ...g.players.slice(0, at)] : g.players;
  const t = g.turn;
  const st = {
    ctx,
    v,
    g,
    t,
    me,
    others,
    ui: ctx.S.ui,
    myTurn: Boolean(me && t && t.pid === v.me),
    isHost: v.host === v.me,
    name: (pid) => (pid === v.me ? 'You' : g.players.find((p) => p.id === pid)?.name ?? v.members.find((m) => m.id === pid)?.name ?? 'Someone'),
  };

  return h(
    'main.screen.table',
    { class: { 'my-turn': st.myTurn, paused: Boolean(v.paused), over: g.phase === 'roundEnd' || g.phase === 'gameOver' } },
    topBar(st),
    h('button.ticker', { onClick: () => ctx.openSheet('log') }, ctx.S.log.at(-1)?.text ?? 'Game log'),
    h('section.opps', h('div.opps-grid', { class: `n${Math.min(others.length, 9)}` }, others.map((p) => opponent(st, p)))),
    center(st),
    status(st),
    me ? hand(st) : watching(st),
    actions(st),
  );
}

function topBar(st) {
  const { ctx, v, g } = st;
  return h(
    'header.topbar',
    h('button.icon-btn', { 'aria-label': 'Menu', onClick: () => ctx.openSheet('menu') }, '☰'),
    h('div.tb-mid', h('b', 'Kabo'), h('span', v.code), h('span', `Round ${g.round}`), h('span', `to ${g.rules.target}`)),
    h('button.icon-btn', { 'aria-label': 'Scores', onClick: () => ctx.openSheet('scores') }, '🏆'),
    h('button.icon-btn', { 'aria-label': 'Sound on or off', onClick: () => ctx.toggleSound() }, isMuted() ? '🔇' : '🔊'),
  );
}

// ------------------------------------------------------------- players

function opponent(st, p) {
  const { v, g, t } = st;
  const m = v.members.find((x) => x.id === p.id);
  const cabo = g.caboBy === p.id;
  return h(
    'div.opp',
    { class: { turn: t?.pid === p.id, cabo, off: m && !m.connected } },
    h(
      'div.opp-top',
      h('span.dot', { class: { on: m?.connected } }),
      h('span.nm', p.name),
      m?.bot && h('span.tag', '🤖'),
      cabo && h('span.tag.cabo-tag', 'KABO'),
      h('span.pts', String(p.total)),
    ),
    h('div.minis', p.slots.map((s, i) => slotEl(st, p, i, s, 'sm'))),
    g.phase === 'peek' && h('span.opp-state', p.ready ? 'ready' : 'memorising…'),
    m && !m.connected && !m.bot && h('span.opp-state.off', 'offline'),
  );
}

function hand(st) {
  const { me, g } = st;
  return h(
    'section.me',
    { class: { turn: st.myTurn } },
    h(
      'div.me-top',
      h('span.nm', 'Your cards'),
      g.caboBy === me.id && h('span.tag.cabo-tag', 'KABO'),
      h('span.pts', `${me.total} pts`),
    ),
    h(
      'div.hand',
      { style: { '--n': String(Math.max(4, me.slots.length)) } },
      me.slots.map((s, i) => h('div.slot', slotEl(st, me, i, s, 'lg'), h('span.slot-n', String(i + 1)))),
    ),
  );
}

function watching(st) {
  const { ctx, v, g } = st;
  const pending = v.claims.find((c) => c.from === v.me);
  const free = g.players.filter((p) => {
    const m = v.members.find((x) => x.id === p.id);
    return m && !m.bot && !m.connected;
  });
  return h(
    'section.me.watch',
    h('b', "You're watching this game"),
    h('span', 'You will get a seat when the host starts the next game.'),
    pending
      ? h('span', 'Asked the host to let you take over a seat…')
      : free.map((p) => h('button.btn', { onClick: () => ctx.send('claim', { seat: p.id }) }, `Take over ${p.name}'s seat`)),
  );
}

function slotEl(st, p, i, s, size) {
  const key = `s:${p.id}:${i}`;
  if (!s) return h('div.card.empty', { class: size, dataset: { key } });
  const open = st.g.phase === 'roundEnd' || st.g.phase === 'gameOver';
  const el = cardEl(s.c ?? null, { size, rules: st.g.rules, key, extra: { up: s.up, seen: Boolean(s.c && !s.up && !open) } });
  const a = slotAction(st, p, i, s);
  if (a.tap) {
    el.classList.add('tap');
    el.setAttribute('role', 'button');
    el.onclick = a.tap;
  }
  if (a.sel) el.classList.add('sel');
  if (a.glow) el.classList.add('glow');
  if (a.dim) el.classList.add('dim');
  return el;
}

// What tapping this card does right now (if anything).
function slotAction(st, p, i, s) {
  const { g, t, v, ui, ctx } = st;
  const mine = p.id === v.me;
  const out = { tap: null, sel: false, glow: false, dim: false };
  if (t?.stage === 'reveal' && t.reveal.cards.some((x) => x.pid === p.id && x.slot === i)) out.glow = true;

  if (g.phase === 'peek' && mine && g.peek && !g.peek.ready) {
    if (g.peek.picks.includes(i)) out.glow = true;
    else if (g.peek.picks.length < 2) out.tap = () => ctx.send('peekPick', { slot: i });
    return out;
  }
  if (!st.myTurn || t.stage !== 'decide' || ctx.view.paused) return out;

  const locked = g.rules.lockCaller && g.caboBy === p.id;
  switch (ui.mode) {
    case null:
      if (mine) out.tap = () => ctx.setUi({ mode: 'exchange', own: [i] });
      break;
    case 'exchange':
      if (mine) {
        out.sel = ui.own[0] === i;
        out.tap = () => ctx.setUi({ own: [i] });
      }
      break;
    case 'match':
      if (!mine) break;
      // A face-up card everyone can see is obviously not a match.
      if (s.up && s.c && s.c.r !== t.drawn.r) out.dim = true;
      else {
        out.sel = ui.own.includes(i);
        out.tap = () => ctx.setUi({ own: out.sel ? ui.own.filter((x) => x !== i) : [...ui.own, i] });
      }
      break;
    case 'peek':
      if (mine && !s.up) out.tap = () => ctx.send('power', { target: { own: i } });
      else if (mine) out.dim = true;
      break;
    case 'spy':
      if (!mine && !s.up) out.tap = () => ctx.send('power', { target: { pid: p.id, slot: i } });
      break;
    case 'swap':
    case 'lookswap':
      if (mine) {
        out.sel = ui.own[0] === i;
        out.tap = () => ctx.setUi({ own: [i] });
      } else if (locked) {
        out.dim = true;
      } else {
        out.sel = ui.other?.pid === p.id && ui.other.slot === i;
        out.tap = () => ctx.setUi({ other: { pid: p.id, slot: i } });
      }
      break;
    default:
  }
  return out;
}

// --------------------------------------------------------------- middle

function center(st) {
  const { ctx, g, t } = st;
  const canDraw = st.myTurn && t.stage === 'draw' && !st.v.paused;
  const canTake = canDraw && g.discardTop;
  return h(
    'section.center',
    h(
      'div.pile.deck',
      { class: { tap: canDraw }, onClick: canDraw ? () => ctx.send('drawDeck') : null },
      g.deckCount ? backEl({ size: 'md', key: 'deck' }) : h('div.card.md.empty', { dataset: { key: 'deck' } }),
      h('span.pile-n', String(g.deckCount)),
      h('span.pile-lbl', 'Deck'),
    ),
    h(
      'div.pile.discard',
      { class: { tap: canTake }, onClick: canTake ? () => ctx.send('takeDiscard') : null },
      g.discardTop ? cardEl(g.discardTop, { size: 'md', key: 'discard' }) : h('div.card.md.empty', { dataset: { key: 'discard' } }),
      h('span.pile-lbl', 'Discard'),
    ),
    stage(st),
  );
}

function stage(st) {
  const { g, t, v, name } = st;
  if (g.phase === 'peek') {
    const ready = g.players.filter((p) => p.ready).length;
    return h('div.stage.msg', h('b', 'Memorise!'), h('span', `Everyone looks at 2 of their cards. ${ready}/${g.players.length} ready.`));
  }
  if (g.phase !== 'turn') {
    return h('div.stage.msg', h('b', g.phase === 'gameOver' ? 'Game over' : 'Round over'), h('span', 'Everyone’s cards are face-up'));
  }
  if (t.stage === 'decide') {
    const card = t.drawn ? cardEl(t.drawn, { size: 'lg', rules: g.rules, key: 'drawn' }) : backEl({ size: 'lg', key: 'drawn' });
    let cap;
    if (st.myTurn && t.from === 'discard') {
      cap = [h('b', `You took the ${cardText(t.drawn)}`), h('span', 'Swap it for one of your cards')];
    } else if (st.myTurn) {
      const p = t.power;
      cap = [
        h('b', `You drew the ${cardText(t.drawn)}`),
        h('span', `Worth ${fmtValue(cardValue(t.drawn))} point${Math.abs(cardValue(t.drawn)) === 1 ? '' : 's'}`),
        p && h('span.power', `${POWERS[p].icon} ${POWERS[p].name}: ${POWERS[p].what}`),
      ];
    } else {
      cap = [h('b', t.from === 'discard' ? `${name(t.pid)} took the ${cardText(t.drawn)}` : `${name(t.pid)} drew a card`), h('span', 'Deciding…')];
    }
    return h('div.stage', card, h('div.cap', cap));
  }
  if (t.stage === 'reveal') {
    const P = POWERS[t.reveal.power];
    const shown = t.reveal.cards.map((x) => {
      const p = g.players.find((pp) => pp.id === x.pid);
      const s = p?.slots[x.slot];
      const label = x.pid === v.me ? `Your card ${x.slot + 1}` : `${p?.name ?? '?'}'s card ${x.slot + 1}`;
      return h('div.shown', s?.c ? cardEl(s.c, { size: 'md', rules: g.rules, extra: 'seen' }) : backEl({ size: 'md' }), h('small', label));
    });
    const cap = st.myTurn ? (t.reveal.power === 'lookswap' ? 'Swap them?' : 'Remember it!') : `${name(t.pid)}: ${P.name}`;
    return h('div.stage.reveal', h('div.shown-row', shown), h('div.cap', h('b', `${P.icon} ${cap}`)));
  }
  return h(
    'div.stage.msg',
    st.myTurn
      ? [h('b', 'Your turn!'), h('span', g.discardTop ? `Draw a card, take the ${cardText(g.discardTop)}, or call Kabo` : 'Draw a card or call Kabo')]
      : [h('b', `${name(t.pid)}'s turn`), h('span', 'Choosing…')],
  );
}

function status(st) {
  const { ctx, v, g, name } = st;
  const kids = [];
  if (g.caboBy && g.phase === 'turn') {
    const left = g.finalTurns?.length ?? 0;
    kids.push(h('span.cabo-flag', `${name(g.caboBy)} called Kabo · ${left} turn${left === 1 ? '' : 's'} left`));
  }
  const timer = v.timer;
  if (timer && !v.paused) {
    const who = timer.pid ? (timer.pid === v.me ? 'You' : name(timer.pid)) : null;
    const label = timer.reason === 'offline' ? `${who} is offline, skipping in` : null;
    kids.push(
      h(
        'div.timer-wrap',
        { dataset: { deadline: String(ctx.S.deadline), total: String(timer.total), mine: timer.pid === v.me || (!timer.pid && g.peek && !g.peek.ready) ? '1' : '0' } },
        label && h('span.tlabel', label),
        h('div.timer', h('i')),
        h('span.secs', `${Math.ceil(timer.left / 1000)}s`),
      ),
    );
  } else if (v.paused) {
    kids.push(h('span.paused-flag', '⏸ Paused'));
  }
  return h('div.status', kids);
}

// ------------------------------------------------------------- buttons

function actions(st) {
  const { ctx, g, t, v, me } = st;
  const bar = (...kids) => h('footer.actions', ...kids);
  const hint = (text) => h('p.hint', text);

  if (g.phase === 'roundEnd' || g.phase === 'gameOver') {
    return bar(
      g.phase === 'gameOver'
        ? h('button.btn.primary', { onClick: () => ctx.showGameOver() }, 'Final scores')
        : h('button.btn.primary', { onClick: () => ctx.showResults() }, 'Round results'),
    );
  }
  if (!me) return bar(hint(t ? `${st.name(t.pid)}'s turn` : 'Players are memorising their cards'));
  if (v.paused) {
    return bar(
      hint(`${v.members.find((m) => m.id === v.paused.by)?.name ?? 'The host'} paused the game`),
      st.isHost && h('button.btn.primary', { onClick: () => ctx.send('resume') }, '▶ Resume'),
    );
  }
  if (g.phase === 'peek') {
    if (g.peek && !g.peek.ready) {
      const n = g.peek.picks.length;
      return bar(
        hint(n < 2 ? `Tap ${2 - n === 2 ? 'two' : 'one more'} of your cards to look ${n ? 'at it' : 'at them'}` : 'Memorise them, then hide them'),
        h('button.btn.primary', { onClick: () => ctx.send('peekReady') }, n < 2 ? 'Skip' : 'Got it, hide them'),
      );
    }
    return bar(hint('Waiting for everyone to memorise their cards…'));
  }
  if (!st.myTurn) {
    const left = g.finalTurns ? ' (last turns)' : '';
    return bar(hint(`Waiting for ${st.name(t.pid)}…${left}`));
  }

  if (t.stage === 'draw') {
    const armed = st.ui.caboArmed && Date.now() - st.ui.caboArmed < 3000;
    return bar(
      h('button.btn.primary', { onClick: () => ctx.send('drawDeck') }, 'Draw'),
      g.discardTop && h('button.btn', { onClick: () => ctx.send('takeDiscard') }, `Take ${cardText(g.discardTop)}`),
      !g.caboBy &&
        h(
          'button.btn.cabo',
          { class: { armed }, onClick: () => (armed ? ctx.send('cabo') : ctx.armCabo()) },
          armed ? 'Tap again!' : 'KABO!',
        ),
    );
  }
  if (t.stage === 'decide') return decideBar(st, bar, hint);
  if (t.reveal.power === 'lookswap') {
    return bar(
      h('button.btn.primary', { onClick: () => ctx.send('reveal', { swap: true }) }, 'Swap them'),
      h('button.btn', { onClick: () => ctx.send('reveal', { swap: false }) }, 'Keep as is'),
    );
  }
  return bar(hint('Only you can see it. Remember it!'), h('button.btn.primary', { onClick: () => ctx.send('reveal') }, 'Got it'));
}

function decideBar(st, bar, hint) {
  const { ctx, t, ui } = st;
  const back = h('button.btn', { onClick: () => ctx.setUi({ mode: null, own: [], other: null }) }, 'Back');
  if (t.from === 'discard' || ui.mode === 'exchange') {
    const n = ui.own.length;
    return bar(
      hint(n ? 'Swap this card?' : t.from === 'discard' ? `Tap the card to swap for the ${cardText(t.drawn)}` : 'Tap the card you want to replace'),
      h('button.btn.primary', { disabled: n === 0, onClick: () => ctx.send('exchange', { slots: ui.own }) }, 'Swap'),
      t.from === 'deck' && back,
    );
  }
  if (ui.mode === 'match') {
    const n = ui.own.length;
    return bar(
      hint(
        n
          ? `Throw ${n === 1 ? 'it' : `all ${n}`} away with the ${cardText(t.drawn)}? A wrong guess costs a penalty card.`
          : `Tap your card(s) that are also ${rankName(t.drawn.r)}`,
      ),
      h('button.btn.primary', { disabled: n === 0, onClick: () => ctx.send('match', { slots: ui.own }) }, n > 1 ? `Match ${n} cards` : 'Match'),
      back,
    );
  }
  if (ui.mode === 'peek') return bar(hint('Tap one of your face-down cards to peek at it'), back);
  if (ui.mode === 'spy') return bar(hint("Tap someone else's face-down card to spy on it"), back);
  if (ui.mode === 'swap' || ui.mode === 'lookswap') {
    const ready = ui.own.length === 1 && ui.other;
    const step = !ui.own.length ? 'Tap one of your cards…' : !ui.other ? "…and one of someone else's" : ui.mode === 'swap' ? 'Swap these two without looking?' : 'Look at both cards?';
    return bar(
      hint(step),
      h(
        'button.btn.primary',
        { disabled: !ready, onClick: () => ctx.send('power', { target: { own: ui.own[0], pid: ui.other.pid, slot: ui.other.slot } }) },
        ui.mode === 'swap' ? 'Swap' : 'Look',
      ),
      back,
    );
  }
  const p = t.power;
  return h(
    'footer.actions.quad',
    h('button.btn.primary', { onClick: () => ctx.setUi({ mode: 'exchange', own: [] }) }, 'Keep it'),
    h('button.btn.match', { onClick: () => ctx.setUi({ mode: 'match', own: [] }) }, `Match ${t.drawn.r}`),
    h('button.btn', { onClick: () => ctx.send('discard') }, 'Discard'),
    p && h('button.btn.power', { onClick: () => ctx.setUi({ mode: p, own: [], other: null }) }, `${POWERS[p].icon} ${POWERS[p].name}`),
  );
}

const RANK_NAMES = { A: 'an Ace', J: 'a Jack', Q: 'a Queen', K: 'a King', 8: 'an 8' };
const rankName = (r) => RANK_NAMES[r] ?? `a ${r}`;
