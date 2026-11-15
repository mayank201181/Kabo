// Room-level tests: timers, bots and pauses, on a mocked clock so nothing has to wait.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Room } from '../server/rooms.js';
import { botSnapSlot } from '../server/bot.js';
import { seededRng } from '../server/util.js';

let socks = 0;
const sock = () => ({ id: `sock${++socks}`, data: {}, emit() {} });

// What the socket layer does with every command, accepted or not.
function cmd(room, m, type, args = {}) {
  try {
    room.command(m.id, { type, ...args });
    return null;
  } catch (e) {
    return e.message;
  } finally {
    room.afterChange();
  }
}

function table(t, { people = ['Host'], bots = 0, timer = 0, timing = {} } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const room = new Room('TEST', { rng: seededRng(11), timing });
  const sockets = people.map(() => sock());
  const members = people.map((name, i) => room.join(name, `token-for-${name}`, sockets[i]));
  room.afterChange();
  for (let i = 0; i < bots; i++) cmd(room, members[0], 'addBot');
  cmd(room, members[0], 'settings', { settings: { turnTimer: timer } });
  return { room, members, sockets, host: members[0], bot: room.list().find((m) => m.bot) };
}

// Skip the opening peek (nobody has looked at anything) with `first` to play.
function begin(room, first) {
  const g = room.game;
  g.startPid = first.id;
  for (const p of g.players) g.peekReady(p.id);
  room.afterChange();
  return g;
}

// Turn the card object `target` into the card `code` ('QS'), swapping with wherever that card is.
function put(g, target, code) {
  const all = [...g.deck, ...g.discard, ...g.players.flatMap((p) => p.hand.filter(Boolean).map((x) => x.card))];
  const want = all.find((c) => c.r + c.s === code);
  const old = { ...target };
  Object.assign(target, want);
  Object.assign(want, old);
}

const count = (room, t) => room.log.filter((e) => e.t === t).length;

test('removing a computer player while its out-of-turn match is pending does not throw', (t) => {
  const { room, host } = table(t, { bots: 2 });
  cmd(room, host, 'start');
  const [bot, other] = room.list().filter((m) => m.bot);
  const g = begin(room, host);
  put(g, g.deck.at(-1), '7S');
  const card = g.player(bot.id).hand[0].card;
  put(g, card, '7H');
  g.known.get(bot.id).add(card.id); // the bot knows it holds a 7
  assert.equal(cmd(room, host, 'drawDeck'), null);
  assert.equal(cmd(room, host, 'discard'), null);
  assert.equal(botSnapSlot(g, bot.id), 0);
  assert.equal(botSnapSlot(g, other.id), null);
  assert.ok(room.timers.snap, 'the bot is about to throw its 7');

  t.mock.timers.tick(300);
  assert.equal(cmd(room, host, 'kick', { id: bot.id }), null);
  assert.equal(g.players.length, 2);
  assert.equal(g.phase, 'turn');
  assert.doesNotThrow(() => t.mock.timers.tick(3000), 'the pending timer must cope with the bot being gone');
  assert.equal(botSnapSlot(g, bot.id), null, 'someone who left has nothing to throw');
  assert.equal(count(room, 'snap'), 0);
  room.destroy();
});

test('changing the turn timer mid-turn starts a fresh countdown instead of passing the turn', (t) => {
  const { room, members: [host, bunty] } = table(t, { people: ['Host', 'Bunty'] }); // timer Off
  cmd(room, host, 'start');
  const g = room.game;
  t.mock.timers.tick(40_000); // 40 s into the opening peek, nobody has looked yet
  cmd(room, host, 'settings', { settings: { turnTimer: 30 } });
  t.mock.timers.tick(1000);
  assert.equal(g.phase, 'peek', 'nobody is hurried through the peek');
  assert.ok(room.viewFor(bunty.id).timer.left > 28_000);

  cmd(room, host, 'settings', { settings: { turnTimer: 0 } });
  cmd(room, host, 'peekReady');
  cmd(room, bunty, 'peekReady');
  const thinker = room.members.get(g.turn.pid);
  cmd(room, thinker, 'drawDeck');
  t.mock.timers.tick(40_000); // thinking, with the timer Off
  cmd(room, host, 'settings', { settings: { turnTimer: 120 } });
  t.mock.timers.tick(35_000);
  cmd(room, host, 'settings', { settings: { turnTimer: 30 } }); // 85 s were left
  t.mock.timers.tick(1000);
  assert.equal(count(room, 'timeout'), 0);
  assert.equal(`${g.turn.pid}:${g.turn.stage}`, `${thinker.id}:decide`);
  assert.ok(room.viewFor(thinker.id).timer.left > 28_000);
  t.mock.timers.tick(30_000);
  assert.equal(count(room, 'timeout'), 1, 'and it runs out 30 s later');
  room.destroy();
});

