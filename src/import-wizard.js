import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";

const params = new URLSearchParams(window.location.search);
const workspaceDir = String(params.get("workspaceDir") ?? "").trim();
const patientFolder = String(params.get("patientFolder") ?? "").trim();
const importWizardDir = String(params.get("importWizardDir") ?? "").trim();

const livePreviewToggle = document.getElementById("wizardLivePreviewToggle");
const importPanel = document.getElementById("wizardImportPanel");
const importToggle = document.getElementById("wizardImportToggle");
const importCountText = document.getElementById("wizardImportCountText");
const importListWrap = document.getElementById("wizardImportListWrap");
const importList = document.getElementById("wizardImportList");
const filesCountBg = document.getElementById("wizardFilesCountBg");
const actionBtn = document.getElementById("wizardActionBtn");
const treatmentInput = document.getElementById("wizardTreatmentInput");
const closeConfirm = document.getElementById("wizardCloseConfirm");
const discardBtn = document.getElementById("wizardDiscardBtn");
const confirmBtn = document.getElementById("wizardConfirmBtn");

const svg = document.getElementById("doctor-svg");
const pupilL = document.getElementById("pupil-l");
const pupilR = document.getElementById("pupil-r");

let stateTimer = null;
let blinkTimer = null;
let pupilInterval = null;
let pollInterval = null;
let importExpanded = false;
let lastLivePreviewPath = "";
let livePreviewPinnedPath = "";
let livePreviewManuallyClosed = false;
let suppressNextPreviewClosedEvent = false;
let importMode = false;
let importBusy = false;
let importModeFilePaths = [];
let allowWindowClose = false;
let closeConfirmVisible = false;
let livePreviewWindow = null;
let livePreviewConfirmRefreshTimerId = null;
let livePreviewBlockedByImport = false;
const knownPaths = new Set();
const pendingRows = [];
const previewDataUrlByPath = new Map();
const candidateRowsByPath = new Map();

const FILE_DECODE_RETRY_MIN_MS = 250;
const WATCH_FOLDER_POLL_MS = 400;
const PREVIEW_DISPATCH_TIMEOUT_MS = 1500;
let pollInFlight = false;
let lastPreviewDispatchSignature = "";
const WIZARD_TRACE_ENABLED = true;

function wizardTrace(scope, message, extra = null) {
  if (!WIZARD_TRACE_ENABLED) return;
  const ts = new Date().toISOString();
  if (extra === null || extra === undefined) {
    console.log(`[wizard-trace][${scope}][${ts}] ${message}`);
    void invoke("preview_trace_client", {
      scope: `wizard-main:${scope}`,
      message,
    }).catch(() => {});
    return;
  }
  const serialized = JSON.stringify(extra);
  console.log(`[wizard-trace][${scope}][${ts}] ${message}`, extra);
  void invoke("preview_trace_client", {
    scope: `wizard-main:${scope}`,
    message: `${message} ${serialized}`,
  }).catch(() => {});
}

function getPendingPreviewPaths() {
  const seen = new Set();
  const out = [];
  for (const row of pendingRows) {
    const path = String(row?.path ?? "").trim();
    if (!path || seen.has(path)) continue;
    seen.add(path);
    out.push(path);
  }
  return out;
}

