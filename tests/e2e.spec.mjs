// Browser tests: the real page, the real Stockfish worker, clicked like a user would.
import { test, expect } from '@playwright/test';

const sq = (page, name) => page.locator(`[data-square="${name}"]`);
const status = (page) => page.locator('#status');
const historyMoves = (page) => page.locator('#history span');

async function clickMove(page, from, to) {
  await sq(page, from).click();
  await sq(page, to).click();
}

// Open the page (optionally from a FEN position) and wait for the engine.
async function openGame(page, { fen, color = 'w', difficulty } = {}) {
  await page.goto(fen ? `/index.html?fen=${encodeURIComponent(fen)}` : '/index.html');
  await expect(status(page)).not.toHaveText(/Loading/, { timeout: 20000 });
  if (difficulty) await page.selectOption('#difficulty', difficulty);
  if (color !== 'w') {
    await page.selectOption('#color', color);
    await page.click('#new-game');
  }
}

// Record every network request so tests can prove nothing leaves the site.
function trackRequests(page) {
  const urls = [];
  page.on('request', (request) => urls.push(request.url()));
  return urls;
}

test('player moves, computer replies, using only local files', async ({ page, baseURL }) => {
  const urls = trackRequests(page);
  let wasmType = null;
  page.on('response', (r) => { if (r.url().endsWith('.wasm')) wasmType = r.headers()['content-type']; });

  await openGame(page);
  await expect(status(page)).toHaveText('Your move (White)');

  await clickMove(page, 'e2', 'e4');
  await expect(page.locator('#thinking')).toBeVisible();
  await expect(historyMoves(page).nth(1)).not.toHaveText('', { timeout: 15000 });
  await expect(page.locator('#thinking')).toBeHidden();
  await expect(status(page)).toHaveText(/Your move \(White\)/);
  await expect(historyMoves(page).nth(0)).toHaveText('e4');
  await expect(page.locator('.square.last-move')).toHaveCount(2);

  const external = urls.filter((u) => !u.startsWith(baseURL));
  expect(external, 'no requests outside the local site').toEqual([]);
  expect(urls.some((u) => u.endsWith('/engine/stockfish-18-lite-single.wasm'))).toBe(true);
  console.log(`  requests: ${urls.map((u) => u.replace(baseURL, '')).join(', ')}`);
  console.log(`  .wasm served as: ${wasmType}`);
});

test('security: Content-Security-Policy allows the game and logs no violations', async ({ page }) => {
  const problems = [];
  page.on('console', (msg) => { if (msg.type() === 'error') problems.push(msg.text()); });
  page.on('pageerror', (err) => problems.push(err.message));
  await openGame(page);
  await clickMove(page, 'e2', 'e4');
  await expect(historyMoves(page).nth(1)).not.toHaveText('', { timeout: 15000 });
  const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
  expect(csp).toContain("default-src 'self'");
  expect(problems).toEqual([]);
});

test('security: a malicious ?fen= link cannot inject HTML', async ({ page }) => {
  let dialogOpened = false;
  page.on('dialog', async (dialog) => { dialogOpened = true; await dialog.dismiss(); });
  const payloads = [
    '<img src=x onerror=alert(1)>/8/8/8/8/8/8/k6K w - - 0 1',
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"><img src=x onerror=alert(1)>',
  ];
  for (const fen of payloads) {
    await openGame(page, { fen });
    await expect(page.locator('#board img, #history img')).toHaveCount(0);
    await expect(sq(page, 'e1')).toHaveAttribute('aria-label', 'e1 white king'); // normal start position
  }
  expect(dialogOpened).toBe(false);
});

test('selecting a piece highlights its legal moves', async ({ page }) => {
  await openGame(page);
  await sq(page, 'g1').click();
  await expect(sq(page, 'g1')).toHaveClass(/selected/);
  await expect(page.locator('.square.target')).toHaveCount(2); // f3 and h3
  await expect(sq(page, 'f3')).toHaveClass(/target/);
  await sq(page, 'g1').click(); // clicking again deselects
  await expect(page.locator('.square.target')).toHaveCount(0);
});

