/**
 * Layered ("Auto-sort") layout for the automaton diagram.
 *
 * Pure function, no DOM: it only reads the automaton and returns a map
 * state -> [x, y], so it can be unit-tested in Node and reused by any view.
 *
 * Algorithm (a small Sugiyama-style layout):
 *   1. Columns. The start state is column 0; every other state goes in the
 *      column equal to its BFS depth from the start, following all
 *      transitions including ε.
 *   2. Set-aside column. Unreachable states and dead states (no accepting
 *      state can be reached from them) go in one extra column on the far
 *      right, so the useful part of the automaton reads left to right.
 *   3. Ordering. A few barycenter sweeps (down then up) reorder each column
 *      to reduce edge crossings; the ordering with the fewest crossings wins.
 *   4. Coordinates. Columns are evenly spaced and centred vertically.
 *
 * Deterministic: no randomness, and every tie is broken by the order of
 * automaton.states, so the same automaton always gets the same positions.
 *
 * Without a start state, nothing is "unreachable", so nothing is set aside:
 * the roots are the states with no incoming transitions (or the first
 * state if every state has one), and any state still unplaced after the BFS
 * seeds a new BFS from column 0, in state-list order.
 */

const LAYOUT_DEFAULTS = {
  columnGap: 190,
  rowGap: 130,
  originX: 100,
  originY: 100,
  sweeps: 8,
};

function computeLayeredLayout(automaton, opts) {
  const options = Object.assign({}, LAYOUT_DEFAULTS, opts || {});
  const states = automaton.states.slice();
  if (!states.length) return {};

  const order = new Map(states.map((s, i) => [s, i]));
  const { successors, neighbours } = layoutAdjacency(automaton, states);

  const asideSet = setAsideStates(automaton);
  const columns = assignColumns(automaton, states, successors, asideSet);

  // Build the layers; the set-aside states form one extra final column.
  const mainCount = columns.size ? Math.max.apply(null, Array.from(columns.values())) + 1 : 0;
  const layers = [];
  for (let i = 0; i < mainCount; i++) layers.push([]);
  const aside = [];
  for (const s of states) {
    if (columns.has(s)) layers[columns.get(s)].push(s);
    else aside.push(s);
  }
  if (aside.length) layers.push(aside);

  const ordered = reduceCrossings(layers, neighbours, order, options.sweeps);

  // Coordinates: evenly spaced columns, each centred on the tallest one.
  const tallest = Math.max.apply(null, ordered.map((l) => l.length));
  const centerY = options.originY + ((tallest - 1) * options.rowGap) / 2;
  const positions = {};
  ordered.forEach((layer, col) => {
    const x = options.originX + col * options.columnGap;
    layer.forEach((state, row) => {
      positions[state] = [x, centerY + (row - (layer.length - 1) / 2) * options.rowGap];
    });
  });
  return positions;
}

/** Deduplicated successor lists and undirected neighbour lists (no self-loops). */
function layoutAdjacency(automaton, states) {
  const successors = new Map(states.map((s) => [s, []]));
  const neighbours = new Map(states.map((s) => [s, []]));
  const seen = new Set();
  for (const [src, , dst] of automaton.allTransitionRows()) {
    if (src === dst || !successors.has(dst)) continue;
    const key = src + KEY_SEP + dst;
    if (seen.has(key)) continue;
    seen.add(key);
    successors.get(src).push(dst);
    if (!seen.has(dst + KEY_SEP + src)) {
      neighbours.get(src).push(dst);
      neighbours.get(dst).push(src);
    }
  }
  return { successors, neighbours };
}

/**
 * Unreachable and dead states. Dead states are only set aside while the
 * start state itself is live: otherwise every state would be dead and the
 * layout would collapse into the side column.
 */
function setAsideStates(automaton) {
  if (automaton.startState === null) return new Set();
  const aside = automaton.getUnreachableStates();
  const dead = automaton.getDeadStates();
  if (!dead.has(automaton.startState)) {
    for (const s of dead) aside.add(s);
  }
  return aside;
}

