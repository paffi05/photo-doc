import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import confetti from "canvas-confetti";
import { initSidebarLayout } from "./sidebar-layout";
import { initMainContent } from "./main-content";

// ---------- DOM ----------
const onboardingView = document.getElementById("onboardingView");
const appView = document.getElementById("appView");

const pickBtn = document.getElementById("pickWorkspaceBtn");
const pickIcon = document.getElementById("pickWorkspaceIcon");
const onboardingTitle = document.getElementById("onboardingTitle");
const onboardingSubtitle = document.getElementById("onboardingSubtitle");

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
const cacheSizeSlider = document.getElementById("cacheSizeSlider");
const cacheSizeValue = document.getElementById("cacheSizeValue");
const cacheUsageBar = document.getElementById("cacheUsageBar");
const cacheUsageText = document.getElementById("cacheUsageText");
const openCacheFolderBtn = document.getElementById("openCacheFolderBtn");
const indexingWarmupSpinner = document.getElementById("indexingWarmupSpinner");
const indexingProgressSpinner = document.getElementById("indexingProgressSpinner");
const indexingProgressText = document.getElementById("indexingProgressText");
const indexingDebugCounts = document.getElementById("indexingDebugCounts");

function setDebugState(state) {
  if (!debugBadge) return;
  debugBadge.textContent = `debug: (${state})`;
}

function ts() {
  return new Date().toISOString();
}

let isWorkspaceSetupInProgress = false;
let onboardingReadyWorkspaceDir = null;
let currentWorkspaceDir = null;
let patientSearchDebounceId = null;
let isDbUpdating = false;
let isPreviewFillRunning = false;
let previewFillPollIntervalId = null;
let indexingDebugCountsInFlight = false;
let selectedPatient = null;
let selectedPatientId = "";
let addPatientIdTaken = false;
let addPatientIdChecking = false;
let addPatientIdCheckToken = 0;
const importingPatientJobCounts = new Map();
let lastRenderedPatientEntries = [];
let lastRenderedFilterText = "";

