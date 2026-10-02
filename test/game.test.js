import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game, GameError } from '../server/game.js';
import { cardValue, cardPower, makeDeck, isKamikaze } from '../server/cards.js';
import { seededRng } from '../server/util.js';
import { rig, codes, ev } from './helpers.js';

const C = (code) => makeDeck().find((c) => c.r + c.s === code);
const players = (n) => Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `P${i}` }));

test('card values follow the house rules', () => {
  assert.equal(cardValue(C('AS')), 1);
  assert.equal(cardValue(C('10D')), 10);
  assert.equal(cardValue(C('JH')), 11);
  assert.equal(cardValue(C('QC')), 12);
  assert.equal(cardValue(C('KS')), 13);
  assert.equal(cardValue(C('KC')), 13);
  assert.equal(cardValue(C('KH')), -1);
  assert.equal(cardValue(C('KD')), -1);
  const total = makeDeck().reduce((a, c) => a + cardValue(c), 0);
  assert.equal(total, 336);
});

test('card powers, including the red King switch', () => {
  const on = { redKingPower: true };
  const off = { redKingPower: false };
  assert.equal(cardPower(C('7H'), on), 'peek');
  assert.equal(cardPower(C('8S'), on), 'peek');
  assert.equal(cardPower(C('9D'), on), 'spy');
  assert.equal(cardPower(C('10C'), on), 'spy');
  assert.equal(cardPower(C('JS'), on), 'swap');
  assert.equal(cardPower(C('QH'), on), 'swap');
  assert.equal(cardPower(C('KS'), off), 'lookswap');
  assert.equal(cardPower(C('KC'), off), 'lookswap');
  assert.equal(cardPower(C('KH'), on), 'lookswap');
  assert.equal(cardPower(C('KD'), off), null);
  assert.equal(cardPower(C('6S'), on), null);
  assert.equal(cardPower(C('AS'), on), null);
});

test('kamikaze is exactly Q, Q, K♠, K♣', () => {
  assert.ok(isKamikaze(['QS', 'QH', 'KS', 'KC'].map(C)));
  assert.ok(!isKamikaze(['QS', 'QH', 'KS', 'KH'].map(C)));
  assert.ok(!isKamikaze(['QS', 'QH', 'KS', 'KC', 'AS'].map(C)));
  assert.ok(!isKamikaze(['QS', 'KS', 'KC'].map(C)));
});

test('deal: 4 cards each, one face-up discard, the rest in the deck', () => {
  for (const n of [2, 6, 10]) {
    const g = new Game(players(n), {}, { rng: seededRng(n) });
    assert.equal(g.phase, 'peek');
    for (const p of g.players) assert.equal(p.hand.length, 4);
    assert.equal(g.discard.length, 1);
    assert.equal(g.deck.length, 52 - 4 * n - 1);
    const ids = new Set([...g.deck, ...g.discard, ...g.players.flatMap((p) => p.hand.map((s) => s.card))].map((c) => c.id));
    assert.equal(ids.size, 52);
  }
});

test('opening peek: two of your own cards, visible only to you until you are ready', () => {
  const g = new Game(players(3), {}, { rng: seededRng(3) });
  g.peekPick('p0', 1);
  g.peekPick('p0', 3);
  assert.throws(() => g.peekPick('p0', 2), GameError);
  assert.throws(() => g.peekPick('p1', 1) || g.peekPick('p1', 1), GameError);
  const mine = g.viewFor('p0').players[0].slots;
  assert.ok(mine[1].c && mine[3].c);
  assert.ok(!mine[0].c && !mine[2].c);
  assert.ok(g.viewFor('p1').players[0].slots.every((s) => !s.c), 'others never see my peeks');
  g.peekReady('p0');
  assert.ok(g.viewFor('p0').players[0].slots.every((s) => !s.c), 'hidden again once ready');
  assert.equal(g.phase, 'peek');
  g.peekReady('p1');
  g.peekReady('p2');
  assert.equal(g.phase, 'turn');
  assert.equal(g.turn.pid, g.startPid);
});

