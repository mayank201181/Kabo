// Kabo rules engine: a pure state machine with no timers and no I/O.
// Every public action validates who is acting and either mutates state
// (emitting public events) or throws a GameError whose message is safe to
// show the player. Hidden information only leaves through viewFor().

import { makeDeck, cardValue, cardPower, face, isKamikaze } from './cards.js';
import { shuffle } from './util.js';

export class GameError extends Error {}

export const DEFAULT_RULES = Object.freeze({
  target: 50,          // the game ends once someone goes over this
  reshuffle: true,     // empty deck → reshuffle the discard pile (house rule); off = round ends (official)
  faceUpPickups: true, // cards taken from the discard pile stay face-up; off = expert mode
  redKingPower: true,  // red Kings (−1) can also be discarded for Look & Swap
  lockCaller: false,   // after CABO the caller's cards can't be swapped
  kamikaze: true,      // finish with Q, Q, K♠, K♣ → 0 for you, half the target for everyone else
});

export const HAND_SIZE = 4;
export const PEEK_COUNT = 2;
export const CALLER_PENALTY = 10;

const STAGE_HINT = {
  draw: 'Draw a card first',
  decide: 'First decide what to do with the card you drew',
  reveal: 'Finish looking at the cards first',
};

export class Game {
  constructor(players, rules = {}, { rng = Math.random, emit } = {}) {
    if (players.length < 2) throw new GameError('Need at least 2 players');
    this.rules = { ...DEFAULT_RULES, ...rules };
    this.rng = rng;
    this.sink = emit ?? null;
    this.events = [];
    this.tick = 0;
    this.players = players.map(({ id, name }) => ({ id, name, hand: [], total: 0, resetUsed: false, history: [] }));
    this.round = 0;
    this.winners = null;
    this.startPid = this.players[Math.floor(rng() * this.players.length)].id;
    this.startRound();
  }

  // ---------------------------------------------------------------- helpers

  emit(ev) {
    this.tick += 1;
    if (this.sink) this.sink(ev);
    else this.events.push(ev);
  }

  need(cond, msg) {
    if (!cond) throw new GameError(msg);
  }

  has(pid) {
    return this.players.some((p) => p.id === pid);
  }

  player(pid) {
    const p = this.players.find((x) => x.id === pid);
    this.need(p, 'You are not playing in this game');
    return p;
  }

  needTurn(pid, stage) {
    this.need(this.phase === 'turn', "The round isn't in play right now");
    this.need(this.turn.pid === pid, "It's not your turn");
    this.need(this.turn.stage === stage, STAGE_HINT[this.turn.stage]);
  }

  ownSlot(p, slot) {
    return Number.isInteger(slot) && slot >= 0 && slot < p.hand.length && p.hand[slot] !== null;
  }

  // `known` tracks which cards each player has legitimately seen. Only bots
  // read it; it never goes to clients.
  know(pid, card) {
    this.known.get(pid)?.add(card.id);
  }

  knowAll(card) {
    for (const seen of this.known.values()) seen.add(card.id);
  }

  toDiscard(card) {
    this.discard.push(card);
    this.knowAll(card);
  }

  // ------------------------------------------------------------------ round

  startRound() {
    this.round += 1;
    this.deck = shuffle(makeDeck(), this.rng);
    for (const p of this.players) {
      p.hand = this.deck.splice(-HAND_SIZE).map((card) => ({ card, up: false }));
    }
    this.known = new Map(this.players.map((p) => [p.id, new Set()]));
    this.discard = [];
    this.toDiscard(this.deck.pop());
    this.caboBy = null;
    this.caboName = null;
    this.finalTurns = null;
    this.turn = null;
    this.turnCount = 0;
    this.results = null;
    this.peek = new Map(this.players.map((p) => [p.id, { picks: [], ready: false }]));
    this.phase = 'peek';
    this.emit({ t: 'round', round: this.round, start: this.startPid });
  }

