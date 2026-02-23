import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import confetti from "canvas-confetti";
import { initSidebarLayout } from "./sidebar-layout";
import { initMainContent } from "./main-content";

// ---------- DOM ----------
const onboardingView = document.getElementById("onboardingView");
const appView = document.getElementById("appView");

const pickBtn = document.getElementById("pickWorkspaceBtn");
const pickIcon = document.getElementById("pickWorkspaceIcon");

const openBtn = document.getElementById("openSettings");
const closeBtn = document.getElementById("closeSettings");
const overlay = document.getElementById("overlay");
const panel = document.getElementById("settingsPanel");
const addPatientBtn = document.getElementById("addPatientBtn");

const changeWorkspaceBtn = document.getElementById("changeWorkspaceBtn");
const workspacePathEl = document.getElementById("workspacePath");
const folderIconContainer = document.getElementById("folderIconContainer");
const debugBadge = document.getElementById("debugBadge");
const debugWindowBadge = document.getElementById("debugWindowBadge");
const showFrontendDebugToggle = document.getElementById("showFrontendDebug");
const alwaysShowTimelineNamesToggle = document.getElementById("alwaysShowTimelineNames");
const deleteWorkspaceBtn = document.getElementById("deleteWorkspaceBtn");
const deleteWorkspaceRow = document.getElementById("deleteWorkspaceRow");
const patientSearchInput = document.getElementById("patientSearchInput");
const patientList = document.getElementById("patientList");
const addPatientForm = document.getElementById("addPatientForm");
const newPatientLastName = document.getElementById("newPatientLastName");
const newPatientFirstName = document.getElementById("newPatientFirstName");
const newPatientId = document.getElementById("newPatientId");
const confirmAddPatientBtn = document.getElementById("confirmAddPatientBtn");
const dbStatusText = document.getElementById("dbStatusText");
const dbStatusTime = document.getElementById("dbStatusTime");
const dbStatusSpinner = document.getElementById("dbStatusSpinner");
const dbReloadBtn = document.getElementById("dbReloadBtn");

function setDebugState(state) {
  if (!debugBadge) return;
  debugBadge.textContent = `debug: (${state})`;
}

function ts() {
  return new Date().toISOString();
}

let transitionTimeoutId = null;
let transitionStartedAt = null;
let currentWorkspaceDir = null;
let patientSearchDebounceId = null;
let isDbUpdating = false;
let selectedPatient = null;
let selectedPatientId = "";
let addPatientIdTaken = false;
let addPatientIdChecking = false;
let addPatientIdCheckToken = 0;
const importingPatients = new Set();
let lastRenderedPatientEntries = [];
let lastRenderedFilterText = "";

const DEBUG_PREF_KEY = "showFrontendDebug";
const TIMELINE_NAMES_PREF_KEY = "alwaysShowTimelineNames";
const sidebarLayout = initSidebarLayout({
  appView,
  openBtn,
  closeBtn,
  overlay,
  panel,
  addPatientBtn,
  onPatientSidebarHiddenChange: (hidden) => {
    if (hidden) {
      setAddPatientFormVisible(false);
      return;
    }
    setAddPatientFormVisible(false);
  },
});
const mainContent = initMainContent({
  appView,
  onDropOverlayWillShow: () => {
    if (sidebarLayout.isSettingsOpen()) {
      sidebarLayout.closeSettings();
    }
    if (selectedPatient && sidebarLayout.isCompactPatientSidebarMode()) {
      sidebarLayout.setPatientSidebarHidden(true);
    }
  },
  resolveImportContext: () => ({
    workspaceDir: currentWorkspaceDir,
    patientFolder: selectedPatient,
  }),
  onImportActivityChange: ({ patientFolder, active }) => {
    if (!patientFolder) return;
    if (active) {
      importingPatients.add(patientFolder);
    } else {
      importingPatients.delete(patientFolder);
    }
    renderPatientList(lastRenderedPatientEntries, lastRenderedFilterText);
  },
  onCheckMissingPatientIdTaken: async (patientId) => {
    if (!currentWorkspaceDir) return false;
    const normalizedId = normalizePatientFieldValue(patientId);
    if (!normalizedId || !isNumericPatientId(normalizedId)) return false;
    return isPatientIdTaken(normalizedId, { excludeFolderName: selectedPatient });
  },
  onSubmitMissingPatientId: async (patientId) => {
    if (!currentWorkspaceDir || !selectedPatient) {
      throw new Error("no selected patient");
    }

    const normalizedId = normalizePatientFieldValue(patientId);
    if (!normalizedId || !isNumericPatientId(normalizedId)) {
      throw new Error("id must be numeric");
    }

    const targetFolder = selectedPatient;
    await invoke("save_patient_id", {
      workspaceDir: currentWorkspaceDir,
      folderName: targetFolder,
      id: normalizedId,
    });

    const { lastName, firstName } = splitPatientName(targetFolder);
    selectedPatientId = normalizedId;
    mainContent.setSelectedPatientHeader({ lastName, firstName, patientId: normalizedId });
    await searchPatients(patientSearchInput?.value ?? "");
    return normalizedId;
  },
});

