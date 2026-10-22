// Unit tests for js/config.js helpers and for the chess.js rules the game relies on.
// Run with: npm test   (uses Node's built-in test runner, no installs needed)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from '../lib/chess.js/chess.js';
import {
  DIFFICULTY, buildGoCommand, buildStrengthCommands, parseBestMove, getGameStatus,
  isLightSquare, formatClock, timeoutText, parseScore, decideDrawOffer, DRAW_OFFER,
} from '../js/config.js';
import { ChessClock } from '../js/clock.js';

// --- config helpers -------------------------------------------------------

test('parseBestMove reads normal, promotion and "none" replies', () => {
  assert.deepEqual(parseBestMove('bestmove e2e4 ponder e7e5'), { from: 'e2', to: 'e4' });
  assert.deepEqual(parseBestMove('bestmove a7a8n'), { from: 'a7', to: 'a8', promotion: 'n' });
  assert.equal(parseBestMove('bestmove (none)'), null);
  assert.equal(parseBestMove('info depth 3'), null);
});

test('buildGoCommand gives a different search limit per level', () => {
  assert.equal(buildGoCommand('beginner'), 'go depth 1 movetime 100');
  assert.equal(buildGoCommand('intermediate'), 'go movetime 500');
  assert.equal(buildGoCommand('full'), 'go movetime 3000');
  assert.throws(() => buildGoCommand('impossible'));
});

test('buildStrengthCommands sets or clears every strength limit', () => {
  assert.deepEqual(buildStrengthCommands('beginner'), [
    'setoption name UCI_LimitStrength value false',
    'setoption name Skill Level value 0',
  ]);
  assert.deepEqual(buildStrengthCommands('advanced'), [
    'setoption name UCI_LimitStrength value true',
    'setoption name Skill Level value 20',
    'setoption name UCI_Elo value 2200',
  ]);
  assert.deepEqual(buildStrengthCommands('full'), [
    'setoption name UCI_LimitStrength value false',
    'setoption name Skill Level value 20',
  ]);
  assert.throws(() => buildStrengthCommands('impossible'));
});

test('seven difficulty levels get stronger in order', () => {
  const levels = Object.values(DIFFICULTY);
  assert.deepEqual(levels.map((l) => l.label),
    ['Beginner', 'Casual', 'Intermediate', 'Advanced', 'Hard', 'Master', 'GrandMaster']);
  // Elo-limited levels sit between Beginner (Skill 0) and GrandMaster (no limits),
  // within the engine's allowed UCI_Elo range.
  const elos = levels.slice(1, -1).map((l) => l.elo);
  assert.ok(elos.every((e, i) => e >= 1320 && e <= 3190 && (i === 0 || e > elos[i - 1])));
  assert.equal(levels[0].skill, 0);
  assert.ok(levels.every((l, i) => i === 0 || l.movetime > levels[i - 1].movetime));
  const full = DIFFICULTY.full;
  assert.ok(full.elo === null && full.skill === 20 && full.depth === null);
});

test('buildGoCommand caps thinking time when the clock is low', () => {
  assert.equal(buildGoCommand('full', 600000), 'go movetime 3000');         // plenty of time: unchanged
  assert.equal(buildGoCommand('full', 30000), 'go movetime 1000');          // 1/30 of 30 s
  assert.equal(buildGoCommand('beginner', 1000), 'go depth 1 movetime 50'); // never below 50 ms
});

// --- board colours ----------------------------------------------------------
test('square colours: h1, a8 and e8 are light; a1 and e1 are dark', () => {
  for (const sq of ['h1', 'a8', 'e8', 'd1', 'b1']) assert.equal(isLightSquare(sq), true, sq);
  for (const sq of ['a1', 'e1', 'h8', 'd8']) assert.equal(isLightSquare(sq), false, sq);
});

test('square colours alternate across all 64 squares', () => {
  for (const f of 'abcdefgh') {
    for (let r = 1; r <= 8; r++) {
      const sq = f + r;
      if (r < 8) assert.notEqual(isLightSquare(sq), isLightSquare(f + (r + 1)), `${sq} vs rank above`);
      if (f !== 'h') {
        const right = String.fromCharCode(f.charCodeAt(0) + 1) + r;
        assert.notEqual(isLightSquare(sq), isLightSquare(right), `${sq} vs ${right}`);
      }
    }
  }
});

