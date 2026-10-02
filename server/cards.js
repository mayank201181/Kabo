// The house-rules deck: one standard 52-card pack.
// Suits in Hindi: Hukum ♠ (S), Chidi ♣ (C), Paan ♥ (H), Eent ♦ (D).

export const SUITS = ['S', 'H', 'C', 'D'];
export const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

export function makeDeck() {
  const deck = [];
  let id = 0;
  for (const s of SUITS) for (const r of RANKS) deck.push({ id: id++, r, s });
  return deck;
}

export const isRed = (c) => c.s === 'H' || c.s === 'D';

// A = 1, 2–10 face value, J = 11, Q = 12, black K = 13, red K = −1.
export function cardValue(c) {
  switch (c.r) {
    case 'A': return 1;
    case 'J': return 11;
    case 'Q': return 12;
    case 'K': return isRed(c) ? -1 : 13;
    default: return Number(c.r);
  }
}

// Powers are only usable when the card is drawn from the deck and discarded.
//   7, 8  peek      look at one of your own cards
//   9, 10 spy       look at one of someone else's cards
//   J, Q  swap      blind swap one of yours with one of theirs
//   K     lookswap  look at one of yours and one of theirs, then optionally swap
//                   (red Kings only when rules.redKingPower is on)
export function cardPower(c, rules) {
  switch (c.r) {
    case '7': case '8': return 'peek';
    case '9': case '10': return 'spy';
    case 'J': case 'Q': return 'swap';
    case 'K': return isRed(c) && !rules.redKingPower ? null : 'lookswap';
    default: return null;
  }
}

// What clients get to see of a card: never the internal id.
export const face = (c) => ({ r: c.r, s: c.s });

// Q, Q, K♠, K♣ and nothing else (the only two 13s in the pack).
export function isKamikaze(cards) {
  if (cards.length !== 4) return false;
  const v = cards.map(cardValue).sort((a, b) => a - b);
  return v[0] === 12 && v[1] === 12 && v[2] === 13 && v[3] === 13;
}