function renderImportUi() {
  if (!importPanel || !importCountText || !importListWrap || !importList || !importToggle) return;
  const count = pendingRows.length;
  if (filesCountBg) filesCountBg.textContent = String(count);
  importPanel.hidden = count < 1;
  importToggle.disabled = importMode;
  importCountText.textContent = `${count} Files`;
  const expanded = !importMode && importExpanded && count > 0;
  importToggle.setAttribute("aria-expanded", expanded ? "true" : "false");
  importPanel.classList.toggle("expanded", expanded);
  importPanel.classList.toggle("inactive", importMode);

  if (!expanded || count < 1) return;
  importList.innerHTML = "";
  for (const row of pendingRows) {
    const path = String(row?.path ?? "").trim();
    const name = String(row?.name ?? "").trim() || path;
    const li = document.createElement("li");
    li.className = "wizard-import-item";

    const thumb = document.createElement("span");
    thumb.className = "wizard-import-thumb";
    const dataUrl = previewDataUrlByPath.get(path) || "";
    if (dataUrl) {
      const img = document.createElement("img");
      img.src = dataUrl;
      img.alt = "";
      thumb.appendChild(img);
    }
    li.appendChild(thumb);

    const title = document.createElement("span");
    title.className = "wizard-import-name";
    title.textContent = name;
    title.title = name;
    li.appendChild(title);
    li.addEventListener("click", () => {
      if (!path) return;
      void sendLivePreviewPath(path, getPendingPreviewPaths(), {
        force: true,
        userInitiated: true,
      });
    });

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "wizard-import-remove";
    removeBtn.setAttribute("aria-label", `Remove ${name}`);
    removeBtn.textContent = "×";
    removeBtn.disabled = importMode;
    removeBtn.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (importWizardDir && path) {
        try {
          await invoke("remove_import_wizard_cached_preview", {
            folderDir: importWizardDir,
            path,
          });
        } catch (err) {
          console.error("remove_import_wizard_cached_preview failed:", err);
        }
      }
      previewDataUrlByPath.delete(path);
      const idx = pendingRows.findIndex((entry) => String(entry?.path ?? "").trim() === path);
      if (idx >= 0) pendingRows.splice(idx, 1);
      if (livePreviewPinnedPath === path) livePreviewPinnedPath = "";
      renderImportUi();
      updateActionButtonState();
      void syncLivePreviewNavigation();
    });
    li.appendChild(removeBtn);

    importList.appendChild(li);
  }
}

function getTodayDateString() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function updateActionButtonState() {
  const hasFiles = importMode ? importModeFilePaths.length > 0 : pendingRows.length > 0;
  if (actionBtn) {
    actionBtn.hidden = !hasFiles && !importMode;
  }
  if (livePreviewToggle) {
    livePreviewToggle.disabled = importMode || importBusy;
  }
  if (!actionBtn) return;
  if (!importMode) {
    actionBtn.textContent = "Import";
    actionBtn.disabled = !hasFiles || importBusy;
    if (treatmentInput) treatmentInput.hidden = true;
    return;
  }
  if (treatmentInput) treatmentInput.hidden = false;
  actionBtn.textContent = "Done";
  const hasTreatment = Boolean(String(treatmentInput?.value ?? "").trim());
  actionBtn.disabled = !hasTreatment || !hasFiles || importBusy;
}

function hasPendingImportSelection() {
  if (importMode) return importModeFilePaths.length > 0;
  return pendingRows.length > 0;
}

function setCloseConfirmVisible(visible) {
  closeConfirmVisible = Boolean(visible);
  if (closeConfirm) closeConfirm.hidden = !closeConfirmVisible;
}

async function closeHelperWindowNow() {
  allowWindowClose = true;
  setCloseConfirmVisible(false);
  try {
    await invoke("close_import_wizard_preview_window");
  } catch {
    // ignore preview-close errors
  }
  const current = getCurrentWindow();
  try {
    await current.destroy();
    return;
  } catch {
    // fallback below
  }
  try {
    await invoke("close_import_wizard_helper_window");
    return;
  } catch {
    // final fallback below
  }
  setTimeout(() => {
    if (typeof current.destroy === "function") {
      void current.destroy().catch(() => {});
    } else {
      void current.close().catch(() => {});
    }
  }, 120);
}

async function requestCloseWithWarning() {
  if (importBusy) return;
  if (hasPendingImportSelection()) {
    setCloseConfirmVisible(true);
    return;
  }
  await closeHelperWindowNow();
}

async function clearWizardPreviewCache() {
  if (!importWizardDir) return;
  try {
    await invoke("clear_import_wizard_preview_cache", { folderDir: importWizardDir });
  } catch (err) {
    console.error("clear_import_wizard_preview_cache failed:", err);
  }
}

async function enterImportMode() {
  importMode = true;
  livePreviewBlockedByImport = true;
  livePreviewManuallyClosed = true;
  if (livePreviewToggle) {
    livePreviewToggle.checked = false;
  }
  importModeFilePaths = pendingRows
    .map((row) => String(row?.path ?? "").trim())
    .filter(Boolean);
  importExpanded = false;
  await closeLivePreviewWindow();
  // Safety retry in case preview window was still initializing during first close.
  setTimeout(() => {
    if (!importMode) return;
    void closeLivePreviewWindow();
  }, 120);
  renderImportUi();
  updateActionButtonState();
  if (treatmentInput) {
    treatmentInput.hidden = false;
    treatmentInput.focus();
  }
}