test('illegal moves and opponent pieces are rejected', async ({ page }) => {
  await openGame(page);
  await clickMove(page, 'e2', 'e5');           // pawns can't move three squares
  await sq(page, 'e7').click();                // can't select the computer's pieces
  await expect(sq(page, 'e7')).not.toHaveClass(/selected/);
  await clickMove(page, 'f1', 'c4');           // bishop is blocked
  await expect(historyMoves(page)).toHaveCount(0);
  await expect(sq(page, 'e2')).toHaveAttribute('aria-label', 'e2 white pawn');
  await expect(sq(page, 'f1')).toHaveAttribute('aria-label', 'f1 white bishop');
});

test('playing as Black: board flips and the computer opens', async ({ page }) => {
  await openGame(page, { color: 'b' });
  await expect(page.locator('#board .square').first()).toHaveAttribute('data-square', 'h1');
  await expect(historyMoves(page).nth(0)).not.toHaveText('', { timeout: 15000 });
  await expect(status(page)).toHaveText('Your move (Black)');
  // Reply as Black with any legal pawn move, and check the computer answers again.
  await clickMove(page, 'a7', 'a6');
  await expect(historyMoves(page).nth(2)).not.toHaveText('', { timeout: 15000 });
});

for (const level of ['beginner', 'casual', 'intermediate', 'advanced', 'hard', 'master', 'full']) {
  test(`difficulty "${level}" plays legal replies`, async ({ page }) => {
    await openGame(page, { difficulty: level });
    const t0 = Date.now();
    await clickMove(page, 'e2', 'e4');
    await expect(historyMoves(page).nth(1)).not.toHaveText('', { timeout: 15000 });
    const ms = Date.now() - t0;
    await clickMove(page, 'd2', 'd4');
    await expect(historyMoves(page).nth(3)).not.toHaveText('', { timeout: 15000 });
    console.log(`  ${level}: first reply ${await historyMoves(page).nth(1).textContent()} after ${ms} ms`);
  });
}

test('settings are disabled while the computer thinks', async ({ page }) => {
  await openGame(page, { difficulty: 'full' });
  await clickMove(page, 'e2', 'e4');
  await expect(page.locator('#thinking')).toBeVisible();
  await expect(page.locator('#difficulty')).toBeDisabled();
  await expect(page.locator('#color')).toBeDisabled();
  await sq(page, 'd2').click(); // board is locked
  await expect(sq(page, 'd2')).not.toHaveClass(/selected/);
  await expect(page.locator('#thinking')).toBeHidden({ timeout: 15000 });
  await expect(page.locator('#difficulty')).toBeEnabled();
});

test('restart resets board, history and highlights', async ({ page }) => {
  await openGame(page);
  await clickMove(page, 'e2', 'e4');
  await expect(historyMoves(page).nth(1)).not.toHaveText('', { timeout: 15000 });
  await page.click('#restart');
  await expect(historyMoves(page)).toHaveCount(0);
  await expect(sq(page, 'e2')).toHaveAttribute('aria-label', 'e2 white pawn');
  await expect(sq(page, 'e4')).toHaveAttribute('aria-label', 'e4');
  await expect(page.locator('.square.last-move')).toHaveCount(0);
  await expect(status(page)).toHaveText('Your move (White)');
  // The engine still works after the restart.
  await clickMove(page, 'd2', 'd4');
  await expect(historyMoves(page).nth(1)).not.toHaveText('', { timeout: 15000 });
});

test('restart while the computer is thinking discards its stale move', async ({ page }) => {
  await openGame(page, { difficulty: 'full' });
  await clickMove(page, 'e2', 'e4');
  await expect(page.locator('#thinking')).toBeVisible();
  await page.click('#restart');
  await expect(page.locator('#thinking')).toBeHidden();
  await page.waitForTimeout(3500); // longer than GrandMaster's 3 s search
  await expect(historyMoves(page)).toHaveCount(0);
  await expect(status(page)).toHaveText('Your move (White)');
  await clickMove(page, 'e2', 'e4');
  await expect(historyMoves(page).nth(1)).not.toHaveText('', { timeout: 15000 });
  await expect(historyMoves(page).nth(0)).toHaveText('e4');
});

