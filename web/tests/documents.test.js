/**
 * Tests for the document list behind the tab strip (documents.js).
 *
 * Run with:  node web/tests/run-tests.js
 *
 * Executed in a context where automaton.js, examples.js and documents.js
 * have already been evaluated.
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

/** A minimal Storage stand-in: getItem / setItem over a plain object. */
function memoryStorage(initial) {
  const data = Object.assign({}, initial || {});
  return {
    data: data,
    getItem: (key) => (key in data ? data[key] : null),
    setItem: (key, value) => { data[key] = String(value); },
  };
}

function example(key) {
  return Automaton.fromJSON(EXAMPLES[key]);
}

const names = (list) => list.documents.map((d) => d.automaton.name);

/* ------------------------------------------------------------------ */

function testAddAndActivate() {
  const list = new DocumentList();
  assert(list.active === null, "an empty list has no active document");

  const a = list.add(example("DFA: ends with 1"));
  const b = list.add(null);
  assertEqual(list.documents.length, 2, "two documents after two adds");
  assert(list.active === b, "add() makes the new document active");
  assertEqual(b.automaton.name, DEFAULT_DOCUMENT_NAME, "add(null) creates a blank automaton");
  assert(a.id !== b.id, "documents get distinct ids");

  assert(list.activate(a.id) === a, "activate() returns the document");
  assert(list.active === a, "activate() switches the active document");
  assert(list.activate(9999) === null && list.active === a, "activating an unknown id changes nothing");
}

function testClose() {
  const list = new DocumentList();
  const a = list.add(example("DFA: ends with 1"));
  const b = list.add(example("DFA: divisible by 3"));
  const c = list.add(example("NFA: contains 'ab'"));

  list.activate(b.id);
  list.close(b.id);
  assert(list.active === c, "closing the active tab activates its right-hand neighbour");

  list.close(c.id);
  assert(list.active === a, "closing the last-positioned active tab falls back to the left");

  const d = list.add(null);
  list.activate(a.id);
  list.close(d.id);
  assert(list.active === a, "closing an inactive tab keeps the active one");
  assertEqual(list.documents.length, 1, "one tab left");

  const fresh = list.close(a.id);
  assertEqual(list.documents.length, 1, "closing the last tab leaves exactly one tab");
  assert(fresh === list.active && isBlankDocument(fresh), "...and it is a fresh blank tab");
  assert(fresh.id !== a.id, "...with a new id");

  assert(list.close(12345) === list.active, "closing an unknown id is a no-op");
}

function testBlankDetection() {
  const list = new DocumentList();
  const doc = list.add(null);
  assert(isBlankDocument(doc), "a new empty document is blank");

  pushDocumentHistory(doc);
  doc.automaton.addSymbol("a");
  assert(!isBlankDocument(doc), "a document with history is not blank, even without states");

  undoDocument(doc);
  assert(!isBlankDocument(doc), "an undone document still has redo history: not blank");

  const withStates = list.add(example("DFA: ends with 1"));
  assert(!isBlankDocument(withStates), "a document with states is not blank");
}

function testOpenReusesBlankTab() {
  const list = new DocumentList();
  const blank = list.add(null);

  const first = list.open(example("DFA: ends with 1"));
  assertEqual(list.documents.length, 1, "open() into a blank tab reuses it");
  assert(first.id === blank.id && list.active === first, "...keeping its id and position");
  assertEqual(first.automaton.name, EXAMPLES["DFA: ends with 1"].name, "...and showing the opened automaton");

  const second = list.open(example("DFA: divisible by 3"));
  assertEqual(list.documents.length, 2, "open() over a non-blank tab adds a new tab");
  assert(list.active === second && second.id !== first.id, "...and activates it");

  // A blank tab in the middle is reused only when it is the active one.
  const middle = list.add(null);
  list.add(example("NFA: contains 'ab'"));
  list.open(example("DFA: ends with 1"));
  assertEqual(list.documents.length, 5, "an inactive blank tab is not reused");
  list.activate(middle.id);
  list.open(example("DFA: ends with 1"));
  assertEqual(list.documents.length, 5, "the active blank tab is reused");
  assertEqual(list.documents.indexOf(list.active), 2, "...in place");

  // A blank tab whose history makes it non-blank is not overwritten.
  const touched = list.add(null);
  pushDocumentHistory(touched);
  list.open(example("DFA: ends with 1"));
  assert(list.find(touched.id) !== null && list.active.id !== touched.id,
    "a tab with history is kept and a new tab opened");
}

