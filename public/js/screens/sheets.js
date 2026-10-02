// Bottom sheets: menu, rules, scores, log, round results, game over, prompts.

import { h } from '../h.js';
import { cardEl, fmtValue, SUIT, SUIT_HINDI, POWERS } from '../cards.js';
import { isMuted } from '../sound.js';
import { namer } from '../text.js';
import { seg, memberRow, TIMER_CHOICES } from './lobby.js';

const DEFAULT_RULES = { target: 50, reshuffle: true, takeDiscard: false, faceUpPickups: true, redKingPower: true, lockCaller: false, kamikaze: true, snap: true, turnTimer: 45 };
const fmtScore = (n) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '0');

function sheet(ctx, title, body, { closable = true, id = '' } = {}) {
  const close = () => ctx.closeSheet();
  return h(
    'div.sheet-wrap',
    { onClick: (e) => closable && e.target === e.currentTarget && close() },
    h(
      'div.sheet',
      { dataset: { sheet: id || title } },
      h('header', h('h2', title), closable && h('button.icon-btn', { 'aria-label': 'Close', onClick: close }, '✕')),
      h('div.sheet-body', body),
    ),
  );
}

export function renderSheet(ctx, name, data) {
  switch (name) {
    case 'rules': return rulesSheet(ctx);
    case 'scores': return scoresSheet(ctx);
    case 'log': return logSheet(ctx);
    case 'menu': return menuSheet(ctx);
    case 'confirm': return confirmSheet(ctx, data);
    default: return null;
  }
}

// ------------------------------------------------------------------ rules

function rulesSheet(ctx) {
  const r = { ...DEFAULT_RULES, ...(ctx.view?.game?.rules ?? ctx.view?.settings ?? {}) };
  return sheet(ctx, 'How to play', [
    h('p.lead', 'Kabo (also called Cabo) is a memory game: end each round with the lowest total.'),
    h('h3', 'Card values'),
    h(
      'ul.rules',
      h('li', 'A = 1, 2–10 = face value, J = 11, Q = 12'),
      h('li', `K${SUIT.S} K${SUIT.C} (${SUIT_HINDI.S}, ${SUIT_HINDI.C}) = 13`),
      h('li', `K${SUIT.H} K${SUIT.D} (${SUIT_HINDI.H}, ${SUIT_HINDI.D}) = −1, the best cards in the game`),
    ),
    h('h3', 'Start of a round'),
    h('p', 'Everyone gets 4 cards face-down. Look at any 2 of them once, then remember them. Cards stay in their places unless someone swaps them.'),
    h('h3', 'On your turn, do one of these'),
    !r.takeDiscard && h('p', "You always draw from the deck. Nobody picks up a card someone else threw away."),
    h(
      'ol.rules',
      h('li', h('b', 'Draw from the deck. '), 'Keep it by swapping it for one of your cards, match it, or discard it.'),
      r.takeDiscard &&
        h(
          'li',
          h('b', 'Take the top discard. '),
          `You must swap it for one of your cards${r.faceUpPickups ? ', and it stays face-up' : ''}.`,
        ),
      h('li', h('b', 'Call Kabo. '), 'Everyone else gets one more turn, then all cards are shown.'),
    ),
    h('h3', 'Powers'),
    h('p', 'If you draw one of these from the deck, you can discard it to use its power:'),
    h(
      'ul.rules',
      h('li', h('b', `7, 8: ${POWERS.peek.icon} ${POWERS.peek.name}. `), POWERS.peek.what),
      h('li', h('b', `9, 10: ${POWERS.spy.icon} ${POWERS.spy.name}. `), POWERS.spy.what),
      h('li', h('b', `J, Q: ${POWERS.swap.icon} ${POWERS.swap.name}. `), POWERS.swap.what),
      h('li', h('b', `K${SUIT.S} K${SUIT.C}: ${POWERS.lookswap.icon} ${POWERS.lookswap.name}. `), POWERS.lookswap.what),
      r.redKingPower && h('li', `K${SUIT.H} K${SUIT.D} can do the same, but they're worth −1, so you'll probably keep them.`),
    ),
    h('h3', 'Matching'),
    h(
      'p',
      'Drew a card from the deck with the same rank as one of yours, like a 2 when you know you have a 2? Tap Match and throw both on the discard pile, so your hand gets smaller. You can match more than one card at a time. If a card you pick does not match, it is turned face-up and you take a penalty card. Get rid of all your cards and the round ends.',
    ),
    r.snap && h('h3', 'Matching out of turn (snap)'),
    r.snap &&
      h(
        'p',
        "Whenever a card lands on the discard pile, anyone can tap Snap and throw a card of the same rank on it, even when it's not their turn. Only the first person gets it: anyone later, or anyone who throws the wrong card, takes a penalty card. You can also throw someone else's card if you know it (say you spied on their 6), and then you give them one of your cards in its place. Once you call Kabo, your cards are final.",
      ),
    h('h3', 'Scoring'),
    h(
      'ul.rules',
      h('li', 'Your score for the round is the total of your cards.'),
      h('li', 'If you called Kabo and have the lowest total (ties count), you score 0, or your total if it is below zero.'),
      h('li', 'If you called Kabo and someone is lower, you score your total + 10.'),
      r.kamikaze && h('li', `Kamikaze: finish with exactly Q, Q, K${SUIT.S}, K${SUIT.C} and you score 0 while everyone else scores ${r.target / 2}.`),
      h('li', `Land exactly on ${r.target} and you drop back to ${r.target / 2} (once per game).`),
      h('li', `The game ends when someone goes over ${r.target}. Lowest total wins.`),
    ),
    h('h3', 'Running out of cards'),
    h('p', r.reshuffle ? 'When the deck runs out, the discard pile is shuffled into a new deck.' : 'When the deck runs out, the round ends.'),
    r.lockCaller && h('p', "After someone calls Kabo, nobody can swap that player's cards."),
  ]);
}

