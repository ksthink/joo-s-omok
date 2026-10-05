# Rapfi engine (WebAssembly build)

The files in this directory are the [Rapfi](https://github.com/dhbloo/rapfi)
Gomoku/Renju engine by dhbloo and contributors, compiled to WebAssembly. They are
**not** part of this project's own code and are distributed under the
**GNU General Public License version 3** (see `COPYING.txt`).

| File | What it is |
|---|---|
| `rapfi-single.js` / `.wasm` | single-threaded engine |
| `rapfi-single-simd128.js` / `.wasm` | single-threaded engine using WebAssembly SIMD |
| `rapfi.data` | engine config and NNUE network weights |

- Source code: https://github.com/dhbloo/rapfi (build instructions for
  WebAssembly are in its README, section "Build for WebAssembly").
- These binaries are the builds published with the Gomoku Calculator web app
  (https://github.com/dhbloo/gomoku-calculator), downloaded unmodified from
  https://www.gomocalc.com/build/ on 2026-10-05.

The game talks to the engine only through its text protocol (Gomocup / Yixin-Board
commands) from a Web Worker: see `rapfi-worker.js` and `rapfi.js` in the project root.
