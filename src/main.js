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
const settingsBody = panel?.querySelector(".settings-body") ?? null;
const addPatientBtn = document.getElementById("addPatientBtn");
const invalidPatientFoldersBtn = document.getElementById("invalidPatientFoldersBtn");
const invalidPatientFoldersPanel = document.getElementById("invalidPatientFoldersPanel");
const invalidPatientFoldersList = document.getElementById("invalidPatientFoldersList");
const invalidPatientFoldersTitle = document.getElementById("invalidPatientFoldersTitle");

const changeWorkspaceBtn = document.getElementById("changeWorkspaceBtn");
const workspacePathEl = document.getElementById("workspacePath");
const folderIconContainer = document.getElementById("folderIconContainer");
const debugBadge = document.getElementById("debugBadge");
const debugWindowBadge = document.getElementById("debugWindowBadge");
const showFrontendDebugToggle = document.getElementById("showFrontendDebug");
const alwaysShowTimelineNamesToggle = document.getElementById("alwaysShowTimelineNames");
const deleteWorkspaceBtn = document.getElementById("deleteWorkspaceBtn");
const deleteWorkspaceRow = document.getElementById("deleteWorkspaceRow");
const deleteDatabaseBtn = document.getElementById("deleteDatabaseBtn");
const deleteDatabaseRow = document.getElementById("deleteDatabaseRow");
const deleteLocalCacheBtn = document.getElementById("deleteLocalCacheBtn");
const deleteLocalCacheRow = document.getElementById("deleteLocalCacheRow");
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
const previewSpeedSlider = document.getElementById("previewSpeedSlider");
const previewSpeedValue = document.getElementById("previewSpeedValue");
const cacheUsageBar = document.getElementById("cacheUsageBar");
const cacheUsageText = document.getElementById("cacheUsageText");
const openCacheFolderBtn = document.getElementById("openCacheFolderBtn");
const keepLocalCacheCopyToggle = document.getElementById("keepLocalCacheCopy");
const indexingProgressSpinner = document.getElementById("indexingProgressSpinner");
const indexingProgressText = document.getElementById("indexingProgressText");
const cacheReloadBtn = document.getElementById("cacheReloadBtn");

function setDebugState(state) {
  if (!debugBadge) return;
  debugBadge.textContent = `debug: (${state})`;
}

function setInvalidPanelExpanded(expanded) {
  if (!invalidPatientFoldersPanel) return;
  if (invalidPanelHideTimerId !== null) {
    clearTimeout(invalidPanelHideTimerId);
    invalidPanelHideTimerId = null;
  }

  if (expanded) {
    invalidPatientFoldersPanel.hidden = false;
    requestAnimationFrame(() => {
      invalidPatientFoldersPanel.classList.add("expanded");
    });
    return;
  }

  invalidPatientFoldersPanel.classList.remove("expanded");
  invalidPanelHideTimerId = setTimeout(() => {
    if (!invalidPatientFoldersPanel.classList.contains("expanded")) {
      invalidPatientFoldersPanel.hidden = true;
    }
    invalidPanelHideTimerId = null;
  }, PANEL_ANIM_MS);
}

function setAddPatientPanelExpanded(expanded) {
  if (!addPatientForm) return;
  if (addPatientFormHideTimerId !== null) {
    clearTimeout(addPatientFormHideTimerId);
    addPatientFormHideTimerId = null;
  }

  if (expanded) {
    addPatientForm.hidden = false;
    requestAnimationFrame(() => {
      addPatientForm.classList.add("expanded");
    });
    return;
  }

  addPatientForm.classList.remove("expanded");
  addPatientFormHideTimerId = setTimeout(() => {
    if (!addPatientForm.classList.contains("expanded")) {
      addPatientForm.hidden = true;
    }
    addPatientFormHideTimerId = null;
  }, PANEL_ANIM_MS);
}

function renderInvalidPatientFoldersPanel() {
  if (!invalidPatientFoldersPanel || !invalidPatientFoldersList) return;
  const hasInvalidItems = Boolean(currentWorkspaceDir) &&
    (invalidPatientFolderNames.length > 0 || invalidPatientFileNames.length > 0);
  const expanded = hasInvalidItems && invalidPatientFoldersPanelExpanded;

  setInvalidPanelExpanded(expanded);
  invalidPatientFoldersPanel.setAttribute("aria-hidden", expanded ? "false" : "true");
  invalidPatientFoldersBtn?.classList.toggle("active", expanded);

  invalidPatientFoldersList.innerHTML = "";
  if (!expanded) return;

  const folderIcon = `
    <svg class="invalid-patient-folder-icon" viewBox="0 0 100 100" fill="none" aria-hidden="true">
      <path d="M10 30C10 26.6863 12.6863 24 16 24H35L42 32H84C87.3137 32 90 34.6863 90 38V74C90 77.3137 87.3137 80 84 80H16C12.6863 80 10 77.3137 10 74V30Z" fill="var(--folder-back)"/>
      <path d="M10 40C10 36.6863 12.6863 34 16 34H84C87.3137 34 90 36.6863 90 40V74C90 77.3137 87.3137 80 84 80H16C12.6863 80 10 77.3137 10 74V40Z" fill="var(--folder-front)"/>
    </svg>
  `;

  for (const folderName of invalidPatientFolderNames) {
    const item = document.createElement("li");
    item.className = "invalid-patient-folder-item";
    item.innerHTML = `${folderIcon}<span class="invalid-patient-folder-name">${folderName}</span>`;
    invalidPatientFoldersList.appendChild(item);
  }

  for (const fileName of invalidPatientFileNames) {
    const item = document.createElement("li");
    item.className = "invalid-patient-folder-item";
    const ext = extractExt(fileName) || "FILE";
    item.innerHTML = `
      <span class="invalid-patient-file-ext">${ext}</span>
      <span class="invalid-patient-folder-name">${fileName}</span>
    `;
    invalidPatientFoldersList.appendChild(item);
  }
}

