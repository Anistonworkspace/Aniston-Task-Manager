// Shared per-user department-collapse persistence for the Docs surfaces.
//
// Both the Docs home list (DocsListPage) and the in-editor right side panel
// (DocsSidePanel) group docs by the owner's department for Tier 1/2 and let
// the user collapse/expand each section. We persist that collapse state per
// user in localStorage under ONE key so a department collapsed on the home
// page stays collapsed in the editor panel and vice-versa.
//
// Stored shape:
//   { [deptName]: true }   // true = collapsed. Missing keys default to
//                          // expanded so brand-new departments start open.

export function getDocsDeptCollapseStorageKey(userId) {
  return `docsDeptCollapseState:${userId}`;
}

export function loadDeptCollapseState(userId) {
  if (!userId) return {};
  try {
    const raw = localStorage.getItem(getDocsDeptCollapseStorageKey(userId));
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function saveDeptCollapseState(userId, state) {
  if (!userId) return;
  try {
    localStorage.setItem(getDocsDeptCollapseStorageKey(userId), JSON.stringify(state));
  } catch { /* quota / privacy mode — ignore */ }
}