const DEBUG_PREF_KEY = "showFrontendDebug";
const TIMELINE_NAMES_PREF_KEY = "alwaysShowTimelineNames";
const DEFAULT_CACHE_SIZE_GB = 5;
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
      const nextCount = (importingPatientJobCounts.get(patientFolder) ?? 0) + 1;
      importingPatientJobCounts.set(patientFolder, nextCount);
    } else {
      const currentCount = importingPatientJobCounts.get(patientFolder) ?? 0;
      const nextCount = Math.max(0, currentCount - 1);
      if (nextCount > 0) {
        importingPatientJobCounts.set(patientFolder, nextCount);
      } else {
        importingPatientJobCounts.delete(patientFolder);
      }
    }
    renderPatientList(lastRenderedPatientEntries, lastRenderedFilterText);
  },
  onImportDebugStateChange: (state) => {
    if (!state) return;
    setDebugState(state);
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
  if (indexingDebugCounts) indexingDebugCounts.hidden = !show;
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

function clampCacheSizeGb(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_CACHE_SIZE_GB;
  return Math.min(10, Math.max(1, Math.round(n)));
}

function setCacheSizeUi(valueGb) {
  const cacheSizeGb = clampCacheSizeGb(valueGb);
  if (cacheSizeSlider) cacheSizeSlider.value = String(cacheSizeGb);
  if (cacheSizeValue) cacheSizeValue.textContent = `${cacheSizeGb} GB`;
}

function formatBytesShort(bytes = 0) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / (1024 ** 2)).toFixed(1)} MB`;
  return `${(n / (1024 ** 3)).toFixed(2)} GB`;
}

function setCacheUsageUi({ usedBytes = 0, maxBytes = 0, percent = 0 } = {}) {
  const safePercent = Math.max(0, Math.min(100, Number(percent) || 0));
  const visiblePercent = safePercent > 0 ? Math.max(2, safePercent) : 0;
  if (cacheUsageBar) {
    cacheUsageBar.style.width = `${visiblePercent}%`;
  }
  if (cacheUsageText) {
    cacheUsageText.textContent = `Cache usage: ${safePercent.toFixed(1)}% (${formatBytesShort(usedBytes)} / ${formatBytesShort(maxBytes)})`;
  }
}

function setIndexingProgressUi({ running = false, message = "Up to date" } = {}) {
  if (indexingProgressSpinner) indexingProgressSpinner.hidden = !running;
  if (indexingProgressText) indexingProgressText.textContent = message || "Up to date";
}

function setIndexingDebugCountsUi(dbImageCount = 0, cacheImageCount = 0, { show = false } = {}) {
  if (!indexingDebugCounts) return;
  indexingDebugCounts.textContent = `DB/CACHE: ${dbImageCount}/${cacheImageCount}`;
  indexingDebugCounts.hidden = !show;
}

function shouldShowIndexingDebugCounts() {
  return Boolean(showFrontendDebugToggle?.checked) && Boolean(currentWorkspaceDir);
}

async function refreshIndexingDebugCounts() {
  if (!indexingDebugCounts) return;
  if (!shouldShowIndexingDebugCounts()) {
    setIndexingDebugCountsUi(0, 0, { show: false });
    return;
  }
  if (indexingDebugCountsInFlight) return;
  indexingDebugCountsInFlight = true;
  try {
    const stats = await invoke("get_preview_debug_counts", { workspaceDir: currentWorkspaceDir });
    const dbImageCount = Number(stats?.db_image_count ?? stats?.dbImageCount ?? 0) || 0;
    const cacheImageCount = Number(stats?.cache_image_count ?? stats?.cacheImageCount ?? 0) || 0;
    setIndexingDebugCountsUi(dbImageCount, cacheImageCount, { show: true });
  } catch (err) {
    console.error("get_preview_debug_counts failed:", err);
    setIndexingDebugCountsUi(0, 0, { show: true });
  } finally {
    indexingDebugCountsInFlight = false;
  }
}

function setPreviewFillRunning(running) {
  isPreviewFillRunning = Boolean(running);
  if (indexingWarmupSpinner) indexingWarmupSpinner.hidden = !isPreviewFillRunning;
  if (!isPreviewFillRunning) {
    setIndexingProgressUi({ running: false, message: "Up to date" });
  } else if (indexingProgressText && indexingProgressText.textContent === "Up to date") {
    setIndexingProgressUi({ running: true, message: "Preparing indexing..." });
  }
  if (isPreviewFillRunning) {
    if (previewFillPollIntervalId === null) {
      previewFillPollIntervalId = setInterval(() => {
        void refreshCacheUsageUi();
        void refreshIndexingDebugCounts();
      }, 5000);
    }
  } else if (previewFillPollIntervalId !== null) {
    clearInterval(previewFillPollIntervalId);
    previewFillPollIntervalId = null;
  }
}

async function ensureBackgroundPreviewFill(cacheStats = null) {
  if (!currentWorkspaceDir || isPreviewFillRunning) return;
  try {
    const counts = await invoke("get_preview_debug_counts", { workspaceDir: currentWorkspaceDir });
    const dbImageCount = Number(counts?.db_image_count ?? counts?.dbImageCount ?? 0) || 0;
    const cacheImageCount = Number(counts?.cache_image_count ?? counts?.cacheImageCount ?? 0) || 0;

    if (dbImageCount > cacheImageCount) {
      setIndexingProgressUi({ running: true, message: `Checking previews (${cacheImageCount}/${dbImageCount})` });
      const started = await invoke("start_background_preview_fill", { workspaceDir: currentWorkspaceDir });
      if (started) {
        setPreviewFillRunning(true);
      } else {
        setIndexingProgressUi({ running: false, message: "Up to date" });
      }
    } else {
      setIndexingProgressUi({ running: true, message: "Removing old files" });
      await invoke("cleanup_preview_cache_for_workspace", { workspaceDir: currentWorkspaceDir });
      setIndexingProgressUi({ running: false, message: "Up to date" });
      void refreshCacheUsageUi();
      void refreshIndexingDebugCounts();
    }
  } catch (err) {
    console.error("startup preview check failed:", err);
    setIndexingProgressUi({ running: false, message: "Up to date" });
  }
}

async function refreshCacheUsageUi() {
  try {
    const stats = await invoke("get_preview_cache_stats");
    setCacheUsageUi({
      usedBytes: stats?.used_bytes ?? stats?.usedBytes ?? 0,
      maxBytes: stats?.max_bytes ?? stats?.maxBytes ?? 0,
      percent: stats?.used_percent ?? stats?.usedPercent ?? 0,
    });
    return stats;
  } catch (err) {
    console.error("get_preview_cache_stats failed:", err);
    const fallback = {
      used_bytes: 0,
      max_bytes: (DEFAULT_CACHE_SIZE_GB * 1024 * 1024 * 1024),
      used_percent: 0,
    };
    setCacheUsageUi({
      usedBytes: fallback.used_bytes,
      maxBytes: fallback.max_bytes,
      percent: fallback.used_percent,
    });
    return fallback;
  }
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
  const stripIdSuffix = (name) => name.replace(/\s+\([^()]+\)\s*$/, "").trim();
  const idx = folderName.indexOf(",");
  if (idx === -1) {
    return { lastName: folderName.trim(), firstName: "" };
  }
  return {
    lastName: folderName.slice(0, idx).trim(),
    firstName: stripIdSuffix(folderName.slice(idx + 1).trim()),
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
  workspacePathEl.textContent = workspaceDir;
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

    if ((importingPatientJobCounts.get(folderName) ?? 0) > 0) {
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
  await refreshIndexingDebugCounts();
}

function clearPatients() {
  currentWorkspaceDir = null;
  selectedPatient = null;
  selectedPatientId = "";
  importingPatientJobCounts.clear();
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
  setPreviewFillRunning(false);
  setIndexingProgressUi({ running: false, message: "Up to date" });
  setIndexingDebugCountsUi(0, 0, { show: false });
  setDbStatusIdle();
}

function showMainScreen(workspaceDir) {
  showMainScreenWithOptions(workspaceDir);
}

function showMainScreenWithOptions(workspaceDir, options = {}) {
  const skipLoadPatients = options?.skipLoadPatients ?? false;
  console.log(`[transition ${ts()}] showing main screen`);
  onboardingView.hidden = true;
  appView.hidden = false;
  currentWorkspaceDir = workspaceDir;
  sidebarLayout.applyPatientSidebarMode();
  sidebarLayout.setPatientSidebarHidden(false);
  setWorkspacePathDisplay(workspaceDir);
  void (async () => {
    const stats = await refreshCacheUsageUi();
    await ensureBackgroundPreviewFill(stats);
    await refreshIndexingDebugCounts();
  })();
  if (!skipLoadPatients) {
    loadPatients(workspaceDir);
  }
  requestAnimationFrame(sidebarLayout.updateTopButtonSpacing);
  console.log(
    `[transition ${ts()}] view flags onboarding.hidden=${onboardingView.hidden} app.hidden=${appView.hidden}`
  );
}

// ---------- Folder -> Checkmark ----------
function setOnboardingCopy(title, subtitle) {
  if (onboardingTitle) onboardingTitle.textContent = title;
  if (onboardingSubtitle) onboardingSubtitle.textContent = subtitle;
}

function setOnboardingBusyState(isBusy) {
  if (pickBtn) pickBtn.disabled = isBusy;
  pickIcon?.classList.toggle("is-busy", isBusy);
}

function setOnboardingButtonLabel(label) {
  if (pickBtn) pickBtn.textContent = label;
}

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

function replaceFolderWithLoadingSpinner() {
  if (!folderIconContainer) return;

  folderIconContainer.innerHTML = `
    <svg class="setup-spinner-svg" viewBox="0 0 240 240" xmlns="http://www.w3.org/2000/svg">
      <circle class="setup-spinner-ring" cx="120" cy="120" r="96"/>
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