test('draw from the deck and discard it', () => {
  const g = rig([['5S', '6S', '7S', '8S'], ['5H', '6H', '7H', '8H']], { deck: ['3D', '4D'] });
  assert.throws(() => g.drawDeck('p1'), /not your turn/);
  g.drawDeck('p0');
  assert.deepEqual(g.viewFor('p0').turn.drawn, { r: '3', s: 'D' });
  assert.equal(g.viewFor('p1').turn.drawn, null, 'others cannot see a card drawn from the deck');
  g.discardDrawn('p0');
  assert.deepEqual(g.viewFor('p1').discardTop, { r: '3', s: 'D' });
  assert.equal(g.turn.pid, 'p1');
});

test('swap a drawn card into your hand: old card discarded, new one face-down', () => {
  const g = rig([['5S', '6S', '7S', '8S'], ['5H', '6H', '7H', '8H']], { deck: ['AD', '4D'] });
  g.drawDeck('p0');
  g.exchange('p0', [2]);
  assert.deepEqual(codes(g.players[0].hand), ['5S', '6S', 'AD', '8S']);
  assert.equal(g.players[0].hand[2].up, false);
  assert.equal(g.discard.at(-1).r + g.discard.at(-1).s, '7S');
  assert.equal(g.viewFor('p1').players[0].slots[2].c, undefined);
});

test('taking the discard: must swap it in, and it stays face-up', () => {
  const g = rig([['5S', '6S', '7S', '8S'], ['5H', '6H', '7H', '8H']], { deck: ['3D'], discard: ['AH'] });
  g.takeDiscard('p0');
  assert.throws(() => g.discardDrawn('p0'), /must swap/);
  assert.throws(() => g.usePower('p0', {}), GameError);
  g.exchange('p0', [3]);
  assert.deepEqual(codes(g.players[0].hand), ['5S', '6S', '7S', 'AH']);
  assert.deepEqual(g.viewFor('p1').players[0].slots[3], { up: true, c: { r: 'A', s: 'H' } });
});

test('expert mode keeps discard pickups face-down', () => {
  const g = rig([['5S', '6S', '7S', '8S'], ['5H', '6H', '7H', '8H']], { deck: ['3D'], discard: ['AH'], rules: { faceUpPickups: false } });
  g.takeDiscard('p0');
  g.exchange('p0', [0]);
  assert.deepEqual(g.viewFor('p1').players[0].slots[0], { up: false });
});

test('Keep swaps exactly one card', () => {
  const g = rig([['5S', '9S', '5H', '8S'], ['4C', '6H', '7H', '8H']], { deck: ['2D', '4D'] });
  g.drawDeck('p0');
  assert.throws(() => g.exchange('p0', [0, 2]), /one of your cards/);
  assert.throws(() => g.exchange('p0', []), /one of your cards/);
  g.exchange('p0', [2]);
  assert.deepEqual(codes(g.players[0].hand), ['5S', '9S', '2D', '8S']);
});

test('match: draw a 2, throw away your 2 as well, and your hand shrinks', () => {
  const g = rig([['5S', '2C', '7D', '9H'], ['4C', '6H', '7H', '8H']], { deck: ['2H', '4D'], discard: ['3C'], up: ['0:1'] });
  g.drawDeck('p0');
  g.match('p0', [1]);
  assert.deepEqual(codes(g.players[0].hand), ['5S', null, '7D', '9H']);
  assert.deepEqual(g.discard.slice(-2).map((c) => c.r + c.s), ['2C', '2H'], 'the drawn card ends up on top');
  assert.equal(g.turn.pid, 'p1');
  assert.deepEqual(ev(g, 'match')[0].out, [{ r: '2', s: 'C' }]);
});

test('match several cards at once; ranks match even when values differ (kings)', () => {
  const g = rig([['KS', 'KH', '7D', '9H'], ['2S', '2C', '7H', '8H']], { deck: ['KC', '2H', '4D'], discard: ['3C'] });
  g.drawDeck('p0');
  g.match('p0', [0, 1]);
  assert.deepEqual(codes(g.players[0].hand), [null, null, '7D', '9H']);
  g.drawDeck('p1');
  g.match('p1', [0, 1]);
  assert.deepEqual(codes(g.players[1].hand), [null, null, '7H', '8H']);
});

