import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

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
let importMode = false;
let importBusy = false;
let importModeFilePaths = [];
let allowWindowClose = false;
let closeConfirmVisible = false;
const knownPaths = new Set();
const pendingRows = [];
const previewDataUrlByPath = new Map();
const candidateRowsByPath = new Map();

const FILE_STABLE_MIN_AGE_MS = 2200;
const FILE_STABLE_POLLS_REQUIRED = 2;
const BASELINE_RECENT_FILE_WINDOW_MS = 15000;

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
      renderImportUi();
      updateActionButtonState();
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
  importModeFilePaths = pendingRows
    .map((row) => String(row?.path ?? "").trim())
    .filter(Boolean);
  importExpanded = false;
  await closeLivePreviewWindow();
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

async function pollWatchFolder() {
  if (!importWizardDir) return;
  try {
    const rows = await invoke("list_import_wizard_files", { folderDir: importWizardDir });
    const list = Array.isArray(rows) ? rows : [];
    const now = Date.now();
    const seenCandidatePaths = new Set();
    const newImagePaths = [];
    for (const row of list) {
      const path = String(row?.path ?? "").trim();
      const isImage = Boolean(row?.is_image ?? row?.isImage ?? false);
      if (!path || !isImage || knownPaths.has(path)) continue;
      if (pendingRows.some((entry) => String(entry?.path ?? "").trim() === path)) continue;
      seenCandidatePaths.add(path);
      if (!isStableImportRow(row, now)) continue;
      candidateRowsByPath.delete(path);
      knownPaths.add(path);
      pendingRows.unshift(row);
      newImagePaths.push(path);
      void fetchPreviewForPath(path).then(renderImportUi);
    }
    for (const path of candidateRowsByPath.keys()) {
      if (!seenCandidatePaths.has(path)) {
        candidateRowsByPath.delete(path);
      }
    }

    if (livePreviewToggle?.checked && newImagePaths.length > 0) {
      const newestRecognized = newImagePaths[newImagePaths.length - 1];
      if (newestRecognized && newestRecognized !== lastLivePreviewPath) {
        await sendLivePreviewPath(newestRecognized);
      }
    }

    renderImportUi();
    updateActionButtonState();
  } catch (err) {
    console.error("list_import_wizard_files failed:", err);
  }
}

function getRowModifiedMs(row) {
  return Number(row?.modified_ms ?? row?.modifiedMs ?? 0) || 0;
}

function isStableImportRow(row, nowMs = Date.now()) {
  const path = String(row?.path ?? "").trim();
  if (!path) return false;
  const size = Number(row?.size ?? 0);
  const modifiedMs = getRowModifiedMs(row);
  const ageMs = modifiedMs > 0 ? (nowMs - modifiedMs) : 0;
  const prev = candidateRowsByPath.get(path);
  if (!prev) {
    candidateRowsByPath.set(path, {
      size,
      modifiedMs,
      stablePolls: 0,
    });
    return false;
  }
  const unchanged = prev.size === size && prev.modifiedMs === modifiedMs;
  const stablePolls = unchanged ? (Number(prev.stablePolls ?? 0) + 1) : 0;
  candidateRowsByPath.set(path, { size, modifiedMs, stablePolls });
  return size > 0 && ageMs >= FILE_STABLE_MIN_AGE_MS && stablePolls >= FILE_STABLE_POLLS_REQUIRED;
}

function shouldTreatAsBaselineFile(row, nowMs = Date.now()) {
  const modifiedMs = getRowModifiedMs(row);
  if (modifiedMs <= 0) return false;
  return (nowMs - modifiedMs) >= BASELINE_RECENT_FILE_WINDOW_MS;
}

async function closeLivePreviewWindow() {
  try {
    await invoke("close_import_wizard_preview_window");
  } catch {
    // ignore
  } finally {
    lastLivePreviewPath = "";
  }
}

async function sendLivePreviewPath(path) {
  if (!path || !livePreviewToggle?.checked) return;
  try {
    await invoke("open_import_wizard_preview_window", { path });
    lastLivePreviewPath = path;
  } catch (err) {
    console.error("import wizard live preview update failed:", err);
  }
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
      if (importMode) return;
      importExpanded = !importExpanded;
      renderImportUi();
    });
  }
  if (actionBtn) {
    actionBtn.addEventListener("click", () => {
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
        void closeLivePreviewWindow();
      }
    });
  }

  if (importWizardDir && workspaceDir && patientFolder) {
    const now = Date.now();
    const baseline = await invoke("list_import_wizard_files", { folderDir: importWizardDir }).catch(() => []);
    for (const row of Array.isArray(baseline) ? baseline : []) {
      const path = String(row?.path ?? "").trim();
      const isImage = Boolean(row?.is_image ?? row?.isImage ?? false);
      if (!path || !isImage) continue;
      if (shouldTreatAsBaselineFile(row, now)) {
        knownPaths.add(path);
        continue;
      }
      candidateRowsByPath.set(path, {
        size: Number(row?.size ?? 0),
        modifiedMs: getRowModifiedMs(row),
        stablePolls: 0,
      });
    }
    pollInterval = setInterval(() => {
      void pollWatchFolder();
    }, 1300);
  }

  renderImportUi();
  updateActionButtonState();
}

window.addEventListener("beforeunload", cleanup);
void init();
