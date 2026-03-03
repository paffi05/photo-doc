import { listen } from "@tauri-apps/api/event";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";

const params = new URLSearchParams(window.location.search);
const previewMode = params.get("mode") === "image" ? "image" : "wizard";
const previewEventName = previewMode === "image" ? "image-preview-file" : "import-wizard-preview-file";
const getCurrentPathCommand =
  previewMode === "image" ? "get_current_image_preview_path" : "get_current_import_wizard_preview_path";
const getCurrentPathsCommand =
  previewMode === "image" ? "get_current_image_preview_paths" : "get_current_import_wizard_preview_paths";

const previewImage = document.getElementById("previewImage");
const previewRoot = document.querySelector(".preview-root");
const previewLoading = document.getElementById("previewLoading");
const navPrevBtn = document.getElementById("navPrevBtn");
const navNextBtn = document.getElementById("navNextBtn");
let previewRequestToken = 0;
let currentPreviewPath = "";
let navigationPaths = [];
let lastAppliedEventSignature = "";
let currentScale = 1;
let translateX = 0;
let translateY = 0;
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

function buildEventSignature(path, paths = []) {
  const safePath = normalizePath(path);
  const safePaths = Array.isArray(paths)
    ? paths.map((entry) => normalizePath(entry)).filter((entry) => entry.length > 0)
    : [];
  return `${safePath}::${safePaths.join("|")}`;
}

function clampScale(scale) {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, Number(scale) || MIN_SCALE));
}

function getPanLimits(scale = currentScale) {
  const { width: rootWidth, height: rootHeight } = getRootSize();
  if (rootWidth <= 0 || rootHeight <= 0 || baseImageWidth <= 0 || baseImageHeight <= 0) {
    return { maxX: 0, maxY: 0 };
  }
  const scaledWidth = baseImageWidth * scale;
  const scaledHeight = baseImageHeight * scale;
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
  previewImage.style.transform = `translate(${translateX}px, ${translateY}px) scale(${currentScale})`;
  updatePanCursorState();
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
  if (naturalWidth <= 0 || naturalHeight <= 0 || rootWidth <= 0 || rootHeight <= 0) {
    baseImageWidth = Math.max(1, rootWidth);
    baseImageHeight = Math.max(1, rootHeight);
    previewImage.style.width = `${Math.round(baseImageWidth)}px`;
    previewImage.style.height = `${Math.round(baseImageHeight)}px`;
    return;
  }
  const containRatio = Math.min(rootWidth / naturalWidth, rootHeight / naturalHeight);
  baseImageWidth = Math.max(1, naturalWidth * containRatio);
  baseImageHeight = Math.max(1, naturalHeight * containRatio);
  previewImage.style.width = `${Math.round(baseImageWidth)}px`;
  previewImage.style.height = `${Math.round(baseImageHeight)}px`;
}

function resetTransform() {
  currentScale = MIN_SCALE;
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
  previewLoading?.classList.add("visible");
}

function hideLoading(requestToken) {
  if (requestToken !== previewRequestToken) return;
  previewLoading?.classList.remove("visible");
}

function loadImageWithVerification(src, requestToken) {
  return new Promise((resolve, reject) => {
    let done = false;
    const cleanup = () => {
      previewImage.onload = null;
      previewImage.onerror = null;
    };

    previewImage.onload = () => {
      if (done) return;
      done = true;
      cleanup();
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
      reject(new Error("preview image failed to load"));
    };

    previewImage.src = src;
  });
}

async function setPreview(path) {
  const normalized = normalizePath(path);
  if (!normalized) return;
  currentPreviewPath = normalized;
  resetTransform();
  updateNavigationButtons();
  const requestToken = ++previewRequestToken;
  showLoading(requestToken);
  await new Promise((resolve) => requestAnimationFrame(resolve));
  try {
    const resolvedPath = await invoke("get_import_wizard_preview_src_path", { path: normalized });
    if (requestToken !== previewRequestToken) return;
    const safePath = String(resolvedPath ?? "").trim() || normalized;
    const src = `${convertFileSrc(safePath)}?t=${Date.now()}`;
    previewImage.decoding = "async";
    await loadImageWithVerification(src, requestToken);
    updateBaseImageSize();
    applyTransform();
  } catch (err) {
    if (requestToken !== previewRequestToken) return;
    try {
      const dataUrl = await invoke("get_import_wizard_preview_data_url", { path: normalized });
      if (requestToken !== previewRequestToken) return;
      const src = String(dataUrl ?? "").trim();
      if (!src) return;
      await loadImageWithVerification(src, requestToken);
      updateBaseImageSize();
      applyTransform();
    } catch (fallbackErr) {
      console.error("import preview original load failed:", err, fallbackErr);
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
  event.preventDefault();
  const delta = Number(event.deltaY) || 0;
  if (!Number.isFinite(delta) || delta === 0) return;
  const direction = delta < 0 ? 1 : -1;
  const step = event.ctrlKey ? WHEEL_ZOOM_STEP * 0.9 : WHEEL_ZOOM_STEP;
  setScaleAt(currentScale + direction * step, event.clientX, event.clientY);
}, { passive: false });

previewRoot?.addEventListener("pointerdown", (event) => {
  if (event.target instanceof Element && event.target.closest(".preview-nav")) return;

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
  updateBaseImageSize();
  const clamped = clampTranslation(translateX, translateY);
  translateX = clamped.x;
  translateY = clamped.y;
  applyTransform();
});

void listen(previewEventName, (event) => {
  const path = normalizePath(event?.payload?.path);
  const paths = Array.isArray(event?.payload?.paths) ? event.payload.paths : [];
  const signature = buildEventSignature(path, paths);
  if (signature && signature === lastAppliedEventSignature) {
    return;
  }
  lastAppliedEventSignature = signature;
  setNavigationPaths(paths);
  if (path && !navigationPaths.includes(path)) {
    navigationPaths.unshift(path);
  }
  void setPreview(path);
});

void (async () => {
  try {
    const navPaths = await invoke(getCurrentPathsCommand);
    setNavigationPaths(navPaths);
    const path = await invoke(getCurrentPathCommand);
    const normalized = normalizePath(path);
    if (normalized) {
      if (!navigationPaths.includes(normalized)) {
        navigationPaths.unshift(normalized);
      }
      lastAppliedEventSignature = buildEventSignature(normalized, navigationPaths);
      await setPreview(normalized);
    } else {
      updateNavigationButtons();
    }
  } catch (err) {
    console.error("get current preview path failed:", err);
  }
})();
