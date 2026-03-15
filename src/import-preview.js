import { listen } from "@tauri-apps/api/event";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { FULL_TRACE } from "./trace-config";
import { applyTranslations, initLanguageFromSettings, onLanguageChanged, t } from "./i18n";
import { buildCalibrationMetadata, computeMarkerCalibration, formatCalibrationDebug } from "./image-calibration-geometry";
import { createCalibrationState, resetCalibrationState, setCalibrationProcessing } from "./image-calibration-state";
import { getAiButtonMarkup, getCalibrationStatusText } from "./image-calibration-ui";

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
const alignMarkersBtn = document.getElementById("alignMarkersBtn");
const alignMarkersBtnContent = document.getElementById("alignMarkersBtnContent");
const markBtn = document.getElementById("markBtn");
const measureBtn = document.getElementById("measureBtn");
const measureCalibrationInput = document.getElementById("measureCalibrationInput");
const drawColorPicker = document.getElementById("drawColorPicker");
const drawColorPopover = document.getElementById("drawColorPopover");
const drawCustomColorInput = document.getElementById("drawCustomColorInput");
const clearDrawBtn = document.getElementById("clearDrawBtn");
const drawSaveWrap = document.getElementById("drawSaveWrap");
const drawSaveInput = document.getElementById("drawSaveInput");
const drawSaveDropdownBtn = document.getElementById("drawSaveDropdownBtn");
const drawSaveSuggestions = document.getElementById("drawSaveSuggestions");
const drawSaveSuggestionsList = document.getElementById("drawSaveSuggestionsList");
const drawSaveBtn = document.getElementById("drawSaveBtn");
const rotateRightBtn = document.getElementById("rotateRightBtn");
const calibrationFaceBounds = document.getElementById("calibrationFaceBounds");
const calibrationMarkerLeft = document.getElementById("calibrationMarkerLeft");
const calibrationMarkerRight = document.getElementById("calibrationMarkerRight");
const calibrationAiBadge = document.getElementById("calibrationAiBadge");
const calibrationInstructionPanel = document.getElementById("calibrationInstructionPanel");
const calibrationDebugPanel = document.getElementById("calibrationDebugPanel");
const navPrevBtn = document.getElementById("navPrevBtn");
const navNextBtn = document.getElementById("navNextBtn");
let previewRequestToken = 0;
let currentPreviewPath = "";
let navigationPaths = [];
let previewLoadInFlight = false;
let queuedPreviewPath = "";
let queuedPreviewNavPaths = null;
let currentScale = 1;
let rotationDeg = 0;
let translateX = 0;
let translateY = 0;
let controlsVisible = false;
let markModeActive = false;
let measureModeActive = false;
let selectedDrawColor = "white";
let activeCustomColorDot = null;
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
let measurementSegments = [];
let pendingMeasureStart = null;
let hoverMeasurePoint = null;
let activeMeasurementLabelDrag = null;
let measurementLabelHover = false;
let calibrationMmPerPx = null;
let calibrationReferencePixels = null;
let calibrationReferenceSegmentIndex = -1;
let drawCanvasRenderScale = 1;
let currentStroke = null;
const calibrationState = createCalibrationState();
const toolbarHiddenForMode = previewMode === "wizard";

if (toolbarHiddenForMode && previewToolbar) {
  previewToolbar.hidden = true;
  previewToolbar.setAttribute("aria-hidden", "true");
}
if (toolbarHiddenForMode && previewRoot) {
  previewRoot.classList.add("wizard-preview-mode");
}
let saveModeActive = false;
let availableTreatmentFolders = [];
let selectedExistingTreatmentFolder = "";
let saveDropdownOpen = false;
let previewWorkspaceDir = "";
let previewPatientFolder = "";
let folderRefreshRequestId = 0;
const ROTATION_UI_STATE_STORAGE_KEY = "mpm.imagePreviewRotationUiState.v1";
const DRAW_COLOR_PALETTE_STORAGE_KEY = "mpm.imagePreviewDrawPalette.v1";
const DEBUG_PREF_KEY = "showFrontendDebug";
const PREVIEW_TRACE_FORWARD_TO_RUST = FULL_TRACE;
const SAVE_BUTTON_ORANGE = "#fb923c";
let showFrontendDebug = false;
let activeCalibrationHandle = null;
let activeCalibrationDragPoint = null;
let aiCalibrationRequested = false;
let aiCalibrationCompleted = false;
let aiCalibrationPath = "";
let faceZoomAnimationFrame = 0;
let calibrationRotationDisplayDeg = 0;
let calibrationRotationAnimationFrame = 0;
let noFaceResetTimer = 0;

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
if (calibrationAiBadge) {
  calibrationAiBadge.hidden = true;
  calibrationAiBadge.style.display = "none";
}
setCalibrationButtonProcessing(false);
updateCalibrationBadgePosition();

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
  const totalRotationDeg = getTotalRotationDeg();
  const transform =
    `translate(-50%, -50%) translate(${translateX}px, ${translateY}px) rotate(${totalRotationDeg}deg) scale(${currentScale})`;
  if (previewImage) {
    previewImage.style.transform = transform;
  }
  if (drawCanvas) {
    drawCanvas.style.transform = transform;
  }
  const targetRenderScale = Math.min(8, Math.max(1, Math.max(1, window.devicePixelRatio || 1) * currentScale));
  const scaleDrift = Math.abs(targetRenderScale - drawCanvasRenderScale);
  if (drawCanvas && baseImageWidth > 0 && baseImageHeight > 0 && scaleDrift > 0.01) {
    resizeDrawCanvas();
  } else {
    redrawDrawCanvas();
  }
  updateCalibrationBadgePosition();
  updateCalibrationMarkerHandles();
  updateCalibrationFaceBounds();
  updatePanCursorState();
}

function cancelFaceZoomAnimation() {
  if (faceZoomAnimationFrame) {
    cancelAnimationFrame(faceZoomAnimationFrame);
    faceZoomAnimationFrame = 0;
  }
}

function clearNoFaceResetTimer() {
  if (noFaceResetTimer) {
    clearTimeout(noFaceResetTimer);
    noFaceResetTimer = 0;
  }
}

function cancelCalibrationRotationAnimation() {
  if (calibrationRotationAnimationFrame) {
    cancelAnimationFrame(calibrationRotationAnimationFrame);
    calibrationRotationAnimationFrame = 0;
  }
}

function syncCalibrationRotationDisplay(immediateValue = null) {
  cancelCalibrationRotationAnimation();
  calibrationRotationDisplayDeg = Number(
    immediateValue ?? calibrationState.metadata?.rotationAngleDeg ?? 0
  ) || 0;
}

function animateCalibrationRotationTo(targetDeg) {
  const nextTarget = Number(targetDeg) || 0;
  const startDeg = Number(calibrationRotationDisplayDeg) || 0;
  cancelCalibrationRotationAnimation();
  if (Math.abs(nextTarget - startDeg) < 0.001) {
    calibrationRotationDisplayDeg = nextTarget;
    applyTransform();
    return;
  }
  const durationMs = 300;
  const startTime = performance.now();
  const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
  const tick = (now) => {
    const progress = Math.min(1, (now - startTime) / durationMs);
    const eased = easeOutCubic(progress);
    calibrationRotationDisplayDeg = startDeg + ((nextTarget - startDeg) * eased);
    applyTransform();
    if (progress < 1) {
      calibrationRotationAnimationFrame = requestAnimationFrame(tick);
      return;
    }
    calibrationRotationDisplayDeg = nextTarget;
    calibrationRotationAnimationFrame = 0;
    applyTransform();
  };
  calibrationRotationAnimationFrame = requestAnimationFrame(tick);
}