  peekPick(pid, slot) {
    this.need(this.phase === 'peek', 'You can only look at your starting cards at the start of a round');
    const st = this.peek.get(pid);
    this.need(st, 'You are not playing in this game');
    this.need(!st.ready, "You've already memorised your cards");
    this.need(st.picks.length < PEEK_COUNT, `You can only look at ${PEEK_COUNT} cards`);
    const p = this.player(pid);
    this.need(this.ownSlot(p, slot), 'Pick one of your cards');
    this.need(!st.picks.includes(slot), 'You already looked at that card');
    st.picks.push(slot);
    this.know(pid, p.hand[slot].card);
    this.emit({ t: 'peeked', pid, slot });
  }

  peekReady(pid) {
    this.need(this.phase === 'peek', 'The round has already started');
    const st = this.peek.get(pid);
    this.need(st, 'You are not playing in this game');
    if (st.ready) return;
    st.ready = true;
    this.emit({ t: 'ready', pid });
    this.maybeBeginPlay();
  }

  maybeBeginPlay() {
    if (this.phase !== 'peek') return;
    if ([...this.peek.values()].every((s) => s.ready)) {
      this.phase = 'turn';
      this.startTurn(this.startPid);
    }
  }

  startTurn(pid) {
    this.turnCount += 1;
    this.turn = { pid, stage: 'draw', drawn: null, from: null, reveal: null };
    this.emit({ t: 'turn', pid });
  }

  // ------------------------------------------------------------------ turns

  drawDeck(pid) {
    this.needTurn(pid, 'draw');
    this.refillDeck();
    this.need(this.deck.length > 0, 'The deck is empty');
    const card = this.deck.pop();
    this.know(pid, card);
    Object.assign(this.turn, { stage: 'decide', drawn: card, from: 'deck' });
    this.emit({ t: 'draw', pid, from: 'deck' });
  }

  takeDiscard(pid) {
    this.needTurn(pid, 'draw');
    this.need(this.discard.length > 0, 'The discard pile is empty');
    const card = this.discard.pop();
    Object.assign(this.turn, { stage: 'decide', drawn: card, from: 'discard' });
    this.emit({ t: 'draw', pid, from: 'discard', c: face(card) });
  }

  callCabo(pid) {
    this.needTurn(pid, 'draw');
    this.need(!this.caboBy, 'Kabo has already been called');
    this.caboBy = pid;
    this.caboName = this.player(pid).name;
    this.finalTurns = new Set(this.players.filter((p) => p.id !== pid).map((p) => p.id));
    this.emit({ t: 'cabo', pid });
    this.endTurn();
  }

  // Swap the drawn card for one of your cards, or for several cards that all
  // share a value. A wrong guess reveals them and you keep everything.
  exchange(pid, slots) {
    this.needTurn(pid, 'decide');
    const p = this.player(pid);
    this.need(Array.isArray(slots) && slots.length > 0, 'Pick at least one of your cards');
    this.need(new Set(slots).size === slots.length && slots.every((i) => this.ownSlot(p, i)), 'Pick your own cards');
    const { drawn, from } = this.turn;
    const up = from === 'discard' && this.rules.faceUpPickups;
    const cards = slots.map((i) => p.hand[i].card);
    const value = cardValue(cards[0]);
    const extra = from === 'discard' ? { c: face(drawn) } : {};

    if (cards.every((c) => cardValue(c) === value)) {
      const into = Math.min(...slots);
      for (const i of slots) {
        this.toDiscard(p.hand[i].card);
        p.hand[i] = null;
      }
      p.hand[into] = { card: drawn, up };
      this.emit({ t: 'exchange', pid, slots, into, from, out: cards.map(face), ...extra });
    } else {
      for (const i of slots) {
        p.hand[i].up = true;
        this.knowAll(p.hand[i].card);
      }
      while (p.hand.length && p.hand.at(-1) === null) p.hand.pop();
      p.hand.push({ card: drawn, up });
      const added = [p.hand.length - 1];
      if (slots.length >= 3) {
        this.refillDeck();
        if (this.deck.length) {
          p.hand.push({ card: this.deck.pop(), up: false });
          added.push(p.hand.length - 1);
        }
      }
      this.emit({ t: 'mismatch', pid, slots, shown: cards.map(face), added, from, ...extra });
    }
    this.endTurn();
  }

