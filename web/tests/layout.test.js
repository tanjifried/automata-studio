/**
 * Tests for the layered Auto-sort layout (js/layout.js).
 *
 * Executed by run-tests.js in its own context; the wrapper function keeps
 * its helpers private all the same.
 */

(function () {
  let failures = 0;
  let checks = 0;

  function assert(condition, message) {
    checks += 1;
    if (!condition) {
      failures += 1;
      console.error("  FAIL: " + message);
    }
  }

  function build(spec) {
    const a = new Automaton({ name: "t" });
    for (const s of spec.states) a.addState(s);
    a.alphabet = spec.alphabet || ["a", "b"];
    // addState() makes the first state the start state; undo that unless asked.
    a.startState = spec.start === undefined ? null : spec.start;
    a.acceptStates = new Set(spec.accept || []);
    for (const [src, sym, dst] of spec.edges || []) a.addTransition(src, sym, dst);
    return a;
  }

  /** Map each state to its column index (columns ranked by x). */
  function columnsOf(positions) {
    const xs = Array.from(new Set(Object.values(positions).map((p) => p[0]))).sort((a, b) => a - b);
    const out = {};
    for (const s of Object.keys(positions)) out[s] = xs.indexOf(positions[s][0]);
    return out;
  }

  function columnOrder(positions, column) {
    const cols = columnsOf(positions);
    return Object.keys(positions)
      .filter((s) => cols[s] === column)
      .sort((a, b) => positions[a][1] - positions[b][1]);
  }

  function crossings(automaton, positions) {
    const cols = columnsOf(positions);
    const edges = automaton
      .allTransitionRows()
      .filter((r) => Math.abs(cols[r[0]] - cols[r[2]]) === 1)
      .map((r) => (cols[r[0]] < cols[r[2]] ? [r[0], r[2]] : [r[2], r[0]]));
    let count = 0;
    for (let i = 0; i < edges.length; i++) {
      for (let j = i + 1; j < edges.length; j++) {
        const [a1, b1] = edges[i];
        const [a2, b2] = edges[j];
        if (cols[a1] !== cols[a2]) continue;
        const d1 = positions[a1][1] - positions[a2][1];
        const d2 = positions[b1][1] - positions[b2][1];
        if (d1 * d2 < 0) count += 1;
      }
    }
    return count;
  }

  /* ---------------------------------------------------------------- */

  function testEmpty() {
    const positions = computeLayeredLayout(new Automaton({ name: "empty" }));
    assert(Object.keys(positions).length === 0, "empty automaton gives no positions");
    console.log("OK layout: empty automaton");
  }

  function testDeterminism() {
    for (const key of Object.keys(EXAMPLES)) {
      const a = Automaton.fromJSON(EXAMPLES[key]);
      const first = JSON.stringify(computeLayeredLayout(a));
      // Existing positions must not influence the result.
      a.positions = {};
      const second = JSON.stringify(computeLayeredLayout(a));
      const third = JSON.stringify(computeLayeredLayout(Automaton.fromJSON(EXAMPLES[key])));
      assert(first === second && second === third, "layout is deterministic for " + key);
    }
    console.log("OK layout: deterministic");
  }

  function testStartAndBfsColumns() {
    // a: q0 -> q1 -> q2 -> q3, with a shortcut q0 -> q2 and a back edge q3 -> q0.
    const a = build({
      states: ["q3", "q2", "q1", "q0"],
      start: "q0",
      accept: ["q3"],
      edges: [
        ["q0", "a", "q1"],
        ["q1", "a", "q2"],
        ["q0", "b", "q2"],
        ["q2", "a", "q3"],
        ["q3", "a", "q0"],
      ],
    });
    const cols = columnsOf(computeLayeredLayout(a));
    assert(cols.q0 === 0, "start state is in column 0");
    assert(cols.q1 === 1 && cols.q2 === 1, "q1 and q2 are at BFS depth 1");
    assert(cols.q3 === 2, "q3 is at BFS depth 2");

    // ε-transitions count as edges for the BFS.
    const eps = Automaton.fromJSON(EXAMPLES["ε-NFA: a*b* ∪ b*a*"]);
    const ec = columnsOf(computeLayeredLayout(eps));
    assert(ec.p0 === 0 && ec.p1 === 1 && ec.p3 === 1 && ec.p2 === 2 && ec.p4 === 2,
      "ε-NFA columns follow BFS depth through ε-transitions");
    console.log("OK layout: start in column 0, BFS columns");
  }

  function testUnreachableAndDeadGoLast() {
    const a = Automaton.fromJSON(EXAMPLES["DFA: with dead and unreachable states"]);
    const cols = columnsOf(computeLayeredLayout(a));
    const last = Math.max.apply(null, Object.values(cols));
    assert(cols.A === 0 && cols.B === 1, "live states keep their BFS columns");
    for (const s of ["C", "D", "E"]) {
      assert(cols[s] === last && last === 2, s + " (unreachable/dead) is in the final column");
    }

    // A reachable dead sink also goes to the side column.
    const sink = build({
      states: ["s", "ok", "trap"],
      start: "s",
      accept: ["ok"],
      edges: [["s", "a", "ok"], ["s", "b", "trap"], ["trap", "a", "trap"]],
    });
    const sc = columnsOf(computeLayeredLayout(sink));
    assert(sc.s === 0 && sc.ok === 1 && sc.trap === 2, "reachable dead sink is set aside");

    // No accepting states: everything is "dead", so nothing is set aside.
    const noAccept = build({
      states: ["x", "y"],
      start: "x",
      edges: [["x", "a", "y"]],
    });
    const nc = columnsOf(computeLayeredLayout(noAccept));
    assert(nc.x === 0 && nc.y === 1, "without accepting states the BFS layering is kept");
    console.log("OK layout: unreachable and dead states in the last column");
  }

  function testCrossingReduction() {
    // Listed in an order whose naive placement crosses: s -> {a, b}, a -> d, b -> c.
    const a = build({
      states: ["s", "a", "b", "c", "d", "f"],
      start: "s",
      accept: ["f"],
      edges: [
        ["s", "a", "a"],
        ["s", "b", "b"],
        ["a", "a", "d"],
        ["b", "a", "c"],
        ["c", "a", "f"],
        ["d", "a", "f"],
      ],
    });
    const positions = computeLayeredLayout(a);
    assert(crossings(a, positions) === 0, "crossings removed (got " + crossings(a, positions) + ")");
    const second = columnOrder(positions, 2);
    assert(second.join() === "d,c", "column 2 reordered to follow its parents (got " + second + ")");
    console.log("OK layout: crossing reduction");
  }

  function testNoOverlap() {
    const big = build({ states: [], start: undefined });
    for (let i = 0; i < 24; i++) big.addState("n" + i);
    big.setStartState("n0");
    big.acceptStates = new Set(["n23"]);
    for (let i = 0; i < 24; i++) {
      big.addTransition("n" + i, "a", "n" + ((i * 3 + 1) % 24));
      big.addTransition("n" + i, "b", "n" + ((i * 5 + 2) % 24));
    }
    const all = [big].concat(Object.keys(EXAMPLES).map((k) => Automaton.fromJSON(EXAMPLES[k])));
    for (const a of all) {
      const positions = computeLayeredLayout(a);
      assert(Object.keys(positions).length === a.states.length, "every state gets a position");
      const pts = Object.values(positions);
      let minDist = Infinity;
      for (let i = 0; i < pts.length; i++) {
        for (let j = i + 1; j < pts.length; j++) {
          minDist = Math.min(minDist, Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]));
        }
      }
      assert(minDist >= 100, a.name + ": states are well separated (min " + minDist + ")");
    }
    console.log("OK layout: no overlapping positions");
  }

  function testNoStartState() {
    // Roots are the states without incoming transitions.
    const a = build({
      states: ["b", "a", "c"],
      edges: [["a", "a", "b"], ["b", "a", "c"]],
    });
    const cols = columnsOf(computeLayeredLayout(a));
    assert(cols.a === 0 && cols.b === 1 && cols.c === 2, "without a start state, roots go first");

    // Pure cycle: the first listed state becomes the root.
    const cyc = build({
      states: ["p", "q", "r"],
      edges: [["p", "a", "q"], ["q", "a", "r"], ["r", "a", "p"]],
    });
    const cc = columnsOf(computeLayeredLayout(cyc));
    assert(cc.p === 0 && cc.q === 1 && cc.r === 2, "without roots, the first state is the root");
    console.log("OK layout: no start state fallback");
  }

  console.log("\nRunning Auto-sort layout tests\n");
  testEmpty();
  testDeterminism();
  testStartAndBfsColumns();
  testUnreachableAndDeadGoLast();
  testCrossingReduction();
  testNoOverlap();
  testNoStartState();

  console.log("\n" + checks + " checks, " + failures + " failures.");
  if (failures === 0) console.log("All layout tests passed.");
  globalThis.__TEST_FAILURES__ = (globalThis.__TEST_FAILURES__ || 0) + failures;
})();
