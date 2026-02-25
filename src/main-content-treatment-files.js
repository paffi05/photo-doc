import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

const VISIBLE_FIRST_IMAGE_COUNT = 10;
const VISIBLE_FIRST_PREVIEW_CONCURRENCY = 6;
const INITIAL_IMAGE_PREVIEWS = 30;
const PREVIEW_CONCURRENCY = 4;
const FILL_RUNNING_PREVIEW_CONCURRENCY = 2;
const FILL_RUNNING_QUICK_BATCH_SIZE = 6;
const FALLBACK_RECOVERY_BATCH_SIZE = 20;
const THUMB_RECOVERY_RETRY_DELAYS_MS = [350, 900, 1800];

function normalizePath(pathLike = "") {
  if (typeof pathLike === "string") return pathLike;
  if (pathLike === null || pathLike === undefined) return "";
  return String(pathLike);
}

function formatBytes(bytes = 0) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / (1024 ** 2)).toFixed(1)} MB`;
  return `${(n / (1024 ** 3)).toFixed(1)} GB`;
}

function extractExt(name = "") {
  const idx = String(name).lastIndexOf(".");
  if (idx === -1) return "";
  return String(name).slice(idx + 1).toUpperCase();
}

export function createTreatmentFilesPanel({ container, onOpenPath }) {
  const panel = document.createElement("section");
  panel.className = "treatment-files-panel";
  panel.hidden = true;
  panel.innerHTML = `
    <div class="treatment-files-header">
      <div class="treatment-files-title">Treatment Files</div>
      <div class="treatment-files-folder"></div>
      <div class="treatment-files-counts"></div>
    </div>
    <div class="treatment-files-loading" hidden>Loading files...</div>
    <div class="treatment-files-empty" hidden>No files in this treatment folder.</div>
    <div class="treatment-files-images-wrap" hidden>
      <div class="treatment-files-section-title">Images</div>
      <div class="treatment-files-images-grid"></div>
    </div>
    <div class="treatment-files-other-wrap" hidden>
      <div class="treatment-files-section-title">Other Files</div>
      <div class="treatment-files-other-list"></div>
    </div>
  `;
  container.appendChild(panel);

  const folderEl = panel.querySelector(".treatment-files-folder");
  const countsEl = panel.querySelector(".treatment-files-counts");
  const loadingEl = panel.querySelector(".treatment-files-loading");
  const emptyEl = panel.querySelector(".treatment-files-empty");
  const imagesWrapEl = panel.querySelector(".treatment-files-images-wrap");
  const imagesGridEl = panel.querySelector(".treatment-files-images-grid");
  const otherWrapEl = panel.querySelector(".treatment-files-other-wrap");
  const otherListEl = panel.querySelector(".treatment-files-other-list");

  let activeContextKey = "";
  let activeContext = { workspaceDir: "", patientFolder: "", treatmentFolder: "" };
  let activeRequestId = 0;
  let isBackgroundFillRunning = false;
  const runtimePreviewByPath = new Map();
  const cacheWarmupRequested = new Set();
  let activeCardsByPath = new Map();
  let activeImageFiles = [];

  void listen("preview-fill-status", (event) => {
    const wasRunning = isBackgroundFillRunning;
    isBackgroundFillRunning = Boolean(event?.payload?.running);
    if (wasRunning && !isBackgroundFillRunning && activeCardsByPath.size > 0 && activeImageFiles.length > 0) {
      const requestId = activeRequestId;
      setTimeout(() => {
        if (requestId !== activeRequestId) return;
        void recoverFallbackThumbs(activeCardsByPath, activeImageFiles, requestId);
      }, 180);
    }
  });
  void listen("import-preview-ready", (event) => {
    const path = normalizePath(event?.payload?.path ?? "");
    const previewPath = normalizePath(event?.payload?.preview_path ?? event?.payload?.previewPath ?? "");
    if (!path || !previewPath) return;
    if (!activeCardsByPath.has(path)) return;
    let src = "";
    try {
      src = convertFileSrc(previewPath);
    } catch {
      src = "";
    }
    if (!src) return;
    setThumbImage(path, activeCardsByPath, src, {
      requestId: activeRequestId,
      allowPathFallback: true,
      previewQuality: "full",
    });
  });
  void (async () => {
    try {
      isBackgroundFillRunning = Boolean(await invoke("get_preview_fill_status"));
    } catch {
      isBackgroundFillRunning = false;
    }
  })();

  function clearPanel() {
    activeContextKey = "";
    activeContext = { workspaceDir: "", patientFolder: "", treatmentFolder: "" };
    activeRequestId += 1;
    cacheWarmupRequested.clear();
    activeCardsByPath = new Map();
    activeImageFiles = [];
    panel.hidden = true;
    folderEl.textContent = "";
    countsEl.textContent = "";
    loadingEl.hidden = true;
    emptyEl.hidden = true;
    imagesWrapEl.hidden = true;
    otherWrapEl.hidden = true;
    imagesGridEl.innerHTML = "";
    otherListEl.innerHTML = "";
  }

  function setLoadingState(folderName = "") {
    panel.hidden = false;
    folderEl.textContent = folderName;
    countsEl.textContent = "";
    loadingEl.hidden = false;
    emptyEl.hidden = true;
    imagesWrapEl.hidden = true;
    otherWrapEl.hidden = true;
    imagesGridEl.innerHTML = "";
    otherListEl.innerHTML = "";
  }

  function renderOtherFiles(otherFiles = []) {
    otherListEl.innerHTML = "";
    for (const file of otherFiles) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "treatment-other-file-row";
      row.title = file.path;
      row.innerHTML = `
        <span class="treatment-other-file-ext">${extractExt(file.name) || "FILE"}</span>
        <span class="treatment-other-file-name">${file.name}</span>
        <span class="treatment-other-file-size">${formatBytes(file.size)}</span>
      `;
      row.addEventListener("click", () => {
        if (typeof onOpenPath === "function") {
          void onOpenPath(file.path);
        }
      });
      otherListEl.appendChild(row);
    }
  }

  function createImageCard(file) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "treatment-image-card";
    card.title = file.path;
    card.innerHTML = `
      <span class="treatment-image-thumb fallback">IMG</span>
      <span class="treatment-image-name">${file.name}</span>
    `;
    card.addEventListener("click", () => {
      if (typeof onOpenPath === "function") {
        void onOpenPath(file.path);
      }
    });
    return card;
  }

  function setFallbackThumb(path, cardsByPath) {
    const card = cardsByPath.get(path);
    const thumb = card?.querySelector(".treatment-image-thumb");
    if (!thumb) return;
    runtimePreviewByPath.delete(path);
    thumb.classList.remove("loading");
    thumb.classList.add("fallback");
    thumb.textContent = "IMG";
  }

  function recoverSingleThumbWithRetry(path, cardsByPath, requestId, attempt = 0) {
    void (async () => {
      if (requestId !== activeRequestId) return;
      try {
        const rows = await invoke("get_cached_image_previews", {
          paths: [path],
          includeDataUrl: true,
          generateIfMissing: true,
        });
        if (requestId !== activeRequestId) return;
        const row = Array.isArray(rows) ? rows[0] : null;
        const dataUrl = String(row?.data_url ?? row?.dataUrl ?? "").trim();
        if (dataUrl) {
          setThumbImage(path, cardsByPath, dataUrl, {
            requestId,
            allowPathFallback: false,
            previewQuality: "full",
          });
          return;
        }
      } catch {
        if (requestId !== activeRequestId) return;
      }

      if (attempt < THUMB_RECOVERY_RETRY_DELAYS_MS.length) {
        const delay = THUMB_RECOVERY_RETRY_DELAYS_MS[attempt];
        setTimeout(() => {
          recoverSingleThumbWithRetry(path, cardsByPath, requestId, attempt + 1);
        }, delay);
        return;
      }
      setFallbackThumb(path, cardsByPath);
    })();
  }

  function setThumbImage(path, cardsByPath, src, { requestId = 0, allowPathFallback = false, previewQuality = "full" } = {}) {
    if (!src) return;
    const card = cardsByPath.get(path);
    const thumb = card?.querySelector(".treatment-image-thumb");
    if (!thumb) return;

    const quality = previewQuality === "quick" ? "quick" : "full";
    runtimePreviewByPath.set(path, { src, quality });

    thumb.classList.remove("loading");
    thumb.classList.remove("fallback");
    const img = document.createElement("img");
    img.className = quality === "quick" ? "quick-preview" : "full-preview";
    img.alt = "";
    img.loading = "lazy";
    img.decoding = "async";

    if (allowPathFallback) {
      img.addEventListener("error", () => {
        if (requestId !== activeRequestId) return;
        recoverSingleThumbWithRetry(path, cardsByPath, requestId, 0);
      }, { once: true });
    }

    img.src = src;
    thumb.innerHTML = "";
    thumb.appendChild(img);
  }

  function applyRuntimePreviewIfAvailable(path, cardsByPath) {
    const hit = runtimePreviewByPath.get(path);
    if (!hit?.src) return false;
    setThumbImage(path, cardsByPath, hit.src, {
      requestId: activeRequestId,
      allowPathFallback: false,
      previewQuality: hit.quality,
    });
    return true;
  }

  async function loadExistingCachedPreviewSrcMap(paths = []) {
    const normalized = Array.isArray(paths)
      ? paths.map((p) => normalizePath(p)).filter((p) => p.length > 0)
      : [];
    if (normalized.length < 1) return new Map();
    const rows = await invoke("get_existing_cached_preview_paths", { paths: normalized });
    const out = new Map();
    for (const row of Array.isArray(rows) ? rows : []) {
      const path = normalizePath(row?.path ?? "");
      const previewPath = normalizePath(row?.preview_path ?? row?.previewPath ?? "");
      if (!path || !previewPath) continue;
      try {
        out.set(path, convertFileSrc(previewPath));
      } catch {
        // ignore conversion failures
      }
    }
    return out;
  }

  async function loadCachedPreviewSrc(path) {
    const rows = await invoke("get_cached_image_previews", {
      paths: [path],
      includeDataUrl: false,
      generateIfMissing: false,
    });
    const row = Array.isArray(rows) ? rows[0] : null;
    const previewPath = normalizePath(row?.preview_path ?? row?.previewPath ?? "");
    if (!previewPath) return "";
    try {
      return convertFileSrc(previewPath);
    } catch {
      return "";
    }
  }

  async function loadQuickPreviewSrc(path) {
    const rows = await invoke("get_quick_image_previews", { paths: [path] });
    const row = Array.isArray(rows) ? rows[0] : null;
    return normalizePath(row?.data_url ?? row?.dataUrl ?? "");
  }

  async function loadQuickPreviewSrcMap(paths = []) {
    const normalized = Array.isArray(paths)
      ? paths.map((p) => normalizePath(p)).filter((p) => p.length > 0)
      : [];
    if (normalized.length < 1) return new Map();
    const rows = await invoke("get_quick_image_previews", { paths: normalized });
    const out = new Map();
    for (const row of Array.isArray(rows) ? rows : []) {
      const path = normalizePath(row?.path ?? "");
      const dataUrl = normalizePath(row?.data_url ?? row?.dataUrl ?? "");
      if (!path || !dataUrl) continue;
      out.set(path, dataUrl);
    }
    return out;
  }

  function listFallbackPaths(cardsByPath, files = []) {
    const out = [];
    for (const file of files) {
      const path = normalizePath(file?.path ?? "");
      if (!path) continue;
      const card = cardsByPath.get(path);
      const thumb = card?.querySelector(".treatment-image-thumb");
      if (!thumb) continue;
      const hasImg = Boolean(thumb.querySelector("img"));
      const isFallback = thumb.classList.contains("fallback");
      if (!hasImg || isFallback) out.push(path);
    }
    return out;
  }

  async function recoverFallbackThumbs(cardsByPath, files, requestId) {
    const fallbackPaths = listFallbackPaths(cardsByPath, files);
    if (fallbackPaths.length < 1) return;

    for (let i = 0; i < fallbackPaths.length; i += FALLBACK_RECOVERY_BATCH_SIZE) {
      if (requestId !== activeRequestId) return;
      const batch = fallbackPaths.slice(i, i + FALLBACK_RECOVERY_BATCH_SIZE);
      let rows = [];
      try {
        rows = await invoke("get_cached_image_previews", {
          paths: batch,
          includeDataUrl: true,
          generateIfMissing: true,
        });
      } catch {
        rows = [];
      }
      if (requestId !== activeRequestId) return;
      const map = new Map();
      for (const row of Array.isArray(rows) ? rows : []) {
        const path = normalizePath(row?.path ?? "");
        const dataUrl = normalizePath(row?.data_url ?? row?.dataUrl ?? "");
        if (path && dataUrl) map.set(path, dataUrl);
      }
      for (const path of batch) {
        const src = map.get(path) ?? "";
        if (src) {
          setThumbImage(path, cardsByPath, src, {
            requestId,
            allowPathFallback: false,
            previewQuality: "full",
          });
        } else {
          recoverSingleThumbWithRetry(path, cardsByPath, requestId, 0);
        }
      }
    }
  }

  function warmCachePreviewInBackground(path) {
    if (!path || cacheWarmupRequested.has(path)) return;
    cacheWarmupRequested.add(path);
    void invoke("get_cached_image_previews", {
      paths: [path],
      includeDataUrl: false,
      generateIfMissing: true,
    }).catch(() => {});
  }

  async function fillImagePreviewsProgressively(
    cardsByPath,
    imageFiles,
    requestId,
    {
      concurrency = PREVIEW_CONCURRENCY,
      existingCacheByPath = null,
    } = {}
  ) {
    const queue = [...(Array.isArray(imageFiles) ? imageFiles : [])];

    const adjustedConcurrency = isBackgroundFillRunning
      ? Math.min(Math.max(1, FILL_RUNNING_PREVIEW_CONCURRENCY), Math.max(1, concurrency))
      : Math.max(1, concurrency);
    const workerCount = Math.min(adjustedConcurrency, queue.length);

    const workers = Array.from({ length: workerCount }, async () => {
      while (queue.length > 0) {
        if (requestId !== activeRequestId) return;
        const file = queue.shift();
        const path = normalizePath(file?.path ?? "");
        if (!path) continue;

        const existingSrc = existingCacheByPath?.get(path) ?? "";
        if (existingSrc) {
          setThumbImage(path, cardsByPath, existingSrc, {
            requestId,
            allowPathFallback: true,
            previewQuality: "full",
          });
          continue;
        }

        let cachedSrc = "";
        try {
          cachedSrc = await loadCachedPreviewSrc(path);
        } catch {
          cachedSrc = "";
        }
        if (requestId !== activeRequestId) return;

        if (cachedSrc) {
          setThumbImage(path, cardsByPath, cachedSrc, {
            requestId,
            allowPathFallback: true,
            previewQuality: "full",
          });
          continue;
        }

        setFallbackThumb(path, cardsByPath);
        warmCachePreviewInBackground(path);
      }
    });

    await Promise.all(workers);
    await recoverFallbackThumbs(cardsByPath, imageFiles, requestId);
  }

  async function setContext({ workspaceDir = "", patientFolder = "", treatmentFolder = "" } = {}) {
    const w = String(workspaceDir ?? "").trim();
    const p = String(patientFolder ?? "").trim();
    const t = String(treatmentFolder ?? "").trim();

    if (!w || !p || !t) {
      clearPanel();
      return;
    }

    const contextKey = `${w}::${p}::${t}`;
    activeContext = { workspaceDir: w, patientFolder: p, treatmentFolder: t };
    activeContextKey = contextKey;
    const requestId = ++activeRequestId;
    setLoadingState(t);

    let files = [];
    try {
      const rows = await invoke("list_treatment_files", {
        workspaceDir: w,
        patientFolder: p,
        treatmentFolder: t,
      });
      if (requestId !== activeRequestId || contextKey !== activeContextKey) return;
      files = Array.isArray(rows) ? rows : [];
    } catch {
      if (requestId !== activeRequestId) return;
      loadingEl.hidden = true;
      emptyEl.hidden = false;
      emptyEl.textContent = "Could not load files.";
      return;
    }

    const imageFiles = files.filter((f) => Boolean(f?.is_image ?? f?.isImage));
    const otherFiles = files.filter((f) => !Boolean(f?.is_image ?? f?.isImage));

    loadingEl.hidden = true;
    emptyEl.hidden = files.length > 0;
    imagesWrapEl.hidden = imageFiles.length < 1;
    otherWrapEl.hidden = otherFiles.length < 1;
    countsEl.textContent = `${imageFiles.length} images, ${otherFiles.length} other files`;

    imagesGridEl.innerHTML = "";
    otherListEl.innerHTML = "";

    if (files.length < 1) return;

    renderOtherFiles(otherFiles);

    const cardsByPath = new Map();
    for (const file of imageFiles) {
      const card = createImageCard(file);
      cardsByPath.set(file.path, card);
      imagesGridEl.appendChild(card);
    }
    activeCardsByPath = cardsByPath;
    activeImageFiles = imageFiles;

    const needsLoad = [];
    for (const file of imageFiles) {
      const path = normalizePath(file?.path ?? "");
      if (!path) continue;
      if (!applyRuntimePreviewIfAvailable(path, cardsByPath)) {
        needsLoad.push(file);
      }
    }

    const visibleFirst = needsLoad.slice(0, VISIBLE_FIRST_IMAGE_COUNT);
    const initial = needsLoad.slice(VISIBLE_FIRST_IMAGE_COUNT, INITIAL_IMAGE_PREVIEWS);
    const rest = needsLoad.slice(INITIAL_IMAGE_PREVIEWS);

    const allNeededPaths = needsLoad.map((f) => normalizePath(f?.path ?? "")).filter((p) => p.length > 0);
    let existingCacheByPath = new Map();
    try {
      existingCacheByPath = await loadExistingCachedPreviewSrcMap(allNeededPaths);
    } catch {
      existingCacheByPath = new Map();
    }
    if (requestId !== activeRequestId) return;

    for (const [path, src] of existingCacheByPath.entries()) {
      setThumbImage(path, cardsByPath, src, {
        requestId,
        allowPathFallback: true,
        previewQuality: "full",
      });
    }

    const firstPhase = [...visibleFirst, ...initial].filter((f) => {
      const path = normalizePath(f?.path ?? "");
      return path && !existingCacheByPath.has(path);
    });

    void fillImagePreviewsProgressively(
      cardsByPath,
      firstPhase,
      requestId,
      {
        concurrency: isBackgroundFillRunning ? FILL_RUNNING_PREVIEW_CONCURRENCY : VISIBLE_FIRST_PREVIEW_CONCURRENCY,
        existingCacheByPath,
      }
    );

    if (rest.length > 0) {
      const restMissing = rest.filter((f) => {
        const path = normalizePath(f?.path ?? "");
        return path && !existingCacheByPath.has(path);
      });
      if (restMissing.length > 0) {
        setTimeout(() => {
          void fillImagePreviewsProgressively(cardsByPath, restMissing, requestId, {
            concurrency: isBackgroundFillRunning ? FILL_RUNNING_PREVIEW_CONCURRENCY : PREVIEW_CONCURRENCY,
            existingCacheByPath,
          });
        }, 0);
      }
    }
  }

  return {
    clear: clearPanel,
    setContext,
    invalidateRuntimePreviewCache: () => {
      runtimePreviewByPath.clear();
    },
    refreshActiveContext: async () => {
      if (!activeContext?.workspaceDir || !activeContext?.patientFolder || !activeContext?.treatmentFolder) return;
      await setContext(activeContext);
    },
  };
}
