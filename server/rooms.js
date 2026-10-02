// Rooms: who is at the table, the host's controls, turn timers, bots, and
// sending each connected device its own view of the game.

import { Game, GameError, DEFAULT_RULES } from './game.js';
import { botStep } from './bot.js';
import { cleanName, makeRoomCode, newId, cryptoRandom } from './util.js';

export const MAX_SEATS = 10;
const MAX_MEMBERS = 24;
const MAX_ROOMS = 2000;
const LOG_LIMIT = 200;
const IDLE_ROOM_MS = 60 * 60_000;

// Short, so they fit on a crowded table (Chitti, Jaadoo and G.One are famous film robots and aliens).
const BOT_NAMES = ['Chitti', 'Jaadoo', 'G.One', 'Robo', 'Bolt', 'Chip', 'Pixel', 'Byte', 'Gizmo'];

export const DEFAULT_SETTINGS = Object.freeze({ ...DEFAULT_RULES, turnTimer: 45 });
const CHOICES = { target: [50, 100], turnTimer: [0, 30, 45, 60, 90, 120] };
const SWITCHES = ['reshuffle', 'faceUpPickups', 'redKingPower', 'lockCaller', 'kamikaze'];

const DEFAULT_TIMING = {
  botMin: 900,          // bots pause like people do, so moves can be followed
  botMax: 1700,
  offlineGrace: 30_000, // an offline player's turn is passed after this long
  hostGrace: 30_000,    // an offline host hands over after this long
  peekMin: 30_000,      // the opening peek never gets less than this
  revealMax: 20_000,    // time to look at peeked/spied cards
};

const need = (cond, msg) => {
  if (!cond) throw new GameError(msg);
};

export class Room {
  constructor(code, { rng = cryptoRandom, timing = {} } = {}) {
    this.code = code;
    this.rng = rng;
    this.timing = { ...DEFAULT_TIMING, ...timing };
    this.members = new Map();
    this.order = []; // member ids in seat order (join order)
    this.hostId = null;
    this.settings = { ...DEFAULT_SETTINGS };
    this.game = null;
    this.paused = null;
    this.claims = [];
    this.log = [];
    this.seq = 0;
    this.sockets = new Map();
    this.timers = { turn: null, bot: null, host: null };
    this.stage = { key: '', at: Date.now() };
    this.deadlineInfo = null;
    this.lastSeen = Date.now();
    this.absentSince = null;
  }

  // ------------------------------------------------------------- members

  push(ev) {
    this.log.push({ seq: ++this.seq, ...ev });
    if (this.log.length > LOG_LIMIT) this.log.splice(0, this.log.length - LOG_LIMIT);
  }

  list() {
    return this.order.map((id) => this.members.get(id));
  }

  seated() {
    return this.list().filter((m) => m.seat);
  }

  byToken(token) {
    if (!token) return null;
    for (const m of this.members.values()) if (m.token === token) return m;
    return null;
  }

  // Two people called Asha become "Asha" and "Asha 2".
  uniqueName(raw, ...except) {
    const base = cleanName(raw);
    const taken = new Set(this.list().filter((m) => !except.includes(m.id)).map((m) => m.name.toLowerCase()));
    if (!taken.has(base.toLowerCase())) return base;
    for (let i = 2; ; i++) {
      const name = `${[...base].slice(0, 13).join('').trim()} ${i}`;
      if (!taken.has(name.toLowerCase())) return name;
    }
  }

  join(name, token, socket) {
    let m = this.byToken(token);
    if (m) {
      if (!this.game) m.name = this.uniqueName(name, m.id);
    } else {
      need(this.members.size < MAX_MEMBERS, 'This room is full');
      const seat = !this.game && this.seated().length < MAX_SEATS;
      m = { id: newId(), name: this.uniqueName(name), token, bot: false, seat, sockets: new Set(), connected: false, offlineSince: null };
      this.members.set(m.id, m);
      this.order.push(m.id);
      if (!this.hostId) this.hostId = m.id;
      this.push({ t: 'join', pid: m.id, name: m.name, watching: !seat });
    }
    this.attach(m, socket);
    return m;
  }

