import { getCurrentWindow } from "@tauri-apps/api/window";
import { TauriEvent } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { createMainHeaderTimeline } from "./main-content-header";
import { createImportPanel } from "./main-content-import";
import { createTreatmentFilesPanel } from "./main-content-treatment-files";

export function initMainContent({
  appView,
  onDropOverlayWillShow,
  resolveImportContext,
  onImportActivityChange,
  onImportDebugStateChange,
  onPreviewLoadingStatusChange,
  onPatientKeywordsChanged,
  onCheckMissingPatientIdTaken,
  onSubmitMissingPatientId,
}) {
  const mainCanvas = appView?.querySelector(".main-canvas") ?? null;
  if (!mainCanvas) {
    return {
      mainCanvas: null,
      setSelectedPatientHeader: () => {},
      clearSelectedPatientHeader: () => {},
      refreshTimelineForSelection: async () => {},
    };
  }

  const {
    timeline,
    patientLabel,
    patientNameRow,
    patientLast,
    patientFirst,
    patientIdLine,
    patientIdInput,
    timelineScroll,
    timelinePrefixLine,
    timelineTrack,
    timelineLine,
  } = createMainHeaderTimeline(mainCanvas);

  const dropOverlay = document.createElement("div");
  dropOverlay.className = "main-drop-overlay";
  dropOverlay.hidden = true;
  dropOverlay.innerHTML = `
    <div class="main-drop-overlay-frame" aria-hidden="true">
      <div class="main-drop-overlay-plus">+</div>
      <div class="main-drop-overlay-text">Drop files for import</div>
    </div>
  `;
  mainCanvas.appendChild(dropOverlay);

  const headerFrost = document.createElement("div");
  headerFrost.className = "main-header-frost";
  headerFrost.setAttribute("aria-hidden", "true");
  mainCanvas.appendChild(headerFrost);

  const contentScrollLayer = document.createElement("div");
  contentScrollLayer.className = "main-content-scroll-layer";
  mainCanvas.appendChild(contentScrollLayer);

  const {
    importPanel,
    importExistingSection,
    importExistingFolderLabel,
    importExistingFolderIcon,
    importExistingFolderText,
    importDateLabel,
    importDate,
    importTreatmentName,
    importDeleteOrigin,
    importFilesToggle,
    importFilesCountText,
    importFilesListWrap,
    importFilesScrollUp,
    importFilesScrollDown,
    importFilesList,
    importCancelBtn,
    importStartBtn,
  } = createImportPanel(contentScrollLayer);
  const treatmentFilesPanel = createTreatmentFilesPanel({
    container: contentScrollLayer,
    onOpenPath: async (openRequest) => {
      const path = typeof openRequest === "string"
        ? String(openRequest ?? "").trim()
        : String(openRequest?.path ?? "").trim();
      if (!path) return;

      const isImage = typeof openRequest === "object"
        ? Boolean(openRequest?.isImage ?? openRequest?.is_image ?? false)
        : false;
      if (!isImage) {
        await invoke("open_path_with_default", { path });
        return;
      }

      const workspaceDir = String(openRequest?.workspaceDir ?? "").trim();
      const patientFolder = String(openRequest?.patientFolder ?? "").trim();
      const treatmentFolder = String(openRequest?.treatmentFolder ?? "").trim();
      const scope = String(openRequest?.scope ?? "").trim();
      let navigationPaths = Array.isArray(openRequest?.navigationPaths)
        ? openRequest.navigationPaths.map((entry) => String(entry ?? "").trim()).filter(Boolean)
        : [];

      try {
        if (scope === "treatment" && workspaceDir && patientFolder && treatmentFolder) {
          const rows = await invoke("list_treatment_image_paths", {
            workspaceDir,
            patientFolder,
            treatmentFolder,
          });
          const normalized = Array.isArray(rows)
            ? rows.map((entry) => String(entry ?? "").trim()).filter(Boolean)
            : [];
          if (normalized.length > 0) navigationPaths = normalized;
        } else if (scope === "patient_root" && workspaceDir && patientFolder) {
          const rows = await invoke("list_patient_root_image_paths", {
            workspaceDir,
            patientFolder,
          });
          const normalized = Array.isArray(rows)
            ? rows.map((entry) => String(entry ?? "").trim()).filter(Boolean)
            : [];
          if (normalized.length > 0) navigationPaths = normalized;
        }
      } catch (err) {
        console.error("loading image preview navigation paths failed:", err);
      }

      if (!navigationPaths.includes(path)) {
        navigationPaths.unshift(path);
      }

      try {
        await invoke("open_image_preview_window", {
          path,
          navigationPaths,
        });
      } catch (err) {
        console.error("open_image_preview_window failed, fallback to default opener:", err);
        await invoke("open_path_with_default", { path });
      }
    },
    onOpenTreatmentFolder: (folderName) => {
      const target = String(folderName ?? "").trim();
      if (!target) return;
      const points = Array.from(timelineTrack?.querySelectorAll(".main-timeline-point") ?? []);
      const point = points.find((el) => String(el?.dataset?.folderName ?? "").trim() === target) ?? null;
      if (!point) return;
      setSelectedTimelinePoint(point);
      ensureTimelinePointVisible(point);
      positionImportProgressCapsules();
    },
    onPreviewLoadingStatusChange: (status) => {
      if (typeof onPreviewLoadingStatusChange === "function") {
        onPreviewLoadingStatusChange(status);
      }
    },
    onPatientKeywordsChanged: (payload) => {
      if (typeof onPatientKeywordsChanged === "function") {
        onPatientKeywordsChanged(payload);
      }
    },
  });

  const emptyState = document.createElement("div");
  emptyState.className = "main-empty-state";
  emptyState.innerHTML = `
    <div class="main-empty-inner">
    <svg width="200" height="200" viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg" class="doctor-svg sleeping" id="doctorSvg">
      <rect x="20" y="154" width="160" height="6" rx="2" fill="#4b2c20" />

      <path d="M60,150 L140,150 L130,120 Q100,110 70,120 Z" fill="#ffffff" stroke="#cbd5e1" stroke-width="1" />
      <path d="M90,120 L100,150 L110,120" fill="none" stroke="#cbd5e1" stroke-width="1" />
      <path d="M80,120 Q80,145 100,145 Q120,145 120,120" fill="none" stroke="#475569" stroke-width="2" />
      <circle cx="100" cy="145" r="5" fill="#94a3b8" stroke="#475569" stroke-width="1" />

      <g transform="rotate(-10, 100, 100)">
        <circle cx="100" cy="95" r="30" fill="#ffdbac" />
        <path d="M70,95 A30,30 0 0,1 130,95 L130,85 Q100,70 70,85 Z" fill="#4b2c20" />

        <g>
          <path class="eye-closed" d="M85,100 Q90,105 95,100" stroke="#8d5524" fill="none" stroke-width="2" />
          <g class="eye-open">
            <circle cx="90" cy="100" r="5" fill="white" />
            <circle id="pupil-l" cx="90" cy="100" r="2.5" fill="#1e293b" />
          </g>
        </g>
        <g>
          <path class="eye-closed" d="M105,100 Q110,105 115,100" stroke="#8d5524" fill="none" stroke-width="2" />
          <g class="eye-open">
            <circle cx="110" cy="100" r="5" fill="white" />
            <circle id="pupil-r" cx="110" cy="100" r="2.5" fill="#1e293b" />
          </g>
        </g>
      </g>

      <g id="zs" font-family="Arial" font-weight="bold" fill="#64748b">
        <text x="135" y="70" font-size="18" class="z z1">Z</text>
        <text x="145" y="55" font-size="14" class="z z2">z</text>
        <text x="155" y="45" font-size="10" class="z z3">z</text>
      </g>
    </svg>
      <div class="main-empty-label">No patient selected</div>
    </div>
  `;
  mainCanvas.appendChild(emptyState);

  const idleCursorDot = document.createElement("div");
  idleCursorDot.className = "idle-cursor-dot";
  idleCursorDot.hidden = true;
  mainCanvas.appendChild(idleCursorDot);

  const doctorSvg = emptyState.querySelector("#doctorSvg");
  const pupilL = emptyState.querySelector("#pupil-l");
  const pupilR = emptyState.querySelector("#pupil-r");
  const patientSidebarEl = appView?.querySelector(".patient-sidebar") ?? null;
  const settingsPanelEl = appView?.querySelector("#settingsPanel") ?? null;

  let sleepTimer = null;
  let dragDepth = 0;
  let dragHideTimerId = null;
  let internalDragInProgress = false;
  let hasPatientSelection = false;
  let lastDroppedPaths = [];
  let idleDotBaseX = 0;
  let idleDotBaseY = 0;
  let idleDotJitterRafId = null;
  let timelineRequestId = 0;
  let timelineHoverScrollRafId = null;
  let selectedTimelineKey = "";
  let selectedTimelinePoint = null;
  let timelineSelectionOwner = "";
  let isImportFilesListExpanded = false;
  let importImagePreviewByPath = new Map();
  let importPreviewRequestId = 0;
  let importDeleteOriginPreference = false;
  const IMPORT_PREVIEW_MAX_ITEMS = 160;
  const IMPORT_PREVIEW_CONCURRENCY = 4;
  const importJobs = new Map();
  const bufferedImportProgressByJobId = new Map();
  let importLiveRefreshTimerId = null;
  let importLiveRefreshPending = false;
  let missingPatientIdTaken = false;
  let missingPatientIdChecking = false;
  let missingPatientIdCheckToken = 0;
  let timelineFolderDragHoldTimerId = null;
  let timelineFolderDragArmedPoint = null;
  let timelineFolderDragSourcePoint = null;
  let timelineFolderDragSourceExport = null;
  let timelinePanPointerId = null;
  let timelinePanStartX = 0;
  let timelinePanStartScrollLeft = 0;
  let timelinePanMoved = false;
  let timelinePanSuppressClickUntil = 0;
  let timelineWheelTargetScrollLeft = null;
  let timelineWheelRafId = null;

  const TIMELINE_FOLDER_DRAG_HOLD_MS = 420;
  const TIMELINE_FOLDER_DRAG_MOVE_CANCEL_PX = 12;
  const drawRoundRect = (ctx, x, y, w, h, r) => {
    if (typeof ctx.roundRect === "function") {
      ctx.roundRect(x, y, w, h, r);
      return;
    }
    const radius = Math.max(0, Math.min(r, Math.min(w, h) / 2));
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
  const timelineFolderDragGhost = document.createElement("canvas");
  timelineFolderDragGhost.className = "timeline-folder-drag-ghost";
  timelineFolderDragGhost.setAttribute("aria-hidden", "true");
  timelineFolderDragGhost.width = 33;
  timelineFolderDragGhost.height = 30;
  {
    const ctx = timelineFolderDragGhost.getContext("2d");
    if (ctx) {
      ctx.clearRect(0, 0, 33, 30);
      ctx.shadowColor = "rgba(249,115,22,0.55)";
      ctx.shadowBlur = 7;
      ctx.fillStyle = "#f97316";
      ctx.beginPath();
      drawRoundRect(ctx, 4, 9, 25, 18, 4);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.fillStyle = "#f97316";
      ctx.beginPath();
      drawRoundRect(ctx, 18, 6, 10, 4, 2);
      ctx.fill();
    }
  }
  mainCanvas.appendChild(timelineFolderDragGhost);

  function normalizeFieldValue(value) {
    return (value ?? "").trim();
  }

  function normalizeFsPath(path = "") {
    return String(path ?? "").replace(/\\/g, "/");
  }

  function fsPathToFileUri(path = "") {
    const normalized = normalizeFsPath(path);
    if (!normalized) return "";
    const withPrefix = normalized.startsWith("/") ? normalized : `/${normalized}`;
    return `file://${encodeURI(withPrefix)}`;
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

  function isNumericPatientId(value) {
    return /^\d+$/.test(value);
  }

  function resetPatientIdInputState() {
    missingPatientIdCheckToken += 1;
    missingPatientIdTaken = false;
    missingPatientIdChecking = false;
    patientIdInput.hidden = true;
    patientIdInput.value = "";
    patientIdInput.classList.remove("invalid-id");
    patientIdInput.classList.remove("duplicate-id");
    patientIdInput.disabled = false;
  }

  function showMissingPatientIdPrompt() {
    patientIdLine.textContent = "Add ID...";
    patientIdLine.classList.add("missing-id");
    patientIdLine.hidden = false;
    resetPatientIdInputState();
  }

  function showPatientIdValue(idValue) {
    patientIdLine.textContent = idValue;
    patientIdLine.classList.remove("missing-id");
    patientIdLine.hidden = false;
    resetPatientIdInputState();
  }

  function openMissingPatientIdInput() {
    if (patientLabel.hidden) return;
    if (!patientIdLine.classList.contains("missing-id")) return;
    patientIdLine.hidden = true;
    patientIdInput.hidden = false;
    patientIdInput.value = "";
    patientIdInput.classList.remove("invalid-id");
    patientIdInput.classList.remove("duplicate-id");
    patientIdInput.disabled = false;
    requestAnimationFrame(() => {
      patientIdInput.focus();
    });
  }

  async function checkMissingPatientIdUniqueness() {
    const token = ++missingPatientIdCheckToken;
    const normalizedId = normalizeFieldValue(patientIdInput?.value);
    missingPatientIdTaken = false;
    missingPatientIdChecking = false;
    patientIdInput?.classList.remove("duplicate-id");

    if (!normalizedId || !isNumericPatientId(normalizedId)) {
      return;
    }
    if (typeof onCheckMissingPatientIdTaken !== "function") {
      return;
    }

    missingPatientIdChecking = true;
    try {
      const taken = await onCheckMissingPatientIdTaken(normalizedId);
      if (token !== missingPatientIdCheckToken) return;
      missingPatientIdTaken = Boolean(taken);
      patientIdInput?.classList.toggle("duplicate-id", missingPatientIdTaken);
    } catch (err) {
      if (token !== missingPatientIdCheckToken) return;
      console.error("check missing patient id uniqueness failed:", err);
      missingPatientIdTaken = false;
      patientIdInput?.classList.remove("duplicate-id");
    } finally {
      if (token === missingPatientIdCheckToken) {
        missingPatientIdChecking = false;
      }
    }
  }

  function createImportProgressCapsule() {
    const capsule = document.createElement("div");
    capsule.className = "import-progress-capsule";
    capsule.hidden = true;
    capsule.innerHTML = `
      <svg class="import-progress-ring" viewBox="0 0 36 36" aria-hidden="true">
        <circle class="import-progress-track" cx="18" cy="18" r="16"></circle>
        <circle class="import-progress-value" cx="18" cy="18" r="16"></circle>
      </svg>
      <span class="import-progress-text">0</span>
    `;
    mainCanvas.appendChild(capsule);
    return capsule;
  }

  function updateImportProgressCapsule(capsule, percent = 0) {
    if (!capsule) return;
    const safePercent = Math.max(0, Math.min(100, Number(percent) || 0));
    const textEl = capsule.querySelector(".import-progress-text");
    const valueCircle = capsule.querySelector(".import-progress-value");
    if (textEl) textEl.textContent = `${Math.round(safePercent)}`;
    if (valueCircle) {
      const circumference = 2 * Math.PI * 16;
      const offset = circumference * (1 - safePercent / 100);
      valueCircle.style.strokeDasharray = `${circumference}`;
      valueCircle.style.strokeDashoffset = `${offset}`;
    }
  }

  function updateImportProgressActiveClass() {
    const hasActive = Array.from(importJobs.values()).some((job) => !job.done);
    mainCanvas.classList.toggle("import-progress-active", hasActive);
    if (typeof onImportDebugStateChange === "function") {
      onImportDebugStateChange(hasActive ? `importing (${importJobs.size} job${importJobs.size === 1 ? "" : "s"})` : "ready");
    }
  }

  function scheduleImportLiveRefresh() {
    if (importLiveRefreshPending) return;
    importLiveRefreshPending = true;
    if (importLiveRefreshTimerId !== null) {
      clearTimeout(importLiveRefreshTimerId);
      importLiveRefreshTimerId = null;
    }
    importLiveRefreshTimerId = setTimeout(() => {
      importLiveRefreshTimerId = null;
      importLiveRefreshPending = false;
      void refreshTimeline();
    }, 700);
  }

  function setTimelineVisible(visible) {
    timeline.hidden = !visible;
    mainCanvas.classList.toggle("main-no-timeline", !visible);
    if (!visible) {
      positionImportProgressCapsules();
    }
  }

  function hasFiles(event) {
    const dt = event?.dataTransfer;
    if (!dt) return false;

    if (dt.items && Array.from(dt.items).some((item) => item.kind === "file")) {
      return true;
    }

    const types = Array.from(dt.types ?? []);
    return (
      types.includes("Files") ||
      types.includes("public.file-url") ||
      types.includes("application/x-moz-file")
    );
  }

  function normalizeFsPathForCompare(path = "") {
    const normalized = normalizeFsPath(String(path ?? "").trim());
    return normalized.replace(/\/+$/, "");
  }

  function getParentFsPath(path = "") {
    const normalized = normalizeFsPathForCompare(path);
    const idx = normalized.lastIndexOf("/");
    if (idx <= 0) return "";
    return normalized.slice(0, idx);
  }

  function showDropOverlay() {
    if (!hasPatientSelection) return;
    if (dragHideTimerId) {
      clearTimeout(dragHideTimerId);
      dragHideTimerId = null;
    }
    if (dropOverlay.hidden && typeof onDropOverlayWillShow === "function") {
      onDropOverlayWillShow();
    }
    dropOverlay.hidden = false;
  }

  function hideDropOverlay() {
    if (dragHideTimerId) {
      clearTimeout(dragHideTimerId);
      dragHideTimerId = null;
    }
    dropOverlay.hidden = true;
  }

  function setImportPanelVisible(visible) {
    importPanel.hidden = !visible;
    mainCanvas.classList.toggle("import-setup-open", visible);
    if (!visible) {
      lastDroppedPaths = [];
      importImagePreviewByPath = new Map();
      isImportFilesListExpanded = false;
      importFilesToggle?.classList.remove("expanded");
      importFilesToggle?.setAttribute("aria-expanded", "false");
      importFilesListWrap?.classList.remove("expanded");
      contentScrollLayer.scrollTop = 0;
      mainCanvas.classList.remove("main-header-frost-visible");
      return;
    }
    if (importDeleteOrigin) {
      importDeleteOrigin.checked = Boolean(importDeleteOriginPreference);
    }
    treatmentFilesPanel.clear();
    contentScrollLayer.scrollTop = 0;
    mainCanvas.classList.remove("main-header-frost-visible");
  }

  function syncHeaderFrostVisibility() {
    mainCanvas.classList.toggle("main-header-frost-visible", contentScrollLayer.scrollTop > 0);
  }

  function positionImportProgressCapsules() {
    const context = typeof resolveImportContext === "function" ? resolveImportContext() : null;
    const points = Array.from(timelineTrack?.querySelectorAll(".main-timeline-point") ?? []);
    const groups = new Map();

    for (const job of importJobs.values()) {
      const sameContext =
        context?.workspaceDir === job.workspaceDir &&
        context?.patientFolder === job.patientFolder;
      if (!sameContext) {
        job.capsule.hidden = true;
        job.capsule.classList.remove("visible");
        continue;
      }

      const groupKey = `${job.workspaceDir}::${job.patientFolder}::${job.targetFolder}`;
      if (!groups.has(groupKey)) groups.set(groupKey, []);
      groups.get(groupKey).push(job);
    }

    for (const groupJobs of groups.values()) {
      if (!Array.isArray(groupJobs) || groupJobs.length < 1) continue;
      groupJobs.sort((a, b) => a.id - b.id);
      const leadJob = groupJobs[0];
      const combinedProgress =
        groupJobs.reduce((sum, j) => sum + (Number(j.progressValue) || 0), 0) / groupJobs.length;

      let targetDot = null;
      let targetPoint = null;
      for (const point of points) {
        if (point?.dataset?.timelineKey === leadJob.targetFolder) {
          targetPoint = point;
          targetDot = point.querySelector(".main-timeline-dot");
          break;
        }
      }

      if (!targetDot) {
        for (const job of groupJobs) {
          job.capsule.hidden = true;
          job.capsule.classList.remove("visible");
        }
        continue;
      }

      updateImportProgressCapsule(leadJob.capsule, combinedProgress);
      if (targetPoint && leadJob.capsule.parentElement !== targetPoint) {
        targetPoint.appendChild(leadJob.capsule);
      }
      leadJob.capsule.hidden = false;
      leadJob.capsule.classList.add("visible");
      leadJob.capsule.classList.toggle(
        "on-selected-dot",
        Boolean(targetPoint?.classList?.contains("selected"))
      );
      leadJob.capsule.style.left = "50%";
      leadJob.capsule.style.top = "5px";

      for (let i = 1; i < groupJobs.length; i += 1) {
        const job = groupJobs[i];
        job.capsule.hidden = true;
        job.capsule.classList.remove("visible");
      }
    }
  }

  function trackNewImportJob({ jobId, targetFolder, workspaceDir, patientFolder }) {
    const id = Number(jobId) || null;
    if (!id) return;
    if (importJobs.has(id)) return;

    const capsule = createImportProgressCapsule();
    const job = {
      id,
      targetFolder: String(targetFolder ?? "").trim(),
      workspaceDir: String(workspaceDir ?? "").trim(),
      patientFolder: String(patientFolder ?? "").trim(),
      capsule,
      progressValue: 1,
      shownAt: Date.now(),
      done: false,
      released: false,
      finalizeTimerId: null,
      animationRafId: null,
    };
    importJobs.set(id, job);
    updateImportProgressCapsule(capsule, 1);
    updateImportProgressActiveClass();
    if (typeof onImportDebugStateChange === "function") {
      onImportDebugStateChange(`import started (#${id})`);
    }

    const buffered = bufferedImportProgressByJobId.get(id);
    if (buffered) {
      applyImportProgressEventForJob(job, buffered);
      bufferedImportProgressByJobId.delete(id);
    }

    requestAnimationFrame(positionImportProgressCapsules);
  }

  function applyImportProgressEventForJob(job, { percent = 0, done = false, error = "" } = {}) {
    if (!job) return;

    job.progressValue = Math.max(0, Math.min(100, Number(percent) || 0));
    updateImportProgressCapsule(job.capsule, job.progressValue);
    positionImportProgressCapsules();
    if (typeof onImportDebugStateChange === "function") {
      onImportDebugStateChange(`import #${job.id}: ${Math.round(job.progressValue)}%`);
    }

    if (!done) {
      const selectedFolder = getSelectedTimelineFolderName().trim();
      if (selectedFolder && selectedFolder === job.targetFolder) {
        scheduleImportLiveRefresh();
      }
      return;
    }
    if (job.done) return;

    job.done = true;
    const elapsed = Date.now() - job.shownAt;
    const minVisibleMs = 1500;
    const waitMs = Math.max(0, minVisibleMs - elapsed);
    if (waitMs > 0) {
      job.capsule.classList.add("holding");
      updateImportProgressCapsule(job.capsule, Math.max(1, job.progressValue));
    }
    if (job.finalizeTimerId !== null) clearTimeout(job.finalizeTimerId);
    animateJobProgressTo100(job, waitMs, () => {
      if (error) {
        console.error("import failed:", error);
        if (typeof onImportDebugStateChange === "function") {
          onImportDebugStateChange(`error: import #${job.id}`);
        }
      } else {
        void refreshTimeline();
      }
      releaseImportJob(job);
      importStartBtn.disabled = false;
      importCancelBtn.disabled = false;
    });
  }

  function animateJobProgressTo100(job, durationMs, onDone) {
    if (!job) return;
    if (job.animationRafId !== null) {
      cancelAnimationFrame(job.animationRafId);
      job.animationRafId = null;
    }

    const startPercent = Math.max(1, Math.min(99, job.progressValue));
    if (durationMs <= 0) {
      job.progressValue = 100;
      updateImportProgressCapsule(job.capsule, 100);
      if (typeof onDone === "function") onDone();
      return;
    }

    const startTs = performance.now();
    const tick = (now) => {
      const elapsed = now - startTs;
      const t = Math.min(1, elapsed / durationMs);
      const next = startPercent + (100 - startPercent) * t;
      job.progressValue = next;
      updateImportProgressCapsule(job.capsule, next);
      if (t < 1) {
        job.animationRafId = requestAnimationFrame(tick);
        return;
      }
      job.animationRafId = null;
      if (typeof onDone === "function") onDone();
    };
    job.animationRafId = requestAnimationFrame(tick);
  }

  function releaseImportJob(job) {
    if (!job || job.released) return;
    job.released = true;
    if (job.finalizeTimerId !== null) clearTimeout(job.finalizeTimerId);
    if (job.animationRafId !== null) cancelAnimationFrame(job.animationRafId);
    if (typeof onImportActivityChange === "function" && job.patientFolder) {
      onImportActivityChange({ patientFolder: job.patientFolder, active: false });
    }
    job.capsule.classList.remove("holding");
    job.capsule.classList.remove("visible");
    job.capsule.classList.add("done");
    setTimeout(() => {
      job.capsule.remove();
    }, 250);
    importJobs.delete(job.id);
    updateImportProgressActiveClass();
    if (typeof onImportDebugStateChange === "function") {
      onImportDebugStateChange(`import finished (#${job.id})`);
    }
    requestAnimationFrame(positionImportProgressCapsules);
  }

  function extractFileName(pathLike = "") {
    const normalized = String(pathLike ?? "").trim();
    if (!normalized) return "";
    const parts = normalized.split(/[\\/]/);
    return parts[parts.length - 1] || normalized;
  }

  function isPreviewImagePath(pathLike = "") {
    return /\.(jpe?g|png)$/i.test(String(pathLike ?? "").trim());
  }

  function applyPreviewToElement(previewEl, normalizedPath, previewInfo) {
    if (!previewEl) return;
    previewEl.className = "main-import-files-item-preview";
    previewEl.innerHTML = "";

    const kind = previewInfo?.kind ?? "none";
    if (kind === "loading") {
      previewEl.classList.add("loading");
      return;
    }

    const dataUrl = previewInfo?.dataUrl ?? "";
    if (isPreviewImagePath(normalizedPath) && dataUrl) {
      const img = document.createElement("img");
      img.className = "main-import-files-item-preview-img";
      img.alt = "";
      img.loading = "lazy";
      img.decoding = "async";
      img.src = dataUrl;
      previewEl.appendChild(img);
    }
  }

  function updateImportPreviewRow(path) {
    if (!importFilesList) return;
    const targetPath = String(path ?? "").trim();
    if (!targetPath) return;
    for (const item of importFilesList.children) {
      if (!(item instanceof HTMLElement)) continue;
      if (item.dataset.filePath !== targetPath) continue;
      const previewEl = item.querySelector(".main-import-files-item-preview");
      const info = importImagePreviewByPath.get(targetPath) ?? { kind: "none", dataUrl: "" };
      applyPreviewToElement(previewEl, targetPath, info);
      break;
    }
  }

  async function refreshImportImagePreviewKinds(paths = []) {
    const reqId = ++importPreviewRequestId;
    const normalizedPaths = Array.isArray(paths)
      ? paths.map((p) => String(p ?? "").trim()).filter(Boolean)
      : [];
    const nextPreviews = new Map();
    for (const p of normalizedPaths) {
      const prev = importImagePreviewByPath.get(p);
      nextPreviews.set(
        p,
        prev && typeof prev.kind === "string"
          ? prev
          : { kind: "none", dataUrl: "" }
      );
    }
    importImagePreviewByPath = nextPreviews;
    updateImportFilesUi();

    const imagePaths = normalizedPaths.filter(isPreviewImagePath).slice(0, IMPORT_PREVIEW_MAX_ITEMS);
    const unresolved = imagePaths.filter((p) => {
      const current = nextPreviews.get(p);
      return !current || current.kind === "none" || current.kind === "loading";
    });
    for (const p of unresolved) {
      nextPreviews.set(p, { kind: "loading", dataUrl: "" });
    }
    importImagePreviewByPath = nextPreviews;
    updateImportFilesUi();

    const queue = [...unresolved];
    const workerCount = Math.min(IMPORT_PREVIEW_CONCURRENCY, queue.length);
    const workers = Array.from({ length: workerCount }, async () => {
      while (queue.length > 0) {
        if (reqId !== importPreviewRequestId) return;
        const path = queue.shift();
        if (!path) continue;
        try {
          const rows = await invoke("get_image_previews", { paths: [path] });
          if (reqId !== importPreviewRequestId) return;
          const row = Array.isArray(rows) ? rows[0] : null;
          const outPath = String(row?.path ?? path).trim();
          const kind = String(row?.kind ?? "").trim().toLowerCase();
          const dataUrl = String(row?.data_url ?? row?.dataUrl ?? "").trim();
          if (nextPreviews.has(outPath)) {
            if (kind === "portrait" || kind === "landscape" || kind === "square" || kind === "other") {
              nextPreviews.set(outPath, { kind, dataUrl });
            } else {
              nextPreviews.set(outPath, { kind: "none", dataUrl: "" });
            }
          }
        } catch (err) {
          console.error("get_image_previews failed:", err);
          nextPreviews.set(path, { kind: "other", dataUrl: "" });
        }
        importImagePreviewByPath = nextPreviews;
        updateImportPreviewRow(path);
      }
    });
    await Promise.all(workers);

    if (reqId !== importPreviewRequestId) return;
    importImagePreviewByPath = nextPreviews;
    updateImportFilesUi();
  }

  function updateImportFilesUi() {
    const count = lastDroppedPaths.length;
    if (importFilesCountText) {
      importFilesCountText.textContent = `${count} ${count === 1 ? "File" : "Files"}`;
    }
    if (importFilesList) {
      importFilesList.innerHTML = "";
      for (const [index, p] of lastDroppedPaths.entries()) {
        const li = document.createElement("li");
        li.className = "main-import-files-item";

        const normalizedPath = String(p ?? "").trim();
        li.dataset.filePath = normalizedPath;
        const preview = document.createElement("span");
        const previewInfo = importImagePreviewByPath.get(normalizedPath) ?? { kind: "none", dataUrl: "" };
        applyPreviewToElement(preview, normalizedPath, previewInfo);
        li.appendChild(preview);

        const name = document.createElement("span");
        name.className = "main-import-files-item-name";
        name.textContent = extractFileName(p) || String(p);
        li.appendChild(name);

        const removeBtn = document.createElement("button");
        removeBtn.type = "button";
        removeBtn.className = "main-import-files-item-remove";
        removeBtn.setAttribute("aria-label", "Remove file");
        removeBtn.innerHTML = `
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M7 7L17 17" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>
            <path d="M17 7L7 17" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>
          </svg>
        `;
        removeBtn.addEventListener("click", () => {
          lastDroppedPaths.splice(index, 1);
          if (lastDroppedPaths.length < 1) {
            isImportFilesListExpanded = false;
          }
          updateImportFilesUi();
        });
        li.appendChild(removeBtn);

        importFilesList.appendChild(li);
      }
    }
    const expanded = isImportFilesListExpanded && count > 0;
    importFilesListWrap?.classList.toggle("expanded", expanded);
    importFilesToggle?.classList.toggle("expanded", expanded);
    importFilesToggle?.setAttribute("aria-expanded", expanded ? "true" : "false");
    if (importFilesToggle) importFilesToggle.disabled = count < 1;
    requestAnimationFrame(updateImportFilesOverflowIndicators);
  }

  function updateImportFilesOverflowIndicators() {
    if (!importFilesListWrap || !importFilesScrollUp || !importFilesScrollDown) return;
    const expanded = importFilesListWrap.classList.contains("expanded");
    if (!expanded) {
      importFilesScrollUp.classList.remove("visible");
      importFilesScrollDown.classList.remove("visible");
      return;
    }

    const maxScrollTop = Math.max(0, importFilesListWrap.scrollHeight - importFilesListWrap.clientHeight);
    const canScroll = maxScrollTop > 1;
    const scrollTop = importFilesListWrap.scrollTop;

    importFilesScrollUp.classList.toggle("visible", canScroll && scrollTop > 1);
    importFilesScrollDown.classList.toggle("visible", canScroll && scrollTop < maxScrollTop - 1);
  }

  function animateImportFilesListScrollTo(targetTop, durationMs = 600) {
    if (!importFilesListWrap) return;
    const startTop = importFilesListWrap.scrollTop;
    const maxTop = Math.max(0, importFilesListWrap.scrollHeight - importFilesListWrap.clientHeight);
    const clampedTarget = Math.max(0, Math.min(maxTop, targetTop));
    const delta = clampedTarget - startTop;
    if (Math.abs(delta) < 1) {
      importFilesListWrap.scrollTop = clampedTarget;
      return;
    }

    const startedAt = performance.now();
    const easeInOutCubic = (t) =>
      t < 0.5 ? 4 * t * t * t : 1 - ((-2 * t + 2) ** 3) / 2;

    const tick = (now) => {
      const elapsed = now - startedAt;
      const t = Math.min(1, elapsed / durationMs);
      importFilesListWrap.scrollTop = startTop + delta * easeInOutCubic(t);
      if (t < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  function setIdleCursorDotVisible(visible) {
    idleCursorDot.hidden = !visible;
    if (!visible) {
      idleCursorDot.style.transform = "";
      if (idleDotJitterRafId !== null) {
        cancelAnimationFrame(idleDotJitterRafId);
        idleDotJitterRafId = null;
      }
      return;
    }

    if (idleDotJitterRafId === null) {
      const animateIdleDot = () => {
        if (hasPatientSelection || idleCursorDot.hidden) {
          idleDotJitterRafId = null;
          idleCursorDot.style.transform = "";
          return;
        }
        const t = performance.now() / 1000;
        const jx = Math.sin(t * 32) * 6.4 + Math.cos(t * 47) * 2.8;
        const jy = Math.cos(t * 29) * 6.0 + Math.sin(t * 43) * 2.6;
        idleCursorDot.style.transform = `translate(${jx}px, ${jy}px)`;
        idleDotJitterRafId = requestAnimationFrame(animateIdleDot);
      };
      idleDotJitterRafId = requestAnimationFrame(animateIdleDot);
    }
  }

  function isPointInsideElement(el, x, y) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  }

  function todayIsoDate() {
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }

  function isoDateFromMs(ms) {
    const n = Number(ms);
    if (!Number.isFinite(n) || n <= 0) return "";
    const d = new Date(n);
    if (Number.isNaN(d.getTime())) return "";
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }

  async function resolveImportDateForPaths(paths = []) {
    const normalizedPaths = Array.isArray(paths)
      ? paths.map((p) => String(p ?? "").trim()).filter(Boolean)
      : [];
    if (normalizedPaths.length < 1) return todayIsoDate();

    try {
      const createdMsList = await invoke("get_import_files_created_ms", {
        paths: normalizedPaths,
      });
      const rows = Array.isArray(createdMsList) ? createdMsList : [];
      if (rows.length !== normalizedPaths.length) return todayIsoDate();

      const uniqueDates = new Set();
      for (const value of rows) {
        const day = isoDateFromMs(value);
        if (!day) return todayIsoDate();
        uniqueDates.add(day);
        if (uniqueDates.size > 1) return todayIsoDate();
      }
      const [singleDate] = uniqueDates;
      return singleDate || todayIsoDate();
    } catch (err) {
      console.error("get_import_files_created_ms failed:", err);
      return todayIsoDate();
    }
  }

  function extractFolderDate(folderName) {
    const match = /^\d{4}-\d{2}-\d{2}/.exec(folderName ?? "");
    return match?.[0] ?? "";
  }

  function extractFolderTreatment(folderName) {
    return (folderName ?? "").replace(/^\d{4}-\d{2}-\d{2}\s*/, "").trim();
  }

  function hasInvalidTreatmentFolderName(value = "") {
    return /[\\/]/.test(String(value ?? "").trim());
  }

  function buildTimelinePoint({ date = "", treatment = "", timelineKey = "", folderName = "" } = {}) {
    const point = document.createElement("div");
    point.className = "main-timeline-point";
    if (timelineKey) point.dataset.timelineKey = timelineKey;
    if (folderName) point.dataset.folderName = folderName;

    const dot = document.createElement("div");
    dot.className = "main-timeline-dot";
    point.appendChild(dot);

    const label = document.createElement("div");
    label.className = "main-timeline-date";
    label.textContent = date;
    point.appendChild(label);

    const treatmentEl = document.createElement("div");
    treatmentEl.className = "main-timeline-treatment";
    treatmentEl.textContent = treatment;
    point.appendChild(treatmentEl);
    return point;
  }

  function getSelectedTimelineFolderName() {
    return selectedTimelinePoint?.dataset?.folderName ?? "";
  }

  function updateTreatmentFilesPanelForSelection() {
    const context = typeof resolveImportContext === "function" ? resolveImportContext() : null;
    const selectedFolder = getSelectedTimelineFolderName();
    if (!context?.workspaceDir || !context?.patientFolder) {
      treatmentFilesPanel.clear();
      return;
    }
    if (!selectedFolder) {
      void treatmentFilesPanel.setPatientOverview({
        workspaceDir: context.workspaceDir,
        patientFolder: context.patientFolder,
      });
      return;
    }
    void treatmentFilesPanel.setContext({
      workspaceDir: context.workspaceDir,
      patientFolder: context.patientFolder,
      treatmentFolder: selectedFolder,
    });
  }

  function prefetchNeighborTreatmentPreviews() {
    const context = typeof resolveImportContext === "function" ? resolveImportContext() : null;
    if (!context?.workspaceDir || !context?.patientFolder || !selectedTimelinePoint) return;

    const points = Array.from(timelineTrack?.querySelectorAll(".main-timeline-point") ?? []);
    if (points.length < 1) return;
    const selectedIndex = points.indexOf(selectedTimelinePoint);
    if (selectedIndex === -1) return;

    const neighborFolders = [];
    for (const offset of [-2, -1, 1, 2]) {
      const point = points[selectedIndex + offset];
      const folderName = point?.dataset?.folderName ?? "";
      if (!folderName) continue;
      neighborFolders.push(folderName);
    }
    if (neighborFolders.length < 1) return;

    void invoke("prefetch_treatment_folder_previews", {
      workspaceDir: context.workspaceDir,
      patientFolder: context.patientFolder,
      treatmentFolders: neighborFolders,
    });
  }

  function syncImportDateAvailability() {
    const hasExistingSelection = Boolean(getSelectedTimelineFolderName());
    if (importDate) importDate.disabled = hasExistingSelection;
    importDateLabel?.classList.toggle("disabled", hasExistingSelection);
  }

  function updateImportSelectionUi() {
    if (!importExistingFolderLabel || !importExistingFolderText) return;
    const selectedFolder = getSelectedTimelineFolderName();
    if (selectedFolder) {
      importExistingFolderLabel.classList.add("selected");
      importExistingFolderText.textContent = selectedFolder;
      if (importExistingFolderIcon) importExistingFolderIcon.hidden = false;
      return;
    }
    importExistingFolderLabel.classList.remove("selected");
    importExistingFolderText.textContent = "Select an existing folder";
    if (importExistingFolderIcon) importExistingFolderIcon.hidden = true;
  }

  function setSelectedTimelinePoint(point) {
    if (selectedTimelinePoint && selectedTimelinePoint !== point) {
      selectedTimelinePoint.classList.remove("selected");
    }

    selectedTimelinePoint = point ?? null;
    if (selectedTimelinePoint) {
      selectedTimelinePoint.classList.add("selected");
      selectedTimelineKey = selectedTimelinePoint.dataset.timelineKey ?? "";
    } else {
      selectedTimelineKey = "";
    }
    syncImportDateAvailability();
    updateImportSelectionUi();
    updateImportStartEnabled();
    updateTreatmentFilesPanelForSelection();
    prefetchNeighborTreatmentPreviews();
  }

  function resetTimelineFolderDragArmedPoint() {
    if (timelineFolderDragArmedPoint) {
      timelineFolderDragArmedPoint.classList.remove("folder-drag-armed", "folder-dragging");
    }
    timelineFolderDragArmedPoint = null;
  }

  function clearTimelineFolderDragHoldTimer() {
    if (timelineFolderDragHoldTimerId !== null) {
      clearTimeout(timelineFolderDragHoldTimerId);
      timelineFolderDragHoldTimerId = null;
    }
  }

  function beginTimelineFolderDragHold(point) {
    clearTimelineFolderDragHoldTimer();
    resetTimelineFolderDragArmedPoint();
    timelineFolderDragHoldTimerId = setTimeout(() => {
      timelineFolderDragHoldTimerId = null;
      timelineFolderDragArmedPoint = point;
      timelineFolderDragArmedPoint.classList.add("folder-drag-armed");
      setSelectedTimelinePoint(point);
    }, TIMELINE_FOLDER_DRAG_HOLD_MS);
  }

  function attachTimelineFolderDragExportHandlers(point) {
    const dot = point?.querySelector(".main-timeline-dot");
    if (!dot) return;
    dot.draggable = true;
    let holdPointerId = null;
    let holdStartX = 0;
    let holdStartY = 0;

    const clearHold = () => {
      holdPointerId = null;
      clearTimelineFolderDragHoldTimer();
      if (!timelineFolderDragSourcePoint) {
        resetTimelineFolderDragArmedPoint();
      }
    };

    dot.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      holdPointerId = event.pointerId;
      holdStartX = Number(event.clientX) || 0;
      holdStartY = Number(event.clientY) || 0;
      beginTimelineFolderDragHold(point);
    });

    dot.addEventListener("pointermove", (event) => {
      if (holdPointerId !== event.pointerId) return;
      const currentX = Number(event.clientX) || 0;
      const currentY = Number(event.clientY) || 0;
      const moved = Math.hypot(currentX - holdStartX, currentY - holdStartY);
      if (timelineFolderDragArmedPoint === point) return;
      if (moved > TIMELINE_FOLDER_DRAG_MOVE_CANCEL_PX) {
        clearHold();
      }
    });

    dot.addEventListener("pointerup", (event) => {
      if (holdPointerId !== event.pointerId) return;
      clearHold();
    });
    dot.addEventListener("pointercancel", clearHold);

    dot.addEventListener("dragstart", (event) => {
      if (timelineFolderDragArmedPoint !== point) {
        event.preventDefault();
        return;
      }
      const context = typeof resolveImportContext === "function" ? resolveImportContext() : null;
      const folderName = String(point.dataset.folderName ?? "").trim();
      if (!context?.workspaceDir || !context?.patientFolder || !folderName) {
        event.preventDefault();
        resetTimelineFolderDragArmedPoint();
        return;
      }
      const folderPath = `${context.workspaceDir}/${context.patientFolder}/${folderName}`;
      const folderUri = fsPathToFileUri(folderPath);
      if (!folderUri) {
        event.preventDefault();
        resetTimelineFolderDragArmedPoint();
        return;
      }

      timelineFolderDragSourcePoint = point;
      timelineFolderDragSourceExport = {
        workspaceDir: context.workspaceDir,
        patientFolder: context.patientFolder,
        treatmentFolder: folderName,
      };
      point.classList.remove("folder-drag-armed");
      point.classList.add("folder-dragging");
      const dt = event.dataTransfer;
      if (!dt) {
        event.preventDefault();
        point.classList.remove("folder-dragging");
        resetTimelineFolderDragArmedPoint();
        return;
      }
      dt.effectAllowed = "copy";
      // Keep drag purely visual; actual export copy runs on dragend via backend command.
      // Using only an app-specific MIME avoids OS creating .fileloc/.webloc artifacts.
      dt.setData("application/x-mpm-folder-export", folderUri);
      dt.setDragImage(timelineFolderDragGhost, 17, 15);
    });

    dot.addEventListener("dragend", () => {
      const exportPayload = timelineFolderDragSourceExport;
      point.classList.remove("folder-dragging");
      timelineFolderDragSourcePoint = null;
      timelineFolderDragSourceExport = null;
      resetTimelineFolderDragArmedPoint();
      clearTimelineFolderDragHoldTimer();

      if (!exportPayload) return;
      void (async () => {
        try {
          const selected = await open({
            directory: true,
            multiple: false,
            title: "Choose destination folder",
          });
          const destinationDir = normalizeDialogPathSelection(selected);
          if (!destinationDir) return;
          await invoke("copy_treatment_folder_to_destination", {
            workspaceDir: exportPayload.workspaceDir,
            patientFolder: exportPayload.patientFolder,
            treatmentFolder: exportPayload.treatmentFolder,
            destinationDir,
          });
          if (typeof onImportDebugStateChange === "function") {
            onImportDebugStateChange(`folder copied: ${exportPayload.treatmentFolder}`);
          }
        } catch (err) {
          console.error("copy_treatment_folder_to_destination failed:", err);
          if (typeof onImportDebugStateChange === "function") {
            onImportDebugStateChange("error: copy folder");
          }
        }
      })();
    });
  }

  function animateTimelineScrollTo(targetScrollLeft, durationMs = 300) {
    if (!timelineScroll) return;
    const maxScroll = Math.max(0, timelineScroll.scrollWidth - timelineScroll.clientWidth);
    const target = Math.max(0, Math.min(maxScroll, targetScrollLeft));
    const start = timelineScroll.scrollLeft;
    const delta = target - start;

    if (Math.abs(delta) < 1) {
      timelineScroll.scrollLeft = target;
      return;
    }

    if (timelineHoverScrollRafId !== null) {
      cancelAnimationFrame(timelineHoverScrollRafId);
      timelineHoverScrollRafId = null;
    }

    const startTs = performance.now();
    const easeOutCubic = (t) => 1 - (1 - t) ** 3;
    const tick = (now) => {
      const elapsed = now - startTs;
      const t = Math.min(1, elapsed / durationMs);
      timelineScroll.scrollLeft = start + delta * easeOutCubic(t);
      if (t < 1) {
        timelineHoverScrollRafId = requestAnimationFrame(tick);
      } else {
        timelineHoverScrollRafId = null;
      }
    };

    timelineHoverScrollRafId = requestAnimationFrame(tick);
  }

  function ensureTimelinePointVisible(point) {
    if (!timelineScroll || !point) return;
    const viewportRect = timelineScroll.getBoundingClientRect();
    const pointRect = point.getBoundingClientRect();
    let target = timelineScroll.scrollLeft;

    if (pointRect.left < viewportRect.left) {
      target -= viewportRect.left - pointRect.left;
    } else if (pointRect.right > viewportRect.right) {
      target += pointRect.right - viewportRect.right;
    } else {
      return;
    }

    animateTimelineScrollTo(target, 300);
  }

  async function refreshTimeline() {
    const reqId = ++timelineRequestId;
    const context = typeof resolveImportContext === "function" ? resolveImportContext() : null;
    if (!context?.workspaceDir || !context?.patientFolder || !timelineTrack) {
      setTimelineVisible(false);
      treatmentFilesPanel.clear();
      return;
    }
    if (timelineSelectionOwner !== context.patientFolder) {
      timelineSelectionOwner = context.patientFolder;
      setSelectedTimelinePoint(null);
    }

    let folders = [];
    try {
      const list = await invoke("list_patient_timeline_entries", {
        workspaceDir: context.workspaceDir,
        patientFolder: context.patientFolder,
      });
      folders = Array.isArray(list) ? list : [];
    } catch (err) {
      console.error("list_patient_timeline_entries failed (timeline):", err);
    }

    if (reqId !== timelineRequestId) return;

    timelineTrack.innerHTML = "";
    timelineTrack.appendChild(timelineLine);
    let pointsAdded = 0;
    for (const row of folders) {
      const folderName = (row?.folder_name ?? row?.folderName ?? "").toString();
      const date = (row?.folder_date ?? row?.folderDate ?? extractFolderDate(folderName) ?? "").toString();
      const treatment = (row?.treatment_name ?? row?.treatmentName ?? extractFolderTreatment(folderName) ?? "").toString();
      if (!date) continue;
      pointsAdded += 1;
      const timelineKey = folderName || `${date} ${treatment}`.trim();
      const point = buildTimelinePoint({ date, treatment, timelineKey, folderName });
      const dateLabelEl = point.querySelector(".main-timeline-date");
      const treatmentLabelEl = point.querySelector(".main-timeline-treatment");
      attachTimelineFolderDragExportHandlers(point);
      point.addEventListener("mouseenter", () => ensureTimelinePointVisible(point));
      const openTimelinePoint = () => {
        setSelectedTimelinePoint(point);
        if (!importPanel.hidden && importTreatmentName) {
          importTreatmentName.value = "";
        }
        updateImportStartEnabled();
        ensureTimelinePointVisible(point);
        positionImportProgressCapsules();
      };
      point.addEventListener("click", openTimelinePoint);
      dateLabelEl?.addEventListener("click", (event) => {
        event.stopPropagation();
        openTimelinePoint();
      });
      treatmentLabelEl?.addEventListener("click", (event) => {
        event.stopPropagation();
        openTimelinePoint();
      });
      if (selectedTimelineKey && timelineKey === selectedTimelineKey) {
        setSelectedTimelinePoint(point);
      }
      timelineTrack.appendChild(point);
    }

    if (pointsAdded < 1) {
      if (timelineLine) timelineLine.style.width = "0px";
      if (timelinePrefixLine) timelinePrefixLine.hidden = true;
      setTimelineVisible(false);
      void treatmentFilesPanel.setPatientOverview({
        workspaceDir: context.workspaceDir,
        patientFolder: context.patientFolder,
      });
      return;
    }

    requestAnimationFrame(() => {
      const dots = timelineTrack.querySelectorAll(".main-timeline-dot");
      if (!timelineLine || dots.length < 1) {
        if (timelineLine) timelineLine.style.width = "0px";
        if (timelinePrefixLine) timelinePrefixLine.hidden = true;
        return;
      }

      const trackRect = timelineTrack.getBoundingClientRect();
      const timelineRect = timeline.getBoundingClientRect();
      const firstRect = dots[0].getBoundingClientRect();
      const lastRect = dots[dots.length - 1].getBoundingClientRect();
      const firstCenterInTimeline = firstRect.left + firstRect.width / 2 - timelineRect.left;
      const right = lastRect.left + lastRect.width / 2 - trackRect.left;
      const leftExtension = 1400;

      timelineLine.style.left = `${-leftExtension}px`;
      timelineLine.style.width = `${Math.max(0, right + leftExtension)}px`;

      if (timelinePrefixLine) {
        timelinePrefixLine.hidden = false;
        timelinePrefixLine.style.width = `${Math.max(0, firstCenterInTimeline)}px`;
      }
      positionImportProgressCapsules();
    });
    setTimelineVisible(true);
  }

  function updateImportStartEnabled() {
    const hasExistingSelection = Boolean(getSelectedTimelineFolderName());
    const treatmentValue = String(importTreatmentName?.value ?? "").trim();
    const invalidTreatmentName = hasInvalidTreatmentFolderName(treatmentValue);
    const hasNewFolderInput = Boolean(importDate?.value && treatmentValue);
    if (importTreatmentName) {
      importTreatmentName.classList.toggle("invalid-input", invalidTreatmentName);
      importTreatmentName.title = invalidTreatmentName
        ? "Folder name cannot contain / or \\"
        : "";
    }
    importStartBtn.disabled = !hasExistingSelection && (!hasNewFolderInput || invalidTreatmentName);
  }

  async function prepareImportPanel(droppedPaths = [], { append = true } = {}) {
    const context = typeof resolveImportContext === "function" ? resolveImportContext() : null;
    if (!context?.workspaceDir || !context?.patientFolder) {
      return;
    }

    let incomingPaths = Array.isArray(droppedPaths) ? droppedPaths : [];
    const selectedFolder = getSelectedTimelineFolderName().trim();
    if (selectedFolder) {
      const selectedFolderPath = normalizeFsPathForCompare(
        `${context.workspaceDir}/${context.patientFolder}/${selectedFolder}`
      );
      incomingPaths = incomingPaths.filter((path) => {
        const parentPath = getParentFsPath(path);
        return !parentPath || parentPath !== selectedFolderPath;
      });
    }

    const dedupePaths = (paths) => {
      const seen = new Set();
      const unique = [];
      for (const raw of paths) {
        const normalized = String(raw ?? "").trim();
        if (!normalized) continue;
        if (seen.has(normalized)) continue;
        seen.add(normalized);
        unique.push(normalized);
      }
      return unique;
    };
    if (append) {
      lastDroppedPaths = dedupePaths([...lastDroppedPaths, ...incomingPaths]);
    } else {
      lastDroppedPaths = dedupePaths(incomingPaths);
    }
    if (!lastDroppedPaths.length) {
      setImportPanelVisible(false);
      return;
    }
    if (!append) {
      isImportFilesListExpanded = false;
    }
    importDate.value = await resolveImportDateForPaths(lastDroppedPaths);
    importTreatmentName.value = "";

    let existingFolders = [];
    try {
      const list = await invoke("list_patient_treatment_folders", {
        workspaceDir: context.workspaceDir,
        patientFolder: context.patientFolder,
      });
      existingFolders = Array.isArray(list) ? list : [];
    } catch (err) {
      console.error("list_patient_treatment_folders failed:", err);
      existingFolders = [];
    }

    if (importExistingSection) {
      importExistingSection.hidden = existingFolders.length < 1;
    }
    void refreshImportImagePreviewKinds(lastDroppedPaths);
    updateImportFilesUi();
    syncImportDateAvailability();
    updateImportSelectionUi();
    updateImportStartEnabled();
    setImportPanelVisible(true);
  }

  function scheduleDropOverlayHide() {
    if (dragHideTimerId) clearTimeout(dragHideTimerId);
    dragHideTimerId = setTimeout(() => {
      dragDepth = 0;
      hideDropOverlay();
    }, 120);
  }

  function updatePupil(pupil, cx, cy, mouseX, mouseY) {
    if (!pupil) return;
    const dx = mouseX - cx;
    const dy = mouseY - cy;
    const angle = Math.atan2(dy, dx);
    const distance = Math.min(2.5, Math.hypot(dx, dy) / 15);
    const px = cx + Math.cos(angle) * distance;
    const py = cy + Math.sin(angle) * distance;
    pupil.setAttribute("cx", String(px));
    pupil.setAttribute("cy", String(py));
  }

  doctorSvg?.addEventListener("mousemove", (e) => {
    doctorSvg.classList.remove("sleeping");
    doctorSvg.classList.add("awake");
    if (sleepTimer) {
      clearTimeout(sleepTimer);
      sleepTimer = null;
    }

    const rect = doctorSvg.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    updatePupil(pupilL, 90, 100, x, y);
    updatePupil(pupilR, 110, 100, x, y);
  });

  doctorSvg?.addEventListener("mouseleave", () => {
    if (sleepTimer) clearTimeout(sleepTimer);
    sleepTimer = setTimeout(() => {
      doctorSvg.classList.remove("awake");
      doctorSvg.classList.add("sleeping");
    }, 3000);
  });

  window.addEventListener("mousemove", (e) => {
    if (hasPatientSelection) return;
    if (
      isPointInsideElement(patientSidebarEl, e.clientX, e.clientY) ||
      isPointInsideElement(settingsPanelEl, e.clientX, e.clientY)
    ) {
      setIdleCursorDotVisible(false);
      return;
    }
    const rect = mainCanvas.getBoundingClientRect();
    const inside =
      e.clientX >= rect.left &&
      e.clientX <= rect.right &&
      e.clientY >= rect.top &&
      e.clientY <= rect.bottom;

    if (!inside) {
      setIdleCursorDotVisible(false);
      return;
    }

    const doctorRect = doctorSvg?.getBoundingClientRect();
    if (doctorRect) {
      const cx = doctorRect.left + doctorRect.width / 2;
      const cy = doctorRect.top + doctorRect.height / 2;
      const dist = Math.hypot(e.clientX - cx, e.clientY - cy);
      if (dist > 200) {
        setIdleCursorDotVisible(false);
        return;
      }
    }

    setIdleCursorDotVisible(true);
    idleDotBaseX = e.clientX - rect.left - 10;
    idleDotBaseY = e.clientY - rect.top - 10;
    idleCursorDot.style.left = `${idleDotBaseX}px`;
    idleCursorDot.style.top = `${idleDotBaseY}px`;
  });
  mainCanvas.addEventListener("mouseleave", () => {
    if (!hasPatientSelection) {
      setIdleCursorDotVisible(false);
    }
  });


  function onDragEnter(e) {
    if (!hasPatientSelection) return;
    if (internalDragInProgress) return;
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth += 1;
    showDropOverlay();
  }

  function onDragOver(e) {
    if (!hasPatientSelection) return;
    if (internalDragInProgress) return;
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    showDropOverlay();
  }

  function onDragLeave(e) {
    if (!hasPatientSelection) return;
    if (!dropOverlay.hidden) e.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) scheduleDropOverlayHide();
  }

  function onDrop(e) {
    if (!hasPatientSelection) return;
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    hideDropOverlay();
    const dropped = Array.from(e?.dataTransfer?.files ?? []).map((f) => f.path || f.name);
    if (!dropped.length) return;
    void prepareImportPanel(dropped);
  }

  function clearTimelinePanState(pointerId = null) {
    if (pointerId !== null && timelinePanPointerId !== pointerId) return;
    timelinePanPointerId = null;
    timelinePanMoved = false;
    if (timelineScroll) {
      timelineScroll.classList.remove("dragging");
    }
  }

  function stopTimelineWheelAnimation() {
    if (timelineWheelRafId !== null) {
      cancelAnimationFrame(timelineWheelRafId);
      timelineWheelRafId = null;
    }
    timelineWheelTargetScrollLeft = null;
  }

  function smoothTimelineWheelBy(delta) {
    if (!timelineScroll || !Number.isFinite(delta)) return;
    const maxScroll = Math.max(0, timelineScroll.scrollWidth - timelineScroll.clientWidth);
    if (maxScroll < 1) return;

    const currentScrollLeft = timelineScroll.scrollLeft;
    const baseTarget = timelineWheelTargetScrollLeft ?? currentScrollLeft;
    const nextTarget = Math.max(0, Math.min(maxScroll, baseTarget + delta));
    timelineWheelTargetScrollLeft = nextTarget;

    if (timelineWheelRafId !== null) return;
    const tick = () => {
      if (!timelineScroll || timelineWheelTargetScrollLeft === null) {
        timelineWheelRafId = null;
        return;
      }
      const current = timelineScroll.scrollLeft;
      const target = timelineWheelTargetScrollLeft;
      const diff = target - current;
      if (Math.abs(diff) < 0.5) {
        timelineScroll.scrollLeft = target;
        timelineWheelTargetScrollLeft = null;
        timelineWheelRafId = null;
        return;
      }

      // Cap per-frame movement to prevent large stepped wheel deltas from causing visual direction glitches.
      const frameStep = Math.sign(diff) * Math.min(Math.abs(diff) * 0.32, 42);
      timelineScroll.scrollLeft = current + frameStep;
      timelineWheelRafId = requestAnimationFrame(tick);
    };
    timelineWheelRafId = requestAnimationFrame(tick);
  }

  timelineScroll?.addEventListener("wheel", (event) => {
    if (!timelineScroll) return;
    const maxScroll = Math.max(0, timelineScroll.scrollWidth - timelineScroll.clientWidth);
    if (maxScroll < 1) return;
    let delta = Math.abs(event.deltaY) > Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
    if (event.deltaMode === 1) delta *= 16;
    if (event.deltaMode === 2) delta *= timelineScroll.clientWidth;
    if (!Number.isFinite(delta) || Math.abs(delta) < 0.01) return;
    // Keep notched wheels predictable by clamping spikes and animating toward a target.
    const clamped = Math.sign(delta) * Math.min(Math.abs(delta), 120);
    smoothTimelineWheelBy(clamped);
    event.preventDefault();
  }, { passive: false });

  timelineScroll?.addEventListener("pointerdown", (event) => {
    if (!timelineScroll || event.button !== 0) return;
    if (event.target instanceof Element && event.target.closest(".main-timeline-dot")) return;
    if (
      event.target instanceof Element &&
      event.target.closest(".main-timeline-date, .main-timeline-treatment")
    ) {
      return;
    }
    stopTimelineWheelAnimation();
    timelinePanPointerId = event.pointerId;
    timelinePanStartX = Number(event.clientX) || 0;
    timelinePanStartScrollLeft = timelineScroll.scrollLeft;
    timelinePanMoved = false;
    timelineScroll.classList.add("dragging");
    try {
      timelineScroll.setPointerCapture(event.pointerId);
    } catch {
      // no-op if pointer capture is not available
    }
  });

  timelineScroll?.addEventListener("pointermove", (event) => {
    if (!timelineScroll || timelinePanPointerId !== event.pointerId) return;
    const currentX = Number(event.clientX) || 0;
    const deltaX = currentX - timelinePanStartX;
    if (!timelinePanMoved && Math.abs(deltaX) > 3) {
      timelinePanMoved = true;
    }
    timelineScroll.scrollLeft = timelinePanStartScrollLeft - deltaX;
    if (timelinePanMoved) {
      event.preventDefault();
    }
  });

  timelineScroll?.addEventListener("pointerup", (event) => {
    if (timelinePanPointerId !== event.pointerId) return;
    if (timelinePanMoved) {
      timelinePanSuppressClickUntil = performance.now() + 200;
    }
    clearTimelinePanState(event.pointerId);
  });
  timelineScroll?.addEventListener("pointercancel", (event) => {
    clearTimelinePanState(event.pointerId);
  });
  timelineScroll?.addEventListener("lostpointercapture", (event) => {
    clearTimelinePanState(event.pointerId);
  });
  timelineScroll?.addEventListener("click", (event) => {
    if (performance.now() < timelinePanSuppressClickUntil) {
      event.preventDefault();
      event.stopPropagation();
    }
  }, true);

  // Capture listeners at document/window level for reliable external file drags.
  document.addEventListener("dragstart", () => {
    internalDragInProgress = true;
  }, true);
  document.addEventListener("dragend", () => {
    internalDragInProgress = false;
    dragDepth = 0;
    hideDropOverlay();
  }, true);
  window.addEventListener("dragenter", onDragEnter, true);
  window.addEventListener("dragover", onDragOver, true);
  window.addEventListener("dragleave", onDragLeave, true);
  window.addEventListener("drop", onDrop, true);
  document.addEventListener("dragenter", onDragEnter, true);
  document.addEventListener("dragover", onDragOver, true);
  document.addEventListener("dragleave", onDragLeave, true);
  document.addEventListener("drop", onDrop, true);

  // Native Tauri window drag-drop events: this is the reliable cross-platform source.
  const appWindow = getCurrentWindow();
  appWindow.listen(TauriEvent.DRAG_ENTER, () => {
    if (!hasPatientSelection) return;
    if (internalDragInProgress) return;
    dragDepth = Math.max(dragDepth, 1);
    showDropOverlay();
  });
  appWindow.listen(TauriEvent.DRAG_OVER, () => {
    if (!hasPatientSelection) return;
    if (internalDragInProgress) return;
    showDropOverlay();
  });
  appWindow.listen(TauriEvent.DRAG_LEAVE, () => {
    if (!hasPatientSelection) return;
    dragDepth = 0;
    hideDropOverlay();
  });
  appWindow.listen(TauriEvent.DRAG_DROP, (event) => {
    if (!hasPatientSelection) return;
    if (internalDragInProgress) {
      internalDragInProgress = false;
      dragDepth = 0;
      hideDropOverlay();
      return;
    }
    dragDepth = 0;
    hideDropOverlay();
    const dropped = Array.isArray(event?.payload?.paths) ? event.payload.paths : [];
    if (!dropped.length) return;
    void prepareImportPanel(dropped);
  });

  importDate?.addEventListener("input", updateImportStartEnabled);
  importDeleteOrigin?.addEventListener("change", () => {
    importDeleteOriginPreference = Boolean(importDeleteOrigin.checked);
  });
  importPanel?.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    if (importPanel.hidden) return;
    if (!importStartBtn || importStartBtn.disabled) return;
    e.preventDefault();
    importStartBtn.click();
  });
  importTreatmentName?.addEventListener("input", () => {
    if (importTreatmentName.value.trim() && selectedTimelinePoint) {
      setSelectedTimelinePoint(null);
    }
    updateImportStartEnabled();
  });
  importFilesToggle?.addEventListener("click", () => {
    if (lastDroppedPaths.length < 1) return;
    isImportFilesListExpanded = !isImportFilesListExpanded;
    updateImportFilesUi();
  });
  importFilesListWrap?.addEventListener("scroll", updateImportFilesOverflowIndicators);
  importFilesScrollUp?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!importFilesListWrap) return;
    animateImportFilesListScrollTo(0, 650);
  });
  importFilesScrollDown?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!importFilesListWrap) return;
    animateImportFilesListScrollTo(importFilesListWrap.scrollHeight, 650);
  });
  patientIdLine?.addEventListener("click", openMissingPatientIdInput);
  patientNameRow?.addEventListener("click", () => {
    if (!hasPatientSelection) return;
    if (timelinePanPointerId !== null) return;
    setSelectedTimelinePoint(null);
  });
  patientIdInput?.addEventListener("input", () => {
    const normalizedId = normalizeFieldValue(patientIdInput.value);
    const hasInvalidId = Boolean(normalizedId) && !isNumericPatientId(normalizedId);
    patientIdInput.classList.toggle("invalid-id", hasInvalidId);
    void checkMissingPatientIdUniqueness();
  });
  patientIdInput?.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();

    const normalizedId = normalizeFieldValue(patientIdInput.value);
    const hasInvalidId = Boolean(normalizedId) && !isNumericPatientId(normalizedId);
    patientIdInput.classList.toggle("invalid-id", hasInvalidId);
    if (!normalizedId || hasInvalidId) return;
    if (missingPatientIdChecking || missingPatientIdTaken) {
      patientIdInput.classList.toggle("duplicate-id", missingPatientIdTaken);
      return;
    }
    if (typeof onSubmitMissingPatientId !== "function") return;

    void (async () => {
      try {
        patientIdInput.disabled = true;
        patientIdInput.classList.remove("invalid-id");
        patientIdInput.classList.remove("duplicate-id");
        const savedId = normalizeFieldValue(await onSubmitMissingPatientId(normalizedId)) || normalizedId;
        showPatientIdValue(savedId);
      } catch (err) {
        console.error("save missing patient id failed:", err);
      } finally {
        patientIdInput.disabled = false;
      }
    })();
  });
  patientIdInput?.addEventListener("blur", () => {
    if (patientIdInput.disabled) return;
    if (!patientIdLine.classList.contains("missing-id")) return;
    patientIdInput.hidden = true;
    patientIdInput.value = "";
    patientIdInput.classList.remove("invalid-id");
    patientIdInput.classList.remove("duplicate-id");
    patientIdLine.hidden = false;
  });
  contentScrollLayer.addEventListener("scroll", syncHeaderFrostVisibility);
  importCancelBtn?.addEventListener("click", () => {
    setImportPanelVisible(false);
  });
  importStartBtn?.addEventListener("click", () => {
    void (async () => {
      const context = typeof resolveImportContext === "function" ? resolveImportContext() : null;
      if (!context?.workspaceDir || !context?.patientFolder) return;
      if (!lastDroppedPaths.length) return;

      const existingFolder = getSelectedTimelineFolderName().trim();
      const isNew = !existingFolder;
      const treatmentName = importTreatmentName.value.trim();
      const date = importDate.value;
      if (isNew && (!date || !treatmentName)) return;
      if (isNew && hasInvalidTreatmentFolderName(treatmentName)) return;

      try {
        if (typeof onImportDebugStateChange === "function") {
          onImportDebugStateChange(`starting import (${lastDroppedPaths.length} files)`);
        }
        importStartBtn.disabled = true;
        importCancelBtn.disabled = true;
        const result = await invoke("start_import_files", {
          workspaceDir: context.workspaceDir,
          patientFolder: context.patientFolder,
          existingFolder: existingFolder || null,
          date: isNew ? date : null,
          treatmentName: isNew ? treatmentName : null,
          filePaths: lastDroppedPaths,
          deleteOrigin: Boolean(importDeleteOrigin.checked),
        });

        const startedJobId = Number(result?.job_id ?? result?.jobId ?? 0) || null;
        const startedTargetFolder = String(result?.target_folder ?? result?.targetFolder ?? "").trim();
        if (typeof onImportActivityChange === "function" && context.patientFolder) {
          onImportActivityChange({ patientFolder: context.patientFolder, active: true });
        }
        trackNewImportJob({
          jobId: startedJobId,
          targetFolder: startedTargetFolder,
          workspaceDir: context.workspaceDir,
          patientFolder: context.patientFolder,
        });
        setImportPanelVisible(false);
        if (startedTargetFolder) {
          selectedTimelineKey = startedTargetFolder;
          await refreshTimeline();
          requestAnimationFrame(() => {
            const selectedPoint = timelineTrack?.querySelector(".main-timeline-point.selected");
            if (!selectedPoint) return;
            ensureTimelinePointVisible(selectedPoint);
            positionImportProgressCapsules();
          });
        }
      } catch (err) {
        console.error("start_import_files failed:", err);
        if (typeof onImportDebugStateChange === "function") {
          onImportDebugStateChange("error: start import");
        }
        importStartBtn.disabled = false;
        importCancelBtn.disabled = false;
      }
    })();
  });
  appWindow.listen("import-progress", (event) => {
    const payload = event?.payload ?? {};
    const jobId = Number(payload?.job_id ?? payload?.jobId ?? 0) || null;
    if (!jobId) return;
    const job = importJobs.get(jobId);
    const percent = Number(payload?.percent ?? 0);
    const done = Boolean(payload?.done);
    const error = payload?.error ? String(payload.error) : "";
    if (!job) {
      bufferedImportProgressByJobId.set(jobId, { percent, done, error });
      return;
    }
    applyImportProgressEventForJob(job, { percent, done, error });
  });

  function setSelectedPatientHeader({ lastName = "", firstName = "", patientId = "" } = {}) {
    const normalizedLast = (lastName ?? "").trim();
    const normalizedFirst = (firstName ?? "").trim();
    const normalizedId = (patientId ?? "").trim();

    if (!normalizedLast && !normalizedFirst) {
      hasPatientSelection = false;
      timelineSelectionOwner = "";
      setSelectedTimelinePoint(null);
      patientLabel.hidden = true;
      patientLast.textContent = "";
      patientFirst.textContent = "";
      patientIdLine.textContent = "";
      patientIdLine.classList.remove("missing-id");
      patientIdLine.hidden = false;
      resetPatientIdInputState();
      emptyState.hidden = false;
      hideDropOverlay();
      setImportPanelVisible(false);
      setIdleCursorDotVisible(true);
      setTimelineVisible(false);
      treatmentFilesPanel.clear();
      return;
    }

    hasPatientSelection = true;
    setIdleCursorDotVisible(false);
    patientLast.textContent = normalizedLast;
    patientFirst.textContent = normalizedFirst ? `, ${normalizedFirst}` : "";
    if (normalizedId) {
      showPatientIdValue(normalizedId);
    } else {
      showMissingPatientIdPrompt();
    }
    patientLabel.hidden = false;
    emptyState.hidden = true;
    setTimelineVisible(false);
    void refreshTimeline();
    if (!importPanel.hidden) {
      void prepareImportPanel(lastDroppedPaths, { append: false });
    }
  }

  function clearSelectedPatientHeader() {
    hasPatientSelection = false;
    timelineSelectionOwner = "";
    setSelectedTimelinePoint(null);
    patientLabel.hidden = true;
    patientLast.textContent = "";
    patientFirst.textContent = "";
    patientIdLine.textContent = "";
    patientIdLine.classList.remove("missing-id");
    patientIdLine.hidden = false;
    resetPatientIdInputState();
    emptyState.hidden = false;
    doctorSvg?.classList.remove("awake");
    doctorSvg?.classList.add("sleeping");
    hideDropOverlay();
    setImportPanelVisible(false);
    setIdleCursorDotVisible(true);
    setTimelineVisible(false);
    treatmentFilesPanel.clear();
  }

  // Initial state is no selected patient.
  setIdleCursorDotVisible(false);
  syncHeaderFrostVisibility();

  return {
    mainCanvas,
    setSelectedPatientHeader,
    clearSelectedPatientHeader,
    invalidateTreatmentPreviewCache: () => {
      treatmentFilesPanel.invalidateRuntimePreviewCache();
    },
    refreshTreatmentFilesForSelection: async () => {
      if (!hasPatientSelection) return;
      await treatmentFilesPanel.refreshActiveContext();
    },
    refreshTimelineForSelection: async () => {
      if (!hasPatientSelection) {
        setTimelineVisible(false);
        return;
      }
      await refreshTimeline();
    },
    registerExternalImportJob: ({
      jobId,
      targetFolder,
      workspaceDir,
      patientFolder,
    } = {}) => {
      const normalizedWorkspace = String(workspaceDir ?? "").trim();
      const normalizedPatient = String(patientFolder ?? "").trim();
      const normalizedTarget = String(targetFolder ?? "").trim();
      const numericJobId = Number(jobId) || null;
      if (!numericJobId || !normalizedWorkspace || !normalizedPatient || !normalizedTarget) return;
      if (typeof onImportActivityChange === "function") {
        onImportActivityChange({ patientFolder: normalizedPatient, active: true });
      }
      trackNewImportJob({
        jobId: numericJobId,
        targetFolder: normalizedTarget,
        workspaceDir: normalizedWorkspace,
        patientFolder: normalizedPatient,
      });
      selectedTimelineKey = normalizedTarget;
      void (async () => {
        await refreshTimeline();
        requestAnimationFrame(() => {
          const selectedPoint = timelineTrack?.querySelector(".main-timeline-point.selected");
          if (!selectedPoint) return;
          ensureTimelinePointVisible(selectedPoint);
          positionImportProgressCapsules();
        });
      })();
    },
  };
}
