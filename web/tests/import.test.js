/**
 * Tests for the text import parser (parseImport) and merge (applyImport).
 *
 * Run with:  node web/tests/run-tests.js
 *
 * Executed in a context where automaton.js, algorithms.js, examples.js and
 * import.js have already been evaluated.
 */

let failures = 0;
let checks = 0;

function assert(condition, message) {
  checks += 1;
  if (!condition) {
    failures += 1;
    console.error("  FAIL: " + message);
  }
}

function assertEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  assert(a === e, message + " (expected " + e + ", got " + a + ")");
}

/** Parse text that must produce exactly one error, and return it. */
function onlyError(text) {
  const parsed = parseImport(text);
  assertEqual(parsed.errors.length, 1, "one error for " + JSON.stringify(text));
  return parsed.errors[0] || "";
}

function lines() {
  return Array.from(arguments).join("\n");
}

/* ------------------------------------------------------------------ */

function testSections() {
  const parsed = parseImport(lines(
    "states: q0 q1 q2",
    "alphabet: a b",
    "start: q0",
    "accept: q2",
    "q0 a q1",
    "q1 b q2"
  ));
  assertEqual(parsed.errors, [], "no errors");
  assertEqual(parsed.empty, false, "not empty");
  assertEqual(parsed.format, "text", "text format");
  assertEqual(parsed.states, ["q0", "q1", "q2"], "states");
  assertEqual(parsed.alphabet, ["a", "b"], "alphabet");
  assertEqual(parsed.startState, "q0", "start");
  assertEqual(parsed.acceptStates, ["q2"], "accept");
  assertEqual(parsed.transitions, [["q0", "a", "q1"], ["q1", "b", "q2"]], "transitions");
  assertEqual(parsed.autoStates, [], "nothing auto-created");
  console.log("OK every section");
}

function testListsAndKeys() {
  const parsed = parseImport(lines(
    "STATES: q0, q1,q2",
    "Alphabet:a,b c",
    "accept: q1, q2",
    "states: q0 q3"
  ));
  assertEqual(parsed.errors, [], "no errors");
  assertEqual(parsed.states, ["q0", "q1", "q2", "q3"], "comma lists, repeated key, dedupe");
  assertEqual(parsed.alphabet, ["a", "b", "c"], "mixed separators");
  assertEqual(parsed.acceptStates, ["q1", "q2"], "accept list with commas");
  console.log("OK case-insensitive keys and list separators");
}

function testCommentsAndBlanks() {
  const parsed = parseImport(lines(
    "# a comment line",
    "",
    "   ",
    "states: q0 q1   # trailing comment",
    "q0 a q1 # another"
  ));
  assertEqual(parsed.errors, [], "no errors");
  assertEqual(parsed.states, ["q0", "q1"], "states");
  assertEqual(parsed.transitions, [["q0", "a", "q1"]], "transition");
  assertEqual(parseImport("# only\n\n# comments").empty, true, "comments only is empty");
  assertEqual(parseImport("").empty, true, "empty string is empty");
  console.log("OK comments and blank lines");
}

function testMultiSymbolAndEpsilon() {
  const parsed = parseImport(lines(
    "q1 a,b q2",
    "q1 a , c q3",
    "q1 ε q2",
    "q2 eps q3",
    "q3 EPS,a q0"
  ));
  assertEqual(parsed.errors, [], "no errors");
  assertEqual(parsed.transitions, [
    ["q1", "a", "q2"], ["q1", "b", "q2"],
    ["q1", "a", "q3"], ["q1", "c", "q3"],
    ["q1", EPSILON, "q2"],
    ["q2", EPSILON, "q3"],
    ["q3", EPSILON, "q0"], ["q3", "a", "q0"],
  ], "comma lists expand, eps/ε map to epsilon");
  assertEqual(parsed.alphabet, ["a", "b", "c"], "epsilon never joins the alphabet");
  console.log("OK multi-symbol and epsilon");
}

function testAutoCreate() {
  const parsed = parseImport(lines(
    "states: q0 q1",
    "alphabet: a",
    "start: q0",
    "accept: q9",
    "q0 a q1",
    "q1 c q3"
  ));
  assertEqual(parsed.errors, [], "no errors");
  assertEqual(parsed.autoStates, ["q9", "q3"], "undeclared states in reference order");
  assertEqual(parsed.autoSymbols, ["c"], "undeclared symbol");
  assertEqual(parsed.states, ["q0", "q1", "q9", "q3"], "auto states appended");
  assertEqual(parsed.alphabet, ["a", "c"], "auto symbols appended");
  console.log("OK auto-created states and symbols");
}

