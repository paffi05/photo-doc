export function initSidebarLayout({
  appView,
  openBtn,
  closeBtn,
  overlay,
  panel,
  addPatientBtn,
  onPatientSidebarHiddenChange,
}) {
  const COMPACT_PATIENT_SIDEBAR_MAX_WIDTH = 900;

  let patientSidebarHideTimerId = null;
  let spacingAnimationFrameId = null;
  let isPatientSidebarHidden = false;

  function openSettings() {
    appView?.classList.add("settings-open");
    panel?.setAttribute("aria-hidden", "false");
  }

  function closeSettings() {
    appView?.classList.remove("settings-open");
    panel?.setAttribute("aria-hidden", "true");
  }

  function isSettingsOpen() {
    return appView?.classList.contains("settings-open") ?? false;
  }

  function isCompactPatientSidebarMode() {
    return window.innerWidth <= COMPACT_PATIENT_SIDEBAR_MAX_WIDTH;
  }

  function setPatientSidebarHidden(hidden) {
    if (!appView) return;
    const effectiveHidden = isCompactPatientSidebarMode() ? hidden : false;
    if (isPatientSidebarHidden === effectiveHidden) return;
    isPatientSidebarHidden = effectiveHidden;
    appView.classList.toggle("patient-sidebar-hidden", effectiveHidden);
    updateTopButtonSpacing();
    // Keep correcting while the sidebar is animating so the + button never goes under gear.
    if (spacingAnimationFrameId !== null) {
      cancelAnimationFrame(spacingAnimationFrameId);
      spacingAnimationFrameId = null;
    }
    const startTs = performance.now();
    const trackSpacing = (now) => {
      updateTopButtonSpacing();
      if (now - startTs < 360) {
        spacingAnimationFrameId = requestAnimationFrame(trackSpacing);
      } else {
        spacingAnimationFrameId = null;
      }
    };
    spacingAnimationFrameId = requestAnimationFrame(trackSpacing);
    if (typeof onPatientSidebarHiddenChange === "function") {
      onPatientSidebarHiddenChange(effectiveHidden);
    }
  }

  function applyPatientSidebarMode() {
    if (!appView) return;
    const compact = isCompactPatientSidebarMode();
    appView.classList.toggle("compact-sidebar", compact);
    if (!compact) setPatientSidebarHidden(false);
  }

  function scheduleAutoHidePatientSidebar() {
    clearAutoHidePatientSidebar();
    if (!isCompactPatientSidebarMode() || appView?.hidden) return;
    patientSidebarHideTimerId = setTimeout(() => {
      setPatientSidebarHidden(true);
      patientSidebarHideTimerId = null;
    }, 500);
  }

  function clearAutoHidePatientSidebar() {
    if (patientSidebarHideTimerId !== null) {
      clearTimeout(patientSidebarHideTimerId);
      patientSidebarHideTimerId = null;
    }
  }

  function updateTopButtonSpacing() {
    if (!openBtn || !addPatientBtn || appView?.hidden) return;

    addPatientBtn.style.marginRight = "";

    const gearRect = openBtn.getBoundingClientRect();
    const addRect = addPatientBtn.getBoundingClientRect();

    const verticallyOverlapping = addRect.bottom > gearRect.top && addRect.top < gearRect.bottom;
    if (!verticallyOverlapping) {
      addPatientBtn.style.marginRight = "";
      return;
    }

    const minGap = 5;
    const shiftNeeded = addRect.right - (gearRect.left - minGap);
    addPatientBtn.style.marginRight = shiftNeeded > 0 ? `${Math.ceil(shiftNeeded)}px` : "";
  }

  openBtn?.addEventListener("click", () => (isSettingsOpen() ? closeSettings() : openSettings()));
  closeBtn?.addEventListener("click", closeSettings);
  overlay?.addEventListener("click", closeSettings);

  return {
    openSettings,
    closeSettings,
    isSettingsOpen,
    isCompactPatientSidebarMode,
    isPatientSidebarHidden: () => isPatientSidebarHidden,
    setPatientSidebarHidden,
    applyPatientSidebarMode,
    scheduleAutoHidePatientSidebar,
    clearAutoHidePatientSidebar,
    updateTopButtonSpacing,
  };
}
