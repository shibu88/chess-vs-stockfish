// config.js — settings and small "pure" helper functions.
// Nothing here touches the page or the engine, so it can be unit-tested in Node.

// Path to the Stockfish Web Worker script. The worker finds its .wasm file
// automatically by swapping ".js" for ".wasm" in this same path.
export const ENGINE_PATH = 'engine/stockfish-18-lite-single.js';

// How long to wait for the engine to start before showing an error (ms).
export const ENGINE_START_TIMEOUT_MS = 15000;

// Difficulty levels, weakest first.
//  elo      → Stockfish's Elo limiter (UCI_LimitStrength + UCI_Elo, allowed 1320–3190).
//             null = no Elo limit.
//  skill    → Stockfish "Skill Level" (0 = weakest, 20 = full strength). Only used
//             when there is no Elo limit; Beginner needs it because Elo can't go below 1320.
//  depth    → maximum number of half-moves to look ahead (null = no limit).
//  movetime → maximum thinking time per move in milliseconds.
// The search stops at whichever limit (depth or time) is reached first.
export const DIFFICULTY = {
  beginner:     { label: 'Beginner',                elo: null, skill: 0,  depth: 1,    movetime: 100 },
  casual:       { label: 'Casual',                  elo: 1400, skill: 20, depth: null, movetime: 300 },
  intermediate: { label: 'Intermediate',            elo: 1800, skill: 20, depth: null, movetime: 500 },
  advanced:     { label: 'Advanced',                elo: 2200, skill: 20, depth: null, movetime: 800 },
  master:       { label: 'Master',                  elo: 2600, skill: 20, depth: null, movetime: 1000 },
  full:         { label: 'GrandMaster', elo: null, skill: 20, depth: null, movetime: 3000 },
};

// Hash table size (MB) set once when the engine starts. Bigger helps the
// unlimited level; the Elo-limited levels stay at their rating.
export const ENGINE_HASH_MB = 64;

// The "setoption" commands that set a level's strength. All three options are
// sent every time, so switching levels never leaves an old limit behind.
export function buildStrengthCommands(levelName) {
  const level = DIFFICULTY[levelName];
  if (!level) throw new Error(`Unknown difficulty: ${levelName}`);
  const cmds = [
    `setoption name UCI_LimitStrength value ${level.elo ? 'true' : 'false'}`,
    `setoption name Skill Level value ${level.skill}`,
  ];
  if (level.elo) cmds.push(`setoption name UCI_Elo value ${level.elo}`);
  return cmds;
}

// Build the UCI "go" command for a difficulty level, e.g. "go depth 1 movetime 100".
// timeLeftMs (optional): the engine's remaining clock time. Thinking time is then
// capped at 1/30 of it (at least 50 ms), so Stockfish can't lose on time in fast games.
export function buildGoCommand(levelName, timeLeftMs) {
  const level = DIFFICULTY[levelName];
  if (!level) throw new Error(`Unknown difficulty: ${levelName}`);
  let movetime = level.movetime;
  if (timeLeftMs != null) movetime = Math.max(50, Math.min(movetime, Math.floor(timeLeftMs / 30)));
  let cmd = 'go';
  if (level.depth) cmd += ` depth ${level.depth}`;
  cmd += ` movetime ${movetime}`;
  return cmd;
}

// Turn an engine reply like "bestmove e7e8q ponder d2d4" into
// { from: 'e7', to: 'e8', promotion: 'q' }. Returns null if there is no move
// (e.g. "bestmove (none)" when the game is already over).
export function parseBestMove(line) {
  const match = /^bestmove ([a-h][1-8])([a-h][1-8])([qrbn])?/.exec(line);
  if (!match) return null;
  const move = { from: match[1], to: match[2] };
  if (match[3]) move.promotion = match[3];
  return move;
}

// True if a square such as "h1" is a light square. a1 is dark and h1 is light
// ("light on the right"), so a8 and e8 are light and e1 is dark.
export function isLightSquare(square) {
  const file = square.charCodeAt(0) - 97; // a = 0
  const rank = Number(square[1]);
  return (file + rank) % 2 === 0;
}

