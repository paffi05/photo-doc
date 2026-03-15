import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { onLanguageChanged, t } from "./i18n";

const VISIBLE_FIRST_IMAGE_COUNT = 10;
const VISIBLE_FIRST_PREVIEW_CONCURRENCY = 6;
const INITIAL_IMAGE_PREVIEWS = 30;
const PREVIEW_CONCURRENCY = 4;
const FILL_RUNNING_PREVIEW_CONCURRENCY = 2;
const FILL_RUNNING_QUICK_BATCH_SIZE = 6;
const FALLBACK_RECOVERY_BATCH_SIZE = 20;
const THUMB_RECOVERY_RETRY_DELAYS_MS = [350, 900, 1800];
const FILE_LIST_PAGE_SIZE = 220;
const ACTIVE_PREVIEW_BATCH_SIZE = 2;

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

function fileExtBadgeLabel(name = "", maxLen = 4) {
  const ext = extractExt(name) || "FILE";
  return ext.length > maxLen ? "?" : ext;
}

function formatDateOnly(timestampMs = 0) {
  const ms = Number(timestampMs) || 0;
  if (ms <= 0) return "";
  const d = new Date(ms);
  if (!Number.isFinite(d.getTime())) return "";
  return d.toLocaleDateString();
}

function parseTreatmentFolderHeader(folderName = "") {
  const raw = String(folderName ?? "").trim();
  if (!raw) return { title: "", date: "" };
  const match = /^(\d{4}-\d{2}-\d{2})\s+(.+)$/.exec(raw);
  if (!match) return { title: raw, date: "" };
  const date = String(match[1] ?? "").trim();
  const title = String(match[2] ?? "").trim();
  return { title: title || raw, date };
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

function normalizeKeywords(value) {
  const out = [];
  const seen = new Set();
  const list = Array.isArray(value) ? value : [];
  for (const entry of list) {
    const keyword = String(entry ?? "").trim();
    if (!keyword) continue;
    const key = keyword.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(keyword);
  }
  return out;
}

export function createTreatmentFilesPanel({
  container,
  onOpenPath,
  onOpenTreatmentFolder,
  onPreviewLoadingStatusChange,
  onPatientKeywordsChanged,
  onSelectionChange,
}) {
  const panel = document.createElement("section");
  panel.className = "treatment-files-panel";
  panel.hidden = true;
  panel.innerHTML = `
    <div class="treatment-files-header">
      <div class="treatment-files-header-main">
        <div class="treatment-files-title">${t("treatment_files.title")}</div>
        <div class="treatment-files-folder"></div>
        <div class="treatment-files-counts"></div>
        <div class="treatment-previews-progress" hidden>
          <span class="treatment-previews-spinner" aria-hidden="true"></span>
          <span class="treatment-previews-progress-text">${t("treatment_files.loading_previews", { done: 0, total: 0 })}</span>
        </div>
      </div>
      <div class="treatment-files-view-toggle" role="group" aria-label="${t("treatment_files.treatment_files_view_mode")}">
        <button
          type="button"
          class="treatment-files-view-btn"
          data-view-mode="list"
          aria-label="${t("treatment_files.list_view")}"
          title="${t("treatment_files.list_view")}"
        >
          <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <path d="M4 5.2H16" />
            <path d="M4 10H16" />
            <path d="M4 14.8H16" />
          </svg>
        </button>
        <button
          type="button"
          class="treatment-files-view-btn"
          data-view-mode="tile"
          aria-label="${t("treatment_files.tile_view")}"
          title="${t("treatment_files.tile_view")}"
        >
          <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <rect x="3.6" y="3.6" width="5.8" height="5.8" rx="1.1" />
            <rect x="10.6" y="10.6" width="5.8" height="5.8" rx="1.1" />
          </svg>
        </button>
      </div>
    </div>
    <div class="treatment-files-loading" hidden>${t("treatment_files.loading_files")}</div>
    <div class="treatment-files-empty" hidden>${t("treatment_files.empty")}</div>
    <div class="treatment-keywords-wrap" hidden>
      <div class="treatment-files-section-title">${t("treatment_files.keywords")}</div>
      <div class="treatment-keywords-list"></div>
    </div>
    <div class="treatment-folders-overview-wrap" hidden>
      <div class="treatment-files-section-title">${t("treatment_files.folders")}</div>
      <div class="treatment-folders-overview-grid"></div>
    </div>
    <div class="treatment-files-list-wrap" hidden>
      <div class="treatment-files-list"></div>
    </div>
    <div class="treatment-files-images-wrap" hidden>
      <div class="treatment-files-section-title">${t("treatment_files.images")}</div>
      <div class="treatment-files-images-grid"></div>
    </div>
    <div class="treatment-files-other-wrap" hidden>
      <div class="treatment-files-section-title">${t("treatment_files.other_files")}</div>
      <div class="treatment-files-other-list"></div>
    </div>
    <button type="button" class="small-btn treatment-files-load-more" hidden>${t("treatment_files.load_more")}</button>
  `;
  container.appendChild(panel);

  const titleEl = panel.querySelector(".treatment-files-title");
  const folderEl = panel.querySelector(".treatment-files-folder");
  const countsEl = panel.querySelector(".treatment-files-counts");
  const previewsProgressEl = panel.querySelector(".treatment-previews-progress");
  const previewsProgressTextEl = panel.querySelector(".treatment-previews-progress-text");
  const viewToggleEl = panel.querySelector(".treatment-files-view-toggle");
  const viewBtns = Array.from(panel.querySelectorAll(".treatment-files-view-btn"));
  const loadingEl = panel.querySelector(".treatment-files-loading");
  const emptyEl = panel.querySelector(".treatment-files-empty");
  const keywordsWrapEl = panel.querySelector(".treatment-keywords-wrap");
  const keywordsListEl = panel.querySelector(".treatment-keywords-list");
  const foldersOverviewWrapEl = panel.querySelector(".treatment-folders-overview-wrap");
  const foldersOverviewGridEl = panel.querySelector(".treatment-folders-overview-grid");
  const listWrapEl = panel.querySelector(".treatment-files-list-wrap");
  const listEl = panel.querySelector(".treatment-files-list");
  const imagesWrapEl = panel.querySelector(".treatment-files-images-wrap");
  const imagesGridEl = panel.querySelector(".treatment-files-images-grid");
  const otherWrapEl = panel.querySelector(".treatment-files-other-wrap");
  const otherListEl = panel.querySelector(".treatment-files-other-list");
  const loadMoreBtn = panel.querySelector(".treatment-files-load-more");

  let activeContextKey = "";
  let activeContext = { workspaceDir: "", patientFolder: "", treatmentFolder: "" };
  let activeRequestId = 0;
  let isBackgroundFillRunning = false;
  let currentViewMode = "tile";
  const runtimePreviewByPath = new Map();
  const optimisticPreviewRevealedPaths = new Set();
  const cacheWarmupRequested = new Set();
  let activeCardsByPath = new Map();
  let activeImageFiles = [];
  let activeLoadedFiles = [];
  let activeFileOffset = 0;
  const optimisticThumbRotationByPath = new Map();
  let previewLoadingStatus = { running: false, completed: 0, total: 0 };
  let activeOverviewKeywords = [];
  const optimisticImportPlaceholdersByContext = new Map();
  let optimisticPlaceholderCards = [];
  let selectedExplorerItemKey = "";
  let selectedExplorerItem = null;

  function formatCounts(imageCount = 0, otherCount = 0, importingCount = 0) {
    return importingCount > 0
      ? t("treatment_files.images_plus_importing", {
        images: imageCount,
        importing: importingCount,
        other: otherCount,
      })
      : t("treatment_files.images_only", {
        images: imageCount,
        other: otherCount,
      });
  }

  const VIEW_MODE_STORAGE_KEY = "mpm.treatmentFilesViewMode";
  const normalizeViewMode = (value) => (value === "list" ? "list" : "tile");
  function loadStoredViewMode() {
    try {
      return normalizeViewMode(localStorage.getItem(VIEW_MODE_STORAGE_KEY));
    } catch {
      return "tile";
    }
  }
  function saveStoredViewMode(mode) {
    try {
      localStorage.setItem(VIEW_MODE_STORAGE_KEY, normalizeViewMode(mode));
    } catch {
      // ignore
    }
  }
  function applyViewModeUi(mode) {
    currentViewMode = normalizeViewMode(mode);
    panel.dataset.viewMode = currentViewMode;
    for (const btn of viewBtns) {
      const isActive = btn.dataset.viewMode === currentViewMode;
      btn.classList.toggle("active", isActive);
      btn.setAttribute("aria-pressed", isActive ? "true" : "false");
    }
  }
  function setViewMode(mode, { rerender = true } = {}) {
    const normalized = normalizeViewMode(mode);
    if (currentViewMode === normalized && rerender) return;
    applyViewModeUi(normalized);
    saveStoredViewMode(normalized);
    if (rerender && activeContext?.workspaceDir && activeContext?.patientFolder && activeContext?.treatmentFolder) {
      void setContext(activeContext);
    }
  }
  applyViewModeUi(loadStoredViewMode());
  onLanguageChanged(() => {
    titleEl.textContent = panel.hidden ? t("treatment_files.title") : titleEl.textContent;
    loadingEl.textContent = t("treatment_files.loading_files");
    emptyEl.textContent = t("treatment_files.empty");
    loadMoreBtn.textContent = t("treatment_files.load_more");
    keywordsWrapEl?.querySelector(".treatment-files-section-title")?.replaceChildren(t("treatment_files.keywords"));
    foldersOverviewWrapEl?.querySelector(".treatment-files-section-title")?.replaceChildren(t("treatment_files.folders"));
    imagesWrapEl?.querySelector(".treatment-files-section-title")?.replaceChildren(t("treatment_files.images"));
    otherWrapEl?.querySelector(".treatment-files-section-title")?.replaceChildren(t("treatment_files.other_files"));
    viewToggleEl?.setAttribute("aria-label", t("treatment_files.treatment_files_view_mode"));
    const [listBtn, tileBtn] = viewBtns;
    listBtn?.setAttribute("aria-label", t("treatment_files.list_view"));
    listBtn?.setAttribute("title", t("treatment_files.list_view"));
    tileBtn?.setAttribute("aria-label", t("treatment_files.tile_view"));
    tileBtn?.setAttribute("title", t("treatment_files.tile_view"));
    if (activeContext?.workspaceDir && activeContext?.patientFolder && activeContext?.treatmentFolder) {
      void setContext(activeContext);
    } else {
      clearPanel();
    }
  });
  viewToggleEl?.addEventListener("click", (event) => {
    const btn = event.target?.closest?.(".treatment-files-view-btn");
    if (!btn) return;
    const mode = btn.dataset.viewMode === "list" ? "list" : "tile";
    setViewMode(mode, { rerender: true });
  });

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
    let src = "";
    try {
      src = convertFileSrc(previewPath);
    } catch {
      src = "";
    }
    if (!src) return;
    runtimePreviewByPath.set(path, { src, quality: "full" });
    if (activeCardsByPath.has(path)) {
      clearOptimisticThumbRotation(path);
      setThumbImage(path, activeCardsByPath, src, {
        requestId: activeRequestId,
        allowPathFallback: true,
        previewQuality: "full",
      });
      return;
    }
    if (!isPathInActiveTreatmentFolder(path)) return;
    if (optimisticPreviewRevealedPaths.has(path)) return;
    const revealed = revealNextOptimisticPlaceholder(path, src);
    if (revealed) {
      optimisticPreviewRevealedPaths.add(path);
      return;
    }
    if (appendRuntimeImportedImage(path, src)) return;
  });
  void listen("import-file-copied", (event) => {
    const workspaceDir = String(event?.payload?.workspace_dir ?? event?.payload?.workspaceDir ?? "").trim();
    const patientFolder = String(event?.payload?.patient_folder ?? event?.payload?.patientFolder ?? "").trim();
    const targetFolder = String(event?.payload?.target_folder ?? event?.payload?.targetFolder ?? "").trim();
    const path = normalizePath(event?.payload?.path ?? "");
    const isImage = Boolean(event?.payload?.is_image ?? event?.payload?.isImage ?? false);
    if (!path || !isImage) return;
    if (!activeContext?.workspaceDir || !activeContext?.patientFolder || !activeContext?.treatmentFolder) return;
    if (
      workspaceDir !== String(activeContext.workspaceDir).trim() ||
      patientFolder !== String(activeContext.patientFolder).trim() ||
      targetFolder !== String(activeContext.treatmentFolder).trim()
    ) {
      return;
    }
    if (activeCardsByPath.has(path)) return;
    if (bindNextOptimisticPlaceholderToPath(path)) return;
    void appendRuntimeImportedImage(path, "");
  });
  void listen("image-preview-rotated", (event) => {
    const path = normalizePath(event?.payload?.path ?? "");
    const rotationDeg = Number(event?.payload?.rotation_deg ?? event?.payload?.rotationDeg ?? 0) || 0;
    if (!path) return;
    const normalizedRotation = ((rotationDeg % 360) + 360) % 360;
    if (!activeCardsByPath.has(path)) return;
    optimisticThumbRotationByPath.set(path, normalizedRotation);
    applyThumbRotation(path, activeCardsByPath);
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
    activeLoadedFiles = [];
    activeFileOffset = 0;
    optimisticThumbRotationByPath.clear();
    optimisticPreviewRevealedPaths.clear();
    activeOverviewKeywords = [];
    optimisticPlaceholderCards = [];
    panel.hidden = true;
    titleEl.textContent = t("treatment_files.title");
    folderEl.textContent = "";
    countsEl.textContent = "";
    if (previewsProgressEl) previewsProgressEl.hidden = true;
    if (previewsProgressTextEl) previewsProgressTextEl.textContent = t("treatment_files.loading_previews", { done: 0, total: 0 });
    previewLoadingStatus = { running: false, completed: 0, total: 0 };
    if (typeof onPreviewLoadingStatusChange === "function") {
      onPreviewLoadingStatusChange(previewLoadingStatus);
    }
    viewToggleEl.hidden = false;
    loadingEl.hidden = true;
    emptyEl.hidden = true;
    keywordsWrapEl.hidden = true;
    foldersOverviewWrapEl.hidden = true;
    listWrapEl.hidden = true;
    imagesWrapEl.hidden = true;
    otherWrapEl.hidden = true;
    loadMoreBtn.hidden = true;
    loadMoreBtn.disabled = false;
    foldersOverviewGridEl.innerHTML = "";
    keywordsListEl.innerHTML = "";
    listEl.innerHTML = "";
    imagesGridEl.innerHTML = "";
    otherListEl.innerHTML = "";
    clearExplorerSelection({ silent: true });
  }

  function getExplorerItemKey(item = null) {
    const path = String(item?.path ?? "").trim();
    const kind = String(item?.kind ?? "").trim();
    return path && kind ? `${kind}::${path}` : "";
  }

  function emitSelectionChange() {
    if (typeof onSelectionChange === "function") {
      onSelectionChange(selectedExplorerItem ? { ...selectedExplorerItem } : null);
    }
  }

  function clearExplorerSelection({ silent = false } = {}) {
    if (selectedExplorerItemKey) {
      panel
        .querySelectorAll(".selection-active")
        .forEach((element) => element.classList.remove("selection-active"));
    }
    selectedExplorerItemKey = "";
    selectedExplorerItem = null;
    if (!silent) emitSelectionChange();
  }

  function setExplorerSelection(item = null, element = null) {
    const nextKey = getExplorerItemKey(item);
    if (!nextKey || !element) {
      clearExplorerSelection();
      return;
    }
    if (selectedExplorerItemKey === nextKey) {
      clearExplorerSelection();
      return;
    }
    panel
      .querySelectorAll(".selection-active")
      .forEach((entry) => entry.classList.remove("selection-active"));
    element.classList.add("selection-active");
    selectedExplorerItemKey = nextKey;
    selectedExplorerItem = { ...item };
    emitSelectionChange();
  }

  function attachSelectionControl(element, item) {
    if (!element || !item) return;
    const selectBtn = document.createElement("span");
    selectBtn.className = "explorer-item-select-btn";
    selectBtn.setAttribute("role", "button");
    selectBtn.setAttribute("tabindex", "0");
    selectBtn.setAttribute("aria-label", "Select item");
    selectBtn.setAttribute("title", "Select item");
    const toggleSelection = (event) => {
      event.preventDefault();
      event.stopPropagation();
      setExplorerSelection(item, element);
    };
    selectBtn.addEventListener("click", toggleSelection);
    selectBtn.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      toggleSelection(event);
    });
    element.appendChild(selectBtn);
  }

  function setLoadingState(folderName = "") {
    panel.hidden = false;
    const { title, date } = parseTreatmentFolderHeader(folderName);
    titleEl.textContent = title || folderName;
    folderEl.textContent = date;
    countsEl.textContent = "";
    if (previewsProgressEl) previewsProgressEl.hidden = true;
    if (previewsProgressTextEl) previewsProgressTextEl.textContent = t("treatment_files.loading_previews", { done: 0, total: 0 });
    previewLoadingStatus = { running: false, completed: 0, total: 0 };
    if (typeof onPreviewLoadingStatusChange === "function") {
      onPreviewLoadingStatusChange(previewLoadingStatus);
    }
    viewToggleEl.hidden = false;
    loadingEl.hidden = false;
    emptyEl.hidden = true;
    keywordsWrapEl.hidden = true;
    foldersOverviewWrapEl.hidden = true;
    listWrapEl.hidden = true;
    imagesWrapEl.hidden = true;
    otherWrapEl.hidden = true;
    loadMoreBtn.hidden = true;
    loadMoreBtn.disabled = false;
    loadMoreBtn.onclick = null;
    optimisticThumbRotationByPath.clear();
    optimisticPreviewRevealedPaths.clear();
    activeOverviewKeywords = [];
    foldersOverviewGridEl.innerHTML = "";
    keywordsListEl.innerHTML = "";
    listEl.innerHTML = "";
    imagesGridEl.innerHTML = "";
    otherListEl.innerHTML = "";
  }

  function getContextKey(workspaceDir = "", patientFolder = "", treatmentFolder = "") {
    const w = String(workspaceDir ?? "").trim();
    const p = String(patientFolder ?? "").trim();
    const t = String(treatmentFolder ?? "").trim();
    return `${w}::${p}::${t}`;
  }

  function setOptimisticImportPlaceholders({
    workspaceDir = "",
    patientFolder = "",
    treatmentFolder = "",
    imageCount = 0,
    totalCount = 0,
    preferExistingThumbnailsFirst = false,
  } = {}) {
    const key = getContextKey(workspaceDir, patientFolder, treatmentFolder);
    if (!workspaceDir || !patientFolder || !treatmentFolder || !key) return;
    const previousState = optimisticImportPlaceholdersByContext.get(key);
    const baselineLoadedImageCount = Number(previousState?.baselineLoadedImageCount);
    const optimisticState = {
      imageCount: Math.max(0, Number(imageCount) || 0),
      totalCount: Math.max(0, Number(totalCount) || 0),
      preferExistingThumbnailsFirst: Boolean(preferExistingThumbnailsFirst),
      baselineLoadedImageCount: Number.isFinite(baselineLoadedImageCount)
        ? Math.max(0, baselineLoadedImageCount)
        : (Array.isArray(activeLoadedFiles)
            ? activeLoadedFiles.reduce((count, file) => (
                count + (Boolean(file?.is_image ?? file?.isImage) ? 1 : 0)
              ), 0)
            : 0),
    };
    optimisticImportPlaceholdersByContext.set(key, optimisticState);
    if (key !== activeContextKey || panel.hidden) return;
    const useListView = currentViewMode === "list";
    const placeholderCount = getRemainingOptimisticPlaceholderCount(optimisticState, activeLoadedFiles);
    const changed = activeLoadedFiles.length < 1
      ? renderOptimisticImportPlaceholders(placeholderCount)
      : appendOptimisticImportPlaceholders(placeholderCount, useListView) > 0;
    if (changed || optimisticPlaceholderCards.length > 0) {
      syncActiveCountsUi();
    }
  }

  function getRemainingOptimisticPlaceholderCount(optimistic = null, loadedFiles = []) {
    if (!optimistic) return 0;
    const optimisticImageCount = Math.max(0, Number(optimistic.imageCount) || 0);
    const loadedImageCount = (Array.isArray(loadedFiles) ? loadedFiles : []).reduce((count, file) => (
      count + (Boolean(file?.is_image ?? file?.isImage) ? 1 : 0)
    ), 0);
    const baselineLoadedImageCount = Math.max(
      0,
      Number(optimistic?.baselineLoadedImageCount) || 0
    );
    const newlyLoadedImageCount = Math.max(0, loadedImageCount - baselineLoadedImageCount);
    return Math.max(0, optimisticImageCount - newlyLoadedImageCount);
  }

  function renderOptimisticImportPlaceholders(count = 0) {
    const safeCount = Math.max(0, Number(count) || 0);
    if (safeCount < 1) return false;
    loadingEl.hidden = true;
    emptyEl.hidden = true;
    const useListView = currentViewMode === "list";
    listWrapEl.hidden = !useListView;
    imagesWrapEl.hidden = useListView;
    otherWrapEl.hidden = true;
    listEl.innerHTML = "";
    imagesGridEl.innerHTML = "";
    optimisticPlaceholderCards = [];
    optimisticPreviewRevealedPaths.clear();
    if (useListView) {
      for (let i = 0; i < safeCount; i += 1) {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "treatment-file-list-row";
        row.disabled = true;
        row.setAttribute("aria-hidden", "true");
        row.innerHTML = `
          <span class="treatment-image-thumb treatment-list-image-thumb fallback">IMG</span>
          <span class="treatment-file-list-name">Importing...</span>
          <span class="treatment-file-list-meta">
            <span class="treatment-file-list-size">-</span>
            <span class="treatment-file-list-date">-</span>
          </span>
        `;
        listEl.appendChild(row);
        optimisticPlaceholderCards.push(row);
      }
      return true;
    }
    for (let i = 0; i < safeCount; i += 1) {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "treatment-image-card";
      card.disabled = true;
      card.setAttribute("aria-hidden", "true");
      card.innerHTML = `
        <span class="treatment-image-thumb fallback">IMG</span>
        <span class="treatment-image-name"></span>
      `;
      imagesGridEl.appendChild(card);
      optimisticPlaceholderCards.push(card);
    }
    return true;
  }

  function appendOptimisticImportPlaceholders(count = 0, useListView = false) {
    const safeCount = Math.max(0, Number(count) || 0);
    if (safeCount < 1) return 0;
    const missingCount = Math.max(0, safeCount - optimisticPlaceholderCards.length);
    if (missingCount < 1) return 0;
    let appended = 0;
    for (let i = 0; i < missingCount; i += 1) {
      if (useListView) {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "treatment-file-list-row";
        row.disabled = true;
        row.setAttribute("aria-hidden", "true");
        row.innerHTML = `
          <span class="treatment-image-thumb treatment-list-image-thumb fallback">IMG</span>
          <span class="treatment-file-list-name">Importing...</span>
          <span class="treatment-file-list-meta">
            <span class="treatment-file-list-size">-</span>
            <span class="treatment-file-list-date">-</span>
          </span>
        `;
        listEl.appendChild(row);
        optimisticPlaceholderCards.push(row);
      } else {
        const card = document.createElement("button");
        card.type = "button";
        card.className = "treatment-image-card";
        card.disabled = true;
        card.setAttribute("aria-hidden", "true");
        card.innerHTML = `
          <span class="treatment-image-thumb fallback">IMG</span>
          <span class="treatment-image-name"></span>
        `;
        imagesGridEl.appendChild(card);
        optimisticPlaceholderCards.push(card);
      }
      appended += 1;
    }
    return appended;
  }

  function isPathInActiveTreatmentFolder(pathLike = "") {
    const path = normalizePath(pathLike).toLowerCase();
    if (!path || !activeContext?.workspaceDir || !activeContext?.patientFolder || !activeContext?.treatmentFolder) {
      return false;
    }
    const base = normalizePath(
      `${activeContext.workspaceDir}/${activeContext.patientFolder}/${activeContext.treatmentFolder}/`
    )
      .replaceAll("\\", "/")
      .toLowerCase();
    return path.replaceAll("\\", "/").startsWith(base);
  }

  function revealNextOptimisticPlaceholder(path = "", src = "") {
    if (!path || !src || optimisticPlaceholderCards.length < 1) return false;
    const card = optimisticPlaceholderCards.find((entry) => (
      String(entry?.dataset?.optimisticImportPath ?? "").trim() === path
    )) ?? optimisticPlaceholderCards.find((entry) => {
      const thumb = entry?.querySelector?.(".treatment-image-thumb");
      if (!thumb || thumb.querySelector("img")) return false;
      const boundPath = String(entry?.dataset?.optimisticImportPath ?? "").trim();
      return !boundPath || boundPath === path;
    });
    if (!card) return false;
    card.dataset.optimisticImportPath = path;
    const thumb = card.querySelector(".treatment-image-thumb");
    if (!thumb) return false;
    const img = document.createElement("img");
    img.className = "full-preview";
    img.alt = "";
    img.loading = "eager";
    img.decoding = "async";
    img.addEventListener("load", () => {
      thumb.classList.remove("fallback");
      thumb.innerHTML = "";
      thumb.appendChild(img);
    }, { once: true });
    img.src = src;
    if (img.complete && img.naturalWidth > 0) {
      thumb.classList.remove("fallback");
      thumb.innerHTML = "";
      thumb.appendChild(img);
    }
    return true;
  }

  function bindNextOptimisticPlaceholderToPath(path = "") {
    const normalizedPath = normalizePath(path);
    if (!normalizedPath || optimisticPlaceholderCards.length < 1) return false;
    const existing = optimisticPlaceholderCards.find((entry) => (
      String(entry?.dataset?.optimisticImportPath ?? "").trim() === normalizedPath
    ));
    if (existing) return true;
    const placeholder = optimisticPlaceholderCards.find((entry) => {
      const boundPath = String(entry?.dataset?.optimisticImportPath ?? "").trim();
      return !boundPath;
    });
    if (!placeholder) return false;
    placeholder.dataset.optimisticImportPath = normalizedPath;
    const name = normalizedPath.split(/[\\/]/).pop() || normalizedPath;
    const nameEl = placeholder.querySelector(".treatment-image-name, .treatment-file-list-name");
    if (nameEl) nameEl.textContent = name;
    return true;
  }

  function removeOneOptimisticPlaceholder() {
    const placeholder = optimisticPlaceholderCards.shift() ?? null;
    if (!placeholder) return false;
    placeholder.remove();
    return true;
  }

  function syncActiveCountsUi() {
    const imageCount = activeLoadedFiles.filter((f) => Boolean(f?.is_image ?? f?.isImage)).length;
    const otherCount = activeLoadedFiles.filter((f) => !Boolean(f?.is_image ?? f?.isImage)).length;
    const importingCount = optimisticPlaceholderCards.length;
    countsEl.textContent = importingCount > 0
      ? formatCounts(imageCount, otherCount, importingCount)
      : formatCounts(imageCount, otherCount, 0);
  }

  function appendRuntimeImportedImage(path, src = "") {
    const normalizedPath = normalizePath(path);
    if (!normalizedPath || activeCardsByPath.has(normalizedPath) || !isPathInActiveTreatmentFolder(normalizedPath)) {
      return false;
    }
    const name = normalizedPath.split(/[\\/]/).pop() || normalizedPath;
    const file = {
      path: normalizedPath,
      name,
      size: 0,
      created_ms: Date.now(),
      modified_ms: Date.now(),
      is_image: true,
    };
    const navigationPaths = Array.from(new Set([
      normalizedPath,
      ...activeImageFiles.map((entry) => normalizePath(entry?.path ?? "")),
    ].filter(Boolean)));
    let card = null;
    if (currentViewMode === "list") {
      card = createFileListRow(file, {
        scope: "treatment",
        navigationPaths,
      });
      listEl.insertBefore(card, listEl.firstChild ?? null);
      listWrapEl.hidden = false;
    } else {
      card = createImageCard(file, {
        scope: "treatment",
        navigationPaths,
      });
      imagesGridEl.insertBefore(card, imagesGridEl.firstChild ?? null);
      imagesWrapEl.hidden = false;
    }
    activeCardsByPath.set(normalizedPath, card);
    activeImageFiles = [file, ...activeImageFiles.filter((entry) => normalizePath(entry?.path ?? "") !== normalizedPath)];
    activeLoadedFiles = [file, ...activeLoadedFiles.filter((entry) => normalizePath(entry?.path ?? "") !== normalizedPath)];
    removeOneOptimisticPlaceholder();
    if (src) {
      setThumbImage(normalizedPath, activeCardsByPath, src, {
        requestId: activeRequestId,
        allowPathFallback: false,
        previewQuality: "full",
      });
    }
    syncActiveCountsUi();
    return true;
  }

  function setPreviewLoadingProgress(completed = 0, total = 0) {
    const safeTotal = Math.max(0, Number(total) || 0);
    const safeCompleted = Math.min(safeTotal, Math.max(0, Number(completed) || 0));
    if (!previewsProgressEl || !previewsProgressTextEl) return;
    previewsProgressEl.classList.remove("checking-cache");
    if (safeTotal < 1) {
      previewsProgressEl.hidden = true;
      previewsProgressTextEl.textContent = t("treatment_files.loading_previews", { done: 0, total: 0 });
      previewLoadingStatus = { running: false, completed: 0, total: 0 };
      if (typeof onPreviewLoadingStatusChange === "function") {
        onPreviewLoadingStatusChange(previewLoadingStatus);
      }
      return;
    }
    previewsProgressTextEl.textContent = `Loading Preview... (${safeCompleted}/${safeTotal})`;
    previewsProgressEl.hidden = safeCompleted >= safeTotal;
    previewLoadingStatus = {
      running: safeCompleted < safeTotal,
      completed: safeCompleted,
      total: safeTotal,
    };
    if (typeof onPreviewLoadingStatusChange === "function") {
      onPreviewLoadingStatusChange(previewLoadingStatus);
    }
  }

  function setPreviewCacheCheckStatus() {
    if (!previewsProgressEl || !previewsProgressTextEl) return;
    previewsProgressEl.classList.add("checking-cache");
    previewsProgressEl.hidden = false;
    previewsProgressTextEl.textContent = "Checking Cache...";
    previewLoadingStatus = { running: true, completed: 0, total: 0 };
    if (typeof onPreviewLoadingStatusChange === "function") {
      onPreviewLoadingStatusChange(previewLoadingStatus);
    }
  }

  async function requestActivePreviewPriority(requestId) {
    if (requestId !== activeRequestId) return;
    // Keep global background creation running; active-view work is prioritized by micro-batching.
    if (!isBackgroundFillRunning) return;
  }

  function createFolderStackItem(src = "", orderClass = "") {
    const item = document.createElement("span");
    item.className = `treatment-folder-stack-item ${orderClass}`.trim();
    const thumb = document.createElement("span");
    thumb.className = "treatment-image-thumb treatment-folder-stack-thumb fallback";
    thumb.textContent = "IMG";
    if (!src) {
      item.appendChild(thumb);
      return item;
    }
    const img = document.createElement("img");
    img.className = "full-preview";
    img.alt = "";
    img.loading = "eager";
    img.decoding = "async";
    const showLoaded = () => {
      thumb.classList.remove("fallback");
      thumb.innerHTML = "";
      thumb.appendChild(img);
    };
    img.addEventListener("load", showLoaded, { once: true });
    img.addEventListener("error", () => {
      if (img.parentElement === thumb) {
        img.remove();
      }
      thumb.classList.add("fallback");
      thumb.textContent = "IMG";
    }, { once: true });
    // Keep fallback label centered until image bytes are actually ready.
    img.src = src;
    if (img.complete && img.naturalWidth > 0) {
      showLoaded();
    }
    item.appendChild(thumb);
    return item;
  }

  function createFolderOverviewCard(folder = {}, previewSrcByPath = new Map()) {
    const folderName = String(folder?.folder_name ?? folder?.folderName ?? "").trim();
    const folderDate = String(folder?.folder_date ?? folder?.folderDate ?? "").trim();
    const treatmentName = String(folder?.treatment_name ?? folder?.treatmentName ?? "").trim();
    const previewPaths = Array.isArray(folder?.preview_paths ?? folder?.previewPaths)
      ? (folder?.preview_paths ?? folder?.previewPaths).map((p) => String(p ?? "").trim()).filter(Boolean)
      : [];

    const card = document.createElement("button");
    card.type = "button";
    card.className = "treatment-folder-overview-card";
    card.title = folderName || treatmentName || "Folder";
    attachSelectionControl(card, {
      kind: "folder",
      scope: "patient_overview",
      path: activeContext?.workspaceDir && activeContext?.patientFolder && folderName
        ? `${activeContext.workspaceDir}\\${activeContext.patientFolder}\\${folderName}`
        : "",
      name: treatmentName || folderName || "Folder",
      workspaceDir: activeContext?.workspaceDir ?? "",
      patientFolder: activeContext?.patientFolder ?? "",
      treatmentFolder: folderName,
    });

    const stack = document.createElement("span");
    stack.className = "treatment-folder-stack";
    const stackSources = [];
    for (const path of previewPaths.slice(0, 3)) {
      const cached = previewSrcByPath.get(path) ?? "";
      if (cached) {
        stackSources.push(cached);
        continue;
      }
      try {
        stackSources.push(convertFileSrc(path));
      } catch {
        stackSources.push("");
      }
    }
    const realSources = stackSources.filter(Boolean);
    if (realSources.length < 1) {
      const empty = document.createElement("span");
      empty.className = "treatment-folder-stack-empty";
      empty.textContent = "No images";
      stack.appendChild(empty);
    } else {
      const classes =
        realSources.length === 1
          ? ["solo"]
          : realSources.length === 2
            ? ["duo-left", "duo-right"]
            : ["one", "two", "three"];
      for (let i = 0; i < realSources.length && i < classes.length; i += 1) {
        stack.appendChild(createFolderStackItem(realSources[i], classes[i]));
      }
    }
    card.appendChild(stack);

    const label = document.createElement("span");
    label.className = "treatment-folder-overview-name";
    label.textContent = treatmentName || folderName || "Folder";
    card.appendChild(label);

    const date = document.createElement("span");
    date.className = "treatment-folder-overview-date";
    date.textContent = folderDate || "";
    card.appendChild(date);

    card.addEventListener("click", () => {
      if (typeof onOpenTreatmentFolder === "function" && folderName) {
        onOpenTreatmentFolder(folderName);
      }
    });
    return card;
  }

  async function setPatientOverviewContext({ workspaceDir = "", patientFolder = "" } = {}) {
    const w = String(workspaceDir ?? "").trim();
    const p = String(patientFolder ?? "").trim();
    if (!w || !p) {
      clearPanel();
      return;
    }

    activeContext = { workspaceDir: w, patientFolder: p, treatmentFolder: "" };
    activeContextKey = `${w}::${p}::overview`;
    const requestId = ++activeRequestId;
    panel.hidden = false;
    titleEl.textContent = "Overview";
    folderEl.textContent = "";
    countsEl.textContent = "";
    loadingEl.hidden = false;
    emptyEl.hidden = true;
    viewToggleEl.hidden = true;
    keywordsWrapEl.hidden = true;
    foldersOverviewWrapEl.hidden = true;
    listWrapEl.hidden = true;
    imagesWrapEl.hidden = true;
    otherWrapEl.hidden = true;
    loadMoreBtn.hidden = true;
    loadMoreBtn.disabled = false;
    loadMoreBtn.onclick = null;
    keywordsListEl.innerHTML = "";
    foldersOverviewGridEl.innerHTML = "";
    listEl.innerHTML = "";
    imagesGridEl.innerHTML = "";
    otherListEl.innerHTML = "";

    let overview = null;
    let keywords = [];
    const [overviewResult, keywordsResult] = await Promise.allSettled([
      invoke("list_patient_overview", {
        workspaceDir: w,
        patientFolder: p,
      }),
      invoke("load_patient_keywords", {
        workspaceDir: w,
        folderName: p,
      }),
    ]);
    if (requestId !== activeRequestId) return;
    if (keywordsResult.status === "fulfilled") {
      keywords = normalizeKeywords(keywordsResult.value);
    }
    if (overviewResult.status !== "fulfilled") {
      if (requestId !== activeRequestId) return;
      loadingEl.hidden = true;
      emptyEl.hidden = false;
      emptyEl.textContent = "Could not load patient overview.";
      return;
    }
    overview = overviewResult.value;

    const folders = Array.isArray(overview?.treatment_folders ?? overview?.treatmentFolders)
      ? (overview?.treatment_folders ?? overview?.treatmentFolders)
      : [];
    const rootFiles = Array.isArray(overview?.root_files ?? overview?.rootFiles)
      ? (overview?.root_files ?? overview?.rootFiles)
      : [];

    loadingEl.hidden = true;
    emptyEl.hidden = folders.length > 0 || rootFiles.length > 0;
    countsEl.textContent = `${folders.length} folders, ${rootFiles.length} root files`;
    activeOverviewKeywords = normalizeKeywords(keywords);
    renderOverviewKeywords(w, p, requestId);

    otherWrapEl.hidden = rootFiles.length < 1;
    const rootImagePaths = rootFiles
      .filter((file) => Boolean(file?.is_image ?? file?.isImage))
      .map((file) => normalizePath(file?.path ?? ""))
      .filter((path) => path.length > 0);
    const rootImageCardsByPath = renderOtherFiles(rootFiles, {
      scope: "patient_root",
      navigationPaths: rootImagePaths,
    });

    if (folders.length > 0 || rootImagePaths.length > 0) {
      const stackPreviewPaths = [];
      for (const folder of folders) {
        const paths = Array.isArray(folder?.preview_paths ?? folder?.previewPaths)
          ? (folder?.preview_paths ?? folder?.previewPaths)
          : [];
        for (const path of paths) {
          const normalized = String(path ?? "").trim();
          if (normalized) stackPreviewPaths.push(normalized);
        }
      }
      const priorityPaths = Array.from(new Set([...stackPreviewPaths, ...rootImagePaths]));

      let previewSrcByPath = new Map();
      foldersOverviewWrapEl.hidden = folders.length < 1;
      const renderOverviewCards = () => {
        foldersOverviewGridEl.innerHTML = "";
        for (const folder of folders) {
          const card = createFolderOverviewCard(folder, previewSrcByPath);
          foldersOverviewGridEl.appendChild(card);
        }
      };
      // Render immediately so overview cards are visible even if preview lookup is slow.
      renderOverviewCards();

      if (priorityPaths.length > 0) {
        setPreviewCacheCheckStatus();
      }
      try {
        previewSrcByPath = await loadExistingCachedPreviewSrcMap(priorityPaths);
      } catch {
        previewSrcByPath = new Map();
      }
      if (requestId !== activeRequestId) return;

      renderOverviewCards();

      for (const path of rootImagePaths) {
        const src = previewSrcByPath.get(path) ?? "";
        if (!src) continue;
        setThumbImage(path, rootImageCardsByPath, src, {
          requestId,
          allowPathFallback: true,
          previewQuality: "full",
        });
      }

      const missingPriorityPaths = priorityPaths.filter((path) => !previewSrcByPath.has(path));
      const loadedPriorityCount = priorityPaths.length - missingPriorityPaths.length;
      if (priorityPaths.length > 0) {
        setPreviewLoadingProgress(loadedPriorityCount, priorityPaths.length);
      }
      if (missingPriorityPaths.length > 0) {
        await requestActivePreviewPriority(requestId);
        let doneMissing = 0;
        for (let i = 0; i < missingPriorityPaths.length; i += ACTIVE_PREVIEW_BATCH_SIZE) {
          if (requestId !== activeRequestId) return;
          const batch = missingPriorityPaths.slice(i, i + ACTIVE_PREVIEW_BATCH_SIZE);
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
          for (const row of Array.isArray(rows) ? rows : []) {
            const path = normalizePath(row?.path ?? "");
            const dataUrl = normalizePath(row?.data_url ?? row?.dataUrl ?? "");
            const previewPath = normalizePath(row?.preview_path ?? row?.previewPath ?? "");
            if (!path) continue;
            if (dataUrl) {
              previewSrcByPath.set(path, dataUrl);
              continue;
            }
            if (!previewPath) continue;
            try {
              previewSrcByPath.set(path, convertFileSrc(previewPath));
            } catch {
              // ignore conversion failures
            }
          }
          doneMissing += batch.length;
          setPreviewLoadingProgress(loadedPriorityCount + doneMissing, priorityPaths.length);
          renderOverviewCards();
          for (const path of rootImagePaths) {
            const src = previewSrcByPath.get(path) ?? "";
            if (!src) continue;
            setThumbImage(path, rootImageCardsByPath, src, {
              requestId,
              allowPathFallback: true,
              previewQuality: "full",
            });
          }
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      }

      const priorityPathSet = new Set(priorityPaths);
      let stageTwoOffset = 0;
      let stageTwoHasMore = true;
      let stageTwoLoaded = 0;
      let stageTwoTotal = 0;
      while (stageTwoHasMore) {
        if (requestId !== activeRequestId) return;
        let pageRows = [];
        try {
          const page = await invoke("list_patient_image_paths_page", {
            workspaceDir: w,
            patientFolder: p,
            offset: stageTwoOffset,
            limit: 5000,
          });
          pageRows = Array.isArray(page?.rows)
            ? page.rows.map((entry) => normalizePath(entry)).filter((path) => path.length > 0)
            : [];
          stageTwoHasMore = Boolean(page?.has_more ?? page?.hasMore ?? false);
        } catch {
          pageRows = [];
          stageTwoHasMore = false;
        }
        if (requestId !== activeRequestId) return;
        stageTwoOffset += pageRows.length;

        const pageStageTwoPaths = pageRows.filter((path) => !priorityPathSet.has(path));
        if (pageStageTwoPaths.length < 1) {
          if (!stageTwoHasMore) break;
          continue;
        }

        stageTwoTotal += pageStageTwoPaths.length;
        let stageTwoCacheMap = new Map();
        if (pageStageTwoPaths.length > 0) {
          setPreviewCacheCheckStatus();
        }
        try {
          stageTwoCacheMap = await loadExistingCachedPreviewSrcMap(pageStageTwoPaths);
        } catch {
          stageTwoCacheMap = new Map();
        }
        if (requestId !== activeRequestId) return;

        const stageTwoMissing = pageStageTwoPaths.filter((path) => !stageTwoCacheMap.has(path));
        stageTwoLoaded += pageStageTwoPaths.length - stageTwoMissing.length;
        setPreviewLoadingProgress(stageTwoLoaded, stageTwoTotal);
        if (stageTwoMissing.length > 0) {
          await requestActivePreviewPriority(requestId);
          for (let i = 0; i < stageTwoMissing.length; i += ACTIVE_PREVIEW_BATCH_SIZE) {
            if (requestId !== activeRequestId) return;
            const batch = stageTwoMissing.slice(i, i + ACTIVE_PREVIEW_BATCH_SIZE);
            try {
              await invoke("get_cached_image_previews", {
                paths: batch,
                includeDataUrl: false,
                generateIfMissing: true,
              });
            } catch {
              // ignore failures; continue background retries
            }
            stageTwoLoaded += batch.length;
            setPreviewLoadingProgress(stageTwoLoaded, stageTwoTotal);
            await new Promise((resolve) => setTimeout(resolve, 0));
          }
        }
      }
      if (stageTwoTotal < 1) {
        setPreviewLoadingProgress(0, 0);
      } else {
        setPreviewLoadingProgress(stageTwoLoaded, stageTwoTotal);
      }
    } else {
      setPreviewLoadingProgress(0, 0);
    }
  }

  async function persistOverviewKeywords(workspaceDir, patientFolder, keywords, requestId) {
    const normalized = normalizeKeywords(keywords);
    await invoke("save_patient_keywords", {
      workspaceDir,
      folderName: patientFolder,
      keywords: normalized,
    });
    if (requestId !== activeRequestId) return;
    activeOverviewKeywords = normalized;
    renderOverviewKeywords(workspaceDir, patientFolder, requestId);
    if (typeof onPatientKeywordsChanged === "function") {
      onPatientKeywordsChanged({
        workspaceDir,
        patientFolder,
        keywords: normalized,
      });
    }
  }

  function renderOverviewKeywords(workspaceDir, patientFolder, requestId) {
    keywordsWrapEl.hidden = false;
    keywordsListEl.innerHTML = "";

    for (const keyword of activeOverviewKeywords) {
      const badge = document.createElement("span");
      badge.className = "treatment-keyword-badge";

      const text = document.createElement("span");
      text.className = "treatment-keyword-label";
      text.textContent = keyword;
      badge.appendChild(text);

      const xMark = document.createElement("button");
      xMark.type = "button";
      xMark.className = "treatment-keyword-x";
      xMark.textContent = "×";
      xMark.setAttribute("aria-label", `Remove keyword ${keyword}`);
      xMark.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const filtered = activeOverviewKeywords.filter(
          (entry) => entry.toLowerCase() !== keyword.toLowerCase()
        );
        void persistOverviewKeywords(workspaceDir, patientFolder, filtered, requestId);
      });
      badge.appendChild(xMark);

      keywordsListEl.appendChild(badge);
    }

    const addKeywordBtn = document.createElement("button");
    addKeywordBtn.type = "button";
    addKeywordBtn.className = "treatment-keyword-add";
    addKeywordBtn.textContent = `${t("treatment_files.keywords")}...`;
    addKeywordBtn.addEventListener("click", () => {
      const input = document.createElement("input");
      input.type = "text";
      input.className = "treatment-keyword-input";
      input.placeholder = `${t("treatment_files.keywords")}...`;
      let closed = false;
      const closeInput = () => {
        if (closed) return;
        closed = true;
        renderOverviewKeywords(workspaceDir, patientFolder, requestId);
      };
      const submitValue = async () => {
        const value = String(input.value ?? "").trim();
        if (!value) {
          closeInput();
          return;
        }
        const next = normalizeKeywords([...activeOverviewKeywords, value]);
        input.disabled = true;
        try {
          await persistOverviewKeywords(workspaceDir, patientFolder, next, requestId);
        } catch (err) {
          console.error("save_patient_keywords failed:", err);
          closeInput();
        }
      };
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          void submitValue();
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          closeInput();
        }
      });
      input.addEventListener("blur", closeInput, { once: true });
      addKeywordBtn.replaceWith(input);
      requestAnimationFrame(() => {
        input.focus();
        input.select();
      });
    });
    keywordsListEl.appendChild(addKeywordBtn);
  }

  function renderOtherFiles(otherFiles = [], options = {}) {
    otherListEl.innerHTML = "";
    const imageCardsByPath = new Map();
    const scope = String(options?.scope ?? "").trim();
    const navigationPaths = Array.isArray(options?.navigationPaths) ? options.navigationPaths : [];
    for (const file of otherFiles) {
      const row = createFileListRow(file, { scope, navigationPaths });
      otherListEl.appendChild(row);
      if (Boolean(file?.is_image ?? file?.isImage)) {
        const path = normalizePath(file?.path ?? "");
        if (path) imageCardsByPath.set(path, row);
      }
    }
    return imageCardsByPath;
  }

  function createImageCard(file, options = {}) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "treatment-image-card";
    card.title = file.path;
    card.draggable = true;
    card.innerHTML = `
      <span class="treatment-image-thumb fallback">IMG</span>
      <span class="treatment-image-name">${file.name}</span>
    `;
    attachSelectionControl(card, {
      kind: "file",
      scope: String(options?.scope ?? "").trim() || "treatment",
      path: String(file?.path ?? "").trim(),
      name: String(file?.name ?? "").trim(),
      isImage: true,
      workspaceDir: activeContext?.workspaceDir ?? "",
      patientFolder: activeContext?.patientFolder ?? "",
      treatmentFolder: activeContext?.treatmentFolder ?? "",
    });
    let dragged = false;
    card.addEventListener("click", () => {
      if (dragged) {
        dragged = false;
        return;
      }
      if (typeof onOpenPath === "function") {
        void onOpenPath({
          path: file.path,
          isImage: true,
          scope: String(options?.scope ?? "").trim() || "treatment",
          workspaceDir: activeContext?.workspaceDir ?? "",
          patientFolder: activeContext?.patientFolder ?? "",
          treatmentFolder: activeContext?.treatmentFolder ?? "",
          navigationPaths: Array.isArray(options?.navigationPaths) ? options.navigationPaths : [],
        });
      }
    });
    card.addEventListener("dragstart", (event) => {
      dragged = true;
      const dt = event?.dataTransfer;
      if (!dt) return;
      dt.effectAllowed = "copy";
      dt.setData("application/x-mpm-image-export", String(file.path ?? ""));

      const previewImg = card.querySelector(".treatment-image-thumb img");
      if (previewImg) {
        dt.setDragImage(previewImg, 20, 20);
      }
    });
    attachCopyOnDragEnd(card, file, () => {
      dragged = false;
    });
    return card;
  }

  function createFileListRow(file, options = {}) {
    const isImage = Boolean(file?.is_image ?? file?.isImage);
    const createdMs = Number(file?.created_ms ?? file?.createdMs ?? file?.modified_ms ?? file?.modifiedMs ?? 0) || 0;
    const dateText = formatDateOnly(createdMs);
    const row = document.createElement("button");
    row.type = "button";
    row.className = "treatment-file-list-row";
    row.title = file.path;
    row.draggable = true;
    row.innerHTML = `
      ${
        isImage
          ? `<span class="treatment-image-thumb treatment-list-image-thumb fallback">IMG</span>`
          : `<span class="treatment-file-list-ext">${fileExtBadgeLabel(file.name)}</span>`
      }
      <span class="treatment-file-list-name">${file.name}</span>
      <span class="treatment-file-list-meta">
        <span class="treatment-file-list-size">${formatBytes(file.size)}</span>
        <span class="treatment-file-list-date">${dateText || "-"}</span>
      </span>
    `;
    attachSelectionControl(row, {
      kind: "file",
      scope: String(options?.scope ?? "").trim() || (activeContext?.treatmentFolder ? "treatment" : "patient_root"),
      path: String(file?.path ?? "").trim(),
      name: String(file?.name ?? "").trim(),
      isImage,
      workspaceDir: activeContext?.workspaceDir ?? "",
      patientFolder: activeContext?.patientFolder ?? "",
      treatmentFolder: activeContext?.treatmentFolder ?? "",
    });
    row.addEventListener("click", () => {
      if (typeof onOpenPath === "function") {
        void onOpenPath({
          path: file.path,
          isImage,
          scope: String(options?.scope ?? "").trim() || (activeContext?.treatmentFolder ? "treatment" : "patient_root"),
          workspaceDir: activeContext?.workspaceDir ?? "",
          patientFolder: activeContext?.patientFolder ?? "",
          treatmentFolder: activeContext?.treatmentFolder ?? "",
          navigationPaths: Array.isArray(options?.navigationPaths) ? options.navigationPaths : [],
        });
      }
    });
    row.addEventListener("dragstart", (event) => {
      const dt = event?.dataTransfer;
      if (!dt) return;
      dt.effectAllowed = "copy";
      dt.setData("application/x-mpm-file-export", String(file.path ?? ""));
      dt.setData("text/plain", String(file.path ?? ""));
    });
    attachCopyOnDragEnd(row, file);
    return row;
  }

  function attachCopyOnDragEnd(el, file, onDone = null) {
    el.addEventListener("dragend", () => {
      const sourcePath = String(file?.path ?? "").trim();
      if (!sourcePath) {
        if (typeof onDone === "function") onDone();
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
          if (!destinationDir) return;
          await invoke("copy_file_to_destination", {
            sourcePath,
            destinationDir,
          });
        } catch (err) {
          console.error("copy_file_to_destination failed:", err);
        } finally {
          if (typeof onDone === "function") onDone();
        }
      })();
    });
  }

  function setFallbackThumb(path, cardsByPath) {
    const card = cardsByPath.get(path);
    const thumb = card?.querySelector(".treatment-image-thumb");
    if (!thumb) return;
    runtimePreviewByPath.delete(path);
    thumb.classList.remove("loading");
    thumb.classList.add("fallback");
    thumb.style.transform = "";
    thumb.textContent = "IMG";
  }

  function applyThumbRotation(path, cardsByPath) {
    const card = cardsByPath.get(path);
    const thumb = card?.querySelector(".treatment-image-thumb");
    if (!thumb) return;
    const rotationDeg = Number(optimisticThumbRotationByPath.get(path) ?? 0) || 0;
    if (rotationDeg === 0) {
      thumb.style.transform = "";
      return;
    }
    thumb.style.transform = `rotate(${rotationDeg}deg)`;
  }

  function normalizeRotationDeg(value = 0) {
    const n = Number(value) || 0;
    return ((n % 360) + 360) % 360;
  }

  function clearOptimisticThumbRotation(path) {
    optimisticThumbRotationByPath.delete(path);
  }

  function previewSrcFromRow(row) {
    const dataUrl = normalizePath(row?.data_url ?? row?.dataUrl ?? "");
    if (dataUrl) return dataUrl;
    const previewPath = normalizePath(row?.preview_path ?? row?.previewPath ?? "");
    if (!previewPath) return "";
    try {
      return convertFileSrc(previewPath);
    } catch {
      return "";
    }
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
        const src = previewSrcFromRow(row);
        if (src) {
          setThumbImage(path, cardsByPath, src, {
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

    thumb.classList.add("loading");
    thumb.classList.add("fallback");
    thumb.textContent = "IMG";
    const img = document.createElement("img");
    img.className = quality === "quick" ? "quick-preview" : "full-preview";
    img.alt = "";
    img.loading = "eager";
    img.decoding = "async";

    const showLoadedImage = () => {
      // Allow in-flight loads to complete even if a newer request started.
      // Only abort if this card is no longer the active card for this path.
      if (cardsByPath.get(path) !== card) return;
      thumb.classList.remove("loading");
      thumb.classList.remove("fallback");
      thumb.innerHTML = "";
      thumb.appendChild(img);
      applyThumbRotation(path, cardsByPath);
    };

    img.addEventListener("load", showLoadedImage, { once: true });

    if (allowPathFallback) {
      img.addEventListener("error", () => {
        if (cardsByPath.get(path) !== card) return;
        recoverSingleThumbWithRetry(path, cardsByPath, requestId, 0);
      }, { once: true });
    } else {
      img.addEventListener("error", () => {
        if (cardsByPath.get(path) !== card) return;
        setFallbackThumb(path, cardsByPath);
      }, { once: true });
    }

    img.src = src;
    if (img.complete && img.naturalWidth > 0) {
      showLoadedImage();
    }
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

  async function loadExistingCachedPreviewDataSrcMap(paths = []) {
    const normalized = Array.isArray(paths)
      ? paths.map((p) => normalizePath(p)).filter((p) => p.length > 0)
      : [];
    if (normalized.length < 1) return new Map();
    const rows = await invoke("get_cached_image_previews", {
      paths: normalized,
      includeDataUrl: true,
      generateIfMissing: false,
    });
    const out = new Map();
    for (const row of Array.isArray(rows) ? rows : []) {
      const path = normalizePath(row?.path ?? "");
      const dataUrl = normalizePath(row?.data_url ?? row?.dataUrl ?? "");
      const previewPath = normalizePath(row?.preview_path ?? row?.previewPath ?? "");
      if (!path) continue;
      if (dataUrl) {
        out.set(path, dataUrl);
        continue;
      }
      if (previewPath) {
        try {
          out.set(path, convertFileSrc(previewPath));
        } catch {
          // ignore conversion failures
        }
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
        const src = previewSrcFromRow(row);
        if (path && src) map.set(path, src);
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
      batchSize = ACTIVE_PREVIEW_BATCH_SIZE,
      existingCacheByPath = null,
      onProgress = null,
    } = {}
  ) {
    const queue = Array.isArray(imageFiles) ? imageFiles : [];
    const allPaths = queue
      .map((file) => normalizePath(file?.path ?? ""))
      .filter((path) => path.length > 0);
    const total = allPaths.length;
    if (total < 1) {
      if (typeof onProgress === "function") onProgress(0, 0);
      return;
    }

    if (typeof onProgress === "function") onProgress(0, total);
    await requestActivePreviewPriority(requestId);

    let completed = 0;
    const safeBatchSize = Math.max(1, Number(batchSize) || ACTIVE_PREVIEW_BATCH_SIZE);
    for (let i = 0; i < allPaths.length; i += safeBatchSize) {
      if (requestId !== activeRequestId) return;
      const batch = allPaths.slice(i, i + safeBatchSize);
      const unknownPaths = batch.filter((path) => !(existingCacheByPath?.has(path)));

      if (unknownPaths.length > 0) {
        let rows = [];
        try {
          rows = await invoke("get_cached_image_previews", {
            paths: unknownPaths,
            includeDataUrl: false,
            generateIfMissing: true,
          });
        } catch {
          rows = [];
        }
        if (requestId !== activeRequestId) return;
        for (const row of Array.isArray(rows) ? rows : []) {
          const path = normalizePath(row?.path ?? "");
          const previewPath = normalizePath(row?.preview_path ?? row?.previewPath ?? "");
          if (!path || !previewPath) continue;
          try {
            existingCacheByPath?.set(path, convertFileSrc(previewPath));
          } catch {
            // ignore preview conversion failures
          }
        }
      }

      for (const path of batch) {
        if (requestId !== activeRequestId) return;
        const cachedSrc = existingCacheByPath?.get(path) ?? "";
        if (cachedSrc) {
          setThumbImage(path, cardsByPath, cachedSrc, {
            requestId,
            allowPathFallback: true,
            previewQuality: "full",
          });
        } else {
          setFallbackThumb(path, cardsByPath);
          recoverSingleThumbWithRetry(path, cardsByPath, requestId, 0);
        }
      }

      completed += batch.length;
      if (typeof onProgress === "function") onProgress(completed, total);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    await recoverFallbackThumbs(cardsByPath, imageFiles, requestId);
  }

  async function setContext(
    { workspaceDir = "", patientFolder = "", treatmentFolder = "" } = {},
    options = {}
  ) {
    const w = String(workspaceDir ?? "").trim();
    const p = String(patientFolder ?? "").trim();
    const t = String(treatmentFolder ?? "").trim();

    if (!w || !p || !t) {
      clearPanel();
      return;
    }

    const contextKey = `${w}::${p}::${t}`;
    const optimistic = optimisticImportPlaceholdersByContext.get(contextKey);
    const append = Boolean(options?.append) && contextKey === activeContextKey;
    const previousLoadedFiles =
      !append && contextKey === activeContextKey ? [...activeLoadedFiles] : [];
    const sameVisibleContext = Boolean(
      !append &&
      contextKey === activeContextKey &&
      !panel.hidden
    );
    const keepExistingVisible = Boolean(
      sameVisibleContext &&
      (optimistic || activeLoadedFiles.length > 0 || optimisticPlaceholderCards.length > 0)
    );
    if (!append && contextKey !== activeContextKey) {
      activeLoadedFiles = [];
      activeFileOffset = 0;
    }
    activeContext = { workspaceDir: w, patientFolder: p, treatmentFolder: t };
    activeContextKey = contextKey;
    const requestId = ++activeRequestId;
    if (!append && !keepExistingVisible) {
      setLoadingState(t);
      if (optimistic && !optimistic.preferExistingThumbnailsFirst) {
        const placeholderCount = getRemainingOptimisticPlaceholderCount(optimistic, []);
        const didRender = renderOptimisticImportPlaceholders(placeholderCount);
        if (didRender) {
          countsEl.textContent = t("treatment_files.images_importing", {
            images: Math.max(0, Number(optimistic.imageCount) || 0),
          });
        }
      }
    }

    let files = [];
    let totalCount = 0;
    let hasMore = false;
    try {
      const page = await invoke("list_treatment_files_page", {
        workspaceDir: w,
        patientFolder: p,
        treatmentFolder: t,
        offset: append ? activeFileOffset : 0,
        limit: FILE_LIST_PAGE_SIZE,
      });
      if (requestId !== activeRequestId || contextKey !== activeContextKey) return;
      const pageRows = Array.isArray(page?.rows) ? page.rows : [];
      files = append ? [...activeLoadedFiles, ...pageRows] : pageRows;
      totalCount = Number(page?.total_count ?? page?.totalCount ?? files.length) || files.length;
      hasMore = Boolean(page?.has_more ?? page?.hasMore ?? false);
      activeLoadedFiles = files;
      activeFileOffset = files.length;
    } catch {
      if (requestId !== activeRequestId) return;
      if (keepExistingVisible && optimistic) {
        loadingEl.hidden = true;
        emptyEl.hidden = true;
        const useListView = currentViewMode === "list";
        const placeholderCount = getRemainingOptimisticPlaceholderCount(optimistic, activeLoadedFiles);
        const appended = appendOptimisticImportPlaceholders(placeholderCount, useListView);
        if (appended > 0) {
          const existingImageCount = activeLoadedFiles.filter((f) => Boolean(f?.is_image ?? f?.isImage)).length;
          const existingOtherCount = activeLoadedFiles.filter((f) => !Boolean(f?.is_image ?? f?.isImage)).length;
          countsEl.textContent = formatCounts(existingImageCount, existingOtherCount, appended);
        }
        return;
      }
      loadingEl.hidden = true;
      emptyEl.hidden = false;
      emptyEl.textContent = t("treatment_files.could_not_load");
      return;
    }

    const imageFiles = files.filter((f) => Boolean(f?.is_image ?? f?.isImage));
    const otherFiles = files.filter((f) => !Boolean(f?.is_image ?? f?.isImage));
    const useListView = currentViewMode === "list";

    if (keepExistingVisible && optimistic && previousLoadedFiles.length > 0) {
      loadingEl.hidden = true;
      emptyEl.hidden = true;
      const placeholderCount = getRemainingOptimisticPlaceholderCount(optimistic, previousLoadedFiles);
      const appended = appendOptimisticImportPlaceholders(placeholderCount, useListView);
      if (appended > 0) {
        const existingImageCount = previousLoadedFiles.filter((f) => Boolean(f?.is_image ?? f?.isImage)).length;
        const existingOtherCount = previousLoadedFiles.filter((f) => !Boolean(f?.is_image ?? f?.isImage)).length;
        countsEl.textContent = formatCounts(existingImageCount, existingOtherCount, appended);
      }
      loadMoreBtn.hidden = !hasMore;
      loadMoreBtn.disabled = false;
      if (hasMore) {
        loadMoreBtn.onclick = () => {
          loadMoreBtn.disabled = true;
          void setContext(activeContext, { append: true });
        };
      } else {
        loadMoreBtn.onclick = null;
      }
      return;
    }

    if (keepExistingVisible && files.length < 1 && optimistic) {
      loadingEl.hidden = true;
      emptyEl.hidden = true;
      const placeholderCount = getRemainingOptimisticPlaceholderCount(optimistic, activeLoadedFiles);
      const appended = appendOptimisticImportPlaceholders(placeholderCount, useListView);
      if (appended > 0) {
        const existingImageCount = activeLoadedFiles.filter((f) => Boolean(f?.is_image ?? f?.isImage)).length;
        const existingOtherCount = activeLoadedFiles.filter((f) => !Boolean(f?.is_image ?? f?.isImage)).length;
        countsEl.textContent = formatCounts(existingImageCount, existingOtherCount, appended);
      }
      return;
    }

    loadingEl.hidden = true;
    emptyEl.hidden = files.length > 0;
    countsEl.textContent = formatCounts(imageFiles.length, otherFiles.length, 0);
    listWrapEl.hidden = !useListView || files.length < 1;
    imagesWrapEl.hidden = useListView || imageFiles.length < 1;
    otherWrapEl.hidden = useListView || otherFiles.length < 1;

    listEl.innerHTML = "";
    imagesGridEl.innerHTML = "";
    otherListEl.innerHTML = "";

    if (files.length < 1) {
      if (optimistic && !append) {
        const placeholderCount = getRemainingOptimisticPlaceholderCount(optimistic, []);
        const didRender = renderOptimisticImportPlaceholders(placeholderCount);
        if (didRender) {
          countsEl.textContent = t("treatment_files.images_importing", {
            images: Math.max(0, Number(optimistic.imageCount) || 0),
          });
          return;
        }
      }
      return;
    }
    optimisticPlaceholderCards = [];

    loadMoreBtn.hidden = !hasMore;
    loadMoreBtn.disabled = false;
    if (hasMore) {
      loadMoreBtn.onclick = () => {
        loadMoreBtn.disabled = true;
        void setContext(activeContext, { append: true });
      };
    } else {
      loadMoreBtn.onclick = null;
    }

    const treatmentImagePaths = imageFiles
      .map((file) => normalizePath(file?.path ?? ""))
      .filter((path) => path.length > 0);

    const cardsByPath = new Map();
    if (useListView) {
      for (const file of files) {
        const row = createFileListRow(file, {
          scope: "treatment",
          navigationPaths: treatmentImagePaths,
        });
        listEl.appendChild(row);
        if (Boolean(file?.is_image ?? file?.isImage)) {
          const path = normalizePath(file?.path ?? "");
          if (path) cardsByPath.set(path, row);
        }
      }
    } else {
      renderOtherFiles(otherFiles, { scope: "treatment" });
      for (const file of imageFiles) {
        const card = createImageCard(file, {
          scope: "treatment",
          navigationPaths: treatmentImagePaths,
        });
        const path = normalizePath(file?.path ?? "");
        if (path) cardsByPath.set(path, card);
        imagesGridEl.appendChild(card);
      }
    }
    if (optimistic) {
      const placeholderCount = getRemainingOptimisticPlaceholderCount(optimistic, files);
      const appended = appendOptimisticImportPlaceholders(placeholderCount, useListView);
      if (appended > 0) {
        countsEl.textContent = formatCounts(imageFiles.length, otherFiles.length, appended);
      }
    }
    activeCardsByPath = cardsByPath;
    activeImageFiles = imageFiles;

    const needsLoad = [];
    const runtimeReadyPaths = new Set();
    for (const file of imageFiles) {
      const path = normalizePath(file?.path ?? "");
      if (!path) continue;
      if (applyRuntimePreviewIfAvailable(path, cardsByPath)) {
        runtimeReadyPaths.add(path);
      } else {
        needsLoad.push(file);
      }
    }

    const visibleFirst = needsLoad.slice(0, VISIBLE_FIRST_IMAGE_COUNT);
    const initial = needsLoad.slice(VISIBLE_FIRST_IMAGE_COUNT, INITIAL_IMAGE_PREVIEWS);
    const rest = needsLoad.slice(INITIAL_IMAGE_PREVIEWS);

    const allImagePaths = treatmentImagePaths;
    let existingCacheByPath = new Map();
    if (allImagePaths.length > 0) {
      setPreviewCacheCheckStatus();
    }
    try {
      existingCacheByPath = await loadExistingCachedPreviewSrcMap(allImagePaths);
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

    const restMissing = rest.filter((f) => {
      const path = normalizePath(f?.path ?? "");
      return path && !existingCacheByPath.has(path);
    });
    const totalMissing = firstPhase.length + restMissing.length;
    const totalImages = allImagePaths.length;
    let cachedImageCount = 0;
    for (const path of allImagePaths) {
      if (runtimeReadyPaths.has(path) || existingCacheByPath.has(path)) {
        cachedImageCount += 1;
      }
    }
    setPreviewLoadingProgress(cachedImageCount, totalImages);
    if (totalMissing > 0 && totalImages > 0) {
      void (async () => {
        let completed = 0;
        if (firstPhase.length > 0) {
          await fillImagePreviewsProgressively(cardsByPath, firstPhase, requestId, {
            batchSize: ACTIVE_PREVIEW_BATCH_SIZE,
            existingCacheByPath,
            onProgress: (chunkDone) => setPreviewLoadingProgress(cachedImageCount + completed + chunkDone, totalImages),
          });
          completed += firstPhase.length;
        }
        if (requestId !== activeRequestId) return;
        if (restMissing.length > 0) {
          await fillImagePreviewsProgressively(cardsByPath, restMissing, requestId, {
            batchSize: ACTIVE_PREVIEW_BATCH_SIZE,
            existingCacheByPath,
            onProgress: (chunkDone) => setPreviewLoadingProgress(cachedImageCount + completed + chunkDone, totalImages),
          });
          completed += restMissing.length;
        }
        if (requestId !== activeRequestId) return;
        setPreviewLoadingProgress(cachedImageCount + completed, totalImages);
      })();
    } else if (totalImages < 1) {
      setPreviewLoadingProgress(0, 0);
    }
  }

  return {
    clear: clearPanel,
    setContext,
    setPatientOverview: setPatientOverviewContext,
    clearSelection: () => clearExplorerSelection(),
    getSelection: () => (selectedExplorerItem ? { ...selectedExplorerItem } : null),
    isActiveTreatmentContext: ({ workspaceDir = "", patientFolder = "", treatmentFolder = "" } = {}) => (
      getContextKey(workspaceDir, patientFolder, treatmentFolder) === activeContextKey &&
      !panel.hidden
    ),
    clearOptimisticImportForContext: ({ workspaceDir = "", patientFolder = "", treatmentFolder = "" } = {}) => {
      const key = getContextKey(workspaceDir, patientFolder, treatmentFolder);
      if (!key) return;
      optimisticImportPlaceholdersByContext.delete(key);
      if (key !== activeContextKey) return;
      optimisticPlaceholderCards.forEach((card) => card.remove());
      optimisticPlaceholderCards = [];
      optimisticPreviewRevealedPaths.clear();
      syncActiveCountsUi();
    },
    hasActiveOptimisticImport: () => {
      if (!activeContextKey) return false;
      return optimisticImportPlaceholdersByContext.has(activeContextKey);
    },
    invalidateRuntimePreviewCache: () => {
      runtimePreviewByPath.clear();
    },
    refreshActiveContext: async () => {
      if (!activeContext?.workspaceDir || !activeContext?.patientFolder) return;
      if (activeContext?.treatmentFolder && optimisticImportPlaceholdersByContext.has(activeContextKey) && activeCardsByPath.size > 0) {
        return;
      }
      if (activeContext?.treatmentFolder) {
        await setContext(activeContext);
        return;
      }
      await setPatientOverviewContext(activeContext);
    },
    setOptimisticImportPlaceholders,
  };
}