function setInvalidPatientFolderWarningUi(count = 0, folderNames = [], fileNames = []) {
  invalidPatientFolderCount = Math.max(0, Number(count) || 0);
  invalidPatientFolderNames = Array.isArray(folderNames)
    ? folderNames.filter((name) => typeof name === "string" && name.trim().length > 0)
    : [];
  invalidPatientFileNames = Array.isArray(fileNames)
    ? fileNames.filter((name) => typeof name === "string" && name.trim().length > 0)
    : [];

  if (!invalidPatientFoldersBtn) return;
  const totalIssues = invalidPatientFolderNames.length + invalidPatientFileNames.length;
  if (invalidPatientFoldersTitle) {
    invalidPatientFoldersTitle.textContent = `${totalIssues} invalid folders or Files`;
  }
  const showWarning = Boolean(currentWorkspaceDir) && totalIssues > 0;
  invalidPatientFoldersBtn.hidden = !showWarning;
  invalidPatientFoldersBtn.disabled = !showWarning;
  if (showWarning) {
    invalidPatientFoldersBtn.setAttribute(
      "title",
      `${totalIssues} invalid folder/file item(s) found in the main directory.`,
    );
  } else {
    invalidPatientFoldersBtn.removeAttribute("title");
    invalidPatientFoldersPanelExpanded = false;
  }
  renderInvalidPatientFoldersPanel();
}

async function refreshInvalidPatientFolderWarning(workspaceDir = currentWorkspaceDir) {
  if (!workspaceDir) {
    setInvalidPatientFolderWarningUi(0, [], []);
    return 0;
  }
  try {
    const row = await invoke("get_invalid_patient_folders", { workspaceDir });
    const count = Number(row?.invalid_count ?? row?.invalidCount ?? 0) || 0;
    const invalidFolders = Array.isArray(row?.invalid_folders ?? row?.invalidFolders)
      ? (row?.invalid_folders ?? row?.invalidFolders)
      : [];
    const invalidFiles = Array.isArray(row?.invalid_files ?? row?.invalidFiles)
      ? (row?.invalid_files ?? row?.invalidFiles)
      : [];
    setInvalidPatientFolderWarningUi(count, invalidFolders, invalidFiles);
    return count;
  } catch (err) {
    console.error("get_invalid_patient_folders failed:", err);
    setInvalidPatientFolderWarningUi(0, [], []);
    return 0;
  }
}

function syncSettingsHeaderScrollState() {
  if (!panel || !settingsBody) return;
  panel.classList.toggle("is-scrolled", settingsBody.scrollTop > 0);
}

function ts() {
  return new Date().toISOString();
}

function extractExt(name = "") {
  const raw = String(name ?? "");
  const dot = raw.lastIndexOf(".");
  if (dot <= 0 || dot === raw.length - 1) return "";
  return raw.slice(dot + 1).toUpperCase();
}

let isWorkspaceSetupInProgress = false;
let onboardingReadyWorkspaceDir = null;
let currentWorkspaceDir = null;
let databaseDeleteLocked = false;
let invalidPatientFolderCount = 0;
let invalidPatientFolderNames = [];
let invalidPatientFileNames = [];
let invalidPatientFoldersPanelExpanded = false;
let invalidPanelHideTimerId = null;
let patientSearchDebounceId = null;
let isDbUpdating = false;
let isPreviewFillRunning = false;
let isPreviewFillStopInFlight = false;
let previewFillPausedByUser = false;
let isStoppingCacheProcesses = false;
let cacheMarkedNotSynchronized = false;
let isCacheMaintenanceRunning = false;
let indexingLivePollIntervalId = null;
let indexingDebugCountsInFlight = false;
let indexingStatusInFlight = false;
let indexingProgressRunning = false;
let indexingProgressMessage = "Up to date";
let indexingCountsSuffix = "";
let indexingCustomSuffix = "";
let previewFillProgressMessage = "";
let manualCacheHoldMode = "";
let keepLocalCacheCopyEnabled = false;
let localCacheSyncInFlight = false;
let localCacheStatusPollIntervalId = null;
let localCacheStatusState = "up_to_date";
let localCacheStatusRunning = false;
let localCacheFolderExists = false;
let localCacheFileCount = 0;
let creatingProgressBaseCacheCount = null;
let creatingProgressExpectedCount = 0;
let selectedPatient = null;
let selectedPatientId = "";
let addPatientIdTaken = false;
let addPatientIdChecking = false;
let addPatientIdCheckToken = 0;
let addPatientFormHideTimerId = null;
const importingPatientJobCounts = new Map();
let lastRenderedPatientEntries = [];
let lastRenderedFilterText = "";