// Clock display: "m:ss", or "s.t" seconds with tenths under 10 s. Never negative.
export function formatClock(ms) {
  const t = Math.max(0, ms);
  if (t < 10000) return `0:0${Math.floor(t / 1000)}.${Math.floor((t % 1000) / 100)}`;
  const totalSeconds = Math.floor(t / 1000);
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, '0')}`;
}

// Status text when `flagged` ('w' or 'b') runs out of time. FIDE rule: it is a
// draw instead if the other side has only its king left (it could never mate).
export function timeoutText(game, flagged, playerColor) {
  const name = (c) => (c === 'w' ? 'White' : 'Black');
  const other = flagged === 'w' ? 'b' : 'w';
  const otherPieces = game.board().flat().filter((p) => p && p.color === other);
  if (otherPieces.length === 1) {
    return `Draw — ${name(flagged)} ran out of time, but ${name(other)} has only a king left.`;
  }
  return `Time out — ${name(other)} wins. ${other === playerColor ? 'You win!' : 'The computer wins.'}`;
}

// Read the evaluation from an engine "info" line, e.g. "info depth 12 ... score cp -35 ...".
// Returns { type: 'cp' | 'mate', value } from the point of view of the side to move,
// or null if the line has no exact score (bounds are skipped).
export function parseScore(line) {
  if (!line.startsWith('info') || /\b(lowerbound|upperbound)\b/.test(line)) return null;
  const match = /\bscore (cp|mate) (-?\d+)/.exec(line);
  return match ? { type: match[1], value: Number(match[2]) } : null;
}

// Draw-offer policy. Stockfish has no built-in way to accept or decline draws,
// so the game applies this fixed rule using Stockfish's own evaluation:
//   1. Offers before move `minMove` are declined (too early).
//   2. Otherwise Stockfish analyses the position at full strength for `analysisMs`.
//      It accepts if, from its own side, the evaluation is at most
//      `maxEngineAdvantageCp` centipawns (100 = one pawn), or if it is getting mated.
//      It declines if it is better than that, or has a forced mate itself.
export const DRAW_OFFER = { minMove: 20, analysisMs: 1000, maxEngineAdvantageCp: 20 };

// fullmoveNumber: chess.js move number. engineScore: { type, value } from the
// ENGINE's point of view (or null if unknown). Returns { accept, reason }.
export function decideDrawOffer(fullmoveNumber, engineScore) {
  if (fullmoveNumber < DRAW_OFFER.minMove) {
    return { accept: false, reason: `draw offers are only considered from move ${DRAW_OFFER.minMove}` };
  }
  if (!engineScore) return { accept: false, reason: 'it could not evaluate the position' };
  if (engineScore.type === 'mate') {
    return engineScore.value > 0
      ? { accept: false, reason: 'it sees a forced checkmate for itself' }
      : { accept: true, reason: 'it sees a forced checkmate against itself' };
  }
  const pawns = (engineScore.value / 100).toFixed(2);
  return engineScore.value <= DRAW_OFFER.maxEngineAdvantageCp
    ? { accept: true, reason: `its evaluation for itself is ${pawns} pawns` }
    : { accept: false, reason: `it thinks it is better (${engineScore.value > 0 ? '+' : ''}${pawns} pawns)` };
}

// Describe the current position for the status line.
// `game` is a chess.js Chess object; `playerColor` is 'w' or 'b'.
// Returns { text, over } where `over` is true when the game has ended.
export function getGameStatus(game, playerColor) {
  const sideToMove = game.turn() === 'w' ? 'White' : 'Black';
  const isPlayersTurn = game.turn() === playerColor;

  if (game.isCheckmate()) {
    const winner = game.turn() === 'w' ? 'Black' : 'White';
    return { text: `Checkmate — ${winner} wins. ${isPlayersTurn ? 'The computer wins.' : 'You win!'}`, over: true };
  }
  if (game.isStalemate()) return { text: 'Draw by stalemate.', over: true };
  if (game.isThreefoldRepetition()) return { text: 'Draw by threefold repetition.', over: true };
  if (game.isInsufficientMaterial()) return { text: 'Draw by insufficient material.', over: true };
  if (game.isDrawByFiftyMoves()) return { text: 'Draw by the 50-move rule.', over: true };

  const who = isPlayersTurn ? `Your move (${sideToMove})` : `Computer to move (${sideToMove})`;
  return { text: game.inCheck() ? `Check! ${who}` : who, over: false };
}
