import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";

const previewImage = document.getElementById("previewImage");

async function setPreview(path) {
  const normalized = String(path ?? "").trim();
  if (!normalized) return;
  try {
    const dataUrl = await invoke("get_import_wizard_preview_data_url", { path: normalized });
    const src = String(dataUrl ?? "").trim();
    if (!src) return;
    previewImage.src = src;
  } catch (err) {
    console.error("get_import_wizard_preview_data_url failed:", err);
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
