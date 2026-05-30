// Returns true when a keyboard event's target is inside an editable surface
// (form input, textarea, select, contenteditable region, or a custom rich-text
// editor that opts in via [data-editable="true"]). Global keyboard shortcuts
// must call this guard before firing so plain letters like F or N never get
// hijacked while users are typing in task titles, search boxes, comments,
// docs, modals, etc.
export function isEditableTarget(target) {
  if (!target) return false;

  // contenteditable propagates from a parent — `isContentEditable` reads it
  // for the element under the cursor regardless of which child fired.
  if (target.isContentEditable) return true;

  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;

  // Opt-in marker for custom rich-text / cell editors that don't use a
  // native input or contenteditable (e.g. <div role="textbox">).
  if (typeof target.closest === 'function') {
    if (target.closest('[data-editable="true"]')) return true;
    if (target.closest('[role="textbox"]')) return true;
    if (target.closest('[contenteditable="true"]')) return true;
  }

  return false;
}

export default isEditableTarget;
