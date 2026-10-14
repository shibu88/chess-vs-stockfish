// main.js — the game controller.
//
//   chess.js  = the referee: legal moves, check/mate/draw, move history (SAN)
//   Stockfish = the opponent: suggests the computer's move (js/engine.js)
//   Board     = the display: draws pieces and reports clicks/drags (js/board.js)
//   Clock     = the chess clock (js/clock.js)
//
// Flow: player clicks or drags → chess.js validates the move → clocks switch →
//       board redraws → Stockfish is asked for a reply → chess.js plays it → …

import { Chess } from '../lib/chess.js/chess.js';
import { Board } from './board.js';
import { Engine } from './engine.js';
import { ChessClock } from './clock.js';
import { getGameStatus, formatClock, timeoutText, decideDrawOffer, DRAW_OFFER } from './config.js';

// ---- Page elements ----
const $ = (id) => document.getElementById(id);
const statusEl = $('status');
const thinkingEl = $('thinking');
const noticeEl = $('notice');
const errorEl = $('engine-error');
const errorTextEl = $('engine-error-text');
const difficultySelect = $('difficulty');
const colorSelect = $('color');
const timeSelect = $('time-control');
const newGameButton = $('new-game');
const restartButton = $('restart');
const offerDrawButton = $('offer-draw');
const resignButton = $('resign');
const resignConfirmEl = $('resign-confirm');
const historyEl = $('history');
const clockEls = { top: $('clock-top'), bottom: $('clock-bottom') };

// ---- Game state ----
const game = new Chess();
const engine = new Engine();
const clock = new ChessClock();
const board = new Board($('board'), $('promotion'), onSquareClick, {
  canDrag: (square) => playerCanMove() && game.get(square)?.color === playerColor,
  onDragStart: selectSquare,
  onDrop,
});

let playerColor = 'w';  // the human's colour
let minutes = 10;       // this game's time control, per player
let selected = null;    // square the player has picked, e.g. "e2"
let targets = [];       // legal moves (chess.js verbose objects) for the selected piece
let lastMove = null;    // { from, to } of the most recent move
let thinking = false;   // true while Stockfish is searching for its move
let drawPending = false; // true while Stockfish considers the player's draw offer
let result = null;      // text of a result chess.js doesn't know about: timeout, resignation, agreed draw
let engineReady = false;
let engineFailed = false;
let gameId = 0;         // increases on every new game (and game end), so late engine replies are ignored

// Optional testing aid: index.html?fen=<position> starts games from that position.
const startFen = new URLSearchParams(location.search).get('fen');

const colorName = (c) => (c === 'w' ? 'White' : 'Black');
const engineColor = () => (playerColor === 'w' ? 'b' : 'w');

// Over by chess rules (mate, stalemate, …) or by timeout / resignation / agreed draw.
function gameOver() {
  return Boolean(result) || getGameStatus(game, playerColor).over;
}

// ---- Starting and restarting ----

async function startNewGame(color, gameMinutes) {
  const id = ++gameId;
  board.closePromotion(null);
  game.reset();
  if (startFen) {
    try { game.load(startFen); } catch { console.warn('Ignoring invalid ?fen= parameter'); }
  }
  playerColor = color;
  colorSelect.value = color;
  minutes = gameMinutes;
  timeSelect.value = String(gameMinutes);
  clock.reset(gameMinutes * 60000); // clocks start with the first move
  selected = null;
  targets = [];
  lastMove = null;
  thinking = false;
  drawPending = false;
  result = null;
  showNotice('');
  resignConfirmEl.hidden = true;
  board.setOrientation(color);
  update();

  if (!engineReady) return;      // the engine will move once it has loaded
  await engine.newGame();        // stops any search still running from the old game
  if (id !== gameId) return;     // another New Game was clicked meanwhile
  computerMoveIfNeeded();
}

// Timeout, resignation or agreed draw: stop everything and show the result.
function endGame(text) {
  gameId++;                      // ignore any engine reply still on its way
  result = text;
  thinking = false;
  drawPending = false;
  clock.stop();
  selected = null;
  targets = [];
  resignConfirmEl.hidden = true;
  board.closePromotion(null);
  update();
}

