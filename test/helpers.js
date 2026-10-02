import { Game } from '../server/game.js';
import { makeDeck } from '../server/cards.js';
import { seededRng } from '../server/util.js';

// Build a game in a known position and skip the opening peek.
// hands: card codes per player, e.g. [['5S', 'KH', 'QC', '2D'], [...]]
// deck:  codes listed top first (the first one is drawn first)
export function rig(hands, { deck, discard = ['2C'], rules = {}, start = 0, up = [] } = {}) {
  const ids = hands.map((_, i) => ({ id: `p${i}`, name: `P${i}` }));
  const g = new Game(ids, rules, { rng: seededRng(7) });
  const pool = new Map(makeDeck().map((c) => [c.r + c.s, c]));
  const take = (code) => {
    const c = pool.get(code);
    if (!c) throw new Error(`card ${code} is unknown or used twice`);
    pool.delete(code);
    return c;
  };
  g.players.forEach((p, i) => {
    p.hand = hands[i].map((code, slot) => ({ card: take(code), up: up.includes(`${i}:${slot}`) }));
  });
  g.discard = discard.map(take);
  g.deck = deck ? [...deck].reverse().map(take) : [...pool.values()];
  g.known = new Map(g.players.map((p) => [p.id, new Set()]));
  g.startPid = `p${start}`;
  for (const p of g.players) g.peekReady(p.id);
  g.events.length = 0;
  return g;
}

export const codes = (slots) => slots.map((s) => (s ? s.card.r + s.card.s : null));
export const ev = (g, t) => g.events.filter((e) => e.t === t);
