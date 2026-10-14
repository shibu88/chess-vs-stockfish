// Engine test: runs the real engine/stockfish-18-lite-single.js (+ .wasm) in Node,
// sends the same UCI commands the website sends, and checks every reply with chess.js.
// No network access is involved — the engine is loaded straight from disk.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Chess } from '../lib/chess.js/chess.js';
import { DIFFICULTY, ENGINE_HASH_MB, buildStrengthCommands, buildGoCommand, parseBestMove, parseScore } from '../js/config.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const enginePath = path.join(root, 'engine', 'stockfish-18-lite-single.js');
const wasmPath = enginePath.replace(/\.js$/, '.wasm');

// Load the engine script as a CommonJS module (it is a browser worker script that
// also supports Node). We evaluate it with a fake `module` so it exports its
// factory function instead of starting its own command-line interface.
function loadEngineFactory() {
  const mod = { exports: {} };
  const source = readFileSync(enginePath, 'utf8');
  new Function('module', 'exports', 'require', '__filename', '__dirname', source)(
    mod, mod.exports, createRequire(enginePath), enginePath, path.dirname(enginePath));
  return mod.exports;
}

let engine;
let lines = [];
let waiters = [];

function send(cmd) {
  // "go" must run asynchronously so later commands (like "stop") can interrupt it.
  setImmediate(() => engine.ccall('command', null, ['string'], [cmd], { async: /^go\b/.test(cmd) }));
}
function waitFor(testFn, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for engine')), timeoutMs);
    waiters.push({ testFn, resolve: (l) => { clearTimeout(timer); resolve(l); } });
  });
}

before(async () => {
  const factory = loadEngineFactory();
  engine = { locateFile: (f) => (f.includes('.wasm') ? wasmPath : enginePath) };
  await factory()(engine);
  while (engine._isReady && !engine._isReady()) await new Promise((r) => setTimeout(r, 10));
  engine.listener = (line) => {
    lines.push(line);
    for (const w of [...waiters]) {
      if (w.testFn(line)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(line); }
    }
  };
  send('uci');
  await waitFor((l) => l === 'uciok');
  send(`setoption name Hash value ${ENGINE_HASH_MB}`); // same as js/engine.js
});

async function bestMove(fen, level) {
  for (const cmd of buildStrengthCommands(level)) send(cmd);
  send(`position fen ${fen}`);
  const reply = waitFor((l) => l.startsWith('bestmove'));
  send(buildGoCommand(level));
  return parseBestMove(await reply);
}

test('engine reports the strength options we use', () => {
  for (const name of ['Skill Level', 'UCI_LimitStrength', 'UCI_Elo', 'Hash']) {
    assert.ok(lines.some((l) => l.startsWith(`option name ${name} type `)), name);
  }
});

const positions = {
  start: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  middlegame: 'r1bq1rk1/pp2bppp/2n1pn2/3p4/2PP4/2N1PN2/PP3PPP/R2QKB1R b KQ - 0 8',
};

for (const level of Object.keys(DIFFICULTY)) {
  test(`${level}: engine returns legal moves within its time limit`, async () => {
    for (const fen of Object.values(positions)) {
      const t0 = Date.now();
      const move = await bestMove(fen, level);
      const ms = Date.now() - t0;
      assert.ok(move, 'engine returned a move');
      assert.doesNotThrow(() => new Chess(fen).move(move), `legal: ${JSON.stringify(move)}`);
      assert.ok(ms < DIFFICULTY[level].movetime + 1500, `took ${ms} ms`);
      console.log(`  ${level} ${fen.split(' ')[1]} → ${move.from}${move.to}${move.promotion || ''} in ${ms} ms`);
    }
  });
}

test('full strength finds mate in one', async () => {
  // White: Qh5 with Bc4 — Qxf7# is mate (scholar's mate pattern).
  const fen = 'r1bqkbnr/pppp1ppp/2n5/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4';
  const move = await bestMove(fen, 'full');
  const game = new Chess(fen);
  game.move(move);
  assert.ok(game.isCheckmate(), `expected mate, got ${move.from}${move.to}`);
});

// Mirrors Engine.evaluate() in js/engine.js (used for draw offers).
async function evaluate(fen, ms) {
  for (const cmd of buildStrengthCommands('full')) send(cmd);
  send(`position fen ${fen}`);
  let score = null;
  const reply = waitFor((l) => { score = parseScore(l) || score; return l.startsWith('bestmove'); });
  send(`go movetime ${ms}`);
  await reply;
  return score;
}

test('evaluation for draw offers: scores are from the side to move', async () => {
  // White is a queen up. With White to move the score is clearly positive...
  const whiteToMove = await evaluate('6k1/5ppp/8/8/8/8/5PPP/3Q2K1 w - - 0 30', 500);
  assert.ok(whiteToMove && (whiteToMove.type === 'mate' ? whiteToMove.value > 0 : whiteToMove.value > 300), JSON.stringify(whiteToMove));
  // ...and with Black to move it is clearly negative.
  const blackToMove = await evaluate('6k1/5ppp/8/8/8/8/5PPP/3Q2K1 b - - 0 30', 500);
  assert.ok(blackToMove && (blackToMove.type === 'mate' ? blackToMove.value < 0 : blackToMove.value < -300), JSON.stringify(blackToMove));
  console.log(`  eval white-to-move ${JSON.stringify(whiteToMove)}, black-to-move ${JSON.stringify(blackToMove)}`);
});

test('engine promotes with a promotion letter', async () => {
  const fen = '8/P6k/8/8/8/8/8/K7 w - - 0 1';
  const move = await bestMove(fen, 'full');
  assert.deepEqual(move, { from: 'a7', to: 'a8', promotion: 'q' });
});

test('checkmated position gives "bestmove (none)" → null', async () => {
  const fen = 'rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3';
  assert.equal(await bestMove(fen, 'beginner'), null);
});

// Mirrors Engine.newGame() in js/engine.js: stop, wait for the stale bestmove,
// then ucinewgame + isready. (Note: this build can send "readyok" *before* the
// stale bestmove, which is why newGame() waits for the bestmove explicitly.)
test('stop interrupts a long search, and the next search is unaffected', async () => {
  send(`position fen ${positions.middlegame}`);
  send('go movetime 10000');
  await new Promise((r) => setTimeout(r, 200));
  const t0 = Date.now();
  const stale = waitFor((l) => l.startsWith('bestmove'));
  send('stop');
  await stale;
  assert.ok(Date.now() - t0 < 3000, `stopped promptly (${Date.now() - t0} ms)`);
  send('ucinewgame');
  send('isready');
  await waitFor((l) => l === 'readyok');

  // A fresh search from the start position must return a move legal *there*.
  const move = await bestMove(positions.start, 'beginner');
  assert.doesNotThrow(() => new Chess(positions.start).move(move));
});