const DEBUG_PREF_KEY = "showFrontendDebug";
const TIMELINE_NAMES_PREF_KEY = "alwaysShowTimelineNames";
const DEFAULT_CACHE_SIZE_GB = 5;
const DEFAULT_PREVIEW_PERFORMANCE_MODE = "auto";
const INDEXING_STATUS_POLL_MS = 2500;
const LOCAL_CACHE_STATUS_POLL_MS = 3000;
const MIN_MANUAL_CACHE_STATUS_MS = 1500;
const PANEL_ANIM_MS = 230;
const CACHE_RELOAD_ICON_UPDATE = `
  <svg class="db-reload-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M21 12a9 9 0 1 1-2.64-6.36" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
    <path d="M21 3v6h-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>
`;
const CACHE_RELOAD_ICON_PAUSE = `
  <svg class="db-reload-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M8 6V18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>
    <path d="M16 6V18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>
  </svg>
`;
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
    updateLocalCacheDeleteButtonState();
    void refreshIndexingStatus();
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
}

function updateWindowDebugSize() {
  if (!debugWindowBadge) return;
  debugWindowBadge.textContent = `window: ${window.innerWidth}x${window.innerHeight}`;
}

function setDeleteWorkspaceAvailability(enabled) {
  if (deleteWorkspaceBtn) deleteWorkspaceBtn.disabled = !enabled;
  deleteWorkspaceRow?.classList.toggle("inactive", !enabled);
}

function setDeleteDatabaseAvailability(enabled) {
  const available = Boolean(enabled) && !isDbUpdating && !databaseDeleteLocked;
  if (deleteDatabaseBtn) deleteDatabaseBtn.disabled = !available;
  deleteDatabaseRow?.classList.toggle("inactive", !available);
}