function restoreOnboardingIdleState() {
  restoreOnboardingFolderIcon();
  setOnboardingCopy("Select Main Folder", "Please select the folder where your patient folders are stored.");
  setOnboardingButtonLabel("Browse Folders");
  onboardingReadyWorkspaceDir = null;
  setOnboardingBusyState(false);
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
  if (isWorkspaceSetupInProgress) return;
  isWorkspaceSetupInProgress = true;
  setOnboardingBusyState(true);
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
      isWorkspaceSetupInProgress = false;
      setOnboardingBusyState(false);
      return;
    }

    const workspaceDir = Array.isArray(dir) ? dir[0] : dir;
    if (!workspaceDir) {
      setDebugState("workspace pick invalid");
      isWorkspaceSetupInProgress = false;
      setOnboardingBusyState(false);
      return;
    }

    await invoke("save_workspace", { workspaceDir });
    setDebugState("workspace saved");

    if (isAlreadyInMainView) {
      setWorkspacePathDisplay(workspaceDir);
      loadPatients(workspaceDir);
      setDebugState("ready");
      console.log(`[transition ${ts()}] workspace updated in main view (no transition timer)`);
      isWorkspaceSetupInProgress = false;
      setOnboardingBusyState(false);
      return;
    }

    replaceFolderWithLoadingSpinner();
    setOnboardingCopy("Setting Up Database", "Please wait while we complete indexing.");
    await loadPatients(workspaceDir, { minStatusMs: 3000 });

    // ONLY change the folder icon -> checkmark animation
    replaceFolderWithCheckmark();
    setOnboardingCopy("Setup Complete", "Your workspace is ready. You can now work with your data.");
    console.log(`[transition ${ts()}] checkmark icon applied`);
    burstConfettiFromFolder();
    onboardingReadyWorkspaceDir = workspaceDir;
    setOnboardingButtonLabel("Start");
    setDebugState("ready to start");
    isWorkspaceSetupInProgress = false;
    setOnboardingBusyState(false);
  } catch (err) {
    console.error("Failed to open folder dialog:", err);
    setDebugState("error: save workspace");
    restoreOnboardingIdleState();
    isWorkspaceSetupInProgress = false;
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
    const cacheSizeGb =
      settings?.cache_size_gb ??
      settings?.cacheSizeGb ??
      DEFAULT_CACHE_SIZE_GB;
    setCacheSizeUi(cacheSizeGb);
    await refreshCacheUsageUi();
    await refreshIndexingDebugCounts();
    console.log("workspaceDir:", workspaceDir);

    if (!workspaceDir) {
      onboardingView.hidden = false;
      appView.hidden = true;
      restoreOnboardingIdleState();
      clearPatients();
      setDebugState("no workspace");
      return;
    }

    showMainScreen(workspaceDir);
    setDebugState("ready");

  } catch (err) {
    console.error("load_settings failed:", err);
    setCacheSizeUi(DEFAULT_CACHE_SIZE_GB);
    await refreshCacheUsageUi();
    setDebugState("error: load settings");
  }
}

