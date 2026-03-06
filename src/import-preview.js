import { listen } from "@tauri-apps/api/event";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { FULL_TRACE } from "./trace-config";

const params = new URLSearchParams(window.location.search);
const previewMode = params.get("mode") === "image" ? "image" : "wizard";
const previewEventName = previewMode === "image" ? "image-preview-file" : "import-wizard-preview-file";
const getCurrentPathCommand =
  previewMode === "image" ? "get_current_image_preview_path" : "get_current_import_wizard_preview_path";
const getCurrentPathsCommand =
  previewMode === "image" ? "get_current_image_preview_paths" : "get_current_import_wizard_preview_paths";

const previewImage = document.getElementById("previewImage");
const previewRoot = document.querySelector(".preview-root");
const drawCanvas = document.getElementById("drawCanvas");
const previewLoading = document.getElementById("previewLoading");
const previewToolbar = document.getElementById("previewToolbar");
const markBtn = document.getElementById("markBtn");
const drawColorPicker = document.getElementById("drawColorPicker");
const clearDrawBtn = document.getElementById("clearDrawBtn");
const drawSaveWrap = document.getElementById("drawSaveWrap");
const drawSaveInput = document.getElementById("drawSaveInput");
const drawSaveDropdownBtn = document.getElementById("drawSaveDropdownBtn");
const drawSaveSuggestions = document.getElementById("drawSaveSuggestions");
const drawSaveSuggestionsList = document.getElementById("drawSaveSuggestionsList");
const drawSaveBtn = document.getElementById("drawSaveBtn");
const rotateRightBtn = document.getElementById("rotateRightBtn");
const navPrevBtn = document.getElementById("navPrevBtn");
const navNextBtn = document.getElementById("navNextBtn");
let previewRequestToken = 0;
let currentPreviewPath = "";
let navigationPaths = [];
let currentScale = 1;
let rotationDeg = 0;
let translateX = 0;
let translateY = 0;
let controlsVisible = false;
let markModeActive = false;
let selectedDrawColor = "white";
const pendingRotationStepsByPath = new Map();
const optimisticRotationOverrideDegByPath = new Map();
const inflightRotationStepsByPath = new Map();
const rotateSaveTimerByPath = new Map();
const rotateSaveRunningByPath = new Map();
const latestRotationOpIdByPath = new Map();
let rotationOpCounter = 0;
const ROTATE_SAVE_DEBOUNCE_MS = 800;
let baseImageWidth = 0;
let baseImageHeight = 0;
const MIN_SCALE = 1;
const MAX_SCALE = 6;
const WHEEL_ZOOM_STEP = 0.15;
const activeTouchPoints = new Map();
let pinchStartDistance = 0;
let pinchStartScale = 1;
let activePanTouchPointerId = null;
let lastPanClientX = 0;
let lastPanClientY = 0;
let isMousePanning = false;
let loadingVisibleSinceMs = 0;
let isDrawingLine = false;
let lastDrawPoint = null;
let hasDrawnLines = false;
let lineSegments = [];
let saveModeActive = false;
let availableTreatmentFolders = [];
let selectedExistingTreatmentFolder = "";
let saveDropdownOpen = false;
let previewWorkspaceDir = "";
let previewPatientFolder = "";
let folderRefreshRequestId = 0;
const ROTATION_UI_STATE_STORAGE_KEY = "mpm.imagePreviewRotationUiState.v1";
const PREVIEW_TRACE_FORWARD_TO_RUST = FULL_TRACE;

function previewTrace(scope, message, extra = null) {
  const ts = new Date().toISOString();
  const extraText = extra === null || extra === undefined
    ? ""
    : ` ${JSON.stringify(extra)}`;
  if (PREVIEW_TRACE_FORWARD_TO_RUST) {
    try {
      void invoke("preview_trace_client", {
        scope: `window:${previewMode}:${scope}`,
        message: `${message}${extraText}`,
      });
    } catch {
      // ignore trace transport errors
    }
  }
  if (extra === null || extra === undefined) {
    console.log(`[preview-trace][window:${previewMode}][${scope}][${ts}] ${message}`);
    return;
  }
  console.log(`[preview-trace][window:${previewMode}][${scope}][${ts}] ${message}`, extra);
}

previewTrace("boot", "import-preview script loaded", {
  href: window.location.href,
  mode: previewMode,
  eventName: previewEventName,
});

function normalizePath(value) {
  return String(value ?? "").trim();
}

function getRootSize() {
  const width = Number(previewRoot?.clientWidth) || 0;
  const height = Number(previewRoot?.clientHeight) || 0;
  return { width, height };
}

function getPointInRoot(clientX, clientY) {
  const rect = previewRoot?.getBoundingClientRect();
  if (!rect) return null;
  return {
    x: clientX - rect.left,
    y: clientY - rect.top,
  };
}

function setNavigationPaths(paths = []) {
  const seen = new Set();
  const next = [];
  for (const raw of Array.isArray(paths) ? paths : []) {
    const path = normalizePath(raw);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    next.push(path);
  }
  navigationPaths = next;
  if (currentPreviewPath && !navigationPaths.includes(currentPreviewPath)) {
    currentPreviewPath = navigationPaths[0] ?? "";
  }
}

function clampScale(scale) {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, Number(scale) || MIN_SCALE));
}

function isQuarterTurnOdd() {
  const normalized = ((rotationDeg % 360) + 360) % 360;
  return normalized === 90 || normalized === 270;
}

function getEffectiveBaseImageSize() {
  if (isQuarterTurnOdd()) {
    return {
      width: baseImageHeight,
      height: baseImageWidth,
    };
  }
  return {
    width: baseImageWidth,
    height: baseImageHeight,
  };
}

function getPanLimits(scale = currentScale) {
  const { width: rootWidth, height: rootHeight } = getRootSize();
  const effectiveBase = getEffectiveBaseImageSize();
  if (rootWidth <= 0 || rootHeight <= 0 || effectiveBase.width <= 0 || effectiveBase.height <= 0) {
    return { maxX: 0, maxY: 0 };
  }
  const scaledWidth = effectiveBase.width * scale;
  const scaledHeight = effectiveBase.height * scale;
  return {
    maxX: Math.max(0, (scaledWidth - rootWidth) / 2),
    maxY: Math.max(0, (scaledHeight - rootHeight) / 2),
  };
}

