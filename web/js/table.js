/**
 * Transition table: the pure part of the editable table in the Transitions tab.
 *
 * Parsing and validating what is typed into a cell, diffing it against the
 * automaton, and deciding which columns to show and which cells to flag.
 * Nothing here touches the DOM, so it runs (and is tested) under plain Node.
 */

const EMPTY_SET_MARK = "∅";

/**
 * Split cell text into tokens. Commas and whitespace separate names; a
 * "{...}" group is kept whole, because conversions produce state names such
 * as "{q0,q1}". Whitespace inside a group is dropped ("{q0, q1}" = "{q0,q1}").
 */
function tokenizeCell(text) {
  const s = String(text || "");
  const tokens = [];
  let i = 0;
  while (i < s.length) {
    if (/[\s,]/.test(s[i])) {
      i += 1;
      continue;
    }
    let j = i;
    if (s[i] === "{") {
      let depth = 0;
      while (j < s.length) {
        if (s[j] === "{") depth += 1;
        else if (s[j] === "}") depth -= 1;
        j += 1;
        if (depth === 0) break;
      }
      tokens.push(s.slice(i, j).replace(/\s+/g, ""));
    } else {
      while (j < s.length && !/[\s,]/.test(s[j])) j += 1;
      tokens.push(s.slice(i, j));
    }
    i = j;
  }
  return tokens;
}

/**
 * Parse what was typed into a cell against the automaton's states.
 *
 * Returns { targets, errors }: targets are the named states, deduplicated, in
 * typing order; errors has one message per unknown name. States are never
 * created from here. Besides plain names:
 *   - "∅" or "{}" means "nothing" (unless a state is literally called "∅");
 *   - "{q1, q2}" that is not itself a state name is read as the set q1, q2.
 */
function parseCell(text, states) {
  const known = new Set(states || []);
  const targets = [];
  const unknown = [];
  const seen = new Set();

  const take = (name) => {
    if (seen.has(name)) return;
    seen.add(name);
    if (known.has(name)) targets.push(name);
    else unknown.push(name);
  };

  for (const token of tokenizeCell(text)) {
    if (known.has(token)) {
      take(token);
    } else if (token === EMPTY_SET_MARK || token === "{}") {
      // Explicitly empty: contributes nothing.
    } else if (token[0] === "{" && token[token.length - 1] === "}") {
      for (const inner of tokenizeCell(token.slice(1, -1))) take(inner);
    } else {
      take(token);
    }
  }

  return {
    targets: targets,
    errors: unknown.map((name) => 'Unknown state "' + name + '".'),
  };
}

/** What a commit changes: { add, remove }, both in a stable order. */
function diffCell(current, next) {
  const before = Array.from(current || []);
  const after = Array.from(next || []);
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  return {
    add: after.filter((s, i) => !beforeSet.has(s) && after.indexOf(s) === i),
    remove: before.filter((s, i) => !afterSet.has(s) && before.indexOf(s) === i),
  };
}

/** The targets of one cell, in the automaton's state order. */
function cellTargets(automaton, state, symbol) {
  const targets = automaton.targets(state, symbol);
  const ordered = automaton.states.filter((s) => targets.has(s));
  // Targets that are not (or no longer) in the states list go last.
  for (const t of sortedArray(targets)) if (ordered.indexOf(t) === -1) ordered.push(t);
  return ordered;
}

/** Cell text as shown and as offered for editing: "q1, q2" ("" when empty). */
function formatCell(automaton, state, symbol) {
  return cellTargets(automaton, state, symbol).join(", ");
}

/**
 * Which columns the table shows: the alphabet, plus ε when the automaton has
 * ε-transitions (forced: hiding it would hide transitions) or when the user
 * asked for it with the "Show ε" toggle.
 *
 * Returns { symbols, epsilon, epsilonForced }.
 */
function tableColumns(automaton, showEpsilon) {
  const forced = automaton.hasEpsilonTransitions();
  const epsilon = forced || Boolean(showEpsilon);
  return {
    symbols: automaton.alphabet.concat(epsilon ? [EPSILON] : []),
    epsilon: epsilon,
    epsilonForced: forced,
  };
}

/**
 * Whether an empty cell should be flagged as a missing transition: only when
 * the automaton is otherwise a DFA (by Automaton.isDeterministic), and never
 * in the ε column. Mirrors the "Missing transitions" list in Properties.
 */
function isMissingCell(automaton, state, symbol) {
  if (symbol === EPSILON) return false;
  if (automaton.alphabet.indexOf(symbol) === -1) return false;
  if (automaton.targets(state, symbol).size) return false;
  return automaton.isDeterministic();
}

/**
 * What committing `text` to one cell would do, without touching the
 * automaton: { changed, errors, add, remove }. Nothing may be committed while
 * `errors` is non-empty; `changed` false means "no-op, no history entry".
 */
function previewCell(automaton, state, symbol, text) {
  const parsed = parseCell(text, automaton.states);
  if (parsed.errors.length) {
    return { changed: false, errors: parsed.errors, add: [], remove: [] };
  }
  const diff = diffCell(cellTargets(automaton, state, symbol), parsed.targets);
  return {
    changed: diff.add.length > 0 || diff.remove.length > 0,
    errors: [],
    add: diff.add,
    remove: diff.remove,
  };
}

/** Apply a previewCell() result to the automaton. */
function applyCellChange(automaton, state, symbol, change) {
  for (const target of change.remove) automaton.removeTransition(state, symbol, target);
  for (const target of change.add) automaton.addTransition(state, symbol, target);
}