test('castling via the board', async ({ page }) => {
  await openGame(page, { fen: 'r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1' });
  await clickMove(page, 'e1', 'g1');
  await expect(historyMoves(page).nth(0)).toHaveText('O-O');
  await expect(sq(page, 'g1')).toHaveAttribute('aria-label', 'g1 white king');
  await expect(sq(page, 'f1')).toHaveAttribute('aria-label', 'f1 white rook');
});

test('en passant via the board', async ({ page }) => {
  await openGame(page, { fen: 'rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq f6 0 3' });
  await sq(page, 'e5').click();
  await expect(sq(page, 'f6')).toHaveClass(/target/);
  await sq(page, 'f6').click();
  await expect(historyMoves(page).nth(0)).toHaveText('exf6');
  await expect(sq(page, 'f5')).toHaveAttribute('aria-label', 'f5');
});

test('promotion: picker offers Q/R/B/N, cancel keeps the pawn', async ({ page }) => {
  await openGame(page, { fen: '4k3/P7/8/8/8/8/8/4K3 w - - 0 1' });
  await clickMove(page, 'a7', 'a8');
  await expect(page.locator('#promotion')).toBeVisible();
  await expect(page.locator('#promotion [data-piece]')).toHaveCount(4);
  await page.click('.promotion-cancel');
  await expect(page.locator('#promotion')).toBeHidden();
  await expect(sq(page, 'a7')).toHaveAttribute('aria-label', 'a7 white pawn');

  await clickMove(page, 'a7', 'a8');
  await page.click('#promotion [data-piece="n"]');
  await expect(sq(page, 'a8')).toHaveAttribute('aria-label', 'a8 white knight');
  await expect(historyMoves(page).nth(0)).toHaveText('a8=N');
});

test('player checkmate ends the game and locks the board', async ({ page }) => {
  await openGame(page, { fen: 'r1bqkbnr/pppp1ppp/2n5/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4' });
  await clickMove(page, 'h5', 'f7');
  await expect(status(page)).toHaveText('Checkmate — White wins. You win!');
  await expect(status(page)).toHaveClass(/game-over/);
  await expect(sq(page, 'e8')).toHaveClass(/check/);
  await page.waitForTimeout(500);
  await expect(page.locator('#thinking')).toBeHidden();
  await sq(page, 'd2').click();
  await expect(sq(page, 'd2')).not.toHaveClass(/selected/);
});

test('computer checkmate is announced', async ({ page }) => {
  await openGame(page, { fen: 'r1bqkbnr/pppp1ppp/2n5/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4', color: 'b', difficulty: 'full' });
  await expect(status(page)).toHaveText('Checkmate — White wins. The computer wins.', { timeout: 15000 });
});

test('stalemate is announced', async ({ page }) => {
  await openGame(page, { fen: '7k/8/5Q2/6K1/8/8/8/8 w - - 0 1' });
  await clickMove(page, 'f6', 'f7');
  await expect(status(page)).toHaveText('Draw by stalemate.');
});

test('check is shown', async ({ page }) => {
  // GrandMaster thinks for 3 s, so the check highlight stays visible long enough to assert.
  await openGame(page, { fen: '4k3/8/8/8/8/8/8/R3K3 w - - 0 1', difficulty: 'full' });
  await clickMove(page, 'a1', 'a8');
  await expect(sq(page, 'e8')).toHaveClass(/check/);
});

test('engine load failure shows an error, and Retry recovers', async ({ page }) => {
  await page.route('**/*.wasm', (route) => route.abort());
  await page.goto('/index.html');
  await expect(page.locator('#engine-error')).toBeVisible({ timeout: 25000 });
  await expect(status(page)).toHaveText(/Engine unavailable/);
  console.log(`  error shown: ${await page.locator('#engine-error-text').textContent()}`);

  await page.unroute('**/*.wasm');
  await page.click('#retry-engine');
  await expect(page.locator('#engine-error')).toBeHidden();
  await expect(status(page)).toHaveText('Your move (White)', { timeout: 20000 });
  await clickMove(page, 'e2', 'e4');
  await expect(historyMoves(page).nth(1)).not.toHaveText('', { timeout: 15000 });
});