test('a wrong match turns your card face-up and costs a penalty card', () => {
  const g = rig([['5S', '6C', '7D', '9H'], ['2S', '4C', '7H', '8H']], { deck: ['2H', '3S', '2D', 'AD'] });
  g.drawDeck('p0');
  g.match('p0', [1]);
  assert.deepEqual(codes(g.players[0].hand), ['5S', '6C', '7D', '9H', '3S']);
  assert.deepEqual(g.players[0].hand.map((s) => s.up), [false, true, false, false, false]);
  assert.equal(g.discard.at(-1).r + g.discard.at(-1).s, '2H', 'the drawn card is still discarded');
  assert.equal(g.known.get('p0').has(g.players[0].hand[4].card.id), false, 'the penalty card is unseen');
  // One right and one wrong: the right one goes, the wrong one stays face-up, one penalty card.
  g.drawDeck('p1');
  g.match('p1', [0, 1]);
  assert.deepEqual(codes(g.players[1].hand), [null, '4C', '7H', '8H', 'AD']);
  assert.equal(g.players[1].hand[1].up, true);
  assert.deepEqual(ev(g, 'match')[1].hits, [0]);
  assert.deepEqual(ev(g, 'match')[1].misses, [1]);
});

test('match only works on a card drawn from the deck', () => {
  const g = rig([['5S', '2C'], ['4C', '6H']], { deck: ['9D'], discard: ['2H'] });
  g.takeDiscard('p0');
  assert.throws(() => g.match('p0', [1]), /drawn from the deck/);
  g.exchange('p0', [1]);
  g.drawDeck('p1');
  assert.throws(() => g.match('p1', [5]), /your own cards/);
  assert.throws(() => g.match('p1', []), /card\(s\) that match/);
  assert.equal(g.turn.stage, 'decide');
});

test('getting rid of your last card ends the round', () => {
  const g = rig([['2C'], ['9C', '9D', '9H', '9S']], { deck: ['2H', '4D'], discard: ['3C'] });
  g.drawDeck('p0');
  g.match('p0', [0]);
  assert.equal(g.phase, 'roundEnd');
  assert.equal(g.results.reason, 'empty');
  assert.equal(g.results.emptied, 'p0');
  assert.deepEqual(g.results.rows.map((r) => r.score), [0, 36]);
});

test('peek and spy show the card only to the player using the power', () => {
  const g = rig([['5S', '9S', '6H', '8S'], ['4C', '6C', '7H', '8H']], { deck: ['7D', '10D'] });
  g.drawDeck('p0');
  assert.equal(g.viewFor('p0').turn.power, 'peek');
  g.usePower('p0', { own: 1 });
  assert.equal(g.turn.stage, 'reveal');
  assert.deepEqual(g.viewFor('p0').players[0].slots[1].c, { r: '9', s: 'S' });
  assert.equal(g.viewFor('p1').players[0].slots[1].c, undefined);
  assert.deepEqual(g.viewFor('p1').turn.reveal.cards, [{ pid: 'p0', slot: 1 }]);
  g.finishReveal('p0');
  assert.equal(g.viewFor('p0').players[0].slots[1].c, undefined, 'gone once the turn ends');

  g.drawDeck('p1');
  g.usePower('p1', { pid: 'p0', slot: 3 });
  assert.deepEqual(g.viewFor('p1').players[0].slots[3].c, { r: '8', s: 'S' });
  assert.equal(g.viewFor('p0').players[0].slots[3].c, undefined);
  g.finishReveal('p1');
});

test('J/Q swap is blind; face-up cards keep their face-up state', () => {
  const g = rig([['5S', '9S', '6H', '8S'], ['4C', '6C', '7H', '8H']], { deck: ['JD'], up: ['1:2'] });
  g.drawDeck('p0');
  g.usePower('p0', { own: 0, pid: 'p1', slot: 2 });
  assert.deepEqual(codes(g.players[0].hand), ['7H', '9S', '6H', '8S']);
  assert.deepEqual(codes(g.players[1].hand), ['4C', '6C', '5S', '8H']);
  assert.equal(g.players[0].hand[0].up, true);
  assert.equal(g.turn.pid, 'p1');
  assert.equal(ev(g, 'swap')[0].blind, true);
});