function setDebugVisibility(show) {
  if (!debugBadge) return;
  debugBadge.hidden = !show;
  if (debugWindowBadge) debugWindowBadge.hidden = !show;
}

function updateWindowDebugSize() {
  if (!debugWindowBadge) return;
  debugWindowBadge.textContent = `window: ${window.innerWidth}x${window.innerHeight}`;
}

function setDeleteWorkspaceAvailability(enabled) {
  if (deleteWorkspaceBtn) deleteWorkspaceBtn.disabled = !enabled;
  deleteWorkspaceRow?.classList.toggle("inactive", !enabled);
}

function readDebugVisibilityPref() {
  try {
    const raw = localStorage.getItem(DEBUG_PREF_KEY);
    if (raw === null) return true;
    return raw === "true";
  } catch {
    return true;
  }
}

function writeDebugVisibilityPref(show) {
  try {
    localStorage.setItem(DEBUG_PREF_KEY, String(show));
  } catch {
    // Ignore storage failures and keep runtime behavior.
  }
}

function setTimelineNamesAlwaysVisible(enabled) {
  appView?.classList.toggle("timeline-names-always-visible", enabled);
}

function readTimelineNamesPref() {
  try {
    const raw = localStorage.getItem(TIMELINE_NAMES_PREF_KEY);
    if (raw === null) return false;
    return raw === "true";
  } catch {
    return false;
  }
}

function writeTimelineNamesPref(enabled) {
  try {
    localStorage.setItem(TIMELINE_NAMES_PREF_KEY, String(enabled));
  } catch {
    // Ignore storage failures and keep runtime behavior.
  }
}

function initTimelineNamesSetting() {
  const enabled = readTimelineNamesPref();
  setTimelineNamesAlwaysVisible(enabled);
  if (alwaysShowTimelineNamesToggle) {
    alwaysShowTimelineNamesToggle.checked = enabled;
  }
}

function initDebugVisibilitySetting() {
  const show = readDebugVisibilityPref();
  setDebugVisibility(show);
  setDeleteWorkspaceAvailability(show);
  if (showFrontendDebugToggle) showFrontendDebugToggle.checked = show;
}

function formatDateTime(date) {
  return date.toLocaleString();
}

function setDbStatusUpdating() {
  isDbUpdating = true;
  if (dbStatusText) dbStatusText.textContent = "updating...";
  if (dbStatusSpinner) dbStatusSpinner.hidden = false;
  if (dbReloadBtn) dbReloadBtn.disabled = true;
}

function setDbStatusUpToDate(date = new Date()) {
  isDbUpdating = false;
  if (dbStatusText) dbStatusText.textContent = "Up to date";
  if (dbStatusTime) dbStatusTime.textContent = formatDateTime(date);
  if (dbStatusSpinner) dbStatusSpinner.hidden = true;
  if (dbReloadBtn) dbReloadBtn.disabled = !currentWorkspaceDir;
}