// --- clock ------------------------------------------------------------------
function fakeClock() {
  let t = 0;
  const clock = new ChessClock(() => t);
  return { clock, advance: (ms) => { t += ms; } };
}

test('clock: nothing runs until the first move, then time comes off the side to move', () => {
  const { clock, advance } = fakeClock();
  clock.reset(180000);
  advance(5000);
  assert.equal(clock.timeLeft('w'), 180000);
  assert.equal(clock.timeLeft('b'), 180000);
  clock.switchTo('b');           // White moved; Black's clock starts
  advance(2500);
  assert.equal(clock.timeLeft('b'), 177500);
  assert.equal(clock.timeLeft('w'), 180000);
  clock.switchTo('w');
  advance(1000);
  assert.equal(clock.timeLeft('w'), 179000);
  assert.equal(clock.timeLeft('b'), 177500);
});

test('clock: elapsed time is exact however rarely it is read (no drift)', () => {
  const { clock, advance } = fakeClock();
  clock.reset(300000);
  clock.switchTo('w');
  for (let i = 0; i < 1000; i++) advance(7.3); // e.g. irregular timer ticks
  advance(60000);                               // e.g. a background tab for a minute
  assert.ok(Math.abs(clock.timeLeft('w') - (300000 - 7300 - 60000)) < 1e-6);
});

test('clock: pause/resume, stop, and flagging', () => {
  const { clock, advance } = fakeClock();
  clock.reset(10000);
  clock.switchTo('w');
  advance(4000);
  clock.pause();
  advance(60000);                // paused: no time used
  assert.equal(clock.timeLeft('w'), 6000);
  assert.equal(clock.flagged(), null);
  clock.resume();
  advance(6000);
  assert.equal(clock.flagged(), 'w');
  clock.stop();
  assert.equal(clock.flagged(), null);
  advance(5000);
  assert.equal(clock.timeLeft('w'), 0); // stopped clocks don't move
  clock.reset(60000);
  assert.equal(clock.timeLeft('w'), 60000);
  assert.equal(clock.active, null);
});

test('formatClock shows m:ss, and tenths under 10 seconds', () => {
  assert.equal(formatClock(600000), '10:00');
  assert.equal(formatClock(179999), '2:59');
  assert.equal(formatClock(65000), '1:05');
  assert.equal(formatClock(9450), '0:09.4');
  assert.equal(formatClock(0), '0:00.0');
  assert.equal(formatClock(-300), '0:00.0');
});

test('timeoutText: the other side wins, unless it has only a king (draw)', () => {
  const start = new Chess();
  assert.equal(timeoutText(start, 'w', 'w'), 'Time out — Black wins. The computer wins.');
  assert.equal(timeoutText(start, 'b', 'w'), 'Time out — White wins. You win!');
  const loneBlackKing = new Chess('4k3/8/8/8/8/8/4P3/4K2Q w - - 0 1');
  assert.equal(timeoutText(loneBlackKing, 'w', 'w'), 'Draw — White ran out of time, but Black has only a king left.');
  assert.match(timeoutText(loneBlackKing, 'b', 'w'), /White wins/);
});

// --- draw offers --------------------------------------------------------------
test('parseScore reads exact cp/mate scores and skips bounds', () => {
  assert.deepEqual(parseScore('info depth 14 seldepth 20 multipv 1 score cp -35 nodes 9 pv e2e4'), { type: 'cp', value: -35 });
  assert.deepEqual(parseScore('info depth 9 score mate 3 pv h5f7'), { type: 'mate', value: 3 });
  assert.equal(parseScore('info depth 9 score cp 50 lowerbound nodes 1'), null);
  assert.equal(parseScore('bestmove e2e4'), null);
});

test('decideDrawOffer follows the documented policy', () => {
  const late = DRAW_OFFER.minMove;
  const max = DRAW_OFFER.maxEngineAdvantageCp;
  assert.equal(decideDrawOffer(late - 1, { type: 'cp', value: -500 }).accept, false); // too early
  assert.match(decideDrawOffer(1, null).reason, /from move 20/);
  assert.equal(decideDrawOffer(late, null).accept, false);                            // no evaluation
  assert.equal(decideDrawOffer(late, { type: 'cp', value: -300 }).accept, true);      // Stockfish worse
  assert.equal(decideDrawOffer(late, { type: 'cp', value: 0 }).accept, true);         // equal
  assert.equal(decideDrawOffer(late, { type: 'cp', value: max }).accept, true);
  assert.equal(decideDrawOffer(late, { type: 'cp', value: max + 1 }).accept, false);
  assert.equal(decideDrawOffer(late, { type: 'mate', value: 4 }).accept, false);      // Stockfish mates
  assert.equal(decideDrawOffer(late, { type: 'mate', value: -4 }).accept, true);      // Stockfish gets mated
});