// ----------------------------------------------------------------- scores

function scoresSheet(ctx) {
  const v = ctx.view;
  const g = v?.game;
  if (!g) return sheet(ctx, 'Scores', h('p', 'No game yet.'));
  const rounds = Math.max(0, ...g.players.map((p) => p.history.length));
  const players = [...g.players].sort((a, b) => a.total - b.total);
  const best = players[0]?.total;
  return sheet(ctx, 'Scores', [
    h(
      'div.scroll-x',
      h(
        'table.scores',
        h('thead', h('tr', h('th', 'Player'), Array.from({ length: rounds }, (_, i) => h('th', `R${i + 1}`)), h('th', 'Total'))),
        h(
          'tbody',
          players.map((p) =>
            h(
              'tr',
              { class: { me: p.id === v.me, lead: p.total === best && rounds > 0 } },
              h('td', p.name),
              p.history.map((x) => h('td', fmtScore(x))),
              h('td.tot', String(p.total)),
            ),
          ),
        ),
      ),
    ),
    h('p.muted', `The game ends when someone goes over ${g.rules.target}. Lowest total wins.`),
  ]);
}

// -------------------------------------------------------------------- log

function logSheet(ctx) {
  const lines = [...ctx.S.log].reverse();
  return sheet(ctx, 'Game log', lines.length ? h('ol.log', lines.map((l) => h('li', l.text))) : h('p.muted', 'Nothing yet.'));
}

// ------------------------------------------------------------------- menu