function testPerDocumentUndo() {
  const list = new DocumentList();
  const a = list.add(example("DFA: ends with 1"));
  const b = list.add(example("DFA: divisible by 3"));

  pushDocumentHistory(a);
  a.automaton.addState("extraA");
  pushDocumentHistory(b);
  b.automaton.addState("extraB1");
  pushDocumentHistory(b);
  b.automaton.addState("extraB2");

  assertEqual([a.undoStack.length, b.undoStack.length], [1, 2], "each document has its own undo stack");

  assert(undoDocument(a), "undo in A succeeds");
  assert(a.automaton.states.indexOf("extraA") === -1, "undo in A reverts A");
  assert(b.automaton.states.indexOf("extraB2") !== -1, "undo in A leaves B untouched");
  assertEqual(b.undoStack.length, 2, "undo in A leaves B's stack untouched");
  assert(!undoDocument(a), "A has nothing left to undo");

  assert(redoDocument(a), "redo in A succeeds");
  assert(a.automaton.states.indexOf("extraA") !== -1, "redo in A restores A");
  assert(!redoDocument(b), "B has nothing to redo");

  undoDocument(b);
  assert(b.automaton.states.indexOf("extraB2") === -1 && b.automaton.states.indexOf("extraB1") !== -1,
    "undo in B reverts only B's last change");
  pushDocumentHistory(b);
  assertEqual(b.redoStack.length, 0, "a new change clears that document's redo stack");

  for (let i = 0; i < DOCUMENT_HISTORY_LIMIT + 10; i++) pushDocumentHistory(a);
  assertEqual(a.undoStack.length, DOCUMENT_HISTORY_LIMIT, "history is capped per document");
}

function testSerializationRoundtrip() {
  const list = new DocumentList();
  const a = list.add(example("DFA: ends with 1"));
  a.view = { scale: 1.25, offsetX: 40, offsetY: -12 };
  a.automaton.name = "Renamed tab";
  pushDocumentHistory(a);
  list.add(example("NFA: contains 'ab'"));
  list.add(null);
  list.activate(list.documents[1].id);

  const storage = memoryStorage();
  assert(list.save(storage), "save() reports success");
  const raw = storage.getItem(DOCUMENTS_STORAGE_KEY);
  assert(typeof raw === "string", "save() writes under DOCUMENTS_STORAGE_KEY");

  const restored = DocumentList.load(storage);
  assert(restored !== null, "load() reads it back");
  assertEqual(names(restored), names(list), "tab order and names survive");
  assertEqual(restored.documents.indexOf(restored.active), 1, "the active tab survives");
  assertEqual(restored.documents.map((d) => d.automaton.toJSON()), list.documents.map((d) => d.automaton.toJSON()),
    "automata (including positions) survive");
  assertEqual(restored.documents[0].view, { scale: 1.25, offsetX: 40, offsetY: -12 }, "the view transform survives");
  assert(restored.documents[1].view === null, "a missing view stays null (fit on show)");
  assertEqual(restored.documents[0].undoStack.length, 0, "undo history is not persisted");
  assert(isBlankDocument(restored.documents[2]), "a blank tab comes back blank");

  const next = restored.add(null);
  assert(restored.documents.every((d) => d === next || d.id !== next.id), "new ids do not collide after load");
  assertEqual(JSON.parse(raw).version, DOCUMENTS_FORMAT_VERSION, "the stored data is versioned");
}

function testCorruptStorage() {
  const key = DOCUMENTS_STORAGE_KEY;
  assert(DocumentList.load(memoryStorage()) === null, "missing data loads as null");

  const bad = [
    "not json {",
    "null",
    "42",
    '"text"',
    "[]",
    "{}",
    '{"documents": "nope"}',
    '{"documents": []}',
    '{"documents": [null, 3, {"automaton": {"states": "q0"}}]}',
    '{"documents": [{"automaton": {"states": ["q0"], "transitions": {"q0": null}}}]}',
  ];
  for (const text of bad) {
    const storage = memoryStorage({ [key]: text });
    assert(DocumentList.load(storage) === null, "corrupt data loads as null: " + text);
  }

  const throwing = { getItem: () => { throw new Error("SecurityError"); }, setItem: () => { throw new Error("QuotaExceeded"); } };
  assert(DocumentList.load(throwing) === null, "a throwing storage loads as null");
  assert(new DocumentList().save(throwing) === false, "a throwing storage makes save() return false");

  // One bad entry does not cost the good ones; a bad view or index is ignored.
  const mixed = JSON.stringify({
    version: 1,
    active: 7,
    documents: [
      { automaton: { states: "broken" } },
      { automaton: EXAMPLES["DFA: ends with 1"], view: { scale: "big", offsetX: 0, offsetY: 0 } },
      { automaton: EXAMPLES["DFA: divisible by 3"], view: { scale: 0, offsetX: 1, offsetY: 1 } },
    ],
  });
  const partial = DocumentList.load(memoryStorage({ [key]: mixed }));
  assert(partial !== null, "partly corrupt data still loads");
  assertEqual(partial.documents.length, 2, "only the unreadable entry is dropped");
  assert(partial.active === partial.documents[0], "an out-of-range active index falls back to the first tab");
  assert(partial.documents.every((d) => d.view === null), "invalid views are discarded");
}

/* ------------------------------------------------------------------ */

console.log("Running AutomataStudio document tests\n");

testAddAndActivate();
testClose();
testBlankDetection();
testOpenReusesBlankTab();
testPerDocumentUndo();
testSerializationRoundtrip();
testCorruptStorage();

console.log("\n" + checks + " checks, " + failures + " failures.");
if (failures === 0) console.log("All document tests passed.");

globalThis.__TEST_FAILURES__ = failures;