async function runImportDone() {
  if (!workspaceDir || !patientFolder) return;
  const treatmentName = String(treatmentInput?.value ?? "").trim();
  if (!treatmentName || importModeFilePaths.length < 1 || importBusy) return;

  importBusy = true;
  updateActionButtonState();
  const filePaths = [...importModeFilePaths];
  try {
    const result = await invoke("start_import_files", {
      workspaceDir,
      patientFolder,
      existingFolder: null,
      date: getTodayDateString(),
      treatmentName,
      filePaths,
      deleteOrigin: true,
    });
    const jobId = Number(result?.job_id ?? result?.jobId ?? 0) || null;
    await invoke("notify_import_wizard_completed", {
      workspaceDir,
      patientFolder,
      targetFolder: String(result?.target_folder ?? result?.targetFolder ?? "").trim(),
      jobId,
      importWizardDir,
    }).catch(() => {});
    await closeLivePreviewWindow();
    await invoke("close_import_wizard_helper_window").catch(async () => {
      const current = getCurrentWindow();
      try {
        await current.close();
      } catch {
        // ignore
      }
    });
  } catch (err) {
    console.error("import wizard done failed:", err);
  } finally {
    importBusy = false;
    updateActionButtonState();
  }
}

async function ensureWatchFolderPreviewCache() {
  if (!importWizardDir) return;
  try {
    await invoke("ensure_import_wizard_preview_cache", { folderDir: importWizardDir });
  } catch (err) {
    console.error("ensure_import_wizard_preview_cache failed:", err);
  }
}

async function loadLivePreviewToggleSetting() {
  if (!livePreviewToggle) return;
  try {
    const settings = await invoke("load_settings");
    const enabled = Boolean(
      settings?.import_wizard_live_preview ??
      settings?.importWizardLivePreview ??
      false,
    );
    livePreviewToggle.checked = enabled;
  } catch (err) {
    console.error("load_settings for import wizard live preview failed:", err);
    livePreviewToggle.checked = false;
  }
}

async function saveLivePreviewToggleSetting(enabled) {
  try {
    await invoke("set_import_wizard_live_preview", { enabled: Boolean(enabled) });
  } catch (err) {
    console.error("set_import_wizard_live_preview failed:", err);
  }
}

async function fetchPreviewForPath(path) {
  if (!path || previewDataUrlByPath.has(path)) return;
  try {
    const rows = await invoke("get_import_wizard_cached_previews", {
      folderDir: importWizardDir,
      paths: [path],
      includeDataUrl: true,
      generateIfMissing: true,
    });
    const row = Array.isArray(rows) ? rows[0] : null;
    const dataUrl = String(row?.data_url ?? row?.dataUrl ?? "").trim();
    if (dataUrl) {
      previewDataUrlByPath.set(path, dataUrl);
    }
  } catch (err) {
    console.error("get_import_wizard_cached_previews failed:", err);
  }
}

async function invalidateCachedPreview(path) {
  if (!importWizardDir || !path) return;
  try {
    await invoke("remove_import_wizard_cached_preview", {
      folderDir: importWizardDir,
      path,
    });
  } catch {
    // best effort only
  }
}

