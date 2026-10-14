// engine.js — a small wrapper around the Stockfish Web Worker.
//
// Stockfish runs in a separate thread (a Web Worker) so its thinking never
// freezes the page. We talk to it with plain text commands in the "UCI"
// (Universal Chess Interface) format:
//
//   we send            engine replies
//   ---------------    ------------------------------
//   uci                option lines ..., then "uciok"
//   isready            "readyok" (once it has finished any pending work)
//   position fen ...   (nothing — just sets up the board)
//   go movetime 500    "info ..." lines, then "bestmove e2e4"
//
// Everything happens inside the visitor's browser; no network calls are made.

import { ENGINE_PATH, ENGINE_START_TIMEOUT_MS, ENGINE_HASH_MB, buildStrengthCommands, buildGoCommand, parseBestMove, parseScore } from './config.js';

export class Engine {
  constructor() {
    this.worker = null;
    this.options = new Set();   // option names the engine reported, e.g. "Skill Level"
    this.waiters = [];          // functions waiting for a specific reply line
    this.searching = false;     // true while a "go" search is running
    this.onCrash = null;        // set by main.js; called if the engine dies after starting
  }

  // Start the worker and complete the UCI handshake.
  // Resolves when the engine is ready; rejects with a helpful Error otherwise.
  start() {
    if (typeof WebAssembly !== 'object' || typeof Worker !== 'function') {
      return Promise.reject(new Error('This browser does not support WebAssembly or Web Workers.'));
    }
    this.terminate();

    return new Promise((resolve, reject) => {
      let started = false;
      const timer = setTimeout(() => fail(new Error('The engine took too long to start.')), ENGINE_START_TIMEOUT_MS);

      const fail = (error) => {
        clearTimeout(timer);
        this.terminate();
        if (started) {
          if (this.onCrash) this.onCrash(error);
        } else {
          reject(error);
        }
      };

      try {
        this.worker = new Worker(ENGINE_PATH);
      } catch (error) {
        fail(error);
        return;
      }

      // A failed script/wasm download or a crash inside the engine lands here.
      this.worker.onerror = (event) => {
        event.preventDefault();
        fail(new Error(event.message || 'The engine failed to load or crashed.'));
      };
      this.worker.onmessage = (event) => this.handleLine(String(event.data));

      this.send('uci');
      this.waitFor((line) => {
        const option = /^option name (.+?) type /.exec(line);
        if (option) this.options.add(option[1]);
        return line === 'uciok';
      })
        .then(() => {
          if (this.options.has('Hash')) this.send(`setoption name Hash value ${ENGINE_HASH_MB}`);
          return this.ready();
        })
        .then(() => {
          clearTimeout(timer);
          started = true;
          resolve();
        });
    });
  }

  send(command) {
    if (this.worker) this.worker.postMessage(command);
  }

  // Every line from the engine is offered to the waiting callbacks in order.
  handleLine(line) {
    for (const waiter of [...this.waiters]) {
      if (waiter.test(line)) {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        waiter.resolve(line);
      }
    }
  }

  // Returns a Promise that resolves with the first line for which test(line) is true.
  waitFor(test) {
    return new Promise((resolve) => this.waiters.push({ test, resolve }));
  }

  // "isready" → "readyok": the engine replies only after finishing earlier commands.
  ready() {
    this.send('isready');
    return this.waitFor((line) => line === 'readyok');
  }

  // Reset the engine for a new game. If a search is still running we stop it and
  // wait for its leftover "bestmove" first (main.js ignores that stale move), so
  // it can never be mistaken for the answer to the next search.
  async newGame() {
    if (this.searching) {
      const stale = this.waitFor((line) => line.startsWith('bestmove'));
      this.send('stop');
      await stale;
    }
    this.send('ucinewgame');
    return this.ready();
  }

  // Only send options this engine build reports (e.g. "UCI_Elo", "Skill Level").
  setStrength(levelName) {
    for (const cmd of buildStrengthCommands(levelName)) {
      const name = /^setoption name (.+) value /.exec(cmd)[1];
      if (this.options.has(name)) this.send(cmd);
    }
  }

  // Ask for the best move in a position. Resolves with { from, to, promotion? },
  // or null if the engine has no move (game over).
  // timeLeftMs (optional): the engine's clock time, used to cap its thinking time.
  async getBestMove(fen, levelName, timeLeftMs) {
    this.setStrength(levelName);
    this.send(`position fen ${fen}`);
    const reply = this.waitFor((line) => line.startsWith('bestmove'));
    this.send(buildGoCommand(levelName, timeLeftMs));
    this.searching = true;
    try {
      return parseBestMove(await reply);
    } finally {
      this.searching = false;
    }
  }

  // Evaluate a position at full strength for `movetime` ms (used for draw offers).
  // Resolves with the last exact score Stockfish reported, { type: 'cp' | 'mate', value },
  // from the point of view of the side to move — or null if none was reported.
  async evaluate(fen, movetime) {
    this.setStrength('full');
    this.send(`position fen ${fen}`);
    let score = null;
    const reply = this.waitFor((line) => {
      score = parseScore(line) || score;
      return line.startsWith('bestmove');
    });
    this.send(`go movetime ${movetime}`);
    this.searching = true;
    try {
      await reply;
      return score;
    } finally {
      this.searching = false;
    }
  }

  terminate() {
    if (this.worker) this.worker.terminate();
    this.worker = null;
    this.waiters = [];
    this.searching = false;
    this.options.clear();
  }
}