function clampTranslation(nextX, nextY, scale = currentScale) {
  const { maxX, maxY } = getPanLimits(scale);
  return {
    x: Math.min(maxX, Math.max(-maxX, Number(nextX) || 0)),
    y: Math.min(maxY, Math.max(-maxY, Number(nextY) || 0)),
  };
}

function updatePanCursorState() {
  if (!previewRoot) return;
  const { maxX, maxY } = getPanLimits();
  const canPan = maxX > 0.5 || maxY > 0.5;
  previewRoot.classList.toggle("can-pan", canPan);
  previewRoot.classList.toggle("panning", canPan && (isMousePanning || activePanTouchPointerId !== null));
}

function applyTransform() {
  if (!previewImage) return;
  previewImage.style.transform =
    `translate(-50%, -50%) translate(${translateX}px, ${translateY}px) rotate(${rotationDeg}deg) scale(${currentScale})`;
  updatePanCursorState();
}

function drawColorToCss(color) {
  if (color === "red") return "#e3342f";
  if (color === "blue") return "#2563eb";
  return "#ffffff";
}

function resizeDrawCanvas() {
  if (!drawCanvas || !previewRoot) return;
  const rect = previewRoot.getBoundingClientRect();
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const w = Math.max(1, Math.round(rect.width * dpr));
  const h = Math.max(1, Math.round(rect.height * dpr));
  if (drawCanvas.width !== w) drawCanvas.width = w;
  if (drawCanvas.height !== h) drawCanvas.height = h;
  drawCanvas.style.width = `${Math.round(rect.width)}px`;
  drawCanvas.style.height = `${Math.round(rect.height)}px`;
}

function clearDrawCanvas() {
  if (!drawCanvas) return;
  const ctx = drawCanvas.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
  hasDrawnLines = false;
  lineSegments = [];
  previewToolbar?.classList.remove("has-lines");
  setSaveModeActive(false);
}

function drawPointFromClient(clientX, clientY) {
  if (!drawCanvas || !previewRoot) return null;
  const rect = previewRoot.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  const sx = drawCanvas.width / rect.width;
  const sy = drawCanvas.height / rect.height;
  return {
    x: (clientX - rect.left) * sx,
    y: (clientY - rect.top) * sy,
  };
}

function continueDrawingTo(clientX, clientY) {
  if (!drawCanvas || !isDrawingLine || !lastDrawPoint) return;
  const next = drawPointFromClient(clientX, clientY);
  if (!next) return;
  const ctx = drawCanvas.getContext("2d");
  if (!ctx) return;
  ctx.strokeStyle = drawColorToCss(selectedDrawColor);
  ctx.lineWidth = Math.max(2, Math.round((window.devicePixelRatio || 1) * 2.2));
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(lastDrawPoint.x, lastDrawPoint.y);
  ctx.lineTo(next.x, next.y);
  ctx.stroke();
  lineSegments.push({
    color: selectedDrawColor,
    x1: lastDrawPoint.x,
    y1: lastDrawPoint.y,
    x2: next.x,
    y2: next.y,
  });
  if (!hasDrawnLines) {
    hasDrawnLines = true;
    previewToolbar?.classList.add("has-lines");
  }
  lastDrawPoint = next;
}

function normalizeRotationSteps(value) {
  const n = Number(value) || 0;
  const mod = ((n % 4) + 4) % 4;
  return mod;
}