function setDbStatusIdle() {
  isDbUpdating = false;
  if (dbStatusText) dbStatusText.textContent = "Up to date";
  if (dbStatusTime) dbStatusTime.textContent = "never updated";
  if (dbStatusSpinner) dbStatusSpinner.hidden = true;
  if (dbReloadBtn) dbReloadBtn.disabled = true;
}

function splitPatientName(folderName) {
  const idx = folderName.indexOf(",");
  if (idx === -1) {
    return { lastName: folderName.trim(), firstName: "" };
  }
  return {
    lastName: folderName.slice(0, idx).trim(),
    firstName: folderName.slice(idx + 1).trim(),
  };
}

function normalizePatientEntry(entry) {
  if (typeof entry === "string") {
    return { folderName: entry, patientId: "" };
  }

  const folderName =
    (entry?.folder_name ?? entry?.folderName ?? "").toString();
  const patientId =
    (entry?.patient_id ?? entry?.patientId ?? "").toString().trim();

  return { folderName, patientId };
}

function setWorkspacePathDisplay(workspaceDir) {
  if (!workspacePathEl) return;
  if (!workspaceDir) {
    workspacePathEl.textContent = "(not set)";
    workspacePathEl.title = "";
    return;
  }
  workspacePathEl.textContent = `...${workspaceDir}`;
  workspacePathEl.title = workspaceDir;
}

function normalizePatientFieldValue(value) {
  return (value ?? "").trim();
}

function isNumericPatientId(value) {
  return /^\d+$/.test(value);
}

async function isPatientIdTaken(patientId, { excludeFolderName = null } = {}) {
  if (!currentWorkspaceDir) return false;
  const normalizedId = normalizePatientFieldValue(patientId);
  if (!normalizedId) return false;

  try {
    return await invoke("is_patient_id_taken", {
      workspaceDir: currentWorkspaceDir,
      patientId: normalizedId,
      excludeFolderName: excludeFolderName ?? null,
    });
  } catch (err) {
    console.error("is_patient_id_taken failed:", err);
    return false;
  }
}

function isAddPatientFormValid() {
  const patientId = normalizePatientFieldValue(newPatientId?.value);
  return Boolean(
    normalizePatientFieldValue(newPatientLastName?.value) &&
    normalizePatientFieldValue(newPatientFirstName?.value) &&
    patientId &&
    isNumericPatientId(patientId)
  );
}

function updateAddPatientFormState() {
  const patientId = normalizePatientFieldValue(newPatientId?.value);
  const hasInvalidId = Boolean(patientId) && !isNumericPatientId(patientId);
  const hasDuplicateId = Boolean(patientId) && isNumericPatientId(patientId) && addPatientIdTaken;
  newPatientId?.classList.toggle("invalid-id", hasInvalidId);
  newPatientId?.classList.toggle("duplicate-id", hasDuplicateId);
  if (!confirmAddPatientBtn) return;
  confirmAddPatientBtn.disabled = !isAddPatientFormValid() || hasDuplicateId || addPatientIdChecking;
}

async function checkAddPatientIdUniqueness() {
  const token = ++addPatientIdCheckToken;
  const patientId = normalizePatientFieldValue(newPatientId?.value);

  addPatientIdTaken = false;
  addPatientIdChecking = false;
  if (!patientId || !isNumericPatientId(patientId) || !currentWorkspaceDir) {
    updateAddPatientFormState();
    return;
  }

  addPatientIdChecking = true;
  updateAddPatientFormState();
  const taken = await isPatientIdTaken(patientId);
  if (token !== addPatientIdCheckToken) return;

  addPatientIdTaken = Boolean(taken);
  addPatientIdChecking = false;
  updateAddPatientFormState();
}

function resetAddPatientForm() {
  addPatientIdCheckToken += 1;
  addPatientIdTaken = false;
  addPatientIdChecking = false;
  if (newPatientLastName) newPatientLastName.value = "";
  if (newPatientFirstName) newPatientFirstName.value = "";
  if (newPatientId) newPatientId.value = "";
  newPatientId?.classList.remove("duplicate-id");
  updateAddPatientFormState();
}