  attach(m, socket) {
    socket.data.room = this.code;
    socket.data.mid = m.id;
    socket.data.fresh = true;
    m.sockets.add(socket.id);
    this.sockets.set(socket.id, socket);
    m.connected = true;
    m.offlineSince = null;
  }

  detach(socket) {
    this.sockets.delete(socket.id);
    const m = this.members.get(socket.data.mid);
    socket.data.room = null;
    socket.data.mid = null;
    if (!m) return;
    m.sockets.delete(socket.id);
    if (m.sockets.size === 0 && !m.bot) {
      m.connected = false;
      m.offlineSince = Date.now();
    }
    this.afterChange();
  }

  addBot() {
    need(!this.game, 'Add computer players before the game starts');
    need(this.seated().length < MAX_SEATS, `The table is full (${MAX_SEATS} players)`);
    need(this.members.size < MAX_MEMBERS, 'This room is full');
    const used = new Set(this.list().map((m) => m.name));
    const name = BOT_NAMES.find((n) => !used.has(n)) ?? `Bot ${this.members.size + 1}`;
    const m = { id: newId(), name, token: null, bot: true, seat: true, sockets: new Set(), connected: true, offlineSince: null };
    this.members.set(m.id, m);
    this.order.push(m.id);
    this.push({ t: 'join', pid: m.id, name, bot: true });
  }

  remove(m, why) {
    if (this.game?.has(m.id)) this.game.removePlayer(m.id);
    this.members.delete(m.id);
    this.order = this.order.filter((id) => id !== m.id);
    this.claims = this.claims.filter((c) => c.from !== m.id && c.seat !== m.id);
    for (const sid of m.sockets) {
      const s = this.sockets.get(sid);
      if (s) {
        s.emit('removed', { why });
        s.data.room = null;
        s.data.mid = null;
      }
      this.sockets.delete(sid);
    }
    this.push({ t: why, pid: m.id, name: m.name });
    if (this.hostId === m.id) {
      const humans = this.list().filter((x) => !x.bot);
      this.setHost((humans.find((x) => x.connected) ?? humans[0])?.id ?? null);
    }
  }

  setHost(id) {
    if (id === this.hostId) return;
    this.hostId = id;
    if (id) this.push({ t: 'host', pid: id });
  }

  // An offline host hands over to the next connected person after a grace period.
  ensureHost() {
    const host = this.members.get(this.hostId);
    if (host?.connected) {
      clearTimeout(this.timers.host);
      this.timers.host = null;
      return;
    }
    const next = this.list().find((m) => !m.bot && m.connected);
    if (!host) {
      if (next) this.setHost(next.id);
      return;
    }
    if (!next || this.timers.host) return;
    const wait = Math.max(0, host.offlineSince + this.timing.hostGrace - Date.now());
    this.timers.host = setTimeout(() => {
      this.timers.host = null;
      const h = this.members.get(this.hostId);
      const n = this.list().find((m) => !m.bot && m.connected);
      if (h && !h.connected && n) {
        this.setHost(n.id);
        this.afterChange();
      }
    }, wait);
  }

  // ------------------------------------------------------------ commands