function persistRotationUiState() {
  try {
    const payload = {
      pendingSteps: Object.fromEntries(
        Array.from(pendingRotationStepsByPath.entries()).map(([k, v]) => [k, normalizeRotationSteps(v)])
      ),
      optimisticDeg: Object.fromEntries(
        Array.from(optimisticRotationOverrideDegByPath.entries()).map(([k, v]) => [k, normalizeRotationDeg(v)])
      ),
    };
    localStorage.setItem(ROTATION_UI_STATE_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // ignore persistence errors
  }
}

function pruneStaleRotationUiState() {
  const keys = new Set([
    ...Array.from(pendingRotationStepsByPath.keys()),
    ...Array.from(optimisticRotationOverrideDegByPath.keys()),
  ]);
  for (const key of keys) {
    const steps = normalizeRotationSteps(pendingRotationStepsByPath.get(key) ?? 0);
    if (steps === 0) {
      pendingRotationStepsByPath.delete(key);
      optimisticRotationOverrideDegByPath.delete(key);
      continue;
    }
    const expected = normalizeRotationDeg(steps * 90);
    if (expected === 0) {
      optimisticRotationOverrideDegByPath.delete(key);
    } else {
      optimisticRotationOverrideDegByPath.set(key, expected);
    }
  }
}

function loadRotationUiState() {
  try {
    const raw = localStorage.getItem(ROTATION_UI_STATE_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    const pending = parsed?.pendingSteps && typeof parsed.pendingSteps === "object" ? parsed.pendingSteps : {};
    const optimistic = parsed?.optimisticDeg && typeof parsed.optimisticDeg === "object" ? parsed.optimisticDeg : {};
    for (const [path, value] of Object.entries(pending)) {
      const key = normalizePath(path);
      const steps = normalizeRotationSteps(value);
      if (!key || steps === 0) continue;
      pendingRotationStepsByPath.set(key, steps);
    }
    for (const [path, value] of Object.entries(optimistic)) {
      const key = normalizePath(path);
      const deg = normalizeRotationDeg(value);
      if (!key || deg === 0) continue;
      optimisticRotationOverrideDegByPath.set(key, deg);
    }
    pruneStaleRotationUiState();
    persistRotationUiState();
  } catch {
    // ignore parse errors
  }
}

function getPendingRotationDeg(path) {
  const key = normalizePath(path);
  if (!key) return 0;
  const steps = normalizeRotationSteps(pendingRotationStepsByPath.get(key) ?? 0);
  return steps * 90;
}

function normalizeRotationDeg(value) {
  const n = Number(value) || 0;
  return ((n % 360) + 360) % 360;
}

function getOptimisticRotationOverrideDeg(path) {
  const key = normalizePath(path);
  if (!key) return 0;
  const pending = normalizeRotationSteps(pendingRotationStepsByPath.get(key) ?? 0);
  const inflight = normalizeRotationSteps(inflightRotationStepsByPath.get(key) ?? 0);
  if (pending === 0 && inflight === 0) return 0;
  return normalizeRotationDeg(optimisticRotationOverrideDegByPath.get(key) ?? 0);
}

function addOptimisticRotationOverride(path, deltaDeg) {
  const key = normalizePath(path);
  if (!key) return;
  const next = normalizeRotationDeg(getOptimisticRotationOverrideDeg(key) + (Number(deltaDeg) || 0));
  if (next === 0) {
    optimisticRotationOverrideDegByPath.delete(key);
    pruneStaleRotationUiState();
    persistRotationUiState();
    return;
  }
  optimisticRotationOverrideDegByPath.set(key, next);
  pruneStaleRotationUiState();
  persistRotationUiState();
}

function addPendingRotationStep(path) {
  const key = normalizePath(path);
  if (!key) return;
  const next = normalizeRotationSteps((pendingRotationStepsByPath.get(key) ?? 0) + 1);
  if (next === 0) {
    pendingRotationStepsByPath.delete(key);
    optimisticRotationOverrideDegByPath.delete(key);
    pruneStaleRotationUiState();
    persistRotationUiState();
    return;
  }
  pendingRotationStepsByPath.set(key, next);
  optimisticRotationOverrideDegByPath.set(key, normalizeRotationDeg(next * 90));
  pruneStaleRotationUiState();
  persistRotationUiState();
}

function consumePendingRotationStep(path) {
  const key = normalizePath(path);
  if (!key) return;
  const current = normalizeRotationSteps(pendingRotationStepsByPath.get(key) ?? 0);
  if (current === 0) {
    pendingRotationStepsByPath.delete(key);
    optimisticRotationOverrideDegByPath.delete(key);
    pruneStaleRotationUiState();
    persistRotationUiState();
    return;
  }
  const next = normalizeRotationSteps(current - 1);
  if (next === 0) {
    pendingRotationStepsByPath.delete(key);
    optimisticRotationOverrideDegByPath.delete(key);
    pruneStaleRotationUiState();
    persistRotationUiState();
    return;
  }
  pendingRotationStepsByPath.set(key, next);
  optimisticRotationOverrideDegByPath.set(key, normalizeRotationDeg(next * 90));
  pruneStaleRotationUiState();
  persistRotationUiState();
}

async function flushPendingRotationSave(path) {
  const key = normalizePath(path);
  if (!key) return;
  if (rotateSaveRunningByPath.get(key)) return;
  if (normalizeRotationSteps(inflightRotationStepsByPath.get(key) ?? 0) > 0) return;
  const steps = normalizeRotationSteps(pendingRotationStepsByPath.get(key) ?? 0);
  if (steps === 0) return;
  const opId = ++rotationOpCounter;
  latestRotationOpIdByPath.set(key, opId);
  pendingRotationStepsByPath.delete(key);
  inflightRotationStepsByPath.set(key, steps);
  persistRotationUiState();

  rotateSaveRunningByPath.set(key, true);
  try {
    // Persist only net pending rotation for latest op.
    await invoke("rotate_image_right_in_place", { path: key, steps, opId });
    addOptimisticRotationOverride(key, -(steps * 90));
    previewTrace("rotate", "debounced rotate save ok", { path: key, steps, opId });
  } catch (err) {
    pendingRotationStepsByPath.set(key, steps);
    previewTrace("rotate", "debounced rotate save failed", {
      path: key,
      opId,
      err: String(err ?? ""),
    });
    console.error("debounced rotate save failed:", err);
    persistRotationUiState();
  } finally {
    inflightRotationStepsByPath.delete(key);
    rotateSaveRunningByPath.set(key, false);
    const remaining = normalizeRotationSteps(pendingRotationStepsByPath.get(key) ?? 0);
    if (remaining > 0) {
      schedulePendingRotationSave(key);
    }
  }
}

function schedulePendingRotationSave(path) {
  const key = normalizePath(path);
  if (!key) return;
  const existingTimer = rotateSaveTimerByPath.get(key);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }
  const timerId = setTimeout(() => {
    rotateSaveTimerByPath.delete(key);
    void flushPendingRotationSave(key);
  }, ROTATE_SAVE_DEBOUNCE_MS);
  rotateSaveTimerByPath.set(key, timerId);
  persistRotationUiState();
}

function scheduleAllPendingRotationSaves() {
  for (const [rawPath, rawSteps] of pendingRotationStepsByPath.entries()) {
    const path = normalizePath(rawPath);
    const steps = normalizeRotationSteps(rawSteps ?? 0);
    if (!path || steps === 0) continue;
    schedulePendingRotationSave(path);
  }
}

function setControlsVisible(visible) {
  controlsVisible = Boolean(visible);
  previewRoot?.classList.toggle("controls-visible", controlsVisible);
  previewToolbar?.setAttribute("aria-hidden", controlsVisible ? "false" : "true");
}

function toggleControlsVisible() {
  setControlsVisible(!controlsVisible);
}

function setMarkModeActive(active) {
  markModeActive = Boolean(active);
  markBtn?.classList.toggle("active", markModeActive);
  markBtn?.setAttribute("aria-pressed", markModeActive ? "true" : "false");
  previewRoot?.classList.toggle("draw-mode", markModeActive);
  if (!markModeActive) {
    isDrawingLine = false;
    lastDrawPoint = null;
    previewToolbar?.classList.remove("has-lines");
    setSaveModeActive(false);
  }
}

function setSaveModeActive(active) {
  saveModeActive = Boolean(active);
  previewToolbar?.classList.toggle("save-mode", saveModeActive);
  if (drawSaveBtn) {
    drawSaveBtn.textContent = saveModeActive ? "Done" : "Save";
  }
  if (!saveModeActive) {
    setSaveDropdownOpen(false);
    if (drawSaveSuggestionsList) drawSaveSuggestionsList.innerHTML = "";
    selectedExistingTreatmentFolder = "";
    if (drawSaveInput) drawSaveInput.classList.remove("is-existing-selected");
    return;
  }
  availableTreatmentFolders = [];
  folderRefreshRequestId += 1;
  if (drawSaveDropdownBtn) drawSaveDropdownBtn.hidden = true;
  setSaveDropdownOpen(false);
  if (drawSaveSuggestionsList) drawSaveSuggestionsList.innerHTML = "";
  void refreshAvailableTreatmentFolders();
  requestAnimationFrame(() => {
    drawSaveInput?.focus();
    drawSaveInput?.select();
  });
}

function isLikelyPatientFolderName(name) {
  const value = String(name ?? "").trim();
  return value.includes(",") && value.length > 2;
}

async function refreshAvailableTreatmentFolders() {
  const requestId = ++folderRefreshRequestId;
  if ((!previewWorkspaceDir || !previewPatientFolder) && currentPreviewPath) {
    try {
      const settings = await invoke("load_settings");
      const workspaceRaw = String(
        settings?.workspace_dir ?? settings?.workspaceDir ?? ""
      ).trim();
      if (workspaceRaw) {
        const ws = workspaceRaw.replace(/\\/g, "/").replace(/\/+$/, "");
        const filePath = String(currentPreviewPath).replace(/\\/g, "/");
        const prefix = `${ws}/`;
        if (filePath.startsWith(prefix)) {
          const relative = filePath.slice(prefix.length);
          const patient = String(relative.split("/")[0] ?? "").trim();
          if (patient && isLikelyPatientFolderName(patient)) {
            previewWorkspaceDir = workspaceRaw;
            previewPatientFolder = patient;
          }
        }
      }
    } catch {
      // keep existing context values on fallback failure
    }
  }

  if (!previewWorkspaceDir || !previewPatientFolder || !isLikelyPatientFolderName(previewPatientFolder)) {
    availableTreatmentFolders = [];
    if (requestId !== folderRefreshRequestId) return;
    renderSaveDropdown(String(drawSaveInput?.value ?? "").trim());
    return;
  }
  try {
    const rows = await invoke("list_patient_treatment_folders", {
      workspaceDir: previewWorkspaceDir,
      patientFolder: previewPatientFolder,
    });
    availableTreatmentFolders = Array.isArray(rows)
      ? rows.map((entry) => String(entry ?? "").trim()).filter(Boolean)
      : [];
    if (requestId !== folderRefreshRequestId) return;
    if (saveModeActive) {
      renderSaveDropdown(drawSaveInput?.value ?? "");
    }
  } catch {
    availableTreatmentFolders = [];
    if (requestId !== folderRefreshRequestId) return;
    renderSaveDropdown(String(drawSaveInput?.value ?? "").trim());
  }
}

function setSaveDropdownOpen(open) {
  saveDropdownOpen = Boolean(open);
  if (drawSaveSuggestions) {
    drawSaveSuggestions.hidden = !saveDropdownOpen;
  }
  if (drawSaveDropdownBtn) {
    drawSaveDropdownBtn.setAttribute("aria-expanded", saveDropdownOpen ? "true" : "false");
  }
}

function clearSelectedExistingTreatmentFolder(clearInput = false) {
  selectedExistingTreatmentFolder = "";
  if (drawSaveInput) {
    drawSaveInput.classList.remove("is-existing-selected");
    if (clearInput) drawSaveInput.value = "";
  }
}

function selectExistingTreatmentFolder(folderName) {
  const selected = String(folderName ?? "").trim();
  if (!selected) return;
  selectedExistingTreatmentFolder = selected;
  if (drawSaveInput) {
    drawSaveInput.value = selected;
    drawSaveInput.classList.add("is-existing-selected");
  }
}

function getFilteredTreatmentFolders(filterText = "") {
  const folders = Array.isArray(availableTreatmentFolders) ? availableTreatmentFolders : [];
  const needle = String(filterText ?? "").trim().toLowerCase();
  if (!needle) return folders;
  return folders.filter((name) => String(name ?? "").toLowerCase().includes(needle));
}

function renderSaveDropdown(filterText = "") {
  if (!drawSaveSuggestionsList || !drawSaveDropdownBtn) return;
  drawSaveSuggestionsList.innerHTML = "";
  const allFolders = Array.isArray(availableTreatmentFolders) ? availableTreatmentFolders : [];
  const folders = getFilteredTreatmentFolders(filterText);
  drawSaveDropdownBtn.hidden = allFolders.length < 1;
  if (allFolders.length < 1) {
    setSaveDropdownOpen(false);
    return;
  }
  if (folders.length < 1) {
    setSaveDropdownOpen(false);
    return;
  }
  for (const folder of folders) {
    const name = String(folder ?? "").trim();
    if (!name) continue;
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "draw-save-suggestion";
    if (name === selectedExistingTreatmentFolder) {
      btn.classList.add("is-selected");
    }
    btn.textContent = name;
    btn.title = name;
    btn.addEventListener("click", () => {
      selectExistingTreatmentFolder(name);
      setSaveDropdownOpen(false);
    });
    li.appendChild(btn);
    drawSaveSuggestionsList.appendChild(li);
  }
}

function currentDateYmd() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

async function exportAnnotatedTempFile() {
  if (!drawCanvas || !currentPreviewPath) {
    throw new Error("missing preview state");
  }
  const ext = String(currentPreviewPath.split(".").pop() ?? "").toLowerCase();
  const mime = ext === "png" ? "image/png" : "image/jpeg";
  const outExt = ext === "png" ? "png" : "jpg";
  const loadBaseImage = (src) =>
    new Promise((resolve, reject) => {
      const img = new Image();
      img.decoding = "async";
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("base image load failed"));
      img.src = src;
    });
  let baseImage = null;
  try {
    baseImage = await loadBaseImage(`${convertFileSrc(currentPreviewPath)}?t=${Date.now()}`);
  } catch {
    const dataUrl = await invoke("get_import_wizard_preview_data_url", { path: currentPreviewPath });
    baseImage = await loadBaseImage(String(dataUrl ?? ""));
  }
  const targetCanvas = document.createElement("canvas");
  const w = Math.max(1, Number(baseImage?.naturalWidth) || 0);
  const h = Math.max(1, Number(baseImage?.naturalHeight) || 0);
  targetCanvas.width = w;
  targetCanvas.height = h;
  const ctx = targetCanvas.getContext("2d");
  if (!ctx) throw new Error("2d context unavailable");
  ctx.drawImage(baseImage, 0, 0, w, h);

  const viewW = Math.max(1, drawCanvas.width);
  const viewH = Math.max(1, drawCanvas.height);
  for (const seg of lineSegments) {
    ctx.strokeStyle = drawColorToCss(seg.color);
    ctx.lineWidth = Math.max(2, Math.round((w / viewW) * 2.4));
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo((seg.x1 / viewW) * w, (seg.y1 / viewH) * h);
    ctx.lineTo((seg.x2 / viewW) * w, (seg.y2 / viewH) * h);
    ctx.stroke();
  }

  const dataUrl = targetCanvas.toDataURL(mime, 0.95);
  return await invoke("save_import_wizard_preview_data_url_to_temp", {
    dataUrl,
    fileExt: outExt,
  });
}