/** BFS depth of every state that is not set aside. */
function assignColumns(automaton, states, successors, asideSet) {
  const columns = new Map();
  const bfs = (roots) => {
    const queue = [];
    for (const r of roots) {
      if (!columns.has(r) && !asideSet.has(r)) {
        columns.set(r, 0);
        queue.push(r);
      }
    }
    for (let head = 0; head < queue.length; head++) {
      const state = queue[head];
      for (const next of successors.get(state)) {
        if (!columns.has(next) && !asideSet.has(next)) {
          columns.set(next, columns.get(state) + 1);
          queue.push(next);
        }
      }
    }
  };

  if (automaton.startState !== null && successors.has(automaton.startState)) {
    bfs([automaton.startState]);
  } else {
    const hasIncoming = new Set();
    for (const s of states) for (const t of successors.get(s)) hasIncoming.add(t);
    const roots = states.filter((s) => !hasIncoming.has(s));
    bfs(roots.length ? roots : [states[0]]);
    // States on cycles no root reaches: seed them one at a time.
    for (const s of states) {
      if (!columns.has(s) && !asideSet.has(s)) bfs([s]);
    }
  }
  return columns;
}

/**
 * Barycenter heuristic. Positions are centred (index minus half the column
 * height) because that is how columns are drawn, so neighbours in columns
 * of different heights compare correctly.
 */
function reduceCrossings(layers, neighbours, order, sweeps) {
  let current = layers.map((l) => l.slice());
  let best = current.map((l) => l.slice());
  let bestCrossings = countCrossings(best, neighbours);

  const layerOf = new Map();
  current.forEach((layer, i) => layer.forEach((s) => layerOf.set(s, i)));

  const centred = () => {
    const pos = new Map();
    for (const layer of current) {
      layer.forEach((s, i) => pos.set(s, i - (layer.length - 1) / 2));
    }
    return pos;
  };

  const reorder = (i, direction) => {
    const pos = centred();
    const layer = current[i];
    const key = new Map();
    for (const s of layer) {
      // Prefer neighbours in the adjacent column on the sweep side, then any
      // column on that side; a state with none keeps its current slot.
      const all = neighbours.get(s).filter((n) => layerOf.get(n) !== i);
      const adjacent = all.filter((n) => layerOf.get(n) === i - direction);
      const side = all.filter((n) => (layerOf.get(n) - i) * direction < 0);
      const pick = adjacent.length ? adjacent : side;
      key.set(
        s,
        pick.length ? pick.reduce((sum, n) => sum + pos.get(n), 0) / pick.length : pos.get(s)
      );
    }
    const index = new Map(layer.map((s, k) => [s, k]));
    layer.sort(
      (a, b) => key.get(a) - key.get(b) || index.get(a) - index.get(b) || order.get(a) - order.get(b)
    );
  };

  for (let sweep = 0; sweep < sweeps && bestCrossings > 0; sweep++) {
    if (sweep % 2 === 0) {
      for (let i = 1; i < current.length; i++) reorder(i, 1);
    } else {
      for (let i = current.length - 2; i >= 0; i--) reorder(i, -1);
    }
    const crossings = countCrossings(current, neighbours);
    if (crossings < bestCrossings) {
      bestCrossings = crossings;
      best = current.map((l) => l.slice());
    }
  }
  return best;
}

/** Crossings between edges joining adjacent columns (in either direction). */
function countCrossings(layers, neighbours) {
  let total = 0;
  for (let i = 0; i + 1 < layers.length; i++) {
    const right = new Map(layers[i + 1].map((s, k) => [s, k]));
    const edges = [];
    layers[i].forEach((s, k) => {
      for (const n of neighbours.get(s)) {
        if (right.has(n)) edges.push([k, right.get(n)]);
      }
    });
    for (let a = 0; a < edges.length; a++) {
      for (let b = a + 1; b < edges.length; b++) {
        const d1 = edges[a][0] - edges[b][0];
        const d2 = edges[a][1] - edges[b][1];
        if (d1 * d2 < 0) total += 1;
      }
    }
  }
  return total;
}