test('after a person matches first, a bot that is next still waits so they can throw another card', (t) => {
  const { room, host, bot } = table(t, { bots: 1 }); // default timing: bots pause 0.9-1.7 s, snapWait 2.9 s
  cmd(room, host, 'start');
  const g = begin(room, host);
  const mine = g.player(host.id).hand;
  put(g, g.deck.at(-1), 'QS');
  put(g, mine[0].card, 'QH');
  put(g, mine[1].card, 'QD');
  assert.equal(cmd(room, host, 'drawDeck'), null);
  assert.equal(cmd(room, host, 'discard'), null); // Q♠ is the fresh discard and the bot is next
  t.mock.timers.tick(500);
  assert.equal(cmd(room, host, 'snap', { target: { pid: host.id, slot: 0 } }), null);
  assert.equal(room.viewFor(host.id).game.snap.open, true, 'the first matcher may throw more');
  t.mock.timers.tick(2000);
  assert.equal(`${g.turn.pid}:${g.turn.stage}`, `${bot.id}:draw`, 'the bot is still waiting');
  assert.equal(cmd(room, host, 'snap', { target: { pid: host.id, slot: 1 } }), null);
  assert.equal(room.log.filter((e) => e.t === 'snap' && e.result === 'ok').length, 2);
  t.mock.timers.tick(3000);
  assert.notEqual(`${g.turn.pid}:${g.turn.stage}`, `${bot.id}:draw`, 'then the bot gets on with its turn');
  room.destroy();
});

test("commands that change nothing don't push back a computer player's move", (t) => {
  const { room, host, bot } = table(t, { bots: 1 });
  cmd(room, host, 'start');
  const watcher = room.join('Stranger', 'token-for-Stranger', sock()); // joins mid-game, so only watches
  const g = begin(room, bot);
  for (let i = 0; i < 20; i++) {
    assert.match(cmd(room, watcher, 'snap'), /watching/);
    t.mock.timers.tick(500); // faster than any bot pause, for 10 s
  }
  assert.equal(g.turn.pid, host.id, 'the bot has played its turn');
  room.destroy();
});

test("a pause doesn't use up an offline player's grace", (t) => {
  const { room, members: [host, bunty], sockets } = table(t, { people: ['Host', 'Bunty'] }); // timer Off
  cmd(room, host, 'start');
  const g = begin(room, bunty);
  cmd(room, bunty, 'drawDeck');
  t.mock.timers.tick(35_000); // Bunty thinks
  cmd(room, host, 'pause');
  t.mock.timers.tick(60_000);
  room.detach(sockets[1]); // her phone goes to sleep during the pause
  t.mock.timers.tick(600_000);
  cmd(room, host, 'resume');
  t.mock.timers.tick(1000);
  assert.equal(count(room, 'timeout'), 0, 'not passed the moment the game resumes');
  assert.equal(`${g.turn.pid}:${g.turn.stage}`, `${bunty.id}:decide`);
  const timer = room.viewFor(host.id).timer;
  assert.equal(timer.reason, 'offline');
  assert.ok(timer.left > 28_000, `left: ${timer.left}`);
  t.mock.timers.tick(30_000);
  assert.equal(count(room, 'timeout'), 1, 'passed after the usual 30 s');
  room.destroy();
});

