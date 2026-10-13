// On small screens, navigation opens over the page instead of taking its space.
export function initializeSidebar() {
  const sidebar = document.getElementById("sidebar");
  const workspace = document.getElementById("workspace");
  const toggle = document.getElementById("sidebarToggle");
  const close = document.getElementById("sidebarClose");
  const backdrop = document.getElementById("sidebarBackdrop");
  const mobile = window.matchMedia("(max-width: 800px)");
  let open = false;

  function setOpen(next, restoreFocus = true) {
    const wasOpen = open;
    open = mobile.matches && next;
    document.body.classList.toggle("sidebar-open", open);
    toggle.setAttribute("aria-expanded", String(open));
    backdrop.hidden = !open;
    workspace.inert = open;
    if (!open && restoreFocus && mobile.matches && wasOpen) toggle.focus();
    sidebar.inert = mobile.matches && !open;
    if (mobile.matches) {
      sidebar.setAttribute("aria-hidden", String(!open));
      sidebar.setAttribute("role", "dialog");
      if (open) sidebar.setAttribute("aria-modal", "true");
      else sidebar.removeAttribute("aria-modal");
    } else {
      sidebar.removeAttribute("aria-hidden");
      sidebar.removeAttribute("role");
      sidebar.removeAttribute("aria-modal");
    }
    if (open) close.focus();
  }

  toggle.addEventListener("click", () => setOpen(!open));
  close.addEventListener("click", () => setOpen(false));
  backdrop.addEventListener("click", () => setOpen(false));
  sidebar.addEventListener("click", (event) => {
    if (event.target.closest("a[href^='#']")) setOpen(false);
  });
  document.addEventListener("keydown", (event) => {
    if (!open) return;
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
    } else if (event.key === "Tab") {
      const controls = [...sidebar.querySelectorAll("a[href], button, input, select, textarea, summary, [tabindex='0']")]
        .filter((element) => !element.disabled && element.getClientRects().length);
      const first = controls[0];
      const last = controls.at(-1);
      if (!first) {
        event.preventDefault();
        sidebar.focus();
      } else if (event.shiftKey && (document.activeElement === first || document.activeElement === sidebar)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  });
  mobile.addEventListener("change", () => {
    const focusInSidebar = sidebar.contains(document.activeElement);
    if (mobile.matches && focusInSidebar) toggle.focus();
    setOpen(false, false);
  });
  setOpen(false, false);
}