async function pollWatchFolder() {
  if (pollInFlight) return;
  if (!importWizardDir) return;
  pollInFlight = true;
  const pollStartedAt = performance.now();
  wizardTrace("poll", "start");
  try {
    const rows = await invoke("list_import_wizard_files", { folderDir: importWizardDir });
    const list = (Array.isArray(rows) ? rows : [])
      .slice()
      .sort((a, b) => {
        const aMs = Number(a?.modified_ms ?? a?.modifiedMs ?? a?.created_ms ?? a?.createdMs ?? 0) || 0;
        const bMs = Number(b?.modified_ms ?? b?.modifiedMs ?? b?.created_ms ?? b?.createdMs ?? 0) || 0;
        return bMs - aMs;
      });
    wizardTrace("poll", "list fetched", { totalRows: list.length });
    const now = Date.now();
    const seenCandidatePaths = new Set();
    const previousPendingCount = pendingRows.length;
    let latestAddedPath = "";
    for (const row of list) {
      const path = String(row?.path ?? "").trim();
      const isImage = Boolean(row?.is_image ?? row?.isImage ?? false);
      if (!path || !isImage || knownPaths.has(path)) continue;
      if (pendingRows.some((entry) => String(entry?.path ?? "").trim() === path)) continue;
      seenCandidatePaths.add(path);
      wizardTrace("detect", "candidate seen", { path, size: Number(row?.size ?? 0) || 0 });
      trackImportRowCandidate(row, now);
      if (!await isImportRowDecodable(row, now)) {
        wizardTrace("detect", "candidate not ready yet", { path });
        continue;
      }
      candidateRowsByPath.delete(path);
      knownPaths.add(path);
      pendingRows.unshift(row);
      if (!latestAddedPath) latestAddedPath = path;
      wizardTrace("detect", "candidate accepted", {
        path,
        pendingCount: pendingRows.length,
      });
      void invalidateCachedPreview(path)
        .then(() => fetchPreviewForPath(path))
        .then(renderImportUi);
    }
    for (const path of candidateRowsByPath.keys()) {
      if (!seenCandidatePaths.has(path)) {
        candidateRowsByPath.delete(path);
      }
    }

    renderImportUi();
    updateActionButtonState();
    void syncLivePreviewNavigation();
    const countIncreased = pendingRows.length > previousPendingCount;
    wizardTrace("poll", "post-process", {
      pendingBefore: previousPendingCount,
      pendingAfter: pendingRows.length,
      countIncreased,
      latestAddedPath,
    });
    if (
      !importMode &&
      !livePreviewBlockedByImport &&
      livePreviewToggle?.checked &&
      countIncreased &&
      latestAddedPath &&
      latestAddedPath !== lastLivePreviewPath
    ) {
      livePreviewManuallyClosed = false;
      livePreviewPinnedPath = "";
      if (livePreviewConfirmRefreshTimerId !== null) {
        clearTimeout(livePreviewConfirmRefreshTimerId);
        livePreviewConfirmRefreshTimerId = null;
      }
      requestAnimationFrame(() => {
        wizardTrace("preview", "dispatch newest accepted", {
          path: latestAddedPath,
          navCount: getPendingPreviewPaths().length,
        });
        void sendLivePreviewPath(latestAddedPath, getPendingPreviewPaths(), { force: true });
      });
      // Re-emit shortly after first detection to avoid a white first frame
      // when camera copy finishes a moment later.
      livePreviewConfirmRefreshTimerId = setTimeout(() => {
        livePreviewConfirmRefreshTimerId = null;
        if (importMode || livePreviewBlockedByImport) return;
        if (!livePreviewToggle?.checked) return;
        if (livePreviewPinnedPath) return;
        if (!pendingRows.some((entry) => String(entry?.path ?? "").trim() === latestAddedPath)) return;
        wizardTrace("preview", "dispatch delayed confirm refresh", {
          path: latestAddedPath,
          navCount: getPendingPreviewPaths().length,
        });
        void sendLivePreviewPath(latestAddedPath, getPendingPreviewPaths(), { force: true });
      }, 900);
    }
  } catch (err) {
    wizardTrace("poll", "failed", { err: String(err ?? "") });
    console.error("list_import_wizard_files failed:", err);
  } finally {
    wizardTrace("poll", "end", { ms: Math.round(performance.now() - pollStartedAt) });
    pollInFlight = false;
  }
}

async function withTimeout(promise, timeoutMs, label) {
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = window.setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== null) {
      clearTimeout(timer);
    }
  }
}

function trackImportRowCandidate(row, nowMs = Date.now()) {
  const path = String(row?.path ?? "").trim();
  if (!path) return;
  const size = Number(row?.size ?? 0);
  const prev = candidateRowsByPath.get(path);
  if (!prev) {
    candidateRowsByPath.set(path, {
      size,
      firstSeenAtMs: nowMs,
      decodeReady: false,
      decodeCheckInFlight: false,
      lastDecodeAttemptAtMs: 0,
      decodeFingerprint: "",
      decodeStablePasses: 0,
    });
    return;
  }
  const sizeChanged = prev.size !== size;
  const firstSeenAtMs = Number(prev.firstSeenAtMs ?? nowMs) || nowMs;
  candidateRowsByPath.set(path, {
    size,
    firstSeenAtMs,
    decodeReady: sizeChanged ? false : Boolean(prev.decodeReady),
    decodeCheckInFlight: sizeChanged ? false : Boolean(prev.decodeCheckInFlight),
    lastDecodeAttemptAtMs: sizeChanged ? 0 : (Number(prev.lastDecodeAttemptAtMs ?? 0) || 0),
    decodeFingerprint: sizeChanged ? "" : String(prev.decodeFingerprint ?? ""),
    decodeStablePasses: sizeChanged ? 0 : (Number(prev.decodeStablePasses ?? 0) || 0),
  });
}

