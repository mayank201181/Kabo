// End-to-end: real Socket.IO clients against the real server, with short
// timers so offline/timeout paths run quickly.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { io as connect } from 'socket.io-client';
import { createApp } from '../server/index.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let srv;
let url;

before(async () => {
  srv = createApp({ timing: { botMin: 5, botMax: 15, offlineGrace: 400, hostGrace: 300, peekMin: 400, revealMax: 400 } });
  await new Promise((r) => srv.server.listen(0, r));
  url = `http://localhost:${srv.server.address().port}`;
});

after(() => {
  srv.rooms.close();
  srv.io.close();
  srv.server.close();
});

let tokenSeq = 0;
class Client {
  constructor(name, token = `test-token-${name}-${++tokenSeq}`) {
    this.name = name;
    this.token = token;
    this.view = null;
    this.events = [];
    this.removed = null;
    this.connect();
  }

  connect() {
    this.socket = connect(url, { transports: ['websocket'], forceNew: true, reconnection: false });
    this.socket.on('state', (m) => {
      this.view = m.view;
      this.events.push(...m.events);
      checkNoLeaks(m.view);
    });
    this.socket.on('removed', (m) => (this.removed = m.why));
  }

  emit(ev, data) {
    return new Promise((res) => this.socket.emit(ev, data, res));
  }

  create() {
    return this.emit('create', { name: this.name, token: this.token });
  }

  join(code) {
    return this.emit('join', { code, name: this.name, token: this.token });
  }

  cmd(type, args = {}) {
    return this.emit('cmd', { type, ...args });
  }

  async until(pred, ms = 4000) {
    const t0 = Date.now();
    while (!(this.view && pred(this.view))) {
      if (Date.now() - t0 > ms) throw new Error(`${this.name}: timed out waiting`);
      await sleep(5);
    }
    return this.view;
  }

  close() {
    this.socket.close();
  }
}

// A face-down card may only appear in your view during your opening peek or
// while you're using a power on it.
function checkNoLeaks(v) {
  const g = v.game;
  if (!g || g.phase === 'roundEnd' || g.phase === 'gameOver') return;
  for (const p of g.players) {
    p.slots.forEach((s, i) => {
      if (!s || s.up || !s.c) return;
      const peekOk = g.phase === 'peek' && p.id === v.me && g.peek && !g.peek.ready && g.peek.picks.includes(i);
      const revealOk = g.turn?.stage === 'reveal' && g.turn.pid === v.me && g.turn.reveal.cards.some((r) => r.pid === p.id && r.slot === i);
      assert.ok(peekOk || revealOk, `hidden card leaked to ${v.me}`);
    });
  }
  if (g.turn?.drawn) assert.ok(g.turn.pid === v.me || g.turn.from === 'discard', 'drawn card leaked');
}

// A legal (if not clever) move for whoever is looking at this view.
function chooseMove(v) {
  const g = v.game;
  if (!g) return null;
  if (g.phase === 'peek') {
    if (!g.peek || g.peek.ready) return null;
    return g.peek.picks.length < 2 ? { type: 'peekPick', slot: g.peek.picks.length } : { type: 'peekReady' };
  }
  if (g.phase !== 'turn' || g.turn.pid !== v.me) return null;
  const mine = g.players.find((p) => p.id === v.me);
  const own = mine.slots.flatMap((s, i) => (s ? [i] : []));
  const op = g.players.find((p) => p.id !== v.me);
  const theirs = op.slots.flatMap((s, i) => (s ? [i] : []));
  const r = Math.random();
  switch (g.turn.stage) {
    case 'draw':
      if (!g.caboBy && r < 0.12) return { type: 'cabo' };
      if (g.discardTop && r < 0.35) return { type: 'takeDiscard' };
      return { type: 'drawDeck' };
    case 'decide': {
      if (g.turn.from === 'discard') return { type: 'exchange', slots: [own[0]] };
      const p = g.turn.power;
      if (p && r < 0.5) {
        const target = p === 'peek' ? { own: own[0] } : p === 'spy' ? { pid: op.id, slot: theirs[0] } : { own: own[0], pid: op.id, slot: theirs[0] };
        return { type: 'power', target };
      }
      return r < 0.75 ? { type: 'discard' } : { type: 'exchange', slots: [own.at(-1)] };
    }
    case 'reveal':
      return { type: 'reveal', swap: r < 0.5 };
    default:
      return null;
  }
}