// ---------- Events ----------
pickBtn?.addEventListener("click", async () => {
  if (onboardingReadyWorkspaceDir) {
    const workspaceDir = onboardingReadyWorkspaceDir;
    onboardingReadyWorkspaceDir = null;
    showMainScreenWithOptions(workspaceDir, { skipLoadPatients: true });
    setDebugState("ready");
    return;
  }
  await pickWorkspaceAndSave();
});
pickIcon?.addEventListener("click", async () => {
  if (onboardingReadyWorkspaceDir || isWorkspaceSetupInProgress) return;
  await pickWorkspaceAndSave();
});

changeWorkspaceBtn?.addEventListener("click", pickWorkspaceAndSave);
showFrontendDebugToggle?.addEventListener("change", (e) => {
  const show = Boolean(e.target?.checked);
  setDebugVisibility(show);
  setDeleteWorkspaceAvailability(show);
  writeDebugVisibilityPref(show);
  void refreshIndexingDebugCounts();
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
    restoreOnboardingIdleState();
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
  await refreshIndexingDebugCounts();
});
cacheSizeSlider?.addEventListener("input", (e) => {
  const value = clampCacheSizeGb(e.target?.value ?? DEFAULT_CACHE_SIZE_GB);
  setCacheSizeUi(value);
});
cacheSizeSlider?.addEventListener("change", async (e) => {
  const value = clampCacheSizeGb(e.target?.value ?? DEFAULT_CACHE_SIZE_GB);
  setCacheSizeUi(value);
  if (!cacheSizeSlider) return;
  cacheSizeSlider.disabled = true;
  try {
    const saved = await invoke("set_cache_size_gb", { cacheSizeGb: value });
    setCacheSizeUi(saved);
    const stats = await refreshCacheUsageUi();
    await ensureBackgroundPreviewFill(stats);
  } catch (err) {
    console.error("set_cache_size_gb failed:", err);
    setCacheSizeUi(DEFAULT_CACHE_SIZE_GB);
    await refreshCacheUsageUi();
  } finally {
    cacheSizeSlider.disabled = false;
  }
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
    const createdFolderName = await invoke("create_patient_with_metadata", {
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
    selectedPatient = (createdFolderName ?? `${lastName}, ${firstName}`).toString();
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
openCacheFolderBtn?.addEventListener("click", async () => {
  try {
    await invoke("open_preview_cache_dir");
  } catch (err) {
    console.error("open_preview_cache_dir failed:", err);
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
void listen("preview-fill-status", (event) => {
  const running = Boolean(event?.payload?.running);
  setPreviewFillRunning(running);
  if (!running) {
    void refreshCacheUsageUi();
    void refreshIndexingDebugCounts();
  }
});
void listen("preview-fill-progress", (event) => {
  const running = Boolean(event?.payload?.running);
  const message = String(event?.payload?.message ?? "").trim();
  setIndexingProgressUi({
    running,
    message: message || (running ? "Indexing..." : "Up to date"),
  });
});
void (async () => {
  try {
    const running = await invoke("get_preview_fill_status");
    setPreviewFillRunning(running);
    if (!running) {
      setIndexingProgressUi({ running: false, message: "Up to date" });
    }
  } catch (err) {
    console.error("get_preview_fill_status failed:", err);
  }
})();
boot();
