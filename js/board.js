// board.js — draws the chessboard and reports which square was clicked/tapped,
// or which piece was dragged where. It knows nothing about chess rules: main.js
// asks chess.js what is legal and then tells the board what to highlight.
//
// Security note: everything is built with DOM methods (createElement/textContent),
// never by inserting HTML strings, so nothing can be injected into the page.

import { isLightSquare } from './config.js';

const FILES = 'abcdefgh';
// Solid chess symbols for both colours (CSS colours them).
const GLYPHS = { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' };
// Added after each symbol: asks phones to draw it as text, not as a colourful emoji.
const TEXT_STYLE = '︎';
const NAMES = { k: 'king', q: 'queen', r: 'rook', b: 'bishop', n: 'knight', p: 'pawn' };
// A press only becomes a drag after the pointer moves this many pixels,
// so ordinary clicks and taps keep working as before.
const DRAG_THRESHOLD_PX = 5;

function makeSpan(className, text) {
  const span = document.createElement('span');
  span.className = className;
  span.textContent = text;
  return span;
}

function pieceElement(color, type) {
  return makeSpan(`piece ${color === 'w' ? 'w' : 'b'}`, (GLYPHS[type] || '') + TEXT_STYLE);
}

export class Board {
  // boardEl: the empty board <div>; promotionEl: the promotion picker;
  // onSquareClick(square): called with e.g. "e2" when a square is chosen.
  // drag (optional): { canDrag(square), onDragStart(square), onDrop(from, to) }.
  //   onDrop gets to = null when the piece was dropped off the board.
  constructor(boardEl, promotionEl, onSquareClick, drag = null) {
    this.boardEl = boardEl;
    this.promotionEl = promotionEl;
    this.orientation = 'w';
    this.squares = {};           // "e2" → <button>
    this.coords = {};            // "e2" → coordinate label elements for that square
    this.resolvePromotion = null;
    this.dragHandlers = drag;
    this.drag = null;            // the press/drag in progress, if any
    this.ignoreClickUntil = 0;   // the click that follows a drag is not a real click

    boardEl.addEventListener('click', (event) => {
      if (performance.now() < this.ignoreClickUntil) {
        this.ignoreClickUntil = 0;
        return;
      }
      const square = event.target.closest('[data-square]');
      if (square) onSquareClick(square.dataset.square);
    });
    if (drag) {
      boardEl.addEventListener('pointerdown', (event) => this.onPointerDown(event));
      boardEl.addEventListener('pointermove', (event) => this.onPointerMove(event));
      boardEl.addEventListener('pointerup', (event) => this.onPointerUp(event));
      boardEl.addEventListener('pointercancel', (event) => this.onPointerUp(event, true));
      boardEl.addEventListener('dragstart', (event) => event.preventDefault()); // no browser drag-and-drop
    }
    promotionEl.addEventListener('click', (event) => {
      const button = event.target.closest('button');
      if (button) this.closePromotion(button.dataset.piece || null);
    });
    promotionEl.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') this.closePromotion(null);
    });
    this.build();
  }

  // Which colour is shown at the bottom: 'w' or 'b'.
  setOrientation(color) {
    if (color !== this.orientation) {
      this.orientation = color;
      this.build();
    }
  }

  // Create the 64 square buttons in display order (rank 8 at the top for White).
  build() {
    this.endDrag();
    this.boardEl.replaceChildren();
    this.squares = {};
    this.coords = {};
    const ranks = this.orientation === 'w' ? [8, 7, 6, 5, 4, 3, 2, 1] : [1, 2, 3, 4, 5, 6, 7, 8];
    const files = this.orientation === 'w' ? [...FILES] : [...FILES].reverse();

    ranks.forEach((rank, row) => {
      files.forEach((file, col) => {
        const name = file + rank;
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.square = name;
        button.className = `square ${isLightSquare(name) ? 'light' : 'dark'}`;
        // Coordinates along the left and bottom edges.
        const coords = [];
        if (col === 0) coords.push(makeSpan('coord rank', String(rank)));
        if (row === 7) coords.push(makeSpan('coord file', file));
        this.coords[name] = coords;
        this.boardEl.appendChild(button);
        this.squares[name] = button;
      });
    });
  }

  // Redraw pieces and highlights from a chess.js game.
  //   selected:    square the player picked, or null
  //   targets:     legal moves for that piece (chess.js verbose moves)
  //   lastMove:    { from, to } of the previous move, or null
  //   interactive: false while the computer thinks or the game is over
  render(game, { selected = null, targets = [], lastMove = null, interactive = true } = {}) {
    const targetSquares = new Map(targets.map((m) => [m.to, m]));
    const checkedKing = game.inCheck() ? game.turn() : null;

    for (const [name, button] of Object.entries(this.squares)) {
      const piece = game.get(name);
      button.replaceChildren(...this.coords[name], ...(piece ? [pieceElement(piece.color, piece.type)] : []));
      button.setAttribute('aria-label',
        piece ? `${name} ${piece.color === 'w' ? 'white' : 'black'} ${NAMES[piece.type]}` : name);

      const target = targetSquares.get(name);
      button.classList.toggle('selected', name === selected);
      button.classList.toggle('target', Boolean(target));
      button.classList.toggle('capture', Boolean(target && target.captured));
      button.classList.toggle('last-move', Boolean(lastMove && (name === lastMove.from || name === lastMove.to)));
      button.classList.toggle('check', Boolean(piece && piece.type === 'k' && piece.color === checkedKing));
      // Squares holding a piece you may drag also stop the page scrolling on touch (see CSS).
      button.classList.toggle('draggable',
        Boolean(interactive && piece && this.dragHandlers && this.dragHandlers.canDrag(name)));
    }
    this.boardEl.classList.toggle('locked', !interactive);
    if (!interactive) this.endDrag(); // e.g. the clock ran out mid-drag
  }

  // ---- Drag and drop (mouse, pen and touch, via Pointer Events) ----

  onPointerDown(event) {
    if (!event.isPrimary || event.button !== 0 || this.drag) return;
    const squareEl = event.target.closest('[data-square]');
    if (!squareEl || !this.dragHandlers.canDrag(squareEl.dataset.square)) return;
    // Keep receiving this pointer's events even after it leaves the square.
    squareEl.setPointerCapture(event.pointerId);
    this.drag = { from: squareEl.dataset.square, pointerId: event.pointerId,
      startX: event.clientX, startY: event.clientY, active: false, ghost: null, over: null };
  }

  onPointerMove(event) {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (!drag.active) {
      if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < DRAG_THRESHOLD_PX) return;
      drag.active = true;
      this.dragHandlers.onDragStart(drag.from); // main.js selects the piece and shows its moves
      const piece = this.squares[drag.from].querySelector('.piece');
      if (this.drag !== drag || !piece) { this.endDrag(); return; }
      // A copy of the piece follows the pointer; the original is faded out.
      drag.ghost = piece.cloneNode(true);
      drag.ghost.classList.add('drag-ghost');
      document.body.appendChild(drag.ghost);
      this.squares[drag.from].classList.add('drag-origin');
    }
    event.preventDefault();
    const size = this.squares[drag.from].getBoundingClientRect().width;
    drag.ghost.style.width = `${size}px`;
    drag.ghost.style.height = `${size}px`;
    drag.ghost.style.transform = `translate(${event.clientX - size / 2}px, ${event.clientY - size / 2}px)`;
    const over = this.squareAt(event.clientX, event.clientY);
    if (over !== drag.over) {
      if (drag.over) this.squares[drag.over].classList.remove('drag-over');
      if (over) this.squares[over].classList.add('drag-over');
      drag.over = over;
    }
  }

  onPointerUp(event, cancelled = false) {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    const to = cancelled ? null : this.squareAt(event.clientX, event.clientY);
    this.endDrag();
    if (drag.active) {
      this.ignoreClickUntil = performance.now() + 500;
      this.dragHandlers.onDrop(drag.from, to); // an illegal drop just redraws the piece where it was
    }
  }

  // The board square under a screen position, e.g. "e4", or null.
  squareAt(x, y) {
    const el = document.elementFromPoint(x, y);
    const squareEl = el && el.closest('[data-square]');
    return squareEl && this.boardEl.contains(squareEl) ? squareEl.dataset.square : null;
  }

  endDrag() {
    const drag = this.drag;
    if (!drag) return;
    this.drag = null;
    if (drag.ghost) drag.ghost.remove();
    for (const name of [drag.from, drag.over]) {
      if (name && this.squares[name]) this.squares[name].classList.remove('drag-origin', 'drag-over');
    }
  }

  // Show the promotion picker. Resolves with 'q', 'r', 'b', 'n', or null if cancelled.
  askPromotion(color) {
    this.closePromotion(null); // close any picker already open
    for (const button of this.promotionEl.querySelectorAll('[data-piece]')) {
      button.replaceChildren(pieceElement(color, button.dataset.piece));
    }
    this.promotionEl.hidden = false;
    this.promotionEl.querySelector('[data-piece]').focus();
    return new Promise((resolve) => { this.resolvePromotion = resolve; });
  }

  closePromotion(piece) {
    this.promotionEl.hidden = true;
    if (this.resolvePromotion) {
      const resolve = this.resolvePromotion;
      this.resolvePromotion = null;
      resolve(piece);
    }
  }
}