async function isImportRowDecodable(row, nowMs = Date.now()) {
  const path = String(row?.path ?? "").trim();
  if (!path) return false;
  const prev = candidateRowsByPath.get(path);
  if (!prev) return false;
  if (Boolean(prev.decodeReady)) return true;
  if (Boolean(prev.decodeCheckInFlight)) return false;
  const lastAttemptAtMs = Number(prev.lastDecodeAttemptAtMs ?? 0) || 0;
  if (lastAttemptAtMs > 0 && (nowMs - lastAttemptAtMs) < FILE_DECODE_RETRY_MIN_MS) return false;

  candidateRowsByPath.set(path, {
    ...prev,
    decodeCheckInFlight: true,
    lastDecodeAttemptAtMs: nowMs,
  });

  try {
    const result = await invoke("validate_import_wizard_image_complete", { path });
    const readyNow = Boolean(result?.ready ?? result === true);
    const fingerprint = String(result?.fingerprint ?? "").trim();
    const current = candidateRowsByPath.get(path);
    if (current) {
      const prevFingerprint = String(current.decodeFingerprint ?? "");
      const stablePasses = readyNow && fingerprint && fingerprint === prevFingerprint
        ? ((Number(current.decodeStablePasses ?? 0) || 0) + 1)
        : (readyNow ? 1 : 0);
      const readyAccepted = readyNow && stablePasses >= 2;
      wizardTrace("decode", "validation result", {
        path,
        readyNow,
        stablePasses,
        readyAccepted,
        size: Number(result?.size ?? 0) || 0,
      });
      candidateRowsByPath.set(path, {
        ...current,
        decodeReady: readyAccepted,
        decodeCheckInFlight: false,
        lastDecodeAttemptAtMs: nowMs,
        decodeFingerprint: readyNow ? fingerprint : "",
        decodeStablePasses: stablePasses,
      });
      return readyAccepted;
    }
    return false;
  } catch {
    wizardTrace("decode", "validation failed", { path });
    const current = candidateRowsByPath.get(path);
    if (current) {
      candidateRowsByPath.set(path, {
        ...current,
        decodeReady: false,
        decodeCheckInFlight: false,
        lastDecodeAttemptAtMs: nowMs,
        decodeFingerprint: "",
        decodeStablePasses: 0,
      });
    }
    return false;
  }
}

async function closeLivePreviewWindow() {
  suppressNextPreviewClosedEvent = true;
  setTimeout(() => {
    suppressNextPreviewClosedEvent = false;
  }, 600);
  try {
    let closed = false;
    if (livePreviewWindow) {
      try {
        await livePreviewWindow.close();
        closed = true;
      } catch (err) {
        wizardTrace("preview", "close cached handle failed", { err: String(err ?? "") });
      }
    }
    if (!closed) {
      try {
        const existing = await WebviewWindow.getByLabel("import_wizard_preview");
        if (existing) {
          await existing.close();
          closed = true;
        }
      } catch (err) {
        wizardTrace("preview", "close by label failed", { err: String(err ?? "") });
      }
    }
    try {
      await invoke("close_import_wizard_preview_window");
    } catch (err) {
      wizardTrace("preview", "rust close command failed", { err: String(err ?? "") });
    }
    wizardTrace("preview", "close requested", { closed });
  } finally {
    livePreviewWindow = null;
    if (livePreviewConfirmRefreshTimerId !== null) {
      clearTimeout(livePreviewConfirmRefreshTimerId);
      livePreviewConfirmRefreshTimerId = null;
    }
    lastLivePreviewPath = "";
    livePreviewPinnedPath = "";
    lastPreviewDispatchSignature = "";
  }
}

