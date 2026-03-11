import { invoke } from "@tauri-apps/api/core";
import en from "./locales/en";
import de from "./locales/de";
import fr from "./locales/fr";

const locales = { en, de, fr };
const DEFAULT_LANGUAGE = "en";
const LANGUAGE_STORAGE_KEY = "photo-doc.language";
let currentLanguage = DEFAULT_LANGUAGE;
let currentDictionary = en;

function normalizeLanguage(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return ["en", "de", "fr"].includes(normalized) ? normalized : DEFAULT_LANGUAGE;
}

function lookupKey(source, key) {
  return String(key ?? "")
    .split(".")
    .reduce((acc, part) => (acc && Object.prototype.hasOwnProperty.call(acc, part) ? acc[part] : undefined), source);
}

function interpolate(template, vars = {}) {
  return String(template ?? "").replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
    const value = vars[key];
    return value === null || value === undefined ? "" : String(value);
  });
}

export function getLanguage() {
  return currentLanguage;
}

export function t(key, vars = {}) {
  const value = lookupKey(currentDictionary, key) ?? lookupKey(en, key);
  if (typeof value === "function") return value(vars);
  if (value === null || value === undefined) return key;
  return interpolate(value, vars);
}

function setNodeText(node, text) {
  if (!node) return;
  node.textContent = text;
}

export function applyTranslations(root = document) {
  if (!root?.querySelectorAll) return;
  for (const el of root.querySelectorAll("[data-i18n]")) {
    setNodeText(el, t(el.dataset.i18n, parseDatasetVars(el.dataset.i18nVars)));
  }
  for (const el of root.querySelectorAll("[data-i18n-placeholder]")) {
    el.setAttribute("placeholder", t(el.dataset.i18nPlaceholder, parseDatasetVars(el.dataset.i18nVars)));
  }
  for (const el of root.querySelectorAll("[data-i18n-title]")) {
    el.setAttribute("title", t(el.dataset.i18nTitle, parseDatasetVars(el.dataset.i18nVars)));
  }
  for (const el of root.querySelectorAll("[data-i18n-aria-label]")) {
    el.setAttribute("aria-label", t(el.dataset.i18nAriaLabel, parseDatasetVars(el.dataset.i18nVars)));
  }
  const titleKey = root?.documentElement?.dataset?.i18nDocumentTitle;
  if (titleKey && root.title !== undefined) {
    root.title = t(titleKey);
  }
  if (root?.documentElement) {
    root.documentElement.lang = currentLanguage;
  }
}

function parseDatasetVars(raw = "") {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function onLanguageChanged(callback) {
  const handler = (event) => callback(event.detail);
  window.addEventListener("app-language-changed", handler);
  return () => window.removeEventListener("app-language-changed", handler);
}

export function hydrateLanguageFromStorage() {
  let storedLanguage = DEFAULT_LANGUAGE;
  try {
    storedLanguage = normalizeLanguage(window.localStorage.getItem(LANGUAGE_STORAGE_KEY));
  } catch {
    storedLanguage = DEFAULT_LANGUAGE;
  }
  currentLanguage = storedLanguage;
  currentDictionary = locales[storedLanguage] ?? en;
  return storedLanguage;
}

export async function setLanguage(nextLanguage, { persist = false } = {}) {
  const normalized = normalizeLanguage(nextLanguage);
  currentLanguage = normalized;
  currentDictionary = locales[normalized] ?? en;
  try {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, currentLanguage);
  } catch {
    // ignore storage failures
  }
  applyTranslations(document);
  window.dispatchEvent(new CustomEvent("app-language-changed", {
    detail: {
      language: currentLanguage,
      t,
    },
  }));
  if (persist) {
    try {
      await invoke("set_language", { language: currentLanguage });
    } catch (err) {
      console.error("set_language failed:", err);
    }
  }
  return currentLanguage;
}

export async function initLanguageFromSettings() {
  try {
    const settings = await invoke("load_settings");
    let fallbackStoredLanguage = DEFAULT_LANGUAGE;
    try {
      fallbackStoredLanguage = normalizeLanguage(window.localStorage.getItem(LANGUAGE_STORAGE_KEY));
    } catch {
      fallbackStoredLanguage = DEFAULT_LANGUAGE;
    }
    const language = settings?.language ?? fallbackStoredLanguage ?? DEFAULT_LANGUAGE;
    await setLanguage(language, { persist: false });
    return normalizeLanguage(language);
  } catch {
    let storedLanguage = DEFAULT_LANGUAGE;
    try {
      storedLanguage = normalizeLanguage(window.localStorage.getItem(LANGUAGE_STORAGE_KEY));
    } catch {
      storedLanguage = DEFAULT_LANGUAGE;
    }
    await setLanguage(storedLanguage, { persist: false });
    return storedLanguage;
  }
}
