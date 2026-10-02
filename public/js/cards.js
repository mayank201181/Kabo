// Card faces, values and wording shared by every screen.

import { h } from './h.js';

export const SUIT = { S: '♠', H: '♥', C: '♣', D: '♦' };
export const SUIT_HINDI = { S: 'Hukum', C: 'Chidi', H: 'Paan', D: 'Eent' };

export const isRed = (c) => c.s === 'H' || c.s === 'D';
export const cardText = (c) => `${c.r}${SUIT[c.s]}`;

export function cardValue(c) {
  switch (c.r) {
    case 'A': return 1;
    case 'J': return 11;
    case 'Q': return 12;
    case 'K': return isRed(c) ? -1 : 13;
    default: return Number(c.r);
  }
}

export function cardPower(c, rules) {
  switch (c.r) {
    case '7': case '8': return 'peek';
    case '9': case '10': return 'spy';
    case 'J': case 'Q': return 'swap';
    case 'K': return isRed(c) && !rules.redKingPower ? null : 'lookswap';
    default: return null;
  }
}

export const POWERS = {
  peek: { name: 'Peek', icon: '👁', what: 'look at one of your cards' },
  spy: { name: 'Spy', icon: '🔍', what: "look at someone else's card" },
  swap: { name: 'Swap', icon: '🔄', what: 'swap one of yours with one of theirs, without looking' },
  lookswap: { name: 'Look & swap', icon: '👑', what: 'see one of yours and one of theirs, then swap or not' },
};

export const fmtValue = (n) => (n < 0 ? `−${-n}` : String(n));

// size: 'lg' (your hand), 'md' (piles, drawn card), 'sm' (other players)
export function cardEl(c, { size = 'md', rules = null, key, extra } = {}) {
  if (!c) return h('div.card.back', { class: [size, extra], dataset: key ? { key } : undefined });
  const red = isRed(c);
  const face = c.r === 'J' || c.r === 'Q' || c.r === 'K';
  const power = rules ? cardPower(c, rules) : null;
  const v = cardValue(c);
  return h(
    'div.card.face',
    { class: [size, extra, { red, court: face }], dataset: key ? { key } : undefined, 'aria-label': cardText(c) },
    h('span.ix', c.r, h('i', SUIT[c.s])),
    h('span.pip', face ? c.r : SUIT[c.s]),
    face && h('span.pip-suit', SUIT[c.s]),
    size !== 'sm' && h('span.ix.br', c.r, h('i', SUIT[c.s])),
    size !== 'sm' && c.r === 'K' && h('span.val', { class: { neg: v < 0 } }, fmtValue(v)),
    size === 'lg' && power && h('span.pw', POWERS[power].icon),
  );
}

export const backEl = (opts = {}) => cardEl(null, opts);