// Let every client make its moves until `done` says stop.
async function playUntil(clients, done, ms = 15000) {
  const t0 = Date.now();
  const busy = new Set();
  while (!done()) {
    assert.ok(Date.now() - t0 < ms, 'game did not progress in time');
    for (const c of clients) {
      if (busy.has(c) || !c.view) continue;
      const mv = chooseMove(c.view);
      if (!mv) continue;
      busy.add(c);
      c.cmd(mv.type, mv).then((res) => {
        busy.delete(c);
        // Racing a state update is fine; anything else is a bug.
        if (!res.ok) assert.match(res.error, /not your turn|first|already|isn't in play|start/i);
      });
    }
    await sleep(3);
  }
}

test('create, join, change rules, start and play a full round', async () => {
  const a = new Client('Asha');
  const b = new Client('Bunty');
  const c = new Client('Chintu');
  const res = await a.create();
  assert.ok(res.ok);
  assert.match(res.code, /^[A-Z]{4}$/);
  assert.ok((await b.join(res.code.toLowerCase())).ok, 'codes are case-insensitive');
  assert.ok((await c.join(res.code)).ok);
  assert.equal((await b.join('ZZZZ')).ok, false);
  const twin = new Client('asha');
  assert.ok((await twin.join(res.code)).ok);
  await a.until((v) => v.members.length === 4);
  assert.deepEqual(a.view.members.map((m) => m.name), ['Asha', 'Bunty', 'Chintu', 'asha 2']);
  assert.ok((await twin.cmd('leave')).ok);
  twin.close();

  await a.until((v) => v.members.length === 3);
  assert.equal(a.view.host, a.view.me);
  const notHost = await b.cmd('settings', { settings: { target: 100 } });
  assert.equal(notHost.ok, false);
  assert.ok((await a.cmd('settings', { settings: { target: 100, turnTimer: 0, kamikaze: false, bogus: 1, reshuffle: 'yes' } })).ok);
  await b.until((v) => v.settings.target === 100);
  assert.equal(b.view.settings.turnTimer, 0);
  assert.equal(b.view.settings.kamikaze, false);
  assert.equal(b.view.settings.reshuffle, true, 'bad values are ignored');

  assert.equal((await b.cmd('start')).ok, false);
  assert.ok((await a.cmd('start')).ok);
  await c.until((v) => v.game?.phase === 'peek');
  assert.equal(c.view.game.rules.target, 100);

  await playUntil([a, b, c], () => a.view.game?.phase === 'roundEnd' || a.view.game?.phase === 'gameOver');
  const rows = a.view.game.results.rows;
  assert.equal(rows.length, 3);
  for (const r of rows) assert.ok(r.cards.length > 0 && r.cards.every((x) => x.r && x.s));
  assert.equal((await b.cmd('nextRound')).ok, false, 'only the host starts the next round');
  if (a.view.game.phase === 'roundEnd') {
    assert.ok((await a.cmd('nextRound')).ok);
    await b.until((v) => v.game.round === 2 && v.game.phase === 'peek');
  }
  for (const x of [a, b, c]) x.close();
});

test('a practice game against computer players runs to the end', async () => {
  const a = new Client('Solo');
  const { code } = await a.create();
  for (let i = 0; i < 3; i++) assert.ok((await a.cmd('addBot')).ok);
  await a.until((v) => v.members.length === 4);
  assert.ok(a.view.members.slice(1).every((m) => m.bot && m.name.length <= 8));
  assert.ok((await a.cmd('start')).ok);
  await playUntil([a], () => {
    const g = a.view.game;
    if (g?.phase === 'roundEnd') a.cmd('nextRound');
    return g?.phase === 'gameOver';
  }, 60000);
  assert.ok(a.view.game.winners.length >= 1);
  assert.ok((await a.cmd('toLobby')).ok);
  await a.until((v) => !v.game);
  assert.ok(code);
  a.close();
});

test('rejoin after a dropped connection keeps your seat; offline turns pass', async () => {
  const a = new Client('Host');
  const b = new Client('Dropper');
  const { code } = await a.create();
  await b.join(code);
  await a.until((v) => v.members.length === 2);
  await a.cmd('start');
  await b.until((v) => v.game?.phase === 'peek');
  const seat = b.view.me;

  b.close();
  await a.until((v) => v.members.find((m) => m.id === seat)?.connected === false);
  // Offline players are auto-readied, then their turns are passed.
  await a.cmd('peekReady');
  await a.until((v) => v.game.phase === 'turn', 3000);
  if (a.view.game.turn.pid === seat) {
    await a.until((v) => v.game.turn.pid !== seat, 3000);
    assert.ok(a.events.some((e) => e.t === 'timeout' && e.pid === seat));
  }

  b.connect();
  const back = await b.emit('rejoin', { code, token: b.token });
  assert.ok(back.ok);
  await b.until((v) => v.game?.phase === 'turn');
  assert.equal(b.view.me, seat);
  await a.until((v) => v.members.find((m) => m.id === seat)?.connected === true);
  const bad = await new Client('Stranger').emit('rejoin', { code, token: 'not-a-member-token' });
  assert.equal(bad.ok, false);
  a.close();
  b.close();
});

test('the host hands over when offline, can kick, pause and resume', async () => {
  const a = new Client('A');
  const b = new Client('B');
  const c = new Client('C');
  const { code } = await a.create();
  await b.join(code);
  await c.join(code);
  await a.until((v) => v.members.length === 3);
  await a.cmd('start');
  await a.until((v) => v.game?.phase === 'peek');

  assert.ok((await a.cmd('pause')).ok);
  await b.until((v) => v.paused);
  const blocked = await b.cmd('peekReady');
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /paused/);
  assert.ok((await a.cmd('resume')).ok);
  await b.until((v) => !v.paused);

  assert.ok((await a.cmd('kick', { id: c.view.me })).ok);
  await c.until(() => c.removed === 'kicked');
  await a.until((v) => v.members.length === 2 && v.game.players.length === 2);

  a.close();
  await b.until((v) => v.host === v.me, 3000);
  assert.ok((await b.cmd('skip')).ok);
  b.close();
});