function setAddPatientFormVisible(visible) {
  if (!addPatientForm) return;
  addPatientForm.hidden = !visible;
  addPatientBtn?.classList.toggle("active", visible);
  if (visible) {
    updateAddPatientFormState();
    void checkAddPatientIdUniqueness();
    newPatientLastName?.focus();
  }
}

function renderPatientList(entries, filterText = "") {
  if (!patientList) return;
  lastRenderedPatientEntries = entries;
  lastRenderedFilterText = filterText;

  patientList.innerHTML = "";

  if (entries.length === 0) {
    const empty = document.createElement("li");
    empty.className = "patient-empty";
    empty.textContent = filterText ? "No patients match your search." : "No patient folders found.";
    patientList.appendChild(empty);
    return;
  }

  for (const entry of entries) {
    const { folderName, patientId } = normalizePatientEntry(entry);
    if (!folderName) continue;
    const { lastName, firstName } = splitPatientName(folderName);
    const item = document.createElement("li");
    item.className = "patient-item";
    if (folderName === selectedPatient) {
      item.classList.add("selected");
    }

    if (importingPatients.has(folderName)) {
      const importSpinner = document.createElement("span");
      importSpinner.className = "patient-import-spinner";
      importSpinner.setAttribute("aria-hidden", "true");
      item.appendChild(importSpinner);
    }

    const last = document.createElement("span");
    last.className = "patient-last";
    last.textContent = lastName || folderName;
    item.appendChild(last);

    if (firstName) {
      const first = document.createElement("span");
      first.className = "patient-first";
      first.textContent = `, ${firstName}`;
      item.appendChild(first);
    }

    if (patientId) {
      const id = document.createElement("span");
      id.className = "patient-id";
      id.textContent = patientId;
      item.appendChild(id);
    }

    item.addEventListener("click", () => {
      selectedPatient = folderName;
      selectedPatientId = patientId;
      mainContent.setSelectedPatientHeader({ lastName, firstName, patientId });
      renderPatientList(entries, filterText);
      sidebarLayout.scheduleAutoHidePatientSidebar();
    });

    patientList.appendChild(item);
  }
}

async function searchPatients(query = "") {
  if (!currentWorkspaceDir) {
    renderPatientList([], query.trim());
    return;
  }

  try {
    const patients = await invoke("search_patients", {
      workspaceDir: currentWorkspaceDir,
      query,
    });
    const entries = Array.isArray(patients) ? patients : [];
    renderPatientList(entries, query.trim());
  } catch (err) {
    console.error("search_patients failed:", err);
    renderPatientList([], query.trim());
  }
}

async function loadPatients(workspaceDir, options = {}) {
  const minStatusMs = options?.minStatusMs ?? 0;
  currentWorkspaceDir = workspaceDir;
  const query = patientSearchInput?.value ?? "";
  setDbStatusUpdating();
  const startedAt = Date.now();
  let reindexFailed = false;

  try {
    const indexedCount = await invoke("reindex_patient_folders", { workspaceDir });
    console.log(`[patients ${ts()}] indexed ${indexedCount} folders`);
  } catch (err) {
    console.error("reindex_patient_folders failed:", err);
    reindexFailed = true;
  }

  const elapsedMs = Date.now() - startedAt;
  const remainingMs = minStatusMs - elapsedMs;
  if (remainingMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, remainingMs));
  }

  if (reindexFailed) {
    isDbUpdating = false;
    if (dbStatusText) dbStatusText.textContent = "Up to date";
    if (dbStatusTime) dbStatusTime.textContent = "update failed";
    if (dbStatusSpinner) dbStatusSpinner.hidden = true;
    if (dbReloadBtn) dbReloadBtn.disabled = !currentWorkspaceDir;
  } else {
    setDbStatusUpToDate(new Date());
  }

  await searchPatients(query);
  await mainContent.refreshTimelineForSelection();
}