test('missing engine script shows an error', async ({ page }) => {
  await page.route('**/stockfish-18-lite-single.js', (route) => route.fulfill({ status: 404, body: 'not found' }));
  await page.goto('/index.html');
  await expect(page.locator('#engine-error')).toBeVisible({ timeout: 25000 });
});

test('desktop screenshot', async ({ page }) => {
  await openGame(page);
  await clickMove(page, 'e2', 'e4');
  await expect(historyMoves(page).nth(1)).not.toHaveText('', { timeout: 15000 });
  await sq(page, 'g1').click();
  await page.screenshot({ path: 'screenshots/desktop.png', fullPage: true });
});

test('mobile: board fits the screen and tapping works @mobile', async ({ page }) => {
  await openGame(page);
  const noHorizontalScroll = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  expect(noHorizontalScroll).toBe(true);
  const box = await page.locator('#board').boundingBox();
  const width = page.viewportSize().width;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(width);

  // Move history starts collapsed on phones and can be opened.
  await expect(page.locator('#history-panel')).not.toHaveAttribute('open', '');
  await sq(page, 'e2').tap();
  await sq(page, 'e4').tap();
  await expect(historyMoves(page).nth(1)).not.toHaveText('', { timeout: 15000 });
  await page.locator('#history-panel summary').tap();
  await expect(page.locator('#history')).toBeVisible();
  await page.screenshot({ path: 'screenshots/mobile.png', fullPage: true });
});

// ---------------------------------------------------------------------------
// Board colours, drag-and-drop, chess clock, draw offers and resignation
// ---------------------------------------------------------------------------

const clockTime = (page, where) => page.locator(`#clock-${where} .clock-time`);
const clockBox = (page, where) => page.locator(`#clock-${where}`);

async function center(page, name) {
  const box = await sq(page, name).boundingBox();
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

// Drag with the mouse: press on `from`, move in small steps, release on `to`.
async function dragMove(page, from, to) {
  const a = await center(page, from);
  const b = await center(page, to);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 8 });
  await page.mouse.up();
}

// Drag with a finger: real touch events sent through Chrome DevTools.
async function touchDrag(page, from, to) {
  const a = await center(page, from);
  const b = await center(page, to);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [a] });
  for (let i = 1; i <= 8; i++) {
    const p = { x: a.x + ((b.x - a.x) * i) / 8, y: a.y + ((b.y - a.y) * i) / 8 };
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [p] });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

async function expectStandardColours(page) {
  for (const name of ['h1', 'a8', 'e8']) await expect(sq(page, name), name).toHaveClass(/\blight\b/);
  for (const name of ['a1', 'e1', 'h8']) await expect(sq(page, name), name).toHaveClass(/\bdark\b/);
  // Every square differs from its right-hand and upper neighbour.
  const wrong = await page.evaluate(() => {
    const isLight = (n) => document.querySelector(`[data-square="${n}"]`).classList.contains('light');
    const bad = [];
    for (const f of 'abcdefgh') for (let r = 1; r <= 8; r++) {
      if (r < 8 && isLight(f + r) === isLight(f + (r + 1))) bad.push(f + r);
      const right = String.fromCharCode(f.charCodeAt(0) + 1);
      if (f !== 'h' && isLight(f + r) === isLight(right + r)) bad.push(f + r);
    }
    return bad;
  });
  expect(wrong).toEqual([]);
}

test('board colours: h1/a8/e8 light, a1/e1 dark, after moves, restart and flipping', async ({ page }) => {
  await openGame(page);
  await expectStandardColours(page);
  // White's view: top-left is a8 (light), bottom-right is h1 (light).
  await expect(page.locator('#board .square').first()).toHaveAttribute('data-square', 'a8');
  await expect(page.locator('#board .square').last()).toHaveAttribute('data-square', 'h1');
  await clickMove(page, 'e2', 'e4');
  await expect(historyMoves(page).nth(1)).not.toHaveText('', { timeout: 15000 });
  await expectStandardColours(page);
  await page.click('#restart');
  await expectStandardColours(page);
  await page.selectOption('#color', 'b');
  await page.click('#new-game');
  await expect(page.locator('#board .square').first()).toHaveAttribute('data-square', 'h1');
  await expectStandardColours(page);
});