  command(mid, cmd = {}) {
    const m = this.members.get(mid);
    need(m, 'You are no longer in this room');
    const isHost = mid === this.hostId;
    const needHost = () => need(isHost, 'Only the host can do that');
    const g = this.game;

    switch (cmd.type) {
      case 'settings':
        needHost();
        this.applySettings(cmd.settings);
        return;
      case 'addBot':
        needHost();
        return this.addBot();
      case 'kick': {
        needHost();
        const t = this.members.get(cmd.id);
        need(t, 'That player has already left');
        need(t.id !== mid, 'Use “Leave room” to leave');
        return this.remove(t, 'kicked');
      }
      case 'makeHost': {
        needHost();
        const t = this.members.get(cmd.id);
        need(t && !t.bot, 'Pick a person to be the host');
        return this.setHost(t.id);
      }
      case 'start':
        needHost();
        return this.start();
      case 'nextRound':
        needHost();
        need(g, 'No game is running');
        need(!this.paused, 'The game is paused');
        return g.nextRound();
      case 'toLobby':
        needHost();
        return this.toLobby();
      case 'pause':
        needHost();
        need(g && g.phase !== 'gameOver', 'No game is running');
        if (!this.paused) {
          this.paused = { by: mid, at: Date.now() };
          this.push({ t: 'pause', pid: mid });
        }
        return;
      case 'resume':
        needHost();
        if (this.paused) {
          this.stage.at += Date.now() - this.paused.at;
          this.paused = null;
          this.push({ t: 'resume', pid: mid });
        }
        return;
      case 'skip':
        needHost();
        need(g, 'No game is running');
        need(!this.paused, 'The game is paused');
        if (g.phase === 'peek') {
          for (const [id, st] of [...g.peek]) if (g.phase === 'peek' && !st.ready) g.autoPlay(id);
        } else if (g.phase === 'turn') g.autoPlay(g.turn.pid);
        return;
      case 'claim':
        return this.claim(m, cmd.seat);
      case 'resolveClaim':
        needHost();
        return this.resolveClaim(cmd.id, cmd.allow === true);
      case 'leave':
        return this.remove(m, 'left');
      default:
        return this.play(m, cmd);
    }
  }

  play(m, cmd) {
    const g = this.game;
    need(g, "The game hasn't started yet");
    need(!this.paused, 'The game is paused');
    need(g.has(m.id), "You're watching this game");
    const id = m.id;
    switch (cmd.type) {
      case 'peekPick': return g.peekPick(id, cmd.slot);
      case 'peekReady': return g.peekReady(id);
      case 'drawDeck': return g.drawDeck(id);
      case 'takeDiscard': return g.takeDiscard(id);
      case 'cabo': return g.callCabo(id);
      case 'exchange': return g.exchange(id, cmd.slots);
      case 'discard': return g.discardDrawn(id);
      case 'power': return g.usePower(id, cmd.target ?? {});
      case 'reveal': return g.finishReveal(id, cmd.swap === true);
      default: throw new GameError('Unknown action');
    }
  }

  // The turn timer can change at any time; the other rules only between games.
  applySettings(s = {}) {
    const next = { ...this.settings };
    if (CHOICES.turnTimer.includes(s.turnTimer)) next.turnTimer = s.turnTimer;
    if (!this.game) {
      if (CHOICES.target.includes(s.target)) next.target = s.target;
      for (const k of SWITCHES) if (typeof s[k] === 'boolean') next[k] = s[k];
    }
    this.settings = next;
  }

  start() {
    need(!this.game, 'A game is already running');
    const seats = this.seated().filter((m) => m.bot || m.connected);
    need(seats.length >= 2, 'You need at least 2 players (add a computer player to practise)');
    need(seats.length <= MAX_SEATS, `At most ${MAX_SEATS} players`);
    const rules = Object.fromEntries(Object.keys(DEFAULT_RULES).map((k) => [k, this.settings[k]]));
    this.paused = null;
    this.push({ t: 'start' });
    this.game = new Game(seats.map((m) => ({ id: m.id, name: m.name })), rules, {
      rng: this.rng,
      emit: (ev) => this.push(ev),
    });
  }

  toLobby() {
    need(this.game, 'No game is running');
    this.game = null;
    this.paused = null;
    this.claims = [];
    let seated = 0;
    for (const m of this.list()) {
      m.seat = seated < MAX_SEATS;
      if (m.seat) seated++;
    }
    this.push({ t: 'lobby' });
  }