function setSelectedDrawColor(color) {
  const next = ["white", "red", "blue"].includes(String(color)) ? String(color) : "white";
  selectedDrawColor = next;
  const dots = Array.from(drawColorPicker?.querySelectorAll(".draw-color-dot") ?? []);
  for (const dot of dots) {
    const isActive = String(dot?.dataset?.color ?? "") === selectedDrawColor;
    dot.classList.toggle("active", isActive);
    dot.setAttribute("aria-pressed", isActive ? "true" : "false");
  }
}

function setScaleAt(nextScale, clientX, clientY) {
  const clamped = clampScale(nextScale);
  if (Math.abs(clamped - currentScale) < 0.0001) return;
  const point = getPointInRoot(clientX, clientY);
  if (!point || !previewRoot) return;
  const { width: rootWidth, height: rootHeight } = getRootSize();
  const centerX = (rootWidth / 2) + translateX;
  const centerY = (rootHeight / 2) + translateY;
  const relativeX = (point.x - centerX) / currentScale;
  const relativeY = (point.y - centerY) / currentScale;
  currentScale = clamped;
  const nextCenterX = point.x - (relativeX * currentScale);
  const nextCenterY = point.y - (relativeY * currentScale);
  const nextTranslateX = nextCenterX - (rootWidth / 2);
  const nextTranslateY = nextCenterY - (rootHeight / 2);
  const clampedTranslate = clampTranslation(nextTranslateX, nextTranslateY, currentScale);
  translateX = clampedTranslate.x;
  translateY = clampedTranslate.y;
  applyTransform();
}