  discardDrawn(pid) {
    this.needTurn(pid, 'decide');
    this.need(this.turn.from === 'deck', 'You took that card from the discard pile, so you must swap it in');
    const card = this.turn.drawn;
    this.toDiscard(card);
    this.emit({ t: 'discard', pid, c: face(card) });
    this.endTurn();
  }

  // target: { own } for peek, { pid, slot } for spy, { own, pid, slot } for swap / lookswap
  usePower(pid, target = {}) {
    this.needTurn(pid, 'decide');
    const { drawn, from } = this.turn;
    this.need(from === 'deck', 'Powers only work on cards drawn from the deck');
    const power = cardPower(drawn, this.rules);
    this.need(power, 'That card has no power');
    const me = this.player(pid);

    let own = null;
    let other = null;
    if (power !== 'spy') {
      this.need(this.ownSlot(me, target.own), 'Pick one of your cards');
      own = { pid, slot: target.own };
    }
    if (power !== 'peek') {
      const op = target.pid !== pid ? this.players.find((p) => p.id === target.pid) : null;
      this.need(op && this.ownSlot(op, target.slot), "Pick one of another player's cards");
      if (power !== 'spy') {
        this.need(!(this.rules.lockCaller && this.caboBy === op.id), `${op.name} called Kabo, so their cards are locked`);
      }
      other = { pid: op.id, slot: target.slot };
    }

    this.toDiscard(drawn);
    this.emit({ t: 'power', pid, power, c: face(drawn) });

    if (power === 'swap') {
      this.swapSlots(own, other);
      this.emit({ t: 'swap', pid, a: own, b: other, blind: true });
      this.endTurn();
      return;
    }
    const cards = [own, other].filter(Boolean);
    for (const x of cards) this.know(pid, this.player(x.pid).hand[x.slot].card);
    Object.assign(this.turn, { stage: 'reveal', drawn: null, reveal: { power, cards } });
    if (power === 'peek') this.emit({ t: 'peek', pid, slot: own.slot });
    else if (power === 'spy') this.emit({ t: 'spy', pid, b: other });
    else this.emit({ t: 'look', pid, a: own, b: other });
  }

  finishReveal(pid, doSwap = false) {
    this.needTurn(pid, 'reveal');
    const { power, cards } = this.turn.reveal;
    if (power === 'lookswap') {
      if (doSwap) {
        this.swapSlots(cards[0], cards[1]);
        this.emit({ t: 'swap', pid, a: cards[0], b: cards[1], blind: false });
      } else {
        this.emit({ t: 'noswap', pid });
      }
    }
    this.endTurn();
  }

  swapSlots(a, b) {
    const pa = this.player(a.pid);
    const pb = this.player(b.pid);
    [pa.hand[a.slot], pb.hand[b.slot]] = [pb.hand[b.slot], pa.hand[a.slot]];
  }

  // What happens when a player runs out of time (or is offline too long):
  // a pass that changes as little as possible.
  autoPlay(pid) {
    if (this.phase === 'peek') {
      if (this.peek.get(pid) && !this.peek.get(pid).ready) this.peekReady(pid);
      return;
    }
    if (this.phase !== 'turn' || this.turn.pid !== pid) return;
    const { stage, from, drawn } = this.turn;
    this.emit({ t: 'timeout', pid });
    if (stage === 'draw') {
      this.endTurn();
    } else if (stage === 'decide' && from === 'deck') {
      this.discardDrawn(pid);
    } else if (stage === 'decide') {
      this.discard.push(drawn);
      this.emit({ t: 'putback', pid, c: face(drawn) });
      this.endTurn();
    } else {
      this.finishReveal(pid, false);
    }
  }