async function sendLivePreviewPath(path, navigationPaths = null, options = {}) {
  const force = Boolean(options?.force);
  const userInitiated = Boolean(options?.userInitiated);
  if (!path) return;
  if (livePreviewBlockedByImport && !userInitiated) {
    wizardTrace("preview", "dispatch skipped (blocked by import)", { path });
    return;
  }
  if (importMode) {
    wizardTrace("preview", "dispatch skipped (import mode)", { path });
    return;
  }
  if (!force && !livePreviewToggle?.checked) return;
  const navPaths = Array.isArray(navigationPaths) ? navigationPaths : getPendingPreviewPaths();
  const normalizedNavPaths = navPaths.map((entry) => String(entry ?? "").trim()).filter(Boolean);
  const signature = `${String(path ?? "").trim()}::${normalizedNavPaths.join("|")}`;
  if (!force && !userInitiated && signature === lastPreviewDispatchSignature) {
    wizardTrace("preview", "dispatch skipped (same signature)", { path });
    return;
  }
  try {
    wizardTrace("preview", "dispatch start", {
      path,
      navCount: normalizedNavPaths.length,
      force,
      userInitiated,
    });
    await withTimeout(
      invoke("set_import_wizard_preview_state", {
        path,
        navigationPaths: normalizedNavPaths,
      }),
      PREVIEW_DISPATCH_TIMEOUT_MS,
      "set_import_wizard_preview_state",
    );
    const existing = await WebviewWindow.getByLabel("import_wizard_preview");
    if (existing) {
      livePreviewWindow = existing;
    } else {
      livePreviewWindow = new WebviewWindow("import_wizard_preview", {
        title: "Import Live Preview",
        width: 1024,
        height: 760,
        minWidth: 520,
        minHeight: 420,
        resizable: true,
        center: true,
        url: "import-preview.html",
      });
    }
    const win = livePreviewWindow ?? await WebviewWindow.getByLabel("import_wizard_preview");
    if (!win) return;
    // Do not block the poll loop on show/permission.
    void win.show().catch(() => {});
    await win.emit("import-wizard-preview-file", { path, paths: normalizedNavPaths });
    wizardTrace("preview", "dispatch emitted", {
      path,
      navCount: normalizedNavPaths.length,
      force,
      userInitiated,
    });
    lastLivePreviewPath = path;
    if (userInitiated) {
      livePreviewPinnedPath = path;
    }
    lastPreviewDispatchSignature = signature;
    if (force || userInitiated) {
      livePreviewManuallyClosed = false;
    }
  } catch (err) {
    livePreviewWindow = null;
    wizardTrace("preview", "dispatch failed", { path, err: String(err ?? "") });
    console.error("import wizard live preview update failed:", err);
  }
}

async function syncLivePreviewNavigation() {
  if (livePreviewBlockedByImport) return;
  if (!livePreviewToggle?.checked || importMode) return;
  if (livePreviewManuallyClosed) return;
  const navPaths = getPendingPreviewPaths();
  if (navPaths.length < 1) {
    await closeLivePreviewWindow();
    lastPreviewDispatchSignature = "";
    return;
  }
  const activePath = navPaths.includes(livePreviewPinnedPath)
    ? livePreviewPinnedPath
    : navPaths[0];
  if (!activePath) return;
  wizardTrace("preview", "sync navigation dispatch", {
    activePath,
    navCount: navPaths.length,
    pinnedPath: livePreviewPinnedPath,
  });
  void sendLivePreviewPath(activePath, navPaths);
}

function initDoctorAnimation() {
  if (!svg || !pupilL || !pupilR) return;
  svg.classList.add("awake");
  svg.classList.remove("dozing");

  const movePupils = () => {
    if (!svg.classList.contains("awake")) return;
    const offsetX = (Math.random() - 0.5) * 7;
    const offsetY = (Math.random() - 0.5) * 6;
    pupilL.setAttribute("cx", String(90 + offsetX));
    pupilL.setAttribute("cy", String(100 + offsetY));
    pupilR.setAttribute("cx", String(110 + offsetX));
    pupilR.setAttribute("cy", String(100 + offsetY));
  };

  const scheduleNextState = () => {
    if (stateTimer) clearTimeout(stateTimer);
    if (svg.classList.contains("awake")) {
      stateTimer = setTimeout(() => {
        svg.classList.remove("awake");
        svg.classList.add("dozing");
        if (blinkTimer) clearTimeout(blinkTimer);
        scheduleNextState();
      }, 12000 + Math.random() * 8000);
    } else {
      stateTimer = setTimeout(() => {
        svg.classList.add("awake");
        svg.classList.remove("dozing");
        movePupils();
        scheduleBlink();
        scheduleNextState();
      }, 2000 + Math.random() * 4000);
    }
  };

  const triggerBlink = () => {
    if (!svg.classList.contains("awake")) return;
    svg.classList.add("blinking");
    setTimeout(() => svg.classList.remove("blinking"), 600);
    scheduleBlink();
  };

  const scheduleBlink = () => {
    if (blinkTimer) clearTimeout(blinkTimer);
    if (!svg.classList.contains("awake")) return;
    const next = 3000 + Math.random() * 6000;
    blinkTimer = setTimeout(triggerBlink, next);
  };

  svg.addEventListener("mousemove", () => {
    svg.classList.add("awake");
    svg.classList.remove("dozing");
    if (stateTimer) clearTimeout(stateTimer);
    scheduleNextState();
    scheduleBlink();
  });

  movePupils();
  pupilInterval = setInterval(() => {
    if (svg.classList.contains("awake")) movePupils();
  }, 2200);
  setTimeout(movePupils, 700);
  scheduleNextState();
  scheduleBlink();
}