function panBy(deltaX, deltaY) {
  if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) return;
  const clampedTranslate = clampTranslation(translateX + deltaX, translateY + deltaY);
  translateX = clampedTranslate.x;
  translateY = clampedTranslate.y;
  applyTransform();
}

function updateBaseImageSize() {
  if (!previewImage || !previewRoot) return;
  const naturalWidth = Number(previewImage.naturalWidth) || 0;
  const naturalHeight = Number(previewImage.naturalHeight) || 0;
  const { width: rootWidth, height: rootHeight } = getRootSize();
  const FIT_SAFETY = 0.999;
  if (naturalWidth <= 0 || naturalHeight <= 0 || rootWidth <= 0 || rootHeight <= 0) {
    baseImageWidth = Math.max(1, rootWidth);
    baseImageHeight = Math.max(1, rootHeight);
    previewImage.style.width = `${baseImageWidth}px`;
    previewImage.style.height = `${baseImageHeight}px`;
    return;
  }
  // Uniform scale only (no distortion). For quarter-turn rotations, fit against swapped bounds.
  const containRatio = isQuarterTurnOdd()
    ? Math.min(rootWidth / naturalHeight, rootHeight / naturalWidth)
    : Math.min(rootWidth / naturalWidth, rootHeight / naturalHeight);
  const safeRatio = Math.max(0, containRatio * FIT_SAFETY);
  baseImageWidth = Math.max(1, naturalWidth * safeRatio);
  baseImageHeight = Math.max(1, naturalHeight * safeRatio);
  previewImage.style.width = `${baseImageWidth}px`;
  previewImage.style.height = `${baseImageHeight}px`;
}

function resetTransform() {
  currentScale = MIN_SCALE;
  rotationDeg = 0;
  translateX = 0;
  translateY = 0;
  pinchStartDistance = 0;
  pinchStartScale = MIN_SCALE;
  activeTouchPoints.clear();
  activePanTouchPointerId = null;
  lastPanClientX = 0;
  lastPanClientY = 0;
  isMousePanning = false;
  applyTransform();
}

function updateNavigationButtons() {
  const paths = Array.isArray(navigationPaths) ? navigationPaths : [];
  const index = paths.findIndex((path) => path === currentPreviewPath);
  const hasAny = paths.length > 0 && index >= 0;
  const hasPrev = hasAny && index > 0;
  const hasNext = hasAny && index >= 0 && index < (paths.length - 1);
  if (navPrevBtn) navPrevBtn.disabled = !hasPrev;
  if (navNextBtn) navNextBtn.disabled = !hasNext;
}

function showLoading(requestToken) {
  if (requestToken !== previewRequestToken) return;
  if (loadingVisibleSinceMs <= 0) {
    loadingVisibleSinceMs = performance.now();
    previewTrace("ui", "loading shown", { requestToken });
  }
  previewLoading?.classList.add("visible");
}

function hideLoading(requestToken) {
  if (requestToken !== previewRequestToken) return;
  if (loadingVisibleSinceMs > 0) {
    const visibleMs = Math.round(performance.now() - loadingVisibleSinceMs);
    previewTrace("ui", "loading hidden", { requestToken, visibleMs });
    loadingVisibleSinceMs = 0;
  }
  previewLoading?.classList.remove("visible");
}