  // Someone watching asks to take over an offline player's seat (e.g. their
  // phone died and they're back on another device). The host decides.
  claim(m, seatId) {
    const g = this.game;
    need(g, 'No game is running');
    need(!g.has(m.id), "You're already playing");
    const seat = this.members.get(seatId);
    need(seat && !seat.bot && g.has(seat.id) && !seat.connected, 'That seat is not free');
    this.claims = this.claims.filter((c) => c.from !== m.id);
    this.claims.push({ id: newId(), from: m.id, seat: seat.id });
    this.push({ t: 'claim', pid: m.id, seat: seat.id });
  }

  resolveClaim(id, allow) {
    const c = this.claims.find((x) => x.id === id);
    need(c, 'That request has expired');
    this.claims = this.claims.filter((x) => x !== c);
    const from = this.members.get(c.from);
    const seat = this.members.get(c.seat);
    if (!allow || !from || !seat || seat.connected || !this.game?.has(seat.id)) {
      if (from) this.push({ t: 'claimDenied', pid: from.id });
      return;
    }
    const old = seat.name;
    seat.token = from.token;
    seat.name = this.uniqueName(from.name, from.id, seat.id);
    for (const sid of from.sockets) {
      const s = this.sockets.get(sid);
      if (!s) continue;
      s.data.mid = seat.id;
      s.data.fresh = true;
      seat.sockets.add(sid);
    }
    seat.connected = seat.sockets.size > 0;
    seat.offlineSince = seat.connected ? null : Date.now();
    this.members.delete(from.id);
    this.order = this.order.filter((x) => x !== from.id);
    this.claims = this.claims.filter((x) => x.from !== from.id && x.seat !== seat.id);
    this.game.renamePlayer(seat.id, seat.name);
    this.push({ t: 'takeover', pid: seat.id, name: seat.name, old });
  }

  // -------------------------------------------------------- timers & bots

  stageKey() {
    const g = this.game;
    if (!g) return 'lobby';
    if (g.phase === 'turn') return `${g.round}:${g.turnCount}:${g.turn.stage}`;
    return `${g.round}:${g.phase}`;
  }

  peekDeadline(pid) {
    const m = this.members.get(pid);
    if (!m || m.bot) return Infinity;
    const T = this.settings.turnTimer * 1000;
    let at = T ? this.stage.at + Math.max(T, this.timing.peekMin) : Infinity;
    if (!m.connected) at = Math.min(at, Math.max(this.stage.at, m.offlineSince) + this.timing.offlineGrace);
    return at;
  }

  deadline() {
    const g = this.game;
    if (!g || this.paused) return null;
    const T = this.settings.turnTimer * 1000;
    if (g.phase === 'peek') {
      let at = Infinity;
      for (const [pid, st] of g.peek) if (!st.ready) at = Math.min(at, this.peekDeadline(pid));
      if (!Number.isFinite(at)) return null;
      return { at, pid: null, total: T ? Math.max(T, this.timing.peekMin) : this.timing.offlineGrace, reason: 'peek' };
    }
    if (g.phase !== 'turn') return null;
    const pid = g.turn.pid;
    const m = this.members.get(pid);
    if (!m || m.bot) return null;
    const limit = T ? (g.turn.stage === 'reveal' ? Math.min(T, this.timing.revealMax) : T) : Infinity;
    let d = { at: this.stage.at + limit, pid, total: limit, reason: 'turn' };
    if (!m.connected) {
      const off = Math.max(this.stage.at, m.offlineSince) + this.timing.offlineGrace;
      if (off < d.at) d = { at: off, pid, total: this.timing.offlineGrace, reason: 'offline' };
    }
    return Number.isFinite(d.at) ? d : null;
  }

  armTimer() {
    clearTimeout(this.timers.turn);
    this.timers.turn = null;
    const d = this.someoneHere() ? this.deadline() : null;
    this.deadlineInfo = d;
    if (d) this.timers.turn = setTimeout(() => this.onDeadline(), Math.max(0, d.at - Date.now()) + 25);
  }