test('drag and drop: legal move plays, illegal drop and opponent pieces snap back', async ({ page }) => {
  const problems = [];
  page.on('pageerror', (err) => problems.push(err.message));
  page.on('console', (msg) => { if (msg.type() === 'error') problems.push(msg.text()); });
  await openGame(page);

  await dragMove(page, 'e2', 'e5');            // illegal: back to e2
  await expect(sq(page, 'e2')).toHaveAttribute('aria-label', 'e2 white pawn');
  await expect(sq(page, 'e5')).toHaveAttribute('aria-label', 'e5');
  await expect(page.locator('.drag-ghost')).toHaveCount(0);
  await dragMove(page, 'e7', 'e5');            // the computer's piece: nothing happens
  await expect(sq(page, 'e7')).toHaveAttribute('aria-label', 'e7 black pawn');
  await expect(historyMoves(page)).toHaveCount(0);

  await dragMove(page, 'g1', 'f3');            // legal
  await expect(historyMoves(page).nth(0)).toHaveText('Nf3');
  await expect(sq(page, 'f3')).toHaveClass(/last-move/);
  await expect(page.locator('#thinking')).toBeVisible();
  await dragMove(page, 'd2', 'd4');            // computer is thinking: ignored
  await expect(historyMoves(page).nth(1)).not.toHaveText('', { timeout: 15000 });
  await expect(sq(page, 'd2')).toHaveAttribute('aria-label', 'd2 white pawn');
  await expect(historyMoves(page)).toHaveCount(2);

  await dragMove(page, 'd2', 'd4');            // our turn again: plays
  await expect(historyMoves(page).nth(2)).toHaveText('d4');
  // A normal click still works after drags, and selection highlights still show.
  await expect(historyMoves(page).nth(3)).not.toHaveText('', { timeout: 15000 });
  await sq(page, 'b1').click();
  await expect(sq(page, 'b1')).toHaveClass(/selected/);
  await expect(page.locator('.square.target').first()).toBeVisible();
  expect(problems).toEqual([]);
});

test('drag and drop: castling, en passant and promotion with a choice of piece', async ({ page }) => {
  await openGame(page, { fen: 'r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1' });
  await dragMove(page, 'e1', 'c1');
  await expect(historyMoves(page).nth(0)).toHaveText('O-O-O');
  await expect(sq(page, 'd1')).toHaveAttribute('aria-label', 'd1 white rook');

  await openGame(page, { fen: 'rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq f6 0 3' });
  await dragMove(page, 'e5', 'f6');
  await expect(historyMoves(page).nth(0)).toHaveText('exf6');
  await expect(sq(page, 'f5')).toHaveAttribute('aria-label', 'f5');

  await openGame(page, { fen: '4k3/P7/8/8/8/8/8/4K3 w - - 0 1' });
  await dragMove(page, 'a7', 'a8');
  await expect(page.locator('#promotion')).toBeVisible();   // no silent queen
  await page.click('#promotion [data-piece="r"]');
  await expect(sq(page, 'a8')).toHaveAttribute('aria-label', 'a8 white rook');
  await expect(historyMoves(page).nth(0)).toHaveText('a8=R+');
});

test('chess clock: starts on the first move, switches each move, counts engine time', async ({ page }) => {
  await openGame(page, { difficulty: 'full' });             // Stockfish thinks ~3 s per move
  await expect(clockTime(page, 'top')).toHaveText('10:00');
  await expect(clockTime(page, 'bottom')).toHaveText('10:00');
  await expect(page.locator('.clock.active')).toHaveCount(0);
  await expect(clockBox(page, 'top')).toContainText('Black · Stockfish');
  await expect(clockBox(page, 'bottom')).toContainText('White · You');

  await clickMove(page, 'e2', 'e5');                         // illegal: no clock starts
  await page.waitForTimeout(1200);
  await expect(page.locator('.clock.active')).toHaveCount(0);
  await expect(clockTime(page, 'bottom')).toHaveText('10:00');

  await clickMove(page, 'e2', 'e4');
  await expect(clockBox(page, 'top')).toHaveClass(/active/);   // Stockfish's clock runs while it thinks
  await expect(clockBox(page, 'bottom')).not.toHaveClass(/active/);
  await expect(historyMoves(page).nth(1)).not.toHaveText('', { timeout: 15000 });
  await expect(clockBox(page, 'bottom')).toHaveClass(/active/);
  await expect(clockBox(page, 'top')).not.toHaveClass(/active/);
  const engineTime = await clockTime(page, 'top').textContent();
  expect(engineTime).toMatch(/^9:5[4-7]$/);                  // ~3 s were used by Stockfish
  console.log(`  Stockfish's clock after its first move: ${engineTime}`);
  await page.waitForTimeout(2100);
  await expect(clockTime(page, 'bottom')).not.toHaveText('10:00'); // now our time runs
  await expect(clockTime(page, 'top')).toHaveText(engineTime);     // and Stockfish's is stopped
});