function clearPatients() {
  currentWorkspaceDir = null;
  selectedPatient = null;
  selectedPatientId = "";
  importingPatients.clear();
  sidebarLayout.clearAutoHidePatientSidebar();
  sidebarLayout.setPatientSidebarHidden(false);
  if (patientSearchDebounceId !== null) {
    clearTimeout(patientSearchDebounceId);
    patientSearchDebounceId = null;
  }
  if (patientSearchInput) patientSearchInput.value = "";
  setAddPatientFormVisible(false);
  resetAddPatientForm();
  mainContent.clearSelectedPatientHeader();
  renderPatientList([], "");
  setDbStatusIdle();
}

function showMainScreen(workspaceDir) {
  console.log(`[transition ${ts()}] showing main screen`);
  onboardingView.hidden = true;
  appView.hidden = false;
  sidebarLayout.applyPatientSidebarMode();
  sidebarLayout.setPatientSidebarHidden(false);
  setWorkspacePathDisplay(workspaceDir);
  loadPatients(workspaceDir);
  requestAnimationFrame(sidebarLayout.updateTopButtonSpacing);
  console.log(
    `[transition ${ts()}] view flags onboarding.hidden=${onboardingView.hidden} app.hidden=${appView.hidden}`
  );
}

// ---------- Folder -> Checkmark ----------
function replaceFolderWithCheckmark() {
  if (!folderIconContainer) return;

  folderIconContainer.innerHTML = `
    <svg class="checkmark-svg" viewBox="0 0 240 240" fill="none" xmlns="http://www.w3.org/2000/svg">
      <!-- Glow circle -->
      <circle cx="120" cy="120" r="96" fill="#10b981" class="glow"/>
      
      <!-- Ring -->
      <circle class="circle" cx="120" cy="120" r="96" fill="none"
              stroke="#10b981" stroke-width="19" stroke-miterlimit="10"/>
      
      <!-- Checkmark -->
      <path class="check" d="M75 120 L105 155 L165 85" fill="none"
            stroke="#ffffff" stroke-width="18" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  `;
}

function restoreOnboardingFolderIcon() {
  if (!folderIconContainer) return;

  folderIconContainer.innerHTML = `
    <svg id="folderSvg" width="130" height="130" viewBox="0 0 100 100" fill="none">
      <path d="M10 30C10 26.6863 12.6863 24 16 24H35L42 32H84C87.3137 32 90 34.6863 90 38V74C90 77.3137 87.3137 80 84 80H16C12.6863 80 10 77.3137 10 74V30Z" fill="var(--folder-back)"/>
      <g class="folder-front">
        <path d="M10 40C10 36.6863 12.6863 34 16 34H84C87.3137 34 90 36.6863 90 40V74C90 77.3137 87.3137 80 84 80H16C12.6863 80 10 77.3137 10 74V40Z" fill="var(--folder-front)"/>
        <circle cx="50" cy="57" r="8" fill="white" fill-opacity="0.5"/>
        <rect x="49.2" y="53" width="1.6" height="8" rx="0.8" fill="white"/>
        <rect x="46" y="56.2" width="8" height="1.6" rx="0.8" fill="white"/>
      </g>
    </svg>
  `;
}

// Confetti burst from the folder/checkmark position (subtle)
function burstConfettiFromFolder() {
  const el = document.getElementById("pickWorkspaceIcon");
  if (!el) return;

  const r = el.getBoundingClientRect();
  const x = (r.left + r.width / 2) / window.innerWidth;
  const y = (r.top + r.height / 2) / window.innerHeight;

  // first small burst
  setTimeout(() => {
    confetti({
      particleCount: 35,
      startVelocity: 12,
      spread: 30,
      origin: { x, y },
      colors: ["#10b981", "#34d399", "#ffffff", "#fef08a"],
      ticks: 80,
      gravity: 1.2,
      decay: 0.96,
      scalar: 0.7,
    });

    // tiny side bursts
    setTimeout(() => {
      confetti({
        particleCount: 15,
        angle: 75,
        spread: 20,
        origin: { x, y },
        colors: ["#10b981", "#34d399"],
        ticks: 70,
        scalar: 0.65,
      });
      confetti({
        particleCount: 15,
        angle: 105,
        spread: 20,
        origin: { x, y },
        colors: ["#ffffff", "#fef08a"],
        ticks: 70,
        scalar: 0.65,
      });
    }, 100);
  }, 420);
}