function testModeDetection() {
  assertEqual(parseImport("start: q0").mode, "full", "start: makes it full");
  assertEqual(parseImport("states: q0\naccept: q0\nq0 a q0").mode, "partial", "no start: is partial");
  assertEqual(parseImport('{"states": []}').mode, "full", "JSON is full");
  console.log("OK full vs partial detection");
}

function testJsonPassthrough() {
  const original = Automaton.fromJSON(EXAMPLES["DFA: divisible by 3"]);
  const text = "  " + JSON.stringify(original.toJSON(), null, 2);
  const parsed = parseImport(text);
  assertEqual(parsed.errors, [], "no errors");
  assertEqual(parsed.format, "json", "detected as JSON");
  assertEqual(parsed.states, original.states, "states read");

  const result = applyImport(new Automaton(), parsed);
  assertEqual(result.automaton.toJSON(), original.toJSON(), "round-trips through fromJSON");
  assertEqual(result.needsLayout, false, "all positions present: keep them");

  const noPositions = original.toJSON();
  delete noPositions.positions.r2;
  const partial = applyImport(new Automaton(), parseImport(JSON.stringify(noPositions)));
  assertEqual(partial.needsLayout, true, "missing a position: auto-layout");

  const err = onlyError('{\n  "states": [\n  oops\n}');
  assert(/^line \d+: invalid JSON/.test(err), "broken JSON reports a line: " + err);
  assert(/^line 1: JSON is not a \.afjson/.test(onlyError('{"name": "x"}')), "JSON without states");
  console.log("OK JSON passthrough");
}

function testErrors() {
  assertEqual(onlyError("states: q0\nq0 a"), "line 2: expected `source symbols target`", "too few tokens");
  assertEqual(onlyError("q0 a q1 q2"), "line 1: expected `source symbols target`", "too many tokens");
  assertEqual(onlyError("\n\nfoo: bar"),
    'line 3: unknown key "foo:" (expected states:, alphabet:, start: or accept:)', "unknown key");
  assertEqual(onlyError("start:"), "line 1: start: needs exactly one state", "start with no state");
  assertEqual(onlyError("start: q0 q1"), "line 1: start: needs exactly one state", "start with two");
  assertEqual(onlyError("start: q0\nstart: q1"), 'line 2: start state already set to "q0"', "two starts");
  assertEqual(parseImport("start: q0\nstart: q0").errors, [], "repeating the same start is fine");
  assertEqual(onlyError("q0 a,,b q1"), 'line 1: empty symbol in list "a,,b"', "empty symbol");
  assertEqual(onlyError("alphabet: eps"),
    "line 1: ε is reserved for epsilon transitions and cannot be in the alphabet", "eps in alphabet");
  assertEqual(onlyError("alphabet: ε"),
    "line 1: ε is reserved for epsilon transitions and cannot be in the alphabet", "ε in alphabet");

  const parsed = parseImport("states: q0\nq0 x\nbad: 1\nq0 a q0");
  assertEqual(parsed.errors.length, 2, "errors are collected per line, not just the first");
  console.log("OK error messages");
}

function testSymbolRule() {
  assertEqual(onlyError("alphabet: ab"),
    'line 1: invalid symbol "ab": use single-character symbols', "multi-char in alphabet");
  assertEqual(onlyError("q0 ab q1"),
    'line 1: invalid symbol "ab": use single-character symbols', "multi-char in transition");
  assertEqual(onlyError("q0 a,bc q1"),
    'line 1: invalid symbol "bc": use single-character symbols', "multi-char inside a list");
  assertEqual(parseImport("alphabet: é 0 _").errors, [], "any single character is fine");
  console.log("OK single-character symbols");
}

