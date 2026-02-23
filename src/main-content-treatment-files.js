import { invoke } from "@tauri-apps/api/core";

const PREVIEW_CONCURRENCY = 4;
const MAX_IMAGE_PREVIEWS = 120;

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
  let activeRequestId = 0;

  function clearPanel() {
    activeContextKey = "";
    activeRequestId += 1;
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
      <span class="treatment-image-thumb loading"></span>
      <span class="treatment-image-name">${file.name}</span>
    `;
    card.addEventListener("click", () => {
      if (typeof onOpenPath === "function") {
        void onOpenPath(file.path);
      }
    });
    return card;
  }

  async function fillImagePreviews(cardsByPath, imageFiles, requestId) {
    const queue = [...imageFiles];
    const workerCount = Math.min(PREVIEW_CONCURRENCY, queue.length);
    const workers = Array.from({ length: workerCount }, async () => {
      while (queue.length > 0) {
        const file = queue.shift();
        if (!file) continue;
        if (requestId !== activeRequestId) return;
        try {
          const rows = await invoke("get_image_previews", { paths: [file.path] });
          if (requestId !== activeRequestId) return;
          const row = Array.isArray(rows) ? rows[0] : null;
          const dataUrl = String(row?.data_url ?? row?.dataUrl ?? "").trim();
          const card = cardsByPath.get(file.path);
          if (!card) continue;
          const thumb = card.querySelector(".treatment-image-thumb");
          if (!thumb) continue;
          thumb.classList.remove("loading");
          if (dataUrl) {
            thumb.innerHTML = `<img src="${dataUrl}" alt="" loading="lazy" decoding="async" />`;
          } else {
            thumb.classList.add("fallback");
            thumb.textContent = "IMG";
          }
        } catch (err) {
          if (requestId !== activeRequestId) return;
          const card = cardsByPath.get(file.path);
          const thumb = card?.querySelector(".treatment-image-thumb");
          if (thumb) {
            thumb.classList.remove("loading");
            thumb.classList.add("fallback");
            thumb.textContent = "IMG";
          }
        }
      }
    });
    await Promise.all(workers);
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
    } catch (err) {
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

    const cappedImages = imageFiles.slice(0, MAX_IMAGE_PREVIEWS);
    const cardsByPath = new Map();
    for (const file of cappedImages) {
      const card = createImageCard(file);
      cardsByPath.set(file.path, card);
      imagesGridEl.appendChild(card);
    }
    if (imageFiles.length > cappedImages.length) {
      const note = document.createElement("div");
      note.className = "treatment-images-limit-note";
      note.textContent = `Showing first ${cappedImages.length} image previews.`;
      imagesGridEl.appendChild(note);
    }

    await fillImagePreviews(cardsByPath, cappedImages, requestId);
  }

  return {
    clear: clearPanel,
    setContext,
  };
}
