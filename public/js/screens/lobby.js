import { h } from '../h.js';
import { SUIT } from '../cards.js';

export const TIMER_CHOICES = [
  [0, 'Off'],
  [30, '30s'],
  [45, '45s'],
  [60, '60s'],
  [90, '90s'],
  [120, '2m'],
];

export function seg(options, value, onPick, disabled = false) {
  return h(
    'div.seg',
    options.map(([val, label]) =>
      h('button', { type: 'button', class: { on: val === value }, disabled, onClick: () => val !== value && onPick(val) }, label),
    ),
  );
}

function toggle(label, hint, on, onChange, disabled) {
  return h(
    'label.switch',
    { class: { ro: disabled } },
    h('input', { type: 'checkbox', checked: on, disabled, onChange: (e) => onChange(e.target.checked) }),
    h('span.track'),
    h('span.txt', h('b', label), hint && h('small', hint)),
  );
}

export function memberRow(ctx, m, { tools = false } = {}) {
  const v = ctx.view;
  const isMe = m.id === v.me;
  return h(
    'li.member',
    h('span.dot', { class: { on: m.connected } }),
    h('span.nm', m.name),
    m.bot && h('span.tag', 'computer'),
    m.id === v.host && h('span.tag.host', 'host'),
    isMe && h('span.tag.you', 'you'),
    !m.connected && !m.bot && h('span.tag', 'offline'),
    tools &&
      !isMe && [
        !m.bot && h('button.mini-btn', { onClick: () => ctx.send('makeHost', { id: m.id }) }, 'Make host'),
        h(
          'button.mini-btn.danger',
          {
            onClick: () =>
              ctx.confirm({
                title: `Remove ${m.name}?`,
                text: v.game ? 'Their cards leave the game.' : '',
                yes: 'Remove',
                onYes: () => ctx.send('kick', { id: m.id }),
              }),
          },
          'Remove',
        ),
      ],
  );
}

export function renderLobby(ctx) {
  const v = ctx.view;
  const s = v.settings;
  const isHost = v.host === v.me;
  const players = v.members.filter((m) => m.playing);
  const watchers = v.members.filter((m) => !m.playing);
  const ready = players.filter((m) => m.bot || m.connected).length;
  const hostName = v.members.find((m) => m.id === v.host)?.name ?? 'the host';
  const set = (patch) => ctx.send('settings', { settings: patch });
  const ro = !isHost;

  return h(
    'main.screen.lobby',
    h(
      'header.lobby-head',
      h('button.icon-btn', { 'aria-label': 'Leave room', onClick: () => ctx.confirmLeave() }, '←'),
      h('div.room', h('span.label', 'Room code'), h('span.code', v.code)),
      h('button.icon-btn', { 'aria-label': 'How to play', onClick: () => ctx.openSheet('rules') }, '?'),
    ),
    h(
      'section.invite.panel',
      h('p', 'Invite everyone. They open the link on their phone and type their name.'),
      h(
        'div.row',
        h('a.btn.wa', { href: ctx.whatsappLink(), target: '_blank', rel: 'noopener' }, 'WhatsApp'),
        navigator.share && h('button.btn', { onClick: () => ctx.shareLink() }, 'Share'),
        h('button.btn', { onClick: () => ctx.copyLink() }, 'Copy link'),
      ),
      h('p.link', ctx.roomLink()),
    ),
    h(
      'section.panel',
      h('h2', 'Players ', h('span.count', `${players.length}/10`)),
      h('ul.plist', players.map((m) => memberRow(ctx, m, { tools: isHost }))),
      isHost &&
        players.length < 10 &&
        h('button.btn.ghost.wide', { onClick: () => ctx.send('addBot') }, '+ Add a computer player'),
      watchers.length > 0 && [h('h3', 'Watching'), h('ul.plist', watchers.map((m) => memberRow(ctx, m, { tools: isHost })))],
    ),
    h(
      'section.panel.rules-panel',
      h('h2', 'House rules', ro && h('small', ` (set by ${hostName})`)),
      h('div.setting', h('span', 'Play to'), seg([[50, '50'], [100, '100']], s.target, (x) => set({ target: x }), ro)),
      h('div.setting', h('span', 'Turn timer'), seg(TIMER_CHOICES, s.turnTimer, (x) => set({ turnTimer: x }), ro)),
      toggle(
        'Empty deck: reshuffle',
        s.reshuffle ? 'The discard pile is shuffled into a new deck' : 'Official rule: the round ends',
        s.reshuffle,
        (x) => set({ reshuffle: x }),
        ro,
      ),
      toggle(
        'Pick up from the discard pile',
        s.takeDiscard ? 'Official rule: instead of drawing, you may take the top discard' : 'Everyone always draws from the deck',
        s.takeDiscard,
        (x) => set({ takeDiscard: x }),
        ro,
      ),
      s.takeDiscard &&
        toggle(
          'Discard pickups stay face-up',
          s.faceUpPickups ? 'Everyone can see cards taken from the discard pile' : 'Expert: every card stays face-down',
          s.faceUpPickups,
          (x) => set({ faceUpPickups: x }),
          ro,
        ),
      toggle(`Red Kings (K${SUIT.H} K${SUIT.D}) can Look & swap`, 'They are worth −1 either way', s.redKingPower, (x) => set({ redKingPower: x }), ro),
      toggle("Lock the caller's cards", "After Kabo, nobody can swap the caller's cards", s.lockCaller, (x) => set({ lockCaller: x }), ro),
      toggle(
        'Match out of turn (snap)',
        "First to throw a matching card on a fresh discard gets rid of it; late or wrong = penalty. You can match someone else's card too, then give them one of yours.",
        s.snap,
        (x) => set({ snap: x }),
        ro,
      ),
      toggle(
        `Kamikaze (Q Q K${SUIT.S} K${SUIT.C})`,
        `Scores 0, and everyone else gets ${s.target / 2}`,
        s.kamikaze,
        (x) => set({ kamikaze: x }),
        ro,
      ),
    ),
    h(
      'footer.lobby-foot',
      isHost
        ? h(
            'button.btn.primary.big',
            { disabled: ready < 2, onClick: () => ctx.send('start') },
            ready < 2 ? 'Waiting for at least 2 players' : `Start game (${ready} players)`,
          )
        : h('p.wait', `Waiting for ${hostName} to start the game…`),
    ),
  );
}
