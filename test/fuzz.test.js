// Randomised games: random (often silly) moves, bad input, players leaving,
// and bot-only games. After every step we check that no card is lost or
// duplicated and that no view shows a face-down card it shouldn't.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game, GameError } from '../server/game.js';
import { cardPower } from '../server/cards.js';
import { botStep } from '../server/bot.js';
import { seededRng, shuffle } from '../server/util.js';

const players = (n) => Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `P${i}` }));

function randomRules(rng) {
  return {
    target: rng() < 0.7 ? 50 : 100,
    reshuffle: rng() < 0.8,
    faceUpPickups: rng() < 0.8,
    redKingPower: rng() < 0.5,
    lockCaller: rng() < 0.3,
    kamikaze: rng() < 0.8,
    snap: rng() < 0.85,
  };
}

function checkInvariants(g) {
  const cards = [...g.deck, ...g.discard, ...g.players.flatMap((p) => p.hand.filter(Boolean).map((s) => s.card))];
  if (g.phase === 'turn' && g.turn.drawn) cards.push(g.turn.drawn);
  const ids = cards.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, 'a card is in two places');
  assert.equal(ids.length, 52, 'a card went missing');
  if (g.phase === 'peek' || g.phase === 'turn') {
    for (const p of g.players) assert.ok(p.hand.some(Boolean), 'an empty hand must end the round');
  }

  const open = g.phase === 'roundEnd' || g.phase === 'gameOver';
  for (const viewer of [...g.players.map((p) => p.id), 'watcher']) {
    const v = g.viewFor(viewer);
    assert.ok(!/"id":\d/.test(JSON.stringify(v)), 'internal card ids must never reach clients');
    const st = g.phase === 'peek' ? g.peek.get(viewer) : null;
    v.players.forEach((p, pi) => {
      p.slots.forEach((s, i) => {
        if (!s || !s.c) return;
        const real = g.players[pi].hand[i];
        assert.deepEqual(s.c, { r: real.card.r, s: real.card.s }, 'view shows the wrong card');
        if (s.up) return;
        const peekOk = st && !st.ready && p.id === viewer && st.picks.includes(i);
        const revealOk =
          g.phase === 'turn' && g.turn.stage === 'reveal' && g.turn.pid === viewer &&
          g.turn.reveal.cards.some((r) => r.pid === p.id && r.slot === i);
        assert.ok(open || peekOk || revealOk, `face-down card leaked to ${viewer}`);
      });
    });
    if (v.turn?.drawn) assert.ok(v.turn.pid === viewer || v.turn.from === 'discard', 'drawn card leaked');
  }
}

const slotsOf = (p) => p.hand.flatMap((s, i) => (s ? [i] : []));

// Someone (anyone) throws a card on the fresh discard: a real match, a guess,
// or someone else's card with one of theirs given back.
function randomSnap(g, rng) {
  const pick = (arr) => arr[Math.floor(rng() * arr.length)];
  const me = pick(g.players);
  const owner = rng() < 0.7 ? me : pick(g.players);
  const top = g.snapWin?.card;
  const real = top ? slotsOf(owner).filter((i) => owner.hand[i].card.r === top.r) : [];
  const slot = real.length && rng() < 0.6 ? pick(real) : pick(slotsOf(owner));
  try {
    g.snap(me.id, { pid: owner.id, slot, give: owner === me ? undefined : pick(slotsOf(me)) });
  } catch (e) {
    if (!(e instanceof GameError)) throw e;
  }
}

