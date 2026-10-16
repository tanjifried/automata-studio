# AutomataStudio

**Build, simulate and analyse finite automata in your browser.**

An educational tool for creating, editing, converting, simulating and analysing
Deterministic (DFA) and Non-deterministic (NFA) Finite Automata, including
ε-transitions. It runs entirely in the browser: no install, no account, no
server.

[![Live demo](https://img.shields.io/badge/live%20demo-open-2d6fd6)](https://tanjifried.github.io/automata-studio/)
[![Deploy](https://github.com/tanjifried/automata-studio/actions/workflows/deploy-pages.yml/badge.svg)](https://github.com/tanjifried/automata-studio/actions/workflows/deploy-pages.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

> **Try it now:** **[tanjifried.github.io/automata-studio](https://tanjifried.github.io/automata-studio/)**

Forked from [ReyEscarlata0/automata-studio](https://github.com/ReyEscarlata0/automata-studio).

---

## Features

**Editing**
- Visual editor for states, alphabet and transitions, with ε-transitions
- **Editable transition table**: one row per state, one column per symbol.
  Click a cell and type its targets (`q1, q2`); Enter saves, Esc cancels, an
  empty cell means no transition, and unknown state names are refused rather
  than created. Tab and the arrow keys move between cells like a spreadsheet.
  `→` and `*` on each row set the start state and toggle accepting; `+ state`
  and `+ symbol` add rows and columns. The ε column appears when there are
  ε-transitions (or on request). In a DFA, empty cells are tinted amber as
  missing transitions. Each saved cell is one undo step
- The table is linked to the diagram: hovering a cell highlights its arrows,
  clicking a state highlights its row, and a running simulation highlights the
  active rows and the column of the symbol being read. The editor panel widens
  while the table is open
- Interactive canvas: drag states, zoom with the scroll wheel, pan
- **Auto-sort**: a layered left-to-right layout by distance from the start
  state, with fewer edge crossings; unreachable and dead states go in the last
  column. Undoable with Ctrl+Z
- Accepting states, start state, renaming, undo/redo
- Live validation with clear error messages

**Simulation**
- Step-by-step simulation of any automaton, DFA or NFA alike, by tracking the
  set of active states
- Active states and the edges just taken are highlighted on the diagram
- Walk forward and backward through the run, or play it automatically
- Input tape showing exactly which symbol is being consumed

**Analysis and conversion**
- **NFA → DFA** by subset construction, with the full subset table
- **DFA minimization** by partition refinement (Moore), shown iteration by iteration
- **DFA → NFA** equivalent view
- Property report: deterministic, complete, connected, ε-transitions,
  unreachable states, dead states and missing transitions

**Documents**
- **Tabs**: open several automata side by side. Each tab keeps its own undo
  history, simulation, selection and zoom; the label follows the automaton's
  name. Open, Examples, a full Import and conversion results open in a new tab
  (or fill the current one if it is empty)
- **Autosave**: every open tab (with positions, the active tab and each tab's
  zoom) is saved in the browser's `localStorage` and restored on reload. Undo
  history is not saved

**Files**
- Save (active tab) and open `.afjson` projects
- **Import dialog** with a live preview: type or paste a quick text
  definition, paste `.afjson`, or drop a file. With a `start:` line it is a new
  automaton; without one the lines are merged into the current tab:

  ```
  states: q0 q1 q2
  alphabet: a b
  start: q0
  accept: q2
  q0 a q1
  q0 b q0
  q1 a,b q2      # comma = several symbols
  q1 eps q2      # eps or ε = epsilon
  ```
- Export the diagram to PNG
- **Copy image** copies the full active diagram to the clipboard at 2× resolution
  using the current theme. Simulation highlights and state diagnostics are kept;
  selection and hover outlines are omitted. Empty diagrams cannot be copied.
  Clipboard access needs a supported browser and a secure page (HTTPS or localhost).
  If copying is unavailable or denied, the message offers **Download PNG** for
  the same image
- Printable report (diagram, properties and transition table) that the browser
  can save as PDF

**Interface**
- Light and dark themes, following the system preference by default
- Responsive layout that works on tablets and phones
- Fully static: nothing leaves your machine

<img width="1917" height="907" alt="image" src="https://github.com/user-attachments/assets/64022852-3a07-4737-865f-ce5dac999c65" />

---

## Tech stack

Vanilla JavaScript (ES2020), inline SVG, CSS custom properties. No framework,
no bundler, no dependencies: the browser loads eight plain scripts and runs
them.

**CI/CD** — GitHub Actions runs the algorithm test suite on every push to
`main` and deploys `web/` to GitHub Pages only if the tests pass.

---

## Project structure

```
automata-studio/
├── examples/                # Sample .afjson automata
└── web/                     # The app (deployed as-is to GitHub Pages)
    ├── index.html
    ├── css/styles.css
    ├── js/
    │   ├── automaton.js     # Automaton data model (DFA and NFA in one class)
    │   ├── algorithms.js    # Simulation, subset construction, minimization, properties
    │   ├── layout.js        # Layered Auto-sort layout
    │   ├── examples.js      # Preloaded example automata
    │   ├── import.js        # Import dialog parser (text and .afjson) and merge
    │   ├── documents.js     # Open tabs: per-tab history, autosave (no DOM)
    │   ├── table.js         # Transition table: cell parsing, diffing, column rules (no DOM)
    │   ├── graph.js         # SVG renderer: drag, zoom, pan, edge routing
    │   └── app.js           # UI wiring, tabs, file I/O, export
    └── tests/               # Node test suite (algorithms, layout, import, tabs, table)
```

The algorithm layer is deliberately pure: it takes an automaton and returns a
result carrying the intermediate steps, with no dependency on the DOM. That is
what lets the UI show the process and not only the outcome, and what lets the
tests run under plain Node.

---

## Running locally

It is a static site, so any HTTP server works:

```bash
git clone https://github.com/tanjifried/automata-studio.git
cd automata-studio/web
python3 -m http.server 8000
# open http://localhost:8000
```

Opening `web/index.html` directly from the file system also works — there are
no modules or fetch calls that would trip over the `file://` origin.

---

## Tests

```bash
node web/tests/run-tests.js      # 308 checks in 5 suites
```

| Suite | Checks |
|---|---|
| `algorithms.test.js` | 45 |
| `layout.test.js` | 32 |
| `import.test.js` | 102 |
| `documents.test.js` | 70 |
| `table.test.js` | 59 |

### Optional clipboard browser checks

With Chrome and `playwright-core` available, start the web app locally and run:

```bash
python3 -m http.server 8767 --directory web
# In another terminal (NODE_PATH is only needed for an external install):
NODE_PATH=/path/to/node_modules node web/tests/clipboard.browser.test.js http://127.0.0.1:8767
```

Set `CHROME_BIN` if Chrome is not at `/usr/bin/google-chrome`. These checks
write a PNG to the browser test context's clipboard and read it back, then cover
clean highlights, themes, busy/empty states, failures, fallback downloads, and
narrow screens. Screenshots go to `/tmp/automata-copy-image-checks` by default;
pass a second argument to choose another output directory.


---

## The `.afjson` format

A plain JSON document. `transitions` maps a state and a symbol to a **list** of
targets — that single detail is what lets one structure represent both DFAs and
NFAs. `ε` is the reserved symbol for epsilon transitions, and `positions` holds
the canvas coordinates so a diagram reopens exactly as it was arranged.

```json
{
  "name": "DFA: binary strings ending in 1",
  "states": ["q0", "q1"],
  "alphabet": ["0", "1"],
  "start_state": "q0",
  "accept_states": ["q1"],
  "transitions": {
    "q0": { "0": ["q0"], "1": ["q1"] },
    "q1": { "0": ["q0"], "1": ["q1"] }
  },
  "positions": { "q0": [100, 150], "q1": [320, 150] }
}
```

Ready-made examples live in [`examples/`](examples/): a DFA for strings ending
in `1`, a DFA for binary numbers divisible by 3, an NFA that detects the
substring `ab`, an ε-NFA for `a*b* ∪ b*a*`, and a DFA that deliberately
contains dead and unreachable states.

---

## Algorithms

| Algorithm | Implementation | Notes |
|---|---|---|
| String simulation | Active-state set + ε-closure | One routine handles DFA and NFA |
| ε-closure | Depth-first search over ε-transitions | |
| NFA → DFA | Subset construction | Records every subset it discovers |
| DFA minimization | Moore partition refinement | Drops unreachable states first |
| Reachable states | Depth-first search from the start state | |
| Dead states | Backward search from the accepting states | States that can never accept |
---

## License

[MIT](LICENSE) — free to use, modify and share, including for teaching.

Built as an educational project for an Automata Theory and Formal Languages
course.