function cleanup() {
  if (stateTimer) clearTimeout(stateTimer);
  if (blinkTimer) clearTimeout(blinkTimer);
  if (pupilInterval) clearInterval(pupilInterval);
  if (pollInterval) clearInterval(pollInterval);
  if (livePreviewConfirmRefreshTimerId !== null) {
    clearTimeout(livePreviewConfirmRefreshTimerId);
    livePreviewConfirmRefreshTimerId = null;
  }
  candidateRowsByPath.clear();
  void closeLivePreviewWindow();
  importModeFilePaths = [];
  if (!importBusy) {
    void clearWizardPreviewCache();
  }
}

async function init() {
  initDoctorAnimation();
  await loadLivePreviewToggleSetting();
  await ensureWatchFolderPreviewCache();

  if (importToggle) {
    importToggle.addEventListener("click", () => {
      livePreviewManuallyClosed = true;
      void closeLivePreviewWindow();
      if (importMode) return;
      importExpanded = !importExpanded;
      renderImportUi();
    });
  }
  if (actionBtn) {
    actionBtn.addEventListener("click", () => {
      if (!importMode) {
        livePreviewBlockedByImport = true;
        livePreviewManuallyClosed = true;
        void closeLivePreviewWindow();
      }
      if (!importMode) {
        void enterImportMode();
        return;
      }
      void runImportDone();
    });
  }
  if (discardBtn) {
    discardBtn.addEventListener("click", () => {
      setCloseConfirmVisible(false);
    });
  }
  if (confirmBtn) {
    confirmBtn.addEventListener("click", () => {
      void closeHelperWindowNow();
    });
  }
  void listen("import-wizard-request-close", () => {
    void requestCloseWithWarning();
  });
  void listen("import-wizard-preview-window-closed", () => {
    livePreviewWindow = null;
    if (suppressNextPreviewClosedEvent) {
      suppressNextPreviewClosedEvent = false;
      return;
    }
    if (!livePreviewToggle?.checked || importMode) return;
    livePreviewManuallyClosed = true;
    lastLivePreviewPath = "";
  });
  if (treatmentInput) {
    treatmentInput.addEventListener("input", updateActionButtonState);
    treatmentInput.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      if (!importMode || actionBtn?.disabled) return;
      void runImportDone();
    });
  }
  if (livePreviewToggle) {
    livePreviewToggle.addEventListener("change", () => {
      if (importMode) return;
      void saveLivePreviewToggleSetting(livePreviewToggle.checked);
      if (!livePreviewToggle.checked) {
        livePreviewManuallyClosed = false;
        void closeLivePreviewWindow();
        return;
      }
      livePreviewBlockedByImport = false;
      livePreviewManuallyClosed = false;
      void syncLivePreviewNavigation();
    });
  }

  if (importWizardDir && workspaceDir && patientFolder) {
    const baseline = await invoke("list_import_wizard_files", { folderDir: importWizardDir }).catch(() => []);
    for (const row of Array.isArray(baseline) ? baseline : []) {
      const path = String(row?.path ?? "").trim();
      const isImage = Boolean(row?.is_image ?? row?.isImage ?? false);
      if (!path || !isImage) continue;
      // Treat all existing files at startup as baseline so polling can focus on newly arriving files.
      knownPaths.add(path);
    }
    pollInterval = setInterval(() => {
      void pollWatchFolder();
    }, WATCH_FOLDER_POLL_MS);
    void pollWatchFolder();
  }

  renderImportUi();
  updateActionButtonState();
}

window.addEventListener("beforeunload", cleanup);
void init();