  onDeadline() {
    const g = this.game;
    if (!g || this.paused) return;
    const now = Date.now();
    try {
      if (g.phase === 'peek') {
        for (const [pid, st] of [...g.peek]) {
          if (g.phase === 'peek' && !st.ready && this.peekDeadline(pid) <= now) g.autoPlay(pid);
        }
      } else if (g.phase === 'turn') {
        const d = this.deadline();
        if (d && d.at <= now) g.autoPlay(d.pid);
      }
    } catch (e) {
      console.error('timeout handling failed', e);
    }
    this.afterChange();
  }

  armBots() {
    clearTimeout(this.timers.bot);
    this.timers.bot = null;
    const g = this.game;
    // Bots (and timers) wait while nobody is connected.
    if (!g || this.paused || !this.someoneHere()) return;
    const isBot = (id) => this.members.get(id)?.bot;
    let pid = null;
    if (g.phase === 'peek') pid = [...g.peek.keys()].find((id) => isBot(id) && !g.peek.get(id).ready);
    else if (g.phase === 'turn' && isBot(g.turn.pid)) pid = g.turn.pid;
    if (!pid) return;
    const { botMin, botMax } = this.timing;
    const delay = g.phase === 'peek' ? botMin / 2 : botMin + this.rng() * (botMax - botMin);
    this.timers.bot = setTimeout(() => {
      this.timers.bot = null;
      if (this.game !== g || this.paused) return;
      try {
        botStep(g, pid, this.rng);
      } catch (e) {
        console.error('bot move failed', e);
        try {
          g.autoPlay(pid);
        } catch (e2) {
          console.error('bot fallback failed', e2);
        }
      }
      this.afterChange();
    }, delay);
  }

  someoneHere() {
    return this.list().some((m) => !m.bot && m.connected);
  }

  afterChange() {
    // While nobody is connected the clock stops, like a pause.
    const here = this.someoneHere();
    if (here) this.lastSeen = Date.now();
    if (!here && this.absentSince == null) this.absentSince = Date.now();
    if (here && this.absentSince != null) {
      this.stage.at += Date.now() - this.absentSince;
      this.absentSince = null;
    }
    const key = this.stageKey();
    if (key !== this.stage.key) this.stage = { key, at: Date.now() };
    this.ensureHost();
    this.armTimer();
    this.armBots();
    this.broadcast();
  }

  // ---------------------------------------------------------------- views

  broadcast() {
    for (const socket of this.sockets.values()) {
      const mid = socket.data.mid;
      if (!mid || !this.members.has(mid)) continue;
      let events;
      let replay = false;
      if (socket.data.fresh) {
        events = this.log.slice(-40);
        replay = true;
        socket.data.fresh = false;
      } else {
        events = this.log.filter((e) => e.seq > (socket.data.lastSeq ?? 0));
      }
      socket.data.lastSeq = this.seq;
      socket.emit('state', { view: this.viewFor(mid), events, replay });
    }
  }

  viewFor(mid) {
    const d = this.deadlineInfo;
    const isHost = mid === this.hostId;
    return {
      code: this.code,
      me: mid,
      host: this.hostId,
      members: this.list().map((m) => ({
        id: m.id,
        name: m.name,
        bot: m.bot,
        connected: m.connected,
        playing: this.game ? this.game.has(m.id) : m.seat,
      })),
      settings: { ...this.settings },
      paused: this.paused ? { by: this.paused.by } : null,
      timer: d ? { pid: d.pid, left: Math.max(0, d.at - Date.now()), total: d.total, reason: d.reason } : null,
      claims: this.claims.filter((c) => isHost || c.from === mid).map((c) => ({ ...c })),
      game: this.game ? this.game.viewFor(mid) : null,
    };
  }

  isIdle(now = Date.now()) {
    if (this.members.size === 0) return true;
    return !this.someoneHere() && now - this.lastSeen > IDLE_ROOM_MS;
  }