test('black King: look at both cards, then choose whether to swap', () => {
  const g = rig([['5S', '9S', '6H', '8S'], ['4C', '6C', 'AH', '8H']], { deck: ['KS', 'KC'] });
  g.drawDeck('p0');
  assert.equal(g.viewFor('p0').turn.power, 'lookswap');
  g.usePower('p0', { own: 1, pid: 'p1', slot: 2 });
  const v = g.viewFor('p0');
  assert.deepEqual(v.players[0].slots[1].c, { r: '9', s: 'S' });
  assert.deepEqual(v.players[1].slots[2].c, { r: 'A', s: 'H' });
  assert.equal(g.viewFor('p1').players[1].slots[2].c, undefined);
  g.finishReveal('p0', true);
  assert.deepEqual(codes(g.players[0].hand), ['5S', 'AH', '6H', '8S']);
  assert.deepEqual(codes(g.players[1].hand), ['4C', '6C', '9S', '8H']);

  g.drawDeck('p1');
  g.usePower('p1', { own: 0, pid: 'p0', slot: 0 });
  g.finishReveal('p1', false);
  assert.deepEqual(codes(g.players[1].hand), ['4C', '6C', '9S', '8H']);
  assert.equal(ev(g, 'noswap').length, 1);
});

test('powers only work from the deck, and invalid targets are rejected without side effects', () => {
  const g = rig([['5S', '9S', '6H', '8S'], ['4C', '6C', 'AH', '8H']], { deck: ['9H'], discard: ['JS'] });
  g.takeDiscard('p0');
  assert.throws(() => g.usePower('p0', { own: 0, pid: 'p1', slot: 0 }), /from the deck/);
  g.exchange('p0', [0]);
  g.drawDeck('p1');
  assert.throws(() => g.usePower('p1', { pid: 'p1', slot: 0 }), /another player/);
  assert.throws(() => g.usePower('p1', { pid: 'p0', slot: 9 }), /another player/);
  assert.equal(g.turn.stage, 'decide');
  assert.equal(g.discard.length, 1);
});

test('CABO: everyone else gets one more turn, then scoring', () => {
  const g = rig(
    [['AS', '2S', '3S', 'KH'], ['5H', '6H', '7H', '8H'], ['9C', '9D', '10C', '10D']],
    { deck: ['4D', '4C', '4S'] },
  );
  g.callCabo('p0');
  assert.equal(g.turn.pid, 'p1');
  assert.throws(() => g.callCabo('p1'), /already/);
  g.drawDeck('p1');
  g.discardDrawn('p1');
  assert.equal(g.turn.pid, 'p2');
  g.drawDeck('p2');
  g.discardDrawn('p2');
  assert.equal(g.phase, 'roundEnd');
  const rows = Object.fromEntries(g.results.rows.map((r) => [r.pid, r]));
  assert.equal(rows.p0.sum, 5);
  assert.equal(rows.p0.score, 0);
  assert.equal(rows.p0.callerOk, true);
  assert.equal(rows.p1.score, 26);
  assert.equal(rows.p2.score, 38);
  assert.equal(g.results.caboName, 'P0');
});

test('CABO caller who is not lowest scores their sum + 10; a tie still counts as lowest', () => {
  const g = rig([['AS', '2S', '3S', '9S'], ['AH', '2H', '3H', '4H']], { deck: ['5D', '6D'] });
  g.callCabo('p0');
  g.drawDeck('p1');
  g.discardDrawn('p1');
  assert.equal(g.results.rows[0].score, 25);
  assert.equal(g.results.rows[0].callerOk, false);

  const t = rig([['AS', '2S', '3S', '4S'], ['AH', '2H', '3H', '4H']], { deck: ['5D', '6D'] });
  t.callCabo('p0');
  t.drawDeck('p1');
  t.discardDrawn('p1');
  assert.equal(t.results.rows[0].score, 0);
});

test('a correct caller with a negative total keeps the negative total', () => {
  const g = rig([['KH', 'KD', 'AS'], ['AH', '2H', '3H', '4H']], { deck: ['5D', '6D'] });
  g.callCabo('p0');
  g.drawDeck('p1');
  g.discardDrawn('p1');
  assert.equal(g.results.rows[0].sum, -1);
  assert.equal(g.results.rows[0].score, -1);
});

test('kamikaze: 0 for you, half the target for everyone else', () => {
  const g = rig([['QS', 'QH', 'KS', 'KC'], ['AH', '2H', '3H', '4H'], ['5C', '5D', '6C', '6D']], { deck: ['5H', '6H', '7C'], start: 1 });
  g.callCabo('p1');
  g.drawDeck('p2');
  g.discardDrawn('p2');
  g.drawDeck('p0');
  g.discardDrawn('p0');
  assert.equal(g.results.kamikaze, 'p0');
  assert.deepEqual(g.results.rows.map((r) => r.score), [0, 25, 25]);
});