function setDebugOnlyRowsVisibility(show) {
  if (deleteWorkspaceRow) deleteWorkspaceRow.hidden = !show;
  if (deleteDatabaseRow) deleteDatabaseRow.hidden = !show;
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
  setDebugOnlyRowsVisibility(show);
  setDeleteWorkspaceAvailability(show);
  setDeleteDatabaseAvailability(show);
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

function normalizePreviewPerformanceMode(mode) {
  const raw = String(mode ?? "").trim().toLowerCase();
  if (raw === "gentle" || raw === "fast") return raw;
  return DEFAULT_PREVIEW_PERFORMANCE_MODE;
}

function previewPerformanceModeToSliderValue(mode) {
  const normalized = normalizePreviewPerformanceMode(mode);
  if (normalized === "gentle") return 0;
  if (normalized === "fast") return 2;
  return 1;
}

function sliderValueToPreviewPerformanceMode(value) {
  const n = Number(value);
  if (n <= 0) return "gentle";
  if (n >= 2) return "fast";
  return "auto";
}

function previewPerformanceModeToLabel(mode) {
  const normalized = normalizePreviewPerformanceMode(mode);
  if (normalized === "gentle") return "Gentle";
  if (normalized === "fast") return "Fast";
  return "Auto";
}

function setPreviewPerformanceUi(mode) {
  const normalized = normalizePreviewPerformanceMode(mode);
  if (previewSpeedSlider) {
    previewSpeedSlider.value = String(previewPerformanceModeToSliderValue(normalized));
  }
  if (previewSpeedValue) {
    previewSpeedValue.textContent = previewPerformanceModeToLabel(normalized);
  }
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

function formatLocalCacheCopyStatusText(state, lastSyncMs = null) {
  if (state === "copying") return "Copying Cache...";
  if (state === "updating") return "Syncing Cache...";
  if (state === "paused") return "Paused";
  return "";
}

function isLocalCacheMutationBlocked() {
  if (!keepLocalCacheCopyEnabled) return false;
  return Boolean(
    hasActiveImportJobs() ||
    isPreviewFillRunning ||
    isStoppingCacheProcesses
  );
}

function updateLocalCacheDeleteButtonState() {
  const blocked = isLocalCacheMutationBlocked();
  const enabled =
    Boolean(currentWorkspaceDir) &&
    Number(localCacheFileCount) > 0 &&
    !blocked;
  const busy = Boolean(localCacheStatusRunning || localCacheSyncInFlight);
  if (deleteLocalCacheBtn) {
    deleteLocalCacheBtn.disabled = !enabled || busy;
  }
  deleteLocalCacheRow?.classList.toggle("inactive", !enabled);
  if (keepLocalCacheCopyToggle) {
    keepLocalCacheCopyToggle.disabled =
      !currentWorkspaceDir || localCacheSyncInFlight || blocked;
  }
}

function applyLocalCacheCopyStatus(status = {}) {
  const enabled = Boolean(status?.enabled);
  keepLocalCacheCopyEnabled = enabled;
  if (keepLocalCacheCopyToggle) keepLocalCacheCopyToggle.checked = enabled;

  const stateRaw = String(status?.state ?? "").trim().toLowerCase();
  const state = enabled ? (stateRaw || "up_to_date") : "up_to_date";
  const running = enabled && (Boolean(status?.running) || state === "copying" || state === "updating");
  localCacheFolderExists = Boolean(status?.local_cache_exists ?? status?.localCacheExists ?? false);
  localCacheFileCount = Number(status?.local_cache_file_count ?? status?.localCacheFileCount ?? 0) || 0;
  localCacheStatusState = state;
  localCacheStatusRunning = running;
  updateLocalCacheDeleteButtonState();
  void refreshIndexingStatus();
}

async function refreshLocalCacheCopyStatus() {
  try {
    const status = await invoke("get_local_cache_copy_status");
    applyLocalCacheCopyStatus(status);
    return status;
  } catch (err) {
    console.error("get_local_cache_copy_status failed:", err);
    return null;
  }
}

function startLocalCacheStatusPolling() {
  if (localCacheStatusPollIntervalId !== null) return;
  localCacheStatusPollIntervalId = setInterval(() => {
    void refreshLocalCacheCopyStatus();
  }, LOCAL_CACHE_STATUS_POLL_MS);
}

function stopLocalCacheStatusPolling() {
  if (localCacheStatusPollIntervalId === null) return;
  clearInterval(localCacheStatusPollIntervalId);
  localCacheStatusPollIntervalId = null;
}

async function syncLocalCacheCopy({ manual = false } = {}) {
  if (!currentWorkspaceDir || !keepLocalCacheCopyEnabled || localCacheSyncInFlight) return;
  cacheMarkedNotSynchronized = false;
  localCacheSyncInFlight = true;
  updateLocalCacheDeleteButtonState();
  applyLocalCacheCopyStatus({
    enabled: true,
    running: true,
    state: manual ? "updating" : "updating",
  });
  try {
    const status = await invoke("sync_local_cache_copy", { workspaceDir: currentWorkspaceDir });
    applyLocalCacheCopyStatus(status);
  } catch (err) {
    console.error("sync_local_cache_copy failed:", err);
  } finally {
    localCacheSyncInFlight = false;
    updateLocalCacheDeleteButtonState();
    void refreshLocalCacheCopyStatus();
  }
}

function renderIndexingProgressText() {
  if (!indexingProgressText) return;
  const baseText = indexingProgressMessage || "Up to date";
  const suffix = indexingCustomSuffix || indexingCountsSuffix;
  const alreadyHasCounts = /\(\d+\s*\/\s*\d+\)/.test(baseText);
  indexingProgressText.textContent = suffix && !alreadyHasCounts
    ? `${baseText} ${suffix}`
    : baseText;
}

function setIndexingProgressUi({ running = false, message = "Up to date" } = {}) {
  indexingProgressRunning = Boolean(running);
  indexingProgressMessage = message || "Up to date";
  if (indexingProgressSpinner) indexingProgressSpinner.hidden = !indexingProgressRunning;
  renderIndexingProgressText();
}

function setIndexingDebugCountsUi(dbImageCount = 0, cacheImageCount = 0, { show = false } = {}) {
  indexingCountsSuffix = show ? `(${dbImageCount}/${cacheImageCount})` : "";
  renderIndexingProgressText();
}

function setIndexingCustomSuffixUi(suffix = "") {
  indexingCustomSuffix = suffix || "";
  renderIndexingProgressText();
}

function shouldShowIndexingDebugCounts() {
  return Boolean(currentWorkspaceDir);
}

function hasActiveImportJobs() {
  return importingPatientJobCounts.size > 0;
}

function setCacheReloadButtonMode(mode = "update") {
  if (!cacheReloadBtn) return;
  if (mode === "pause") {
    cacheReloadBtn.innerHTML = CACHE_RELOAD_ICON_PAUSE;
    cacheReloadBtn.setAttribute("aria-label", "Pause cache update");
    cacheReloadBtn.setAttribute("title", "Pause cache update");
    return;
  }
  cacheReloadBtn.innerHTML = CACHE_RELOAD_ICON_UPDATE;
  cacheReloadBtn.setAttribute("aria-label", "Update cache");
  cacheReloadBtn.setAttribute("title", "Update cache");
}

function updateCacheReloadButtonState() {
  if (!cacheReloadBtn) return;
  const pauseMode =
    isPreviewFillRunning ||
    isCacheMaintenanceRunning ||
    localCacheSyncInFlight ||
    localCacheStatusRunning;
  setCacheReloadButtonMode(pauseMode ? "pause" : "update");
  cacheReloadBtn.disabled =
    !currentWorkspaceDir ||
    isPreviewFillStopInFlight ||
    isStoppingCacheProcesses ||
    (isCacheMaintenanceRunning && !pauseMode);
}

async function refreshIndexingDebugCounts() {
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

async function refreshIndexingStatus() {
  if (!currentWorkspaceDir || indexingStatusInFlight) return;
  indexingStatusInFlight = true;
  try {
    const [runningRaw, counts] = await Promise.all([
      invoke("get_preview_fill_status"),
      invoke("get_preview_debug_counts", { workspaceDir: currentWorkspaceDir }),
    ]);

    const running = Boolean(runningRaw);
    const dbImageCount = Number(counts?.db_image_count ?? counts?.dbImageCount ?? 0) || 0;
    const cacheImageCount = Number(counts?.cache_image_count ?? counts?.cacheImageCount ?? 0) || 0;
    const importingActive = hasActiveImportJobs();
    const pendingCacheItems = dbImageCount > cacheImageCount;
    const manualHoldActive = isCacheMaintenanceRunning;
    const progressText = previewFillProgressMessage.toLowerCase();
    const organizingByBackend =
      progressText.includes("removing old files") ||
      progressText.includes("clearing duplicates") ||
      progressText.includes("cleanup");
    const creatingByManual = manualHoldActive && manualCacheHoldMode === "creating";
    const organizingByManual = manualHoldActive && manualCacheHoldMode === "organizing";
    const organizingActive = organizingByBackend || organizingByManual;
    const paused = previewFillPausedByUser && !running && !manualHoldActive && !importingActive;
    const anyCacheTaskRunning =
      running ||
      manualHoldActive ||
      localCacheStatusRunning ||
      localCacheSyncInFlight;
    const creatingActive =
      creatingByManual ||
      pendingCacheItems ||
      importingActive ||
      (running && !organizingByBackend);
    const cacheWorkActive = running || importingActive || pendingCacheItems || manualHoldActive;
    const localCopySyncActive = keepLocalCacheCopyEnabled && (localCacheStatusRunning || localCacheSyncInFlight);
    const localCopyStatusMessage = formatLocalCacheCopyStatusText(localCacheStatusState);

    setPreviewFillRunning(running);
    if (isStoppingCacheProcesses) {
      if (anyCacheTaskRunning) {
        setIndexingProgressUi({ running: true, message: "Stopping processes ..." });
        setIndexingCustomSuffixUi("");
        setIndexingDebugCountsUi(dbImageCount, cacheImageCount, { show: false });
      } else {
        isStoppingCacheProcesses = false;
        cacheMarkedNotSynchronized = true;
        setIndexingProgressUi({ running: false, message: "Not synchronized" });
        setIndexingCustomSuffixUi("");
        setIndexingDebugCountsUi(dbImageCount, cacheImageCount, { show: false });
      }
    } else if (cacheMarkedNotSynchronized && !anyCacheTaskRunning) {
      setIndexingProgressUi({ running: false, message: "Not synchronized" });
      setIndexingCustomSuffixUi("");
      setIndexingDebugCountsUi(dbImageCount, cacheImageCount, { show: false });
    } else if (creatingActive) {
      if (creatingProgressBaseCacheCount === null) {
        creatingProgressBaseCacheCount = cacheImageCount;
        creatingProgressExpectedCount = Math.max(0, dbImageCount - cacheImageCount);
      } else {
        creatingProgressExpectedCount = Math.max(
          creatingProgressExpectedCount,
          Math.max(0, dbImageCount - creatingProgressBaseCacheCount)
        );
      }
      const createdNow = Math.max(0, cacheImageCount - creatingProgressBaseCacheCount);
      const expectedNow = Math.max(createdNow, creatingProgressExpectedCount);
      setIndexingProgressUi({ running: true, message: "Creating Previews" });
      setIndexingCustomSuffixUi(`(${createdNow}/${expectedNow})`);
      setIndexingDebugCountsUi(dbImageCount, cacheImageCount, { show: false });
      void refreshCacheUsageUi();
    } else if (localCopySyncActive && localCopyStatusMessage) {
      setIndexingProgressUi({ running: true, message: localCopyStatusMessage });
      setIndexingCustomSuffixUi("");
      setIndexingDebugCountsUi(dbImageCount, cacheImageCount, { show: false });
    } else if (paused) {
      setIndexingProgressUi({ running: false, message: "Paused" });
      setIndexingCustomSuffixUi("");
      setIndexingDebugCountsUi(dbImageCount, cacheImageCount, { show: false });
    } else if (!cacheWorkActive) {
      creatingProgressBaseCacheCount = null;
      creatingProgressExpectedCount = 0;
      setIndexingProgressUi({ running: false, message: "Up to date" });
      setIndexingCustomSuffixUi("");
      setIndexingDebugCountsUi(dbImageCount, cacheImageCount, { show: shouldShowIndexingDebugCounts() });
    } else if (organizingActive) {
      creatingProgressBaseCacheCount = null;
      creatingProgressExpectedCount = 0;
      setIndexingProgressUi({ running: true, message: "Organizing Cache ..." });
      setIndexingCustomSuffixUi("");
      setIndexingDebugCountsUi(dbImageCount, cacheImageCount, { show: false });
    } else {
      setIndexingProgressUi({ running: true, message: "Creating Previews" });
      setIndexingCustomSuffixUi("");
      setIndexingDebugCountsUi(dbImageCount, cacheImageCount, { show: shouldShowIndexingDebugCounts() });
    }
  } catch (err) {
    console.error("refreshIndexingStatus failed:", err);
  } finally {
    indexingStatusInFlight = false;
  }
}

function startIndexingStatusPolling() {
  if (indexingLivePollIntervalId !== null) return;
  indexingLivePollIntervalId = setInterval(() => {
    void refreshIndexingStatus();
  }, INDEXING_STATUS_POLL_MS);
}

function stopIndexingStatusPolling() {
  if (indexingLivePollIntervalId === null) return;
  clearInterval(indexingLivePollIntervalId);
  indexingLivePollIntervalId = null;
}

function setPreviewFillRunning(running) {
  isPreviewFillRunning = Boolean(running);
  if (isPreviewFillRunning) {
    previewFillPausedByUser = false;
  }
  if (!isPreviewFillRunning && !isCacheMaintenanceRunning && !isStoppingCacheProcesses && !cacheMarkedNotSynchronized) {
    setIndexingProgressUi({ running: false, message: "Up to date" });
  } else if (isPreviewFillRunning && !indexingProgressRunning) {
    setIndexingProgressUi({ running: true, message: "Creating Previews" });
  }
  updateLocalCacheDeleteButtonState();
  updateCacheReloadButtonState();
}

async function ensureBackgroundPreviewFill(cacheStats = null) {
  if (!currentWorkspaceDir || isPreviewFillRunning || previewFillPausedByUser) return;
  try {
    cacheMarkedNotSynchronized = false;
    const counts = await invoke("get_preview_debug_counts", { workspaceDir: currentWorkspaceDir });
    const dbImageCount = Number(counts?.db_image_count ?? counts?.dbImageCount ?? 0) || 0;
    const cacheImageCount = Number(counts?.cache_image_count ?? counts?.cacheImageCount ?? 0) || 0;

    if (dbImageCount > cacheImageCount) {
      setIndexingProgressUi({ running: true, message: "Creating Previews" });
      const started = await invoke("start_background_preview_fill", { workspaceDir: currentWorkspaceDir });
      if (started) {
        setPreviewFillRunning(true);
      } else {
        setIndexingProgressUi({ running: false, message: "Up to date" });
      }
    } else {
      setIndexingProgressUi({ running: true, message: "Organizing Cache ..." });
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
    if (keepLocalCacheCopyEnabled && !isPreviewFillRunning && !isCacheMaintenanceRunning && !hasActiveImportJobs()) {
      void syncLocalCacheCopy();
    }
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

async function runManualCacheMaintenance() {
  if (!currentWorkspaceDir || isPreviewFillRunning || isCacheMaintenanceRunning) return;
  previewFillPausedByUser = false;
  cacheMarkedNotSynchronized = false;
  const startedAt = Date.now();
  isCacheMaintenanceRunning = true;
  manualCacheHoldMode = "organizing";
  updateCacheReloadButtonState();
  setIndexingProgressUi({ running: true, message: "Organizing Cache ..." });
  try {
    const counts = await invoke("get_preview_debug_counts", { workspaceDir: currentWorkspaceDir });
    const dbImageCount = Number(counts?.db_image_count ?? counts?.dbImageCount ?? 0) || 0;
    const cacheImageCount = Number(counts?.cache_image_count ?? counts?.cacheImageCount ?? 0) || 0;

    if (dbImageCount > cacheImageCount) {
      manualCacheHoldMode = "creating";
      setIndexingProgressUi({ running: true, message: "Creating Previews" });
      const started = await invoke("start_background_preview_fill", { workspaceDir: currentWorkspaceDir });
      if (started) {
        setPreviewFillRunning(true);
      } else {
        await refreshIndexingStatus();
      }
    } else {
      setIndexingProgressUi({ running: true, message: "Organizing Cache ..." });
      await invoke("cleanup_preview_cache_for_workspace", { workspaceDir: currentWorkspaceDir });
      await refreshCacheUsageUi();
      await refreshIndexingStatus();
    }
  } catch (err) {
    console.error("manual cache maintenance failed:", err);
    await refreshIndexingStatus();
  } finally {
    const elapsedMs = Date.now() - startedAt;
    const remainingMs = MIN_MANUAL_CACHE_STATUS_MS - elapsedMs;
    if (remainingMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, remainingMs));
    }
    isCacheMaintenanceRunning = false;
    manualCacheHoldMode = "";
    updateCacheReloadButtonState();
    await refreshIndexingStatus();
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
  setDeleteDatabaseAvailability(Boolean(showFrontendDebugToggle?.checked));
}

function setDbStatusUpToDate(date = new Date()) {
  isDbUpdating = false;
  if (dbStatusText) dbStatusText.textContent = "Up to date";
  if (dbStatusTime) dbStatusTime.textContent = formatDateTime(date);
  if (dbStatusSpinner) dbStatusSpinner.hidden = true;
  if (dbReloadBtn) dbReloadBtn.disabled = !currentWorkspaceDir;
  setDeleteDatabaseAvailability(Boolean(showFrontendDebugToggle?.checked));
}

function setDbStatusIdle() {
  isDbUpdating = false;
  if (dbStatusText) dbStatusText.textContent = "Up to date";
  if (dbStatusTime) dbStatusTime.textContent = "never updated";
  if (dbStatusSpinner) dbStatusSpinner.hidden = true;
  if (dbReloadBtn) dbReloadBtn.disabled = true;
  setDeleteDatabaseAvailability(Boolean(showFrontendDebugToggle?.checked));
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

function normalizePatientNameForCreate(value) {
  return String(value ?? "").replace(/\s+$/u, "");
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
  const lastName = normalizePatientNameForCreate(newPatientLastName?.value);
  const firstName = normalizePatientNameForCreate(newPatientFirstName?.value);
  const patientId = normalizePatientFieldValue(newPatientId?.value);
  return Boolean(
    lastName.trim() &&
    firstName.trim() &&
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
  setAddPatientPanelExpanded(visible);
  addPatientForm.setAttribute("aria-hidden", visible ? "false" : "true");
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
  patientList.classList.remove("is-empty-state");

  if (entries.length === 0) {
    const empty = document.createElement("li");
    empty.className = "patient-empty";
    if (filterText) {
      empty.textContent = "No patients match your search.";
    } else {
      empty.classList.add("no-patient-folders");
      empty.textContent = "No patient folders found";
      patientList.classList.add("is-empty-state");
    }
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
    databaseDeleteLocked = false;
    setDbStatusUpToDate(new Date());
  }

  await searchPatients(query);
  await refreshInvalidPatientFolderWarning(workspaceDir);
  await mainContent.refreshTimelineForSelection();
  await refreshIndexingDebugCounts();
}

function clearPatients() {
  currentWorkspaceDir = null;
  databaseDeleteLocked = false;
  selectedPatient = null;
  selectedPatientId = "";
  importingPatientJobCounts.clear();
  updateCacheReloadButtonState();
  updateLocalCacheDeleteButtonState();
  sidebarLayout.clearAutoHidePatientSidebar();
  sidebarLayout.setPatientSidebarHidden(false);
  if (patientSearchDebounceId !== null) {
    clearTimeout(patientSearchDebounceId);
    patientSearchDebounceId = null;
  }
  if (patientSearchInput) patientSearchInput.value = "";
  setInvalidPatientFolderWarningUi(0, [], []);
  setAddPatientFormVisible(false);
  resetAddPatientForm();
  mainContent.clearSelectedPatientHeader();
  renderPatientList([], "");
  stopLocalCacheStatusPolling();
  localCacheFolderExists = false;
  localCacheFileCount = 0;
  applyLocalCacheCopyStatus({
    enabled: keepLocalCacheCopyEnabled,
    running: false,
    state: "up_to_date",
  });
  stopIndexingStatusPolling();
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
  updateCacheReloadButtonState();
  updateLocalCacheDeleteButtonState();
  startIndexingStatusPolling();
  startLocalCacheStatusPolling();
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
    const keepLocalCopy = Boolean(
      settings?.keep_local_cache_copy ??
      settings?.keepLocalCacheCopy ??
      false
    );
    const previewPerformanceMode = normalizePreviewPerformanceMode(
      settings?.preview_performance_mode ??
      settings?.previewPerformanceMode ??
      DEFAULT_PREVIEW_PERFORMANCE_MODE
    );
    keepLocalCacheCopyEnabled = keepLocalCopy;
    if (keepLocalCacheCopyToggle) keepLocalCacheCopyToggle.checked = keepLocalCopy;
    setCacheSizeUi(cacheSizeGb);
    setPreviewPerformanceUi(previewPerformanceMode);
    await refreshCacheUsageUi();
    await refreshIndexingDebugCounts();
    await refreshLocalCacheCopyStatus();
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
    setPreviewPerformanceUi(DEFAULT_PREVIEW_PERFORMANCE_MODE);
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
  setDebugOnlyRowsVisibility(show);
  setDeleteWorkspaceAvailability(show);
  setDeleteDatabaseAvailability(show);
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
deleteDatabaseBtn?.addEventListener("click", async () => {
  if (deleteDatabaseBtn.disabled) return;
  try {
    await invoke("delete_database");
    databaseDeleteLocked = true;
    setDbStatusIdle();
    if (dbReloadBtn) dbReloadBtn.disabled = !currentWorkspaceDir;
    setDeleteDatabaseAvailability(Boolean(showFrontendDebugToggle?.checked));
    selectedPatient = null;
    selectedPatientId = "";
    mainContent.clearSelectedPatientHeader();
    await searchPatients(patientSearchInput?.value ?? "");
    await mainContent.refreshTimelineForSelection();
    await refreshIndexingDebugCounts();
    if (currentWorkspaceDir) {
      await refreshInvalidPatientFolderWarning(currentWorkspaceDir);
    }
  } catch (err) {
    console.error("delete_database failed:", err);
    setDebugState("error: delete database");
  }
});
deleteLocalCacheBtn?.addEventListener("click", async () => {
  if (!currentWorkspaceDir || deleteLocalCacheBtn.disabled) return;
  try {
    localCacheSyncInFlight = true;
    applyLocalCacheCopyStatus({ enabled: keepLocalCacheCopyEnabled, running: true, state: "updating" });
    await invoke("delete_local_cache_copy_files");
    await invoke("set_keep_local_cache_copy", {
      workspaceDir: currentWorkspaceDir,
      enabled: false,
    });
    mainContent.invalidateTreatmentPreviewCache();
    await refreshCacheUsageUi();
    await refreshLocalCacheCopyStatus();
    await mainContent.refreshTreatmentFilesForSelection();
    await refreshIndexingStatus();
  } catch (err) {
    console.error("delete_local_cache_copy_files failed:", err);
  } finally {
    localCacheSyncInFlight = false;
    updateLocalCacheDeleteButtonState();
  }
});
dbReloadBtn?.addEventListener("click", async () => {
  if (!currentWorkspaceDir || isDbUpdating) return;
  await loadPatients(currentWorkspaceDir, { minStatusMs: 1500 });
  await refreshIndexingDebugCounts();
});
cacheReloadBtn?.addEventListener("click", async () => {
  if (!currentWorkspaceDir || isPreviewFillStopInFlight) return;
  const pauseMode =
    isPreviewFillRunning ||
    isCacheMaintenanceRunning ||
    localCacheSyncInFlight ||
    localCacheStatusRunning;
  if (pauseMode) {
    try {
      isPreviewFillStopInFlight = true;
      isStoppingCacheProcesses = true;
      updateCacheReloadButtonState();
      previewFillPausedByUser = true;
      setIndexingProgressUi({ running: true, message: "Pausing..." });
      await invoke("stop_all_cache_tasks");
    } catch (err) {
      console.error("stop_all_cache_tasks failed:", err);
      previewFillPausedByUser = false;
      isStoppingCacheProcesses = false;
      void refreshIndexingStatus();
    } finally {
      isPreviewFillStopInFlight = false;
      updateCacheReloadButtonState();
    }
    return;
  }
  previewFillPausedByUser = false;
  isStoppingCacheProcesses = false;
  cacheMarkedNotSynchronized = false;
  void runManualCacheMaintenance();
});
keepLocalCacheCopyToggle?.addEventListener("change", async (e) => {
  const enabled = Boolean(e.target?.checked);
  const previousEnabled = keepLocalCacheCopyEnabled;
  if (!currentWorkspaceDir) {
    if (keepLocalCacheCopyToggle) keepLocalCacheCopyToggle.checked = keepLocalCacheCopyEnabled;
    return;
  }
  try {
    localCacheSyncInFlight = enabled;
    applyLocalCacheCopyStatus({
      enabled,
      running: enabled,
      state: enabled ? "copying" : "up_to_date",
    });
    const status = await invoke("set_keep_local_cache_copy", {
      workspaceDir: currentWorkspaceDir,
      enabled,
    });
    applyLocalCacheCopyStatus(status);
    if (previousEnabled !== enabled) {
      mainContent.invalidateTreatmentPreviewCache();
    }
    await mainContent.refreshTreatmentFilesForSelection();
    if (enabled) {
      void syncLocalCacheCopy();
    }
  } catch (err) {
    console.error("set_keep_local_cache_copy failed:", err);
    if (keepLocalCacheCopyToggle) keepLocalCacheCopyToggle.checked = keepLocalCacheCopyEnabled;
  } finally {
    localCacheSyncInFlight = false;
    updateLocalCacheDeleteButtonState();
    void refreshLocalCacheCopyStatus();
  }
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
previewSpeedSlider?.addEventListener("input", (e) => {
  const mode = sliderValueToPreviewPerformanceMode(e.target?.value ?? 1);
  setPreviewPerformanceUi(mode);
});
previewSpeedSlider?.addEventListener("change", async (e) => {
  const mode = sliderValueToPreviewPerformanceMode(e.target?.value ?? 1);
  setPreviewPerformanceUi(mode);
  if (!previewSpeedSlider) return;
  previewSpeedSlider.disabled = true;
  try {
    const saved = await invoke("set_preview_performance_mode", { mode });
    setPreviewPerformanceUi(saved);
  } catch (err) {
    console.error("set_preview_performance_mode failed:", err);
    setPreviewPerformanceUi(DEFAULT_PREVIEW_PERFORMANCE_MODE);
  } finally {
    previewSpeedSlider.disabled = false;
  }
});
addPatientBtn?.addEventListener("click", () => {
  if (sidebarLayout.isCompactPatientSidebarMode() && sidebarLayout.isPatientSidebarHidden()) {
    sidebarLayout.setPatientSidebarHidden(false);
    return;
  }
  const isExpanded = addPatientForm?.classList.contains("expanded") ?? false;
  setAddPatientFormVisible(!isExpanded);
});
invalidPatientFoldersBtn?.addEventListener("click", () => {
  if (invalidPatientFolderNames.length + invalidPatientFileNames.length <= 0) return;
  invalidPatientFoldersPanelExpanded = !invalidPatientFoldersPanelExpanded;
  renderInvalidPatientFoldersPanel();
});
confirmAddPatientBtn?.addEventListener("click", async () => {
  if (!currentWorkspaceDir || !isAddPatientFormValid() || confirmAddPatientBtn.disabled) return;
  const lastName = normalizePatientNameForCreate(newPatientLastName?.value);
  const firstName = normalizePatientNameForCreate(newPatientFirstName?.value);
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
    await invoke("open_preview_cache_dir", { workspaceDir: currentWorkspaceDir });
  } catch (err) {
    console.error("open_preview_cache_dir failed:", err);
  }
});
settingsBody?.addEventListener("scroll", syncSettingsHeaderScrollState);
openBtn?.addEventListener("click", () => {
  setTimeout(syncSettingsHeaderScrollState, 0);
});
closeBtn?.addEventListener("click", () => {
  panel?.classList.remove("is-scrolled");
});
overlay?.addEventListener("click", () => {
  panel?.classList.remove("is-scrolled");
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
    previewFillProgressMessage = "";
    void refreshCacheUsageUi();
    void refreshIndexingDebugCounts();
  }
});
void listen("preview-fill-progress", (event) => {
  previewFillProgressMessage = String(event?.payload?.message ?? "").trim();
  void refreshIndexingStatus();
});
void (async () => {
  updateCacheReloadButtonState();
  updateLocalCacheDeleteButtonState();
  syncSettingsHeaderScrollState();
  await refreshLocalCacheCopyStatus();
  await refreshIndexingStatus();
})();
boot();