function loadImageWithVerification(src, requestToken) {
  return new Promise((resolve, reject) => {
    const startedAt = performance.now();
    let done = false;
    const cleanup = () => {
      previewImage.onload = null;
      previewImage.onerror = null;
    };

    previewImage.onload = () => {
      if (done) return;
      done = true;
      cleanup();
      previewTrace("image", "img.onload", {
        requestToken,
        ms: Math.round(performance.now() - startedAt),
        naturalWidth: Number(previewImage?.naturalWidth ?? 0),
        naturalHeight: Number(previewImage?.naturalHeight ?? 0),
      });
      if (requestToken !== previewRequestToken) {
        resolve(false);
        return;
      }
      resolve(true);
    };

    previewImage.onerror = () => {
      if (done) return;
      done = true;
      cleanup();
      previewTrace("image", "img.onerror", {
        requestToken,
        ms: Math.round(performance.now() - startedAt),
        srcKind: String(src ?? "").startsWith("data:") ? "data-url" : "file-src",
      });
      reject(new Error("preview image failed to load"));
    };

    previewTrace("image", "img.src set", {
      requestToken,
      srcKind: String(src ?? "").startsWith("data:") ? "data-url" : "file-src",
    });
    previewImage.src = src;
  });
}

async function setPreview(path) {
  const normalized = normalizePath(path);
  if (!normalized) return;
  const startedAt = performance.now();
  previewTrace("setPreview", "start", { path: normalized });
  currentPreviewPath = normalized;
  resetTransform();
  clearDrawCanvas();
  rotationDeg = getOptimisticRotationOverrideDeg(normalized);
  if (normalizeRotationSteps(pendingRotationStepsByPath.get(normalized) ?? 0) > 0) {
    schedulePendingRotationSave(normalized);
  }
  applyTransform();
  updateNavigationButtons();
  const requestToken = ++previewRequestToken;
  showLoading(requestToken);
  await new Promise((resolve) => requestAnimationFrame(resolve));
  try {
    // Prefer original file path first so live preview is independent from thumbnail/cache generation.
    const directSrc = `${convertFileSrc(normalized)}?t=${Date.now()}`;
    previewImage.decoding = "async";
    await loadImageWithVerification(directSrc, requestToken);
    updateBaseImageSize();
    applyTransform();
    previewTrace("setPreview", "completed via original-path", {
      requestToken,
      path: normalized,
      totalMs: Math.round(performance.now() - startedAt),
    });
  } catch (err) {
    previewTrace("setPreview", "original-path failed, fallback to data_url", {
      requestToken,
      path: normalized,
      err: String(err ?? ""),
    });
    if (requestToken !== previewRequestToken) return;
    try {
      const dataInvokeStart = performance.now();
      const dataUrl = await invoke("get_import_wizard_preview_data_url", { path: normalized });
      previewTrace("setPreview", "get_import_wizard_preview_data_url ok", {
        requestToken,
        path: normalized,
        ms: Math.round(performance.now() - dataInvokeStart),
        length: String(dataUrl ?? "").length,
      });
      if (requestToken !== previewRequestToken) return;
      const src = String(dataUrl ?? "").trim();
      if (!src) return;
      await loadImageWithVerification(src, requestToken);
      updateBaseImageSize();
      applyTransform();
      previewTrace("setPreview", "completed via data_url fallback", {
        requestToken,
        path: normalized,
        totalMs: Math.round(performance.now() - startedAt),
      });
    } catch (dataErr) {
      previewTrace("setPreview", "data_url fallback failed, fallback to src_path", {
        requestToken,
        path: normalized,
        err: String(dataErr ?? ""),
      });
      if (requestToken !== previewRequestToken) return;
      try {
        const srcInvokeStart = performance.now();
        const resolvedPath = await invoke("get_import_wizard_preview_src_path", { path: normalized });
        previewTrace("setPreview", "get_import_wizard_preview_src_path ok", {
          requestToken,
          path: normalized,
          ms: Math.round(performance.now() - srcInvokeStart),
        });
        if (requestToken !== previewRequestToken) return;
        const safePath = String(resolvedPath ?? "").trim() || normalized;
        const src = `${convertFileSrc(safePath)}?t=${Date.now()}`;
        previewImage.decoding = "async";
        await loadImageWithVerification(src, requestToken);
        updateBaseImageSize();
        applyTransform();
        previewTrace("setPreview", "completed via src_path fallback", {
          requestToken,
          path: normalized,
          totalMs: Math.round(performance.now() - startedAt),
        });
      } catch (fallbackErr) {
        previewTrace("setPreview", "src_path fallback failed", {
          requestToken,
          path: normalized,
          err: String(fallbackErr ?? ""),
        });
        console.error("import preview original load failed:", err, dataErr, fallbackErr);
      }
    }
  } finally {
    hideLoading(requestToken);
  }
}

async function navigateByOffset(offset) {
  if (!Number.isFinite(offset) || !currentPreviewPath) return;
  const index = navigationPaths.findIndex((path) => path === currentPreviewPath);
  if (index < 0) {
    updateNavigationButtons();
    return;
  }
  const nextIndex = index + offset;
  if (nextIndex < 0 || nextIndex >= navigationPaths.length) {
    updateNavigationButtons();
    return;
  }
  const nextPath = normalizePath(navigationPaths[nextIndex]);
  if (!nextPath) {
    updateNavigationButtons();
    return;
  }
  await setPreview(nextPath);
}

if (navPrevBtn) {
  navPrevBtn.addEventListener("click", () => {
    void navigateByOffset(-1);
  });
}

if (navNextBtn) {
  navNextBtn.addEventListener("click", () => {
    void navigateByOffset(1);
  });
}

window.addEventListener("keydown", (event) => {
  if (event.key === "ArrowLeft") {
    event.preventDefault();
    void navigateByOffset(-1);
    return;
  }
  if (event.key === "ArrowRight") {
    event.preventDefault();
    void navigateByOffset(1);
  }
});

previewRoot?.addEventListener("wheel", (event) => {
  if (markModeActive) return;
  event.preventDefault();
  const delta = Number(event.deltaY) || 0;
  if (!Number.isFinite(delta) || delta === 0) return;
  const direction = delta < 0 ? 1 : -1;
  const step = event.ctrlKey ? WHEEL_ZOOM_STEP * 0.9 : WHEEL_ZOOM_STEP;
  setScaleAt(currentScale + direction * step, event.clientX, event.clientY);
}, { passive: false });

