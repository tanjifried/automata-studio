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
- Interactive canvas: drag states, zoom with the scroll wheel, pan, circular auto-layout
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

**Files**
- Save and open `.afjson` projects
- Export the diagram to PNG
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
no bundler, no dependencies: the browser loads five plain scripts and runs
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
    │   ├── examples.js      # Preloaded example automata
    │   ├── graph.js         # SVG renderer: drag, zoom, pan, edge routing
    │   └── app.js           # UI wiring, history, file I/O, export
    └── tests/               # Node test suite for the algorithms
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
node web/tests/run-tests.js      # 45 checks
```

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
