import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { getVersion } from "@tauri-apps/api/app";
import confetti from "canvas-confetti";
import { initSidebarLayout } from "./sidebar-layout";
import { initMainContent } from "./main-content";
import { FULL_TRACE } from "./trace-config";

// ---------- DOM ----------
const onboardingView = document.getElementById("onboardingView");
const appView = document.getElementById("appView");
const startupView = document.getElementById("startupView");
const startupProcessText = document.getElementById("startupProcessText");
const startupUpdateNotice = document.getElementById("startupUpdateNotice");
const startupSpinnerPercent = document.getElementById("startupSpinnerPercent");

const pickBtn = document.getElementById("pickWorkspaceBtn");
const pickIcon = document.getElementById("pickWorkspaceIcon");
const onboardingTitle = document.getElementById("onboardingTitle");
const onboardingSubtitle = document.getElementById("onboardingSubtitle");

const openBtn = document.getElementById("openSettings");
const openImportWizardBtn = document.getElementById("openImportWizard");
const closeImportWizardBtn = document.getElementById("closeImportWizard");
const importWizardPanel = document.getElementById("importWizardPanel");
const importWizardLivePreviewToggle = document.getElementById("importWizardLivePreviewToggle");
const importWizardPatientLabel = document.getElementById("importWizardPatientLabel");
const importWizardList = document.getElementById("importWizardList");
const importWizardEmpty = document.getElementById("importWizardEmpty");
const importWizardTreatmentTitle = document.getElementById("importWizardTreatmentTitle");
const importWizardConfirmBtn = document.getElementById("importWizardConfirmBtn");
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
const changeImportWizardBtn = document.getElementById("changeImportWizardBtn");
const importWizardPathEl = document.getElementById("importWizardPath");
const folderIconContainer = document.getElementById("folderIconContainer");
const debugBadge = document.getElementById("debugBadge");
const debugWindowBadge = document.getElementById("debugWindowBadge");
const showFrontendDebugToggle = document.getElementById("showFrontendDebug");
const alwaysShowTimelineNamesToggle = document.getElementById("alwaysShowTimelineNames");
const systemUpdateBtn = document.getElementById("systemUpdateBtn");
const systemUpdateSpinner = document.getElementById("systemUpdateSpinner");
const systemInstallBtn = document.getElementById("systemInstallBtn");
const systemVersionText = document.getElementById("systemVersionText");
const systemUpdateStatusText = document.getElementById("systemUpdateStatusText");
const deleteWorkspaceBtn = document.getElementById("deleteWorkspaceBtn");
const deleteWorkspaceRow = document.getElementById("deleteWorkspaceRow");
const deleteWorkspaceLabel = document.getElementById("deleteWorkspaceLabel");
const deleteDatabaseBtn = document.getElementById("deleteDatabaseBtn");
const deleteDatabaseRow = document.getElementById("deleteDatabaseRow");
const deleteDatabaseLabel = document.getElementById("deleteDatabaseLabel");
const deleteLocalCacheBtn = document.getElementById("deleteLocalCacheBtn");
const deleteLocalCacheRow = document.getElementById("deleteLocalCacheRow");
const deleteLocalCacheLabel = document.getElementById("deleteLocalCacheLabel");
const deleteMainCacheBtn = document.getElementById("deleteMainCacheBtn");
const deleteMainCacheRow = document.getElementById("deleteMainCacheRow");
const deleteMainCacheLabel = document.getElementById("deleteMainCacheLabel");
const openLocalCacheCopyFolderBtn = document.getElementById("openLocalCacheCopyFolderBtn");
const patientSearchInput = document.getElementById("patientSearchInput");
const patientList = document.getElementById("patientList");
const patientListWrap = document.querySelector(".patient-list-wrap");
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
const previewImagesCreatedCount = document.getElementById("previewImagesCreatedCount");
const backgroundPreviewCreationToggle = document.getElementById("backgroundPreviewCreationToggle");
const cacheUsageBar = document.getElementById("cacheUsageBar");
const cacheUsageText = document.getElementById("cacheUsageText");
const indexingCategoryTitle = document.getElementById("indexingCategoryTitle");
const openCacheFolderBtn = document.getElementById("openCacheFolderBtn");
const keepLocalCacheCopyToggle = document.getElementById("keepLocalCacheCopy");
const indexingProgressSpinner = document.getElementById("indexingProgressSpinner");
const indexingProgressText = document.getElementById("indexingProgressText");
const cacheReloadBtn = document.getElementById("cacheReloadBtn");

function previewTrace(scope, message, extra = null) {
  const ts = new Date().toISOString();
  if (extra === null || extra === undefined) {
    console.log(`[preview-trace][main][${scope}][${ts}] ${message}`);
    if (FULL_TRACE) {
      void invoke("preview_trace_client", {
        scope: `main:${scope}`,
        message,
      }).catch(() => {});
    }
    return;
  }
  console.log(`[preview-trace][main][${scope}][${ts}] ${message}`, extra);
  if (FULL_TRACE) {
    void invoke("preview_trace_client", {
      scope: `main:${scope}`,
      message: `${message} ${JSON.stringify(extra)}`,
    }).catch(() => {});
  }
}

function setDebugState(state) {
  if (!debugBadge) return;
  debugBadge.textContent = `debug: (${state})`;
}

function setStartupProcessStatus(message = "") {
  if (!startupProcessText) return;
  const text = String(message ?? "").trim();
  startupProcessText.textContent = text || "Starting application...";
}

function setStartupSpinnerPercent(percent = 0) {
  if (!startupSpinnerPercent) return;
  const safe = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
  startupSpinnerPercent.textContent = `${safe}%`;
}

function setStartupUpdateNoticeVisible(visible) {
  if (!startupUpdateNotice) return;
  startupUpdateNotice.hidden = !visible;
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
    invalidPatientFolderCount > 0;
  const expanded = hasInvalidItems && invalidPatientFoldersPanelExpanded;

  setInvalidPanelExpanded(expanded);
  invalidPatientFoldersPanel.setAttribute("aria-hidden", expanded ? "false" : "true");
  syncInvalidPatientFoldersButtonActiveState();

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
    const ext = fileExtBadgeLabel(fileName);
    item.innerHTML = `
      <span class="invalid-patient-file-ext">${ext}</span>
      <span class="invalid-patient-folder-name">${fileName}</span>
    `;
    invalidPatientFoldersList.appendChild(item);
  }

  if (invalidPatientLoading) {
    const loading = document.createElement("li");
    loading.className = "invalid-patient-folder-item invalid-patient-loading-item";
    loading.innerHTML = `
      <span class="invalid-patient-loading-spinner" aria-hidden="true"></span>
      <span class="invalid-patient-folder-name">Loading Files...</span>
    `;
    invalidPatientFoldersList.appendChild(loading);
  }

  // Keep loading additional invalid entries until list becomes scrollable (or exhausted).
  if (expanded && invalidPatientHasMore && !invalidPatientLoading) {
    requestAnimationFrame(() => {
      if (!invalidPatientFoldersList) return;
      const scrollable = invalidPatientFoldersList.scrollHeight > invalidPatientFoldersList.clientHeight + 4;
      if (scrollable || invalidPatientLoading || !invalidPatientHasMore) return;
      void refreshInvalidPatientFolderWarning(currentWorkspaceDir, { append: true });
    });
  }
}

function isInvalidRenameFormExpanded() {
  return patientFormMode === "invalid_rename" &&
    Boolean(addPatientForm?.classList.contains("expanded"));
}

function syncInvalidPatientFoldersButtonActiveState() {
  if (!invalidPatientFoldersBtn) return;
  const hasInvalidItems = Boolean(currentWorkspaceDir) && invalidPatientFolderCount > 0;
  const active = hasInvalidItems && (invalidPatientFoldersPanelExpanded || isInvalidRenameFormExpanded());
  invalidPatientFoldersBtn.classList.toggle("active", active);
}

