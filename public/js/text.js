// Turns game events into plain sentences for the ticker, log and toasts.

import { cardText, POWERS } from './cards.js';

export function namer(v) {
  const names = new Map();
  for (const m of v.members) names.set(m.id, m.name);
  for (const p of v.game?.players ?? []) names.set(p.id, p.name);
  return (pid, fallback = 'Someone') => (pid === v.me ? 'You' : names.get(pid) ?? fallback);
}

export function describe(ev, v) {
  const name = namer(v);
  const N = name(ev.pid, ev.name);
  const own = (pid) => (pid === v.me ? 'your' : 'their');
  const ref = (pid, slot, actor) =>
    pid === actor ? `${own(pid)} card ${slot + 1}` : pid === v.me ? `your card ${slot + 1}` : `${name(pid)}'s card ${slot + 1}`;

  switch (ev.t) {
    case 'start': return 'New game!';
    case 'round': return `Round ${ev.round}: everyone looks at 2 of their cards`;
    case 'draw':
      return ev.from === 'deck' ? `${N} drew from the deck` : `${N} took the ${cardText(ev.c)} from the discard pile`;
    case 'discard': return `${N} discarded the ${cardText(ev.c)}`;
    case 'putback': return `${N} put the ${cardText(ev.c)} back`;
    case 'exchange': {
      const what = ev.from === 'discard' ? `the ${cardText(ev.c)}` : 'the drawn card';
      return `${N} swapped ${own(ev.pid)} card ${ev.into + 1} (${cardText(ev.out[0])}) for ${what}`;
    }
    case 'match': {
      const hit = ev.out.length ? `${N} matched the ${cardText(ev.c)} with ${own(ev.pid)} ${ev.out.map(cardText).join(' ')}` : '';
      if (!ev.shown.length) return hit;
      const pen = ev.added.length === 1 ? 'a penalty card' : `${ev.added.length} penalty cards`;
      const miss = `${ev.shown.map(cardText).join(' ')} didn't match, so ${ev.pid === v.me ? 'you get' : 'they get'} ${pen}`;
      return hit ? `${hit}, but ${miss}` : `${N} tried to match the ${cardText(ev.c)}, but ${own(ev.pid)} ${miss}`;
    }
    case 'snap': {
      if (ev.result === 'late') return `${N} ${ev.pid === v.me ? 'were' : 'was'} too late to match the ${cardText(ev.c)}: penalty card`;
      const card = ref(ev.owner, ev.slot, ev.pid);
      if (ev.result === 'wrong') return `${N} tried to match the ${cardText(ev.c)} with ${card}, but it was the ${cardText(ev.shown)}: penalty card`;
      if (ev.owner === ev.pid) return `${N} matched the ${cardText(ev.c)} out of turn with ${own(ev.pid)} ${cardText(ev.out)}!`;
      const them = ev.owner === v.me ? 'you' : name(ev.owner);
      return `${N} matched ${ev.owner === v.me ? 'your' : `${name(ev.owner)}'s`} ${cardText(ev.out)} on the ${cardText(ev.c)} and gave ${them} one of ${own(ev.pid)} cards`;
    }
    case 'power': return `${N} played the ${cardText(ev.c)}: ${POWERS[ev.power].name}`;
    case 'peek': return `${N} peeked at ${own(ev.pid)} card ${ev.slot + 1}`;
    case 'spy': return `${N} spied on ${ref(ev.b.pid, ev.b.slot, ev.pid)}`;
    case 'look': return `${N} looked at ${ref(ev.a.pid, ev.a.slot, ev.pid)} and ${ref(ev.b.pid, ev.b.slot, ev.pid)}`;
    case 'swap':
      return `${N} swapped ${ref(ev.a.pid, ev.a.slot, ev.pid)} with ${ref(ev.b.pid, ev.b.slot, ev.pid)}${ev.blind ? ' without looking' : ''}`;
    case 'noswap': return `${N} decided not to swap`;
    case 'cabo': return `${N} called KABO! Everyone else gets one last turn`;
    case 'reshuffle': return `Deck empty: the discard pile was shuffled into a new deck (${ev.n} cards)`;
    case 'timeout': return `${N} ran out of time`;
    case 'roundEnd':
      if (ev.reason === 'empty') return `${name(ev.emptied)} got rid of every card: round over`;
      return ev.reason === 'deck' ? 'The deck ran out: round over' : `Round ${ev.round} over`;
    case 'gameOver': {
      const names = ev.winners.map((id) => name(id));
      return `${names.join(' & ')} ${names.length === 1 && names[0] === 'You' ? 'win' : names.length > 1 ? 'win' : 'wins'} the game!`;
    }
    case 'join': return ev.bot ? `${ev.name} (computer) joined` : ev.watching ? `${ev.name} is watching` : `${ev.name} joined`;
    case 'left': return `${ev.name} left`;
    case 'kicked': return `${ev.name} was removed by the host`;
    case 'benched': return ev.pid === v.me ? 'The host took you out of this game' : `${ev.name} was taken out of this game by the host`;
    case 'host': return ev.pid === v.me ? 'You are now the host' : `${N} is now the host`;
    case 'pause': return `${N} paused the game`;
    case 'resume': return `${N} resumed the game`;
    case 'claim': return `${N} asked to take over ${name(ev.seat)}'s seat`;
    case 'claimDenied': return ev.pid === v.me ? 'The host said no to your request' : null;
    case 'takeover': return `${ev.name} took over ${ev.old}'s seat`;
    case 'lobby': return 'Back to the lobby';
    default: return null;
  }
}
