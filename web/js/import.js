/**
 * Text import: a small line-based syntax for typing or pasting automata.
 *
 *   states: q0 q1 q2
 *   alphabet: a b
 *   start: q0
 *   accept: q2
 *   q0 a q1
 *   q1 a,b q2      # comma = several symbols on one arrow
 *   q1 eps q2      # "eps" or "ε" is an epsilon move
 *
 * Every section is optional. A `start:` line makes it a full import that
 * replaces the current automaton; without one the text is merged into it.
 * Raw .afjson (text starting with "{") is accepted as a full import too.
 *
 * Both functions here are pure: parseImport() reads text, applyImport()
 * returns a new Automaton and never touches the one it is given.
 */

const IMPORT_KEYS = ["states", "alphabet", "start", "accept"];

function importLineError(line, message) {
  return "line " + line + ": " + message;
}

/** Map a written symbol to the model's symbol ("eps" and "ε" mean epsilon). */
function readImportSymbol(token) {
  if (token === EPSILON || token.toLowerCase() === "eps") return EPSILON;
  return token;
}

/** Best-effort line number for a JSON.parse error message. */
function jsonErrorLine(text, message) {
  const lineMatch = /line (\d+)/.exec(message);
  if (lineMatch) return Number(lineMatch[1]);
  const posMatch = /position (\d+)/.exec(message);
  if (posMatch) return text.slice(0, Number(posMatch[1])).split("\n").length;
  return 1;
}

function emptyImport() {
  return {
    empty: true,
    format: "text",
    mode: "partial",
    states: [],
    alphabet: [],
    startState: null,
    acceptStates: [],
    transitions: [],
    autoStates: [],
    autoSymbols: [],
    automaton: null,
    errors: [],
  };
}

function parseJsonImport(text) {
  const result = emptyImport();
  result.empty = false;
  result.format = "json";
  result.mode = "full";
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    result.errors.push(importLineError(jsonErrorLine(text, err.message), "invalid JSON: " + err.message));
    return result;
  }
  if (!data || typeof data !== "object" || !Array.isArray(data.states)) {
    result.errors.push(importLineError(1, "JSON is not a .afjson automaton (no \"states\" list)"));
    return result;
  }
  const automaton = Automaton.fromJSON(data);
  result.automaton = automaton;
  result.states = automaton.states.slice();
  result.alphabet = automaton.alphabet.slice();
  result.startState = automaton.startState;
  result.acceptStates = sortedArray(automaton.acceptStates);
  result.transitions = automaton.allTransitionRows();
  return result;
}

/**
 * Parse import text. Returns a plain description of what it declares:
 * { empty, format: "text"|"json", mode: "full"|"partial", states, alphabet,
 *   startState, acceptStates, transitions: [[src, sym, dst]], autoStates,
 *   autoSymbols, automaton (JSON only), errors: ["line N: ..."] }.
 * `states`/`alphabet` include the auto-created entries, which are also
 * listed separately in `autoStates`/`autoSymbols`.
 */