test('kamikaze can be switched off', () => {
  const g = rig([['QS', 'QH', 'KS', 'KC'], ['AH', '2H', '3H', '4H']], { deck: ['5H', '6H'], rules: { kamikaze: false }, start: 1 });
  g.callCabo('p1');
  g.drawDeck('p0');
  g.discardDrawn('p0');
  assert.equal(g.results.kamikaze, null);
  assert.deepEqual(g.results.rows.map((r) => r.score), [50, 0]);
});

test('landing exactly on the target resets to half, once per game; going over ends the game', () => {
  const g = rig([['AS', '2S', '3S', '4S'], ['10H', '10D', '10C', 'QH']], { deck: ['5D', '6D'] });
  g.players[1].total = 8;
  g.callCabo('p0');
  g.drawDeck('p1');
  g.discardDrawn('p1');
  assert.equal(g.players[1].total, 25);
  assert.equal(g.results.rows[1].reset, true);
  assert.equal(g.phase, 'roundEnd');

  g.players[1].total = 8;
  g.nextRound();
  g.players[0].hand = g.players[0].hand.slice(0, 1);
  g.players[1].hand = g.players[1].hand.slice(0, 4);
  // Rig totals directly: P1 lands on exactly 50 again but has used the reset.
  g.phase = 'turn';
  g.turn = { pid: 'p0', stage: 'draw' };
  g.players[0].hand = [{ card: C('AD'), up: false }];
  g.players[1].hand = ['10S', 'QS', 'QD', 'AC', '7C'].map((x) => ({ card: C(x), up: false }));
  g.endRound('cabo');
  assert.equal(g.players[1].total, 8 + 42);
  assert.equal(g.phase, 'roundEnd', '50 is not over 50');
});

test('game over: lowest total wins, ties broken by the last round', () => {
  const g = rig([['AS', '2S'], ['AH', '2H'], ['KS', 'KC', 'QS', 'QH', 'JS']], { deck: ['5D', '6D', '7D'], rules: { kamikaze: false } });
  g.players[0].total = 10;
  g.players[1].total = 7;
  g.callCabo('p0');
  g.drawDeck('p1');
  g.discardDrawn('p1');
  g.drawDeck('p2');
  g.discardDrawn('p2');
  // P0 called with 3 (tied lowest) → 0 → 10. P1 scores 3 → 10. P2 goes over.
  assert.equal(g.phase, 'gameOver');
  assert.deepEqual(g.winners, ['p0']);
  assert.ok(ev(g, 'gameOver').length === 1);
});

test('empty deck: the discard pile is reshuffled (house rule)', () => {
  const g = rig([['5S', '6S', '7S', '8S'], ['5H', '6H', '7H', '8H']], { deck: ['2D'], discard: ['3C', '4C', 'AD'] });
  g.drawDeck('p0');
  g.discardDrawn('p0');
  assert.equal(ev(g, 'reshuffle').length, 1);
  assert.equal(g.deck.length, 3);
  assert.equal(g.discard.length, 1);
  assert.equal(g.discard[0].r + g.discard[0].s, '2D');
  assert.equal(g.phase, 'turn');
  // Reshuffled cards are no longer "known" to anyone.
  for (const c of g.deck) assert.equal(g.known.get('p1').has(c.id), false);
});

test('empty deck with reshuffle off ends the round (official rule)', () => {
  const g = rig([['5S', '6S', '7S', '8S'], ['5H', '6H', '7H', '8H']], { deck: ['2D'], discard: ['3C', '4C'], rules: { reshuffle: false } });
  g.drawDeck('p0');
  g.discardDrawn('p0');
  assert.equal(g.phase, 'roundEnd');
  assert.equal(g.results.reason, 'deck');
});

test('locked caller: cards cannot be swapped after CABO when the rule is on', () => {
  const g = rig([['5S', '6S', '7S', '8S'], ['5H', '6H', '7H', '8H']], { deck: ['JD', 'QD'], rules: { lockCaller: true } });
  g.callCabo('p0');
  g.drawDeck('p1');
  assert.throws(() => g.usePower('p1', { own: 0, pid: 'p0', slot: 0 }), /locked/);
  g.discardDrawn('p1');
  assert.equal(g.phase, 'roundEnd');
});

