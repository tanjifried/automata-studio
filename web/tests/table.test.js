/**
 * Tests for the transition table helpers (js/table.js) and the shared
 * name/symbol validation the table's "+ state" / "+ symbol" inputs use.
 *
 * Executed by run-tests.js in its own context.
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

  function same(actual, expected, message) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    assert(a === e, message + " (expected " + e + ", got " + a + ")");
  }

  function build(spec) {
    const a = new Automaton({ name: "t" });
    for (const s of spec.states) a.addState(s);
    a.alphabet = spec.alphabet || ["a", "b"];
    for (const [src, sym, dst] of spec.edges || []) a.addTransition(src, sym, dst);
    return a;
  }

  const STATES = ["q0", "q1", "q2"];

  function testParsing() {
    same(parseCell("q1, q2", STATES).targets, ["q1", "q2"], "comma + space");
    same(parseCell("q1,q2", STATES).targets, ["q1", "q2"], "comma only");
    same(parseCell("q1 q2", STATES).targets, ["q1", "q2"], "whitespace only");
    same(parseCell("  q2 ,\tq0  ,, q1 ", STATES).targets, ["q2", "q0", "q1"], "mixed separators keep typing order");
    same(parseCell("q1", STATES).targets, ["q1"], "single target");
    same(parseCell("q1, q1 q1", STATES).targets, ["q1"], "duplicates are dropped");
    same(parseCell("q1, q2, q1", STATES).errors, [], "duplicates are not errors");
    console.log("OK table: comma/whitespace parsing and dedupe");
  }

  function testUnknownNames() {
    const r = parseCell("q1, qx, q9", STATES);
    same(r.errors, ['Unknown state "qx".', 'Unknown state "q9".'], "one error per unknown name");
    same(r.targets, ["q1"], "known names still parsed");
    same(parseCell("Q1", STATES).errors, ['Unknown state "Q1".'], "names are case-sensitive");
    same(parseCell("qx qx", STATES).errors.length, 1, "unknown duplicates reported once");

    const a = build({ states: STATES, edges: [["q0", "a", "q1"]] });
    const before = JSON.stringify(a.toJSON());
    const p = previewCell(a, "q0", "a", "q2, nope");
    assert(!p.changed && p.errors.length === 1, "preview refuses unknown names");
    assert(JSON.stringify(a.toJSON()) === before, "nothing changes on error");
    assert(a.states.indexOf("nope") === -1, "unknown names never create states");
    console.log("OK table: unknown names");
  }

  function testEmptyClears() {
    same(parseCell("", STATES), { targets: [], errors: [] }, "empty text");
    same(parseCell("   , ", STATES), { targets: [], errors: [] }, "only separators");
    same(parseCell("∅", STATES), { targets: [], errors: [] }, "∅ means empty");
    same(parseCell("{}", STATES), { targets: [], errors: [] }, "{} means empty");

    const a = build({ states: STATES, edges: [["q0", "a", "q1"], ["q0", "a", "q2"]] });
    const p = previewCell(a, "q0", "a", "");
    assert(p.changed, "clearing a filled cell is a change");
    same(p.remove, ["q1", "q2"], "clearing removes every target");
    applyCellChange(a, "q0", "a", p);
    assert(a.targets("q0", "a").size === 0, "cell is empty after clearing");
    assert(!("a" in a.transitions.q0), "no empty target set left behind");
    console.log("OK table: empty cells clear");
  }

  function testSetNames() {
    // Conversions name states "{q0,q1}"; the braces keep them whole.
    const names = ["{q0}", "{q0,q1}", "∅", "q1", "q2"];
    same(parseCell("{q0,q1}, {q0}", names).targets, ["{q0,q1}", "{q0}"], "brace names kept whole");
    same(parseCell("{q0, q1}", names).targets, ["{q0,q1}"], "spaces inside braces ignored");
    same(parseCell("∅", names).targets, ["∅"], "a state literally called ∅ wins");
    same(parseCell("{q1, q2}", STATES).targets, ["q1", "q2"], "set notation lists targets");
    console.log("OK table: set-style names");
  }

  function testDiff() {
    same(diffCell(["q1"], ["q1"]), { add: [], remove: [] }, "unchanged = empty diff");
    same(diffCell(["q1"], ["q2"]), { add: ["q2"], remove: ["q1"] }, "replace");
    same(diffCell(["q1", "q2"], ["q2", "q0"]), { add: ["q0"], remove: ["q1"] }, "add missing, remove dropped");
    same(diffCell([], ["q0", "q1"]), { add: ["q0", "q1"], remove: [] }, "fill an empty cell");
    same(diffCell(new Set(["q0"]), []), { add: [], remove: ["q0"] }, "accepts Sets");
    same(diffCell(["q2", "q1"], ["q1", "q2"]), { add: [], remove: [] }, "order does not matter");

    const a = build({ states: STATES, edges: [["q0", "a", "q1"], ["q0", "a", "q2"]] });
    const noop = previewCell(a, "q0", "a", "q2 q1");
    assert(!noop.changed, "same set in another order is a no-op");
    const p = previewCell(a, "q0", "a", "q2, q0");
    applyCellChange(a, "q0", "a", p);
    same(cellTargets(a, "q0", "a"), ["q0", "q2"], "commit replaces the target set");
    same(formatCell(a, "q0", "a"), "q0, q2", "cell text in state order");
    same(formatCell(a, "q1", "b"), "", "empty cell text");
    const other = a.targets("q0", "b");
    assert(other.size === 0, "other cells untouched");
    console.log("OK table: diff and commit");
  }

  function testEpsilonColumn() {
    const plain = build({ states: STATES, edges: [["q0", "a", "q1"]] });
    same(tableColumns(plain, false), { symbols: ["a", "b"], epsilon: false, epsilonForced: false },
      "no ε column by default");
    same(tableColumns(plain, true), { symbols: ["a", "b", "ε"], epsilon: true, epsilonForced: false },
      "toggle shows the ε column");

    const eps = build({ states: STATES, edges: [["q0", EPSILON, "q1"]] });
    same(tableColumns(eps, false), { symbols: ["a", "b", "ε"], epsilon: true, epsilonForced: true },
      "ε-transitions force the column on");
    same(tableColumns(eps, true).epsilonForced, true, "still forced with the toggle on");

    const empty = new Automaton();
    same(tableColumns(empty, false).symbols, [], "no columns without an alphabet");
    console.log("OK table: ε column visibility");
  }

  function testMissingCells() {
    const dfa = build({ states: ["q0", "q1"], edges: [["q0", "a", "q1"], ["q1", "a", "q0"]] });
    assert(isMissingCell(dfa, "q0", "b"), "empty cell of a DFA is missing");
    assert(!isMissingCell(dfa, "q0", "a"), "filled cell is not missing");
    assert(!isMissingCell(dfa, "q0", EPSILON), "ε cells are never missing");

    const nfa = build({ states: ["q0", "q1"], edges: [["q0", "a", "q1"], ["q0", "a", "q0"]] });
    assert(!isMissingCell(nfa, "q1", "b"), "NFA empties are not flagged");

    const enfa = build({ states: ["q0", "q1"], edges: [["q0", EPSILON, "q1"]] });
    assert(!isMissingCell(enfa, "q1", "a"), "ε-NFA empties are not flagged");

    const bare = build({ states: ["q0", "q1"] });
    assert(isMissingCell(bare, "q0", "a"), "no transitions yet: still a DFA, flagged");

    // Agrees with the Properties panel's "Missing transitions" list.
    const report = analyzeProperties(dfa);
    const flagged = [];
    for (const s of dfa.states) for (const sym of dfa.alphabet) {
      if (isMissingCell(dfa, s, sym)) flagged.push(s + " --" + sym + "--> (undefined)");
    }
    same(flagged, report.missingTransitions, "matches Properties for a DFA");
    console.log("OK table: DFA missing-cell rule");
  }

  function testNameValidation() {
    same(stateNameProblem("", STATES), "The state name cannot be empty.", "empty state name");
    same(stateNameProblem("q 1", STATES), "Only letters, digits, '_' and '-' are allowed.", "bad characters");
    same(stateNameProblem("q1", STATES), 'State "q1" already exists.', "duplicate state");
    same(stateNameProblem("q1", STATES, "q1"), null, "renaming to itself is fine");
    same(stateNameProblem("q3", STATES), null, "valid new state");

    same(newSymbolProblem("", ["a"]), "The symbol cannot be empty.", "empty symbol");
    same(newSymbolProblem("ab", ["a"]), "Use single-character symbols.", "multi-char symbol");
    same(newSymbolProblem(EPSILON, ["a"]), "That symbol is reserved for epsilon transitions.", "ε reserved");
    same(newSymbolProblem("a", ["a"]), 'Symbol "a" is already in the alphabet.', "duplicate symbol");
    same(newSymbolProblem("c", ["a"]), null, "valid new symbol");
    console.log("OK table: + state / + symbol validation");
  }

  console.log("\nRunning transition table tests\n");
  testParsing();
  testUnknownNames();
  testEmptyClears();
  testSetNames();
  testDiff();
  testEpsilonColumn();
  testMissingCells();
  testNameValidation();

  console.log("\n" + checks + " checks, " + failures + " failures.");
  if (failures === 0) console.log("All transition table tests passed.");
  globalThis.__TEST_FAILURES__ = (globalThis.__TEST_FAILURES__ || 0) + failures;
})();