// --- chess.js rules used by the game ---------------------------------------

test('illegal moves are rejected', () => {
  const game = new Chess();
  assert.throws(() => game.move({ from: 'e2', to: 'e5' }));      // pawn can't jump 3
  assert.throws(() => game.move({ from: 'e7', to: 'e5' }));      // not Black's turn
  assert.equal(game.history().length, 0);
});

test('castling both sides, and not through check', () => {
  const fen = 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1';
  let game = new Chess(fen);
  assert.equal(game.move({ from: 'e1', to: 'g1' }).san, 'O-O');
  assert.equal(game.get('f1').type, 'r');

  game = new Chess(fen);
  assert.equal(game.move({ from: 'e1', to: 'c1' }).san, 'O-O-O');
  assert.equal(game.get('d1').type, 'r');

  // A black rook on f2 attacks f1, so White may not castle kingside.
  game = new Chess('r3k2r/8/8/8/8/8/5r2/R3K2R w KQkq - 0 1');
  assert.throws(() => game.move({ from: 'e1', to: 'g1' }));
});

test('en passant capture removes the passed pawn', () => {
  const game = new Chess('rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq f6 0 3');
  const move = game.move({ from: 'e5', to: 'f6' });
  assert.ok(move.isEnPassant());
  assert.equal(game.get('f5'), undefined);
});

test('promotion to each of queen, rook, bishop and knight', () => {
  for (const piece of ['q', 'r', 'b', 'n']) {
    const game = new Chess('8/P7/8/8/8/8/8/k6K w - - 0 1');
    game.move({ from: 'a7', to: 'a8', promotion: piece });
    assert.equal(game.get('a8').type, piece);
  }
  // The UI must always supply a promotion piece; chess.js refuses without one.
  const game = new Chess('8/P7/8/8/8/8/8/k6K w - - 0 1');
  assert.throws(() => game.move({ from: 'a7', to: 'a8' }));
});

// --- game status messages --------------------------------------------------

test('checkmate is detected (fool\'s mate)', () => {
  const game = new Chess();
  ['f3', 'e5', 'g4', 'Qh4#'].forEach((san) => game.move(san));
  const status = getGameStatus(game, 'w');
  assert.equal(status.over, true);
  assert.match(status.text, /Checkmate — Black wins\. The computer wins\./);
  assert.match(getGameStatus(game, 'b').text, /You win!/);
});

test('check is reported but the game continues', () => {
  const game = new Chess();
  ['e4', 'f6', 'Qh5+'].forEach((san) => game.move(san));
  assert.deepEqual(getGameStatus(game, 'b'), { text: 'Check! Your move (Black)', over: false });
});

test('stalemate is detected', () => {
  const game = new Chess('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1');
  assert.deepEqual(getGameStatus(game, 'w'), { text: 'Draw by stalemate.', over: true });
});

test('threefold repetition is detected', () => {
  const game = new Chess();
  ['Nf3', 'Nf6', 'Ng1', 'Ng8', 'Nf3', 'Nf6', 'Ng1', 'Ng8'].forEach((san) => game.move(san));
  assert.deepEqual(getGameStatus(game, 'w'), { text: 'Draw by threefold repetition.', over: true });
});

test('insufficient material is detected', () => {
  const game = new Chess('8/8/8/8/8/8/8/k6K w - - 0 1');
  assert.deepEqual(getGameStatus(game, 'w'), { text: 'Draw by insufficient material.', over: true });
});

test('50-move rule is detected', () => {
  const game = new Chess('8/8/8/8/8/8/R7/k6K w - - 100 80');
  assert.deepEqual(getGameStatus(game, 'w'), { text: 'Draw by the 50-move rule.', over: true });
});

test('normal turn messages', () => {
  const game = new Chess();
  assert.deepEqual(getGameStatus(game, 'w'), { text: 'Your move (White)', over: false });
  assert.deepEqual(getGameStatus(game, 'b'), { text: 'Computer to move (White)', over: false });
});