previewRoot?.addEventListener("pointerdown", (event) => {
  if (markModeActive) return;
  if (event.target instanceof Element && event.target.closest(".preview-nav")) return;
  if (event.target instanceof Element && event.target.closest(".preview-toolbar")) return;

  if (event.pointerType === "touch") {
    activeTouchPoints.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (activeTouchPoints.size === 1) {
      activePanTouchPointerId = event.pointerId;
      lastPanClientX = event.clientX;
      lastPanClientY = event.clientY;
    }
  }

  if (activeTouchPoints.size === 2) {
    const [a, b] = Array.from(activeTouchPoints.values());
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    pinchStartDistance = Math.hypot(dx, dy);
    pinchStartScale = currentScale;
    activePanTouchPointerId = null;
  }

  if (event.pointerType === "mouse" && event.button === 0) {
    const { maxX, maxY } = getPanLimits();
    if (maxX > 0.5 || maxY > 0.5) {
      isMousePanning = true;
      lastPanClientX = event.clientX;
      lastPanClientY = event.clientY;
      previewRoot?.setPointerCapture?.(event.pointerId);
      updatePanCursorState();
    }
  }
});

previewRoot?.addEventListener("pointermove", (event) => {
  if (markModeActive) return;
  if (event.pointerType === "touch") {
    if (!activeTouchPoints.has(event.pointerId)) return;
    activeTouchPoints.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (activeTouchPoints.size === 2 && pinchStartDistance > 0) {
      const [a, b] = Array.from(activeTouchPoints.values());
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const dist = Math.hypot(dx, dy);
      if (!Number.isFinite(dist) || dist <= 0) return;
      const centerX = (a.x + b.x) / 2;
      const centerY = (a.y + b.y) / 2;
      const ratio = dist / pinchStartDistance;
      setScaleAt(pinchStartScale * ratio, centerX, centerY);
      event.preventDefault();
      return;
    }

    if (activeTouchPoints.size === 1 && activePanTouchPointerId === event.pointerId) {
      const dx = event.clientX - lastPanClientX;
      const dy = event.clientY - lastPanClientY;
      lastPanClientX = event.clientX;
      lastPanClientY = event.clientY;
      panBy(dx, dy);
      event.preventDefault();
    }
    return;
  }

  if (event.pointerType === "mouse" && isMousePanning) {
    const dx = event.clientX - lastPanClientX;
    const dy = event.clientY - lastPanClientY;
    lastPanClientX = event.clientX;
    lastPanClientY = event.clientY;
    panBy(dx, dy);
    event.preventDefault();
  }
});

function releaseTouchPointer(pointerId) {
  activeTouchPoints.delete(pointerId);
  if (activePanTouchPointerId === pointerId) {
    activePanTouchPointerId = null;
  }
  if (activeTouchPoints.size === 1) {
    const [id, point] = Array.from(activeTouchPoints.entries())[0] ?? [];
    if (typeof id === "number" && point) {
      activePanTouchPointerId = id;
      lastPanClientX = point.x;
      lastPanClientY = point.y;
    }
  }
  if (activeTouchPoints.size < 2) {
    pinchStartDistance = 0;
    pinchStartScale = currentScale;
  }
  updatePanCursorState();
}

function stopMousePan(pointerId) {
  if (!isMousePanning) return;
  isMousePanning = false;
  previewRoot?.releasePointerCapture?.(pointerId);
  updatePanCursorState();
}

previewRoot?.addEventListener("pointerup", (event) => {
  if (event.pointerType === "mouse") {
    stopMousePan(event.pointerId);
  }
  releaseTouchPointer(event.pointerId);
});

previewRoot?.addEventListener("pointercancel", (event) => {
  if (event.pointerType === "mouse") {
    stopMousePan(event.pointerId);
  }
  releaseTouchPointer(event.pointerId);
});

previewRoot?.addEventListener("pointerleave", (event) => {
  if (event.pointerType === "mouse" && isMousePanning) {
    stopMousePan(event.pointerId);
  }
});

window.addEventListener("resize", () => {
  resizeDrawCanvas();
  currentScale = MIN_SCALE;
  translateX = 0;
  translateY = 0;
  updateBaseImageSize();
  applyTransform();
});

window.addEventListener("pointerdown", (event) => {
  if (!saveDropdownOpen) return;
  const target = event.target;
  if (!(target instanceof Node)) {
    setSaveDropdownOpen(false);
    return;
  }
  if (drawSaveWrap?.contains(target)) return;
  setSaveDropdownOpen(false);
});

previewRoot?.addEventListener("click", (event) => {
  if (!(event.target instanceof Element)) return;
  if (event.target.closest(".draw-canvas")) return;
  if (event.target.closest(".preview-nav")) return;
  if (event.target.closest(".preview-toolbar")) return;
  if (event.target.closest(".preview-loading")) return;
  toggleControlsVisible();
});

rotateRightBtn?.addEventListener("click", () => {
  if (!currentPreviewPath) return;
  const path = currentPreviewPath;
  addPendingRotationStep(path);
  rotationDeg = getOptimisticRotationOverrideDeg(path);
  currentScale = MIN_SCALE;
  translateX = 0;
  translateY = 0;
  updateBaseImageSize();
  applyTransform();
  void invoke("emit_image_preview_rotated", {
    path,
    rotationDeg,
    opId: null,
  }).catch(() => {});
  schedulePendingRotationSave(path);
});

markBtn?.addEventListener("click", () => {
  setMarkModeActive(!markModeActive);
});

drawColorPicker?.addEventListener("click", (event) => {
  const dot = event.target instanceof Element ? event.target.closest(".draw-color-dot") : null;
  if (!dot) return;
  setSelectedDrawColor(dot.dataset.color ?? "white");
});

clearDrawBtn?.addEventListener("click", () => {
  clearDrawCanvas();
});

drawSaveInput?.addEventListener("input", () => {
  if (!saveModeActive) return;
  if (selectedExistingTreatmentFolder) {
    clearSelectedExistingTreatmentFolder(false);
  }
  renderSaveDropdown(drawSaveInput.value);
});

drawSaveInput?.addEventListener("focus", () => {
  if (!saveModeActive) return;
  if (selectedExistingTreatmentFolder) {
    clearSelectedExistingTreatmentFolder(true);
  }
  renderSaveDropdown(drawSaveInput.value);
  if (getFilteredTreatmentFolders(drawSaveInput.value).length > 0) {
    setSaveDropdownOpen(true);
  }
});

