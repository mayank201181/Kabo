// Simple, fair computer players. A bot only uses what a human in its seat
// would know: face-up cards, its own peeks/spies, and public moves.

import { cardValue, cardPower } from './cards.js';

const UNKNOWN = 6.5; // average card value in the house-rules deck

function mine(game, pid) {
  const seen = game.known.get(pid);
  return game.player(pid).hand.flatMap((s, i) => {
    if (!s) return [];
    const known = s.up || seen.has(s.card.id);
    return [{ i, known, v: known ? cardValue(s.card) : UNKNOWN }];
  });
}

function theirs(game, pid, { faceDownOnly = false, swappable = false } = {}) {
  const seen = game.known.get(pid);
  const out = [];
  for (const p of game.players) {
    if (p.id === pid) continue;
    if (swappable && game.rules.lockCaller && game.caboBy === p.id) continue;
    p.hand.forEach((s, slot) => {
      if (!s || (faceDownOnly && s.up)) return;
      const known = s.up || seen.has(s.card.id);
      out.push({ pid: p.id, slot, known, v: known ? cardValue(s.card) : UNKNOWN });
    });
  }
  return out;
}

const pick = (arr, rng) => arr[Math.floor(rng() * arr.length)];
const lowest = (arr) => arr.reduce((a, b) => (b.v < a.v ? b : a));
const highest = (arr) => arr.reduce((a, b) => (b.v > a.v ? b : a));

// Best opponent card to take: a known low card, otherwise a random unknown one.
function swapTarget(game, pid, worst, rng) {
  const options = theirs(game, pid, { swappable: true });
  const better = options.filter((o) => o.known && o.v < worst.v);
  if (better.length) return lowest(better);
  const unknown = options.filter((o) => !o.known);
  return unknown.length && worst.v > UNKNOWN ? pick(unknown, rng) : null;
}

// Performs exactly one action for the bot. Returns false if it had nothing to do.
export function botStep(game, pid, rng = Math.random) {
  if (game.phase === 'peek') {
    const st = game.peek.get(pid);
    if (!st || st.ready) return false;
    const hand = game.player(pid).hand;
    for (let i = 0; i < hand.length && st.picks.length < 2; i++) {
      if (hand[i] && !st.picks.includes(i)) game.peekPick(pid, i);
    }
    game.peekReady(pid);
    return true;
  }
  if (game.phase !== 'turn' || game.turn.pid !== pid) return false;

  const t = game.turn;
  const cards = mine(game, pid);
  const worst = highest(cards);
  const unknown = cards.filter((c) => !c.known);
  const estimate = cards.reduce((a, c) => a + c.v, 0);

  if (t.stage === 'draw') {
    // Get braver the longer the round drags on. With many players and a
    // reshuffled deck only a few cards circulate, so a bot may never learn
    // its whole hand; it still has to end the round eventually.
    const laps = game.turnCount / game.players.length;
    const threshold = (unknown.length === 0 ? 8 : 5) + 2 * laps;
    if (!game.caboBy && (estimate <= threshold || laps >= 12)) {
      game.callCabo(pid);
      return true;
    }
    const top = game.discard.at(-1);
    if (game.rules.takeDiscard && top && cardValue(top) <= 3 && cardValue(top) < worst.v - 1) game.takeDiscard(pid);
    else game.drawDeck(pid);
    return true;
  }

  if (t.stage === 'decide') {
    const v = cardValue(t.drawn);
    if (t.from === 'deck') {
      // Throw away known cards of the same rank when that beats keeping the card.
      const hand = game.player(pid).hand;
      const same = cards.filter((c) => c.known && c.v > 0 && hand[c.i].card.r === t.drawn.r);
      const gain = same.reduce((a, c) => a + c.v, 0);
      if (gain > 0 && gain >= worst.v - v) {
        game.match(pid, same.map((c) => c.i));
        return true;
      }
    }
    if (t.from === 'discard' || v < worst.v - (worst.known ? 0 : 1.5)) {
      game.exchange(pid, [worst.i]);
      return true;
    }
    const power = cardPower(t.drawn, game.rules);
    if (power === 'peek' && unknown.length) {
      game.usePower(pid, { own: unknown[0].i });
      return true;
    }
    if (power === 'spy') {
      const targets = theirs(game, pid, { faceDownOnly: true }).filter((o) => !o.known);
      if (targets.length) {
        const o = pick(targets, rng);
        game.usePower(pid, { pid: o.pid, slot: o.slot });
        return true;
      }
    }
    if (power === 'swap' && worst.known && worst.v >= 7) {
      const o = swapTarget(game, pid, worst, rng);
      if (o) {
        game.usePower(pid, { own: worst.i, pid: o.pid, slot: o.slot });
        return true;
      }
    }
    if (power === 'lookswap') {
      const targets = theirs(game, pid, { swappable: true });
      if (targets.length) {
        const o = swapTarget(game, pid, worst, rng) ?? pick(targets, rng);
        game.usePower(pid, { own: worst.i, pid: o.pid, slot: o.slot });
        return true;
      }
    }
    game.discardDrawn(pid);
    return true;
  }

  if (t.stage === 'reveal') {
    const { power, cards: shown } = t.reveal;
    if (power === 'lookswap') {
      const [a, b] = shown.map((x) => cardValue(game.player(x.pid).hand[x.slot].card));
      game.finishReveal(pid, b < a);
    } else {
      game.finishReveal(pid);
    }
    return true;
  }
  return false;
}

// A known card of the bot's own that matches the fresh discard (never a red
// King, which is worth keeping). Bots only ever match their own cards.
export function botSnapSlot(game, pid) {
  const win = game.snapWin;
  if (!win || (win.by && win.by !== pid) || game.phase !== 'turn' || game.caboBy === pid) return null;
  const seen = game.known.get(pid);
  const t = game.turn;
  const hand = game.player(pid).hand;
  for (let i = 0; i < hand.length; i++) {
    const s = hand[i];
    if (!s || !(s.up || seen.has(s.card.id)) || s.card.r !== win.card.r || cardValue(s.card) <= 0) continue;
    if (t.stage === 'reveal' && t.reveal.cards.some((x) => x.pid === pid && x.slot === i)) continue;
    return i;
  }
  return null;
}