test('someone watching can take over an offline seat if the host agrees', async () => {
  const a = new Client('Host');
  const b = new Client('Phone-died');
  const { code } = await a.create();
  await b.join(code);
  await a.until((v) => v.members.length === 2);
  await a.cmd('start');
  await b.until((v) => v.game?.phase === 'peek');
  const seat = b.view.me;
  b.close();
  await a.until((v) => v.members.find((m) => m.id === seat)?.connected === false);

  const d = new Client('New-phone');
  assert.ok((await d.join(code)).ok);
  await d.until((v) => v.game && !v.members.find((m) => m.id === v.me).playing);
  assert.equal((await d.cmd('drawDeck')).ok, false, 'watchers cannot play');
  assert.ok((await d.cmd('claim', { seat })).ok);
  const req = await a.until((v) => v.claims.length === 1);
  assert.ok((await a.cmd('resolveClaim', { id: req.claims[0].id, allow: true })).ok);
  await d.until((v) => v.me === seat);
  assert.equal(d.view.game.players.find((p) => p.id === seat).name, 'New-phone');
  a.close();
  d.close();
});

test('junk input is rejected without taking the server down', async () => {
  const a = new Client('Junk');
  for (const data of [null, 42, 'x', [], { name: 'x' }, { token: 'short' }]) {
    const r = await a.emit('create', data);
    assert.equal(r.ok, false);
  }
  await a.create();
  for (const cmd of [null, {}, { type: 'nope' }, { type: 'exchange', slots: 'all' }, { type: 'power', target: 5 }, { type: 'kick', id: {} }]) {
    const r = await a.emit('cmd', cmd);
    assert.equal(r.ok, false);
  }
  const health = await fetch(`${url}/healthz`).then((r) => r.text());
  assert.equal(health, 'ok');
  const page = await fetch(`${url}/ABCD`);
  assert.equal(page.status, 200);
  a.close();
});