function menuSheet(ctx) {
  const v = ctx.view;
  const g = v?.game;
  const isHost = v?.host === v?.me;
  const item = (icon, label, onClick) => h('button.menu-item', { onClick }, h('span.mi-icon', icon), h('span', label));
  const current = g?.turn ? namer(v)(g.turn.pid) : null;
  return sheet(ctx, 'Menu', [
    h(
      'div.menu-grid',
      item('📖', 'How to play', () => ctx.openSheet('rules')),
      item('🏆', 'Scores', () => ctx.openSheet('scores')),
      item('📜', 'Game log', () => ctx.openSheet('log')),
      item(isMuted() ? '🔇' : '🔊', isMuted() ? 'Sound is off' : 'Sound is on', () => ctx.toggleSound()),
      v && item('🔗', `Invite (${v.code})`, () => ctx.shareLink()),
    ),
    isHost &&
      g &&
      h(
        'section.host-tools',
        h('h3', 'Host controls'),
        h('div.setting', h('span', 'Turn timer'), seg(TIMER_CHOICES, v.settings.turnTimer, (x) => ctx.send('settings', { settings: { turnTimer: x } }))),
        g.phase !== 'gameOver' &&
          h(
            'div.row.wrap',
            v.paused
              ? h('button.btn', { onClick: () => ctx.send('resume') }, '▶ Resume')
              : h('button.btn', { onClick: () => ctx.send('pause') }, '⏸ Pause'),
            g.phase === 'turn' && current && h('button.btn', { onClick: () => ctx.send('skip') }, `⏭ Skip ${current === 'You' ? 'my' : `${current}'s`} turn`),
            g.phase === 'peek' && h('button.btn', { onClick: () => ctx.send('skip') }, '⏭ Start now'),
          ),
        h(
          'button.btn.danger.wide',
          {
            onClick: () =>
              ctx.confirm({
                title: 'End this game?',
                text: 'Scores are cleared and everyone goes back to the lobby.',
                yes: 'End game',
                onYes: () => ctx.send('toLobby'),
              }),
          },
          'End game',
        ),
      ),
    v && h('section', h('h3', 'People in this room'), h('ul.plist', v.members.map((m) => memberRow(ctx, m, { tools: isHost })))),
    v &&
      h(
        'button.btn.danger.ghost.wide',
        {
          onClick: () =>
            ctx.confirm({
              title: 'Leave this room?',
              text: g?.players.some((p) => p.id === v.me) ? 'Your cards leave the game and you cannot get your seat back.' : '',
              yes: 'Leave',
              onYes: () => ctx.send('leave'),
            }),
        },
        'Leave room',
      ),
  ]);
}

function confirmSheet(ctx, { title, text, yes, onYes }) {
  return sheet(ctx, title, [
    text && h('p', text),
    h(
      'div.sheet-actions',
      h(
        'button.btn.primary',
        {
          onClick: () => {
            ctx.closeSheet();
            onYes();
          },
        },
        yes,
      ),
      h('button.btn', { onClick: () => ctx.closeSheet() }, 'Cancel'),
    ),
  ]);
}

// ---------------------------------------------- results, game over, claims

export function resultsSheet(ctx) {
  const v = ctx.view;
  const g = v.game;
  const r = g.results;
  const name = namer(v);
  const isHost = v.host === v.me;
  const hostName = v.members.find((m) => m.id === v.host)?.name ?? 'the host';
  let headline;
  if (r.kamikaze) headline = `💥 Kamikaze by ${name(r.kamikaze)}! Everyone else scores ${g.rules.target / 2}.`;
  else if (r.reason === 'empty') headline = `🎯 ${name(r.emptied)} got rid of every card!`;
  else if (r.caboBy) {
    const row = r.rows.find((x) => x.pid === r.caboBy);
    const who = row ? name(r.caboBy) : r.caboName;
    headline = !row
      ? `${who} called Kabo.`
      : row.callerOk
        ? `✅ ${who} called Kabo and had the lowest total.`
        : `❌ ${who} called Kabo but wasn't the lowest: +10.`;
  } else headline = 'The deck ran out.';
  const rows = [...r.rows].sort((a, b) => a.score - b.score || a.sum - b.sum);
  const over = g.phase === 'gameOver';

  return sheet(
    ctx,
    `Round ${r.round} results`,
    [
      h('p.headline', headline),
      h(
        'div.res',
        h('div.res-row.res-head', h('span', ''), h('span', 'Cards'), h('span', 'Round'), h('span', 'Total')),
        rows.map((row) =>
          h(
            'div.res-row',
            { class: { me: row.pid === v.me } },
            h('span.res-name', name(row.pid, row.name)),
            h('span.res-cards', row.cards.map((c) => cardEl(c, { size: 'sm' })), h('small', `= ${fmtValue(row.sum)}`)),
            h('span.res-score', { class: { adj: row.score !== row.sum } }, fmtScore(row.score)),
            h('span.res-total', String(row.total), row.reset && h('span.badge', '↺ reset')),
          ),
        ),
      ),
      h(
        'div.sheet-actions',
        over
          ? h('button.btn.primary', { onClick: () => ctx.showGameOver() }, 'See the winner')
          : isHost
            ? h('button.btn.primary.big', { onClick: () => ctx.send('nextRound') }, `Start round ${r.round + 1}`)
            : h('p.wait', `Waiting for ${hostName} to start round ${r.round + 1}…`),
        h('button.btn', { onClick: () => ctx.hideResults() }, 'Look at the table'),
      ),
    ],
    { closable: false, id: 'results' },
  );
}

export function gameOverSheet(ctx) {
  const v = ctx.view;
  const g = v.game;
  const name = namer(v);
  const isHost = v.host === v.me;
  const winners = (g.winners ?? []).map((id) => name(id));
  const standings = [...g.players].sort((a, b) => a.total - b.total);
  const iWon = g.winners?.includes(v.me);
  return sheet(
    ctx,
    'Game over',
    [
      h('div.trophy', iWon ? '🎉' : '🏆'),
      h('p.winner', winners.length ? `${winners.join(' & ')} ${winners.length > 1 || iWon ? 'win' : 'wins'}!` : 'Game over'),
      h(
        'ol.standings',
        standings.map((p) =>
          h('li', { class: { me: p.id === v.me, win: g.winners?.includes(p.id) } }, h('span', name(p.id)), h('b', String(p.total))),
        ),
      ),
      h(
        'div.sheet-actions',
        isHost
          ? h('button.btn.primary.big', { onClick: () => ctx.send('toLobby') }, 'Play again')
          : h('p.wait', 'Waiting for the host to start a new game…'),
        g.results && h('button.btn', { onClick: () => ctx.showResults() }, 'Last round'),
        h('button.btn', { onClick: () => ctx.hideResults() }, 'Look at the table'),
      ),
    ],
    { closable: false, id: 'gameover' },
  );
}

export function claimSheet(ctx, claim) {
  const name = namer(ctx.view);
  return sheet(
    ctx,
    'Seat request',
    [
      h('p', `${name(claim.from)} wants to take over ${name(claim.seat)}'s seat (${name(claim.seat)} is offline).`),
      h('p.muted', 'Say yes if it is the same person on a new phone, or someone playing on their behalf.'),
      h(
        'div.sheet-actions',
        h('button.btn.primary', { onClick: () => ctx.send('resolveClaim', { id: claim.id, allow: true }) }, 'Allow'),
        h('button.btn', { onClick: () => ctx.send('resolveClaim', { id: claim.id, allow: false }) }, 'Say no'),
      ),
    ],
    { closable: false, id: 'claim' },
  );
}