function parseImport(text) {
  const source = String(text || "");
  if (source.trim().startsWith("{")) return parseJsonImport(source);

  const result = emptyImport();
  const declaredStates = [];
  const declaredSymbols = [];
  const referencedStates = [];
  const referencedSymbols = [];
  const accept = [];
  const transitions = [];
  const seenTransitions = new Set();
  let hasContent = false;
  let start = null;

  const checkState = (name, lineNo) => {
    if (STATE_NAME_RE.test(name)) return true;
    result.errors.push(importLineError(lineNo,
      'invalid state name "' + name + "\" (letters, digits, '_' and '-' only)"));
    return false;
  };

  const checkSymbol = (symbol, lineNo) => {
    const problem = symbolProblem(symbol);
    if (!problem) return true;
    result.errors.push(importLineError(lineNo, 'invalid symbol "' + symbol + '": ' +
      problem.charAt(0).toLowerCase() + problem.slice(1).replace(/\.$/, "")));
    return false;
  };

  const lines = source.split(/\r?\n/);
  lines.forEach((raw, index) => {
    const lineNo = index + 1;
    const hash = raw.indexOf("#");
    const line = (hash === -1 ? raw : raw.slice(0, hash)).trim();
    if (!line) return;
    hasContent = true;

    const keyMatch = /^([A-Za-z_]+)\s*:(.*)$/.exec(line);
    if (keyMatch) {
      const key = keyMatch[1].toLowerCase();
      const items = keyMatch[2].split(/[\s,]+/).filter(Boolean);
      if (IMPORT_KEYS.indexOf(key) === -1) {
        result.errors.push(importLineError(lineNo, 'unknown key "' + keyMatch[1] +
          ':" (expected states:, alphabet:, start: or accept:)'));
        return;
      }
      if (key === "states") {
        for (const name of items) if (checkState(name, lineNo)) declaredStates.push(name);
      } else if (key === "alphabet") {
        for (const symbol of items) {
          if (readImportSymbol(symbol) === EPSILON) {
            result.errors.push(importLineError(lineNo,
              "ε is reserved for epsilon transitions and cannot be in the alphabet"));
          } else if (checkSymbol(symbol, lineNo)) {
            declaredSymbols.push(symbol);
          }
        }
      } else if (key === "start") {
        if (items.length !== 1) {
          result.errors.push(importLineError(lineNo, "start: needs exactly one state"));
        } else if (start !== null && start !== items[0]) {
          result.errors.push(importLineError(lineNo,
            'start state already set to "' + start + '"'));
        } else if (checkState(items[0], lineNo)) {
          start = items[0];
          referencedStates.push(start);
        }
        result.mode = "full";
      } else {
        for (const name of items) {
          if (checkState(name, lineNo)) {
            accept.push(name);
            referencedStates.push(name);
          }
        }
      }
      return;
    }

    // Transition: "source symbols target"; tolerate spaces around commas.
    const tokens = line.replace(/\s*,\s*/g, ",").split(/\s+/);
    if (tokens.length !== 3) {
      result.errors.push(importLineError(lineNo, "expected `source symbols target`"));
      return;
    }
    const src = tokens[0];
    const dst = tokens[2];
    const symbols = tokens[1].split(",");
    let ok = checkState(src, lineNo);
    ok = checkState(dst, lineNo) && ok;
    if (symbols.some((s) => !s)) {
      result.errors.push(importLineError(lineNo, "empty symbol in list \"" + tokens[1] + "\""));
      return;
    }
    const read = [];
    for (const written of symbols) {
      const symbol = readImportSymbol(written);
      if (symbol === EPSILON || checkSymbol(symbol, lineNo)) read.push(symbol);
      else ok = false;
    }
    if (!ok) return;
    referencedStates.push(src, dst);
    for (const symbol of read) {
      if (symbol !== EPSILON) referencedSymbols.push(symbol);
      const key = [src, symbol, dst].join(KEY_SEP);
      if (!seenTransitions.has(key)) {
        seenTransitions.add(key);
        transitions.push([src, symbol, dst]);
      }
    }
  });

  const unique = (list) => list.filter((v, i) => list.indexOf(v) === i);
  const states = unique(declaredStates);
  const alphabet = unique(declaredSymbols);
  result.autoStates = unique(referencedStates).filter((s) => states.indexOf(s) === -1);
  result.autoSymbols = unique(referencedSymbols).filter((s) => alphabet.indexOf(s) === -1);
  result.states = states.concat(result.autoStates);
  result.alphabet = alphabet.concat(result.autoSymbols);
  result.startState = start;
  result.acceptStates = unique(accept);
  result.transitions = transitions;
  result.empty = !hasContent;
  return result;
}

/**
 * Apply a parsed import to an automaton without mutating it.
 * Full imports build a fresh automaton; partial imports merge into a copy
 * (existing states, symbols and transitions are left as they are).
 *
 * Returns { automaton, mode, needsLayout, created: { states, symbols },
 *           added: { states, symbols, transitions } }, where `created` lists
 * names that exist only because something referenced them, and `added`
 * counts what is new relative to the automaton passed in (full imports
 * count everything).
 */
function applyImport(current, parsed) {
  if (parsed.errors.length) throw new Error("Cannot apply an import with errors.");

  if (parsed.format === "json") {
    const automaton = parsed.automaton.clone();
    return {
      automaton: automaton,
      mode: "full",
      needsLayout: !automaton.states.length ||
        !automaton.states.every((s) => s in automaton.positions),
      created: { states: [], symbols: [] },
      added: {
        states: automaton.states.length,
        symbols: automaton.alphabet.length,
        transitions: automaton.allTransitionRows().length,
      },
    };
  }

  const full = parsed.mode === "full";
  const automaton = full
    ? new Automaton({ name: "Imported automaton" })
    : current.clone();
  const added = { states: 0, symbols: 0, transitions: 0 };

  for (const state of parsed.states) {
    if (automaton.states.indexOf(state) === -1) {
      automaton.addState(state);
      added.states += 1;
    }
  }
  for (const symbol of parsed.alphabet) {
    if (automaton.alphabet.indexOf(symbol) === -1) {
      automaton.addSymbol(symbol);
      added.symbols += 1;
    }
  }
  for (const row of parsed.transitions) {
    if (!automaton.targets(row[0], row[1]).has(row[2])) {
      automaton.addTransition(row[0], row[1], row[2]);
      added.transitions += 1;
    }
  }
  for (const state of parsed.acceptStates) automaton.acceptStates.add(state);
  if (parsed.startState !== null) automaton.setStartState(parsed.startState);

  const isNew = (list, existing) => full ? list : list.filter((v) => existing.indexOf(v) === -1);
  return {
    automaton: automaton,
    mode: full ? "full" : "partial",
    needsLayout: true,
    created: {
      states: isNew(parsed.autoStates, current.states),
      symbols: isNew(parsed.autoSymbols, current.alphabet),
    },
    added: added,
  };
}