function setInvalidPatientFolderWarningUi(count = 0, folderNames = [], fileNames = [], hasMore = false) {
  invalidPatientFolderCount = Math.max(0, Number(count) || 0);
  invalidPatientFolderNames = Array.isArray(folderNames)
    ? folderNames.filter((name) => typeof name === "string" && name.trim().length > 0)
    : [];
  invalidPatientFileNames = Array.isArray(fileNames)
    ? fileNames.filter((name) => typeof name === "string" && name.trim().length > 0)
    : [];
  invalidPatientHasMore = Boolean(hasMore);

  if (!invalidPatientFoldersBtn) return;
  const totalIssues = invalidPatientFolderCount;
  const totalLabel = invalidPatientHasMore ? `${totalIssues}+` : `${totalIssues}`;
  if (invalidPatientFoldersTitle) {
    invalidPatientFoldersTitle.textContent = `${totalLabel} invalid folders or Files`;
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

async function refreshInvalidPatientFolderWarning(workspaceDir = currentWorkspaceDir, { append = false } = {}) {
  if (invalidPatientLoading) return invalidPatientFolderCount;
  if (!workspaceDir) {
    invalidPatientOffset = 0;
    setInvalidPatientFolderWarningUi(0, [], [], false);
    return 0;
  }
  const offset = append ? invalidPatientOffset : 0;
  invalidPatientLoading = true;
  renderInvalidPatientFoldersPanel();
  try {
    const row = await invoke("get_invalid_patient_folders_page", {
      workspaceDir,
      offset,
      limit: INVALID_ITEMS_PAGE_SIZE,
    });
    const count = Number(row?.invalid_count ?? row?.invalidCount ?? 0) || 0;
    const pageFolders = Array.isArray(row?.invalid_folders ?? row?.invalidFolders)
      ? (row?.invalid_folders ?? row?.invalidFolders)
      : [];
    const pageFiles = Array.isArray(row?.invalid_files ?? row?.invalidFiles)
      ? (row?.invalid_files ?? row?.invalidFiles)
      : [];
    const hasMore = Boolean(row?.has_more ?? row?.hasMore ?? false);
    const invalidFolders = append ? [...invalidPatientFolderNames, ...pageFolders] : pageFolders;
    const invalidFiles = append ? [...invalidPatientFileNames, ...pageFiles] : pageFiles;
    invalidPatientOffset = invalidFolders.length + invalidFiles.length;
    setInvalidPatientFolderWarningUi(count, invalidFolders, invalidFiles, hasMore);
    return count;
  } catch (err) {
    console.error("get_invalid_patient_folders_page failed:", err);
    setInvalidPatientFolderWarningUi(0, [], [], false);
    return 0;
  } finally {
    invalidPatientLoading = false;
    renderInvalidPatientFoldersPanel();
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

function fileExtBadgeLabel(name = "", maxLen = 4) {
  const ext = extractExt(name) || "FILE";
  return ext.length > maxLen ? "?" : ext;
}

function normalizeDialogPathSelection(selected) {
  const raw = Array.isArray(selected) ? selected[0] : selected;
  let path = String(raw ?? "").trim();
  if (!path) return "";
  if (path.startsWith("file://")) {
    path = decodeURIComponent(path.replace(/^file:\/\//, ""));
    if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1);
  }
  return path;
}

function isLikelySlowWorkspacePath(path = "") {
  const p = String(path ?? "").trim();
  if (!p) return false;
  if (p.startsWith("\\\\") || p.startsWith("//")) return true;
  if (p.startsWith("/Volumes/")) return true;
  return false;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout(promise, timeoutMs, label = "operation") {
  let timerId = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timerId = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timerId !== null) clearTimeout(timerId);
  }
}

let isWorkspaceSetupInProgress = false;
let onboardingReadyWorkspaceDir = null;
let currentWorkspaceDir = null;
let databaseDeleteLocked = false;
let invalidPatientFolderCount = 0;
let invalidPatientFolderNames = [];
let invalidPatientFileNames = [];
let invalidPatientHasMore = false;
let invalidPatientOffset = 0;
let invalidPatientFoldersPanelExpanded = false;
let invalidPatientLoading = false;
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
let indexingCountsWarmRetryTimerId = null;
let indexingCountsWarmRetryWorkspace = "";
let indexingProgressRunning = false;
let indexingProgressMessage = "Up to date";
let indexingCountsSuffix = "";
let indexingCustomSuffix = "";
let previewImagesCreatedActiveCount = 0;
let previewImagesCreatedDbCount = 0;
let previewFillProgressMessage = "";
let previewFillProgressCompleted = 0;
let previewFillProgressTotal = 0;
let activeViewPreviewLoading = { running: false, completed: 0, total: 0 };
let previewFillPausedForActiveView = false;
let activeViewPrioritySyncInFlight = false;
let manualCacheHoldMode = "";
let keepLocalCacheCopyEnabled = false;
let backgroundPreviewCreationEnabled = false;
let localCacheSyncInFlight = false;
let localCacheStatusPollIntervalId = null;
let workspaceChangeCrawlPollIntervalId = null;
let localCacheStatusState = "up_to_date";
let localCacheStatusRunning = false;
let localCacheStatusCompleted = 0;
let localCacheStatusTotal = 0;
let localCacheFolderExists = false;
let localCacheFileCount = 0;
let isDeleteLocalCacheInFlight = false;
let isDeleteMainCacheInFlight = false;
let previewFillIdleTimerId = null;
let previewFillLastAttemptMs = 0;
let selectedPatient = null;
let selectedPatientId = "";
let addPatientIdTaken = false;
let addPatientIdChecking = false;
let addPatientIdCheckToken = 0;
let addPatientFormHideTimerId = null;
let patientFormMode = "create";
let invalidFolderEditingName = "";
let systemAppVersion = "1.0.13";
let systemUpdateBusy = false;
let systemUpdateInstalling = false;
let systemUpdateCheckedAtMs = null;
let systemUpdateAvailable = false;
let systemUpdateAvailableVersion = "";
let importWizardDir = null;
let importWizardWindowState = null;
let importWizardPreviewWindowState = null;
let importWizardCompactMode = false;
let importWizardRestoreSize = null;
let importWizardPollTimerId = null;
let importWizardIsImporting = false;
let importWizardKnownPaths = new Set();
let importWizardPendingRows = [];
let importWizardNewestProbe = { path: "", size: -1, unchangedTicks: 0 };
let importWizardLastLivePreviewPath = "";
let importWizardPreviewWindow = null;
let importWizardLinkedPatient = null;
const importWizardCleanupByJobId = new Map();
const importingPatientJobCounts = new Map();
const patientEntryCacheByFolder = new Map();
let lastRenderedPatientEntries = [];
let lastRenderedFilterText = "";
let isPatientListLoading = false;
let patientListRenderToken = 0;
let patientSearchOffset = 0;
let patientSearchHasMore = false;
let patientSearchInFlight = false;
let activePatientSearchQuery = "";
let shouldEnsureSelectedPatientVisible = false;
let patientNameTruncationRafId = null;
let slowWorkspaceMode = false;
let initialMainReadyInProgress = false;

const DEBUG_PREF_KEY = "showFrontendDebug";
const TIMELINE_NAMES_PREF_KEY = "alwaysShowTimelineNames";
const DEFAULT_CACHE_SIZE_GB = 5;
const DEFAULT_PREVIEW_PERFORMANCE_MODE = "auto";
const INDEXING_STATUS_POLL_MS = 2500;
const INDEXING_STATUS_POLL_SLOW_MS = 5000;
const LOCAL_CACHE_STATUS_POLL_MS = 3000;
const BACKGROUND_MAINTENANCE_POLL_MS = 10 * 60 * 1000;
const MIN_MANUAL_CACHE_STATUS_MS = 1500;
const PANEL_ANIM_MS = 230;
const PATIENT_LIST_RENDER_BATCH_SIZE = 160;
const PATIENT_LIST_PAGE_SIZE = 250;
const INVALID_ITEMS_PAGE_SIZE = 200;
const PATIENT_FIRSTNAME_EFFECTIVE_MIN_WIDTH_PX = 14;
const WORKSPACE_REINDEX_START_TIMEOUT_MS = 6000;
const WORKSPACE_REINDEX_STATUS_TIMEOUT_MS = 3500;
const WORKSPACE_REINDEX_FALLBACK_TIMEOUT_MS = 180000;
const WORKSPACE_LOAD_OVERALL_TIMEOUT_MS = 600000;
const SEARCH_PATIENTS_TIMEOUT_MS = 120000;
const PREVIEW_FILL_IDLE_DELAY_MS = 2600;
const PREVIEW_FILL_ATTEMPT_COOLDOWN_MS = 12000;
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
const patientDragGhost = document.createElement("canvas");
patientDragGhost.width = 33;
patientDragGhost.height = 30;
patientDragGhost.setAttribute("aria-hidden", "true");
{
  const ctx = patientDragGhost.getContext("2d");
  if (ctx) {
    const drawRoundRect = (x, y, w, h, r) => {
      const radius = Math.max(0, Math.min(r, Math.min(w, h) / 2));
      if (typeof ctx.roundRect === "function") {
        ctx.roundRect(x, y, w, h, radius);
        return;
      }
      ctx.moveTo(x + radius, y);
      ctx.lineTo(x + w - radius, y);
      ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
      ctx.lineTo(x + w, y + h - radius);
      ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
      ctx.lineTo(x + radius, y + h);
      ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
      ctx.lineTo(x, y + radius);
      ctx.quadraticCurveTo(x, y, x + radius, y);
    };
    ctx.clearRect(0, 0, 33, 30);
    ctx.shadowColor = "rgba(37,99,235,0.55)";
    ctx.shadowBlur = 7;
    ctx.fillStyle = "#2563eb";
    ctx.beginPath();
    drawRoundRect(4, 9, 25, 18, 4);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = "#2563eb";
    ctx.beginPath();
    drawRoundRect(18, 6, 10, 4, 2);
    ctx.fill();
  }
}
patientDragGhost.style.position = "fixed";
patientDragGhost.style.left = "-9999px";
patientDragGhost.style.top = "-9999px";
patientDragGhost.style.pointerEvents = "none";
patientDragGhost.style.opacity = "0.98";
document.body.appendChild(patientDragGhost);
const sidebarLayout = initSidebarLayout({
  appView,
  openBtn,
  importWizardBtn: openImportWizardBtn,
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
  onPreviewLoadingStatusChange: (status) => {
    const running = Boolean(status?.running);
    const completed = Math.max(0, Number(status?.completed) || 0);
    const total = Math.max(0, Number(status?.total) || 0);
    activeViewPreviewLoading = { running, completed, total };
    void syncActiveViewPreviewPriority();
    void refreshIndexingStatus();
  },
  onPatientKeywordsChanged: async () => {
    await searchPatients(patientSearchInput?.value ?? "");
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
  if (deleteWorkspaceBtn) deleteWorkspaceBtn.disabled = !enabled || isDeleteLocalCacheInFlight || isDeleteMainCacheInFlight;
  deleteWorkspaceRow?.classList.toggle("inactive", !enabled);
}

function setDeleteDatabaseAvailability(enabled) {
  const available = Boolean(enabled) && !isDbUpdating && !databaseDeleteLocked;
  if (deleteDatabaseBtn) deleteDatabaseBtn.disabled = !available || isDeleteLocalCacheInFlight || isDeleteMainCacheInFlight;
  deleteDatabaseRow?.classList.toggle("inactive", !available);
}

function setDeleteLocalCacheDeletingUi(deleting) {
  const isDeleting = Boolean(deleting);
  deleteLocalCacheRow?.classList.toggle("deleting", isDeleting);
  if (deleteLocalCacheLabel) {
    deleteLocalCacheLabel.textContent = isDeleting ? "Deleting Files..." : "Delete local files";
    deleteLocalCacheLabel.classList.toggle("deleting", isDeleting);
  }
}

function setDeleteMainCacheDeletingUi(deleting) {
  const isDeleting = Boolean(deleting);
  deleteMainCacheRow?.classList.toggle("deleting", isDeleting);
  if (deleteMainCacheLabel) {
    deleteMainCacheLabel.textContent = isDeleting ? "Deleting main Cache..." : "Delete main Cache Files";
    deleteMainCacheLabel.classList.toggle("deleting", isDeleting);
  }
}

function setDebugOnlyRowsVisibility(show) {
  if (deleteWorkspaceRow) deleteWorkspaceRow.hidden = !show;
  if (deleteDatabaseRow) deleteDatabaseRow.hidden = !show;
  if (deleteMainCacheRow) deleteMainCacheRow.hidden = !show;
}

function readDebugVisibilityPref() {
  try {
    const raw = localStorage.getItem(DEBUG_PREF_KEY);
    if (raw === null) return false;
    return raw === "true";
  } catch {
    return false;
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
    if (raw === null) return true;
    return raw === "true";
  } catch {
    return true;
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
  if (state === "copying") return "Copying Images...";
  if (state === "updating") return "Syncing Images...";
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
    deleteLocalCacheBtn.disabled = !enabled || busy || isDeleteLocalCacheInFlight || isDeleteMainCacheInFlight;
  }
  if (openLocalCacheCopyFolderBtn) {
    openLocalCacheCopyFolderBtn.disabled = !currentWorkspaceDir || isDeleteLocalCacheInFlight || isDeleteMainCacheInFlight;
  }
  deleteLocalCacheRow?.classList.toggle("inactive", !enabled);
  const mainDeleteBlocked = Boolean(
    !currentWorkspaceDir ||
    hasActiveImportJobs() ||
    isPreviewFillRunning ||
    isStoppingCacheProcesses ||
    localCacheStatusRunning ||
    localCacheSyncInFlight
  );
  if (deleteMainCacheBtn) {
    deleteMainCacheBtn.disabled = mainDeleteBlocked || isDeleteMainCacheInFlight || isDeleteLocalCacheInFlight;
  }
  deleteMainCacheRow?.classList.toggle("inactive", mainDeleteBlocked);
  if (keepLocalCacheCopyToggle) {
    keepLocalCacheCopyToggle.disabled =
      !currentWorkspaceDir || localCacheSyncInFlight || blocked;
  }
  if (deleteWorkspaceBtn) {
    deleteWorkspaceBtn.disabled = deleteWorkspaceBtn.disabled || isDeleteLocalCacheInFlight;
  }
  if (deleteDatabaseBtn) {
    deleteDatabaseBtn.disabled = deleteDatabaseBtn.disabled || isDeleteLocalCacheInFlight;
  }
}

function applyLocalCacheCopyStatus(status = {}) {
  const enabled = Boolean(status?.enabled);
  keepLocalCacheCopyEnabled = enabled;
  if (keepLocalCacheCopyToggle) keepLocalCacheCopyToggle.checked = enabled;

  const stateRaw = String(status?.state ?? "").trim().toLowerCase();
  const state = enabled ? (stateRaw || "up_to_date") : "up_to_date";
  const stateIsWorking = state === "copying" || state === "updating";
  const running = enabled && stateIsWorking;
  localCacheFolderExists = Boolean(status?.local_cache_exists ?? status?.localCacheExists ?? false);
  localCacheFileCount = Number(status?.local_cache_file_count ?? status?.localCacheFileCount ?? 0) || 0;
  localCacheStatusState = state;
  localCacheStatusRunning = running;
  localCacheStatusCompleted = Math.max(0, Number(status?.completed ?? 0) || 0);
  localCacheStatusTotal = Math.max(localCacheStatusCompleted, Number(status?.total ?? 0) || 0);
  updateLocalCacheDeleteButtonState();
  updateCacheReloadButtonState();
  void refreshIndexingStatus();
}

async function deleteLocalCacheFilesFlow(workspaceDir, { refreshTreatment = true } = {}) {
  localCacheSyncInFlight = true;
  await invoke("set_keep_local_cache_copy", {
    workspaceDir,
    enabled: false,
  });
  applyLocalCacheCopyStatus({ enabled: false, running: false, state: "disabled" });
  await invoke("delete_local_cache_copy_files", {
    workspaceDir,
  });
  mainContent.invalidateTreatmentPreviewCache();
  await refreshCacheUsageUi();
  await refreshLocalCacheCopyStatus();
  if (refreshTreatment) {
    await mainContent.refreshTreatmentFilesForSelection();
  }
  await refreshIndexingStatus();
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

async function triggerWorkspaceChangeCrawl({ requireIdle = true } = {}) {
  if (!currentWorkspaceDir || isDbUpdating || initialMainReadyInProgress) return;
  if (requireIdle && !isIdleForBackgroundMaintenance()) return;
  try {
    await invoke("start_workspace_change_crawl", {
      workspaceDir: currentWorkspaceDir,
      maxPatients: slowWorkspaceMode ? 8 : 16,
    });
  } catch (err) {
    console.error("start_workspace_change_crawl failed:", err);
  }
}

function startWorkspaceChangeCrawlPolling() {
  if (workspaceChangeCrawlPollIntervalId !== null) return;
  workspaceChangeCrawlPollIntervalId = setInterval(() => {
    void runBackgroundMaintenanceTick();
  }, BACKGROUND_MAINTENANCE_POLL_MS);
}

function stopWorkspaceChangeCrawlPolling() {
  if (workspaceChangeCrawlPollIntervalId === null) return;
  clearInterval(workspaceChangeCrawlPollIntervalId);
  workspaceChangeCrawlPollIntervalId = null;
}

async function syncLocalCacheCopy({ manual = false, requireIdle = false } = {}) {
  if (!currentWorkspaceDir || !keepLocalCacheCopyEnabled || localCacheSyncInFlight) return;
  if (requireIdle && !isIdleForBackgroundMaintenance()) return;
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

async function runBackgroundMaintenanceTick() {
  if (!isIdleForBackgroundMaintenance()) return;
  await triggerWorkspaceChangeCrawl({ requireIdle: false });
  if (!isIdleForBackgroundMaintenance()) return;
  await syncLocalCacheCopy({ manual: false, requireIdle: true });
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

function setPreviewImagesCreatedUi(
  activeFolderImageCount = 0,
  dbImageCount = 0,
  { loading = false, updateDbTotal = false } = {}
) {
  if (!previewImagesCreatedCount) return;
  const active = Math.max(0, Number(activeFolderImageCount) || 0);
  const db = Math.max(0, Number(dbImageCount) || 0);
  if (!loading) {
    previewImagesCreatedActiveCount = active;
    if (updateDbTotal) {
      previewImagesCreatedDbCount = db;
    }
  } else if (updateDbTotal) {
    previewImagesCreatedDbCount = db;
  }
  previewImagesCreatedCount.textContent = `(${previewImagesCreatedActiveCount}/${previewImagesCreatedDbCount})`;
}

async function refreshPreviewImagesCreatedDbTotalFromStartup(workspaceDir = currentWorkspaceDir) {
  if (!workspaceDir || startupView?.hidden) return;
  try {
    const dbImageCount = await invoke("get_db_image_count", { workspaceDir });
    setPreviewImagesCreatedUi(previewImagesCreatedActiveCount, dbImageCount, {
      loading: false,
      updateDbTotal: true,
    });
  } catch (err) {
    console.error("get_db_image_count failed:", err);
  }
}

function setIndexingCustomSuffixUi(suffix = "") {
  indexingCustomSuffix = suffix || "";
  renderIndexingProgressText();
}

function setIndexingCategoryTitle(dbImageCount = null, { loading = false } = {}) {
  if (!indexingCategoryTitle) return;
  indexingCategoryTitle.textContent = "INDEXING";
}

async function syncActiveViewPreviewPriority() {
  if (activeViewPrioritySyncInFlight) return;
  activeViewPrioritySyncInFlight = true;
  try {
    const activeViewLoading = Boolean(activeViewPreviewLoading.running && activeViewPreviewLoading.total > 0);
    if (activeViewLoading) {
      if (previewFillPausedForActiveView || !isPreviewFillRunning || isPreviewFillStopInFlight) return;
      try {
        const paused = await invoke("stop_background_preview_fill");
        previewFillPausedForActiveView = Boolean(paused);
      } catch (err) {
        console.error("stop_background_preview_fill for active view failed:", err);
      }
      return;
    }

    if (!previewFillPausedForActiveView) return;
    previewFillPausedForActiveView = false;
    if (!previewFillPausedByUser && !cacheMarkedNotSynchronized) {
      void ensureBackgroundPreviewFill();
    }
  } finally {
    activeViewPrioritySyncInFlight = false;
  }
}

function shouldShowIndexingDebugCounts() {
  return Boolean(currentWorkspaceDir) && Boolean(showFrontendDebugToggle?.checked);
}

function hasActiveImportJobs() {
  return importingPatientJobCounts.size > 0;
}

function isIdleForBackgroundMaintenance() {
  if (!currentWorkspaceDir) return false;
  if (isWorkspaceSetupInProgress || initialMainReadyInProgress) return false;
  if (isDbUpdating || isPatientListLoading || patientSearchInFlight) return false;
  if (importWizardIsImporting || hasActiveImportJobs()) return false;
  if (activeViewPreviewLoading.running) return false;
  if (isPreviewFillRunning || isPreviewFillStopInFlight) return false;
  if (isStoppingCacheProcesses || isCacheMaintenanceRunning) return false;
  if (localCacheSyncInFlight || localCacheStatusRunning) return false;
  return true;
}

function isIdleForBackgroundPreviewFill() {
  if (!isIdleForBackgroundMaintenance()) return false;
  if (slowWorkspaceMode) return false;
  if (previewFillPausedByUser) return false;
  return true;
}

function clearPreviewFillIdleStartTimer() {
  if (previewFillIdleTimerId === null) return;
  clearTimeout(previewFillIdleTimerId);
  previewFillIdleTimerId = null;
}

function scheduleBackgroundPreviewFillWhenIdle() {
  if (previewFillIdleTimerId !== null) return;
  if (!currentWorkspaceDir) return;
  if (!backgroundPreviewCreationEnabled) return;
  if (previewFillPausedByUser || cacheMarkedNotSynchronized) return;

  previewFillIdleTimerId = setTimeout(() => {
    previewFillIdleTimerId = null;
    void ensureBackgroundPreviewFill();
  }, PREVIEW_FILL_IDLE_DELAY_MS);
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
    activeViewPreviewLoading.running ||
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
  if (!sidebarLayout.isSettingsOpen()) return;
  if (!currentWorkspaceDir) {
    setIndexingCategoryTitle(null);
    setIndexingDebugCountsUi(0, 0, { show: false });
    setPreviewImagesCreatedUi(0, 0, { loading: false, updateDbTotal: true });
    return;
  }
  if (indexingDebugCountsInFlight) return;
  indexingDebugCountsInFlight = true;
  try {
    const stats = await invoke("get_preview_debug_counts", { workspaceDir: currentWorkspaceDir });
    const loading = Boolean(stats?.loading);
    const dbImageCount = Number(stats?.db_image_count ?? stats?.dbImageCount ?? 0) || 0;
    const cacheImageCount = Number(stats?.cache_image_count ?? stats?.cacheImageCount ?? 0) || 0;
    setIndexingCategoryTitle(dbImageCount, { loading });
    setPreviewImagesCreatedUi(cacheImageCount, dbImageCount, { loading, updateDbTotal: false });
    setIndexingDebugCountsUi(dbImageCount, cacheImageCount, { show: shouldShowIndexingDebugCounts() });
    if (loading && indexingCountsWarmRetryTimerId === null) {
      const workspaceKey = String(currentWorkspaceDir ?? "").trim();
      if (workspaceKey) {
        indexingCountsWarmRetryWorkspace = workspaceKey;
        indexingCountsWarmRetryTimerId = setTimeout(() => {
          indexingCountsWarmRetryTimerId = null;
          if (String(currentWorkspaceDir ?? "").trim() !== workspaceKey) return;
          if (!sidebarLayout.isSettingsOpen()) return;
          void refreshIndexingDebugCounts();
        }, 650);
      }
      return;
    }
    if (dbImageCount === 0 && cacheImageCount === 0) {
      const workspaceKey = String(currentWorkspaceDir ?? "").trim();
      if (
        workspaceKey &&
        workspaceKey !== indexingCountsWarmRetryWorkspace &&
        indexingCountsWarmRetryTimerId === null
      ) {
        indexingCountsWarmRetryWorkspace = workspaceKey;
        indexingCountsWarmRetryTimerId = setTimeout(() => {
          indexingCountsWarmRetryTimerId = null;
          if (String(currentWorkspaceDir ?? "").trim() !== workspaceKey) return;
          void refreshIndexingDebugCounts();
        }, 450);
      }
    } else {
      indexingCountsWarmRetryWorkspace = "";
      if (indexingCountsWarmRetryTimerId !== null) {
        clearTimeout(indexingCountsWarmRetryTimerId);
        indexingCountsWarmRetryTimerId = null;
      }
    }
  } catch (err) {
    console.error("get_preview_debug_counts failed:", err);
    setIndexingCategoryTitle(null);
    setIndexingDebugCountsUi(0, 0, { show: shouldShowIndexingDebugCounts() });
    setPreviewImagesCreatedUi(0, 0, { loading: false, updateDbTotal: false });
  } finally {
    indexingDebugCountsInFlight = false;
  }
}

async function refreshIndexingStatus() {
  if (!currentWorkspaceDir || indexingStatusInFlight) return;
  indexingStatusInFlight = true;
  try {
    const runningRaw = await invoke("get_preview_fill_status");
    const running = Boolean(runningRaw);
    const importingActive = hasActiveImportJobs();
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
      creatingByManual || importingActive || (running && !organizingByBackend);
    const cacheWorkActive = running || importingActive || manualHoldActive;
    const localCopySyncActive = keepLocalCacheCopyEnabled && (localCacheStatusRunning || localCacheSyncInFlight);
    const localCopyStatusMessage = formatLocalCacheCopyStatusText(localCacheStatusState);
    const activeViewLoading = Boolean(activeViewPreviewLoading.running && activeViewPreviewLoading.total > 0);

    setPreviewFillRunning(running);
    if (activeViewLoading) {
      const completed = Math.max(0, Number(activeViewPreviewLoading.completed) || 0);
      const total = Math.max(0, Number(activeViewPreviewLoading.total) || 0);
      setIndexingProgressUi({ running: true, message: "Creating Previews" });
      setIndexingCustomSuffixUi(total > 0 ? `(${Math.min(completed, total)}/${total})` : "");
      setIndexingDebugCountsUi(0, 0, { show: false });
    } else if (isStoppingCacheProcesses) {
      if (anyCacheTaskRunning) {
        setIndexingProgressUi({ running: true, message: "Stopping processes ..." });
        setIndexingCustomSuffixUi("");
        setIndexingDebugCountsUi(0, 0, { show: false });
      } else {
        isStoppingCacheProcesses = false;
        cacheMarkedNotSynchronized = true;
        setIndexingProgressUi({ running: false, message: "Not synchronized" });
        setIndexingCustomSuffixUi("");
        setIndexingDebugCountsUi(0, 0, { show: false });
      }
    } else if (cacheMarkedNotSynchronized && !anyCacheTaskRunning) {
      setIndexingProgressUi({ running: false, message: "Not synchronized" });
      setIndexingCustomSuffixUi("");
      setIndexingDebugCountsUi(0, 0, { show: false });
    } else if (localCopySyncActive && localCopyStatusMessage) {
      setIndexingProgressUi({ running: true, message: localCopyStatusMessage });
      setIndexingCustomSuffixUi(`(${localCacheStatusCompleted}/${Math.max(localCacheStatusCompleted, localCacheStatusTotal)})`);
      setIndexingDebugCountsUi(0, 0, { show: false });
    } else if (creatingActive) {
      const match = previewFillProgressMessage.match(/\((\d+)\s*\/\s*(\d+)\)/);
      const createdNow = match ? (Number(match[1]) || 0) : Math.max(0, Number(previewFillProgressCompleted) || 0);
      const expectedNow = match ? (Number(match[2]) || 0) : Math.max(0, Number(previewFillProgressTotal) || 0);
      setIndexingProgressUi({ running: true, message: "Creating Previews" });
      setIndexingCustomSuffixUi(`(${createdNow}/${Math.max(createdNow, expectedNow)})`);
      setIndexingDebugCountsUi(0, 0, { show: false });
      void refreshCacheUsageUi();
    } else if (paused) {
      setIndexingProgressUi({ running: false, message: "Paused" });
      setIndexingCustomSuffixUi("");
      setIndexingDebugCountsUi(0, 0, { show: false });
    } else if (!cacheWorkActive) {
      setIndexingProgressUi({ running: false, message: "Up to date" });
      setIndexingCustomSuffixUi("");
      if (shouldShowIndexingDebugCounts()) {
        void refreshIndexingDebugCounts();
      } else {
        setIndexingDebugCountsUi(0, 0, { show: false });
      }
      scheduleBackgroundPreviewFillWhenIdle();
    } else if (organizingActive) {
      setIndexingProgressUi({ running: true, message: "Organizing Cache ..." });
      setIndexingCustomSuffixUi("");
      setIndexingDebugCountsUi(0, 0, { show: false });
    } else {
      setIndexingProgressUi({ running: true, message: "Creating Previews" });
      setIndexingCustomSuffixUi("");
      if (shouldShowIndexingDebugCounts()) {
        void refreshIndexingDebugCounts();
      } else {
        setIndexingDebugCountsUi(0, 0, { show: false });
      }
    }
  } catch (err) {
    console.error("refreshIndexingStatus failed:", err);
  } finally {
    indexingStatusInFlight = false;
  }
}

function startIndexingStatusPolling() {
  if (indexingLivePollIntervalId !== null) return;
  const intervalMs = slowWorkspaceMode ? INDEXING_STATUS_POLL_SLOW_MS : INDEXING_STATUS_POLL_MS;
  indexingLivePollIntervalId = setInterval(() => {
    void refreshIndexingStatus();
  }, intervalMs);
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
  if (!backgroundPreviewCreationEnabled) return;
  if (!currentWorkspaceDir || isPreviewFillRunning || previewFillPausedByUser) return;
  if (!isIdleForBackgroundPreviewFill()) {
    scheduleBackgroundPreviewFillWhenIdle();
    return;
  }
  const now = Date.now();
  if (now - previewFillLastAttemptMs < PREVIEW_FILL_ATTEMPT_COOLDOWN_MS) {
    scheduleBackgroundPreviewFillWhenIdle();
    return;
  }
  previewFillLastAttemptMs = now;
  if (slowWorkspaceMode) {
    setIndexingProgressUi({ running: false, message: "Not synchronized" });
    setIndexingCustomSuffixUi("");
    return;
  }
  try {
    cacheMarkedNotSynchronized = false;
    const counts = await invoke("get_preview_debug_counts", { workspaceDir: currentWorkspaceDir });
    const dbImageCount = Number(counts?.db_image_count ?? counts?.dbImageCount ?? 0) || 0;
    const cacheImageCount = Number(counts?.cache_image_count ?? counts?.cacheImageCount ?? 0) || 0;

    if (dbImageCount > cacheImageCount) {
      if (activeViewPreviewLoading.running) {
        setIndexingProgressUi({ running: false, message: "Not synchronized" });
        scheduleBackgroundPreviewFillWhenIdle();
        return;
      }
      setIndexingProgressUi({ running: true, message: "Creating Previews" });
      const started = await invoke("start_background_preview_fill", { workspaceDir: currentWorkspaceDir });
      if (started) {
        setPreviewFillRunning(true);
      } else {
        setIndexingProgressUi({ running: false, message: "Up to date" });
        scheduleBackgroundPreviewFillWhenIdle();
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
    scheduleBackgroundPreviewFillWhenIdle();
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

async function runManualCacheMaintenance() {
  if (!currentWorkspaceDir || isPreviewFillRunning || isCacheMaintenanceRunning) return;
  const allowBackgroundStartNow = backgroundPreviewCreationEnabled && isIdleForBackgroundPreviewFill();
  previewFillPausedByUser = false;
  cacheMarkedNotSynchronized = false;
  const startedAt = Date.now();
  isCacheMaintenanceRunning = true;
  manualCacheHoldMode = "organizing";
  updateCacheReloadButtonState();
  setIndexingProgressUi({ running: true, message: "Organizing Cache ..." });
  try {
    if (keepLocalCacheCopyEnabled) {
      setIndexingProgressUi({ running: true, message: "Synchronizing Cache ..." });
      await syncLocalCacheCopy({ manual: true, requireIdle: false });
    }

    const counts = await invoke("get_preview_debug_counts", { workspaceDir: currentWorkspaceDir });
    const dbImageCount = Number(counts?.db_image_count ?? counts?.dbImageCount ?? 0) || 0;
    const cacheImageCount = Number(counts?.cache_image_count ?? counts?.cacheImageCount ?? 0) || 0;

    if (dbImageCount > cacheImageCount) {
      if (!allowBackgroundStartNow) {
        setIndexingProgressUi({ running: false, message: "Not synchronized" });
        if (backgroundPreviewCreationEnabled) {
          scheduleBackgroundPreviewFillWhenIdle();
        }
        return;
      }
      if (activeViewPreviewLoading.running) {
        setIndexingProgressUi({ running: false, message: "Not synchronized" });
        scheduleBackgroundPreviewFillWhenIdle();
        return;
      }
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

function setSystemUpdateUi({
  busy = false,
  installing = systemUpdateInstalling,
  version = systemAppVersion,
  checkedAtMs = systemUpdateCheckedAtMs,
  available = systemUpdateAvailable,
  availableVersion = systemUpdateAvailableVersion,
} = {}) {
  const isWorking = Boolean(busy || installing);
  if (systemUpdateBtn) {
    systemUpdateBtn.disabled = isWorking;
    const buttonTitle = busy ? "Searching..." : (installing ? "Installing update..." : "Search for updates");
    systemUpdateBtn.setAttribute("title", buttonTitle);
  }
  if (systemUpdateSpinner) systemUpdateSpinner.hidden = !isWorking;
  if (systemInstallBtn) {
    const showInstallButton = Boolean(available) || Boolean(installing);
    systemInstallBtn.hidden = !showInstallButton;
    systemInstallBtn.disabled = isWorking;
    systemInstallBtn.setAttribute("title", installing ? "Installing update..." : "Install update");
  }
  const safeVersion = String(version || "1.0.13").trim() || "1.0.13";
  if (systemVersionText) {
    systemVersionText.textContent = `Version ${safeVersion}`;
  }
  const nextStatus = (() => {
    if (installing) return "Installing update...";
    if (busy) return "Searching for updates...";
    if (available) {
      const next = String(availableVersion ?? "").trim();
      return next ? `Update available (${next})` : "Update available";
    }
    if (Number.isFinite(Number(checkedAtMs)) && Number(checkedAtMs) > 0) {
      return `Up to date (${formatDateTime(new Date(Number(checkedAtMs)))})`;
    }
    return "Up to date (never checked)";
  })();
  if (systemUpdateStatusText) {
    systemUpdateStatusText.textContent = nextStatus;
  }
}

function setSystemUpdateStatusText(text) {
  const value = String(text ?? "").trim();
  if (!value) return;
  if (systemUpdateStatusText) systemUpdateStatusText.textContent = value;
}

async function searchSystemUpdateNow({ showStartupNotice = false } = {}) {
  if (systemUpdateBusy || systemUpdateInstalling) return;
  systemUpdateBusy = true;
  setSystemUpdateUi({ busy: true });
  try {
    const result = await withTimeout(
      invoke("check_system_update"),
      2800,
      "check_system_update",
    );
    systemUpdateAvailable = Boolean(result?.available);
    systemUpdateAvailableVersion = String(result?.version ?? "").trim();
    systemUpdateCheckedAtMs = Date.now();
    if (showStartupNotice) {
      setStartupUpdateNoticeVisible(systemUpdateAvailable);
    }
  } catch (err) {
    console.error("check_system_update failed:", err);
    if (showStartupNotice) setStartupUpdateNoticeVisible(false);
  } finally {
    systemUpdateBusy = false;
    setSystemUpdateUi({ busy: false });
  }
}

async function installSystemUpdateNow() {
  if (systemUpdateBusy || systemUpdateInstalling || !systemUpdateAvailable) return;
  systemUpdateInstalling = true;
  setSystemUpdateUi({ busy: false, installing: true });
  try {
    const result = await invoke("run_system_update");
    const updated = Boolean(result?.updated);
    const version = String(result?.version ?? "").trim();
    if (updated) {
      if (version) systemAppVersion = version;
      systemUpdateAvailable = false;
      systemUpdateAvailableVersion = "";
      systemUpdateCheckedAtMs = Date.now();
      setStartupUpdateNoticeVisible(false);
      setSystemUpdateStatusText(version ? `Update installed (${version})` : "Update installed");
    } else {
      systemUpdateAvailable = false;
      systemUpdateAvailableVersion = "";
      systemUpdateCheckedAtMs = Date.now();
      setStartupUpdateNoticeVisible(false);
      setSystemUpdateStatusText("Up to date");
    }
  } catch (err) {
    console.error("run_system_update failed:", err);
    setSystemUpdateStatusText("Update failed");
  } finally {
    systemUpdateInstalling = false;
    setSystemUpdateUi({ busy: false, installing: false });
  }
}

async function initSystemUpdateStatus() {
  try {
    const version = await getVersion();
    if (version && String(version).trim()) {
      systemAppVersion = String(version).trim();
    }
    await searchSystemUpdateNow({ showStartupNotice: true });
  } catch (err) {
    console.error("getVersion failed:", err);
  } finally {
    if (!Number.isFinite(Number(systemUpdateCheckedAtMs)) || Number(systemUpdateCheckedAtMs) <= 0) {
      systemUpdateCheckedAtMs = Date.now();
    }
    setSystemUpdateUi({ busy: false });
  }
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
    return {
      folderName: entry,
      patientId: "",
      keywords: [],
      matchedKeywords: [],
      invalidFolder: false,
    };
  }

  const folderName =
    (entry?.folder_name ?? entry?.folderName ?? "").toString();
  const patientId =
    (entry?.patient_id ?? entry?.patientId ?? "").toString().trim();
  const keywordsRaw = Array.isArray(entry?.keywords) ? entry.keywords : [];
  const matchedKeywordsRaw = Array.isArray(entry?.matched_keywords ?? entry?.matchedKeywords)
    ? (entry?.matched_keywords ?? entry?.matchedKeywords)
    : [];
  const normalizeKeywords = (list) => {
    const seen = new Set();
    const out = [];
    for (const value of list) {
      const text = String(value ?? "").trim();
      if (!text) continue;
      const key = text.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(text);
    }
    return out;
  };
  const keywords = normalizeKeywords(keywordsRaw);
  const matchedKeywords = normalizeKeywords(matchedKeywordsRaw);
  const invalidFolder = Boolean(entry?.invalid_folder ?? entry?.invalidFolder ?? false);
  const invalidStart = Boolean(entry?.invalid_start ?? entry?.invalidStart ?? false);

  return { folderName, patientId, keywords, matchedKeywords, invalidFolder, invalidStart };
}

function splitPatientSearchTerms(query = "") {
  const q = String(query ?? "").trim().toLowerCase();
  if (!q) return [];
  if (q.includes(",")) {
    return q
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
  }
  return q
    .split(/\s+/u)
    .map((part) => part.trim())
    .filter(Boolean);
}

function normalizeSearchComparable(value = "") {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function folderNameMatchesSearchTerms(folderName = "", terms = []) {
  const text = normalizeSearchComparable(String(folderName ?? "").trim());
  if (!text || !Array.isArray(terms) || terms.length < 1) return false;
  return terms.every((term) => text.includes(normalizeSearchComparable(term)));
}

async function loadInvalidFolderSearchMatches(workspaceDir, query = "") {
  const workspace = String(workspaceDir ?? "").trim();
  const terms = splitPatientSearchTerms(query);
  if (!workspace || terms.length < 1) return [];
  try {
    const row = await withTimeout(
      invoke("get_invalid_patient_folders_page", {
        workspaceDir: workspace,
        offset: 0,
        limit: 500,
      }),
      12000,
      "get_invalid_patient_folders_page search matches",
    );
    const invalidFolders = Array.isArray(row?.invalid_folders ?? row?.invalidFolders)
      ? (row?.invalid_folders ?? row?.invalidFolders)
      : [];
    return invalidFolders
      .filter((name) => folderNameMatchesSearchTerms(name, terms))
      .map((folderName) => ({
        folderName: String(folderName ?? "").trim(),
        patientId: "",
        keywords: [],
        matchedKeywords: [],
        invalidFolder: true,
        invalidStart: false,
      }))
      .filter((rowEntry) => Boolean(rowEntry.folderName));
  } catch (err) {
    console.error("load invalid folder search matches failed:", err);
    return [];
  }
}

function cachePatientEntries(entries = []) {
  if (!Array.isArray(entries) || entries.length < 1) return;
  for (const entry of entries) {
    const normalized = normalizePatientEntry(entry);
    if (!normalized.folderName) continue;
    patientEntryCacheByFolder.set(normalized.folderName, normalized);
  }
}

function prependSelectedPatientIfMissing(rows = [], query = "") {
  const normalizedQuery = String(query ?? "").trim();
  const selectedFolder = String(selectedPatient ?? "").trim();
  if (normalizedQuery || !selectedFolder) return rows;

  const hasSelected = rows.some((entry) => normalizePatientEntry(entry).folderName === selectedFolder);
  if (hasSelected) return rows;

  const cached = patientEntryCacheByFolder.get(selectedFolder);
  const selectedRow = cached ?? {
    folderName: selectedFolder,
    patientId: String(selectedPatientId ?? "").trim(),
    keywords: [],
    matchedKeywords: [],
  };
  return [selectedRow, ...rows];
}

function mergeUniquePatientRows(existing = [], incoming = []) {
  const seen = new Set(
    existing
      .map((entry) => normalizePatientEntry(entry).folderName)
      .filter(Boolean),
  );
  const uniqueIncoming = [];
  for (const row of incoming) {
    const folderName = normalizePatientEntry(row).folderName;
    if (!folderName || seen.has(folderName)) continue;
    seen.add(folderName);
    uniqueIncoming.push(row);
  }
  return {
    entries: [...existing, ...uniqueIncoming],
    appendedRows: uniqueIncoming,
  };
}

function patientRowsContainFolder(rows = [], folderName = "") {
  const target = String(folderName ?? "").trim();
  if (!target) return false;
  return rows.some((entry) => normalizePatientEntry(entry).folderName === target);
}

function ensureSelectedPatientVisibleInList() {
  if (!shouldEnsureSelectedPatientVisible || !patientList || !patientListWrap) return;
  const selectedFolder = String(selectedPatient ?? "").trim();
  if (!selectedFolder) {
    shouldEnsureSelectedPatientVisible = false;
    return;
  }
  const items = patientList.querySelectorAll(".patient-item");
  let selectedItem = null;
  for (const item of items) {
    if (item?.dataset?.folderName === selectedFolder) {
      selectedItem = item;
      break;
    }
  }
  if (!selectedItem) return;
  shouldEnsureSelectedPatientVisible = false;
  selectedItem.scrollIntoView({ block: "nearest" });
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

function setImportWizardPathDisplay(pathValue) {
  if (!importWizardPathEl) return;
  const normalized = String(pathValue ?? "").trim();
  if (!normalized) {
    importWizardPathEl.textContent = "No folder selected";
    importWizardPathEl.title = "";
    importWizardPathEl.classList.add("no-path");
    updateImportWizardButtonState();
    return;
  }
  importWizardPathEl.textContent = normalized;
  importWizardPathEl.title = normalized;
  importWizardPathEl.classList.remove("no-path");
  updateImportWizardButtonState();
}

function updateImportWizardButtonState() {
  if (!openImportWizardBtn) return;
  const wizardLockActive = Boolean(importWizardLinkedPatient && String(importWizardLinkedPatient).trim());
  const lockPatient = wizardLockActive ? String(importWizardLinkedPatient).trim() : "";
  const hasPatientSelection = Boolean(selectedPatient && String(selectedPatient).trim());
  const hasImportWizardDir = Boolean(importWizardDir && String(importWizardDir).trim());
  const isSelectedLockPatient = hasPatientSelection && String(selectedPatient).trim() === lockPatient;
  openImportWizardBtn.hidden = !hasPatientSelection;
  openImportWizardBtn.disabled =
    !hasPatientSelection ||
    !hasImportWizardDir ||
    (wizardLockActive && !isSelectedLockPatient);
  openImportWizardBtn.classList.toggle("active", wizardLockActive && isSelectedLockPatient);
  if (importWizardPatientLabel) {
    importWizardPatientLabel.textContent = formatWizardPatientLabel();
  }
  sidebarLayout.updateTopButtonSpacing();
}

function setImportWizardLinkedPatient(folderName) {
  const next = String(folderName ?? "").trim() || null;
  if (importWizardLinkedPatient === next) return;
  importWizardLinkedPatient = next;
  renderPatientList(lastRenderedPatientEntries, lastRenderedFilterText);
  updateImportWizardButtonState();
}

async function openImportWizardHelperWindow() {
  if (!currentWorkspaceDir || !selectedPatient || !importWizardDir) return;
  try {
    try {
      const settings = await invoke("load_settings");
      const latestState =
        settings?.import_wizard_window_state ??
        settings?.importWizardWindowState ??
        null;
      importWizardWindowState =
        latestState && typeof latestState === "object" ? latestState : importWizardWindowState;
    } catch (err) {
      console.error("load_settings for import wizard window state failed:", err);
    }

    const { lastName, firstName } = splitPatientName(String(selectedPatient));
    const titleName = firstName ? `${lastName}, ${firstName}` : lastName;
    const windowTitle = titleName;
    const width = 300;
    const height = 200;
    const existing = await WebviewWindow.getByLabel("import_wizard_helper");
    if (existing) {
      await existing.close();
    }
    setImportWizardLinkedPatient(selectedPatient);
    const wizard = new WebviewWindow("import_wizard_helper", {
      title: windowTitle,
      width,
      height,
      minWidth: width,
      minHeight: height,
      maxWidth: width,
      maxHeight: height,
      resizable: false,
      center: true,
      alwaysOnTop: true,
      hiddenTitle: false,
      titleBarStyle: "Visible",
      theme: "Dark",
      url: `import-wizard.html?workspaceDir=${encodeURIComponent(currentWorkspaceDir)}&patientFolder=${encodeURIComponent(selectedPatient)}&importWizardDir=${encodeURIComponent(importWizardDir)}`,
    });
    wizard.once("tauri://error", (event) => {
      setImportWizardLinkedPatient(null);
      console.error("failed to create import wizard window:", event);
    });
    wizard.once("tauri://destroyed", async () => {
      try {
        const stillOpen = await WebviewWindow.getByLabel("import_wizard_helper");
        if (stillOpen) return;
      } catch {
        // ignore and clear lock below
      }
      setImportWizardLinkedPatient(null);
    });
  } catch (err) {
    setImportWizardLinkedPatient(null);
    console.error("open import wizard helper window failed:", err);
  }
}

async function requestImportWizardHelperClose() {
  try {
    const helper = await WebviewWindow.getByLabel("import_wizard_helper");
    if (!helper) {
      setImportWizardLinkedPatient(null);
      return false;
    }
    await helper.emit("import-wizard-request-close");
    return true;
  } catch (err) {
    console.error("request import wizard helper close failed:", err);
    return false;
  }
}

function formatWizardPatientLabel() {
  if (!selectedPatient) return "No patient selected";
  const name = String(selectedPatient);
  return selectedPatientId ? `${name} (${selectedPatientId})` : name;
}

function updateImportWizardConfirmState() {
  if (!importWizardConfirmBtn) return;
  const hasFiles = importWizardPendingRows.length > 0;
  const hasTitle = Boolean(importWizardTreatmentTitle?.value?.trim());
  importWizardConfirmBtn.disabled = !hasFiles || !hasTitle || importWizardIsImporting;
}

function renderImportWizardList() {
  if (!importWizardList || !importWizardEmpty) return;
  importWizardList.innerHTML = "";
  for (const row of importWizardPendingRows) {
    const li = document.createElement("li");
    li.className = "import-wizard-file-item";
    li.textContent = row?.name ? String(row.name) : String(row?.path ?? "");
    li.title = String(row?.path ?? "");
    importWizardList.appendChild(li);
  }
  importWizardEmpty.hidden = importWizardPendingRows.length > 0;
  updateImportWizardConfirmState();
}

function getTodayDateString() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

async function closeImportWizardPreviewWindow() {
  try {
    if (importWizardPreviewWindow) {
      await importWizardPreviewWindow.close();
      importWizardPreviewWindow = null;
    } else {
      const existing = await WebviewWindow.getByLabel("import_wizard_preview");
      if (existing) await existing.close();
    }
    await invoke("close_import_wizard_preview_window").catch(() => {});
  } catch {
    // Ignore close errors for already-closed windows.
  } finally {
    importWizardLastLivePreviewPath = "";
  }
}

function getImportWizardPreviewNavigationPaths() {
  return importWizardPendingRows
    .map((row) => String(row?.path ?? "").trim())
    .filter(Boolean);
}

async function sendImportWizardPreviewPath(path, navigationPaths = null) {
  if (!path || !importWizardLivePreviewToggle?.checked) return;
  const navPaths = Array.isArray(navigationPaths)
    ? navigationPaths.map((entry) => String(entry ?? "").trim()).filter(Boolean)
    : getImportWizardPreviewNavigationPaths();
  const startedAt = performance.now();
  try {
    previewTrace("wizard", "set_import_wizard_preview_state invoke start", {
      path,
      navCount: navPaths.length,
    });
    await invoke("set_import_wizard_preview_state", {
      path,
      navigationPaths: navPaths,
    });
    previewTrace("wizard", "set_import_wizard_preview_state invoke ok", {
      path,
      navCount: navPaths.length,
      ms: Math.round(performance.now() - startedAt),
    });
    const existing = await WebviewWindow.getByLabel("import_wizard_preview");
    if (existing) {
      importWizardPreviewWindow = existing;
    } else {
      const savedWidth = Number(importWizardPreviewWindowState?.width ?? 0);
      const savedHeight = Number(importWizardPreviewWindowState?.height ?? 0);
      const nextWidth = Number.isFinite(savedWidth) && savedWidth > 0 ? savedWidth : 1024;
      const nextHeight = Number.isFinite(savedHeight) && savedHeight > 0 ? savedHeight : 760;
      importWizardPreviewWindow = new WebviewWindow("import_wizard_preview", {
        title: "Import Live Preview",
        width: nextWidth,
        height: nextHeight,
        minWidth: 520,
        minHeight: 420,
        resizable: true,
        center: true,
        url: "import-preview.html",
      });
    }
    const win = importWizardPreviewWindow ?? await WebviewWindow.getByLabel("import_wizard_preview");
    if (!win) return;
    await win.show();
    await win.emit("import-wizard-preview-file", { path, paths: navPaths });
    previewTrace("wizard", "window show+emit done", {
      path,
      navCount: navPaths.length,
      ms: Math.round(performance.now() - startedAt),
    });
    importWizardLastLivePreviewPath = path;
  } catch (err) {
    previewTrace("wizard", "preview window open/emit failed", {
      path,
      navCount: navPaths.length,
      ms: Math.round(performance.now() - startedAt),
      err: String(err ?? ""),
    });
    console.error("import wizard preview window update failed:", err);
  }
}

function stopImportWizardWatcher() {
  if (importWizardPollTimerId !== null) {
    clearInterval(importWizardPollTimerId);
    importWizardPollTimerId = null;
  }
}

async function pollImportWizardFolder() {
  if (!importWizardCompactMode || !importWizardDir) return;
  try {
    const rows = await invoke("list_import_wizard_files", {
      folderDir: importWizardDir,
    });
    const list = Array.isArray(rows) ? rows : [];

    for (const row of list) {
      const path = String(row?.path ?? "").trim();
      if (!path) continue;
      if (!importWizardKnownPaths.has(path)) {
        importWizardKnownPaths.add(path);
        importWizardPendingRows.unshift(row);
      }
    }

    if (list.length > 0) {
      const newest = list[0];
      const newestPath = String(newest?.path ?? "").trim();
      const newestSize = Number(newest?.size ?? -1);
      const newestIsImage = Boolean(newest?.is_image ?? newest?.isImage ?? false);
      if (
        newestPath &&
        newestPath === importWizardNewestProbe.path &&
        newestSize === importWizardNewestProbe.size
      ) {
        importWizardNewestProbe.unchangedTicks += 1;
      } else {
        importWizardNewestProbe = { path: newestPath, size: newestSize, unchangedTicks: 0 };
      }

      if (
        importWizardLivePreviewToggle?.checked &&
        importWizardNewestProbe.path &&
        importWizardNewestProbe.unchangedTicks >= 1 &&
        newestIsImage &&
        importWizardLastLivePreviewPath !== importWizardNewestProbe.path
      ) {
        await sendImportWizardPreviewPath(
          importWizardNewestProbe.path,
          getImportWizardPreviewNavigationPaths(),
        );
      }
    } else {
      importWizardNewestProbe = { path: "", size: -1, unchangedTicks: 0 };
    }

    renderImportWizardList();
  } catch (err) {
    console.error("list_import_wizard_files failed:", err);
  }
}

async function startImportWizardWatcher() {
  stopImportWizardWatcher();
  importWizardKnownPaths = new Set();
  importWizardPendingRows = [];
  importWizardNewestProbe = { path: "", size: -1, unchangedTicks: 0 };
  importWizardLastLivePreviewPath = "";
  renderImportWizardList();
  if (!importWizardDir) return;

  try {
    const rows = await invoke("list_import_wizard_files", {
      folderDir: importWizardDir,
    });
    const baseline = Array.isArray(rows) ? rows : [];
    importWizardKnownPaths = new Set(
      baseline
        .map((row) => String(row?.path ?? "").trim())
        .filter(Boolean),
    );
  } catch (err) {
    console.error("import wizard baseline scan failed:", err);
  }

  importWizardPollTimerId = setInterval(() => {
    void pollImportWizardFolder();
  }, 900);
}

async function confirmImportWizard() {
  if (!currentWorkspaceDir || !selectedPatient || !importWizardDir) return;
  if (!importWizardTreatmentTitle) return;
  const treatmentName = importWizardTreatmentTitle.value.trim();
  if (!treatmentName || importWizardPendingRows.length < 1) return;

  const filePaths = importWizardPendingRows
    .map((row) => String(row?.path ?? "").trim())
    .filter(Boolean);
  if (filePaths.length < 1) return;

  try {
    importWizardIsImporting = true;
    updateImportWizardConfirmState();
    await invoke("start_import_files", {
      workspaceDir: currentWorkspaceDir,
      patientFolder: selectedPatient,
      existingFolder: null,
      date: getTodayDateString(),
      treatmentName,
      filePaths,
      deleteOrigin: false,
    });
    await setImportWizardCompactMode(false);
  } catch (err) {
    console.error("import wizard start_import_files failed:", err);
  } finally {
    importWizardIsImporting = false;
    updateImportWizardConfirmState();
  }
}

async function setImportWizardCompactMode(enabled) {
  if (!appView) return;
  if (importWizardCompactMode === enabled) return;

  const appWindow = getCurrentWindow();
  if (enabled) {
    importWizardCompactMode = true;
    sidebarLayout.closeSettings();
    appView.classList.add("import-wizard-window");
    if (importWizardPanel) importWizardPanel.hidden = false;
    if (importWizardPatientLabel) importWizardPatientLabel.textContent = formatWizardPatientLabel();
    if (importWizardTreatmentTitle) {
      importWizardTreatmentTitle.value = "";
      importWizardTreatmentTitle.focus();
    }
    importWizardIsImporting = false;
    updateImportWizardConfirmState();
    await startImportWizardWatcher();
    if (closeImportWizardBtn) closeImportWizardBtn.hidden = false;
    try {
      const size = await appWindow.innerSize();
      importWizardRestoreSize = {
        width: Number(size?.width ?? 0),
        height: Number(size?.height ?? 0),
      };
      await appWindow.setSize(new LogicalSize(100, 175));
    } catch (err) {
      console.error("enable import wizard compact mode failed:", err);
    }
    return;
  }

  importWizardCompactMode = false;
  appView.classList.remove("import-wizard-window");
  if (importWizardPanel) importWizardPanel.hidden = true;
  if (importWizardTreatmentTitle) importWizardTreatmentTitle.value = "";
  stopImportWizardWatcher();
  importWizardPendingRows = [];
  renderImportWizardList();
  await closeImportWizardPreviewWindow();
  if (closeImportWizardBtn) closeImportWizardBtn.hidden = true;
  if (importWizardRestoreSize?.width && importWizardRestoreSize?.height) {
    try {
      await appWindow.setSize(
        new LogicalSize(importWizardRestoreSize.width, importWizardRestoreSize.height),
      );
    } catch (err) {
      console.error("restore window size after import wizard compact mode failed:", err);
    }
  }
  importWizardRestoreSize = null;
}

function normalizePatientFieldValue(value) {
  return (value ?? "").trim();
}

function normalizePatientNameForCreate(value) {
  return String(value ?? "").replace(/\s+$/u, "");
}

function extractPatientIdFromFolderName(folderName = "") {
  const text = String(folderName ?? "").trim();
  const match = text.match(/\s\(([^()]+)\)\s*$/u);
  return String(match?.[1] ?? "").trim();
}

function setPatientFormMode(mode = "create") {
  patientFormMode = mode === "invalid_rename" ? "invalid_rename" : "create";
  addPatientForm?.classList.toggle("invalid-edit-mode", patientFormMode === "invalid_rename");
  if (confirmAddPatientBtn) {
    confirmAddPatientBtn.setAttribute(
      "aria-label",
      patientFormMode === "invalid_rename" ? "Rename invalid folder" : "Create patient",
    );
  }
  syncInvalidPatientFoldersButtonActiveState();
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
  if (patientFormMode === "invalid_rename") {
    const hasInvalidChars =
      [lastName, firstName, patientId].some((v) =>
        String(v ?? "").includes(",") ||
        String(v ?? "").includes("(") ||
        String(v ?? "").includes(")") ||
        String(v ?? "").includes("/") ||
        String(v ?? "").includes("\\")
      );
    const hasInvalidId = Boolean(patientId) && !isNumericPatientId(patientId);
    return Boolean(
      lastName.trim() &&
      firstName.trim() &&
      patientId &&
      !hasInvalidChars &&
      !hasInvalidId,
    );
  }
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
  const excludeFolderName = patientFormMode === "invalid_rename"
    ? String(invalidFolderEditingName ?? "").trim()
    : null;

  addPatientIdTaken = false;
  addPatientIdChecking = false;
  if (!patientId || !isNumericPatientId(patientId) || !currentWorkspaceDir) {
    updateAddPatientFormState();
    return;
  }

  addPatientIdChecking = true;
  updateAddPatientFormState();
  const taken = await isPatientIdTaken(patientId, { excludeFolderName });
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
  addPatientBtn?.classList.toggle("active", visible && patientFormMode === "create");
  if (!visible) {
    setPatientFormMode("create");
    invalidFolderEditingName = "";
  }
  if (visible) {
    updateAddPatientFormState();
    void checkAddPatientIdUniqueness();
    requestAnimationFrame(() => {
      syncInvalidPatientFoldersButtonActiveState();
    });
    if (patientFormMode === "invalid_rename") {
      newPatientLastName?.focus();
      return;
    }
    newPatientLastName?.focus();
    return;
  }
  syncInvalidPatientFoldersButtonActiveState();
}

function openInvalidFolderRenameForm(folderName = "") {
  const target = String(folderName ?? "").trim();
  if (!target) return;
  const { lastName, firstName } = splitPatientName(target);
  const patientId = extractPatientIdFromFolderName(target);
  invalidFolderEditingName = target;
  setPatientFormMode("invalid_rename");
  if (newPatientLastName) newPatientLastName.value = lastName;
  if (newPatientFirstName) newPatientFirstName.value = firstName;
  if (newPatientId) newPatientId.value = patientId;
  addPatientIdTaken = false;
  addPatientIdChecking = false;
  newPatientId?.classList.remove("duplicate-id");
  setAddPatientFormVisible(true);
  updateAddPatientFormState();
}

function setPatientListLoading(loading) {
  const next = Boolean(loading);
  if (isPatientListLoading === next) return;
  isPatientListLoading = next;
  renderPatientList(lastRenderedPatientEntries, lastRenderedFilterText);
}

function updatePatientSelectionInList() {
  if (!patientList) return;
  const selected = String(selectedPatient ?? "").trim();
  const items = patientList.querySelectorAll(".patient-item");
  for (const item of items) {
    const isSelected = selected && item.dataset.folderName === selected;
    item.classList.toggle("selected", Boolean(isSelected));
  }
}

function updatePatientNameTruncationForItem(item) {
  if (!item || !item.classList.contains("patient-item")) return;
  const first = item.querySelector(".patient-first");
  if (!first) {
    item.classList.remove("truncate-last");
    return;
  }
  if (item.getClientRects().length < 1 || first.getClientRects().length < 1) {
    // Avoid false truncation when the main view is hidden during startup.
    return;
  }
  const firstVisibleWidth = first.getBoundingClientRect().width;
  const firstContentWidth = first.scrollWidth;
  if (firstVisibleWidth <= 0 || firstContentWidth <= 0) {
    return;
  }
  const firstMissing = firstVisibleWidth <= PATIENT_FIRSTNAME_EFFECTIVE_MIN_WIDTH_PX
    || (firstContentWidth > 0 && (firstVisibleWidth / firstContentWidth) < 0.18);
  item.classList.toggle("truncate-last", firstMissing);
}

function refreshPatientNameTruncation() {
  if (!patientList) return;
  const items = patientList.querySelectorAll(".patient-item");
  for (const item of items) {
    updatePatientNameTruncationForItem(item);
  }
}

function schedulePatientNameTruncationRefresh() {
  if (patientNameTruncationRafId !== null) return;
  patientNameTruncationRafId = requestAnimationFrame(() => {
    patientNameTruncationRafId = null;
    refreshPatientNameTruncation();
  });
}

function buildPatientListItem(entry) {
  const {
    folderName,
    patientId,
    keywords,
    matchedKeywords,
    invalidFolder,
    invalidStart,
  } = normalizePatientEntry(entry);
  if (!folderName) return null;
  const { lastName, firstName } = splitPatientName(folderName);
  const item = document.createElement("li");
  item.className = "patient-item";
  if (invalidFolder) item.classList.add("invalid-folder");
  if (invalidFolder && invalidStart) item.classList.add("invalid-start");
  item.dataset.folderName = folderName;
  const wizardLockActive = Boolean(importWizardLinkedPatient && String(importWizardLinkedPatient).trim());
  const isWizardTargetPatient = wizardLockActive && folderName === importWizardLinkedPatient;
  item.draggable = !invalidFolder;
  let dragged = false;
  if (folderName === selectedPatient) {
    item.classList.add("selected");
  }

  if (invalidFolder) {
    const invalidIcon = document.createElement("span");
    invalidIcon.className = "patient-invalid-flag";
    invalidIcon.setAttribute("aria-hidden", "true");
    invalidIcon.innerHTML = `
      <svg class="icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M12 4L21 20H3L12 4Z" fill="currentColor"/>
        <path d="M12 9.8V13.8" stroke="#000000" stroke-width="1.5" stroke-linecap="round"/>
        <circle cx="12" cy="16.7" r="0.9" fill="#000000"/>
      </svg>
    `;
    item.appendChild(invalidIcon);
  }

  if (isWizardTargetPatient) {
    const wizardSpinner = document.createElement("span");
    wizardSpinner.className = "patient-wizard-spinner";
    wizardSpinner.setAttribute("aria-hidden", "true");
    item.appendChild(wizardSpinner);
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

  if (invalidFolder) {
    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "patient-invalid-edit-btn";
    editBtn.setAttribute("aria-label", "Rename invalid folder");
    editBtn.setAttribute("title", "Rename invalid folder");
    editBtn.innerHTML = `
      <svg class="patient-invalid-edit-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M20 10H9L4 12L9 14H20L21.5 12L20 10Z"
          fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M9 10L7 12L9 14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    `;
    editBtn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openInvalidFolderRenameForm(folderName);
    });
    item.appendChild(editBtn);
  }

  const shownKeywords = matchedKeywords.length > 0 ? matchedKeywords : [];
  if (shownKeywords.length > 0) {
    const meta = document.createElement("span");
    meta.className = "patient-keywords";
    meta.textContent = shownKeywords.join(", ");
    meta.title = keywords.length > 0 ? keywords.join(", ") : shownKeywords.join(", ");
    item.appendChild(meta);
  }

  item.addEventListener("click", () => {
    if (invalidFolder) return;
    if (dragged) {
      dragged = false;
      return;
    }
    selectedPatient = folderName;
    selectedPatientId = patientId;
    mainContent.setSelectedPatientHeader({ lastName, firstName, patientId });
    updatePatientSelectionInList();
    updateImportWizardButtonState();
    sidebarLayout.scheduleAutoHidePatientSidebar();
  });

  item.addEventListener("dragstart", (event) => {
    if (invalidFolder) {
      event?.preventDefault?.();
      return;
    }
    dragged = true;
    const dt = event?.dataTransfer;
    if (!dt) return;
    dt.effectAllowed = "copy";
    dt.setData("application/x-mpm-patient-folder-export", folderName);
    dt.setDragImage(patientDragGhost, 17, 15);
  });

  item.addEventListener("dragend", () => {
    if (invalidFolder) {
      dragged = false;
      return;
    }
    if (!currentWorkspaceDir || !folderName) {
      dragged = false;
      return;
    }
    void (async () => {
      try {
        const selected = await open({
          directory: true,
          multiple: false,
          title: "Choose destination folder",
        });
        const destinationDir = normalizeDialogPathSelection(selected);
        if (!destinationDir) {
          dragged = false;
          return;
        }
        await invoke("copy_patient_folder_to_destination", {
          workspaceDir: currentWorkspaceDir,
          patientFolder: folderName,
          destinationDir,
        });
      } catch (err) {
        console.error("copy_patient_folder_to_destination failed:", err);
      } finally {
        dragged = false;
      }
    })();
  });

  return item;
}

function appendPatientListRows(rows) {
  if (!patientList || !Array.isArray(rows) || rows.length < 1) return;
  if (patientList.classList.contains("is-empty-state")) {
    patientList.classList.remove("is-empty-state");
  }
  if (patientList.children.length === 1 && patientList.firstElementChild?.classList.contains("patient-empty")) {
    patientList.innerHTML = "";
  }

  const fragment = document.createDocumentFragment();
  for (const row of rows) {
    const item = buildPatientListItem(row);
    if (item) fragment.appendChild(item);
  }
  patientList.appendChild(fragment);
  schedulePatientNameTruncationRefresh();
  ensureSelectedPatientVisibleInList();
}

function renderPatientList(entries, filterText = "") {
  if (!patientList) return;
  const renderToken = ++patientListRenderToken;
  lastRenderedPatientEntries = entries;
  lastRenderedFilterText = filterText;

  patientList.innerHTML = "";
  patientList.classList.remove("is-empty-state");

  if (isPatientListLoading && !filterText) {
    const loading = document.createElement("li");
    loading.className = "patient-empty";
    loading.textContent = "Loading patients...";
    patientList.appendChild(loading);
    return;
  }

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

  let index = 0;
  const appendBatch = () => {
    if (!patientList || renderToken !== patientListRenderToken) return;
    const fragment = document.createDocumentFragment();
    const nextEnd = Math.min(entries.length, index + PATIENT_LIST_RENDER_BATCH_SIZE);
    while (index < nextEnd) {
      const item = buildPatientListItem(entries[index]);
      index += 1;
      if (item) fragment.appendChild(item);
    }
    patientList.appendChild(fragment);
    schedulePatientNameTruncationRefresh();
    ensureSelectedPatientVisibleInList();
    if (index < entries.length) {
      requestAnimationFrame(appendBatch);
    }
  };
  appendBatch();
}

async function searchPatients(query = "", { append = false } = {}) {
  if (!currentWorkspaceDir) {
    renderPatientList([], query.trim());
    return;
  }
  if (patientSearchInFlight) return;

  const normalizedQuery = String(query ?? "").trim();
  if (!append) {
    patientSearchOffset = 0;
    patientSearchHasMore = false;
    activePatientSearchQuery = normalizedQuery;
  } else {
    if (!patientSearchHasMore) return;
    if (normalizedQuery !== activePatientSearchQuery) return;
  }

  try {
    patientSearchInFlight = true;
    const fetchPage = async (offset) => withTimeout(
      invoke("search_patients_page", {
        workspaceDir: currentWorkspaceDir,
        query: normalizedQuery,
        offset,
        limit: PATIENT_LIST_PAGE_SIZE,
      }),
      SEARCH_PATIENTS_TIMEOUT_MS,
      "search_patients_page",
    );
    const selectedFolder = String(selectedPatient ?? "").trim();
    const shouldLocateSelectedOnClear = !append && !normalizedQuery && Boolean(selectedFolder);
    shouldEnsureSelectedPatientVisible = shouldLocateSelectedOnClear;
    const invalidSearchRows = (!append && normalizedQuery)
      ? await loadInvalidFolderSearchMatches(currentWorkspaceDir, normalizedQuery)
      : [];

    const page = await fetchPage(patientSearchOffset);
    const firstRows = Array.isArray(page?.rows) ? page.rows : [];
    let rawRows = firstRows;
    let hasMore = Boolean(page?.has_more ?? page?.hasMore ?? false);
    let nextOffset = patientSearchOffset + firstRows.length;
    cachePatientEntries(firstRows);

    if (shouldLocateSelectedOnClear && !patientRowsContainFolder(rawRows, selectedFolder)) {
      while (hasMore) {
        const nextPage = await fetchPage(nextOffset);
        const nextRows = Array.isArray(nextPage?.rows) ? nextPage.rows : [];
        if (nextRows.length < 1) {
          hasMore = false;
          break;
        }
        cachePatientEntries(nextRows);
        rawRows = [...rawRows, ...nextRows];
        nextOffset += nextRows.length;
        hasMore = Boolean(nextPage?.has_more ?? nextPage?.hasMore ?? false);
        if (patientRowsContainFolder(rawRows, selectedFolder)) break;
      }
    }

    let rows = append ? rawRows : prependSelectedPatientIfMissing(rawRows, normalizedQuery);
    if (!append && normalizedQuery && invalidSearchRows.length > 0) {
      rows = [
        ...rows,
        ...invalidSearchRows.map((entry, idx) => ({
          ...entry,
          invalidStart: idx === 0,
        })),
      ];
    }
    patientSearchHasMore = hasMore;
    patientSearchOffset = nextOffset;
    if (append) {
      const merged = mergeUniquePatientRows(lastRenderedPatientEntries, rows);
      const entries = merged.entries;
      const rowsToAppend = merged.appendedRows;
      lastRenderedPatientEntries = entries;
      lastRenderedFilterText = normalizedQuery;
      appendPatientListRows(rowsToAppend);
      updatePatientSelectionInList();
    } else {
      renderPatientList(rows, normalizedQuery);
    }
  } catch (err) {
    console.error("search_patients_page failed:", err);
    // Keep app responsive even if patient query is slow or fails.
    renderPatientList(lastRenderedPatientEntries, normalizedQuery);
  } finally {
    patientSearchInFlight = false;
  }
}

async function loadPatients(workspaceDir, options = {}) {
  const minStatusMs = options?.minStatusMs ?? 0;
  const lightweight = Boolean(options?.lightweight);
  const allowBlockingFallback = options?.allowBlockingFallback ?? true;
  const onReindexProgress = typeof options?.onReindexProgress === "function"
    ? options.onReindexProgress
    : null;
  const onStartupStage = typeof options?.onStartupStage === "function"
    ? options.onStartupStage
    : null;
  currentWorkspaceDir = workspaceDir;
  slowWorkspaceMode = isLikelySlowWorkspacePath(workspaceDir);
  invalidPatientOffset = 0;
  const query = patientSearchInput?.value ?? "";
  setPatientListLoading(true);
  setDbStatusUpdating();
  const startedAt = Date.now();
  const loadDeadline = startedAt + WORKSPACE_LOAD_OVERALL_TIMEOUT_MS;
  let reindexFailed = false;
  let lastStartupStageText = "";

  const setStartupStageIfChanged = (text) => {
    const next = String(text ?? "").trim();
    if (!next || next === lastStartupStageText) return;
    lastStartupStageText = next;
    if (onStartupStage) onStartupStage(next);
  };

  try {
    setStartupStageIfChanged("Starting workspace indexing...");
    let startAccepted = await withTimeout(
      invoke("start_workspace_reindex", { workspaceDir }),
      WORKSPACE_REINDEX_START_TIMEOUT_MS,
      "start_workspace_reindex",
    ).catch(() => false);
    if (!startAccepted) {
      setStartupStageIfChanged("Retrying indexing worker startup...");
    }
    let indexedCount = 0;
    while (true) {
      if (Date.now() > loadDeadline) {
        throw new Error("workspace loading exceeded fail-safe timeout");
      }
      const status = await withTimeout(
        invoke("get_workspace_reindex_status"),
        WORKSPACE_REINDEX_STATUS_TIMEOUT_MS,
        "get_workspace_reindex_status",
      ).catch(() => null);
      if (!status) {
        if (!startAccepted && allowBlockingFallback) {
          setStartupStageIfChanged("Running fallback indexing...");
          indexedCount = await withTimeout(
            invoke("reindex_patient_folders", { workspaceDir }),
            WORKSPACE_REINDEX_FALLBACK_TIMEOUT_MS,
            "reindex_patient_folders fallback",
          );
          if (onReindexProgress) onReindexProgress(100);
          break;
        }
        await delay(180);
        continue;
      }
      const statusWorkspaceDir = String(status?.workspace_dir ?? status?.workspaceDir ?? "").trim();
      const running = Boolean(status?.running);
      if (statusWorkspaceDir && statusWorkspaceDir !== workspaceDir) {
        if (!running && !startAccepted) {
          startAccepted = await withTimeout(
            invoke("start_workspace_reindex", { workspaceDir }),
            WORKSPACE_REINDEX_START_TIMEOUT_MS,
            "retry start_workspace_reindex",
          ).catch(() => false);
        }
        await delay(120);
        continue;
      }

      const completed = Number(status?.completed ?? 0) || 0;
      const total = Number(status?.total ?? 0) || 0;
      const statusMessage = String(status?.message ?? "").trim();
      const importingKeywords = /importing keywords/i.test(statusMessage);
      if (running) {
        if (importingKeywords) {
          if (total > 0) {
            setStartupStageIfChanged(`Importing keywords... (${completed}/${total})`);
          } else {
            setStartupStageIfChanged("Importing keywords...");
          }
        } else {
          if (total > 0) {
            setStartupStageIfChanged(`Indexing workspace... (${completed}/${total})`);
          } else {
            setStartupStageIfChanged("Updating database index...");
          }
        }
      }
      if (isDbUpdating && dbStatusText) {
        dbStatusText.textContent = importingKeywords ? "importing keywords..." : "updating...";
      }
      if (!statusWorkspaceDir && !running && !startAccepted && allowBlockingFallback) {
        setStartupStageIfChanged("Running fallback indexing...");
        indexedCount = await invoke("reindex_patient_folders", { workspaceDir });
        if (onReindexProgress) onReindexProgress(100);
        break;
      }
      const rawPercent = total > 0 ? (completed / total) * 100 : (running ? 0 : 100);
      if (onReindexProgress) onReindexProgress(rawPercent);

      const errorMessage = String(status?.error ?? "").trim();
      if (!running) {
        if (errorMessage) {
          throw new Error(errorMessage);
        }
        indexedCount = Number(status?.indexed_count ?? status?.indexedCount ?? completed) || 0;
        break;
      }
      await delay(120);
    }
    console.log(`[patients ${ts()}] indexed ${indexedCount} folders`);
    setStartupStageIfChanged(`Indexing finished (${indexedCount} folders)`);
  } catch (err) {
    console.error("reindex_patient_folders failed:", err);
    setStartupStageIfChanged("Indexing failed, using cached data...");
    reindexFailed = true;
  }

  const elapsedMs = Date.now() - startedAt;
  const remainingMs = minStatusMs - elapsedMs;
  if (remainingMs > 0) {
    await delay(remainingMs);
  }

  if (reindexFailed) {
    isDbUpdating = false;
    if (dbStatusText) dbStatusText.textContent = "Up to date";
    if (dbStatusTime) dbStatusTime.textContent = "using cached index";
    if (dbStatusSpinner) dbStatusSpinner.hidden = true;
    if (dbReloadBtn) dbReloadBtn.disabled = !currentWorkspaceDir;
  } else {
    databaseDeleteLocked = false;
    setDbStatusUpToDate(new Date());
  }

  try {
    setStartupStageIfChanged("Loading patient list...");
    const loadListTask = searchPatients(query);
    const loadInvalidTask = withTimeout(
      refreshInvalidPatientFolderWarning(workspaceDir),
      12000,
      "refreshInvalidPatientFolderWarning",
    ).catch((err) => {
      console.error("refreshInvalidPatientFolderWarning failed:", err);
      return 0;
    });
    const loadTimelineTask = withTimeout(
      mainContent.refreshTimelineForSelection(),
      20000,
      "refreshTimelineForSelection",
    ).catch((err) => {
      console.error("refreshTimelineForSelection failed:", err);
    });
    const loadCountsTask = withTimeout(
      refreshIndexingDebugCounts(),
      12000,
      "refreshIndexingDebugCounts",
    ).catch((err) => {
      console.error("refreshIndexingDebugCounts failed:", err);
    });

      if (lightweight) {
      void loadListTask;
      void loadInvalidTask;
      void loadTimelineTask;
      void loadCountsTask;
    } else {
      await loadListTask;
      setStartupStageIfChanged("Scanning invalid folders...");
      await loadInvalidTask;
      setStartupStageIfChanged("Preparing timeline...");
      await loadTimelineTask;
      setStartupStageIfChanged("Refreshing index counters...");
      await loadCountsTask;
    }
  } finally {
    setPatientListLoading(false);
  }
}

function clearPatients() {
  void setImportWizardCompactMode(false);
  currentWorkspaceDir = null;
  slowWorkspaceMode = false;
  setPatientListLoading(false);
  databaseDeleteLocked = false;
  setImportWizardLinkedPatient(null);
  selectedPatient = null;
  selectedPatientId = "";
  updateImportWizardButtonState();
  importingPatientJobCounts.clear();
  patientEntryCacheByFolder.clear();
  updateCacheReloadButtonState();
  updateLocalCacheDeleteButtonState();
  sidebarLayout.clearAutoHidePatientSidebar();
  sidebarLayout.setPatientSidebarHidden(false);
  if (patientSearchDebounceId !== null) {
    clearTimeout(patientSearchDebounceId);
    patientSearchDebounceId = null;
  }
  if (patientSearchInput) patientSearchInput.value = "";
  patientSearchOffset = 0;
  patientSearchHasMore = false;
  patientSearchInFlight = false;
  activePatientSearchQuery = "";
  shouldEnsureSelectedPatientVisible = false;
  invalidPatientOffset = 0;
  setInvalidPatientFolderWarningUi(0, [], [], false);
  setAddPatientFormVisible(false);
  resetAddPatientForm();
  mainContent.clearSelectedPatientHeader();
  renderPatientList([], "");
  stopLocalCacheStatusPolling();
  clearPreviewFillIdleStartTimer();
  previewFillLastAttemptMs = 0;
  previewFillPausedForActiveView = false;
  activeViewPrioritySyncInFlight = false;
  localCacheFolderExists = false;
  localCacheFileCount = 0;
  applyLocalCacheCopyStatus({
    enabled: keepLocalCacheCopyEnabled,
    running: false,
    state: "up_to_date",
  });
  stopIndexingStatusPolling();
  stopWorkspaceChangeCrawlPolling();
  setPreviewFillRunning(false);
  setIndexingProgressUi({ running: false, message: "Up to date" });
  setIndexingDebugCountsUi(0, 0, { show: false });
  setPreviewImagesCreatedUi(0, 0, { loading: false, updateDbTotal: true });
  setDbStatusIdle();
}

function showMainScreen(workspaceDir) {
  void showMainScreenWithOptions(workspaceDir);
}

async function showMainScreenWithOptions(workspaceDir, options = {}) {
  const skipLoadPatients = options?.skipLoadPatients ?? false;
  const deferShowUntilReady = options?.deferShowUntilReady ?? false;
  console.log(`[transition ${ts()}] showing main screen`);
  if (!deferShowUntilReady && startupView) startupView.hidden = true;
  onboardingView.hidden = true;
  appView.hidden = deferShowUntilReady;
  void setImportWizardCompactMode(false);
  currentWorkspaceDir = workspaceDir;
  setWorkspacePathDisplay(workspaceDir);
  initialMainReadyInProgress = true;
  setStartupProcessStatus("Loading cache state...");
  setStartupSpinnerPercent(0);
  if (!skipLoadPatients) {
    await loadPatients(workspaceDir, {
      onStartupStage: (message) => setStartupProcessStatus(message),
      onReindexProgress: (percent) => setStartupSpinnerPercent(percent),
    });
  } else {
    setStartupSpinnerPercent(82);
  }
  setStartupProcessStatus("Counting indexed images...");
  setStartupSpinnerPercent(92);
  await refreshPreviewImagesCreatedDbTotalFromStartup(workspaceDir);
  setStartupProcessStatus("Loading cache usage...");
  setStartupSpinnerPercent(95);
  const cacheStats = await refreshCacheUsageUi();
  setStartupProcessStatus("Preparing preview maintenance...");
  setStartupSpinnerPercent(97);
  await ensureBackgroundPreviewFill(cacheStats);
  setStartupProcessStatus("Refreshing cache status...");
  setStartupSpinnerPercent(98);
  await refreshLocalCacheCopyStatus();
  setStartupProcessStatus("Refreshing indexing status...");
  setStartupSpinnerPercent(99);
  await refreshIndexingStatus();
  setStartupProcessStatus("Finalizing startup...");
  setStartupSpinnerPercent(100);
  appView.hidden = false;
  if (startupView) startupView.hidden = true;
  updateCacheReloadButtonState();
  updateLocalCacheDeleteButtonState();
  startIndexingStatusPolling();
  startLocalCacheStatusPolling();
  startWorkspaceChangeCrawlPolling();
  sidebarLayout.applyPatientSidebarMode();
  sidebarLayout.setPatientSidebarHidden(false);
  requestAnimationFrame(() => {
    schedulePatientNameTruncationRefresh();
  });
  initialMainReadyInProgress = false;
  void refreshIndexingDebugCounts();
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
    <div class="setup-spinner-wrap">
      <svg class="setup-spinner-svg" viewBox="0 0 240 240" xmlns="http://www.w3.org/2000/svg">
        <circle class="setup-spinner-ring" cx="120" cy="120" r="96"/>
      </svg>
      <span class="setup-spinner-percent" id="setupSpinnerPercent">0%</span>
    </div>
  `;
}

function setOnboardingSetupProgress(percent = 0) {
  const percentEl = document.getElementById("setupSpinnerPercent");
  if (!percentEl) return;
  const safe = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
  percentEl.textContent = `${safe}%`;
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
    setOnboardingSetupProgress(0);
    setOnboardingCopy("Setting Up Database", "Please wait while we complete indexing.");
    let setupTimedOut = false;
    await withTimeout(
      loadPatients(workspaceDir, {
        minStatusMs: 3000,
        onReindexProgress: (percent) => {
          setOnboardingSetupProgress(percent);
        },
      }),
      WORKSPACE_LOAD_OVERALL_TIMEOUT_MS + 5000,
      "initial workspace setup",
    ).catch((err) => {
      setupTimedOut = true;
      console.error("initial workspace setup fallback:", err);
    });

    if (setupTimedOut) {
      setDebugState("ready (setup fallback)");
      showMainScreenWithOptions(workspaceDir, { skipLoadPatients: true });
      void loadPatients(workspaceDir);
      isWorkspaceSetupInProgress = false;
      setOnboardingBusyState(false);
      return;
    }

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

async function pickImportWizardFolderAndSave() {
  try {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Select Import Wizard Folder",
    });
    const nextPath = normalizeDialogPathSelection(selected);
    if (!nextPath) return;
    await invoke("save_import_wizard_dir", { importWizardDir: nextPath });
    importWizardDir = nextPath;
    setImportWizardPathDisplay(importWizardDir);
  } catch (err) {
    console.error("Failed to pick import wizard folder:", err);
  }
}

// ---------- Boot ----------
async function boot() {
  setDebugState("booting");
  setStartupProcessStatus("Loading settings...");
  setStartupUpdateNoticeVisible(false);
  if (startupView) startupView.hidden = false;
  onboardingView.hidden = true;
  appView.hidden = true;
  await initSystemUpdateStatus();

  try {
    const settings = await invoke("load_settings");

    console.log("Loaded settings:", settings);

    const workspaceDir =
      settings?.workspace_dir ??
      settings?.workspaceDir ??
      null;
    const importWizardDirFromSettings =
      settings?.import_wizard_dir ??
      settings?.importWizardDir ??
      null;
    const importWizardWindowStateFromSettings =
      settings?.import_wizard_window_state ??
      settings?.importWizardWindowState ??
      null;
    const importWizardPreviewWindowStateFromSettings =
      settings?.import_wizard_preview_window_state ??
      settings?.importWizardPreviewWindowState ??
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
    const backgroundPreviewCreation = Boolean(
      settings?.background_preview_creation ??
      settings?.backgroundPreviewCreation ??
      false
    );
    keepLocalCacheCopyEnabled = keepLocalCopy;
    backgroundPreviewCreationEnabled = backgroundPreviewCreation;
    if (keepLocalCacheCopyToggle) keepLocalCacheCopyToggle.checked = keepLocalCopy;
    if (backgroundPreviewCreationToggle) {
      backgroundPreviewCreationToggle.checked = backgroundPreviewCreation;
    }
    setCacheSizeUi(cacheSizeGb);
    setPreviewPerformanceUi(previewPerformanceMode);
    importWizardDir = typeof importWizardDirFromSettings === "string"
      ? importWizardDirFromSettings.trim() || null
      : null;
    importWizardWindowState =
      importWizardWindowStateFromSettings &&
      typeof importWizardWindowStateFromSettings === "object"
        ? importWizardWindowStateFromSettings
        : null;
    importWizardPreviewWindowState =
      importWizardPreviewWindowStateFromSettings &&
      typeof importWizardPreviewWindowStateFromSettings === "object"
        ? importWizardPreviewWindowStateFromSettings
        : null;
    setImportWizardPathDisplay(importWizardDir);
    updateImportWizardButtonState();
    console.log("workspaceDir:", workspaceDir);

    if (!workspaceDir) {
      if (startupView) startupView.hidden = true;
      onboardingView.hidden = false;
      appView.hidden = true;
      restoreOnboardingIdleState();
      clearPatients();
      setDebugState("no workspace");
      return;
    }

    setStartupProcessStatus("Preparing workspace...");
    await refreshLocalCacheCopyStatus();
    await showMainScreenWithOptions(workspaceDir, { deferShowUntilReady: true });
    setDebugState("ready");

  } catch (err) {
    console.error("load_settings failed:", err);
    setCacheSizeUi(DEFAULT_CACHE_SIZE_GB);
    setPreviewPerformanceUi(DEFAULT_PREVIEW_PERFORMANCE_MODE);
    backgroundPreviewCreationEnabled = false;
    if (backgroundPreviewCreationToggle) backgroundPreviewCreationToggle.checked = false;
    setSystemUpdateUi({ busy: false });
    await refreshCacheUsageUi();
    if (startupView) startupView.hidden = true;
    onboardingView.hidden = false;
    appView.hidden = true;
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
changeImportWizardBtn?.addEventListener("click", pickImportWizardFolderAndSave);
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
    setImportWizardLinkedPatient(null);
    selectedPatient = null;
    selectedPatientId = "";
    updateImportWizardButtonState();
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
  isDeleteLocalCacheInFlight = true;
  setDeleteLocalCacheDeletingUi(true);
  updateLocalCacheDeleteButtonState();
  setDeleteWorkspaceAvailability(Boolean(showFrontendDebugToggle?.checked));
  setDeleteDatabaseAvailability(Boolean(showFrontendDebugToggle?.checked));
  try {
    await deleteLocalCacheFilesFlow(currentWorkspaceDir, { refreshTreatment: true });
  } catch (err) {
    console.error("delete_local_cache_copy_files failed:", err);
  } finally {
    isDeleteLocalCacheInFlight = false;
    setDeleteLocalCacheDeletingUi(false);
    localCacheSyncInFlight = false;
    updateLocalCacheDeleteButtonState();
    setDeleteWorkspaceAvailability(Boolean(showFrontendDebugToggle?.checked));
    setDeleteDatabaseAvailability(Boolean(showFrontendDebugToggle?.checked));
  }
});
deleteMainCacheBtn?.addEventListener("click", async () => {
  if (!currentWorkspaceDir || deleteMainCacheBtn.disabled) return;
  isDeleteMainCacheInFlight = true;
  isDeleteLocalCacheInFlight = true;
  setDeleteMainCacheDeletingUi(true);
  setDeleteLocalCacheDeletingUi(true);
  updateLocalCacheDeleteButtonState();
  setDeleteWorkspaceAvailability(Boolean(showFrontendDebugToggle?.checked));
  setDeleteDatabaseAvailability(Boolean(showFrontendDebugToggle?.checked));
  try {
    await deleteLocalCacheFilesFlow(currentWorkspaceDir, { refreshTreatment: false });
    await invoke("delete_main_cache_files", {
      workspaceDir: currentWorkspaceDir,
    });
    mainContent.invalidateTreatmentPreviewCache();
    await refreshCacheUsageUi();
    await refreshIndexingDebugCounts();
    await refreshIndexingStatus();
    await mainContent.refreshTreatmentFilesForSelection();
  } catch (err) {
    console.error("delete_main_cache_files failed:", err);
  } finally {
    isDeleteMainCacheInFlight = false;
    isDeleteLocalCacheInFlight = false;
    setDeleteMainCacheDeletingUi(false);
    setDeleteLocalCacheDeletingUi(false);
    updateLocalCacheDeleteButtonState();
    localCacheSyncInFlight = false;
    setDeleteWorkspaceAvailability(Boolean(showFrontendDebugToggle?.checked));
    setDeleteDatabaseAvailability(Boolean(showFrontendDebugToggle?.checked));
  }
});
dbReloadBtn?.addEventListener("click", async () => {
  if (!currentWorkspaceDir || isDbUpdating) return;
  await loadPatients(currentWorkspaceDir, {
    minStatusMs: 300,
    lightweight: true,
    allowBlockingFallback: false,
  });
  void refreshIndexingDebugCounts();
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
  } catch (err) {
    console.error("set_keep_local_cache_copy failed:", err);
    applyLocalCacheCopyStatus({
      enabled: previousEnabled,
      running: false,
      state: previousEnabled ? localCacheStatusState : "disabled",
      completed: localCacheStatusCompleted,
      total: localCacheStatusTotal,
    });
  } finally {
    localCacheSyncInFlight = false;
    updateLocalCacheDeleteButtonState();
    updateCacheReloadButtonState();
    void refreshLocalCacheCopyStatus();
  }
});
backgroundPreviewCreationToggle?.addEventListener("change", async (e) => {
  const enabled = Boolean(e.target?.checked);
  backgroundPreviewCreationEnabled = enabled;
  try {
    await invoke("set_background_preview_creation", { enabled });
    if (!enabled) {
      previewFillPausedByUser = false;
      try {
        await invoke("stop_background_preview_fill");
      } catch (err) {
        console.error("stop_background_preview_fill for background toggle failed:", err);
      }
    } else {
      void ensureBackgroundPreviewFill();
    }
    void refreshIndexingStatus();
  } catch (err) {
    console.error("set_background_preview_creation failed:", err);
    backgroundPreviewCreationEnabled = !enabled;
    if (backgroundPreviewCreationToggle) backgroundPreviewCreationToggle.checked = !enabled;
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
  const wasInvalidRename = patientFormMode === "invalid_rename";
  setPatientFormMode("create");
  invalidFolderEditingName = "";
  resetAddPatientForm();
  if (sidebarLayout.isCompactPatientSidebarMode() && sidebarLayout.isPatientSidebarHidden()) {
    sidebarLayout.setPatientSidebarHidden(false);
    return;
  }
  const isExpanded = addPatientForm?.classList.contains("expanded") ?? false;
  if (isExpanded && wasInvalidRename) {
    setAddPatientFormVisible(true);
    return;
  }
  setAddPatientFormVisible(!isExpanded);
});
invalidPatientFoldersBtn?.addEventListener("click", () => {
  const hasInvalidItems = invalidPatientFolderCount > 0;
  const invalidRenameExpanded = isInvalidRenameFormExpanded();
  if (!hasInvalidItems && !invalidRenameExpanded) return;

  const isActive = hasInvalidItems && (invalidPatientFoldersPanelExpanded || invalidRenameExpanded);
  if (isActive) {
    invalidPatientFoldersPanelExpanded = false;
    renderInvalidPatientFoldersPanel();
    if (invalidRenameExpanded) {
      setAddPatientFormVisible(false);
      resetAddPatientForm();
    }
    return;
  }

  invalidPatientFoldersPanelExpanded = true;
  renderInvalidPatientFoldersPanel();
});
invalidPatientFoldersList?.addEventListener("scroll", () => {
  if (!invalidPatientFoldersPanelExpanded) return;
  if (!invalidPatientHasMore || invalidPatientLoading) return;
  const remaining =
    invalidPatientFoldersList.scrollHeight -
    invalidPatientFoldersList.scrollTop -
    invalidPatientFoldersList.clientHeight;
  if (remaining > 80) return;
  void refreshInvalidPatientFolderWarning(currentWorkspaceDir, { append: true });
});
confirmAddPatientBtn?.addEventListener("click", async () => {
  if (!currentWorkspaceDir || !isAddPatientFormValid() || confirmAddPatientBtn.disabled) return;
  if (patientFormMode === "invalid_rename") {
    const lastName = normalizePatientNameForCreate(newPatientLastName?.value);
    const firstName = normalizePatientNameForCreate(newPatientFirstName?.value);
    const patientId = normalizePatientFieldValue(newPatientId?.value);
    const sourceFolderName = String(invalidFolderEditingName ?? "").trim();
    if (!sourceFolderName || !lastName.trim() || !firstName.trim()) return;
    confirmAddPatientBtn.disabled = true;
    try {
      const renamedFolderName = await invoke("rename_invalid_patient_folder", {
        workspaceDir: currentWorkspaceDir,
        oldFolderName: sourceFolderName,
        lastName,
        firstName,
        patientId,
      });
      setAddPatientFormVisible(false);
      resetAddPatientForm();
      const finalFolderName = String(renamedFolderName ?? "").trim() || sourceFolderName;
      selectedPatient = finalFolderName;
      selectedPatientId = patientId;
      const renamedNameParts = splitPatientName(finalFolderName);
      mainContent.setSelectedPatientHeader({
        lastName: renamedNameParts.lastName,
        firstName: renamedNameParts.firstName,
        patientId,
      });
      if (patientSearchInput) {
        patientSearchInput.value = "";
      }
      await refreshInvalidPatientFolderWarning(currentWorkspaceDir);
      await searchPatients("");
      await mainContent.refreshTimelineForSelection();
      void refreshIndexingStatus();
    } catch (err) {
      console.error("rename_invalid_patient_folder failed:", err);
      confirmAddPatientBtn.disabled = false;
    }
    return;
  }
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
    updateImportWizardButtonState();
    mainContent.setSelectedPatientHeader({ lastName, firstName, patientId });
    await searchPatients("");
    await mainContent.refreshTimelineForSelection();
    void refreshInvalidPatientFolderWarning(currentWorkspaceDir);
    void refreshIndexingStatus();
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
importWizardPathEl?.addEventListener("click", async () => {
  if (!importWizardDir) return;
  try {
    await invoke("open_workspace_dir", { workspaceDir: importWizardDir });
  } catch (err) {
    console.error("open_workspace_dir (import wizard) failed:", err);
  }
});
importWizardLivePreviewToggle?.addEventListener("change", async () => {
  if (!importWizardLivePreviewToggle.checked) {
    await closeImportWizardPreviewWindow();
    return;
  }
  if (importWizardNewestProbe.path && importWizardNewestProbe.unchangedTicks >= 1) {
    await sendImportWizardPreviewPath(
      importWizardNewestProbe.path,
      getImportWizardPreviewNavigationPaths(),
    );
  }
});
importWizardTreatmentTitle?.addEventListener("input", updateImportWizardConfirmState);
importWizardTreatmentTitle?.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  void confirmImportWizard();
});
importWizardConfirmBtn?.addEventListener("click", () => {
  void confirmImportWizard();
});
openImportWizardBtn?.addEventListener("click", async () => {
  if (!selectedPatient || !importWizardDir || openImportWizardBtn.disabled) return;
  const isActiveForSelectedPatient = Boolean(
    importWizardLinkedPatient &&
    String(importWizardLinkedPatient).trim() === String(selectedPatient).trim(),
  );
  if (isActiveForSelectedPatient) {
    await requestImportWizardHelperClose();
    return;
  }
  await openImportWizardHelperWindow();
});
closeImportWizardBtn?.addEventListener("click", async () => {
  await requestImportWizardHelperClose();
  await setImportWizardCompactMode(false);
});
openCacheFolderBtn?.addEventListener("click", async () => {
  try {
    await invoke("open_preview_cache_dir", { workspaceDir: currentWorkspaceDir });
  } catch (err) {
    console.error("open_preview_cache_dir failed:", err);
  }
});
openLocalCacheCopyFolderBtn?.addEventListener("click", async () => {
  if (!currentWorkspaceDir || openLocalCacheCopyFolderBtn.disabled) return;
  try {
    await invoke("open_local_cache_copy_dir");
  } catch (err) {
    console.error("open_local_cache_copy_dir failed:", err);
  }
});
systemUpdateBtn?.addEventListener("click", () => {
  void searchSystemUpdateNow({ showStartupNotice: false });
});
systemInstallBtn?.addEventListener("click", () => {
  void installSystemUpdateNow();
});
settingsBody?.addEventListener("scroll", syncSettingsHeaderScrollState);
openBtn?.addEventListener("click", () => {
  setTimeout(syncSettingsHeaderScrollState, 0);
  requestAnimationFrame(() => {
    if (!sidebarLayout.isSettingsOpen()) return;
    void refreshIndexingDebugCounts();
  });
});
closeBtn?.addEventListener("click", () => {
  panel?.classList.remove("is-scrolled");
});
overlay?.addEventListener("click", () => {
  panel?.classList.remove("is-scrolled");
});

window.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (importWizardCompactMode) {
    void setImportWizardCompactMode(false);
    return;
  }
  if (sidebarLayout.isSettingsOpen()) sidebarLayout.closeSettings();
});
window.addEventListener("resize", updateWindowDebugSize);
window.addEventListener("resize", () => {
  sidebarLayout.applyPatientSidebarMode();
  if (selectedPatient && sidebarLayout.isCompactPatientSidebarMode()) {
    sidebarLayout.setPatientSidebarHidden(true);
  }
  sidebarLayout.updateTopButtonSpacing();
  schedulePatientNameTruncationRefresh();
});
patientSearchInput?.addEventListener("input", (e) => {
  const query = e.target?.value ?? "";
  if (patientSearchDebounceId !== null) clearTimeout(patientSearchDebounceId);
  patientSearchDebounceId = setTimeout(() => {
    searchPatients(query);
  }, 120);
});
patientListWrap?.addEventListener("scroll", () => {
  if (!patientSearchHasMore || patientSearchInFlight) return;
  const remaining = patientListWrap.scrollHeight - patientListWrap.scrollTop - patientListWrap.clientHeight;
  if (remaining > 120) return;
  void searchPatients(activePatientSearchQuery, { append: true });
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
if (/windows/i.test(navigator.userAgent)) {
  appView?.classList.add("platform-windows");
}
sidebarLayout.applyPatientSidebarMode();
sidebarLayout.updateTopButtonSpacing();
updateAddPatientFormState();
renderPatientList([], "");
setPreviewImagesCreatedUi(0, 0, { loading: false, updateDbTotal: true });
void listen("preview-fill-status", (event) => {
  const running = Boolean(event?.payload?.running);
  setPreviewFillRunning(running);
  void syncActiveViewPreviewPriority();
  if (!running) {
    previewFillProgressMessage = "";
    previewFillProgressCompleted = 0;
    previewFillProgressTotal = 0;
    void refreshCacheUsageUi();
    void refreshIndexingDebugCounts();
  }
});
void listen("preview-fill-progress", (event) => {
  const payload = event?.payload ?? {};
  const message = String(payload?.message ?? "").trim();
  const completed = Number(payload?.completed ?? 0) || 0;
  const total = Number(payload?.total ?? 0) || 0;
  previewFillProgressMessage = message;
  previewFillProgressCompleted = Math.max(0, completed);
  previewFillProgressTotal = Math.max(0, total);
  if (message.toLowerCase().includes("creating")) {
    setIndexingCustomSuffixUi(`(${previewFillProgressCompleted}/${Math.max(previewFillProgressCompleted, previewFillProgressTotal)})`);
  }
  void refreshIndexingStatus();
});
void listen("local-cache-copy-progress", (event) => {
  const payload = event?.payload ?? {};
  const stateRaw = String(payload?.state ?? "").trim().toLowerCase();
  const state = stateRaw || localCacheStatusState || "up_to_date";
  const stateIsWorking = state === "copying" || state === "updating";
  const running = keepLocalCacheCopyEnabled && stateIsWorking;
  const completed = Math.max(0, Number(payload?.completed ?? 0) || 0);
  const total = Math.max(completed, Number(payload?.total ?? 0) || 0);
  localCacheStatusState = state;
  localCacheStatusRunning = running;
  localCacheStatusCompleted = completed;
  localCacheStatusTotal = total;
  updateLocalCacheDeleteButtonState();
  updateCacheReloadButtonState();
  void refreshIndexingStatus();
});
void listen("import-wizard-completed", async (event) => {
  const workspace = String(event?.payload?.workspace_dir ?? event?.payload?.workspaceDir ?? "").trim();
  const patient = String(event?.payload?.patient_folder ?? event?.payload?.patientFolder ?? "").trim();
  const targetFolder = String(event?.payload?.target_folder ?? event?.payload?.targetFolder ?? "").trim();
  const jobId = Number(event?.payload?.job_id ?? event?.payload?.jobId ?? 0) || null;
  const wizardDir = String(
    event?.payload?.import_wizard_dir ??
    event?.payload?.importWizardDir ??
    "",
  ).trim();
  if (!workspace || !patient) return;
  if (!currentWorkspaceDir || workspace !== String(currentWorkspaceDir).trim()) return;

  if (jobId && targetFolder && typeof mainContent.registerExternalImportJob === "function") {
    if (wizardDir) {
      importWizardCleanupByJobId.set(jobId, wizardDir);
    }
    mainContent.registerExternalImportJob({
      jobId,
      targetFolder,
      workspaceDir: workspace,
      patientFolder: patient,
    });
  } else {
    void mainContent.refreshTimelineForSelection();
  }

  // Keep event handling non-blocking so progress updates stay smooth during import.
  void (async () => {
    selectedPatient = patient;
    selectedPatientId = "";
    await searchPatients(patientSearchInput?.value ?? "");
    const selectedEntry = (lastRenderedPatientEntries ?? [])
      .map((entry) => normalizePatientEntry(entry))
      .find((entry) => entry.folderName === patient);
    selectedPatientId = String(selectedEntry?.patientId ?? "").trim();
    const { lastName, firstName } = splitPatientName(patient);
    mainContent.setSelectedPatientHeader({ lastName, firstName, patientId: selectedPatientId });
    updateImportWizardButtonState();
  })();
});
void listen("import-progress", async (event) => {
  const payload = event?.payload ?? {};
  const jobId = Number(payload?.job_id ?? payload?.jobId ?? 0) || null;
  if (!jobId) return;
  if (!Boolean(payload?.done)) return;
  const wizardDir = importWizardCleanupByJobId.get(jobId);
  if (!wizardDir) return;
  importWizardCleanupByJobId.delete(jobId);
  try {
    await invoke("clear_import_wizard_preview_cache", { folderDir: wizardDir });
  } catch (err) {
    console.error("clear_import_wizard_preview_cache after import failed:", err);
  }
});
void (async () => {
  updateCacheReloadButtonState();
  updateLocalCacheDeleteButtonState();
  syncSettingsHeaderScrollState();
  await refreshLocalCacheCopyStatus();
  await refreshIndexingStatus();
})();
boot();