test("in the opening peek an offline player's countdown is shown as theirs, not as everyone's", (t) => {
  const off = table(t, { people: ['Host', 'Bunty', 'Chintu'] }); // timer Off
  const [host, bunty, chintu] = off.members;
  cmd(off.room, host, 'start');
  off.room.detach(off.sockets[2]);
  let timer = off.room.viewFor(bunty.id).timer;
  assert.deepEqual([timer.pid, timer.reason, timer.total], [chintu.id, 'offline', 30_000]);
  t.mock.timers.tick(31_000);
  assert.equal(off.room.game.peek.get(chintu.id).ready, true);
  assert.equal(off.room.game.peek.get(bunty.id).ready, false);
  assert.equal(off.room.viewFor(bunty.id).timer, null, 'with the timer Off, Bunty has no countdown');
  off.room.destroy();
  t.mock.timers.reset();

  // With a turn timer, someone still looking sees their own clock; someone who is ready sees who they wait for.
  const on = table(t, { people: ['Host', 'Bunty', 'Chintu'], timer: 45 });
  const [h2, b2, c2] = on.members;
  cmd(on.room, h2, 'start');
  cmd(on.room, h2, 'peekReady');
  t.mock.timers.tick(5000);
  on.room.detach(on.sockets[2]);
  timer = on.room.viewFor(b2.id).timer;
  assert.deepEqual([timer.pid, timer.reason, timer.total, timer.left], [null, 'peek', 45_000, 40_000]);
  timer = on.room.viewFor(h2.id).timer;
  assert.deepEqual([timer.pid, timer.reason, timer.total, timer.left], [c2.id, 'offline', 30_000, 30_000]);
  on.room.destroy();
});

test('once a person taps Snap, a computer player that is next holds its draw so the throw can be finished', (t) => {
  const { room, host, bot } = table(t, { bots: 1 }); // default timing: a bot draws 2.9 s after a discard
  cmd(room, host, 'start');
  const g = begin(room, host);
  put(g, g.deck.at(-1), 'QS');
  put(g, g.player(bot.id).hand[2].card, 'QH');
  assert.equal(cmd(room, host, 'drawDeck'), null);
  assert.equal(cmd(room, host, 'discard'), null); // the Queen of spades is the fresh discard and the bot is next
  t.mock.timers.tick(2000);
  assert.equal(cmd(room, host, 'snapping'), null); // taps Snap, then looks for the bot's Queen
  t.mock.timers.tick(2500);
  assert.equal(`${g.turn.pid}:${g.turn.stage}`, `${bot.id}:draw`, 'still waiting 4.5 s after the discard');
  // Throw the bot's Queen and give it a card in return.
  assert.equal(cmd(room, host, 'snap', { target: { pid: bot.id, slot: 2, give: 0 } }), null);
  assert.equal(room.log.filter((e) => e.t === 'snap' && e.result === 'ok' && e.owner === bot.id && e.gave === 0).length, 1);
  assert.equal(g.player(host.id).hand[0], null);
  // Tapping Snap again buys no more time for the same discard.
  assert.equal(cmd(room, host, 'snapping'), null);
  t.mock.timers.tick(3000);
  assert.notEqual(`${g.turn.pid}:${g.turn.stage}`, `${bot.id}:draw`, 'then the bot gets on with its turn');
  room.destroy();
});

test("tapping Snap doesn't hold anything for people who can't match", (t) => {
  const { room, host, bot } = table(t, { bots: 1 });
  cmd(room, host, 'start');
  const watcher = room.join('Stranger', 'token-for-Stranger-2', sock());
  const g = begin(room, host);
  assert.equal(cmd(room, host, 'drawDeck'), null);
  assert.equal(cmd(room, host, 'discard'), null);
  t.mock.timers.tick(2000);
  cmd(room, watcher, 'snapping'); // only watching
  assert.equal(room.snapHold, null);
  t.mock.timers.tick(1000);
  assert.notEqual(`${g.turn.pid}:${g.turn.stage}`, `${bot.id}:draw`, 'the bot drew after its usual 2.9 s');
  room.destroy();
});