test('red King power can be switched off', () => {
  const g = rig([['5S', '6S', '7S', '8S'], ['5H', '6H', '7H', '8H']], { deck: ['KH'], rules: { redKingPower: false } });
  g.drawDeck('p0');
  assert.equal(g.viewFor('p0').turn.power, null);
  assert.throws(() => g.usePower('p0', { own: 0, pid: 'p1', slot: 0 }), /no power/);
});

test('timeouts pass the turn with as little effect as possible', () => {
  const g = rig([['5S', '6S', '7S', '8S'], ['5H', '6H', '7H', '8H']], { deck: ['2D', '3D', '9D'], discard: ['AC'] });
  g.autoPlay('p0');
  assert.equal(g.turn.pid, 'p1');
  assert.equal(g.deck.length, 3, 'a pass draws nothing');
  g.takeDiscard('p1');
  g.autoPlay('p1');
  assert.equal(g.discard.at(-1).r + g.discard.at(-1).s, 'AC', 'the taken card goes back');
  assert.deepEqual(codes(g.players[1].hand), ['5H', '6H', '7H', '8H']);
  g.drawDeck('p0');
  g.autoPlay('p0');
  assert.equal(g.discard.at(-1).r + g.discard.at(-1).s, '2D');
  g.drawDeck('p1');
  g.discardDrawn('p1');
  g.drawDeck('p0');
  g.autoPlay('p0');
  assert.equal(g.turn.pid, 'p1');
});

test('removing the current player mid-turn hands the turn on', () => {
  const g = rig([['5S', '6S', '7S', '8S'], ['5H', '6H', '7H', '8H'], ['5C', '6C', '7C', '8C']], { deck: ['2D', '3D'] });
  g.drawDeck('p0');
  g.removePlayer('p0');
  assert.equal(g.players.length, 2);
  assert.equal(g.turn.pid, 'p1');
  assert.equal(g.discard.at(-1).r + g.discard.at(-1).s, '2D');
  assert.equal(g.deck.length, 1);
  assert.equal(g.discard.length, 1 + 4 + 1, 'start card + the removed hand underneath + the drawn card');
  assert.equal(g.players.reduce((a, p) => a + p.hand.length, 0), 8);
  g.removePlayer('p2');
  assert.equal(g.phase, 'gameOver');
  assert.deepEqual(g.winners, ['p1']);
});

test('removing a player during the opening peek starts play once everyone left is ready', () => {
  const g = new Game(players(3), {}, { rng: seededRng(9) });
  g.peekReady('p0');
  g.peekReady('p1');
  const start = g.startPid;
  g.removePlayer('p2');
  assert.equal(g.phase, 'turn');
  assert.ok(g.has(g.turn.pid));
  if (start !== 'p2') assert.equal(g.turn.pid, start);
});

test('removing the CABO caller still lets the final lap finish', () => {
  const g = rig([['5S', '6S', '7S', '8S'], ['5H', '6H', '7H', '8H'], ['5C', '6C', '7C', '8C']], { deck: ['2D', '3D'] });
  g.callCabo('p0');
  g.removePlayer('p0');
  g.drawDeck('p1');
  g.discardDrawn('p1');
  g.drawDeck('p2');
  g.discardDrawn('p2');
  assert.equal(g.phase, 'roundEnd');
  assert.equal(g.results.rows.length, 2);
});

test('next round: lowest scorer of the last round starts', () => {
  const g = rig([['9S', '9H'], ['AH', '2H'], ['AC', '2C']], { deck: ['5D', '6D', '7D'], discard: ['3C'], start: 0 });
  g.callCabo('p0');
  g.drawDeck('p1');
  g.discardDrawn('p1');
  g.drawDeck('p2');
  g.discardDrawn('p2');
  // p0: 18 + 10; p1: 3; p2: 3 (tie → closer to previous start p0 clockwise = p1)
  g.nextRound();
  assert.equal(g.startPid, 'p1');
  assert.equal(g.round, 2);
  assert.equal(g.phase, 'peek');
  for (const p of g.players) assert.equal(p.hand.length, 4);
});

test('rename keeps the seat and updates results', () => {
  const g = rig([['5S'], ['5H']], { deck: ['2D'] });
  g.renamePlayer('p1', 'Asha');
  assert.equal(g.viewFor('p0').players[1].name, 'Asha');
});