// ---------- Workspace pick ----------
async function pickWorkspaceAndSave() {
  setDebugState("picking workspace");
  try {
    const isAlreadyInMainView = !appView.hidden;
    const dir = await open({
      directory: true,
      multiple: false,
      title: "Select Workspace",
    });

    if (!dir) {
      setDebugState("workspace pick cancelled");
      return;
    }

    const workspaceDir = Array.isArray(dir) ? dir[0] : dir;
    if (!workspaceDir) {
      setDebugState("workspace pick invalid");
      return;
    }

    await invoke("save_workspace", { workspaceDir });
    setDebugState("workspace saved");

    if (isAlreadyInMainView) {
      setWorkspacePathDisplay(workspaceDir);
      loadPatients(workspaceDir);
      setDebugState("ready");
      console.log(`[transition ${ts()}] workspace updated in main view (no transition timer)`);
      return;
    }

    // ONLY change the folder icon -> checkmark animation
    replaceFolderWithCheckmark();
    console.log(`[transition ${ts()}] checkmark icon applied`);
    burstConfettiFromFolder();

    // After the animation, switch to main screen
    const transitionDelayMs = 2000;
    const dueAt = Date.now() + transitionDelayMs;
    if (transitionTimeoutId !== null) clearTimeout(transitionTimeoutId);
    transitionStartedAt = Date.now();
    setDebugState("transitioning (2.0s)");
    console.log(
      `[transition ${ts()}] timer started (${transitionDelayMs}ms), due=${new Date(dueAt).toISOString()}`
    );
    transitionTimeoutId = setTimeout(() => {
      const elapsedMs = transitionStartedAt ? Date.now() - transitionStartedAt : -1;
      console.log(`[transition ${ts()}] timer fired after ${elapsedMs}ms, switching to main screen`);
      showMainScreen(workspaceDir);
      setDebugState("ready");
      transitionTimeoutId = null;
      transitionStartedAt = null;
    }, transitionDelayMs);
  } catch (err) {
    console.error("Failed to open folder dialog:", err);
    setDebugState("error: save workspace");
  }
}

// ---------- Boot ----------
async function boot() {
  setDebugState("booting");
  onboardingView.hidden = false;
  appView.hidden = true;

  try {
    const settings = await invoke("load_settings");

    console.log("Loaded settings:", settings);

    const workspaceDir =
      settings?.workspace_dir ??
      settings?.workspaceDir ??
      null;
    console.log("workspaceDir:", workspaceDir);

    if (!workspaceDir) {
      onboardingView.hidden = false;
      appView.hidden = true;
      restoreOnboardingFolderIcon();
      clearPatients();
      setDebugState("no workspace");
      return;
    }

    showMainScreen(workspaceDir);
    setDebugState("ready");

  } catch (err) {
    console.error("load_settings failed:", err);
    setDebugState("error: load settings");
  }
}

// ---------- Events ----------
pickBtn?.addEventListener("click", pickWorkspaceAndSave);
pickIcon?.addEventListener("click", pickWorkspaceAndSave);

