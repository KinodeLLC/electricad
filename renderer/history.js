// Undo/redo for the wiring canvas: a bounded stack of model snapshots.
// Pure logic, UMD so tests run it in node. Snapshots are deep JSON clones —
// the model is plain data, so structural sharing is not worth the bugs.
(function (root) {
  function makeHistory(cap = 100) {
    let undo = [];
    let redo = [];
    const clone = (m) => JSON.parse(JSON.stringify(m));
    return {
      // call BEFORE mutating: remembers the pre-change state
      push(model) {
        undo.push(clone(model));
        if (undo.length > cap) undo.shift();
        redo = [];
      },
      undo(current) {
        if (!undo.length) return null;
        redo.push(clone(current));
        return undo.pop();
      },
      redo(current) {
        if (!redo.length) return null;
        undo.push(clone(current));
        return redo.pop();
      },
      canUndo: () => undo.length > 0,
      canRedo: () => redo.length > 0,
      clear() { undo = []; redo = []; }
    };
  }
  const api = { makeHistory };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PinodeHistory = api;
})(typeof window !== 'undefined' ? window : globalThis);