drawSaveInput?.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    setSaveDropdownOpen(false);
  }
});

drawSaveDropdownBtn?.addEventListener("click", (event) => {
  event.preventDefault();
  event.stopPropagation();
  if (!saveModeActive) return;
  void (async () => {
    await refreshAvailableTreatmentFolders();
    const filterValue = String(drawSaveInput?.value ?? "").trim();
    const matches = getFilteredTreatmentFolders(filterValue);
    renderSaveDropdown(filterValue);
    if (!matches.length) {
      setSaveDropdownOpen(false);
      return;
    }
    setSaveDropdownOpen(!saveDropdownOpen);
  })();
});

drawSaveBtn?.addEventListener("click", () => {
  if (!hasDrawnLines) return;
  if (!saveModeActive) {
    setSaveModeActive(true);
    renderSaveDropdown(drawSaveInput?.value ?? "");
    return;
  }
  if (!previewWorkspaceDir || !previewPatientFolder) return;
  const typed = String(drawSaveInput?.value ?? "").trim();
  if (!typed) return;
  drawSaveBtn.disabled = true;
  void (async () => {
    try {
      const tempPath = await exportAnnotatedTempFile();
      const existingMatch = availableTreatmentFolders.find(
        (name) => name.toLowerCase() === typed.toLowerCase()
      ) ?? "";
      const result = await invoke("start_import_files", {
        workspaceDir: previewWorkspaceDir,
        patientFolder: previewPatientFolder,
        existingFolder: existingMatch || null,
        date: existingMatch ? null : currentDateYmd(),
        treatmentName: existingMatch ? null : typed,
        filePaths: [tempPath],
        deleteOrigin: true,
        importWizardDir: null,
      });
      const startedJobId = Number(result?.job_id ?? result?.jobId ?? 0) || null;
      const startedTargetFolder = String(result?.target_folder ?? result?.targetFolder ?? "").trim();
      await invoke("notify_import_wizard_completed", {
        workspaceDir: previewWorkspaceDir,
        patientFolder: previewPatientFolder,
        targetFolder: startedTargetFolder,
        jobId: startedJobId,
        importWizardDir: null,
        plannedPaths: Array.isArray(result?.planned_paths ?? result?.plannedPaths)
          ? (result?.planned_paths ?? result?.plannedPaths)
          : [],
      }).catch(() => {});
      clearDrawCanvas();
      setSaveModeActive(false);
      setMarkModeActive(false);
    } catch (err) {
      console.error("save drawn image import failed:", err);
    } finally {
      drawSaveBtn.disabled = false;
    }
  })();
});

drawCanvas?.addEventListener("pointerdown", (event) => {
  if (!markModeActive) return;
  if (event.button !== undefined && event.button !== 0) return;
  event.preventDefault();
  resizeDrawCanvas();
  const start = drawPointFromClient(event.clientX, event.clientY);
  if (!start) return;
  isDrawingLine = true;
  lastDrawPoint = start;
  drawCanvas.setPointerCapture?.(event.pointerId);
});

drawCanvas?.addEventListener("pointermove", (event) => {
  if (!markModeActive || !isDrawingLine) return;
  event.preventDefault();
  continueDrawingTo(event.clientX, event.clientY);
});

function stopDrawing(pointerId = null) {
  if (!isDrawingLine) return;
  isDrawingLine = false;
  lastDrawPoint = null;
  if (pointerId !== null) {
    drawCanvas?.releasePointerCapture?.(pointerId);
  }
}

drawCanvas?.addEventListener("pointerup", (event) => {
  stopDrawing(event.pointerId);
});

drawCanvas?.addEventListener("pointercancel", (event) => {
  stopDrawing(event.pointerId);
});

void listen(previewEventName, (event) => {
  loadRotationUiState();
  scheduleAllPendingRotationSaves();
  const path = normalizePath(event?.payload?.path);
  const paths = Array.isArray(event?.payload?.paths) ? event.payload.paths : [];
  const workspaceDir = normalizePath(event?.payload?.workspaceDir ?? "");
  const patientFolder = normalizePath(event?.payload?.patientFolder ?? "");
  previewTrace("event", "preview event received", {
    path,
    navCount: paths.length,
  });
  setNavigationPaths(paths);
  previewWorkspaceDir = workspaceDir;
  previewPatientFolder = patientFolder;
  availableTreatmentFolders = [];
  folderRefreshRequestId += 1;
  if (drawSaveDropdownBtn) drawSaveDropdownBtn.hidden = true;
  setSaveDropdownOpen(false);
  if (drawSaveSuggestionsList) drawSaveSuggestionsList.innerHTML = "";
  if (path && !navigationPaths.includes(path)) {
    navigationPaths.unshift(path);
  }
  if (!path) {
    updateNavigationButtons();
    return;
  }
  void setPreview(path);
  void refreshAvailableTreatmentFolders();
});

void (async () => {
  try {
    loadRotationUiState();
    scheduleAllPendingRotationSaves();
    resizeDrawCanvas();
    setSelectedDrawColor("white");
    setControlsVisible(false);
    const navStart = performance.now();
    const navPaths = await invoke(getCurrentPathsCommand);
    previewTrace("bootstrap", "getCurrentPaths ok", {
      ms: Math.round(performance.now() - navStart),
      navCount: Array.isArray(navPaths) ? navPaths.length : 0,
      cmd: getCurrentPathsCommand,
    });
    setNavigationPaths(navPaths);
    const pathStart = performance.now();
    const path = await invoke(getCurrentPathCommand);
    previewTrace("bootstrap", "getCurrentPath ok", {
      ms: Math.round(performance.now() - pathStart),
      cmd: getCurrentPathCommand,
      path: normalizePath(path),
    });
    const normalized = normalizePath(path);
    if (normalized) {
      loadRotationUiState();
      if (!navigationPaths.includes(normalized)) {
        navigationPaths.unshift(normalized);
      }
      await setPreview(normalized);
    } else {
      updateNavigationButtons();
    }
  } catch (err) {
    console.error("get current preview path failed:", err);
  }
})();
