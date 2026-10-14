// clock.js — a chess clock for two players ('w' and 'b').
//
// Time is never counted down tick by tick (timers drift, and browsers slow them
// down in background tabs). Instead we remember WHEN the running clock started
// and subtract the elapsed time whenever someone asks. The page only redraws the
// display on a timer; the numbers themselves are always exact.
//
// `now` is injectable so the maths can be tested in Node with a fake clock.

export class ChessClock {
  constructor(now = () => performance.now()) {
    this.now = now;
    this.reset(0);
  }

  // Both players get `ms` milliseconds; nothing runs until switchTo() is called.
  reset(ms) {
    this.remaining = { w: ms, b: ms };
    this.active = null;     // whose clock is (or was, while paused) running
    this.running = false;
    this.startedAt = 0;
  }

  // Move the time used so far from the running clock into `remaining`.
  commit() {
    if (!this.running) return;
    const t = this.now();
    this.remaining[this.active] -= t - this.startedAt;
    this.startedAt = t;
  }

  // Stop the current clock (if any) and start `color`'s clock.
  switchTo(color) {
    this.commit();
    this.active = color;
    this.running = true;
    this.startedAt = this.now();
  }

  pause() {
    this.commit();
    this.running = false;
  }

  // Continue the clock that was running before pause().
  resume() {
    if (this.active && !this.running) {
      this.running = true;
      this.startedAt = this.now();
    }
  }

  // Stop both clocks for good (game over).
  stop() {
    this.commit();
    this.running = false;
    this.active = null;
  }

  // Milliseconds left for `color` right now (can be negative once time is up).
  timeLeft(color) {
    const used = this.running && this.active === color ? this.now() - this.startedAt : 0;
    return this.remaining[color] - used;
  }

  // The colour whose time has run out, or null.
  flagged() {
    return this.running && this.timeLeft(this.active) <= 0 ? this.active : null;
  }
}