function randomMove(g, rng) {
  const pick = (arr) => arr[Math.floor(rng() * arr.length)];
  if (g.phase === 'turn' && rng() < 0.15) return randomSnap(g, rng);
  if (g.phase === 'peek') {
    const [pid, st] = pick([...g.peek.entries()].filter(([, s]) => !s.ready));
    if (st.picks.length < 2 && rng() < 0.7) {
      try {
        g.peekPick(pid, Math.floor(rng() * 5));
      } catch (e) {
        if (!(e instanceof GameError)) throw e;
      }
    } else g.peekReady(pid);
    return;
  }
  if (g.phase === 'roundEnd') return g.nextRound();
  const { pid, stage, from, drawn } = g.turn;
  const me = g.player(pid);
  if (rng() < 0.02) return g.autoPlay(pid);
  if (stage === 'draw') {
    if (!g.caboBy && rng() < 0.06) return g.callCabo(pid);
    if (g.discard.length && rng() < 0.3) return g.takeDiscard(pid);
    return g.drawDeck(pid);
  }
  if (stage === 'decide') {
    const x = rng();
    if (from === 'deck' && cardPower(drawn, g.rules) && x < 0.45) {
      const op = pick(g.players.filter((p) => p.id !== pid));
      try {
        return g.usePower(pid, { own: pick(slotsOf(me)), pid: op.id, slot: pick(slotsOf(op)) });
      } catch (e) {
        if (!(e instanceof GameError)) throw e;
        return g.discardDrawn(pid);
      }
    }
    if (from === 'deck' && x < 0.6) return g.discardDrawn(pid);
    const own = slotsOf(me);
    if (from === 'deck' && x < 0.8) {
      // Sometimes a real match, sometimes a guess.
      const same = own.filter((i) => me.hand[i].card.r === drawn.r);
      const pickN = (arr) => shuffle(arr, rng).slice(0, 1 + Math.floor(rng() * Math.min(arr.length, 3)));
      return g.match(pid, same.length && rng() < 0.7 ? pickN(same) : pickN(own));
    }
    return g.exchange(pid, [pick(own)]);
  }
  return g.finishReveal(pid, rng() < 0.5);
}

// Garbage input from a misbehaving client must only ever raise GameError.
function chaos(g, rng) {
  const pick = (arr) => arr[Math.floor(rng() * arr.length)];
  const pid = pick([...g.players.map((p) => p.id), 'nobody']);
  const junk = pick([undefined, null, -1, 99, 'x', 1.5, [], {}, [0, 0], [0, 99]]);
  const attempts = [
    () => g.drawDeck(pid),
    () => g.takeDiscard(pid),
    () => g.callCabo(pid),
    () => g.exchange(pid, junk),
    () => g.match(pid, junk),
    () => g.discardDrawn(pid),
    () => g.usePower(pid, { own: junk, pid: pick(g.players).id, slot: junk }),
    () => g.usePower(pid, junk ?? {}),
    () => g.finishReveal(pid, junk),
    () => g.peekPick(pid, junk),
    () => g.snap(pid, { pid: pick(g.players).id, slot: junk, give: junk }),
    () => g.snap(pid, junk ?? {}),
    () => g.nextRound(),
  ];
  try {
    pick(attempts)();
  } catch (e) {
    if (!(e instanceof GameError)) throw e;
  }
}

test('random games keep every invariant', () => {
  let finished = 0;
  for (let seed = 1; seed <= 250; seed++) {
    const rng = seededRng(seed);
    const n = 2 + (seed % 9);
    const g = new Game(players(n), randomRules(rng), { rng });
    for (let step = 0; step < 4000 && g.phase !== 'gameOver'; step++) {
      if (rng() < 0.15) chaos(g, rng);
      else if (rng() < 0.004 && g.players.length > 2) g.removePlayer(g.players[Math.floor(rng() * g.players.length)].id);
      else randomMove(g, rng);
      checkInvariants(g);
    }
    if (g.phase === 'gameOver') finished++;
  }
  assert.ok(finished > 200, `only ${finished}/250 random games finished`);
});

test('bot-only games always finish', () => {
  for (let seed = 1; seed <= 150; seed++) {
    const rng = seededRng(1000 + seed);
    const n = 2 + (seed % 9);
    const g = new Game(players(n), randomRules(rng), { rng });
    let steps = 0;
    while (g.phase !== 'gameOver') {
      if (g.phase === 'roundEnd') g.nextRound();
      else {
        const pid = g.phase === 'peek' ? [...g.peek.entries()].find(([, s]) => !s.ready)[0] : g.turn.pid;
        assert.ok(botStep(g, pid, rng), 'bot had nothing to do on its own turn');
      }
      if (steps % 7 === 0) checkInvariants(g);
      assert.ok(++steps < 60000, `bot game ${seed} (${n} players) did not finish`);
    }
    assert.ok(g.winners.length >= 1);
  }
});