// Called after every move that was actually played.
function afterMove(move) {
  lastMove = { from: move.from, to: move.to };
  showNotice('');
  // The first move starts the clocks; every move hands the clock to the other side.
  if (getGameStatus(game, playerColor).over) clock.stop();
  else clock.switchTo(game.turn());
}

// If the side to move has run out of time, end the game. Returns true if it did.
function checkFlag() {
  const flagged = clock.flagged();
  if (!flagged || gameOver()) return false;
  endGame(timeoutText(game, flagged, playerColor));
  return true;
}

// ---- Player moves ----

function playerCanMove() {
  return engineReady && !thinking && !drawPending && !gameOver() && game.turn() === playerColor;
}

function selectSquare(square) {
  selected = square;
  targets = game.moves({ square, verbose: true });
  update();
}

function onSquareClick(square) {
  if (!playerCanMove()) return;
  const piece = game.get(square);

  if (selected && targets.some((m) => m.to === square)) {
    playPlayerMove(selected, square);
    return;
  }
  if (piece && piece.color === playerColor && square !== selected) {
    selectSquare(square);
    return;
  }
  selected = null;
  targets = [];
  update();
}

// A dragged piece was dropped on `to` (null = off the board).
function onDrop(from, to) {
  if (!playerCanMove()) return;
  if (to && to !== from && targets.some((m) => m.to === to)) {
    playPlayerMove(from, to);
  } else {
    update(); // illegal or no move: redraw, so the piece is back on its square
  }
}

async function playPlayerMove(from, to) {
  const id = gameId;
  let promotion;
  if (targets.some((m) => m.to === to && m.isPromotion())) {
    promotion = await board.askPromotion(playerColor);
    if (id !== gameId) return; // a new game started (or the game ended) meanwhile
    if (!promotion) {          // cancelled: clear the selection so the next tap starts fresh
      selected = null;
      targets = [];
      update();
      return;
    }
  }
  if (checkFlag()) return;     // time ran out before the move was made

  try {
    afterMove(game.move({ from, to, promotion }));
  } catch {
    return; // chess.js says the move is illegal — ignore it (the clock keeps running for the same side)
  }
  selected = null;
  targets = [];
  update();
  computerMoveIfNeeded();
}

// ---- Computer moves ----

async function computerMoveIfNeeded() {
  if (!engineReady || thinking || gameOver() || game.turn() === playerColor) return;

  const id = gameId;
  thinking = true;
  update();
  const move = await engine.getBestMove(game.fen(), difficultySelect.value, clock.timeLeft(engineColor()));
  if (id !== gameId) return; // this reply belongs to a game that was abandoned or has ended
  thinking = false;
  if (checkFlag()) return;   // Stockfish ran out of time before replying

  if (move) {
    try {
      afterMove(game.move(move));
    } catch {
      console.error('Engine suggested an illegal move:', move);
    }
  }
  update();
}

// ---- Draw offers and resignation ----

// See DRAW_OFFER / decideDrawOffer in config.js for the policy.
async function offerDraw() {
  if (!playerCanMove()) return;
  const id = gameId;
  drawPending = true;
  clock.pause();               // considering the offer costs the player no time
  selected = null;
  targets = [];
  showNotice('You offered a draw. Stockfish is considering it…');
  update();

  let score = null;
  if (game.moveNumber() >= DRAW_OFFER.minMove) {
    score = await engine.evaluate(game.fen(), DRAW_OFFER.analysisMs);
    if (id !== gameId) return; // New Game or Resign meanwhile
  }
  // The score is for the side to move (the player); flip it to Stockfish's side.
  const engineScore = score && { type: score.type, value: -score.value };
  const decision = decideDrawOffer(game.moveNumber(), engineScore);
  if (decision.accept) {
    endGame(`Draw agreed — Stockfish accepted your draw offer (${decision.reason}).`);
    return;
  }
  drawPending = false;
  clock.resume();
  update();
  showNotice(`Stockfish declined your draw offer: ${decision.reason}. Play on.`);
}

function resign() {
  if (gameOver()) return;
  endGame(`You resigned — ${colorName(engineColor())} wins.`);
}

// ---- Engine loading and errors ----