test('chess clock: each time control resets both clocks', async ({ page }) => {
  await openGame(page);
  for (const [value, text] of [['3', '3:00'], ['5', '5:00'], ['10', '10:00'], ['15', '15:00']]) {
    await page.selectOption('#time-control', value);
    await page.click('#new-game');
    await expect(clockTime(page, 'top')).toHaveText(text);
    await expect(clockTime(page, 'bottom')).toHaveText(text);
  }
  // Restart keeps the game's time control even if the menu changed.
  await page.selectOption('#time-control', '5');
  await page.click('#restart');
  await expect(clockTime(page, 'bottom')).toHaveText('15:00');
});

test('chess clock: running out of time ends the game and New Game resets it', async ({ page }) => {
  await page.clock.install();                                // lets the test jump time forward
  await openGame(page);
  await page.selectOption('#time-control', '3');
  await page.click('#new-game');
  await clickMove(page, 'e2', 'e4');
  await expect(historyMoves(page).nth(1)).not.toHaveText('', { timeout: 15000 });
  await expect(clockBox(page, 'bottom')).toHaveClass(/active/);

  // Jump 3 minutes ahead, as if the tab had been in the background.
  await page.clock.fastForward('03:01');
  await expect(status(page)).toHaveText('Time out — Black wins. The computer wins.');
  await expect(status(page)).toHaveClass(/game-over/);
  await expect(clockTime(page, 'bottom')).toHaveText('0:00.0');
  await expect(page.locator('.clock.active')).toHaveCount(0);
  await expect(page.locator('#offer-draw')).toBeDisabled();
  await expect(page.locator('#resign')).toBeDisabled();
  await sq(page, 'd2').click();                              // no more moves
  await expect(sq(page, 'd2')).not.toHaveClass(/selected/);
  await dragMove(page, 'd2', 'd4');
  await expect(sq(page, 'd2')).toHaveAttribute('aria-label', 'd2 white pawn');

  await page.click('#new-game');
  await expect(status(page)).toHaveText('Your move (White)');
  await expect(clockTime(page, 'bottom')).toHaveText('3:00');
  await expect(clockTime(page, 'top')).toHaveText('3:00');
  await expect(page.locator('#resign')).toBeEnabled();
});

test('draw offer: declined too early, then play continues normally', async ({ page }) => {
  await openGame(page);
  await clickMove(page, 'e2', 'e4');
  await expect(historyMoves(page).nth(1)).not.toHaveText('', { timeout: 15000 });
  await page.click('#offer-draw');
  await expect(page.locator('#notice')).toHaveText(/Stockfish declined your draw offer: draw offers are only considered from move 20/);
  await expect(status(page)).toHaveText(/Your move \(White\)/);
  await expect(clockBox(page, 'bottom')).toHaveClass(/active/);
  await clickMove(page, 'd2', 'd4');
  await expect(historyMoves(page).nth(2)).toHaveText('d4');
  await expect(page.locator('#notice')).toBeHidden();         // message clears after the next move
});

test('draw offer: declined when Stockfish is better, clock paused while it thinks', async ({ page }) => {
  await openGame(page, { fen: 'r5k1/5ppp/8/8/8/8/5PPP/4K3 w - - 0 30' }); // Stockfish (Black) is a rook up
  await clickMove(page, 'e1', 'e2');
  await expect(historyMoves(page).nth(1)).not.toHaveText('', { timeout: 15000 });
  await page.click('#offer-draw');
  await expect(page.locator('#notice')).toHaveText(/considering/);
  await expect(page.locator('.clock.active')).toHaveCount(0);  // nobody's time runs meanwhile
  await expect(sq(page, 'e2')).toHaveAttribute('aria-label', /white king/);
  await expect(page.locator('#notice')).toHaveText(/declined your draw offer: it (thinks it is better|sees a forced checkmate for itself)/, { timeout: 10000 });
  await expect(clockBox(page, 'bottom')).toHaveClass(/active/);
  await expect(status(page)).not.toHaveClass(/game-over/);
});

