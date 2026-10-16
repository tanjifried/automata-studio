/**
 * Open documents (the tabs above the canvas).
 *
 * Each document owns one automaton plus everything that belongs to editing
 * it: undo/redo stacks, the selection, the simulation run and the view
 * transform. DocumentList keeps the ordered list of documents and which one
 * is active, and knows how to persist itself to localStorage.
 *
 * Nothing here touches the DOM, so it runs (and is tested) under plain Node.
 */

const DEFAULT_DOCUMENT_NAME = "Untitled automaton";
const DOCUMENTS_STORAGE_KEY = "automatastudio-documents";
const DOCUMENTS_FORMAT_VERSION = 1;
const DOCUMENT_HISTORY_LIMIT = 60;

/** A fresh document wrapping `automaton` (a blank one when omitted). */
function createDocument(id, automaton, view) {
  return {
    id: id,
    automaton: automaton || new Automaton({ name: DEFAULT_DOCUMENT_NAME }),
    undoStack: [],
    redoStack: [],
    selection: { state: null, symbol: null },
    sim: { input: "", result: null, index: 0 },
    view: view || null, // { scale, offsetX, offsetY } or null = fit on show
  };
}

/** Blank = nothing worth keeping: no states and no undo/redo history. */
function isBlankDocument(doc) {
  return doc.automaton.states.length === 0 &&
    doc.undoStack.length === 0 &&
    doc.redoStack.length === 0;
}

/* ------------------------------------------------------------------ */
/* Per-document history                                                */
/* ------------------------------------------------------------------ */

/** Snapshot the automaton before a change. */
function pushDocumentHistory(doc) {
  doc.undoStack.push(JSON.stringify(doc.automaton.toJSON()));
  if (doc.undoStack.length > DOCUMENT_HISTORY_LIMIT) doc.undoStack.shift();
  doc.redoStack = [];
}

/** Returns true if something was undone. */
function undoDocument(doc) {
  if (!doc.undoStack.length) return false;
  doc.redoStack.push(JSON.stringify(doc.automaton.toJSON()));
  doc.automaton = Automaton.fromJSON(JSON.parse(doc.undoStack.pop()));
  return true;
}

/** Returns true if something was redone. */
function redoDocument(doc) {
  if (!doc.redoStack.length) return false;
  doc.undoStack.push(JSON.stringify(doc.automaton.toJSON()));
  doc.automaton = Automaton.fromJSON(JSON.parse(doc.redoStack.pop()));
  return true;
}

/* ------------------------------------------------------------------ */
/* The document list                                                   */
/* ------------------------------------------------------------------ */

class DocumentList {
  constructor() {
    this.documents = [];
    this.activeId = null;
    this.nextId = 1;
  }

  get active() {
    return this.find(this.activeId);
  }

  find(id) {
    return this.documents.find((d) => d.id === id) || null;
  }

  /** Append a document and make it active. */
  add(automaton, view) {
    const doc = createDocument(this.nextId++, automaton, view);
    this.documents.push(doc);
    this.activeId = doc.id;
    return doc;
  }

  activate(id) {
    if (!this.find(id)) return null;
    this.activeId = id;
    return this.active;
  }

  /**
   * Open an automaton: reuse the active document if it is blank, otherwise
   * open a new one. Either way the result is the active document.
   */
  open(automaton) {
    const current = this.active;
    if (current && isBlankDocument(current)) {
      const doc = createDocument(current.id, automaton);
      this.documents[this.documents.indexOf(current)] = doc;
      return doc;
    }
    return this.add(automaton);
  }

  /**
   * Close a document. Its right-hand neighbour (or else the left one) becomes
   * active if it was the active one; closing the last leaves one blank tab.
   */
  close(id) {
    const index = this.documents.findIndex((d) => d.id === id);
    if (index === -1) return this.active;
    this.documents.splice(index, 1);
    if (!this.documents.length) return this.add(null);
    if (this.activeId === id) {
      this.activeId = this.documents[Math.min(index, this.documents.length - 1)].id;
    }
    return this.active;
  }

  /* -------------------------- persistence ------------------------- */

  /** Plain JSON-safe snapshot: automata (with positions), views, active index. */
  serialize() {
    return {
      version: DOCUMENTS_FORMAT_VERSION,
      active: Math.max(0, this.documents.indexOf(this.active)),
      documents: this.documents.map((d) => ({
        automaton: d.automaton.toJSON(),
        view: d.view ? { scale: d.view.scale, offsetX: d.view.offsetX, offsetY: d.view.offsetY } : null,
      })),
    };
  }

  /**
   * Rebuild a list from serialize() output. Entries that cannot be read are
   * skipped; returns null when nothing usable is left.
   */
  static deserialize(data) {
    if (!data || typeof data !== "object" || !Array.isArray(data.documents)) return null;
    const list = new DocumentList();
    let activeId = null;
    data.documents.forEach((entry, i) => {
      const automaton = readStoredAutomaton(entry && entry.automaton);
      if (!automaton) return;
      const doc = list.add(automaton, readStoredView(entry.view));
      if (i === data.active) activeId = doc.id;
    });
    if (!list.documents.length) return null;
    list.activeId = activeId !== null ? activeId : list.documents[0].id;
    return list;
  }

  /** Write to a Storage-like object; returns false if it refused (quota, private mode). */
  save(storage) {
    try {
      storage.setItem(DOCUMENTS_STORAGE_KEY, JSON.stringify(this.serialize()));
      return true;
    } catch (err) {
      return false;
    }
  }

  /** Read from a Storage-like object; null when missing, unreadable or corrupt. */
  static load(storage) {
    try {
      const raw = storage.getItem(DOCUMENTS_STORAGE_KEY);
      return raw ? DocumentList.deserialize(JSON.parse(raw)) : null;
    } catch (err) {
      return null;
    }
  }
}

function readStoredAutomaton(data) {
  if (!data || typeof data !== "object" || !Array.isArray(data.states)) return null;
  try {
    const automaton = Automaton.fromJSON(data);
    automaton.validate(); // throws on structurally broken data
    return automaton;
  } catch (err) {
    return null;
  }
}

function readStoredView(view) {
  if (!view || typeof view !== "object") return null;
  const ok = [view.scale, view.offsetX, view.offsetY].every((n) => typeof n === "number" && isFinite(n));
  return ok && view.scale > 0 ? { scale: view.scale, offsetX: view.offsetX, offsetY: view.offsetY } : null;
}