  destroy() {
    for (const t of Object.values(this.timers)) clearTimeout(t);
    for (const s of this.sockets.values()) {
      s.data.room = null;
      s.data.mid = null;
    }
    this.sockets.clear();
  }
}

// ------------------------------------------------------------------ sockets

function respond(ack, fn) {
  try {
    const out = fn();
    if (typeof ack === 'function') ack({ ok: true, ...out });
  } catch (e) {
    if (!(e instanceof GameError)) console.error(e);
    if (typeof ack === 'function') ack({ ok: false, error: e instanceof GameError ? e.message : 'Something went wrong' });
  }
}

const validToken = (t) => typeof t === 'string' && t.length >= 8 && t.length <= 100;

export class RoomManager {
  constructor({ rng = cryptoRandom, timing = {} } = {}) {
    this.rooms = new Map();
    this.rng = rng;
    this.timing = timing;
    this.sweeper = setInterval(() => this.sweep(), 60_000);
    this.sweeper.unref?.();
  }

  get(code) {
    return this.rooms.get(String(code ?? '').trim().toUpperCase());
  }

  create() {
    need(this.rooms.size < MAX_ROOMS, 'The server is busy, please try again later');
    let code;
    do code = makeRoomCode(this.rng);
    while (this.rooms.has(code));
    const room = new Room(code, { rng: this.rng, timing: this.timing });
    this.rooms.set(code, room);
    return room;
  }

  sweep() {
    for (const [code, room] of this.rooms) {
      if (room.isIdle()) {
        room.destroy();
        this.rooms.delete(code);
      }
    }
  }

  close() {
    clearInterval(this.sweeper);
    for (const room of this.rooms.values()) room.destroy();
    this.rooms.clear();
  }

  // A device can only be in one room at a time.
  leaveCurrent(socket) {
    const room = this.get(socket.data.room);
    if (room) room.detach(socket);
  }

  attach(socket) {
    // Generous rate limit: a misbehaving client can't flood the server.
    let budget = 40;
    let last = Date.now();
    socket.use((packet, next) => {
      const now = Date.now();
      budget = Math.min(40, budget + (now - last) / 50);
      last = now;
      if (budget < 1) return next(new Error('Slow down'));
      budget -= 1;
      next();
    });

    socket.on('create', (data, ack) =>
      respond(ack, () => {
        need(validToken(data?.token), 'Please reload the page');
        this.leaveCurrent(socket);
        const room = this.create();
        room.join(data.name, data.token, socket);
        room.afterChange();
        return { code: room.code };
      }),
    );

    socket.on('join', (data, ack) =>
      respond(ack, () => {
        need(validToken(data?.token), 'Please reload the page');
        const room = this.get(data?.code);
        need(room, "Couldn't find that room. Check the code?");
        if (socket.data.room !== room.code) this.leaveCurrent(socket);
        room.join(data.name, data.token, socket);
        room.afterChange();
        return { code: room.code };
      }),
    );

    socket.on('rejoin', (data, ack) =>
      respond(ack, () => {
        const room = this.get(data?.code);
        need(room, 'That room has closed');
        const m = validToken(data?.token) ? room.byToken(data.token) : null;
        need(m, 'You are no longer in that room');
        if (socket.data.room !== room.code) this.leaveCurrent(socket);
        room.attach(m, socket);
        room.afterChange();
        return { code: room.code };
      }),
    );

    socket.on('cmd', (data, ack) =>
      respond(ack, () => {
        const room = this.get(socket.data.room);
        need(room && socket.data.mid, 'You are not in a room');
        try {
          room.command(socket.data.mid, data ?? {});
        } finally {
          room.afterChange();
          if (room.members.size === 0) {
            room.destroy();
            this.rooms.delete(room.code);
          }
        }
        return {};
      }),
    );

    socket.on('disconnect', () => {
      const room = this.get(socket.data.room);
      if (room) room.detach(socket);
    });
  }
}