async function loadEngine() {
  engineReady = false;
  engineFailed = false;
  errorEl.hidden = true;
  update();
  try {
    await engine.start();
    engineReady = true;
    if (!gameOver()) clock.resume(); // continue a game interrupted by an engine failure
    update();
    computerMoveIfNeeded(); // e.g. the player chose Black, so the computer opens
  } catch (error) {
    showEngineError(error);
  }
}

function showEngineError(error) {
  console.error('Engine error:', error);
  gameId++; // forget any search that was in progress
  engineReady = false;
  engineFailed = true;
  thinking = false;
  drawPending = false;
  clock.pause(); // nobody can play without the engine, so time stands still
  errorTextEl.textContent = `The chess engine could not be loaded or stopped working. (${error.message})`;
  errorEl.hidden = false;
  update();
}

engine.onCrash = showEngineError;

// ---- Drawing the page ----

function showNotice(text) {
  noticeEl.textContent = text;
  noticeEl.hidden = !text;
}

function update() {
  const status = getGameStatus(game, playerColor);
  const over = gameOver();

  if (result) {
    statusEl.textContent = result;
  } else if (engineFailed) {
    statusEl.textContent = 'Engine unavailable — see the message below.';
  } else if (!engineReady) {
    statusEl.textContent = 'Loading the engine…';
  } else {
    statusEl.textContent = status.text;
  }
  statusEl.classList.toggle('game-over', over);
  statusEl.classList.toggle('check', !over && game.inCheck());
  thinkingEl.hidden = !thinking;

  // While the engine thinks, settings can't change. New Game / Restart stay
  // available because they safely stop the engine first.
  difficultySelect.disabled = thinking;
  colorSelect.disabled = thinking;
  timeSelect.disabled = thinking;
  offerDrawButton.disabled = !playerCanMove();
  resignButton.disabled = over || !engineReady || !resignConfirmEl.hidden;

  board.render(game, { selected, targets, lastMove, interactive: playerCanMove() });
  renderHistory();
  renderClocks();
}

// Clocks: the board's top colour is the opponent's. Called often, so it only touches the clocks.
function renderClocks() {
  const bottom = playerColor;
  const top = engineColor();
  for (const [where, color] of [['top', top], ['bottom', bottom]]) {
    const el = clockEls[where];
    const left = clock.timeLeft(color);
    el.querySelector('.clock-name').textContent = `${colorName(color)} · ${color === playerColor ? 'You' : 'Stockfish'}`;
    el.querySelector('.clock-time').textContent = formatClock(left);
    el.classList.toggle('active', clock.running && clock.active === color);
    el.classList.toggle('low', left < 20000);
    el.classList.toggle('flagged', left <= 0);
    el.dataset.color = color;
  }
}

function renderHistory() {
  const moves = game.history();
  historyEl.replaceChildren();
  for (let i = 0; i < moves.length; i += 2) {
    const li = document.createElement('li');
    for (const san of [moves[i], moves[i + 1] || '']) {
      const span = document.createElement('span');
      span.textContent = san;
      li.appendChild(span);
    }
    historyEl.appendChild(li);
  }
  historyEl.scrollTop = historyEl.scrollHeight;
}

// The display refreshes 10× a second. The time itself is computed from timestamps,
// so slow or paused timers (e.g. a background tab) never make the clock wrong.
function tick() {
  if (!checkFlag()) renderClocks();
}
setInterval(tick, 100);
document.addEventListener('visibilitychange', tick);

// ---- Buttons ----

newGameButton.addEventListener('click', () => startNewGame(colorSelect.value, Number(timeSelect.value)));
restartButton.addEventListener('click', () => startNewGame(playerColor, minutes));
offerDrawButton.addEventListener('click', offerDraw);
resignButton.addEventListener('click', () => {
  resignConfirmEl.hidden = false;
  update();
  $('resign-cancel').focus();
});
$('resign-yes').addEventListener('click', resign);
$('resign-cancel').addEventListener('click', () => {
  resignConfirmEl.hidden = true;
  update();
});
$('retry-engine').addEventListener('click', loadEngine);

// On small screens, start with the move list collapsed to save space.
if (window.matchMedia('(max-width: 767px)').matches) $('history-panel').open = false;

startNewGame(colorSelect.value, Number(timeSelect.value));
loadEngine();
