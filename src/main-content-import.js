import { t } from "./i18n";

export function createImportPanel(contentScrollLayer) {
  const importPanel = document.createElement("div");
  importPanel.className = "main-import-panel";
  importPanel.hidden = true;
  importPanel.innerHTML = `
    <div class="main-import-card">
      <div class="main-import-section main-import-files-section">
        <button id="importFilesToggle" class="main-import-files-toggle" type="button" aria-expanded="false">
          <svg class="main-import-files-arrow" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <path d="M6 4L14 12" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" />
            <path d="M14 12L6 20" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" />
          </svg>
          <span id="importFilesCountText">${t("import_main.files_count", { count: 0, label: t("import_main.file_plural") })}</span>
        </button>
        <div class="main-import-files-list-shell">
          <div id="importFilesScrollUp" class="main-import-files-overflow-indicator up" aria-hidden="true">
            <svg viewBox="0 0 20 20" fill="none">
              <path d="M6 13L10 9L14 13" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </div>
          <div id="importFilesListWrap" class="main-import-files-list-wrap">
            <ul id="importFilesList" class="main-import-files-list"></ul>
          </div>
          <div id="importFilesScrollDown" class="main-import-files-overflow-indicator down" aria-hidden="true">
            <svg viewBox="0 0 20 20" fill="none">
              <path d="M6 9L10 13L14 9" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </div>
        </div>
      </div>

      <div class="main-import-section main-import-existing-section">
        <div id="importExistingFolderLabel" class="main-import-existing-label">
          <span id="importExistingFolderIcon" class="main-import-existing-icon" hidden aria-hidden="true">
            <svg class="folder-change-icon" width="16" height="16" viewBox="0 0 100 100" fill="none">
              <path d="M10 30C10 26.6863 12.6863 24 16 24H35L42 32H84C87.3137 32 90 34.6863 90 38V74C90 77.3137 87.3137 80 84 80H16C12.6863 80 10 77.3137 10 74V30Z" fill="var(--folder-back)"/>
              <path d="M10 40C10 36.6863 12.6863 34 16 34H84C87.3137 34 90 36.6863 90 40V74C90 77.3137 87.3137 80 84 80H16C12.6863 80 10 77.3137 10 74V40Z" fill="var(--folder-front)"/>
            </svg>
          </span>
          <span id="importExistingFolderText">${t("import_main.select_existing_folder")}</span>
        </div>
        <div class="main-import-or-divider" aria-hidden="true">
          <span class="main-import-or-line"></span>
          <span class="main-import-or-text">${t("import_main.or")}</span>
          <span class="main-import-or-line"></span>
        </div>
      </div>

      <div class="main-import-section">
        <label class="main-import-label" for="importTreatmentName">${t("import_main.folder_name")}</label>
        <input id="importTreatmentName" class="main-import-input" type="text" placeholder="${t("import_main.folder_name_placeholder")}" />

        <label class="main-import-label" for="importDate">${t("import_main.date")}</label>
        <input id="importDate" class="main-import-input" type="date" />
      </div>

      <label class="main-import-checkbox">
        <input id="importDeleteOrigin" type="checkbox" />
        <span>${t("import_main.delete_origin")}</span>
      </label>

      <div class="main-import-actions">
        <button id="importCancelBtn" class="main-import-btn main-import-btn-secondary" type="button">${t("import_main.cancel")}</button>
        <button id="importStartBtn" class="main-import-btn main-import-btn-primary" type="button">${t("import_main.import")}</button>
      </div>
    </div>
  `;
  contentScrollLayer.appendChild(importPanel);

  return {
    importPanel,
    importExistingSection: importPanel.querySelector(".main-import-existing-section"),
    importExistingFolderLabel: importPanel.querySelector("#importExistingFolderLabel"),
    importExistingFolderIcon: importPanel.querySelector("#importExistingFolderIcon"),
    importExistingFolderText: importPanel.querySelector("#importExistingFolderText"),
    importDateLabel: importPanel.querySelector('label[for="importDate"]'),
    importDate: importPanel.querySelector("#importDate"),
    importTreatmentName: importPanel.querySelector("#importTreatmentName"),
    importDeleteOrigin: importPanel.querySelector("#importDeleteOrigin"),
    importFilesToggle: importPanel.querySelector("#importFilesToggle"),
    importFilesCountText: importPanel.querySelector("#importFilesCountText"),
    importFilesListWrap: importPanel.querySelector("#importFilesListWrap"),
    importFilesScrollUp: importPanel.querySelector("#importFilesScrollUp"),
    importFilesScrollDown: importPanel.querySelector("#importFilesScrollDown"),
    importFilesList: importPanel.querySelector("#importFilesList"),
    importCancelBtn: importPanel.querySelector("#importCancelBtn"),
    importStartBtn: importPanel.querySelector("#importStartBtn"),
  };
}