function testStateNames() {
  const message = (name) =>
    'invalid state name "' + name + "\" (letters, digits, '_' and '-' only)";
  assertEqual(onlyError("states: q0 q.1"), "line 1: " + message("q.1"), "states:");
  assertEqual(onlyError("start: {q0}"), "line 1: " + message("{q0}"), "start:");
  assertEqual(onlyError("accept: q$"), "line 1: " + message("q$"), "accept:");
  assertEqual(onlyError("q0 a q!"), "line 1: " + message("q!"), "transition target");
  assertEqual(onlyError("q@ a q1"), "line 1: " + message("q@"), "transition source");
  assertEqual(parseImport("states: Q_0 q-1 9").errors, [], "letters, digits, _ and - are fine");
  console.log("OK state name rule");
}

function testApplyFull() {
  const current = Automaton.fromJSON(EXAMPLES["DFA: ends with 1"]);
  const before = JSON.stringify(current.toJSON());
  const parsed = parseImport(lines(
    "states: a b",
    "start: b",
    "accept: c",
    "a 0,1 b",
    "b ε c"
  ));
  const result = applyImport(current, parsed);
  const out = result.automaton;
  assertEqual(JSON.stringify(current.toJSON()), before, "input automaton untouched");
  assertEqual(result.mode, "full", "full mode");
  assertEqual(out.states, ["a", "b", "c"], "replaces states");
  assertEqual(out.alphabet, ["0", "1"], "alphabet from transitions");
  assertEqual(out.startState, "b", "start");
  assertEqual(sortedArray(out.acceptStates), ["c"], "accept");
  assertEqual(out.allTransitionRows(), [["a", "0", "b"], ["a", "1", "b"], ["b", EPSILON, "c"]], "rows");
  assertEqual(result.created, { states: ["c"], symbols: ["0", "1"] }, "created");
  assertEqual(result.added, { states: 3, symbols: 2, transitions: 3 }, "added counts everything");
  assertEqual(result.needsLayout, true, "text import needs layout");
  assertEqual(out.validate(), [], "result is valid");
  console.log("OK full import replaces");
}

function testApplyMerge() {
  const current = Automaton.fromJSON(EXAMPLES["DFA: ends with 1"]); // q0, q1 over {0,1}
  const before = JSON.stringify(current.toJSON());
  const parsed = parseImport(lines(
    "states: q1 q2",
    "alphabet: 1 2",
    "accept: q2",
    "q0 1 q1",       // already there: no-op
    "q1 2 q2",
    "q2 0 q3"
  ));
  const result = applyImport(current, parsed);
  const out = result.automaton;
  assertEqual(JSON.stringify(current.toJSON()), before, "input automaton untouched");
  assertEqual(result.mode, "partial", "partial mode");
  assertEqual(out.states, ["q0", "q1", "q2", "q3"], "existing states kept, new appended");
  assertEqual(out.alphabet, ["0", "1", "2"], "new symbol appended once");
  assertEqual(out.startState, "q0", "start unchanged");
  assertEqual(sortedArray(out.acceptStates), ["q1", "q2"], "accept list applied on top");
  assert(out.targets("q1", "2").has("q2"), "new transition q1 2 q2");
  assert(out.targets("q2", "0").has("q3"), "new transition q2 0 q3");
  assertEqual(out.positions.q0, current.positions.q0, "existing positions copied");
  assertEqual(result.added, { states: 2, symbols: 1, transitions: 2 }, "only new items counted");
  assertEqual(result.created, { states: ["q3"], symbols: [] }, "created relative to current");

  const again = applyImport(out, parsed);
  assertEqual(again.added, { states: 0, symbols: 0, transitions: 0 }, "re-merging is a no-op");
  assertEqual(again.automaton.toJSON(), out.toJSON(), "same automaton after re-merge");

  let threw = false;
  try {
    applyImport(current, parseImport("q0 ab q1"));
  } catch (err) {
    threw = true;
  }
  assert(threw, "applyImport refuses a parse with errors");
  console.log("OK merge semantics");
}

/* ------------------------------------------------------------------ */

console.log("Running AutomataStudio import tests\n");

testSections();
testListsAndKeys();
testCommentsAndBlanks();
testMultiSymbolAndEpsilon();
testAutoCreate();
testModeDetection();
testJsonPassthrough();
testErrors();
testSymbolRule();
testStateNames();
testApplyFull();
testApplyMerge();

console.log("\n" + checks + " checks, " + failures + " failures.");
if (failures === 0) console.log("All import tests passed.");

globalThis.__TEST_FAILURES__ = failures;
