# Third-Party Notices

This project bundles the following third-party software. Their licence files are
kept next to the files themselves and must not be removed.

## Stockfish.js 18 (engine) — GPL-3.0

| | |
|---|---|
| Files | `engine/stockfish-18-lite-single.js`, `engine/stockfish-18-lite-single.wasm` |
| Licence | GNU General Public License v3 — full text in `engine/Copying.txt` |
| Copyright | Stockfish.js 18 (c) 2026, Chess.com, LLC. Based on Stockfish (c) T. Romstad, M. Costalba, J. Kiiski, G. Linscott and other contributors. NNUE network by Linmiao Xu (linrock). |
| Package | npm `stockfish@18.0.8` — https://registry.npmjs.org/stockfish/-/stockfish-18.0.8.tgz |
| npm integrity | `sha512-z+f2UMPXLylDBGjv9e9zU8QulY7hUl8MYHesLRrdddewlOXjJrUSmtNmbtID1/F72EPhq0CCkCNxgWS5MQVWtQ==` |
| Source code | https://github.com/nmrugg/stockfish.js (git commit `93c994592dcf3b4b21052ab925e9b534df9c0918`) |
| Upstream engine | https://github.com/official-stockfish/Stockfish |
| SHA-256 (.js) | `5243fd9b276cab7dfe3ad1d43ab9ead73568fac76468c614242977a210c4a391` |
| SHA-256 (.wasm) | `a8fbc05ec6920b56d7485826dcb02c5ffd2826bcbf751cf973046f237a9096f1` |

The files are unmodified copies from the npm package's `bin/` folder.
**GPL obligation:** if you publish this website, you are distributing Stockfish. Keep
`engine/Copying.txt` with it and keep the source-code link above available to visitors
(the page footer links here and to the source).

## chess.js 1.4.0 (rules library) — BSD-2-Clause

| | |
|---|---|
| Files | `lib/chess.js/chess.js` (ESM build), `lib/chess.js/chess.js.map` |
| Licence | BSD 2-Clause — full text in `lib/chess.js/LICENSE` |
| Copyright | Copyright (c) 2025, Jeff Hlywa (jhlywa@gmail.com) |
| Package | npm `chess.js@1.4.0` — https://registry.npmjs.org/chess.js/-/chess.js-1.4.0.tgz |
| npm integrity | `sha512-BBJgrrtKQOzFLonR0l+k64A98NLemPwNsCskwb+29bRwobUa4iTm51E1kwGPbWXAcfdDa18nad6vpPPKPWarqw==` |
| Source code | https://github.com/jhlywa/chess.js (git commit `ce1ff9e9fc342984ff75ca475ab39f37888cb28a`) |
| SHA-256 | `76c7c34f0e2e9ab076521a5d6fe786a9cce537bb1b6f29d32a9c9970b5b232d2` |

Unmodified copy of `dist/esm/` from the npm package.

## Chess piece glyphs

The pieces are the standard Unicode chess symbols (U+2654–U+265F), drawn with the
visitor's own system fonts. No font or image files are bundled.

## Development-only tools (not part of the website)

- Playwright (`@playwright/test`, Apache-2.0) — used only by `tests/e2e.spec.mjs`.