  endTurn() {
    const pid = this.turn.pid;
    if (this.caboBy) {
      this.finalTurns.delete(pid);
      if (this.finalTurns.size === 0) return this.endRound('cabo');
    }
    if (!this.refillDeck()) return this.endRound('deck');
    const next = this.nextPid(pid);
    if (!next) return this.endRound('cabo');
    this.startTurn(next);
  }

  // Next player clockwise; after CABO, only players still owed a final turn.
  nextPid(pid) {
    const ids = this.players.map((p) => p.id);
    const at = ids.indexOf(pid);
    for (let k = 1; k <= ids.length; k++) {
      const id = ids[(at + k) % ids.length];
      if (this.caboBy && !this.finalTurns.has(id)) continue;
      return id;
    }
    return null;
  }

  // Returns false when the deck is empty and can't be refilled.
  refillDeck() {
    if (this.deck.length) return true;
    if (!this.rules.reshuffle || this.discard.length < 2) return false;
    const top = this.discard.pop();
    this.deck = shuffle(this.discard, this.rng);
    this.discard = [top];
    for (const seen of this.known.values()) for (const c of this.deck) seen.delete(c.id);
    this.emit({ t: 'reshuffle', n: this.deck.length });
    return true;
  }

  // ---------------------------------------------------------------- scoring

  endRound(reason) {
    this.phase = 'roundEnd';
    this.turn = null;
    const { target, kamikaze } = this.rules;
    const rows = this.players.map((p) => {
      const cards = p.hand.filter(Boolean).map((s) => s.card);
      return { pid: p.id, name: p.name, cards, sum: cards.reduce((a, c) => a + cardValue(c), 0) };
    });
    const kami = kamikaze ? rows.find((r) => isKamikaze(r.cards)) : null;
    const low = Math.min(...rows.map((r) => r.sum));
    for (const r of rows) {
      if (kami) {
        r.score = r === kami ? 0 : target / 2;
      } else if (r.pid === this.caboBy) {
        r.callerOk = r.sum <= low;
        // A correct call never scores worse than not calling (sums can go below 0).
        r.score = r.callerOk ? Math.min(0, r.sum) : r.sum + CALLER_PENALTY;
      } else {
        r.score = r.sum;
      }
    }
    for (const r of rows) {
      const p = this.player(r.pid);
      p.total += r.score;
      if (p.total === target && !p.resetUsed) {
        p.total = target / 2;
        p.resetUsed = true;
        r.reset = true;
      }
      p.history.push(r.score);
      r.total = p.total;
    }
    this.results = {
      round: this.round,
      reason,
      caboBy: this.caboBy,
      caboName: this.caboName,
      kamikaze: kami ? kami.pid : null,
      rows: rows.map((r) => ({ ...r, cards: r.cards.map(face) })),
    };
    this.emit({ t: 'roundEnd', round: this.round, reason, caboBy: this.caboBy, kamikaze: this.results.kamikaze });
    if (this.players.some((p) => p.total > target)) this.finishGame();
  }

  finishGame() {
    this.phase = 'gameOver';
    this.turn = null;
    const best = Math.min(...this.players.map((p) => p.total));
    let winners = this.players.filter((p) => p.total === best);
    if (winners.length > 1) {
      const last = (p) => p.history.at(-1) ?? 0;
      const bestLast = Math.min(...winners.map(last));
      winners = winners.filter((p) => last(p) === bestLast);
    }
    this.winners = winners.map((p) => p.id);
    this.emit({ t: 'gameOver', winners: this.winners });
  }

  // Lowest scorer of the last round starts; ties go to whoever sits closest
  // (clockwise) to the previous start player.
  nextRound() {
    this.need(this.phase === 'roundEnd', 'The round is still going');
    const ids = this.players.map((p) => p.id);
    const from = Math.max(0, ids.indexOf(this.startPid));
    let best = null;
    for (let k = 0; k < ids.length; k++) {
      const p = this.players[(from + k) % ids.length];
      const s = p.history.at(-1) ?? 0;
      if (!best || s < best.s) best = { id: p.id, s };
    }
    this.startPid = best.id;
    this.startRound();
  }

