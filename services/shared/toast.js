// ─────────────────────────────────────────────────────────────────────────────
//  Shared toast notification
//
//  Same logic as the original showToast() in both apps (byte-identical there),
//  wrapped in a tiny factory so it takes the toast element as a parameter
//  instead of assuming a module-level global. Call once per page:
//    const showToast = createToast(document.getElementById('toast'));
//    showToast('Saved');
// ─────────────────────────────────────────────────────────────────────────────

export function createToast(toastEl) {
  let toastTimer;
  return function showToast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2500);
  };
}
