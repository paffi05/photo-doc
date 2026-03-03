import { listen } from "@tauri-apps/api/event";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";

const previewImage = document.getElementById("previewImage");
let previewRequestToken = 0;

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
      // Ignore stale in-flight loads.
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
  const normalized = String(path ?? "").trim();
  if (!normalized) return;
  const requestToken = ++previewRequestToken;
  try {
    const resolvedPath = await invoke("get_import_wizard_preview_src_path", { path: normalized });
    if (requestToken !== previewRequestToken) return;
    const safePath = String(resolvedPath ?? "").trim() || normalized;
    // Always load the original image file (mapped to webview-accessible path if required).
    const src = `${convertFileSrc(safePath)}?t=${Date.now()}`;
    previewImage.decoding = "async";
    await loadImageWithVerification(src, requestToken);
  } catch (err) {
    if (requestToken !== previewRequestToken) return;
    try {
      // Fallback: still load the original image, but via backend data URL.
      const dataUrl = await invoke("get_import_wizard_preview_data_url", { path: normalized });
      if (requestToken !== previewRequestToken) return;
      const src = String(dataUrl ?? "").trim();
      if (!src) return;
      previewImage.src = src;
    } catch (fallbackErr) {
      console.error("import preview original load failed:", err, fallbackErr);
    }
  }
}

void listen("import-wizard-preview-file", (event) => {
  const path = event?.payload?.path;
  void setPreview(path);
});

void (async () => {
  try {
    const path = await invoke("get_current_import_wizard_preview_path");
    const normalized = String(path ?? "").trim();
    if (normalized) {
      await setPreview(normalized);
    }
  } catch (err) {
    console.error("get_current_import_wizard_preview_path failed:", err);
  }
})();