function drawColorToCss(color) {
  const normalized = String(color ?? "").trim();
  if (/^#([0-9a-f]{6}|[0-9a-f]{3})$/i.test(normalized)) return normalized;
  if (color === "red") return "#e3342f";
  if (color === "blue") return "#2563eb";
  return "#ffffff";
}

function normalizeHexColor(value, fallback = "#ffffff") {
  const raw = String(value ?? "").trim();
  if (/^#[0-9a-f]{6}$/i.test(raw)) return raw.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(raw)) {
    return `#${raw[1]}${raw[1]}${raw[2]}${raw[2]}${raw[3]}${raw[3]}`.toLowerCase();
  }
  return fallback;
}

function buildDrawCursorValue(colorValue) {
  const strokeColor = normalizeHexColor(colorValue, "#000000").replace("#", "%23");
  const svg =
    `%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'%3E` +
    `%3Cpath d='M15.7 4.9L19.1 8.3L9.1 18.3L5 19.3L6 15.2L15.7 4.9Z' fill='none' stroke='${strokeColor}' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/%3E` +
    `%3Cpath d='M13.8 6.8L17.2 10.2' fill='none' stroke='${strokeColor}' stroke-width='2' stroke-linecap='round'/%3E` +
    `%3C/svg%3E`;
  return `url("data:image/svg+xml,${svg}")`;
}

function updateDrawCursor(colorValue = selectedDrawColor) {
  previewRoot?.style.setProperty("--draw-cursor", buildDrawCursorValue(colorValue));
}

function hasMeasurementSegments() {
  return Array.isArray(measurementSegments) && measurementSegments.length > 0;
}

function updateMeasurementToolbarState() {
  previewToolbar?.classList.toggle("has-measurements", hasMeasurementSegments());
}

function shouldKeepToolbarVisible() {
  return Boolean(
    calibrationState.metadata.isProcessing ||
    calibrationState.manualMode ||
    calibrationState.metadata.calibrationStatus === "success" ||
    activeCalibrationHandle
  );
}

function hasCancelableCalibrationFlow() {
  return Boolean(
    calibrationState.metadata.isProcessing ||
    calibrationState.manualMode ||
    calibrationState.metadata.calibrationStatus === "failed"
  );
}

function updateCalibrationButtonActiveState() {
  alignMarkersBtn?.classList.toggle(
    "active-state",
    !calibrationState.metadata.isProcessing &&
    (calibrationState.manualMode || calibrationState.metadata.calibrationStatus === "failed")
  );
}

function syncDebugVisibilityFromStorage() {
  try {
    const raw = localStorage.getItem(DEBUG_PREF_KEY);
    showFrontendDebug = raw === "true";
  } catch {
    showFrontendDebug = false;
  }
  updateCalibrationDebugPanel();
}

function setCalibrationButtonProcessing(isProcessing) {
  alignMarkersBtn?.classList.toggle("processing", Boolean(isProcessing));
  if (alignMarkersBtn) alignMarkersBtn.disabled = Boolean(isProcessing);
  if (!alignMarkersBtnContent) return;
  if (isProcessing) {
    alignMarkersBtnContent.innerHTML = `<span class="preview-toolbar-btn-spinner" aria-hidden="true"></span>`;
    updateCalibrationButtonActiveState();
    setControlsVisible(true);
    return;
  }
  alignMarkersBtnContent.innerHTML = getAiButtonMarkup();
  if (calibrationAiBadge) calibrationAiBadge.innerHTML = getAiButtonMarkup();
  updateCalibrationButtonActiveState();
}

function updateCalibrationBadgePosition() {
  const shouldShow = Boolean(
    aiCalibrationRequested &&
    aiCalibrationCompleted &&
    aiCalibrationPath &&
    aiCalibrationPath === currentPreviewPath &&
    calibrationState.metadata.calibrationStatus === "success" &&
    !calibrationState.metadata.isProcessing
  );
  if (
    !calibrationAiBadge ||
    !shouldShow
  ) {
    if (calibrationAiBadge) {
      calibrationAiBadge.hidden = true;
      calibrationAiBadge.style.display = "none";
    }
    return;
  }
  calibrationAiBadge.hidden = false;
  calibrationAiBadge.style.display = "grid";
}

function updateCalibrationFaceBounds() {
  if (!(calibrationFaceBounds instanceof HTMLElement)) return;
  const faceBounds = calibrationState.metadata?.faceBounds;
  if (
    !showFrontendDebug ||
    !faceBounds ||
    !(Number(faceBounds.width) > 0) ||
    !(Number(faceBounds.height) > 0)
  ) {
    calibrationFaceBounds.hidden = true;
    return;
  }
  const topLeft = getRootPointFromImagePoint({ x: faceBounds.x, y: faceBounds.y });
  const topRight = getRootPointFromImagePoint({ x: faceBounds.x + faceBounds.width, y: faceBounds.y });
  const bottomLeft = getRootPointFromImagePoint({ x: faceBounds.x, y: faceBounds.y + faceBounds.height });
  if (!topLeft || !topRight || !bottomLeft) {
    calibrationFaceBounds.hidden = true;
    return;
  }
  calibrationFaceBounds.hidden = false;
  calibrationFaceBounds.style.left = `${topLeft.x}px`;
  calibrationFaceBounds.style.top = `${topLeft.y}px`;
  calibrationFaceBounds.style.width = `${Math.max(0, topRight.x - topLeft.x)}px`;
  calibrationFaceBounds.style.height = `${Math.max(0, bottomLeft.y - topLeft.y)}px`;
}

function updateCalibrationDebugPanel() {
  if (!calibrationDebugPanel) return;
  if (!showFrontendDebug) {
    calibrationDebugPanel.hidden = true;
    updateCalibrationFaceBounds();
    return;
  }
  const lines = formatCalibrationDebug(calibrationState.metadata);
  const points = [];
  if (calibrationState.metadata.leftMarkerCenter) {
    points.push(`left: ${Number(calibrationState.metadata.leftMarkerCenter.x).toFixed(1)}, ${Number(calibrationState.metadata.leftMarkerCenter.y).toFixed(1)}`);
  }
  if (calibrationState.metadata.rightMarkerCenter) {
    points.push(`right: ${Number(calibrationState.metadata.rightMarkerCenter.x).toFixed(1)}, ${Number(calibrationState.metadata.rightMarkerCenter.y).toFixed(1)}`);
  }
  const allLines = [
    ...lines,
    ...points,
  ].filter(Boolean);
  calibrationDebugPanel.hidden = allLines.length < 1;
  calibrationDebugPanel.textContent = allLines.join("\n");
  updateCalibrationFaceBounds();
}

function updateCalibrationInstructionPanel() {
  if (!calibrationInstructionPanel) return;
  const noFaceMessage = t("preview.no_face_detected");
  const shouldShowNoFaceMessage =
    !calibrationState.manualMode &&
    String(calibrationState.lastError ?? "").trim() === noFaceMessage &&
    calibrationState.metadata.calibrationStatus === "failed";
  if (!calibrationState.manualMode && !shouldShowNoFaceMessage) {
    calibrationInstructionPanel.hidden = true;
    calibrationInstructionPanel.textContent = "";
    return;
  }
  calibrationInstructionPanel.hidden = false;
  if (shouldShowNoFaceMessage) {
    calibrationInstructionPanel.textContent = noFaceMessage;
    return;
  }
  calibrationInstructionPanel.textContent = calibrationState.manualStep < 1
    ? t("preview.select_left_marker")
    : t("preview.select_right_marker");
}

function getTranslationForCenteredImagePoint(imagePoint, scale = currentScale) {
  if (!imagePoint) return { x: translateX, y: translateY };
  const localX = Number(imagePoint.x ?? 0) - (baseImageWidth / 2);
  const localY = Number(imagePoint.y ?? 0) - (baseImageHeight / 2);
  const angle = (getTotalRotationDeg() * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const rotatedX = (localX * cos) - (localY * sin);
  const rotatedY = (localX * sin) + (localY * cos);
  return clampTranslation(-(rotatedX * scale), -(rotatedY * scale), scale);
}

function maybeZoomToFaceBounds() {
  const faceBounds = calibrationState.metadata?.faceBounds;
  const faceDetectionSource = String(calibrationState.metadata?.faceDetectionSource ?? "").trim().toLowerCase();
  if (
    faceDetectionSource === "head" ||
    !faceBounds ||
    !(Number(faceBounds.width) > 0) ||
    !(Number(faceBounds.height) > 0)
  ) {
    return;
  }
  const { height: rootHeight } = getRootSize();
  const faceHeight = Number(faceBounds.height) || 0;
  if (!(rootHeight > 0) || !(faceHeight > 0)) return;
  const targetScale = clampScale((rootHeight * 0.8) / faceHeight);
  if (!Number.isFinite(targetScale) || targetScale <= 0) return;
  if (currentScale >= targetScale * 0.9) return;
  const faceCenter = {
    x: Number(faceBounds.x) + (Number(faceBounds.width) / 2),
    y: Number(faceBounds.y) + (Number(faceBounds.height) / 2),
  };
  const startScale = currentScale;
  const startTranslateX = translateX;
  const startTranslateY = translateY;
  const endCentered = getTranslationForCenteredImagePoint(faceCenter, targetScale);
  const endTranslateX = endCentered.x;
  const endTranslateY = endCentered.y;
  const durationMs = 700;
  const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
  cancelFaceZoomAnimation();
  const startTime = performance.now();

  const tick = (now) => {
    const progress = Math.min(1, (now - startTime) / durationMs);
    const eased = easeOutCubic(progress);
    currentScale = startScale + ((targetScale - startScale) * eased);
    translateX = startTranslateX + ((endTranslateX - startTranslateX) * eased);
    translateY = startTranslateY + ((endTranslateY - startTranslateY) * eased);
    applyTransform();
    if (progress < 1) {
      faceZoomAnimationFrame = requestAnimationFrame(tick);
      return;
    }
    faceZoomAnimationFrame = 0;
  };

  faceZoomAnimationFrame = requestAnimationFrame(tick);
}

function normalizeFaceBoundsFromMarkers(
  leftPoint,
  rightPoint,
  existingFaceBounds = calibrationState.metadata?.faceBounds ?? null,
  options = {},
) {
  if (!leftPoint || !rightPoint) return existingFaceBounds ?? null;
  const manualFixedWidth = Boolean(options?.manualFixedWidth);
  const markerDistance = Math.max(
    1,
    Math.hypot(
      Number(rightPoint.x) - Number(leftPoint.x),
      Number(rightPoint.y) - Number(leftPoint.y),
    ),
  );
  const markerCenterX = (Number(leftPoint.x) + Number(rightPoint.x)) / 2;
  const markerCenterY = (Number(leftPoint.y) + Number(rightPoint.y)) / 2;
  const minWidth = markerDistance * 0.8;
  const maxWidth = markerDistance * 1.2;
  let width = maxWidth;
  let height = markerDistance * 1.35;

  if (!manualFixedWidth && existingFaceBounds && Number(existingFaceBounds.width) > 0 && Number(existingFaceBounds.height) > 0) {
    width = Math.min(maxWidth, Math.max(minWidth, Number(existingFaceBounds.width)));
    height = Math.max(height, Number(existingFaceBounds.height), width);
  }

  width = Math.min(width, baseImageWidth * 0.92);
  height = Math.min(Math.max(height, width), Math.min(baseImageHeight * 0.92, width * 1.5));
  const x = Math.max(0, markerCenterX - (width / 2));
  const y = Math.max(0, markerCenterY - (height / 2));
  const clampedWidth = Math.max(0, Math.min(width, baseImageWidth - x));
  const clampedHeight = Math.max(0, Math.min(height, baseImageHeight - y));
  return {
    x,
    y,
    width: clampedWidth,
    height: clampedHeight,
  };
}

function formatMeasurementMm(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return t("preview.calibration_placeholder");
  return `${numeric.toFixed(1)} mm`;
}

function setCalibrationEditing(active) {
  if (!measureCalibrationInput) return;
  if (active) {
    measureCalibrationInput.focus();
    measureCalibrationInput.select();
  }
}

function updateCalibrationDisplay() {
  if (!measureCalibrationInput) return;
  if (Number.isFinite(calibrationMmPerPx) && calibrationMmPerPx > 0 && Number.isFinite(calibrationReferencePixels) && calibrationReferencePixels > 0) {
    measureCalibrationInput.value = (calibrationMmPerPx * calibrationReferencePixels).toFixed(1);
  } else {
    measureCalibrationInput.value = "";
  }
}

function syncCalibrationReferenceSegment() {
  measurementSegments.forEach((segment, index) => {
    segment.isCalibrationReference = index === calibrationReferenceSegmentIndex;
  });
}

function getDotColorValue(dot) {
  if (!(dot instanceof HTMLElement)) return "#ffffff";
  return normalizeHexColor(dot.dataset.drawColorValue || drawColorToCss(dot.dataset.color), "#ffffff");
}

function applyDotColorStyles(dot, colorValue) {
  if (!(dot instanceof HTMLElement)) return;
  const normalized = normalizeHexColor(colorValue, "#ffffff");
  dot.dataset.drawColorValue = normalized;
  dot.style.backgroundColor = normalized;
  const isLight = normalized === "#ffffff";
  dot.style.setProperty("--draw-dot-border-color", isLight ? "rgba(0,0,0,0.2)" : "rgba(255,255,255,0.28)");
}

function saveDrawPalette() {
  try {
    const palette = {};
    for (const dot of Array.from(drawColorPicker?.querySelectorAll(".draw-color-dot") ?? [])) {
      const key = String(dot?.dataset?.color ?? "").trim();
      if (!key) continue;
      palette[key] = getDotColorValue(dot);
    }
    localStorage.setItem(DRAW_COLOR_PALETTE_STORAGE_KEY, JSON.stringify(palette));
  } catch {
    // ignore storage errors
  }
}

function loadStoredDrawPalette() {
  try {
    const raw = localStorage.getItem(DRAW_COLOR_PALETTE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function applyInitialDrawPalette() {
  const storedPalette = loadStoredDrawPalette();
  for (const dot of Array.from(drawColorPicker?.querySelectorAll(".draw-color-dot") ?? [])) {
    const key = String(dot?.dataset?.color ?? "").trim();
    const fallback = drawColorToCss(key);
    const nextColor = storedPalette && typeof storedPalette[key] === "string"
      ? storedPalette[key]
      : fallback;
    applyDotColorStyles(dot, nextColor);
  }
}

function setDrawColorPopoverOpen(open, anchorDot = activeCustomColorDot) {
  if (!drawColorPopover) return;
  const shouldOpen = Boolean(open && anchorDot instanceof HTMLElement && previewToolbar);
  drawColorPopover.hidden = !shouldOpen;
  if (!shouldOpen) return;
  const toolbarRect = previewToolbar.getBoundingClientRect();
  const dotRect = anchorDot.getBoundingClientRect();
  const popoverWidth = drawColorPopover.offsetWidth || 44;
  const left = (dotRect.left - toolbarRect.left) + (dotRect.width / 2) - (popoverWidth / 2);
  drawColorPopover.style.left = `${Math.max(0, left)}px`;
}

function resizeDrawCanvas() {
  if (!drawCanvas) return;
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  drawCanvasRenderScale = Math.min(8, Math.max(dpr, dpr * currentScale));
  const w = Math.max(1, Math.round(baseImageWidth * drawCanvasRenderScale));
  const h = Math.max(1, Math.round(baseImageHeight * drawCanvasRenderScale));
  if (drawCanvas.width !== w) drawCanvas.width = w;
  if (drawCanvas.height !== h) drawCanvas.height = h;
  drawCanvas.style.width = `${Math.round(baseImageWidth)}px`;
  drawCanvas.style.height = `${Math.round(baseImageHeight)}px`;
  redrawDrawCanvas();
}

function clearDrawCanvas() {
  if (!drawCanvas) return;
  const ctx = drawCanvas.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
  hasDrawnLines = false;
  lineSegments = [];
  measurementSegments = [];
  pendingMeasureStart = null;
  hoverMeasurePoint = null;
  activeMeasurementLabelDrag = null;
  setMeasurementLabelHover(false);
  setMeasurementLabelDragging(false);
  calibrationReferenceSegmentIndex = -1;
  currentStroke = null;
  previewToolbar?.classList.remove("has-lines");
  previewToolbar?.classList.remove("has-measurements");
  setSaveModeActive(false);
  redrawDrawCanvas();
}

function clearDrawOnly() {
  hasDrawnLines = false;
  lineSegments = [];
  currentStroke = null;
  previewToolbar?.classList.remove("has-lines");
  setSaveModeActive(false);
  redrawDrawCanvas();
}

function clearMeasurementsOnly() {
  measurementSegments = [];
  pendingMeasureStart = null;
  hoverMeasurePoint = null;
  activeMeasurementLabelDrag = null;
  setMeasurementLabelHover(false);
  setMeasurementLabelDragging(false);
  calibrationReferenceSegmentIndex = -1;
  previewToolbar?.classList.remove("has-measurements");
  setSaveModeActive(false);
  redrawDrawCanvas();
}

function drawPointFromClient(clientX, clientY) {
  const point = getImagePointFromClient(clientX, clientY);
  if (!point || !drawCanvas || baseImageWidth <= 0 || baseImageHeight <= 0) return null;
  const { sx, sy } = getDrawScale();
  return {
    x: point.x * sx,
    y: point.y * sy,
  };
}

function getDrawScale() {
  const fallback = Math.max(1, window.devicePixelRatio || 1);
  const sx = baseImageWidth > 0 ? drawCanvas.width / baseImageWidth : drawCanvasRenderScale || fallback;
  const sy = baseImageHeight > 0 ? drawCanvas.height / baseImageHeight : drawCanvasRenderScale || fallback;
  return {
    sx,
    sy,
  };
}

function getImagePointFromClient(clientX, clientY) {
  if (!previewRoot || baseImageWidth <= 0 || baseImageHeight <= 0) return null;
  const point = getPointInRoot(clientX, clientY);
  if (!point) return null;
  const { width: rootWidth, height: rootHeight } = getRootSize();
  const centerX = (rootWidth / 2) + translateX;
  const centerY = (rootHeight / 2) + translateY;
  const scaledX = (point.x - centerX) / currentScale;
  const scaledY = (point.y - centerY) / currentScale;
  const angle = (-getTotalRotationDeg() * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const localX = (scaledX * cos) - (scaledY * sin);
  const localY = (scaledX * sin) + (scaledY * cos);
  const x = localX + (baseImageWidth / 2);
  const y = localY + (baseImageHeight / 2);
  if (x < 0 || y < 0 || x > baseImageWidth || y > baseImageHeight) return null;
  return { x, y };
}

function redrawDrawCanvas() {
  if (!drawCanvas) return;
  const ctx = drawCanvas.getContext("2d");
  if (!ctx) return;
  ctx.imageSmoothingEnabled = true;
  ctx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
  const { sx, sy } = getDrawScale();
  const baseStrokeWidth = Math.max(1.15, Math.min(2.1, 1.35 * Math.max(window.devicePixelRatio || 1, 1)));
  if (Array.isArray(lineSegments) && lineSegments.length > 0) {
    for (const stroke of lineSegments) {
      if (!stroke || !Array.isArray(stroke.points) || stroke.points.length < 1) continue;
      const points = stroke.points;
      ctx.strokeStyle = drawColorToCss(stroke.color);
      ctx.lineWidth = baseStrokeWidth * Math.max(sx, sy);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      if (points.length === 1) {
        const p = points[0];
        ctx.arc(p.x * sx, p.y * sy, ctx.lineWidth * 0.5, 0, Math.PI * 2);
        ctx.fillStyle = drawColorToCss(stroke.color);
        ctx.fill();
        continue;
      }
      ctx.moveTo(points[0].x * sx, points[0].y * sy);
      for (let i = 1; i < points.length - 1; i += 1) {
        const current = points[i];
        const next = points[i + 1];
        const midX = ((current.x + next.x) / 2) * sx;
        const midY = ((current.y + next.y) / 2) * sy;
        ctx.quadraticCurveTo(current.x * sx, current.y * sy, midX, midY);
      }
      const penultimate = points[points.length - 2];
      const last = points[points.length - 1];
      ctx.quadraticCurveTo(penultimate.x * sx, penultimate.y * sy, last.x * sx, last.y * sy);
      ctx.stroke();
    }
  }
  drawMeasurementSegments(ctx, sx, sy);
  drawCalibrationOverlay(ctx, sx, sy);
}

function drawCrossMarker(ctx, x, y, size, color) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(0.8, size * 0.07);
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(x - size, y);
  ctx.lineTo(x + size, y);
  ctx.moveTo(x, y - size);
  ctx.lineTo(x, y + size);
  ctx.stroke();
  ctx.fillStyle = "#000000";
  ctx.beginPath();
  ctx.arc(x, y, Math.max(1, size * 0.12), 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function getMeasurementLabel(segment) {
  const mm = Number(segment?.mm);
  return Number.isFinite(mm) && mm > 0 ? formatMeasurementMm(mm) : t("preview.calibration_placeholder");
}

function getMeasurementLabelPosition(segment, markerSize = 0) {
  const fallbackX = (Number(segment?.start?.x ?? 0) + Number(segment?.end?.x ?? 0)) / 2;
  const fallbackY = ((Number(segment?.start?.y ?? 0) + Number(segment?.end?.y ?? 0)) / 2) - Math.max(18, markerSize + 7);
  return {
    x: Number(segment?.labelX),
    y: Number(segment?.labelY),
    fallbackX,
    fallbackY,
  };
}

function getTotalRotationDeg() {
  return rotationDeg + calibrationRotationDisplayDeg;
}

function getRootPointFromImagePoint(imagePoint) {
  if (!imagePoint) return null;
  const { width: rootWidth, height: rootHeight } = getRootSize();
  const localX = Number(imagePoint.x ?? 0) - (baseImageWidth / 2);
  const localY = Number(imagePoint.y ?? 0) - (baseImageHeight / 2);
  const angle = (getTotalRotationDeg() * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const rotatedX = (localX * cos) - (localY * sin);
  const rotatedY = (localX * sin) + (localY * cos);
  return {
    x: (rootWidth / 2) + translateX + (rotatedX * currentScale),
    y: (rootHeight / 2) + translateY + (rotatedY * currentScale),
  };
}

function normalizePointToPreviewCoordinates(point) {
  const x = Number(point?.x);
  const y = Number(point?.y);
  const naturalWidth = Number(previewImage?.naturalWidth) || 0;
  const naturalHeight = Number(previewImage?.naturalHeight) || 0;
  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    naturalWidth <= 0 ||
    naturalHeight <= 0 ||
    baseImageWidth <= 0 ||
    baseImageHeight <= 0
  ) {
    return point;
  }
  return {
    x: (x / naturalWidth) * baseImageWidth,
    y: (y / naturalHeight) * baseImageHeight,
  };
}

function normalizeRectToPreviewCoordinates(rect) {
  const x = Number(rect?.x);
  const y = Number(rect?.y);
  const width = Number(rect?.width);
  const height = Number(rect?.height);
  const naturalWidth = Number(previewImage?.naturalWidth) || 0;
  const naturalHeight = Number(previewImage?.naturalHeight) || 0;
  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    naturalWidth <= 0 ||
    naturalHeight <= 0 ||
    baseImageWidth <= 0 ||
    baseImageHeight <= 0
  ) {
    return rect;
  }
  return {
    x: (x / naturalWidth) * baseImageWidth,
    y: (y / naturalHeight) * baseImageHeight,
    width: (width / naturalWidth) * baseImageWidth,
    height: (height / naturalHeight) * baseImageHeight,
  };
}

function updateCalibrationMarkerHandles() {
  const manualLeft = calibrationState.manualPoints[0] ?? null;
  const manualRight = calibrationState.manualPoints[1] ?? null;
  const pairs = [
    [
      calibrationMarkerLeft,
      activeCalibrationHandle === "left" && activeCalibrationDragPoint
        ? activeCalibrationDragPoint
        : (calibrationState.manualMode ? manualLeft : calibrationState.metadata?.leftMarkerCenter),
      "left",
    ],
    [
      calibrationMarkerRight,
      activeCalibrationHandle === "right" && activeCalibrationDragPoint
        ? activeCalibrationDragPoint
        : (calibrationState.manualMode ? manualRight : calibrationState.metadata?.rightMarkerCenter),
      "right",
    ],
  ];
  for (const [el, point, side] of pairs) {
    if (
      !(el instanceof HTMLElement) ||
      !point ||
      calibrationState.metadata.isProcessing ||
      (!calibrationState.manualMode && calibrationState.metadata.calibrationStatus !== "success")
    ) {
      if (el instanceof HTMLElement) el.hidden = true;
      continue;
    }
    const rootPoint = getRootPointFromImagePoint(point);
    if (!rootPoint) {
      el.hidden = true;
      continue;
    }
    el.hidden = false;
    el.dataset.markerSide = side;
    el.style.left = `${rootPoint.x}px`;
    el.style.top = `${rootPoint.y}px`;
  }
}

function findCalibrationHandleHit(clientX, clientY) {
  for (const el of [calibrationMarkerLeft, calibrationMarkerRight]) {
    if (!(el instanceof HTMLElement) || el.hidden) continue;
    const rect = el.getBoundingClientRect();
    if (clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom) {
      return el;
    }
  }
  return null;
}

function getMeasurementLabelRect(ctx, text, x, y) {
  const metrics = ctx.measureText(text);
  const width = metrics.width + 14;
  const height = 22;
  return {
    left: x - (width / 2),
    top: y - (height / 2),
    width,
    height,
  };
}

function fillRoundedRect(ctx, x, y, width, height, radius) {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
  ctx.fill();
}

function drawMeasurementLabel(ctx, text, x, y) {
  ctx.save();
  ctx.font = `${Math.max(13, 13 * Math.max(window.devicePixelRatio || 1, 1))}px "Avenir Next", "Segoe UI", sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const rect = getMeasurementLabelRect(ctx, text, x, y);
  const left = rect.left;
  const top = rect.top;
  ctx.globalAlpha = 1;
  ctx.fillStyle = "rgba(0,0,0,0.3)";
  fillRoundedRect(ctx, left, top, rect.width, rect.height, 5);
  ctx.globalAlpha = 1;
  ctx.fillStyle = "#ffffff";
  ctx.fillText(text, x, y + 0.5);
  ctx.restore();
  return rect;
}

function drawMeasurementLabelWithColor(ctx, text, x, y, textColor = "#ffffff") {
  ctx.save();
  ctx.font = `${Math.max(13, 13 * Math.max(window.devicePixelRatio || 1, 1))}px "Avenir Next", "Segoe UI", sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const rect = getMeasurementLabelRect(ctx, text, x, y);
  ctx.globalAlpha = 1;
  ctx.fillStyle = "rgba(0,0,0,0.3)";
  fillRoundedRect(ctx, rect.left, rect.top, rect.width, rect.height, 5);
  ctx.globalAlpha = 1;
  ctx.fillStyle = textColor;
  ctx.fillText(text, x, y + 0.5);
  ctx.restore();
  return rect;
}

function setMeasurementLabelHover(active) {
  measurementLabelHover = Boolean(active);
  previewRoot?.classList.toggle("measure-label-hover", measurementLabelHover);
}

function setMeasurementLabelDragging(active) {
  previewRoot?.classList.toggle("dragging-measure-label", Boolean(active));
}

function getMeasurementLeaderAnchor(segment) {
  const labelX = Number(segment?.labelX);
  const labelY = Number(segment?.labelY);
  if (!Number.isFinite(labelX) || !Number.isFinite(labelY)) {
    return segment?.start ?? { x: 0, y: 0 };
  }
  const start = segment?.start ?? { x: 0, y: 0 };
  const end = segment?.end ?? { x: 0, y: 0 };
  const startDistance = Math.hypot(labelX - Number(start.x ?? 0), labelY - Number(start.y ?? 0));
  const endDistance = Math.hypot(labelX - Number(end.x ?? 0), labelY - Number(end.y ?? 0));
  return endDistance < startDistance ? end : start;
}

function findMeasurementLabelHit(clientX, clientY) {
  if (!drawCanvas || measurementSegments.length < 1) return null;
  const ctx = drawCanvas.getContext("2d");
  if (!ctx) return null;
  const imagePoint = getImagePointFromClient(clientX, clientY);
  if (!imagePoint) return null;
  const { sx, sy } = getDrawScale();
  ctx.save();
  ctx.font = `${Math.max(13, 13 * Math.max(window.devicePixelRatio || 1, 1))}px "Avenir Next", "Segoe UI", sans-serif`;
  const canvasX = imagePoint.x * sx;
  const canvasY = imagePoint.y * sy;
  for (let i = measurementSegments.length - 1; i >= 0; i -= 1) {
    const segment = measurementSegments[i];
    if (!segment?.start || !segment?.end) continue;
    const markerSize = Math.max(6, 5.5 * Math.max(sx, sy));
    const labelPosition = getMeasurementLabelPosition(segment, markerSize);
    const labelX = Number.isFinite(labelPosition.x) ? labelPosition.x : labelPosition.fallbackX;
    const labelY = Number.isFinite(labelPosition.y) ? labelPosition.y : labelPosition.fallbackY;
    const rect = getMeasurementLabelRect(ctx, getMeasurementLabel(segment), labelX * sx, labelY * sy);
    if (
      canvasX >= rect.left &&
      canvasX <= rect.left + rect.width &&
      canvasY >= rect.top &&
      canvasY <= rect.top + rect.height
    ) {
      ctx.restore();
      return {
        index: i,
        offsetX: imagePoint.x - labelX,
        offsetY: imagePoint.y - labelY,
      };
    }
  }
  ctx.restore();
  return null;
}

function renderMeasurementLabelSprite(text) {
  return renderMeasurementLabelSpriteWithColor(text, "#ffffff");
}

function renderMeasurementLabelSpriteWithColor(text, textColor = "#ffffff") {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const scale = 4;
  const logicalFontSize = 13;
  ctx.font = `${logicalFontSize}px "Avenir Next", "Segoe UI", sans-serif`;
  const rect = getMeasurementLabelRect(ctx, text, 0, 0);
  const width = Math.ceil(rect.width);
  const height = Math.ceil(rect.height);
  canvas.width = width * scale;
  canvas.height = height * scale;
  ctx.scale(scale, scale);
  ctx.font = `${logicalFontSize}px "Avenir Next", "Segoe UI", sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.globalAlpha = 1;
  ctx.fillStyle = "rgba(0,0,0,0.3)";
  fillRoundedRect(ctx, 0, 0, width, height, 5);
  ctx.globalAlpha = 1;
  ctx.fillStyle = textColor;
  ctx.fillText(text, width / 2, (height / 2) + 0.5);
  return {
    dataUrl: canvas.toDataURL("image/png"),
    width,
    height,
  };
}

function getMeasurementLabelTextColor(segment) {
  return segment?.isCalibrationReference ? SAVE_BUTTON_ORANGE : "#ffffff";
}

function drawMeasurementSegments(ctx, sx, sy) {
  const markerSize = Math.max(3.5, 3.1 * Math.max(sx, sy));
  const lineWidth = Math.max(0.9, 0.72 * Math.max(sx, sy));
  for (const segment of measurementSegments) {
    if (!segment?.start || !segment?.end) continue;
    const ax = segment.start.x * sx;
    const ay = segment.start.y * sy;
    const bx = segment.end.x * sx;
    const by = segment.end.y * sy;
    ctx.save();
    ctx.strokeStyle = "#f8fafc";
    ctx.lineWidth = lineWidth;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.stroke();
    ctx.restore();
    drawCrossMarker(ctx, ax, ay, markerSize, "#f8fafc");
    drawCrossMarker(ctx, bx, by, markerSize, "#f8fafc");
    const labelPosition = getMeasurementLabelPosition(segment, markerSize);
    const labelX = Number.isFinite(labelPosition.x) ? labelPosition.x : labelPosition.fallbackX;
    const labelY = Number.isFinite(labelPosition.y) ? labelPosition.y : labelPosition.fallbackY;
    const anchor = getMeasurementLeaderAnchor(segment);
    ctx.save();
    ctx.strokeStyle = "rgba(226,232,240,0.95)";
    ctx.lineWidth = Math.max(0.5, 0.42 * Math.max(sx, sy));
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(anchor.x * sx, anchor.y * sy);
    ctx.lineTo(labelX * sx, labelY * sy);
    ctx.stroke();
    ctx.restore();
    drawMeasurementLabelWithColor(
      ctx,
      getMeasurementLabel(segment),
      labelX * sx,
      labelY * sy,
      getMeasurementLabelTextColor(segment),
    );
  }
  if (measureModeActive && pendingMeasureStart && hoverMeasurePoint) {
    const ax = pendingMeasureStart.x * sx;
    const ay = pendingMeasureStart.y * sy;
    const bx = hoverMeasurePoint.x * sx;
    const by = hoverMeasurePoint.y * sy;
    ctx.save();
    ctx.strokeStyle = "rgba(248,250,252,0.9)";
    ctx.lineWidth = lineWidth;
    ctx.setLineDash([6, 6]);
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.stroke();
    ctx.restore();
    drawCrossMarker(ctx, ax, ay, markerSize, "#f8fafc");
    drawCrossMarker(ctx, bx, by, markerSize, "#f8fafc");
  }
}

function drawCalibrationOverlay(ctx, sx, sy) {
  void ctx;
  void sx;
  void sy;
}

function continueDrawingTo(clientX, clientY) {
  if (!drawCanvas || !isDrawingLine || !lastDrawPoint) return;
  const next = getImagePointFromClient(clientX, clientY);
  if (!next) return;
  const minPointDistance = 0.7;
  const dx = next.x - lastDrawPoint.x;
  const dy = next.y - lastDrawPoint.y;
  if (Math.hypot(dx, dy) < minPointDistance) return;
  if (currentStroke && Array.isArray(currentStroke.points)) {
    currentStroke.points.push(next);
  }
  if (!hasDrawnLines) {
    hasDrawnLines = true;
    previewToolbar?.classList.add("has-lines");
  }
  redrawDrawCanvas();
  lastDrawPoint = next;
}

function updateMeasurementValues() {
  if (!(Number.isFinite(calibrationMmPerPx) && calibrationMmPerPx > 0)) {
    for (const segment of measurementSegments) {
      segment.mm = null;
    }
    redrawDrawCanvas();
    updateCalibrationDisplay();
    return;
  }
  for (const segment of measurementSegments) {
    const dx = Number(segment?.end?.x ?? 0) - Number(segment?.start?.x ?? 0);
    const dy = Number(segment?.end?.y ?? 0) - Number(segment?.start?.y ?? 0);
    segment.mm = Math.hypot(dx, dy) * calibrationMmPerPx;
  }
  syncCalibrationReferenceSegment();
  redrawDrawCanvas();
  updateCalibrationDisplay();
}

function applyCalibrationMm(value) {
  const numeric = Number(String(value ?? "").replace(",", "."));
  if (!(Number.isFinite(numeric) && numeric > 0)) return false;
  if (measurementSegments.length > 0) {
    const latestIndex = measurementSegments.length - 1;
    const latestSegment = measurementSegments[latestIndex];
    const dx = Number(latestSegment?.end?.x ?? 0) - Number(latestSegment?.start?.x ?? 0);
    const dy = Number(latestSegment?.end?.y ?? 0) - Number(latestSegment?.start?.y ?? 0);
    const latestPixels = Math.hypot(dx, dy);
    if (Number.isFinite(latestPixels) && latestPixels > 0) {
      calibrationReferencePixels = latestPixels;
      calibrationReferenceSegmentIndex = latestIndex;
    }
  }
  if (!(Number.isFinite(calibrationReferencePixels) && calibrationReferencePixels > 0)) return false;
  calibrationMmPerPx = numeric / calibrationReferencePixels;
  syncCalibrationReferenceSegment();
  updateMeasurementValues();
  return true;
}

function beginCalibrationEdit() {
  if (!measureCalibrationInput) return;
  measureCalibrationInput.value =
    Number.isFinite(calibrationMmPerPx) && calibrationMmPerPx > 0 && Number.isFinite(calibrationReferencePixels) && calibrationReferencePixels > 0
      ? (calibrationMmPerPx * calibrationReferencePixels).toFixed(1)
      : "";
  setCalibrationEditing(true);
  measureCalibrationInput.focus();
  measureCalibrationInput.select();
}

function commitCalibrationInput() {
  if (!measureCalibrationInput) return;
  const raw = String(measureCalibrationInput.value ?? "").trim();
  if (!raw) {
    setCalibrationEditing(false);
    updateCalibrationDisplay();
    return;
  }
  if (applyCalibrationMm(raw)) {
    setCalibrationEditing(false);
    measureCalibrationInput.blur();
    return;
  }
  measureCalibrationInput.focus();
  measureCalibrationInput.select();
}

function applyCalibrationResult(metadataInput) {
  const nextRotationDeg = Number(metadataInput?.rotationAngleDeg ?? 0) || 0;
  calibrationState.metadata = buildCalibrationMetadata(metadataInput);
  calibrationState.manualMode = false;
  calibrationState.manualStep = 0;
  calibrationState.manualPoints = [];
  calibrationState.lastError = "";
  calibrationMmPerPx = calibrationState.metadata.mmPerPx > 0 ? calibrationState.metadata.mmPerPx : null;
  calibrationReferencePixels = calibrationState.metadata.markerDistancePx > 0 ? calibrationState.metadata.markerDistancePx : null;
  setControlsVisible(true);
  updateMeasurementValues();
  updateCalibrationDebugPanel();
  updateCalibrationInstructionPanel();
  applyTransform();
  maybeZoomToFaceBounds();
  updateCalibrationButtonActiveState();
  animateCalibrationRotationTo(nextRotationDeg);
}

function recomputeCalibrationFromCurrentMarkers(source = calibrationState.metadata.calibrationSource || "manual") {
  const left = calibrationState.metadata.leftMarkerCenter;
  const right = calibrationState.metadata.rightMarkerCenter;
  if (!left || !right) return;
  const computed = computeMarkerCalibration(left, right);
  applyCalibrationResult({
    ...computed,
    calibrationStatus: "success",
    detectionConfidence: Number(calibrationState.metadata.detectionConfidence) || 1,
    isProcessing: false,
    calibrationSource: source,
    faceBounds: normalizeFaceBoundsFromMarkers(left, right, calibrationState.metadata?.faceBounds ?? null),
    faceDetectionSource: calibrationState.metadata?.faceDetectionSource ?? null,
  });
}

function setCalibrationFailure(message, metadataInput = {}) {
  aiCalibrationCompleted = false;
  aiCalibrationPath = "";
  calibrationState.metadata = buildCalibrationMetadata({
    ...metadataInput,
    calibrationStatus: "failed",
    isProcessing: false,
  });
  calibrationState.lastError = localizeCalibrationErrorMessage(message, "preview.calibration_failed");
  syncCalibrationRotationDisplay(0);
  updateCalibrationDebugPanel();
  updateCalibrationInstructionPanel();
  redrawDrawCanvas();
  updateCalibrationBadgePosition();
  maybeZoomToFaceBounds();
  updateCalibrationButtonActiveState();
}

function enableManualCalibrationMode(reason = "") {
  aiCalibrationCompleted = false;
  aiCalibrationPath = "";
  calibrationState.manualMode = true;
  calibrationState.manualStep = 0;
  calibrationState.manualPoints = [];
  calibrationState.lastError = String(reason ?? "");
  previewRoot?.classList.add("calibration-manual-mode");
  setControlsVisible(true);
  updateCalibrationDebugPanel();
  updateCalibrationInstructionPanel();
  redrawDrawCanvas();
  updateCalibrationButtonActiveState();
}

function disableManualCalibrationMode() {
  calibrationState.manualMode = false;
  calibrationState.manualStep = 0;
  calibrationState.manualPoints = [];
  previewRoot?.classList.remove("calibration-manual-mode");
  updateCalibrationDebugPanel();
  updateCalibrationInstructionPanel();
  updateCalibrationButtonActiveState();
}

function cancelCalibrationFlow() {
  clearNoFaceResetTimer();
  cancelFaceZoomAnimation();
  syncCalibrationRotationDisplay(0);
  calibrationState.requestId += 1;
  setCalibrationProcessing(calibrationState, false);
  stopCalibrationHandleDrag();
  resetCalibrationState(calibrationState);
  calibrationMmPerPx = null;
  calibrationReferencePixels = null;
  aiCalibrationRequested = false;
  aiCalibrationCompleted = false;
  aiCalibrationPath = "";
  previewRoot?.classList.remove("calibration-manual-mode");
  updateMeasurementValues();
  updateCalibrationDebugPanel();
  updateCalibrationInstructionPanel();
  setCalibrationButtonProcessing(false);
  updateCalibrationBadgePosition();
  redrawDrawCanvas();
  applyTransform();
}

function isNoFaceDetectionFailure(message) {
  return localizeCalibrationErrorMessage(message, "preview.no_face_detected").trim().toLowerCase()
    === t("preview.no_face_detected").trim().toLowerCase();
}

function scheduleNoFaceReset() {
  clearNoFaceResetTimer();
  noFaceResetTimer = window.setTimeout(() => {
    noFaceResetTimer = 0;
    cancelCalibrationFlow();
  }, 3000);
}

function localizeCalibrationErrorMessage(message, fallbackKey = "preview.calibration_failed") {
  const normalized = String(message ?? "").trim();
  if (!normalized) return t(fallbackKey);
  const mapping = new Map([
    ["No face detected.", "preview.no_face_detected"],
    ["Calibration failed.", "preview.calibration_failed"],
    ["Manual calibration failed.", "preview.manual_calibration_failed"],
    ["Automatic detection failed.", "preview.auto_detection_failed"],
    ["Automatic detection was too uncertain. Manual calibration is enabled.", "preview.auto_detection_uncertain"],
  ]);
  const key = mapping.get(normalized);
  return key ? t(key) : normalized;
}

function startCalibrationHandleDrag(handle, pointerId) {
  if (!(handle instanceof HTMLElement)) return;
  activeCalibrationHandle = handle.dataset.markerSide || null;
  if (calibrationState.manualMode) {
    activeCalibrationDragPoint = activeCalibrationHandle === "left"
      ? calibrationState.manualPoints[0] ?? null
      : calibrationState.manualPoints[1] ?? null;
  } else {
    activeCalibrationDragPoint = activeCalibrationHandle === "left"
      ? calibrationState.metadata?.leftMarkerCenter ?? null
      : calibrationState.metadata?.rightMarkerCenter ?? null;
  }
  handle.classList.add("dragging");
  handle.setPointerCapture?.(pointerId);
  setControlsVisible(true);
  redrawDrawCanvas();
  updateCalibrationMarkerHandles();
}

function finalizeManualCalibration() {
  if (calibrationState.manualPoints.length < 2) return;
  try {
    const [first, second] = calibrationState.manualPoints;
    const computed = computeMarkerCalibration(first, second);
    disableManualCalibrationMode();
    applyCalibrationResult({
      ...computed,
      calibrationStatus: "success",
      detectionConfidence: 1,
      isProcessing: false,
      calibrationSource: "manual",
      faceBounds: normalizeFaceBoundsFromMarkers(first, second, calibrationState.metadata?.faceBounds ?? null, {
        manualFixedWidth: true,
      }),
      faceDetectionSource: calibrationState.metadata?.faceDetectionSource ?? null,
      detectionConfidenceCutoff: calibrationState.metadata?.detectionConfidenceCutoff ?? 0.55,
    });
  } catch (err) {
    setCalibrationFailure(localizeCalibrationErrorMessage(err, "preview.manual_calibration_failed"), {
      faceBounds: calibrationState.metadata?.faceBounds ?? null,
      detectionConfidenceCutoff: calibrationState.metadata?.detectionConfidenceCutoff ?? 0.55,
    });
  }
}

function stopCalibrationHandleDrag(pointerId = null) {
  if (!activeCalibrationHandle) return;
  const handle = activeCalibrationHandle === "left" ? calibrationMarkerLeft : calibrationMarkerRight;
  const dragSide = activeCalibrationHandle;
  const dragPoint = activeCalibrationDragPoint;
  handle?.classList.remove("dragging");
  if (pointerId !== null) {
    handle?.releasePointerCapture?.(pointerId);
  }
  activeCalibrationHandle = null;
  activeCalibrationDragPoint = null;
  if (dragPoint) {
    if (calibrationState.manualMode) {
      const index = dragSide === "left" ? 0 : 1;
      calibrationState.manualPoints[index] = dragPoint;
      calibrationState.manualStep = calibrationState.manualPoints.length;
      updateCalibrationDebugPanel();
      updateCalibrationInstructionPanel();
      redrawDrawCanvas();
      updateCalibrationMarkerHandles();
      if (calibrationState.manualPoints.length >= 2) {
        finalizeManualCalibration();
      }
      return;
    }
    const key = dragSide === "left" ? "leftMarkerCenter" : "rightMarkerCenter";
    calibrationState.metadata = {
      ...calibrationState.metadata,
      [key]: dragPoint,
    };
    recomputeCalibrationFromCurrentMarkers("manual-refine");
    return;
  }
  redrawDrawCanvas();
  updateCalibrationMarkerHandles();
}

async function runAlignAndCalibrateMarkers() {
  if (!currentPreviewPath || calibrationState.metadata.isProcessing) return;
  const requestId = ++calibrationState.requestId;
  aiCalibrationRequested = true;
  aiCalibrationCompleted = false;
  aiCalibrationPath = currentPreviewPath;
  disableManualCalibrationMode();
  setControlsVisible(true);
  setCalibrationProcessing(calibrationState, true);
  updateCalibrationDebugPanel();
  setCalibrationButtonProcessing(true);
  try {
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const result = await invoke("detect_glasses_markers", { path: currentPreviewPath });
    if (requestId !== calibrationState.requestId) return;
    const confidence = Number(result?.detection_confidence ?? result?.detectionConfidence ?? 0) || 0;
    const left = normalizePointToPreviewCoordinates(result?.left_marker_center ?? result?.leftMarkerCenter ?? null);
    const right = normalizePointToPreviewCoordinates(result?.right_marker_center ?? result?.rightMarkerCenter ?? null);
    const faceBounds = normalizeRectToPreviewCoordinates(result?.face_bounds ?? result?.faceBounds ?? null);
    const faceDetectionSource = String(result?.face_detection_source ?? result?.faceDetectionSource ?? "").trim() || null;
    if (!left || !right || confidence < 0.55) {
      const errorMessage = localizeCalibrationErrorMessage(result?.error, "preview.auto_detection_uncertain");
      setCalibrationFailure(
        errorMessage,
        {
          detectionConfidence: confidence,
          detectionConfidenceCutoff: 0.55,
          faceBounds,
          faceDetectionSource,
        },
      );
      if (isNoFaceDetectionFailure(errorMessage)) {
        scheduleNoFaceReset();
        return;
      }
      enableManualCalibrationMode(errorMessage);
      return;
    }
    const computed = computeMarkerCalibration(left, right);
    applyCalibrationResult({
      ...computed,
      calibrationStatus: "success",
      detectionConfidence: confidence,
      detectionConfidenceCutoff: 0.55,
      isProcessing: false,
      calibrationSource: "auto",
      faceBounds,
      faceDetectionSource,
    });
    aiCalibrationCompleted = true;
    updateCalibrationBadgePosition();
  } catch (err) {
    console.error("align and calibrate markers failed:", err);
    const errorMessage = localizeCalibrationErrorMessage(err, "preview.calibration_failed");
    setCalibrationFailure(errorMessage);
    if (isNoFaceDetectionFailure(errorMessage)) {
      scheduleNoFaceReset();
    } else {
      enableManualCalibrationMode(t("preview.auto_detection_failed"));
    }
  } finally {
    if (requestId === calibrationState.requestId) {
      setCalibrationProcessing(calibrationState, false);
    }
    setCalibrationButtonProcessing(false);
    updateCalibrationDebugPanel();
    redrawDrawCanvas();
    applyTransform();
  }
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
    pendingRotationStepsByPath.clear();
    optimisticRotationOverrideDegByPath.clear();
    const raw = localStorage.getItem(ROTATION_UI_STATE_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    const pending = parsed?.pendingSteps && typeof parsed.pendingSteps === "object" ? parsed.pendingSteps : {};
    for (const [path, value] of Object.entries(pending)) {
      const key = normalizePath(path);
      const steps = normalizeRotationSteps(value);
      if (!key || steps === 0) continue;
      pendingRotationStepsByPath.set(key, steps);
      optimisticRotationOverrideDegByPath.set(key, normalizeRotationDeg(steps * 90));
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

function setControlsVisible(visible) {
  controlsVisible = Boolean(visible);
  previewRoot?.classList.toggle("controls-visible", controlsVisible);
  previewToolbar?.setAttribute("aria-hidden", controlsVisible ? "false" : "true");
}

function toggleControlsVisible() {
  if (shouldKeepToolbarVisible() && controlsVisible) return;
  setControlsVisible(!controlsVisible);
}

function setMarkModeActive(active) {
  markModeActive = Boolean(active);
  if (markModeActive) {
    measureModeActive = false;
    measureBtn?.classList.remove("active");
    measureBtn?.setAttribute("aria-pressed", "false");
    previewRoot?.classList.remove("measure-mode");
    pendingMeasureStart = null;
    hoverMeasurePoint = null;
    setCalibrationEditing(false);
  }
  markBtn?.classList.toggle("active", markModeActive);
  markBtn?.setAttribute("aria-pressed", markModeActive ? "true" : "false");
  previewRoot?.classList.toggle("draw-mode", markModeActive);
  previewToolbar?.classList.toggle("has-lines", markModeActive && hasDrawnLines);
  if (!markModeActive) {
    isDrawingLine = false;
    lastDrawPoint = null;
    setSaveModeActive(false);
  }
}

function setMeasureModeActive(active) {
  measureModeActive = Boolean(active);
  if (measureModeActive) {
    markModeActive = false;
    markBtn?.classList.remove("active");
    markBtn?.setAttribute("aria-pressed", "false");
    previewRoot?.classList.remove("draw-mode");
    isDrawingLine = false;
    lastDrawPoint = null;
    currentStroke = null;
    setSaveModeActive(false);
  } else {
    pendingMeasureStart = null;
    hoverMeasurePoint = null;
    setCalibrationEditing(false);
  }
  measureBtn?.classList.toggle("active", measureModeActive);
  measureBtn?.setAttribute("aria-pressed", measureModeActive ? "true" : "false");
  previewRoot?.classList.toggle("measure-mode", measureModeActive);
  redrawDrawCanvas();
}

function setSaveModeActive(active) {
  saveModeActive = Boolean(active);
  previewToolbar?.classList.toggle("save-mode", saveModeActive);
  if (drawSaveBtn) {
    drawSaveBtn.textContent = saveModeActive ? t("preview.done") : t("preview.save");
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
  if (!currentPreviewPath) {
    throw new Error("missing preview state");
  }
  return await invoke("export_annotated_image_to_temp", {
    path: currentPreviewPath,
    strokes: lineSegments,
    measurements: measurementSegments.map((segment) => ({
      start: {
        x: Number(segment?.start?.x) || 0,
        y: Number(segment?.start?.y) || 0,
      },
      end: {
        x: Number(segment?.end?.x) || 0,
        y: Number(segment?.end?.y) || 0,
      },
      label_mm: Number(segment?.mm) || 0,
    })),
    previewWidth: Math.max(1, baseImageWidth),
    previewHeight: Math.max(1, baseImageHeight),
    calibrationTransform: calibrationState.metadata.calibrationStatus === "success"
      ? { rotationAngleDeg: Number(calibrationState.metadata.rotationAngleDeg) || 0 }
      : null,
  });
}

function setSelectedDrawColor(color) {
  const next = normalizeHexColor(color, "#ffffff");
  selectedDrawColor = next;
  updateDrawCursor(next);
  const dots = Array.from(drawColorPicker?.querySelectorAll(".draw-color-dot") ?? []);
  for (const dot of dots) {
    const isActive = getDotColorValue(dot) === selectedDrawColor;
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
  if (drawCanvas) {
    drawCanvas.style.width = `${baseImageWidth}px`;
    drawCanvas.style.height = `${baseImageHeight}px`;
  }
  resizeDrawCanvas();
}

function resetTransform() {
  cancelFaceZoomAnimation();
  syncCalibrationRotationDisplay(0);
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
      previewImage.style.visibility = "visible";
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
      previewImage.style.visibility = "hidden";
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
    previewImage.style.visibility = "hidden";
    previewImage.removeAttribute("src");
    previewImage.src = src;
  });
}

async function setPreview(path) {
  const normalized = normalizePath(path);
  if (!normalized) return;
  const startedAt = performance.now();
  previewTrace("setPreview", "start", { path: normalized });
  clearNoFaceResetTimer();
  currentPreviewPath = normalized;
  resetTransform();
  clearDrawCanvas();
  resetCalibrationState(calibrationState);
  aiCalibrationRequested = false;
  aiCalibrationCompleted = false;
  aiCalibrationPath = "";
  disableManualCalibrationMode();
  stopCalibrationHandleDrag();
  updateCalibrationDebugPanel();
  updateCalibrationInstructionPanel();
  setCalibrationButtonProcessing(false);
  updateCalibrationBadgePosition();
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
    previewTrace("setPreview", "original-path failed, fallback to src_path", {
      requestToken,
      path: normalized,
      err: String(err ?? ""),
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
    } catch (srcErr) {
      previewTrace("setPreview", "src_path fallback failed, fallback to data_url", {
        requestToken,
        path: normalized,
        err: String(srcErr ?? ""),
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
      } catch (fallbackErr) {
        previewTrace("setPreview", "data_url fallback failed", {
          requestToken,
          path: normalized,
          err: String(fallbackErr ?? ""),
        });
        console.error("import preview original load failed:", err, srcErr, fallbackErr);
      }
    }
  } finally {
    hideLoading(requestToken);
  }
}

async function requestPreviewLoad(path, paths = null) {
  const normalizedPath = normalizePath(path);
  if (!normalizedPath) return;
  const normalizedPaths = Array.isArray(paths)
    ? paths.map((entry) => normalizePath(entry)).filter(Boolean)
    : null;
  queuedPreviewPath = normalizedPath;
  queuedPreviewNavPaths = normalizedPaths;
  if (previewLoadInFlight) return;
  previewLoadInFlight = true;
  try {
    while (queuedPreviewPath) {
      const nextPath = queuedPreviewPath;
      const nextPaths = queuedPreviewNavPaths;
      queuedPreviewPath = "";
      queuedPreviewNavPaths = null;
      if (Array.isArray(nextPaths)) {
        setNavigationPaths(nextPaths);
        if (nextPath && !navigationPaths.includes(nextPath)) {
          navigationPaths.push(nextPath);
        }
      }
      await setPreview(nextPath);
    }
  } finally {
    previewLoadInFlight = false;
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
  if (markModeActive || measureModeActive) return;
  event.preventDefault();
  const delta = Number(event.deltaY) || 0;
  if (!Number.isFinite(delta) || delta === 0) return;
  const direction = delta < 0 ? 1 : -1;
  const step = event.ctrlKey ? WHEEL_ZOOM_STEP * 0.9 : WHEEL_ZOOM_STEP;
  setScaleAt(currentScale + direction * step, event.clientX, event.clientY);
}, { passive: false });

previewRoot?.addEventListener("pointerdown", (event) => {
  const calibrationHandleHit = findCalibrationHandleHit(event.clientX, event.clientY);
  if (calibrationHandleHit) {
    event.preventDefault();
    startCalibrationHandleDrag(calibrationHandleHit, event.pointerId);
    return;
  }
  if (markModeActive || measureModeActive || calibrationState.manualMode) return;
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
  if (activeCalibrationHandle) {
    const point = getImagePointFromClient(event.clientX, event.clientY);
    if (!point) return;
    activeCalibrationDragPoint = point;
    redrawDrawCanvas();
    updateCalibrationMarkerHandles();
    return;
  }
  if (markModeActive || measureModeActive || calibrationState.manualMode) return;
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
  stopCalibrationHandleDrag(event.pointerId);
  if (event.pointerType === "mouse") {
    stopMousePan(event.pointerId);
  }
  releaseTouchPointer(event.pointerId);
});

previewRoot?.addEventListener("pointercancel", (event) => {
  stopCalibrationHandleDrag(event.pointerId);
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

window.addEventListener("storage", (event) => {
  if (event.key === DEBUG_PREF_KEY) {
    syncDebugVisibilityFromStorage();
  }
});

window.addEventListener("focus", () => {
  syncDebugVisibilityFromStorage();
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

window.addEventListener("pointerdown", (event) => {
  if (drawColorPopover?.hidden !== false) return;
  const target = event.target;
  if (!(target instanceof Node)) {
    setDrawColorPopoverOpen(false, null);
    activeCustomColorDot = null;
    return;
  }
  if (drawColorPopover.contains(target)) return;
  if (activeCustomColorDot?.contains?.(target)) return;
  setDrawColorPopoverOpen(false, null);
  activeCustomColorDot = null;
});

previewRoot?.addEventListener("click", (event) => {
  if (!(event.target instanceof Element)) return;
  if (shouldKeepToolbarVisible()) return;
  if (event.target.closest(".draw-canvas")) return;
  if (event.target.closest(".preview-nav")) return;
  if (event.target.closest(".preview-toolbar")) return;
  if (event.target.closest(".preview-loading")) return;
  toggleControlsVisible();
});

rotateRightBtn?.addEventListener("click", () => {
  if (hasCancelableCalibrationFlow()) {
    cancelCalibrationFlow();
  }
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

alignMarkersBtn?.addEventListener("click", () => {
  if (hasCancelableCalibrationFlow()) {
    cancelCalibrationFlow();
    return;
  }
  if (markModeActive) {
    setMarkModeActive(false);
  }
  if (measureModeActive) {
    setMeasureModeActive(false);
  }
  void runAlignAndCalibrateMarkers();
});

markBtn?.addEventListener("click", () => {
  if (hasCancelableCalibrationFlow()) {
    cancelCalibrationFlow();
  }
  setMarkModeActive(!markModeActive);
});

measureBtn?.addEventListener("click", () => {
  if (hasCancelableCalibrationFlow()) {
    cancelCalibrationFlow();
  }
  setMeasureModeActive(!measureModeActive);
});

drawColorPicker?.addEventListener("click", (event) => {
  const dot = event.target instanceof Element ? event.target.closest(".draw-color-dot") : null;
  if (!dot) return;
  setSelectedDrawColor(getDotColorValue(dot));
});

drawColorPicker?.addEventListener("dblclick", (event) => {
  const dot = event.target instanceof Element ? event.target.closest(".draw-color-dot") : null;
  if (!dot || !drawCustomColorInput) return;
  event.preventDefault();
  activeCustomColorDot = dot;
  drawCustomColorInput.value = getDotColorValue(dot);
  setDrawColorPopoverOpen(true, dot);
  requestAnimationFrame(() => {
    drawCustomColorInput.focus();
    if (typeof drawCustomColorInput.showPicker === "function") {
      drawCustomColorInput.showPicker();
    } else {
      drawCustomColorInput.click();
    }
  });
});

drawCustomColorInput?.addEventListener("input", (event) => {
  const nextColor = normalizeHexColor(event.target?.value, "#ffffff");
  if (!activeCustomColorDot) return;
  applyDotColorStyles(activeCustomColorDot, nextColor);
  saveDrawPalette();
  setSelectedDrawColor(nextColor);
});

drawCustomColorInput?.addEventListener("change", (event) => {
  const nextColor = normalizeHexColor(event.target?.value, "#ffffff");
  if (activeCustomColorDot) {
    applyDotColorStyles(activeCustomColorDot, nextColor);
    saveDrawPalette();
    setSelectedDrawColor(nextColor);
  }
  setDrawColorPopoverOpen(false, null);
  activeCustomColorDot = null;
});

clearDrawBtn?.addEventListener("click", () => {
  if (measureModeActive) {
    clearMeasurementsOnly();
    return;
  }
  if (markModeActive) {
    clearDrawOnly();
    return;
  }
  clearDrawCanvas();
});

measureCalibrationInput?.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    commitCalibrationInput();
    return;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    setCalibrationEditing(false);
    updateCalibrationDisplay();
  }
});

measureCalibrationInput?.addEventListener("blur", () => {
  commitCalibrationInput();
});

measureCalibrationInput?.addEventListener("focus", () => {
  if (!measureModeActive) return;
  beginCalibrationEdit();
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
  if (!hasDrawnLines && !hasMeasurementSegments()) return;
  if (!saveModeActive) {
    setSaveModeActive(true);
    renderSaveDropdown(drawSaveInput?.value ?? "");
    return;
  }
  if (!previewWorkspaceDir || !previewPatientFolder) return;
  const typed = String(drawSaveInput?.value ?? "").trim();
  if (!typed) return;
  const existingMatch = availableTreatmentFolders.find(
    (name) => name.toLowerCase() === typed.toLowerCase()
  ) ?? "";
  const optimisticTargetFolder = existingMatch || `${currentDateYmd()} ${typed}`;
  const committedStrokes = lineSegments.map((stroke) => ({
    color: stroke?.color ?? "white",
    points: Array.isArray(stroke?.points)
      ? stroke.points.map((point) => ({
          x: Number(point?.x) || 0,
          y: Number(point?.y) || 0,
        }))
      : [],
  })).filter((stroke) => stroke.points.length > 0);
  const committedMeasurements = measurementSegments.map((segment) => {
    const labelSprite = renderMeasurementLabelSpriteWithColor(
      getMeasurementLabel(segment),
      getMeasurementLabelTextColor(segment),
    );
    return {
      start: {
        x: Number(segment?.start?.x) || 0,
        y: Number(segment?.start?.y) || 0,
      },
      end: {
        x: Number(segment?.end?.x) || 0,
        y: Number(segment?.end?.y) || 0,
      },
      label_mm: Number(segment?.mm) || 0,
      label_x: Number(segment?.labelX) || 0,
      label_y: Number(segment?.labelY) || 0,
      label_data_url: labelSprite?.dataUrl ?? "",
      label_width: labelSprite?.width ?? 0,
      label_height: labelSprite?.height ?? 0,
    };
  });
  const previewWidth = Math.max(1, baseImageWidth);
  const previewHeight = Math.max(1, baseImageHeight);
  setSaveModeActive(false);
  setMarkModeActive(false);
  setMeasureModeActive(false);
  drawSaveBtn.disabled = true;
  if (drawSaveInput) drawSaveInput.disabled = true;
  if (drawSaveDropdownBtn) drawSaveDropdownBtn.disabled = true;
  void (async () => {
    try {
      const prepared = await invoke("prepare_import_target_folder", {
        workspaceDir: previewWorkspaceDir,
        patientFolder: previewPatientFolder,
        existingFolder: existingMatch || null,
        date: existingMatch ? null : currentDateYmd(),
        treatmentName: existingMatch ? null : typed,
      });
      const preparedTargetFolder = String(prepared?.target_folder ?? prepared?.targetFolder ?? optimisticTargetFolder).trim();
      await invoke("notify_import_wizard_completed", {
        workspaceDir: previewWorkspaceDir,
        patientFolder: previewPatientFolder,
        targetFolder: preparedTargetFolder,
        jobId: null,
        importWizardDir: null,
        importedImageCount: 1,
        importedTotalCount: 1,
        selectTargetFolder: true,
        preferExistingThumbnailsFirst: Boolean(existingMatch),
        plannedPaths: [],
      }).catch(() => {});
      const tempPath = await invoke("export_annotated_image_to_temp", {
        path: currentPreviewPath,
        strokes: committedStrokes,
        measurements: committedMeasurements,
        previewWidth,
        previewHeight,
        calibrationTransform: calibrationState.metadata.calibrationStatus === "success"
          ? { rotationAngleDeg: Number(calibrationState.metadata.rotationAngleDeg) || 0 }
          : null,
      });
      const result = await invoke("start_import_files", {
        workspaceDir: previewWorkspaceDir,
        patientFolder: previewPatientFolder,
        existingFolder: preparedTargetFolder,
        date: null,
        treatmentName: null,
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
        importedImageCount: 1,
        importedTotalCount: 1,
        selectTargetFolder: true,
        preferExistingThumbnailsFirst: Boolean(existingMatch),
      }).catch(() => {});
      clearDrawCanvas();
    } catch (err) {
      console.error("save drawn image import failed:", err);
    } finally {
      if (drawSaveInput) drawSaveInput.disabled = false;
      if (drawSaveDropdownBtn) drawSaveDropdownBtn.disabled = false;
      drawSaveBtn.disabled = false;
    }
  })();
});

drawCanvas?.addEventListener("pointerdown", (event) => {
  if (calibrationState.manualMode) {
    if (event.button !== undefined && event.button !== 0) return;
    const point = getImagePointFromClient(event.clientX, event.clientY);
    if (!point) return;
    const index = calibrationState.manualStep < 1 ? 0 : 1;
    calibrationState.manualPoints[index] = point;
    calibrationState.manualStep = Math.min(2, calibrationState.manualPoints.length);
    activeCalibrationHandle = index === 0 ? "left" : "right";
    activeCalibrationDragPoint = point;
    const handle = activeCalibrationHandle === "left" ? calibrationMarkerLeft : calibrationMarkerRight;
    handle?.classList.add("dragging");
    drawCanvas?.setPointerCapture?.(event.pointerId);
    updateCalibrationDebugPanel();
    updateCalibrationInstructionPanel();
    redrawDrawCanvas();
    updateCalibrationMarkerHandles();
    return;
  }
  if (!markModeActive && !measureModeActive) return;
  if (measureModeActive && event.button === 2) {
    event.preventDefault();
    if (pendingMeasureStart) {
      pendingMeasureStart = null;
      hoverMeasurePoint = null;
      redrawDrawCanvas();
    }
    return;
  }
  if (event.button !== undefined && event.button !== 0) return;
  event.preventDefault();
  resizeDrawCanvas();
  if (measureModeActive) {
    const labelHit = findMeasurementLabelHit(event.clientX, event.clientY);
    if (labelHit) {
      activeMeasurementLabelDrag = {
        index: labelHit.index,
        offsetX: labelHit.offsetX,
        offsetY: labelHit.offsetY,
      };
      setMeasurementLabelHover(false);
      setMeasurementLabelDragging(true);
      drawCanvas.setPointerCapture?.(event.pointerId);
      return;
    }
    const point = getImagePointFromClient(event.clientX, event.clientY);
    if (!point) return;
    if (!pendingMeasureStart) {
      pendingMeasureStart = point;
      hoverMeasurePoint = point;
      redrawDrawCanvas();
      return;
    }
    const end = point;
    const dx = end.x - pendingMeasureStart.x;
    const dy = end.y - pendingMeasureStart.y;
    const pixels = Math.hypot(dx, dy);
    if (pixels < 1) {
      pendingMeasureStart = null;
      hoverMeasurePoint = null;
      redrawDrawCanvas();
      return;
    }
    measurementSegments.push({
      start: pendingMeasureStart,
      end,
      mm: Number.isFinite(calibrationMmPerPx) && calibrationMmPerPx > 0 ? pixels * calibrationMmPerPx : null,
      labelX: (pendingMeasureStart.x + end.x) / 2,
      labelY: ((pendingMeasureStart.y + end.y) / 2) - 18,
      isCalibrationReference: false,
    });
    if (!(Number.isFinite(calibrationMmPerPx) && calibrationMmPerPx > 0)) {
      calibrationReferencePixels = pixels;
      calibrationReferenceSegmentIndex = measurementSegments.length - 1;
    }
    syncCalibrationReferenceSegment();
    pendingMeasureStart = null;
    hoverMeasurePoint = null;
    updateMeasurementToolbarState();
    redrawDrawCanvas();
    if (!(Number.isFinite(calibrationMmPerPx) && calibrationMmPerPx > 0)) {
      updateCalibrationDisplay();
      beginCalibrationEdit();
    } else {
      updateCalibrationDisplay();
    }
    return;
  }
  const start = getImagePointFromClient(event.clientX, event.clientY);
  if (!start) return;
  isDrawingLine = true;
  lastDrawPoint = start;
  currentStroke = {
    color: selectedDrawColor,
    points: [start],
  };
  lineSegments.push(currentStroke);
  if (!hasDrawnLines) {
    hasDrawnLines = true;
    previewToolbar?.classList.add("has-lines");
  }
  redrawDrawCanvas();
  drawCanvas.setPointerCapture?.(event.pointerId);
});

drawCanvas?.addEventListener("pointermove", (event) => {
  if (calibrationState.manualMode) {
    if (activeCalibrationHandle) {
      const point = getImagePointFromClient(event.clientX, event.clientY);
      if (!point) return;
      activeCalibrationDragPoint = point;
      redrawDrawCanvas();
      updateCalibrationMarkerHandles();
    }
    return;
  }
  if (measureModeActive) {
    if (activeMeasurementLabelDrag) {
      const segment = measurementSegments[activeMeasurementLabelDrag.index];
      const point = getImagePointFromClient(event.clientX, event.clientY);
      if (!segment || !point) return;
      segment.labelX = point.x - activeMeasurementLabelDrag.offsetX;
      segment.labelY = point.y - activeMeasurementLabelDrag.offsetY;
      redrawDrawCanvas();
      return;
    }
    setMeasurementLabelHover(Boolean(findMeasurementLabelHit(event.clientX, event.clientY)));
    if (!pendingMeasureStart) return;
    const point = getImagePointFromClient(event.clientX, event.clientY);
    if (!point) return;
    hoverMeasurePoint = point;
    redrawDrawCanvas();
    return;
  }
  if (!markModeActive || !isDrawingLine) return;
  event.preventDefault();
  continueDrawingTo(event.clientX, event.clientY);
});

function stopDrawing(pointerId = null) {
  if (!isDrawingLine) return;
  isDrawingLine = false;
  lastDrawPoint = null;
  currentStroke = null;
  if (pointerId !== null) {
    drawCanvas?.releasePointerCapture?.(pointerId);
  }
}

drawCanvas?.addEventListener("pointerup", (event) => {
  if (calibrationState.manualMode && activeCalibrationHandle) {
    drawCanvas?.releasePointerCapture?.(event.pointerId);
  }
  if (activeMeasurementLabelDrag) {
    activeMeasurementLabelDrag = null;
    setMeasurementLabelDragging(false);
    setMeasurementLabelHover(Boolean(findMeasurementLabelHit(event.clientX, event.clientY)));
    drawCanvas?.releasePointerCapture?.(event.pointerId);
    return;
  }
  stopDrawing(event.pointerId);
});

drawCanvas?.addEventListener("pointercancel", (event) => {
  if (calibrationState.manualMode && activeCalibrationHandle) {
    drawCanvas?.releasePointerCapture?.(event.pointerId);
  }
  activeMeasurementLabelDrag = null;
  setMeasurementLabelDragging(false);
  setMeasurementLabelHover(false);
  stopDrawing(event.pointerId);
});

drawCanvas?.addEventListener("contextmenu", (event) => {
  if (!measureModeActive) return;
  event.preventDefault();
});

drawCanvas?.addEventListener("pointerleave", () => {
  if (activeMeasurementLabelDrag) return;
  setMeasurementLabelHover(false);
});

void listen(previewEventName, (event) => {
  loadRotationUiState();
  const path = normalizePath(event?.payload?.path);
  const paths = Array.isArray(event?.payload?.paths) ? event.payload.paths : [];
  const workspaceDir = normalizePath(event?.payload?.workspaceDir ?? "");
  const patientFolder = normalizePath(event?.payload?.patientFolder ?? "");
  previewTrace("event", "preview event received", {
    path,
    navCount: paths.length,
  });
  previewWorkspaceDir = workspaceDir;
  previewPatientFolder = patientFolder;
  availableTreatmentFolders = [];
  folderRefreshRequestId += 1;
  if (drawSaveDropdownBtn) drawSaveDropdownBtn.hidden = true;
  setSaveDropdownOpen(false);
  if (drawSaveSuggestionsList) drawSaveSuggestionsList.innerHTML = "";
  updateCalibrationDisplay();
  updateCalibrationDebugPanel();
  if (!path) {
    setNavigationPaths(paths);
    updateNavigationButtons();
    return;
  }
  void requestPreviewLoad(path, paths);
  void refreshAvailableTreatmentFolders();
});

void (async () => {
  try {
    await initLanguageFromSettings();
    applyTranslations(document);
    document.title = previewMode === "image" ? t("image_preview_title") : t("import_live_preview_title");
    previewImage?.setAttribute("alt", t("preview.live_preview_alt"));
    onLanguageChanged(() => {
      applyTranslations(document);
      document.title = previewMode === "image" ? t("image_preview_title") : t("import_live_preview_title");
      previewImage?.setAttribute("alt", t("preview.live_preview_alt"));
      if (drawSaveBtn) {
        drawSaveBtn.textContent = saveModeActive ? t("preview.done") : t("preview.save");
      }
      updateCalibrationDisplay();
    });
    loadRotationUiState();
    resizeDrawCanvas();
    applyInitialDrawPalette();
    setSelectedDrawColor(drawColorToCss("white"));
    syncDebugVisibilityFromStorage();
    updateCalibrationDisplay();
    updateCalibrationDebugPanel();
    updateCalibrationInstructionPanel();
    setCalibrationEditing(false);
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
      await requestPreviewLoad(normalized, navigationPaths);
    } else {
      updateNavigationButtons();
    }
  } catch (err) {
    console.error("get current preview path failed:", err);
  }
})();