changeWorkspaceBtn?.addEventListener("click", pickWorkspaceAndSave);
showFrontendDebugToggle?.addEventListener("change", (e) => {
  const show = Boolean(e.target?.checked);
  setDebugVisibility(show);
  setDeleteWorkspaceAvailability(show);
  writeDebugVisibilityPref(show);
});
alwaysShowTimelineNamesToggle?.addEventListener("change", (e) => {
  const enabled = Boolean(e.target?.checked);
  setTimelineNamesAlwaysVisible(enabled);
  writeTimelineNamesPref(enabled);
});
deleteWorkspaceBtn?.addEventListener("click", async () => {
  if (deleteWorkspaceBtn.disabled) return;
  try {
    await invoke("clear_workspace");
    setWorkspacePathDisplay(null);
    sidebarLayout.closeSettings();
    restoreOnboardingFolderIcon();
    onboardingView.hidden = false;
    appView.hidden = true;
    clearPatients();
    setDebugState("no workspace");
    console.log(`[transition ${ts()}] workspace cleared via debug action`);
  } catch (err) {
    console.error("clear_workspace failed:", err);
    setDebugState("error: clear workspace");
  }
});
dbReloadBtn?.addEventListener("click", async () => {
  if (!currentWorkspaceDir || isDbUpdating) return;
  await loadPatients(currentWorkspaceDir, { minStatusMs: 1500 });
});
addPatientBtn?.addEventListener("click", () => {
  if (sidebarLayout.isCompactPatientSidebarMode() && sidebarLayout.isPatientSidebarHidden()) {
    sidebarLayout.setPatientSidebarHidden(false);
    return;
  }
  setAddPatientFormVisible(addPatientForm?.hidden ?? true);
});
confirmAddPatientBtn?.addEventListener("click", async () => {
  if (!currentWorkspaceDir || !isAddPatientFormValid() || confirmAddPatientBtn.disabled) return;
  const lastName = normalizePatientFieldValue(newPatientLastName?.value);
  const firstName = normalizePatientFieldValue(newPatientFirstName?.value);
  const patientId = normalizePatientFieldValue(newPatientId?.value);

  if (await isPatientIdTaken(patientId)) {
    addPatientIdTaken = true;
    addPatientIdChecking = false;
    updateAddPatientFormState();
    return;
  }

  confirmAddPatientBtn.disabled = true;
  try {
    await invoke("create_patient_with_metadata", {
      workspaceDir: currentWorkspaceDir,
      lastName,
      firstName,
      patientId,
    });
    setAddPatientFormVisible(false);
    resetAddPatientForm();
    if (patientSearchDebounceId !== null) {
      clearTimeout(patientSearchDebounceId);
      patientSearchDebounceId = null;
    }
    if (patientSearchInput) patientSearchInput.value = "";
    selectedPatient = `${lastName}, ${firstName}`;
    selectedPatientId = patientId;
    mainContent.setSelectedPatientHeader({ lastName, firstName, patientId });
    await loadPatients(currentWorkspaceDir);
  } catch (err) {
    console.error("create_patient_with_metadata failed:", err);
    setDebugState("error: create patient");
    updateAddPatientFormState();
  }
});
workspacePathEl?.addEventListener("click", async () => {
  if (!currentWorkspaceDir) return;
  try {
    await invoke("open_workspace_dir", { workspaceDir: currentWorkspaceDir });
  } catch (err) {
    console.error("open_workspace_dir failed:", err);
  }
});

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && sidebarLayout.isSettingsOpen()) sidebarLayout.closeSettings();
});
window.addEventListener("resize", updateWindowDebugSize);
window.addEventListener("resize", () => {
  sidebarLayout.applyPatientSidebarMode();
  if (selectedPatient && sidebarLayout.isCompactPatientSidebarMode()) {
    sidebarLayout.setPatientSidebarHidden(true);
  }
  sidebarLayout.updateTopButtonSpacing();
});
patientSearchInput?.addEventListener("input", (e) => {
  const query = e.target?.value ?? "";
  if (patientSearchDebounceId !== null) clearTimeout(patientSearchDebounceId);
  patientSearchDebounceId = setTimeout(() => {
    searchPatients(query);
  }, 120);
});
[newPatientLastName, newPatientFirstName, newPatientId].forEach((el) => {
  el?.addEventListener("input", updateAddPatientFormState);
  el?.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    if (!confirmAddPatientBtn || confirmAddPatientBtn.disabled) return;
    e.preventDefault();
    confirmAddPatientBtn.click();
  });
});
newPatientId?.addEventListener("input", () => {
  void checkAddPatientIdUniqueness();
});

initDebugVisibilitySetting();
initTimelineNamesSetting();
setDbStatusIdle();
updateWindowDebugSize();
sidebarLayout.applyPatientSidebarMode();
sidebarLayout.updateTopButtonSpacing();
updateAddPatientFormState();
renderPatientList([], "");
boot();