  // ------------------------------------------------------- seat management

  renamePlayer(pid, name) {
    const p = this.player(pid);
    const old = p.name;
    p.name = name;
    if (this.results) for (const r of this.results.rows) if (r.pid === pid) r.name = name;
    this.emit({ t: 'renamed', pid, name, old });
  }

  // A player leaves or is removed mid-game. Their cards go under the discard
  // pile (out of play until a reshuffle) and the game carries on without them.
  removePlayer(pid) {
    const idx = this.players.findIndex((p) => p.id === pid);
    if (idx < 0) return;
    const p = this.players[idx];
    const t = this.turn;
    const wasTurn = this.phase === 'turn' && t.pid === pid;
    const next = wasTurn ? this.nextPid(pid) : null;
    if (this.startPid === pid && this.players.length > 1) {
      this.startPid = this.players[(idx + 1) % this.players.length].id;
    }
    if (wasTurn && t.stage === 'decide') this.toDiscard(t.drawn);
    const cards = p.hand.filter(Boolean).map((s) => s.card);
    this.discard.unshift(...cards);
    for (const c of cards) this.knowAll(c);
    this.players.splice(idx, 1);
    this.known.delete(pid);
    this.peek?.delete(pid);
    this.finalTurns?.delete(pid);
    this.emit({ t: 'removed', pid, name: p.name });

    if (this.phase === 'roundEnd' || this.phase === 'gameOver') return;
    if (this.players.length < 2) return this.finishGame();
    if (this.phase === 'peek') return this.maybeBeginPlay();
    if (wasTurn) {
      if (this.caboBy && this.finalTurns.size === 0) return this.endRound('cabo');
      if (!this.refillDeck()) return this.endRound('deck');
      if (next && next !== pid && this.has(next)) return this.startTurn(next);
      return this.endRound('cabo');
    }
  }

  // ------------------------------------------------------------------ views

  // Everything `viewer` is allowed to know right now, and nothing more.
  viewFor(viewer) {
    const t = this.turn;
    const open = this.phase === 'roundEnd' || this.phase === 'gameOver';
    const peekSt = this.phase === 'peek' ? this.peek.get(viewer) : null;
    const reveal = this.phase === 'turn' && t.stage === 'reveal' && t.pid === viewer ? t.reveal.cards : [];
    const canSee = (pid, i) =>
      open ||
      (peekSt && !peekSt.ready && pid === viewer && peekSt.picks.includes(i)) ||
      reveal.some((r) => r.pid === pid && r.slot === i);

    return {
      round: this.round,
      phase: this.phase,
      rules: { ...this.rules },
      startPid: this.startPid,
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        total: p.total,
        resetUsed: p.resetUsed,
        history: [...p.history],
        ready: this.phase === 'peek' ? Boolean(this.peek.get(p.id)?.ready) : null,
        slots: p.hand.map((s, i) => {
          if (!s) return null;
          if (s.up || canSee(p.id, i)) return { up: s.up, c: face(s.card) };
          return { up: false };
        }),
      })),
      deckCount: this.deck.length,
      discardCount: this.discard.length,
      discardTop: this.discard.length ? face(this.discard.at(-1)) : null,
      caboBy: this.caboBy,
      finalTurns: this.finalTurns ? [...this.finalTurns] : null,
      turn:
        this.phase === 'turn'
          ? {
              pid: t.pid,
              stage: t.stage,
              from: t.from,
              drawn: t.stage === 'decide' && (t.pid === viewer || t.from === 'discard') ? face(t.drawn) : null,
              power: t.stage === 'decide' && t.from === 'deck' && t.pid === viewer ? cardPower(t.drawn, this.rules) : null,
              reveal: t.stage === 'reveal' ? { power: t.reveal.power, cards: t.reveal.cards.map((x) => ({ ...x })) } : null,
            }
          : null,
      peek: peekSt ? { picks: [...peekSt.picks], ready: peekSt.ready } : null,
      results: this.results,
      winners: this.winners,
    };
  }
}
