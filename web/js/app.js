/**
 * Application shell: wires the editor panels, the diagram, the simulation
 * bar and the conversion tools together.
 *
 * It is the only place that mutates the model, and every
 * mutation goes through pushHistory() so undo/redo stays consistent.
 */

(function () {
  "use strict";

  /* ---------------------------------------------------------------- */
  /* Application state                                                 */
  /* ---------------------------------------------------------------- */

  // Everything that belongs to one automaton (history, selection, simulation,
  // view) lives on its document; see documents.js. The active one is doc().
  let documents = new DocumentList();
  let graph = null;

  // UI-only state that is not per document.
  let autoTimer = null;
  let pendingConversion = null;

  const doc = () => documents.active;
  const sel = () => documents.active.selection;

  /* ---------------------------------------------------------------- */
  /* DOM helpers                                                       */
  /* ---------------------------------------------------------------- */

  const $ = (id) => document.getElementById(id);

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  let toastTimer = null;
  function toast(message, kind) {
    const el = $("toast");
    el.textContent = message;
    el.className = "toast show" + (kind ? " " + kind : "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.className = "toast";
    }, 3200);
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function safeFilename(name) {
    const cleaned = String(name).replace(/[^A-Za-z0-9._ -]+/g, "_").trim();
    return (cleaned || "automaton").slice(0, 60);
  }

  /* ---------------------------------------------------------------- */
  /* History (undo / redo)                                             */
  /* ---------------------------------------------------------------- */

  function pushHistory() {
    pushDocumentHistory(doc());
    updateHistoryButtons();
  }

  function undo() {
    if (undoDocument(doc())) afterModelSwap();
  }

  function redo() {
    if (redoDocument(doc())) afterModelSwap();
  }

  function updateHistoryButtons() {
    $("btn-undo").disabled = doc().undoStack.length === 0;
    $("btn-redo").disabled = doc().redoStack.length === 0;
  }

  /** The active document's automaton object was replaced (undo, redo...). */
  function afterModelSwap() {
    const selection = sel();
    selection.state = null;
    selection.symbol = null;
    tableUi.error = null;
    resetSimulation();
    graph.automaton = doc().automaton;
    graph.selectedState = null;
    refresh();
    updateHistoryButtons();
  }

  /* ---------------------------------------------------------------- */
  /* Rendering                                                         */
  /* ---------------------------------------------------------------- */

  function refresh() {
    const automaton = doc().automaton;
    const report = analyzeProperties(automaton);

    // Assign diagnostics straight onto the view, then draw once.
    graph.automaton = automaton;
    graph.deadStates = report.deadStates;
    graph.unreachableStates = report.unreachableStates;
    graph.selectedState = sel().state;
    graph.render();

    renderStatesList(report);
    renderAlphabetList();
    renderTable();
    renderProperties(report);
    renderBadge();

    if (document.activeElement !== $("input-name")) $("input-name").value = automaton.name;
    $("canvas-empty").hidden = automaton.states.length > 0;
    updateEditorButtons();
    renderDocTabs();
    scheduleSave();
  }

  function renderBadge() {
    const automaton = doc().automaton;
    const badge = $("badge-type");
    if (!automaton.states.length) {
      badge.textContent = "—";
      badge.className = "badge";
      return;
    }
    const deterministic = automaton.isDeterministic();
    badge.textContent = deterministic ? "DFA" : "NFA";
    badge.className = "badge " + (deterministic ? "dfa" : "nfa");
  }

  function renderStatesList(report) {
    const automaton = doc().automaton;
    const list = $("list-states");
    list.textContent = "";
    if (!automaton.states.length) {
      list.innerHTML = '<li class="empty-note">No states yet</li>';
      return;
    }
    for (const state of automaton.states) {
      const li = document.createElement("li");
      li.dataset.state = state;
      if (state === sel().state) li.classList.add("selected");

      const tags = [];
      if (automaton.startState === state) tags.push('<span class="tag start">START</span>');
      if (automaton.acceptStates.has(state)) tags.push('<span class="tag accept">ACCEPT</span>');
      if (report.unreachableStates.has(state)) tags.push('<span class="tag unreachable">UNREACH</span>');
      if (report.deadStates.has(state)) tags.push('<span class="tag dead">DEAD</span>');

      li.innerHTML =
        "<span>" + escapeHtml(state) + "</span>" +
        '<span class="tags">' + tags.join("") + "</span>";

      li.addEventListener("click", () => {
        sel().state = state;
        graph.selectedState = state;
        graph.render();
        renderStatesList(report);
        updateEditorButtons();
      });
      list.appendChild(li);
    }
  }

  function renderAlphabetList() {
    const automaton = doc().automaton;
    const list = $("list-alphabet");
    list.textContent = "";
    if (!automaton.alphabet.length) {
      list.innerHTML = '<li class="empty-note">Alphabet is empty</li>';
      return;
    }
    for (const symbol of automaton.alphabet) {
      const li = document.createElement("li");
      if (symbol === sel().symbol) li.classList.add("selected");
      li.innerHTML = "<span><code>" + escapeHtml(symbol) + "</code></span>";
      li.addEventListener("click", () => {
        sel().symbol = symbol;
        renderAlphabetList();
        updateEditorButtons();
      });
      list.appendChild(li);
    }
  }

  function yesNo(value) {
    return '<span class="prop-value ' + (value ? "yes" : "no") + '">' +
      (value ? "Yes" : "No") + "</span>";
  }

  function chips(states, className) {
    if (!states.size) return '<span class="hint">None</span>';
    return '<div class="state-chips">' +
      sortedArray(states)
        .map((s) => '<span class="chip ' + className + '">' + escapeHtml(s) + "</span>")
        .join("") +
      "</div>";
  }

  function renderProperties(report) {
    const automaton = doc().automaton;
    const body = $("properties-body");

    if (!automaton.states.length) {
      body.innerHTML = '<p class="hint">Add at least one state to see the analysis.</p>';
      return;
    }

    let html =
      '<div class="prop-row"><span class="prop-label">Deterministic (DFA)</span>' +
      yesNo(report.isDeterministic) + "</div>" +
      '<div class="prop-row"><span class="prop-label">Complete</span>' +
      yesNo(report.isComplete) + "</div>" +
      '<div class="prop-row"><span class="prop-label">Connected</span>' +
      yesNo(report.isConnected) + "</div>" +
      '<div class="prop-row"><span class="prop-label">ε-transitions</span>' +
      yesNo(report.hasEpsilonTransitions) + "</div>" +
      '<div class="prop-row"><span class="prop-label">States / symbols</span>' +
      '<span class="prop-value">' + automaton.states.length + " / " +
      automaton.alphabet.length + "</span></div>";

    html += "<h4>Unreachable states</h4>" + chips(report.unreachableStates, "bad");
    html += "<h4>Dead states</h4>" + chips(report.deadStates, "muted");

    html += "<h4>Missing transitions</h4>";
    if (!report.missingTransitions.length) {
      html += '<p class="hint">None — the automaton is complete.</p>';
    } else {
      const shown = report.missingTransitions.slice(0, 12);
      html += '<ul class="error-list" style="color:var(--text-dim)">' +
        shown.map((m) => "<li><code>" + escapeHtml(m) + "</code></li>").join("") +
        "</ul>";
      if (report.missingTransitions.length > shown.length) {
        html += '<p class="hint">…and ' +
          (report.missingTransitions.length - shown.length) + " more.</p>";
      }
    }

    if (report.validationErrors.length) {
      html += "<h4>Validation</h4><ul class=\"error-list\">" +
        report.validationErrors.map((e) => "<li>" + escapeHtml(e) + "</li>").join("") +
        "</ul>";
    } else {
      html += '<h4>Validation</h4><p class="hint" style="color:var(--ok)">The automaton is well formed.</p>';
    }

    body.innerHTML = html;
  }

  function updateEditorButtons() {
    const automaton = doc().automaton;
    const { state: selectedState, symbol: selectedSymbol } = sel();
    const hasState = selectedState !== null && automaton.states.indexOf(selectedState) !== -1;
    $("btn-set-start").disabled = !hasState;
    $("btn-toggle-accept").disabled = !hasState;
    $("btn-rename-state").disabled = !hasState;
    $("btn-remove-state").disabled = !hasState;

    $("btn-remove-symbol").disabled =
      selectedSymbol === null || automaton.alphabet.indexOf(selectedSymbol) === -1;
  }

  /* ---------------------------------------------------------------- */
  /* Editor actions                                                    */
  /* ---------------------------------------------------------------- */

  /** Add a state (States tab or the table's "+ state"); false if refused. */
  function createState(name) {
    const automaton = doc().automaton;
    const problem = stateNameProblem(name, automaton.states);
    if (problem) {
      toast(problem, "error");
      return false;
    }
    pushHistory();
    // Drop new states near the centre of the current view.
    const rect = $("canvas").getBoundingClientRect();
    const x = (rect.width / 2 - graph.offsetX) / graph.scale + (Math.random() * 60 - 30);
    const y = (rect.height / 2 - graph.offsetY) / graph.scale + (Math.random() * 60 - 30);
    automaton.addState(name, [x, y]);
    sel().state = name;
    resetSimulation();
    refresh();
    return true;
  }

  function addState() {
    const input = $("input-state");
    if (createState(input.value.trim())) input.value = "";
  }

  function removeState() {
    const selection = sel();
    if (!selection.state) return;
    pushHistory();
    doc().automaton.removeState(selection.state);
    selection.state = null;
    resetSimulation();
    refresh();
  }

  function renameState() {
    const automaton = doc().automaton;
    const selection = sel();
    const current = selection.state;
    if (!current) return;
    const next = window.prompt("New name for state " + current + ":", current);
    if (next === null) return;
    const name = next.trim();
    const problem = stateNameProblem(name, automaton.states, current);
    if (problem) return toast(problem, "error");
    pushHistory();
    automaton.renameState(current, name);
    selection.state = name;
    resetSimulation();
    refresh();
  }

  function setStartState(state) {
    const target = state || sel().state;
    if (!target || doc().automaton.startState === target) return;
    pushHistory();
    doc().automaton.setStartState(target);
    resetSimulation();
    refresh();
  }

  function toggleAccept(state) {
    const target = state || sel().state;
    if (!target) return;
    pushHistory();
    doc().automaton.toggleAcceptState(target);
    resetSimulation();
    refresh();
  }

  /** Add a symbol (Alphabet tab or the table's "+ symbol"); false if refused. */
  function createSymbol(symbol) {
    const automaton = doc().automaton;
    const problem = newSymbolProblem(symbol, automaton.alphabet);
    if (problem) {
      toast(problem, "error");
      return false;
    }
    pushHistory();
    automaton.addSymbol(symbol);
    resetSimulation();
    refresh();
    return true;
  }

  function addSymbol() {
    const input = $("input-symbol");
    if (createSymbol(input.value.trim())) input.value = "";
  }

  function removeSymbol() {
    const selection = sel();
    if (!selection.symbol) return;
    pushHistory();
    doc().automaton.removeSymbol(selection.symbol);
    selection.symbol = null;
    resetSimulation();
    refresh();
  }

  /* ---------------------------------------------------------------- */
  /* Transition table                                                  */
  /* ---------------------------------------------------------------- */

  // UI state of the table; the model edits go through table.js + pushHistory.
  // Cells are identified by { state, symbol } so they survive a re-render.
  const tableUi = {
    showEpsilon: false, // the "Show ε column" toggle (forced on by ε-transitions)
    focus: null,        // the cell with the roving tabindex
    editing: null,      // { state, symbol, input } while a cell editor is open
    error: null,        // { state, symbol, text, message }: a refused edit
    hover: null,        // the cell under the mouse
    lastSelected: null, // last selected state scrolled into view
    rows: new Map(),    // state -> <tr>
    cells: new Map(),   // cellKey -> <td>
    columns: [],        // symbols currently shown, ε last
  };

  const cellKey = (state, symbol) => state + KEY_SEP + symbol;
  const sameCell = (a, b) => Boolean(a && b && a.state === b.state && a.symbol === b.symbol);

  function cellLabel(state, symbol) {
    return "δ(" + state + ", " + symbol + ")";
  }

  function renderTable() {
    const automaton = doc().automaton;
    const table = $("ttable");
    const active = document.activeElement;
    const hadCellFocus = table.contains(active) && !(active && /^ttable-add-/.test(active.id));
    const refocusId = active && /^ttable-add-/.test(active.id) ? active.id : null;
    tableUi.editing = null; // any open editor is discarded with the old DOM

    const columns = tableColumns(automaton, tableUi.showEpsilon);
    tableUi.columns = columns.symbols;
    const toggle = $("toggle-epsilon");
    toggle.checked = columns.epsilon;
    toggle.disabled = columns.epsilonForced;
    $("label-show-epsilon").classList.toggle("forced", columns.epsilonForced);
    $("label-show-epsilon").title = columns.epsilonForced
      ? "Always shown: this automaton has ε-transitions"
      : "Show a column for ε-transitions";

    const shown = (cell) => Boolean(cell) && automaton.states.indexOf(cell.state) !== -1 &&
      columns.symbols.indexOf(cell.symbol) !== -1;
    if (!shown(tableUi.focus)) tableUi.focus = null;
    if (!shown(tableUi.error)) tableUi.error = null;
    if (!shown(tableUi.hover)) tableUi.hover = null;

    table.textContent = "";
    tableUi.rows = new Map();
    tableUi.cells = new Map();

    const headRow = table.createTHead().insertRow();
    const corner = document.createElement("th");
    corner.className = "corner";
    corner.textContent = "δ";
    corner.title = "Rows: states · columns: symbols";
    headRow.appendChild(corner);
    for (const symbol of columns.symbols) {
      const th = document.createElement("th");
      th.className = "col-head" + (symbol === EPSILON ? " eps" : "");
      th.dataset.symbol = symbol;
      th.scope = "col";
      th.textContent = symbol;
      headRow.appendChild(th);
    }
    const addCol = document.createElement("th");
    addCol.className = "add-col";
    addCol.appendChild(tableAddInput("ttable-add-symbol", "+ symbol", 1,
      "Add a symbol (one character) and press Enter"));
    headRow.appendChild(addCol);

    const body = table.createTBody();
    for (const state of automaton.states) {
      const tr = body.insertRow();
      tr.dataset.state = state;
      if (state === sel().state) tr.classList.add("selected");
      tr.appendChild(rowHeader(automaton, state));
      for (const symbol of columns.symbols) {
        const td = tr.insertCell();
        td._cell = { state: state, symbol: symbol };
        td.tabIndex = -1;
        renderCellContent(td);
        tableUi.cells.set(cellKey(state, symbol), td);
      }
      tr.insertCell().className = "filler";
      tableUi.rows.set(state, tr);
    }

    const addRow = body.insertRow();
    addRow.className = "add-row";
    const addHead = document.createElement("th");
    addHead.className = "row-head";
    addHead.appendChild(tableAddInput("ttable-add-state", "+ state", 20,
      "Add a state and press Enter"));
    addRow.appendChild(addHead);
    const addFill = addRow.insertCell();
    addFill.className = "filler";
    addFill.colSpan = columns.symbols.length + 1;
    if (!automaton.states.length) {
      addFill.className = "filler empty-note";
      addFill.textContent = "No states yet — add one here.";
    } else if (!columns.symbols.length) {
      addFill.className = "filler empty-note";
      addFill.textContent = "Add a symbol with + symbol.";
    }

    // Roving tabindex: one cell is reachable with Tab, the arrows do the rest.
    const roving = tableUi.focus ? cellTd(tableUi.focus) : tableUi.cells.values().next().value;
    if (roving) roving.tabIndex = 0;
    if (hadCellFocus && tableUi.focus) cellTd(tableUi.focus).focus({ preventScroll: true });
    if (refocusId) $(refocusId).focus();

    applyTableSimHighlight();
    updateHoverEdges();
    renderTableMessage();
    if (sel().state !== tableUi.lastSelected) {
      tableUi.lastSelected = sel().state;
      if (sel().state) scrollRowIntoView(tableUi.rows.get(sel().state));
    }
    updateTableWidth();
  }

  function tableAddInput(id, placeholder, maxLength, title) {
    const input = document.createElement("input");
    input.type = "text";
    input.id = id;
    input.className = "ttable-add";
    input.placeholder = placeholder;
    input.maxLength = maxLength;
    input.autocomplete = "off";
    input.spellcheck = false;
    input.title = title;
    input.setAttribute("aria-label", title);
    return input;
  }

  function rowHeader(automaton, state) {
    const th = document.createElement("th");
    th.className = "row-head";
    th.scope = "row";
    const isStart = automaton.startState === state;
    const isAccept = automaton.acceptStates.has(state);

    const start = document.createElement("button");
    start.type = "button";
    start.className = "mark mark-start" + (isStart ? " on" : "");
    start.textContent = "→";
    start.dataset.action = "start";
    start.title = isStart ? state + " is the start state" : "Make " + state + " the start state";
    start.setAttribute("aria-pressed", String(isStart));

    const accept = document.createElement("button");
    accept.type = "button";
    accept.className = "mark mark-accept" + (isAccept ? " on" : "");
    accept.textContent = "*";
    accept.dataset.action = "accept";
    accept.title = isAccept
      ? state + " is accepting — click to make it non-accepting"
      : "Make " + state + " accepting";
    accept.setAttribute("aria-pressed", String(isAccept));

    const name = document.createElement("button");
    name.type = "button";
    name.className = "state-name";
    name.dataset.action = "select";
    name.textContent = state;
    name.title = "Select " + state + " on the diagram";

    th.appendChild(start);
    th.appendChild(accept);
    th.appendChild(name);
    return th;
  }

  /** (Re)draw one cell from the model, or from a refused edit. */
  function renderCellContent(td) {
    const automaton = doc().automaton;
    const { state, symbol } = td._cell;
    const simClasses = ["sim-col", "sim-cell"].filter((c) => td.classList.contains(c));
    td.textContent = "";
    td.className = "cell" + (symbol === EPSILON ? " eps" : "");
    for (const c of simClasses) td.classList.add(c);
    const label = cellLabel(state, symbol);

    if (sameCell(tableUi.error, td._cell)) {
      td.classList.add("error");
      td.textContent = tableUi.error.text || " ";
      td.title = tableUi.error.message + " Click to fix, Esc to discard.";
      return;
    }
    const text = formatCell(automaton, state, symbol);
    if (text) {
      td.textContent = text;
      td.title = label + " = {" + text + "} — click to edit";
      return;
    }
    const empty = document.createElement("span");
    empty.className = "empty";
    empty.textContent = "∅";
    td.appendChild(empty);
    if (isMissingCell(automaton, state, symbol)) {
      td.classList.add("missing");
      td.title = "Missing transition: " + label + " is undefined — click to add one";
    } else {
      td.title = label + " = ∅ — click to edit";
    }
  }

  function cellTd(cell) {
    return cell ? tableUi.cells.get(cellKey(cell.state, cell.symbol)) || null : null;
  }

  function renderTableMessage() {
    const box = $("ttable-message");
    const error = tableUi.error;
    box.hidden = !error;
    box.textContent = error ? cellLabel(error.state, error.symbol) + ": " + error.message : "";
  }

  function focusCell(cell) {
    const td = cellTd(cell);
    if (!td) return;
    for (const other of tableUi.cells.values()) other.tabIndex = -1;
    td.tabIndex = 0;
    tableUi.focus = { state: cell.state, symbol: cell.symbol };
    td.focus();
  }

  /** The cell next to `cell`; Tab-style moves (`wrap`) continue on the next row. */
  function neighbourCell(cell, dRow, dCol, wrap) {
    const states = doc().automaton.states;
    const columns = tableUi.columns;
    let row = states.indexOf(cell.state);
    let col = columns.indexOf(cell.symbol) + dCol;
    if (wrap && col >= columns.length) {
      col = 0;
      row += 1;
    } else if (wrap && col < 0) {
      col = columns.length - 1;
      row -= 1;
    }
    row += dRow;
    if (row < 0 || row >= states.length || col < 0 || col >= columns.length) return null;
    return { state: states[row], symbol: columns[col] };
  }

  /* ------------------------------ editing --------------------------- */

  function startEdit(cell, initialText) {
    if (tableUi.editing) {
      if (sameCell(tableUi.editing, cell)) return;
      if (!commitEdit()) return; // the other cell is invalid: stay there
    }
    const td = cellTd(cell);
    if (!td) return;
    const error = sameCell(tableUi.error, cell) ? tableUi.error : null;
    const value = initialText !== undefined ? initialText
      : error ? error.text : formatCell(doc().automaton, cell.state, cell.symbol);

    const width = td.offsetWidth; // keep the column from jumping while editing
    td.textContent = "";
    td.classList.add("editing");
    td.classList.remove("missing");
    td.removeAttribute("title");
    const input = document.createElement("input");
    input.type = "text";
    input.className = "cell-input" + (error ? " invalid" : "");
    input.value = value;
    input.style.width = Math.max(width, 96) + "px";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.setAttribute("aria-label", cellLabel(cell.state, cell.symbol) + " targets");
    if (error) input.title = error.message;
    input.addEventListener("keydown", onEditorKeydown);
    input.addEventListener("blur", onEditorBlur);
    input.addEventListener("input", () => input.classList.remove("invalid"));
    td.appendChild(input);

    tableUi.editing = { state: cell.state, symbol: cell.symbol, input: input };
    for (const other of tableUi.cells.values()) other.tabIndex = -1;
    td.tabIndex = 0;
    tableUi.focus = { state: cell.state, symbol: cell.symbol };
    input.focus();
    input.setSelectionRange(value.length, value.length);
  }

  /**
   * Close the open editor, committing its text. Returns false (and keeps the
   * editor open, marked invalid) when the text names unknown states.
   * A changed cell is exactly one undo step; an unchanged one is a no-op.
   */
  function commitEdit() {
    const editing = tableUi.editing;
    if (!editing) return true;
    const cell = { state: editing.state, symbol: editing.symbol };
    const text = editing.input.value;
    const automaton = doc().automaton;
    const change = previewCell(automaton, cell.state, cell.symbol, text);

    if (change.errors.length) {
      tableUi.error = {
        state: cell.state,
        symbol: cell.symbol,
        text: text,
        message: change.errors.join(" ") +
          " The table never creates states: add it with + state first.",
      };
      editing.input.classList.add("invalid");
      editing.input.title = tableUi.error.message;
      renderTableMessage();
      return false;
    }

    tableUi.editing = null;
    if (sameCell(tableUi.error, cell)) tableUi.error = null;
    if (!change.changed) {
      const td = cellTd(cell);
      if (td) renderCellContent(td);
      renderTableMessage();
      return true;
    }
    pushHistory();
    applyCellChange(automaton, cell.state, cell.symbol, change);
    resetSimulation();
    refresh();
    return true;
  }

  /** Esc: drop the typed text (and any parked error) and show the model again. */
  function cancelEdit() {
    const editing = tableUi.editing;
    if (!editing) return;
    const cell = { state: editing.state, symbol: editing.symbol };
    tableUi.editing = null;
    if (sameCell(tableUi.error, cell)) tableUi.error = null;
    const td = cellTd(cell);
    if (td) renderCellContent(td);
    renderTableMessage();
    focusCell(cell);
  }

  function onEditorBlur(e) {
    const editing = tableUi.editing;
    if (!editing || editing.input !== e.target) return; // already closed
    if (commitEdit()) return;
    // Refused: park the text as a red cell (with its message) instead of losing it.
    tableUi.editing = null;
    const td = cellTd(editing);
    if (td) renderCellContent(td);
  }

  function onEditorKeydown(e) {
    const editing = tableUi.editing;
    if (!editing) return;
    const input = editing.input;
    const cell = { state: editing.state, symbol: editing.symbol };
    const atStart = input.selectionStart === 0 && input.selectionEnd === 0;
    const atEnd = input.selectionStart === input.value.length &&
      input.selectionEnd === input.value.length;
    let next;
    switch (e.key) {
      case "Enter":
        e.preventDefault();
        if (commitEdit()) focusCell(cell);
        return;
      case "Escape":
        e.preventDefault();
        e.stopPropagation();
        cancelEdit();
        return;
      case "Tab":
        next = neighbourCell(cell, 0, e.shiftKey ? -1 : 1, true);
        break;
      case "ArrowUp":
        next = neighbourCell(cell, -1, 0, false);
        break;
      case "ArrowDown":
        next = neighbourCell(cell, 1, 0, false);
        break;
      case "ArrowLeft":
        if (!atStart) return; // move the caret inside the text
        next = neighbourCell(cell, 0, -1, false);
        break;
      case "ArrowRight":
        if (!atEnd) return;
        next = neighbourCell(cell, 0, 1, false);
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
    if (!commitEdit()) return;
    if (next) focusCell(next);
    else if (e.key === "Tab" && !e.shiftKey) $("ttable-add-state").focus();
    else focusCell(cell);
  }

  /** Keys on a focused (not editing) cell: spreadsheet-style navigation. */
  function onCellKeydown(e) {
    const td = e.target;
    if (!td._cell || tableUi.editing) return;
    const cell = td._cell;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    let next;
    switch (e.key) {
      case "Enter":
      case "F2":
        e.preventDefault();
        startEdit(cell);
        return;
      case "Tab":
        next = neighbourCell(cell, 0, e.shiftKey ? -1 : 1, true);
        if (!next) return; // let Tab leave the table
        break;
      case "ArrowUp": next = neighbourCell(cell, -1, 0, false); break;
      case "ArrowDown": next = neighbourCell(cell, 1, 0, false); break;
      case "ArrowLeft": next = neighbourCell(cell, 0, -1, false); break;
      case "ArrowRight": next = neighbourCell(cell, 0, 1, false); break;
      case "Escape":
        if (sameCell(tableUi.error, cell)) {
          tableUi.error = null;
          renderCellContent(td);
          renderTableMessage();
        }
        return;
      default:
        // Typing a character replaces the cell's text, as in a spreadsheet.
        if (e.key.length === 1 && e.key !== " ") {
          e.preventDefault();
          startEdit(cell, e.key);
        }
        return;
    }
    // Arrows never fall through to the simulation's ← → stepping here.
    e.preventDefault();
    e.stopPropagation();
    if (next) focusCell(next);
  }

  /* ------------------------------ linking --------------------------- */

  /** Point at the hovered (else focused) cell's edges on the diagram. */
  function updateHoverEdges() {
    let cell = tableUi.hover;
    if (!cell && tableUi.focus && $("ttable").contains(document.activeElement)) {
      cell = tableUi.focus;
    }
    if (!cell) {
      if (graph.hoverEdges.size) graph.setHoverEdges(null, []);
      return;
    }
    graph.setHoverEdges(cell.state, cellTargets(doc().automaton, cell.state, cell.symbol));
  }

  /**
   * Mirror the simulation: rows of the active states, the column of the next
   * symbol to read (the tape's current cell) and, strongest, where they meet.
   */
  function applyTableSimHighlight() {
    const sim = doc().sim;
    let rows = new Set();
    let column = null;
    if (sim.result && sim.result.steps.length) {
      const step = sim.result.steps[sim.index];
      rows = step.toStates;
      const symbols = Array.from(sim.result.inputString);
      if (sim.index < symbols.length && rows.size) column = symbols[sim.index];
    }
    for (const [state, tr] of tableUi.rows) tr.classList.toggle("sim-row", rows.has(state));
    for (const th of $("ttable").querySelectorAll("th.col-head")) {
      th.classList.toggle("sim-col", th.dataset.symbol === column);
    }
    for (const td of tableUi.cells.values()) {
      const inColumn = td._cell.symbol === column;
      td.classList.toggle("sim-col", inColumn);
      td.classList.toggle("sim-cell", inColumn && rows.has(td._cell.state));
    }
  }

  function scrollRowIntoView(tr) {
    const box = $("ttable-scroll");
    if (!tr || !box.offsetParent) return; // tab hidden
    const head = $("ttable").tHead;
    const top = box.getBoundingClientRect().top + (head ? head.offsetHeight : 0);
    const rect = tr.getBoundingClientRect();
    const bottom = box.getBoundingClientRect().bottom;
    if (rect.top < top) box.scrollTop -= top - rect.top;
    else if (rect.bottom > bottom) box.scrollTop += rect.bottom - bottom;
  }

  /** Tell the layout how wide the table would like the editor panel to be. */
  function updateTableWidth() {
    // Measure the table's natural width, not the panel-filling min-width:
    // otherwise a panel widened once could never shrink back.
    const table = $("ttable");
    table.style.minWidth = "0";
    const width = table.offsetWidth;
    table.style.minWidth = "";
    if (!width) return; // the Transitions tab is not showing
    $("layout").style.setProperty("--table-w", Math.ceil(width + 28) + "px");
  }

  function selectState(state) {
    sel().state = state;
    refresh();
  }

  function initTable() {
    const table = $("ttable");

    table.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      const editing = tableUi.editing;
      if (editing && editing.input.contains(e.target)) return; // caret placement
      const td = e.target.closest("td");
      if (td && td._cell) {
        e.preventDefault();
        startEdit(td._cell);
        return;
      }
      if (!editing) return;
      if (e.target.closest("button")) {
        e.preventDefault(); // keep the editor until the click commits it
      } else if (e.target.classList.contains("ttable-add")) {
        e.preventDefault();
        const id = e.target.id;
        if (commitEdit()) $(id).focus();
      }
    });

    table.addEventListener("click", (e) => {
      const button = e.target.closest("button[data-action]");
      if (!button) return;
      const state = button.closest("tr").dataset.state;
      if (!commitEdit()) return;
      if (button.dataset.action === "start") setStartState(state);
      else if (button.dataset.action === "accept") toggleAccept(state);
      else selectState(state);
    });

    table.addEventListener("keydown", (e) => {
      if (e.target.tagName === "TD") onCellKeydown(e);
      else if (e.target.id === "ttable-add-state" && e.key === "Enter") {
        if (createState(e.target.value.trim())) $("ttable-add-state").value = "";
      } else if (e.target.id === "ttable-add-symbol" && e.key === "Enter") {
        if (createSymbol(e.target.value.trim())) $("ttable-add-symbol").value = "";
      }
    });

    table.addEventListener("focusin", (e) => {
      const td = e.target.closest("td");
      if (td && td._cell) tableUi.focus = td._cell;
      updateHoverEdges();
    });
    table.addEventListener("focusout", (e) => {
      // Focus left the table: only a mouse hover may still point at edges.
      if (!table.contains(e.relatedTarget)) setTimeout(updateHoverEdges, 0);
    });

    table.addEventListener("mouseover", (e) => {
      const td = e.target.closest("td");
      const cell = td && td._cell ? td._cell : null;
      if (sameCell(cell, tableUi.hover) || (!cell && !tableUi.hover)) return;
      tableUi.hover = cell;
      updateHoverEdges();
    });
    table.addEventListener("mouseleave", () => {
      tableUi.hover = null;
      updateHoverEdges();
    });

    $("toggle-epsilon").addEventListener("change", (e) => {
      tableUi.showEpsilon = e.target.checked;
      renderTable();
    });

    // Keep the diagram centred while the canvas narrows or widens (e.g. the
    // editor panel growing for the table) instead of cropping one side.
    if (window.ResizeObserver) {
      const svg = $("canvas");
      let lastWidth = 0;
      new ResizeObserver(() => {
        const width = svg.getBoundingClientRect().width;
        if (lastWidth && width && graph && width !== lastWidth) {
          graph.offsetX += (width - lastWidth) / 2;
          graph.applyTransform();
        }
        lastWidth = width;
      }).observe(svg);
    }
  }

  /* ---------------------------------------------------------------- */
  /* Simulation                                                        */
  /* ---------------------------------------------------------------- */

  /** Forget the active document's run and clear the simulation bar. */
  function resetSimulation() {
    stopAuto();
    const sim = doc().sim;
    sim.result = null;
    sim.index = 0;
    if (graph) {
      graph.highlightedStates = new Set();
      graph.highlightedEdges = new Set();
    }
    applyTableSimHighlight();
    clearSimulationBar();
  }

  function clearSimulationBar() {
    $("sim-verdict").textContent = "";
    $("sim-verdict").className = "verdict";
    $("sim-step").textContent = "Enter a string and press Simulate.";
    $("sim-tape").textContent = "";
    setStepButtons(false);
  }

  function setStepButtons(enabled) {
    const ids = ["btn-step-first", "btn-step-prev", "btn-step-auto", "btn-step-next", "btn-step-last"];
    for (const id of ids) $(id).disabled = !enabled;
  }

  function runSimulation() {
    stopAuto();
    const automaton = doc().automaton;
    const sim = doc().sim;
    const input = $("input-string").value;
    sim.input = input;

    const errors = automaton.validate();
    if (errors.length) {
      sim.result = null;
      $("sim-verdict").textContent = "Invalid automaton";
      $("sim-verdict").className = "verdict error";
      $("sim-step").textContent = errors[0];
      setStepButtons(false);
      return;
    }

    sim.result = simulate(automaton, input);
    sim.index = 0;

    if (sim.result.error) {
      $("sim-verdict").textContent = "Error";
      $("sim-verdict").className = "verdict error";
      $("sim-step").textContent = sim.result.error;
      sim.result = null;
      graph.clearHighlight();
      setStepButtons(false);
      return;
    }

    setStepButtons(true);
    // Jump straight to the outcome, then let the user walk back through it.
    sim.index = sim.result.steps.length - 1;
    renderSimStep();
  }

  function renderSimStep() {
    const sim = doc().sim;
    const simResult = sim.result;
    const simIndex = sim.index;
    if (!simResult || !simResult.steps.length) return;
    const step = simResult.steps[simIndex];

    graph.setHighlight(step.toStates, step.symbol, step.fromStates);
    applyTableSimHighlight();

    const consumed = simIndex;
    const symbols = Array.from(simResult.inputString);
    const tape = $("sim-tape");
    tape.textContent = "";
    if (!symbols.length) {
      const cell = document.createElement("span");
      cell.className = "cell done";
      cell.textContent = "ε (empty string)";
      tape.appendChild(cell);
    } else {
      symbols.forEach((symbol, i) => {
        const cell = document.createElement("span");
        let cls = "cell";
        if (i < consumed) cls += " done";
        else if (i === consumed) cls += " current";
        cell.className = cls;
        cell.textContent = symbol;
        tape.appendChild(cell);
      });
    }

    $("sim-step").textContent =
      "Step " + simIndex + " / " + (simResult.steps.length - 1) + " — " + step.description;

    const atEnd = simIndex === simResult.steps.length - 1;
    const verdict = $("sim-verdict");
    if (atEnd) {
      const consumedAll = simResult.steps.length - 1 === symbols.length;
      if (simResult.accepted) {
        verdict.textContent = "ACCEPTED";
        verdict.className = "verdict accepted";
      } else {
        verdict.textContent = consumedAll ? "REJECTED" : "REJECTED (stuck)";
        verdict.className = "verdict rejected";
      }
    } else {
      verdict.textContent = "running…";
      verdict.className = "verdict";
    }

    setStepButtons(true);
    $("btn-step-prev").disabled = simIndex === 0;
    $("btn-step-first").disabled = simIndex === 0;
    $("btn-step-next").disabled = atEnd;
    $("btn-step-last").disabled = atEnd;
  }

  function goToStep(index) {
    const sim = doc().sim;
    if (!sim.result) return;
    sim.index = Math.max(0, Math.min(sim.result.steps.length - 1, index));
    renderSimStep();
  }

  function stopAuto() {
    if (autoTimer) {
      clearInterval(autoTimer);
      autoTimer = null;
      const btn = $("btn-step-auto");
      if (btn) btn.textContent = "▶ Auto";
    }
  }

  function toggleAuto() {
    if (autoTimer) return stopAuto();
    const sim = doc().sim;
    if (!sim.result) return;
    if (sim.index >= sim.result.steps.length - 1) sim.index = 0;
    $("btn-step-auto").textContent = "⏸ Pause";
    renderSimStep();
    autoTimer = setInterval(() => {
      if (!sim.result || sim.index >= sim.result.steps.length - 1) return stopAuto();
      sim.index += 1;
      renderSimStep();
    }, 900);
  }

  /* ---------------------------------------------------------------- */
  /* Conversions                                                       */
  /* ---------------------------------------------------------------- */

  function showConversion(html, resultAutomaton) {
    $("convert-body").innerHTML = html;
    pendingConversion = resultAutomaton || null;
    $("btn-apply-conversion").hidden = !resultAutomaton;
  }

  function conversionError(message) {
    showConversion('<p class="error-list" style="list-style:none;padding:0">' +
      escapeHtml(message) + "</p>", null);
    toast(message, "error");
  }

  function runNfaToDfa() {
    const automaton = doc().automaton;
    const errors = automaton.validate();
    if (errors.length) return conversionError(errors[0]);
    let result;
    try {
      result = nfaToDfa(automaton);
    } catch (err) {
      return conversionError(err.message);
    }

    const alphabet = automaton.alphabet.filter((s) => s !== EPSILON);
    let html = "<h4>Subset construction table</h4>";
    html += '<div class="table-scroll"><table><thead><tr><th>DFA state</th><th>NFA states</th>' +
      alphabet.map((s) => "<th>" + escapeHtml(s) + "</th>").join("") +
      "</tr></thead><tbody>";

    for (const step of result.steps) {
      const isStart = step.dfaState === result.dfa.startState;
      const isAccept = result.dfa.acceptStates.has(step.dfaState);
      const marks = (isStart ? "→ " : "") + (isAccept ? "* " : "");
      html += "<tr><td><code>" + escapeHtml(marks + step.dfaState) + "</code></td>" +
        "<td>{" + escapeHtml(sortedArray(step.sourceNfaStates).join(", ")) + "}</td>" +
        alphabet
          .map((s) => "<td><code>" + escapeHtml(step.transitions[s] || "∅") + "</code></td>")
          .join("") +
        "</tr>";
    }
    html += "</tbody></table></div>";
    html += '<p class="hint">→ start state · * accepting state · ' +
      result.dfa.states.length + " DFA states from " + automaton.states.length + " NFA states.</p>";

    showConversion(html, result.dfa);
    toast("Subset construction complete: " + result.dfa.states.length + " DFA states.", "ok");
  }

  function runMinimize() {
    const automaton = doc().automaton;
    const errors = automaton.validate();
    if (errors.length) return conversionError(errors[0]);
    let result;
    try {
      result = minimizeDfa(automaton);
    } catch (err) {
      return conversionError(err.message);
    }

    let html = "<h4>Partition refinement</h4><ol>";
    for (const step of result.steps) {
      html += "<li>" + escapeHtml(step.description) + "<br>" +
        step.groups
          .map((g) => "<code>{" + escapeHtml(sortedArray(g).join(",")) + "}</code>")
          .join(" ") +
        "</li>";
    }
    html += "</ol>";

    if (result.removedUnreachable.size) {
      html += "<h4>Removed as unreachable</h4>" +
        '<div class="state-chips">' +
        sortedArray(result.removedUnreachable)
          .map((s) => '<span class="chip bad">' + escapeHtml(s) + "</span>")
          .join("") +
        "</div>";
    }

    html += '<p class="hint">' + automaton.states.length + " states → " +
      result.dfa.states.length + " states in the minimal DFA.</p>";

    showConversion(html, result.dfa);
    toast("Minimized: " + automaton.states.length + " → " + result.dfa.states.length + " states.", "ok");
  }

  function runDfaToNfa() {
    const result = dfaToNfa(doc().automaton);
    showConversion(
      '<p class="hint">Every DFA is already a valid NFA. This produces an equivalent copy ' +
      "labelled as an NFA, ready to extend with non-deterministic or ε-transitions.</p>",
      result
    );
  }

  /** "Open in new tab": the result gets its own tab; the original is untouched. */
  function applyConversion() {
    const result = pendingConversion;
    if (!result) return;
    const sourceName = doc().automaton.name;
    // Conversions invent new state names with no coordinates: lay them out.
    result.positions = {};
    openInTab(result, { layout: true, forceNew: true });
    showConversionHint("Opened in a new tab, next to \u201c" + sourceName + "\u201d.");
    toast("Result opened in a new tab.", "ok");
  }

  function showConversionHint(message) {
    pendingConversion = null;
    $("btn-apply-conversion").hidden = true;
    $("convert-body").innerHTML = '<p class="hint">' + escapeHtml(message) + "</p>";
  }

  /* ---------------------------------------------------------------- */
  /* Files                                                             */
  /* ---------------------------------------------------------------- */

  /** Toolbar "Auto-sort": undoable, so Ctrl+Z restores the previous positions. */
  function autoSort() {
    if (!doc().automaton.states.length) return;
    pushHistory();
    graph.autoLayout();
  }

  /** Toolbar "New" and the tab strip "+": always a fresh, empty tab. */
  function newAutomaton() {
    openInTab(null, { forceNew: true });
    $("input-state").focus();
  }

  function saveFile() {
    const automaton = doc().automaton;
    const data = JSON.stringify(automaton.toJSON(), null, 2);
    downloadBlob(new Blob([data], { type: "application/json" }),
      safeFilename(automaton.name) + ".afjson");
    toast("Downloaded as .afjson.", "ok");
  }

  function openFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(String(reader.result));
        if (!data || !Array.isArray(data.states)) {
          throw new Error("This file is not a valid .afjson automaton.");
        }
        const automaton = Automaton.fromJSON(data);
        openInTab(automaton);
        toast('Opened "' + automaton.name + '".', "ok");
      } catch (err) {
        toast("Could not read the file: " + err.message, "error");
      }
    };
    reader.onerror = () => toast("Could not read the file.", "error");
    reader.readAsText(file);
  }

  /* ---------------------------------------------------------------- */
  /* Import dialog                                                     */
  /* ---------------------------------------------------------------- */

  function plural(count, word) {
    return count + " " + word + (count === 1 ? "" : "s");
  }

  /** Parse the dialog text; returns { parsed, result } with result null if unusable. */
  function currentImport() {
    const parsed = parseImport($("import-text").value);
    const usable = !parsed.empty && !parsed.errors.length;
    return { parsed: parsed, result: usable ? applyImport(doc().automaton, parsed) : null };
  }

  function renderImportPreview() {
    const current = currentImport();
    const parsed = current.parsed;
    const result = current.result;
    const preview = $("import-preview");
    $("import-apply").disabled = !result;

    if (parsed.empty) {
      preview.innerHTML = '<p class="hint">Type or paste a definition, or drop a file, to see a preview here.</p>';
      return;
    }

    const full = parsed.mode === "full";
    let html = '<h4>Mode</h4><p class="import-mode ' + parsed.mode + '">' +
      (full ? (isBlankDocument(doc()) ? "Full import — fills this empty tab"
          : "Full import — opens in a new tab") : "Merge into current automaton") + "</p>";

    html += "<h4>Contents</h4><p>" +
      plural(parsed.states.length, "state") + " · " +
      plural(parsed.alphabet.length, "symbol") + " · " +
      plural(parsed.transitions.length, "transition") + "</p>";
    if (parsed.startState) html += "<p>Start: <code>" + escapeHtml(parsed.startState) + "</code></p>";
    if (parsed.acceptStates.length) {
      html += "<p>Accepting: <code>" + escapeHtml(parsed.acceptStates.join(", ")) + "</code></p>";
    }

    if (result) {
      if (!full) {
        html += "<p>New: " + plural(result.added.states, "state") + ", " +
          plural(result.added.symbols, "symbol") + ", " +
          plural(result.added.transitions, "transition") + "</p>";
      }
      const created = [];
      if (result.created.states.length) created.push(escapeHtml(result.created.states.join(", ")));
      if (result.created.symbols.length) {
        created.push("symbols: " + escapeHtml(result.created.symbols.join(", ")));
      }
      if (created.length) {
        html += "<h4>Auto-created</h4><p>auto-created: " + created.join("; ") + "</p>";
      }
      if (parsed.format === "json") {
        html += '<p class="hint">' + (result.needsLayout
          ? "Some states have no position: the diagram will be auto-laid out."
          : "Positions from the file are kept.") + "</p>";
      }
    }

    if (parsed.errors.length) {
      html += "<h4>Errors (" + parsed.errors.length + ')</h4><ul class="error-list">' +
        parsed.errors.map((e) => "<li>" + escapeHtml(e) + "</li>").join("") + "</ul>";
    }
    preview.innerHTML = html;
  }

  function openImportDialog() {
    renderImportPreview();
    $("import-dialog").showModal();
    $("import-text").focus();
  }

  function closeImportDialog() {
    $("import-dialog").classList.remove("dragging");
    $("import-dialog").close();
  }

  /** A picked or dropped file just fills the textarea; the one parser does the rest. */
  function loadImportFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      $("import-text").value = String(reader.result);
      renderImportPreview();
    };
    reader.onerror = () => toast("Could not read the file.", "error");
    reader.readAsText(file);
  }

  function applyImportDialog() {
    const result = currentImport().result;
    if (!result) return;

    closeImportDialog();
    if (result.mode === "full") {
      // A full import is a new document, like Open: a new tab unless this one is blank.
      openInTab(result.automaton, { layout: result.needsLayout });
    } else {
      // A merge edits this document; one history entry covers it and its layout.
      pushHistory();
      doc().automaton = result.automaton;
      afterModelSwap();
      if (result.needsLayout) graph.autoLayout();
      else graph.fitView();
    }

    const a = result.added;
    toast(result.mode === "full"
      ? "Imported " + plural(a.states, "state") + ", " + plural(a.symbols, "symbol") +
        ", " + plural(a.transitions, "transition") + "."
      : "Merged: +" + plural(a.states, "state") + ", +" + plural(a.symbols, "symbol") +
        ", +" + plural(a.transitions, "transition") + ".", "ok");
  }

  function initImportDialog() {
    const dialog = $("import-dialog");
    $("btn-import").addEventListener("click", openImportDialog);
    $("import-text").addEventListener("input", renderImportPreview);
    $("import-cancel").addEventListener("click", closeImportDialog);
    $("import-apply").addEventListener("click", applyImportDialog);
    $("import-choose").addEventListener("click", () => $("import-file-input").click());
    $("import-file-input").addEventListener("change", (e) => {
      const file = e.target.files && e.target.files[0];
      if (file) loadImportFile(file);
      e.target.value = "";
    });

    // The whole dialog is a drop target, textarea included.
    dialog.addEventListener("dragover", (e) => {
      if (!e.dataTransfer || Array.from(e.dataTransfer.types).indexOf("Files") === -1) return;
      e.preventDefault();
      dialog.classList.add("dragging");
    });
    dialog.addEventListener("dragleave", (e) => {
      if (!dialog.contains(e.relatedTarget)) dialog.classList.remove("dragging");
    });
    dialog.addEventListener("drop", (e) => {
      const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (!file) return;
      e.preventDefault();
      dialog.classList.remove("dragging");
      loadImportFile(file);
    });
  }

  function exportPng() {
    const automaton = doc().automaton;
    if (!automaton.states.length) return toast("Nothing to export yet.", "error");
    const background = isDark() ? "#14161a" : "#ffffff";
    graph
      .toPngBlob(background, 2)
      .then((blob) => {
        downloadBlob(blob, safeFilename(automaton.name) + ".png");
        toast("Diagram exported as PNG.", "ok");
      })
      .catch((err) => toast(err.message, "error"));
  }

  /** Opens a print-ready report; the browser's print dialog saves it as PDF. */
  function exportReport() {
    const automaton = doc().automaton;
    if (!automaton.states.length) return toast("Nothing to report yet.", "error");
    const report = analyzeProperties(automaton);
    const svg = graph.toStandaloneSvg("#ffffff");

    const rows = automaton
      .allTransitionRows()
      .map(
        (r) =>
          "<tr><td>" + escapeHtml(r[0]) + "</td><td>" + escapeHtml(r[1]) +
          "</td><td>" + escapeHtml(r[2]) + "</td></tr>"
      )
      .join("");

    const propRow = (label, value) =>
      "<tr><td>" + label + "</td><td><strong>" + (value ? "Yes" : "No") + "</strong></td></tr>";

    const html =
      "<!DOCTYPE html><html><head><meta charset='utf-8'><title>" +
      escapeHtml(automaton.name) + " — report</title><style>" +
      "body{font:13px/1.6 system-ui,sans-serif;color:#1c1e21;max-width:820px;margin:32px auto;padding:0 20px}" +
      "h1{font-size:20px;margin:0 0 4px}h2{font-size:14px;margin:26px 0 8px;text-transform:uppercase;" +
      "letter-spacing:.05em;color:#656d78;border-bottom:1px solid #dfe3e8;padding-bottom:4px}" +
      "table{border-collapse:collapse;width:100%;font-size:12px}" +
      "th,td{border:1px solid #dfe3e8;padding:5px 8px;text-align:left}th{background:#f4f6f8}" +
      "figure{margin:0;text-align:center}svg{max-width:100%;height:auto}" +
      ".meta{color:#656d78;font-size:12px;margin:0 0 18px}" +
      "@media print{body{margin:0}}</style></head><body>" +
      "<h1>" + escapeHtml(automaton.name) + "</h1>" +
      "<p class='meta'>" + (report.isDeterministic ? "DFA" : "NFA") + " · " +
      automaton.states.length + " states · alphabet {" +
      escapeHtml(automaton.alphabet.join(", ")) + "} · generated by AutomataStudio</p>" +
      "<h2>Diagram</h2><figure>" + svg + "</figure>" +
      "<h2>Properties</h2><table>" +
      propRow("Deterministic (DFA)", report.isDeterministic) +
      propRow("Complete", report.isComplete) +
      propRow("Connected", report.isConnected) +
      propRow("Has ε-transitions", report.hasEpsilonTransitions) +
      "<tr><td>Start state</td><td><strong>" +
      escapeHtml(automaton.startState || "—") + "</strong></td></tr>" +
      "<tr><td>Accepting states</td><td><strong>" +
      escapeHtml(sortedArray(automaton.acceptStates).join(", ") || "—") + "</strong></td></tr>" +
      "<tr><td>Unreachable states</td><td>" +
      escapeHtml(sortedArray(report.unreachableStates).join(", ") || "none") + "</td></tr>" +
      "<tr><td>Dead states</td><td>" +
      escapeHtml(sortedArray(report.deadStates).join(", ") || "none") + "</td></tr>" +
      "</table>" +
      "<h2>Transition table</h2><table><thead><tr><th>From</th><th>Symbol</th><th>To</th></tr></thead>" +
      "<tbody>" + rows + "</tbody></table>" +
      "</body></html>";

    const win = window.open("", "_blank");
    if (!win) return toast("Allow pop-ups to open the report.", "error");
    win.document.write(html);
    win.document.close();
    win.focus();
    setTimeout(() => win.print(), 400);
  }

  /* ---------------------------------------------------------------- */
  /* Document tabs                                                     */
  /* ---------------------------------------------------------------- */

  // The example shown on a first visit, before anything has been autosaved.
  const FIRST_RUN_EXAMPLE = "DFA: ends with 1";
  const DEFAULT_CONVERT_HINT = "Run a conversion to see the full process here, then open the result in a new tab.";

  let saveTimer = null;
  let scrolledTabId = null;

  function currentView() {
    return { scale: graph.scale, offsetX: graph.offsetX, offsetY: graph.offsetY };
  }

  /** Park what lives in the DOM or the view (zoom/pan, typed input) on the active document. */
  function leaveDocument() {
    stopAuto();
    const current = doc();
    if (!current) return;
    current.view = currentView();
    current.sim.input = $("input-string").value;
  }

  /** Put the active document on screen: diagram, view, panels, simulation, history. */
  function showDocument() {
    stopAuto();
    const current = doc();
    tableUi.focus = null;
    tableUi.error = null;
    tableUi.hover = null;
    graph.automaton = current.automaton;
    graph.selectedState = current.selection.state;
    graph.highlightedStates = new Set();
    graph.highlightedEdges = new Set();
    $("input-string").value = current.sim.input;
    $("input-name").value = current.automaton.name;
    showConversionHint(DEFAULT_CONVERT_HINT);

    refresh();
    if (current.view) {
      graph.scale = current.view.scale;
      graph.offsetX = current.view.offsetX;
      graph.offsetY = current.view.offsetY;
      graph.applyTransform();
    } else {
      graph.fitView();
    }
    if (current.sim.result) renderSimStep();
    else clearSimulationBar();
    updateHistoryButtons();
  }

  /**
   * Show `automaton` in a tab: the current one if it is blank (no states, no
   * history), otherwise a new one. `forceNew` always opens a new tab;
   * `layout` runs Auto-sort on it first.
   */
  function openInTab(automaton, options) {
    const opts = options || {};
    leaveDocument();
    if (opts.forceNew) documents.add(automaton);
    else documents.open(automaton);
    showDocument();
    if (opts.layout) graph.autoLayout();
  }

  function switchToDocument(id) {
    if (id === documents.activeId) return;
    leaveDocument();
    documents.activate(id);
    showDocument();
  }

  function closeDocument(id) {
    const target = documents.find(id);
    if (!target) return;
    if (target.automaton.states.length &&
        !window.confirm('Close "' + target.automaton.name + '"? Its automaton and undo history will be lost.')) {
      return;
    }
    if (id !== documents.activeId) {
      documents.close(id);
      renderDocTabs();
      scheduleSave();
      return;
    }
    stopAuto();
    documents.close(id);
    showDocument();
  }

  function renderDocTabs() {
    const strip = $("doc-tabs");
    strip.textContent = "";
    for (const d of documents.documents) {
      const active = d.id === documents.activeId;
      const name = d.automaton.name || DEFAULT_DOCUMENT_NAME;

      const tab = document.createElement("div");
      tab.className = "doc-tab" + (active ? " active" : "");
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", active ? "true" : "false");
      tab.tabIndex = active ? 0 : -1;
      tab.title = name;
      tab.dataset.doc = String(d.id);

      const label = document.createElement("span");
      label.className = "doc-tab-label";
      label.textContent = name;

      const close = document.createElement("button");
      close.type = "button";
      close.className = "doc-tab-close";
      close.title = "Close tab";
      close.setAttribute("aria-label", "Close " + name);
      close.textContent = "×";
      close.addEventListener("click", (e) => {
        e.stopPropagation();
        closeDocument(d.id);
      });

      tab.addEventListener("click", () => switchToDocument(d.id));
      tab.addEventListener("auxclick", (e) => {
        if (e.button === 1) closeDocument(d.id); // middle click closes, as in browsers
      });
      tab.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          switchToDocument(d.id);
        }
      });

      tab.appendChild(label);
      tab.appendChild(close);
      strip.appendChild(tab);

      // Keep a newly activated tab visible when the strip overflows.
      if (active && scrolledTabId !== d.id) {
        scrolledTabId = d.id;
        tab.scrollIntoView({ block: "nearest", inline: "nearest" });
      }
    }
    updateTabOverflow();
  }

  /** Fade whichever edge of the strip hides more tabs. */
  function updateTabOverflow() {
    const strip = $("doc-tabs");
    const hiddenRight = strip.scrollWidth - strip.clientWidth - strip.scrollLeft;
    strip.classList.toggle("more-left", strip.scrollLeft > 1);
    strip.classList.toggle("more-right", hiddenRight > 1);
  }

  function initDocTabs() {
    const strip = $("doc-tabs");
    strip.addEventListener("scroll", updateTabOverflow);
    window.addEventListener("resize", updateTabOverflow);
    // A plain mouse wheel scrolls the strip sideways.
    strip.addEventListener("wheel", (e) => {
      if (e.deltaX || !e.deltaY || strip.scrollWidth <= strip.clientWidth) return;
      e.preventDefault();
      strip.scrollLeft += e.deltaY;
    }, { passive: false });
    $("btn-new-tab").addEventListener("click", newAutomaton);
  }

  /* ----------------------------- autosave -------------------------- */

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 400);
  }

  /** Persist every tab (not the undo history) to localStorage. */
  function saveNow() {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (!doc() || !graph) return;
    doc().view = currentView();
    try {
      documents.save(window.localStorage);
    } catch (err) {
      /* storage disabled: tabs simply will not survive a reload */
    }
  }

  function loadStoredDocuments() {
    try {
      return DocumentList.load(window.localStorage);
    } catch (err) {
      return null;
    }
  }

  /* ---------------------------------------------------------------- */
  /* Theme                                                            */
  /* ---------------------------------------------------------------- */

  function isDark() {
    const attr = document.documentElement.getAttribute("data-theme");
    if (attr) return attr === "dark";
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  }

  function applyTheme(dark) {
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
    $("btn-theme").textContent = dark ? "☀" : "🌙";
    graph.setDarkMode(dark);
    try {
      localStorage.setItem("automatastudio-theme", dark ? "dark" : "light");
    } catch (err) {
      /* private mode: the theme simply will not be remembered */
    }
  }

  function initTheme() {
    let stored = null;
    try {
      stored = localStorage.getItem("automatastudio-theme");
    } catch (err) {
      stored = null;
    }
    const dark = stored ? stored === "dark"
      : window.matchMedia("(prefers-color-scheme: dark)").matches;
    applyTheme(dark);
  }

  /* ---------------------------------------------------------------- */
  /* Tabs                                                              */
  /* ---------------------------------------------------------------- */

  function initTabs() {
    for (const panel of document.querySelectorAll(".panel")) {
      for (const tab of panel.querySelectorAll(".tab")) {
        tab.addEventListener("click", () => {
          panel.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
          panel.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
          tab.classList.add("active");
          const target = panel.querySelector('[data-panel="' + tab.dataset.tab + '"]');
          if (target) target.classList.add("active");
          if (panel.classList.contains("panel-left")) {
            // The transition table gets a wider editor panel (see styles.css).
            $("layout").classList.toggle("table-mode", tab.dataset.tab === "transitions");
            updateTableWidth();
          }
        });
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /* Wiring                                                            */
  /* ---------------------------------------------------------------- */

  function initExamples() {
    const select = $("select-example");
    for (const key of Object.keys(EXAMPLES)) {
      const option = document.createElement("option");
      option.value = key;
      option.textContent = key;
      select.appendChild(option);
    }
    select.addEventListener("change", () => {
      const key = select.value;
      if (!key) return;
      openInTab(Automaton.fromJSON(EXAMPLES[key]));
      select.value = "";
      toast('Loaded example: "' + key + '".', "ok");
    });
  }

  function initEvents() {
    $("btn-add-state").addEventListener("click", addState);
    $("input-state").addEventListener("keydown", (e) => {
      if (e.key === "Enter") addState();
    });
    $("btn-remove-state").addEventListener("click", removeState);
    $("btn-rename-state").addEventListener("click", renameState);
    $("btn-set-start").addEventListener("click", () => setStartState(null));
    $("btn-toggle-accept").addEventListener("click", () => toggleAccept(null));

    $("btn-add-symbol").addEventListener("click", addSymbol);
    $("input-symbol").addEventListener("keydown", (e) => {
      if (e.key === "Enter") addSymbol();
    });
    $("btn-remove-symbol").addEventListener("click", removeSymbol);

    initTable();

    $("btn-simulate").addEventListener("click", runSimulation);
    $("input-string").addEventListener("keydown", (e) => {
      if (e.key === "Enter") runSimulation();
    });
    $("btn-step-first").addEventListener("click", () => { stopAuto(); goToStep(0); });
    $("btn-step-prev").addEventListener("click", () => { stopAuto(); goToStep(doc().sim.index - 1); });
    $("btn-step-next").addEventListener("click", () => { stopAuto(); goToStep(doc().sim.index + 1); });
    $("btn-step-last").addEventListener("click", () => {
      stopAuto();
      goToStep(doc().sim.result ? doc().sim.result.steps.length - 1 : 0);
    });
    $("btn-step-auto").addEventListener("click", toggleAuto);

    $("btn-to-dfa").addEventListener("click", runNfaToDfa);
    $("btn-minimize").addEventListener("click", runMinimize);
    $("btn-to-nfa").addEventListener("click", runDfaToNfa);
    $("btn-apply-conversion").addEventListener("click", applyConversion);

    $("btn-new").addEventListener("click", newAutomaton);
    $("btn-save").addEventListener("click", saveFile);
    $("btn-export-png").addEventListener("click", exportPng);
    $("btn-report").addEventListener("click", exportReport);
    $("btn-open").addEventListener("click", () => $("file-input").click());
    $("file-input").addEventListener("change", (e) => {
      const file = e.target.files && e.target.files[0];
      if (file) openFile(file);
      e.target.value = "";
    });

    $("btn-undo").addEventListener("click", undo);
    $("btn-redo").addEventListener("click", redo);

    $("btn-layout").addEventListener("click", autoSort);
    $("btn-fit").addEventListener("click", () => { graph.fitView(); scheduleSave(); });
    $("btn-zoom-in").addEventListener("click", () => { graph.zoomBy(1.2); scheduleSave(); });
    $("btn-zoom-out").addEventListener("click", () => { graph.zoomBy(1 / 1.2); scheduleSave(); });

    $("btn-theme").addEventListener("click", () => applyTheme(!isDark()));
    $("btn-help").addEventListener("click", () => $("help-dialog").showModal());

    // The tab label follows the name as it is typed; blur tidies an empty name.
    $("input-name").addEventListener("input", () => {
      doc().automaton.name = $("input-name").value.trim() || DEFAULT_DOCUMENT_NAME;
      renderDocTabs();
      scheduleSave();
    });
    $("input-name").addEventListener("change", () => {
      $("input-name").value = doc().automaton.name;
    });

    document.addEventListener("keydown", (e) => {
      // Shortcuts act on the canvas; leave them alone while a modal is open.
      if (document.querySelector("dialog[open]")) return;
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        undo();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
        e.preventDefault();
        redo();
      } else if (!typing && doc().sim.result && e.key === "ArrowLeft") {
        stopAuto();
        goToStep(doc().sim.index - 1);
      } else if (!typing && doc().sim.result && e.key === "ArrowRight") {
        stopAuto();
        goToStep(doc().sim.index + 1);
      }
    });

    window.addEventListener("resize", () => {
      // Keep the diagram usable when the layout reflows.
      if (doc().automaton.states.length) graph.applyTransform();
    });
  }

  /* ---------------------------------------------------------------- */
  /* Boot                                                              */
  /* ---------------------------------------------------------------- */

  function init() {
    graph = new GraphView($("canvas"), {
      // Positions are mutated in place by the view; just persist them.
      onStateMoved: () => scheduleSave(),
      onStateSelected: (state) => {
        sel().state = state;
        refresh();
      },
      onStateDoubleClick: (state) => toggleAccept(state),
    });

    initTabs();
    initExamples();
    initEvents();
    initImportDialog();
    initDocTabs();
    initTheme();

    // Restore the tabs from the last visit; on a first visit (or if the stored
    // data is unreadable) open on a worked example rather than an empty canvas.
    documents = loadStoredDocuments() || new DocumentList();
    if (!documents.documents.length) documents.add(Automaton.fromJSON(EXAMPLES[FIRST_RUN_EXAMPLE]));
    showDocument();

    window.addEventListener("pagehide", saveNow);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") saveNow();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