test('draw offer: accepted when Stockfish is losing; the game ends as a draw', async ({ page }) => {
  // Move 30, White (you) is a queen up.
  await openGame(page, { fen: '6k1/5ppp/8/8/8/8/5PPP/3Q2K1 w - - 0 30' });
  await page.click('#offer-draw');
  await expect(status(page)).toHaveText(/^Draw agreed — Stockfish accepted your draw offer/, { timeout: 10000 });
  await expect(status(page)).toHaveClass(/game-over/);
  await expect(page.locator('#offer-draw')).toBeDisabled();
  await expect(page.locator('#resign')).toBeDisabled();
  await sq(page, 'd1').click();
  await expect(sq(page, 'd1')).not.toHaveClass(/selected/);
});

test('resign: cancel keeps playing, confirm ends the game, New Game resets', async ({ page }) => {
  let dialogOpened = false;
  page.on('dialog', async (d) => { dialogOpened = true; await d.dismiss(); });
  await openGame(page);
  await clickMove(page, 'e2', 'e4');
  await expect(historyMoves(page).nth(1)).not.toHaveText('', { timeout: 15000 });

  await page.click('#resign');
  await expect(page.locator('#resign-confirm')).toBeVisible();
  await page.click('#resign-cancel');
  await expect(page.locator('#resign-confirm')).toBeHidden();
  await clickMove(page, 'd2', 'd4');                         // game goes on
  await expect(historyMoves(page).nth(2)).toHaveText('d4');
  await expect(historyMoves(page).nth(3)).not.toHaveText('', { timeout: 15000 });

  await page.click('#resign');
  await page.click('#resign-yes');
  await expect(status(page)).toHaveText('You resigned — Black wins.');
  await expect(status(page)).toHaveClass(/game-over/);
  await expect(page.locator('.clock.active')).toHaveCount(0);
  const frozen = await clockTime(page, 'bottom').textContent();
  await page.waitForTimeout(1100);
  await expect(clockTime(page, 'bottom')).toHaveText(frozen);
  await expect(page.locator('#offer-draw')).toBeDisabled();
  await expect(page.locator('#resign')).toBeDisabled();
  await sq(page, 'g1').click();
  await expect(sq(page, 'g1')).not.toHaveClass(/selected/);
  expect(dialogOpened).toBe(false);                          // no browser pop-ups

  await page.click('#new-game');
  await expect(status(page)).toHaveText('Your move (White)');
  await expect(historyMoves(page)).toHaveCount(0);
  await expect(clockTime(page, 'bottom')).toHaveText('10:00');
  await expect(page.locator('#resign')).toBeEnabled();
  await clickMove(page, 'e2', 'e4');
  await expect(historyMoves(page).nth(1)).not.toHaveText('', { timeout: 15000 });
});

test('mobile: touch drag moves a piece without scrolling the page @mobile', async ({ page }) => {
  await openGame(page);
  await expect(clockBox(page, 'top')).toBeVisible();
  await expect(clockBox(page, 'bottom')).toBeVisible();
  const scrollBefore = await page.evaluate(() => window.scrollY);
  await touchDrag(page, 'e2', 'e5');                         // illegal: snaps back
  await expect(sq(page, 'e2')).toHaveAttribute('aria-label', 'e2 white pawn');
  await touchDrag(page, 'e2', 'e4');
  await expect(historyMoves(page).nth(0)).toHaveText('e4');
  expect(await page.evaluate(() => window.scrollY)).toBe(scrollBefore);
  await expect(historyMoves(page).nth(1)).not.toHaveText('', { timeout: 15000 });
  await touchDrag(page, 'g1', 'f3');
  await expect(historyMoves(page).nth(2)).toHaveText('Nf3');
});
