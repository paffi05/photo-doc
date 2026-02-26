use tauri::{Emitter, Manager};
use tauri_plugin_updater::UpdaterExt;
use base64::Engine;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::io::Cursor;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex, OnceLock};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, UNIX_EPOCH};

#[derive(Serialize, Deserialize, Default)]
struct WindowState {
    width: u32,
    height: u32,
    x: i32,
    y: i32,
    maximized: bool,
}

#[derive(Serialize, Deserialize, Default)]
#[serde(default)]
struct Settings {
    workspace_dir: Option<String>,
    import_wizard_dir: Option<String>,
    import_wizard_live_preview: Option<bool>,
    window_state: Option<WindowState>,
    import_wizard_window_state: Option<WindowState>,
    import_wizard_preview_window_state: Option<WindowState>,
    cache_size_gb: Option<u8>,
    keep_local_cache_copy: Option<bool>,
    preview_performance_mode: Option<String>,
}

fn get_settings_path(app_handle: &tauri::AppHandle) -> PathBuf {
    let app_dir = app_handle
        .path()
        .app_data_dir()
        .expect("failed to get app data dir");

    fs::create_dir_all(&app_dir).ok();

    app_dir.join("settings.json")
}

fn read_settings(app_handle: &tauri::AppHandle) -> Result<Settings, String> {
    let path = get_settings_path(app_handle);
    if !path.exists() {
        return Ok(Settings::default());
    }

    let content = fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str(&content).map_err(|e| e.to_string())
}

fn write_settings(app_handle: &tauri::AppHandle, settings: &Settings) -> Result<(), String> {
    let path = get_settings_path(app_handle);
    let json = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())
}

fn snapshot_window_state(window: &tauri::Window) -> Result<WindowState, String> {
    let size = window.outer_size().map_err(|e| e.to_string())?;
    let pos = window.outer_position().map_err(|e| e.to_string())?;
    let maximized = window.is_maximized().map_err(|e| e.to_string())?;

    Ok(WindowState {
        width: size.width,
        height: size.height,
        x: pos.x,
        y: pos.y,
        maximized,
    })
}

fn persist_window_state(window: &tauri::Window) -> Result<WindowState, String> {
    snapshot_window_state(window)
}

fn persist_main_window_state(app_handle: &tauri::AppHandle, window: &tauri::Window) -> Result<(), String> {
    let mut settings = read_settings(app_handle)?;
    settings.window_state = Some(persist_window_state(window)?);
    write_settings(app_handle, &settings)
}

fn persist_import_wizard_preview_window_state(
    app_handle: &tauri::AppHandle,
    window: &tauri::Window,
) -> Result<(), String> {
    let mut settings = read_settings(app_handle)?;
    settings.import_wizard_preview_window_state = Some(persist_window_state(window)?);
    write_settings(app_handle, &settings)
}

fn apply_saved_window_state(app_handle: &tauri::AppHandle, window: &tauri::WebviewWindow) -> Result<(), String> {
    let settings = read_settings(app_handle)?;
    let Some(state) = settings.window_state else {
        return Ok(());
    };

    window
        .set_size(tauri::Size::Physical(tauri::PhysicalSize::new(state.width, state.height)))
        .map_err(|e| e.to_string())?;
    window
        .set_position(tauri::Position::Physical(tauri::PhysicalPosition::new(state.x, state.y)))
        .map_err(|e| e.to_string())?;
    if state.maximized {
        window.maximize().map_err(|e| e.to_string())?;
    }

    Ok(())
}

fn get_db_path(app_handle: &tauri::AppHandle) -> PathBuf {
    let app_dir = app_handle
        .path()
        .app_data_dir()
        .expect("failed to get app data dir");

    fs::create_dir_all(&app_dir).ok();

    app_dir.join("patients.db")
}

fn open_db(app_handle: &tauri::AppHandle) -> Result<Connection, String> {
    let db_path = get_db_path(app_handle);
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;

    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS patient_index (
            workspace_dir TEXT NOT NULL,
            folder_name TEXT NOT NULL,
            last_name TEXT NOT NULL,
            first_name TEXT NOT NULL,
            patient_id TEXT NOT NULL DEFAULT '',
            search_text TEXT NOT NULL,
            PRIMARY KEY (workspace_dir, folder_name)
        );
        CREATE INDEX IF NOT EXISTS idx_patient_workspace_last_first
            ON patient_index(workspace_dir, last_name, first_name);
        CREATE INDEX IF NOT EXISTS idx_patient_workspace_search
            ON patient_index(workspace_dir, search_text);
        CREATE TABLE IF NOT EXISTS patient_treatment_index (
            workspace_dir TEXT NOT NULL,
            patient_folder TEXT NOT NULL,
            folder_name TEXT NOT NULL,
            folder_date TEXT NOT NULL,
            treatment_name TEXT NOT NULL,
            PRIMARY KEY (workspace_dir, patient_folder, folder_name)
        );
        CREATE INDEX IF NOT EXISTS idx_treatment_workspace_patient_date
            ON patient_treatment_index(workspace_dir, patient_folder, folder_date, folder_name);
        ",
    )
    .map_err(|e| e.to_string())?;

    if let Err(err) = conn.execute(
        "ALTER TABLE patient_index ADD COLUMN patient_id TEXT NOT NULL DEFAULT ''",
        [],
    ) {
        let msg = err.to_string();
        if !msg.contains("duplicate column name") {
            return Err(msg);
        }
    }

    Ok(conn)
}

fn split_patient_name(folder_name: &str) -> (String, String) {
    if let Some(idx) = folder_name.find(',') {
        let last = folder_name[..idx].trim().to_string();
        let first = strip_patient_id_suffix(folder_name[idx + 1..].trim());
        return (last, first);
    }
    (folder_name.trim().to_string(), String::new())
}

fn is_valid_patient_folder_name(folder_name: &str) -> bool {
    if folder_name.is_empty() || folder_name.trim() != folder_name {
        return false;
    }
    if folder_name.matches(',').count() != 1 {
        return false;
    }
    let Some(comma_idx) = folder_name.find(',') else {
        return false;
    };
    let last_name = &folder_name[..comma_idx];
    let rest_with_space = &folder_name[comma_idx + 1..];
    if last_name.is_empty() || last_name.trim() != last_name {
        return false;
    }
    if !rest_with_space.starts_with(' ') {
        return false;
    }
    let first_and_id = rest_with_space.trim_start();
    if first_and_id.is_empty() || first_and_id.trim() != first_and_id {
        return false;
    }

    if let Some(open_idx) = first_and_id.rfind(" (") {
        if !first_and_id.ends_with(')') || open_idx + 2 >= first_and_id.len() - 1 {
            return false;
        }
        let first_name = &first_and_id[..open_idx];
        let id_part = &first_and_id[open_idx + 2..first_and_id.len() - 1];
        if first_name.is_empty() || first_name.trim() != first_name || id_part.trim().is_empty() {
            return false;
        }
        if first_name.contains(',')
            || id_part.contains(',')
            || first_name.contains('(')
            || first_name.contains(')')
            || id_part.contains('(')
            || id_part.contains(')')
        {
            return false;
        }
        return true;
    }

    !first_and_id.contains(',')
        && !first_and_id.contains('(')
        && !first_and_id.contains(')')
}

fn strip_patient_id_suffix(first_name: &str) -> String {
    let trimmed = first_name.trim();
    if trimmed.ends_with(')') {
        if let Some(open_idx) = trimmed.rfind(" (") {
            if open_idx + 2 < trimmed.len() - 1 {
                return trimmed[..open_idx].trim().to_string();
            }
        }
    }
    trimmed.to_string()
}

#[derive(Serialize, Deserialize, Default)]
#[serde(default)]
struct PatientMetadata {
    id: String,
    keywords: Vec<String>,
    searchterms: Vec<String>,
}

#[derive(Serialize)]
struct PatientSearchRow {
    folder_name: String,
    patient_id: String,
}

#[derive(Serialize)]
struct InvalidPatientFoldersRow {
    invalid_count: u64,
    invalid_folders: Vec<String>,
    invalid_files: Vec<String>,
    has_more: bool,
}

#[derive(Serialize)]
struct PatientTreatmentRow {
    folder_name: String,
    folder_date: String,
    treatment_name: String,
}

#[derive(Serialize)]
struct PatientFolderOverviewRow {
    folder_name: String,
    folder_date: String,
    treatment_name: String,
    preview_paths: Vec<String>,
}

#[derive(Serialize)]
struct PatientOverviewRow {
    treatment_folders: Vec<PatientFolderOverviewRow>,
    root_files: Vec<TreatmentFileRow>,
}

#[derive(Serialize)]
struct TreatmentFileRow {
    path: String,
    name: String,
    size: u64,
    created_ms: u64,
    modified_ms: u64,
    is_image: bool,
}

#[derive(Serialize)]
struct TreatmentFilePageRow {
    total_count: u64,
    has_more: bool,
    rows: Vec<TreatmentFileRow>,
}

#[derive(Serialize)]
struct PatientSearchPageRow {
    rows: Vec<PatientSearchRow>,
    has_more: bool,
}

#[derive(Serialize)]
struct ImportWizardFileRow {
    path: String,
    name: String,
    size: u64,
    created_ms: u64,
    modified_ms: u64,
    is_image: bool,
}

#[derive(Serialize)]
struct ImagePreviewKindRow {
    path: String,
    kind: String,
}

#[derive(Serialize)]
struct ImagePreviewRow {
    path: String,
    kind: String,
    data_url: Option<String>,
}

#[derive(Serialize)]
struct CachedImagePreviewRow {
    path: String,
    kind: String,
    preview_path: Option<String>,
    data_url: Option<String>,
}

#[derive(Serialize)]
struct CachedPreviewPathRow {
    path: String,
    preview_path: Option<String>,
}

#[derive(Serialize, Deserialize, Default)]
struct PreviewCacheEntry {
    file_name: String,
    size: u64,
    last_access_ms: u64,
}

#[derive(Serialize, Deserialize, Default)]
struct PreviewCacheIndex {
    entries: HashMap<String, PreviewCacheEntry>,
}

#[derive(Serialize)]
struct PreviewCacheStatsRow {
    used_bytes: u64,
    max_bytes: u64,
    used_percent: f64,
}

#[derive(Serialize, Clone, Default)]
struct PreviewDebugCountsRow {
    db_image_count: u64,
    cache_image_count: u64,
}

#[derive(Clone, Default)]
struct PreviewDebugCountsCacheEntry {
    row: PreviewDebugCountsRow,
    updated_ms: u64,
    running: bool,
}

#[derive(Serialize, Clone)]
struct LocalCacheCopyStatusRow {
    enabled: bool,
    running: bool,
    state: String,
    last_sync_ms: Option<u64>,
    local_cache_exists: bool,
    local_cache_file_count: u64,
}

#[derive(Default)]
struct LocalCacheCopyRuntime {
    state: String,
    last_sync_ms: Option<u64>,
}

#[derive(Serialize)]
struct StartImportResponse {
    job_id: u64,
    target_folder: String,
    created_new_folder: bool,
}

#[derive(Serialize)]
struct SystemUpdateResult {
    updated: bool,
    version: Option<String>,
}

#[derive(Serialize, Clone)]
struct ImportProgressEvent {
    job_id: u64,
    percent: f64,
    done: bool,
    error: Option<String>,
}

#[derive(Serialize, Clone)]
struct ImportPreviewReadyEvent {
    path: String,
    preview_path: String,
}

#[derive(Serialize, Clone)]
struct ImportWizardCompletedEvent {
    workspace_dir: String,
    patient_folder: String,
    target_folder: String,
    job_id: Option<u64>,
    import_wizard_dir: Option<String>,
}

#[derive(Serialize, Clone)]
struct PreviewFillStatusEvent {
    running: bool,
}

#[derive(Serialize, Clone)]
struct PreviewFillProgressEvent {
    running: bool,
    message: String,
    completed: u64,
    total: u64,
}

#[derive(Serialize, Clone, Default)]
struct WorkspaceReindexStatus {
    running: bool,
    workspace_dir: String,
    completed: u64,
    total: u64,
    indexed_count: u64,
    message: String,
    error: Option<String>,
}

static IMPORT_JOB_COUNTER: AtomicU64 = AtomicU64::new(1);
static IMPORT_ACTIVE_COUNT: AtomicU64 = AtomicU64::new(0);
static PREVIEW_CACHE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static PREVIEW_FILL_RUNNING: AtomicBool = AtomicBool::new(false);
static PREVIEW_FILL_CANCEL_REQUESTED: AtomicBool = AtomicBool::new(false);
static LOCAL_CACHE_COPY_RUNTIME: OnceLock<Mutex<LocalCacheCopyRuntime>> = OnceLock::new();
static LOCAL_CACHE_COPY_RUNNING: AtomicBool = AtomicBool::new(false);
static LOCAL_CACHE_COPY_CANCEL_REQUESTED: AtomicBool = AtomicBool::new(false);
static IMPORT_WIZARD_PREVIEW_PATH: OnceLock<Mutex<String>> = OnceLock::new();
static WORKSPACE_REINDEX_RUNNING: AtomicBool = AtomicBool::new(false);
static WORKSPACE_REINDEX_STATUS: OnceLock<Mutex<WorkspaceReindexStatus>> = OnceLock::new();
static PREVIEW_DEBUG_COUNTS_CACHE: OnceLock<Mutex<HashMap<String, PreviewDebugCountsCacheEntry>>> =
    OnceLock::new();
static HEAVY_IO_TASK_RUNNING: AtomicBool = AtomicBool::new(false);

const PREVIEW_CACHE_DIM: u32 = 200;
const PREVIEW_CACHE_QUALITY: u8 = 52;
const QUICK_PREVIEW_DIM: u32 = 84;
const QUICK_PREVIEW_QUALITY: u8 = 44;
const PREVIEW_CACHE_MAX_AGE_DAYS: u64 = 90;
const PREVIEW_PREFETCH_FOLDERS: usize = 3;
const PREVIEW_PREFETCH_IMAGES_PER_FOLDER: usize = 40;
const LOCAL_CACHE_COPY_DIR_NAME: &str = ".preview-cache";
const IMPORT_PREVIEW_MICROBATCH_SIZE: usize = 2;
const PREVIEW_DEBUG_COUNTS_CACHE_TTL_MS: u64 = 15_000;
const PREVIEW_PERF_GENTLE: &str = "gentle";
const PREVIEW_PERF_AUTO: &str = "auto";
const PREVIEW_PERF_FAST: &str = "fast";

fn normalize_preview_performance_mode(raw: &str) -> String {
    let mode = raw.trim().to_ascii_lowercase();
    match mode.as_str() {
        PREVIEW_PERF_GENTLE => PREVIEW_PERF_GENTLE.to_string(),
        PREVIEW_PERF_FAST => PREVIEW_PERF_FAST.to_string(),
        _ => PREVIEW_PERF_AUTO.to_string(),
    }
}

fn preview_worker_count_for_mode(mode: &str, logical_cores: usize) -> usize {
    let cores = logical_cores.max(1);
    match mode {
        PREVIEW_PERF_GENTLE => {
            if cores <= 4 { 1 } else { 2 }
        }
        PREVIEW_PERF_FAST => {
            let workers = ((cores as f64) * 0.80).round() as usize;
            workers.max(2).min(cores)
        }
        _ => {
            if cores <= 2 {
                1
            } else if cores <= 6 {
                2
            } else if cores <= 10 {
                3
            } else {
                4
            }
        }
    }
}

fn patient_metadata_path(folder_path: &PathBuf) -> PathBuf {
    folder_path.join(".mpm-metadata.json")
}

fn read_patient_metadata(folder_path: &PathBuf) -> Option<PatientMetadata> {
    let path = patient_metadata_path(folder_path);
    if !path.exists() {
        return None;
    }

    let content = fs::read_to_string(path).ok()?;
    serde_json::from_str::<PatientMetadata>(&content).ok()
}

fn read_patient_metadata_value(folder_path: &PathBuf) -> Option<Value> {
    let path = patient_metadata_path(folder_path);
    if !path.exists() {
        return None;
    }

    let content = fs::read_to_string(path).ok()?;
    serde_json::from_str::<Value>(&content).ok()
}

fn metadata_id_from_value(value: &Value) -> String {
    let Some(obj) = value.as_object() else {
        return String::new();
    };
    let Some(id_val) = obj.get("id") else {
        return String::new();
    };

    match id_val {
        Value::String(s) => s.trim().to_string(),
        Value::Number(n) => n.to_string(),
        Value::Bool(b) => b.to_string(),
        _ => String::new(),
    }
}

fn collect_metadata_tokens(value: &Value, out: &mut Vec<String>) {
    match value {
        Value::Null => {}
        Value::Bool(b) => out.push(b.to_string().to_lowercase()),
        Value::Number(n) => out.push(n.to_string().to_lowercase()),
        Value::String(s) => {
            let t = s.trim();
            if !t.is_empty() {
                out.push(t.to_lowercase());
            }
        }
        Value::Array(items) => {
            for item in items {
                collect_metadata_tokens(item, out);
            }
        }
        Value::Object(map) => {
            for (_, v) in map {
                collect_metadata_tokens(v, out);
            }
        }
    }
}

fn build_search_text(last_name: &str, first_name: &str, metadata_text: &str) -> String {
    format!("{}, {} {}", last_name, first_name, metadata_text)
        .trim()
        .to_lowercase()
}

fn parse_treatment_folder_components(name: &str) -> Option<(String, String)> {
    if name.len() < 12 {
        return None;
    }
    let b = name.as_bytes();
    if b.get(4) != Some(&b'-') || b.get(7) != Some(&b'-') || b.get(10) != Some(&b' ') {
        return None;
    }
    let is_digit = |idx: usize| b.get(idx).map(|c| c.is_ascii_digit()).unwrap_or(false);
    if !(0..4).all(is_digit) || !(5..7).all(is_digit) || !(8..10).all(is_digit) {
        return None;
    }
    let date = name[..10].to_string();
    let treatment = name[11..].trim().to_string();
    if treatment.is_empty() {
        return None;
    }
    Some((date, treatment))
}

fn resolve_unique_target_path(dir: &Path, file_name: &str) -> PathBuf {
    let candidate = dir.join(file_name);
    if !candidate.exists() {
        return candidate;
    }

    let path = Path::new(file_name);
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("file")
        .to_string();
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");

    let mut n: u32 = 1;
    loop {
        let name = if ext.is_empty() {
            format!("{stem} ({n})")
        } else {
            format!("{stem} ({n}).{ext}")
        };
        let p = dir.join(name);
        if !p.exists() {
            return p;
        }
        n += 1;
    }
}

fn ensure_treatment_index_row(
    conn: &Connection,
    workspace_dir: &str,
    patient_folder: &str,
    folder_name: &str,
) -> Result<(), String> {
    let (folder_date, treatment_name) = parse_treatment_folder_components(folder_name)
        .ok_or_else(|| "invalid treatment folder format".to_string())?;

    conn.execute(
        "INSERT INTO patient_treatment_index (workspace_dir, patient_folder, folder_name, folder_date, treatment_name)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(workspace_dir, patient_folder, folder_name) DO UPDATE SET
           folder_date = excluded.folder_date,
           treatment_name = excluded.treatment_name",
        params![workspace_dir, patient_folder, folder_name, folder_date, treatment_name],
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

fn is_supported_preview_image(path: &Path) -> bool {
    let Some(ext) = path.extension().and_then(|e| e.to_str()) else {
        return false;
    };
    matches!(ext.to_ascii_lowercase().as_str(), "jpg" | "jpeg" | "png")
}

fn classify_image_ratio(width: usize, height: usize) -> String {
    if width == 0 || height == 0 {
        return "other".to_string();
    }
    let ratio = width as f64 / height as f64;
    if (ratio - 1.0).abs() <= 0.08 {
        "square".to_string()
    } else if ratio > 1.08 {
        "landscape".to_string()
    } else if ratio < 0.92 {
        "portrait".to_string()
    } else {
        "other".to_string()
    }
}

fn generate_preview_data_url(path: &Path) -> Option<String> {
    let reader = image::ImageReader::open(path).ok()?;
    let img = reader.decode().ok()?;
    let thumb = img.thumbnail(20, 20);
    let mut bytes = Vec::new();
    {
        let mut cursor = Cursor::new(&mut bytes);
        thumb
            .write_to(&mut cursor, image::ImageFormat::Png)
            .ok()?;
    }
    let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
    Some(format!("data:image/png;base64,{}", b64))
}

fn generate_quick_preview_data_url(path: &Path) -> Option<String> {
    let reader = image::ImageReader::open(path).ok()?;
    let img = reader.decode().ok()?;
    let thumb = img.thumbnail(QUICK_PREVIEW_DIM, QUICK_PREVIEW_DIM).to_rgb8();
    let mut bytes = Vec::new();
    let mut encoder =
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, QUICK_PREVIEW_QUALITY);
    encoder
        .encode_image(&image::DynamicImage::ImageRgb8(thumb))
        .ok()?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
    Some(format!("data:image/jpeg;base64,{}", b64))
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn preview_cache_lock() -> &'static Mutex<()> {
    PREVIEW_CACHE_LOCK.get_or_init(|| Mutex::new(()))
}

fn import_wizard_preview_path_store() -> &'static Mutex<String> {
    IMPORT_WIZARD_PREVIEW_PATH.get_or_init(|| Mutex::new(String::new()))
}

fn local_cache_copy_runtime() -> &'static Mutex<LocalCacheCopyRuntime> {
    LOCAL_CACHE_COPY_RUNTIME.get_or_init(|| Mutex::new(LocalCacheCopyRuntime {
        state: "up_to_date".to_string(),
        last_sync_ms: None,
    }))
}

fn workspace_reindex_status_store() -> &'static Mutex<WorkspaceReindexStatus> {
    WORKSPACE_REINDEX_STATUS.get_or_init(|| Mutex::new(WorkspaceReindexStatus::default()))
}

fn preview_debug_counts_store() -> &'static Mutex<HashMap<String, PreviewDebugCountsCacheEntry>> {
    PREVIEW_DEBUG_COUNTS_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

struct HeavyIoTaskGuard;

impl HeavyIoTaskGuard {
    fn acquire() -> Option<Self> {
        if HEAVY_IO_TASK_RUNNING
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
        {
            Some(Self)
        } else {
            None
        }
    }
}

impl Drop for HeavyIoTaskGuard {
    fn drop(&mut self) {
        HEAVY_IO_TASK_RUNNING.store(false, Ordering::Relaxed);
    }
}

fn set_local_cache_copy_runtime_state(state: &str, last_sync_ms: Option<u64>) {
    if let Ok(mut runtime) = local_cache_copy_runtime().lock() {
        runtime.state = state.to_string();
        if last_sync_ms.is_some() {
            runtime.last_sync_ms = last_sync_ms;
        }
    }
}

fn get_preview_cache_dir(app_handle: &tauri::AppHandle) -> PathBuf {
    let cache_dir = preview_cache_dir_path(app_handle);
    fs::create_dir_all(&cache_dir).ok();
    cache_dir
}

fn preview_cache_dir_path(app_handle: &tauri::AppHandle) -> PathBuf {
    let base_dir = app_handle
        .path()
        .app_cache_dir()
        .or_else(|_| app_handle.path().app_data_dir())
        .expect("failed to get app cache dir");
    base_dir.join("preview-cache")
}

fn get_active_preview_cache_dir(app_handle: &tauri::AppHandle) -> PathBuf {
    let settings = read_settings(app_handle).unwrap_or_default();
    if let Some(workspace_dir) = settings.workspace_dir {
        let workspace = PathBuf::from(workspace_dir.trim());
        if workspace.exists() && workspace.is_dir() {
            let main_cache_dir = get_local_cache_copy_dir(&workspace);
            fs::create_dir_all(&main_cache_dir).ok();
            if settings.keep_local_cache_copy.unwrap_or(false) {
                return get_preview_cache_dir(app_handle);
            }
            return main_cache_dir;
        }
    }
    get_preview_cache_dir(app_handle)
}

fn get_local_cache_copy_dir(workspace: &Path) -> PathBuf {
    workspace.join(LOCAL_CACHE_COPY_DIR_NAME)
}

fn paths_point_to_same_location(left: &Path, right: &Path) -> bool {
    match (fs::canonicalize(left), fs::canonicalize(right)) {
        (Ok(a), Ok(b)) => a == b,
        _ => left == right,
    }
}

fn path_is_inside_dir(path: &Path, dir: &Path) -> bool {
    let path_canon = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let dir_canon = fs::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf());
    path_canon.starts_with(&dir_canon)
}

fn import_wizard_cache_dir_is_protected(app_handle: &tauri::AppHandle, folder: &Path) -> bool {
    let candidate = folder.join(".preview-cache");
    let _ = fs::create_dir_all(&candidate);

    let active_cache_dir = get_active_preview_cache_dir(app_handle);
    if paths_point_to_same_location(&candidate, &active_cache_dir) {
        return true;
    }

    let local_cache_dir = preview_cache_dir_path(app_handle);
    let _ = fs::create_dir_all(&local_cache_dir);
    if paths_point_to_same_location(&candidate, &local_cache_dir) {
        return true;
    }

    let settings = read_settings(app_handle).unwrap_or_default();
    if let Some(workspace_dir) = settings.workspace_dir {
        let workspace = PathBuf::from(workspace_dir.trim());
        if workspace.exists() && workspace.is_dir() {
            let workspace_main_cache_dir = get_local_cache_copy_dir(&workspace);
            let _ = fs::create_dir_all(&workspace_main_cache_dir);
            if paths_point_to_same_location(&candidate, &workspace_main_cache_dir) {
                return true;
            }
        }
    }

    false
}

fn is_cache_preview_jpeg(path: &Path) -> bool {
    path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| {
            let ext = e.to_ascii_lowercase();
            ext == "jpg" || ext == "jpeg"
        })
        .unwrap_or(false)
}

fn walk_cache_files(cache_dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![cache_dir.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_dir() {
                stack.push(path);
                continue;
            }
            if file_type.is_file() {
                out.push(path);
            }
        }
    }
    out
}

fn list_cache_files(cache_dir: &Path) -> HashMap<String, (PathBuf, u64, u64)> {
    let mut out = HashMap::new();
    for path in walk_cache_files(cache_dir) {
            if path.parent() != Some(cache_dir) {
                // cache index addresses flat file names in cache root; ignore nested entries here
                continue;
            }
            let Some(name) = path.file_name().and_then(|s| s.to_str()) else {
                continue;
            };
            if name.ends_with(".tmp") {
                continue;
            }
            let Ok(meta) = fs::metadata(&path) else {
                continue;
            };
            let modified_ms = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            out.insert(name.to_string(), (path, meta.len(), modified_ms));
    }
    out
}

fn copy_if_newer(src_path: &Path, src_size: u64, src_modified_ms: u64, dst_path: &Path) -> Result<bool, String> {
    let mut should_copy = true;
    if let Ok(meta) = fs::metadata(dst_path) {
        let dst_size = meta.len();
        let dst_modified_ms = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        should_copy = src_size != dst_size || src_modified_ms > dst_modified_ms;
    }
    if !should_copy {
        return Ok(false);
    }

    let tmp_path = dst_path.with_extension("tmp");
    fs::copy(src_path, &tmp_path).map_err(|e| e.to_string())?;
    fs::rename(&tmp_path, dst_path).map_err(|e| e.to_string())?;
    Ok(true)
}

fn copy_preview_cache_main_to_local(main_cache_dir: &Path, local_cache_dir: &Path) -> Result<(), String> {
    fs::create_dir_all(local_cache_dir).map_err(|e| e.to_string())?;
    let main_files = list_cache_files(main_cache_dir);
    for (_, (src_path, src_size, src_modified_ms)) in main_files {
        if LOCAL_CACHE_COPY_CANCEL_REQUESTED.load(Ordering::Relaxed)
            || PREVIEW_FILL_CANCEL_REQUESTED.load(Ordering::Relaxed)
        {
            return Err("cancelled".to_string());
        }
        let Some(file_name) = src_path.file_name() else {
            continue;
        };
        let dst_path = local_cache_dir.join(file_name);
        let _ = copy_if_newer(&src_path, src_size, src_modified_ms, &dst_path)?;
    }
    Ok(())
}

fn reconcile_preview_cache_dirs(main_cache_dir: &Path, local_cache_dir: &Path) -> Result<(), String> {
    fs::create_dir_all(local_cache_dir).map_err(|e| e.to_string())?;
    let main_files = list_cache_files(main_cache_dir);
    let local_files = list_cache_files(local_cache_dir);

    let mut file_names: HashSet<String> = main_files.keys().cloned().collect();
    file_names.extend(local_files.keys().cloned());

    for file_name in file_names {
        if LOCAL_CACHE_COPY_CANCEL_REQUESTED.load(Ordering::Relaxed)
            || PREVIEW_FILL_CANCEL_REQUESTED.load(Ordering::Relaxed)
        {
            return Err("cancelled".to_string());
        }
        match (main_files.get(&file_name), local_files.get(&file_name)) {
            (Some((main_path, main_size, main_modified_ms)), Some((local_path, local_size, local_modified_ms))) => {
                if main_modified_ms >= local_modified_ms {
                    let _ = copy_if_newer(main_path, *main_size, *main_modified_ms, local_path)?;
                } else {
                    let _ = copy_if_newer(local_path, *local_size, *local_modified_ms, main_path)?;
                }
            }
            (Some((main_path, main_size, main_modified_ms)), None) => {
                let dst_path = local_cache_dir.join(&file_name);
                let _ = copy_if_newer(main_path, *main_size, *main_modified_ms, &dst_path)?;
            }
            (None, Some((local_path, local_size, local_modified_ms))) => {
                let dst_path = main_cache_dir.join(&file_name);
                let _ = copy_if_newer(local_path, *local_size, *local_modified_ms, &dst_path)?;
            }
            (None, None) => {}
        }
    }
    Ok(())
}

fn mirror_cache_dir_from_source(source_cache_dir: &Path, target_cache_dir: &Path) -> Result<(), String> {
    fs::create_dir_all(target_cache_dir).map_err(|e| e.to_string())?;
    let source_files = list_cache_files(source_cache_dir);
    let target_files = list_cache_files(target_cache_dir);

    for (file_name, (src_path, src_size, src_modified_ms)) in &source_files {
        if LOCAL_CACHE_COPY_CANCEL_REQUESTED.load(Ordering::Relaxed)
            || PREVIEW_FILL_CANCEL_REQUESTED.load(Ordering::Relaxed)
        {
            return Err("cancelled".to_string());
        }
        let dst_path = target_cache_dir.join(file_name);
        let _ = copy_if_newer(src_path, *src_size, *src_modified_ms, &dst_path)?;
    }

    for file_name in target_files.keys() {
        if LOCAL_CACHE_COPY_CANCEL_REQUESTED.load(Ordering::Relaxed)
            || PREVIEW_FILL_CANCEL_REQUESTED.load(Ordering::Relaxed)
        {
            return Err("cancelled".to_string());
        }
        if source_files.contains_key(file_name) {
            continue;
        }
        let _ = fs::remove_file(target_cache_dir.join(file_name));
    }

    Ok(())
}

fn enforce_cache_files_match_index(cache_dir: &Path) -> Result<(), String> {
    let mut index = load_preview_cache_index(cache_dir);
    index.entries.retain(|_, entry| fs::metadata(cache_dir.join(&entry.file_name)).is_ok());

    let known_files: HashSet<String> = index
        .entries
        .values()
        .map(|entry| entry.file_name.clone())
        .collect();

    for path in walk_cache_files(cache_dir) {
        if !is_cache_preview_jpeg(&path) {
            continue;
        }
        let in_root = path.parent() == Some(cache_dir);
        let Some(file_name) = path.file_name().and_then(|s| s.to_str()) else {
            continue;
        };
        if !in_root || !known_files.contains(file_name) {
            let _ = fs::remove_file(path);
        }
    }

    save_preview_cache_index(cache_dir, &index)
}

fn local_cache_copy_status_row(
    app_handle: &tauri::AppHandle,
    enabled: bool,
    running: bool,
    runtime: &LocalCacheCopyRuntime,
) -> LocalCacheCopyStatusRow {
    let state = if !enabled {
        "disabled".to_string()
    } else if running {
        runtime.state.clone()
    } else if runtime.state.is_empty() {
        "up_to_date".to_string()
    } else {
        runtime.state.clone()
    };
    LocalCacheCopyStatusRow {
        enabled,
        running,
        state,
        last_sync_ms: runtime.last_sync_ms,
        local_cache_exists: preview_cache_dir_path(app_handle).exists(),
        local_cache_file_count: walk_cache_files(&preview_cache_dir_path(app_handle)).len() as u64,
    }
}

fn run_local_cache_copy_sync(
    app_handle: &tauri::AppHandle,
    workspace: &Path,
    initial_copy: bool,
) -> Result<(), String> {
    if !workspace.exists() || !workspace.is_dir() {
        return Err("workspace directory does not exist".to_string());
    }

    let main_cache_dir = get_local_cache_copy_dir(workspace);
    let local_cache_dir = get_preview_cache_dir(app_handle);
    fs::create_dir_all(&main_cache_dir).map_err(|e| e.to_string())?;
    let phase = if initial_copy { "copying" } else { "updating" };
    set_local_cache_copy_runtime_state(phase, None);

    let _guard = preview_cache_lock().lock().map_err(|e| e.to_string())?;
    LOCAL_CACHE_COPY_CANCEL_REQUESTED.store(false, Ordering::Relaxed);
    if initial_copy {
        // On first enable, prime local cache and then reconcile both directions.
        // This guarantees missing files are copied no matter which side has them.
        copy_preview_cache_main_to_local(&main_cache_dir, &local_cache_dir)?;
    }
    reconcile_preview_cache_dirs(&main_cache_dir, &local_cache_dir)?;
    let settings = read_settings(app_handle).unwrap_or_default();
    let cache_size_gb = settings.cache_size_gb.unwrap_or(5).clamp(1, 10);
    let max_cache_bytes = (cache_size_gb as u64) * 1024 * 1024 * 1024;
    cleanup_preview_cache_for_workspace_dir(app_handle, &main_cache_dir, workspace, max_cache_bytes);
    if LOCAL_CACHE_COPY_CANCEL_REQUESTED.load(Ordering::Relaxed)
        || PREVIEW_FILL_CANCEL_REQUESTED.load(Ordering::Relaxed)
    {
        set_local_cache_copy_runtime_state("paused", None);
        return Err("cancelled".to_string());
    }
    enforce_cache_files_match_index(&main_cache_dir)?;
    // Keep local copy as exact mirror of the workspace main cache after each sync.
    mirror_cache_dir_from_source(&main_cache_dir, &local_cache_dir)?;
    enforce_cache_files_match_index(&local_cache_dir)?;
    if LOCAL_CACHE_COPY_CANCEL_REQUESTED.load(Ordering::Relaxed)
        || PREVIEW_FILL_CANCEL_REQUESTED.load(Ordering::Relaxed)
    {
        set_local_cache_copy_runtime_state("paused", None);
        return Err("cancelled".to_string());
    }
    set_local_cache_copy_runtime_state("up_to_date", Some(now_ms()));
    Ok(())
}

fn sync_local_cache_copy_if_enabled(app_handle: &tauri::AppHandle, workspace_dir: &str) {
    let settings = read_settings(app_handle).unwrap_or_default();
    if !settings.keep_local_cache_copy.unwrap_or(false) {
        return;
    }
    let workspace = PathBuf::from(workspace_dir.trim());
    if !workspace.exists() || !workspace.is_dir() {
        return;
    }
    if LOCAL_CACHE_COPY_RUNNING
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return;
    }
    let _ = run_local_cache_copy_sync(app_handle, &workspace, false);
    LOCAL_CACHE_COPY_RUNNING.store(false, Ordering::Relaxed);
}

fn schedule_local_cache_copy_sync_if_enabled(app_handle: &tauri::AppHandle) {
    let settings = read_settings(app_handle).unwrap_or_default();
    if !settings.keep_local_cache_copy.unwrap_or(false) {
        return;
    }
    if IMPORT_ACTIVE_COUNT.load(Ordering::Relaxed) > 0 {
        return;
    }
    let Some(workspace_dir) = settings.workspace_dir else {
        return;
    };
    let workspace_dir = workspace_dir.trim().to_string();
    if workspace_dir.is_empty() {
        return;
    }
    let app_handle_clone = app_handle.clone();
    tauri::async_runtime::spawn_blocking(move || {
        sync_local_cache_copy_if_enabled(&app_handle_clone, &workspace_dir);
    });
}

fn preview_cache_index_path(cache_dir: &Path) -> PathBuf {
    cache_dir.join("index.json")
}

fn load_preview_cache_index(cache_dir: &Path) -> PreviewCacheIndex {
    let path = preview_cache_index_path(cache_dir);
    if !path.exists() {
        return PreviewCacheIndex::default();
    }
    let content = match fs::read_to_string(path) {
        Ok(c) => c,
        Err(_) => return PreviewCacheIndex::default(),
    };
    serde_json::from_str::<PreviewCacheIndex>(&content).unwrap_or_default()
}

fn save_preview_cache_index(cache_dir: &Path, index: &PreviewCacheIndex) -> Result<(), String> {
    let path = preview_cache_index_path(cache_dir);
    let json = serde_json::to_string(index).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())
}

fn build_preview_cache_key(path: &Path, file_size: u64, modified_ms: u64) -> String {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    let normalized_path = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    normalized_path.to_string_lossy().hash(&mut hasher);
    file_size.hash(&mut hasher);
    modified_ms.hash(&mut hasher);
    PREVIEW_CACHE_DIM.hash(&mut hasher);
    PREVIEW_CACHE_QUALITY.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

fn build_preview_cache_key_legacy(path: &Path, file_size: u64, modified_ms: u64) -> String {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    path.to_string_lossy().hash(&mut hasher);
    file_size.hash(&mut hasher);
    modified_ms.hash(&mut hasher);
    PREVIEW_CACHE_DIM.hash(&mut hasher);
    PREVIEW_CACHE_QUALITY.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

fn generate_preview_cache_bytes(path: &Path) -> Result<Vec<u8>, String> {
    let reader = image::ImageReader::open(path).map_err(|e| e.to_string())?;
    let img = reader.decode().map_err(|e| e.to_string())?;
    let thumb = img.thumbnail(PREVIEW_CACHE_DIM, PREVIEW_CACHE_DIM).to_rgb8();
    let mut bytes = Vec::new();
    let mut encoder =
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, PREVIEW_CACHE_QUALITY);
    encoder
        .encode_image(&image::DynamicImage::ImageRgb8(thumb))
        .map_err(|e| e.to_string())?;
    Ok(bytes)
}

fn cleanup_preview_cache(
    cache_dir: &Path,
    index: &mut PreviewCacheIndex,
    max_cache_bytes: u64,
) {
    if PREVIEW_FILL_CANCEL_REQUESTED.load(Ordering::Relaxed)
        || LOCAL_CACHE_COPY_CANCEL_REQUESTED.load(Ordering::Relaxed)
    {
        return;
    }
    let now = now_ms();
    let max_age_ms = PREVIEW_CACHE_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;

    index.entries.retain(|_, entry| {
        let file_path = cache_dir.join(&entry.file_name);
        if !file_path.exists() {
            return false;
        }
        if now.saturating_sub(entry.last_access_ms) > max_age_ms {
            let _ = fs::remove_file(file_path);
            return false;
        }
        true
    });

    let mut total_bytes = 0_u64;
    let mut items: Vec<(String, u64, u64, String)> = Vec::new();
    for (key, entry) in &index.entries {
        if PREVIEW_FILL_CANCEL_REQUESTED.load(Ordering::Relaxed)
            || LOCAL_CACHE_COPY_CANCEL_REQUESTED.load(Ordering::Relaxed)
        {
            break;
        }
        let path = cache_dir.join(&entry.file_name);
        let size = fs::metadata(&path).map(|m| m.len()).unwrap_or(entry.size);
        total_bytes = total_bytes.saturating_add(size);
        items.push((key.clone(), entry.last_access_ms, size, entry.file_name.clone()));
    }

    if total_bytes <= max_cache_bytes {
        return;
    }

    items.sort_by_key(|(_, last_access_ms, _, _)| *last_access_ms);
    for (key, _, size, file_name) in items {
        if PREVIEW_FILL_CANCEL_REQUESTED.load(Ordering::Relaxed)
            || LOCAL_CACHE_COPY_CANCEL_REQUESTED.load(Ordering::Relaxed)
        {
            break;
        }
        if total_bytes <= max_cache_bytes {
            break;
        }
        let _ = fs::remove_file(cache_dir.join(file_name));
        index.entries.remove(&key);
        total_bytes = total_bytes.saturating_sub(size);
    }

    // Remove orphan preview jpg files that are no longer referenced by the cache index.
    // This prevents duplicate legacy/new-key files from accumulating indefinitely.
    let known_files: HashSet<String> = index
        .entries
        .values()
        .map(|entry| entry.file_name.clone())
        .collect();
    if let Ok(entries) = fs::read_dir(cache_dir) {
        for entry in entries.flatten() {
            if PREVIEW_FILL_CANCEL_REQUESTED.load(Ordering::Relaxed)
                || LOCAL_CACHE_COPY_CANCEL_REQUESTED.load(Ordering::Relaxed)
            {
                break;
            }
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let is_preview_jpg = is_cache_preview_jpeg(&path);
            if !is_preview_jpg {
                continue;
            }
            let file_name = match path.file_name().and_then(|s| s.to_str()) {
                Some(v) => v,
                None => continue,
            };
            if !known_files.contains(file_name) {
                let _ = fs::remove_file(path);
            }
        }
    }
}

fn compute_preview_cache_used_bytes(cache_dir: &Path) -> u64 {
    let mut used_bytes = 0_u64;
    if let Ok(entries) = fs::read_dir(cache_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let is_preview_jpg = is_cache_preview_jpeg(&path);
            if !is_preview_jpg {
                continue;
            }
            if let Ok(meta) = fs::metadata(&path) {
                used_bytes = used_bytes.saturating_add(meta.len());
            }
        }
    }
    used_bytes
}

fn compute_preview_cache_image_count(cache_dir: &Path) -> u64 {
    let mut image_count = 0_u64;
    if let Ok(entries) = fs::read_dir(cache_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let is_preview_jpg = is_cache_preview_jpeg(&path);
            if is_preview_jpg {
                image_count = image_count.saturating_add(1);
            }
        }
    }
    image_count
}

fn resolve_existing_cache_file_path(cache_dir: &Path, path_buf: &Path, file_size: u64, modified_ms: u64) -> PathBuf {
    let key = build_preview_cache_key(path_buf, file_size, modified_ms);
    let cache_file_path = cache_dir.join(format!("{key}.jpg"));
    if cache_file_path.exists() {
        return cache_file_path;
    }

    let legacy_key = build_preview_cache_key_legacy(path_buf, file_size, modified_ms);
    let legacy_cache_file_path = cache_dir.join(format!("{legacy_key}.jpg"));
    if legacy_cache_file_path.exists() {
        return legacy_cache_file_path;
    }

    cache_file_path
}

fn is_valid_cached_preview_bytes(bytes: &[u8]) -> bool {
    // Cache previews are written as JPEG files.
    if bytes.len() < 4 {
        return false;
    }
    bytes[0] == 0xFF
        && bytes[1] == 0xD8
        && bytes[bytes.len() - 2] == 0xFF
        && bytes[bytes.len() - 1] == 0xD9
}

fn is_valid_cached_preview_file(path: &Path) -> bool {
    let Ok(bytes) = fs::read(path) else {
        return false;
    };
    is_valid_cached_preview_bytes(&bytes)
}

fn seed_active_preview_cache_from_import_wizard_cache(
    app_handle: &tauri::AppHandle,
    import_wizard_cache_dir: &Path,
    source_path: &Path,
    target_path: &Path,
) -> Result<(), String> {
    if !import_wizard_cache_dir.exists() || !import_wizard_cache_dir.is_dir() {
        return Ok(());
    }
    if !is_supported_preview_image(source_path) || !is_supported_preview_image(target_path) {
        return Ok(());
    }

    let src_meta = fs::metadata(source_path).map_err(|e| e.to_string())?;
    let src_size = src_meta.len();
    let src_modified_ms = src_meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let src_preview_path = resolve_existing_cache_file_path(
        import_wizard_cache_dir,
        source_path,
        src_size,
        src_modified_ms,
    );
    if !src_preview_path.exists() {
        return Ok(());
    }

    let dst_meta = fs::metadata(target_path).map_err(|e| e.to_string())?;
    let dst_size = dst_meta.len();
    let dst_modified_ms = dst_meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let dst_key = build_preview_cache_key(target_path, dst_size, dst_modified_ms);
    let file_name = format!("{dst_key}.jpg");
    let active_cache_dir = get_active_preview_cache_dir(app_handle);
    fs::create_dir_all(&active_cache_dir).map_err(|e| e.to_string())?;
    let dst_preview_path = active_cache_dir.join(&file_name);
    if !dst_preview_path.exists() {
        fs::copy(&src_preview_path, &dst_preview_path).map_err(|e| e.to_string())?;
    }

    let _guard = preview_cache_lock().lock().map_err(|e| e.to_string())?;
    let mut index = load_preview_cache_index(&active_cache_dir);
    let cached_size = fs::metadata(&dst_preview_path)
        .map(|m| m.len())
        .unwrap_or(0);
    index.entries.insert(
        dst_key,
        PreviewCacheEntry {
            file_name,
            size: cached_size,
            last_access_ms: now_ms(),
        },
    );
    save_preview_cache_index(&active_cache_dir, &index)
}

fn emit_preview_fill_progress(
    app_handle: &tauri::AppHandle,
    running: bool,
    message: impl Into<String>,
    completed: u64,
    total: u64,
) {
    let _ = app_handle.emit(
        "preview-fill-progress",
        PreviewFillProgressEvent {
            running,
            message: message.into(),
            completed,
            total,
        },
    );
}

fn set_workspace_reindex_status(
    app_handle: &tauri::AppHandle,
    running: bool,
    workspace_dir: &str,
    completed: u64,
    total: u64,
    indexed_count: u64,
    message: impl Into<String>,
    error: Option<String>,
) {
    let status = WorkspaceReindexStatus {
        running,
        workspace_dir: workspace_dir.to_string(),
        completed,
        total,
        indexed_count,
        message: message.into(),
        error,
    };
    if let Ok(mut current) = workspace_reindex_status_store().lock() {
        *current = status.clone();
    }
    let _ = app_handle.emit("workspace-reindex-progress", status);
}

fn run_preview_cache_cleanup(app_handle: &tauri::AppHandle) {
    let Ok(_guard) = preview_cache_lock().lock() else {
        return;
    };
    let cache_dir = get_active_preview_cache_dir(app_handle);
    let settings = read_settings(app_handle).unwrap_or_default();
    let cache_size_gb = settings.cache_size_gb.unwrap_or(5).clamp(1, 10);
    let max_cache_bytes = (cache_size_gb as u64) * 1024 * 1024 * 1024;
    let mut index = load_preview_cache_index(&cache_dir);
    cleanup_preview_cache(&cache_dir, &mut index, max_cache_bytes);
    index.entries.retain(|_, entry| {
        let path = cache_dir.join(&entry.file_name);
        fs::metadata(&path).is_ok()
    });
    let _ = save_preview_cache_index(&cache_dir, &index);
}

fn collect_workspace_expected_preview_files(workspace: &Path) -> HashSet<String> {
    let mut expected = HashSet::new();
    let mut stack = vec![workspace.to_path_buf()];

    while let Some(dir) = stack.pop() {
        if PREVIEW_FILL_CANCEL_REQUESTED.load(Ordering::Relaxed)
            || LOCAL_CACHE_COPY_CANCEL_REQUESTED.load(Ordering::Relaxed)
        {
            break;
        }
        let entries = match fs::read_dir(&dir) {
            Ok(v) => v,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            if PREVIEW_FILL_CANCEL_REQUESTED.load(Ordering::Relaxed)
                || LOCAL_CACHE_COPY_CANCEL_REQUESTED.load(Ordering::Relaxed)
            {
                break;
            }
            let path = entry.path();
            let file_type = match entry.file_type() {
                Ok(v) => v,
                Err(_) => continue,
            };
            if file_type.is_dir() {
                stack.push(path);
                continue;
            }
            if !file_type.is_file() || !is_supported_preview_image(&path) {
                continue;
            }
            let meta = match fs::metadata(&path) {
                Ok(v) => v,
                Err(_) => continue,
            };
            let file_size = meta.len();
            let modified_ms = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            let key = build_preview_cache_key(&path, file_size, modified_ms);
            expected.insert(format!("{key}.jpg"));
        }
    }

    expected
}

fn collect_workspace_expected_preview_files_from_db(
    app_handle: &tauri::AppHandle,
    workspace: &Path,
) -> Result<HashSet<String>, String> {
    let workspace_dir = workspace.to_string_lossy().to_string();
    let conn = open_db(app_handle)?;
    let mut expected = HashSet::new();

    let mut stmt = conn
        .prepare(
            "SELECT patient_folder, folder_name
             FROM patient_treatment_index
             WHERE workspace_dir = ?1",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![workspace_dir], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| e.to_string())?;

    for row in rows {
        if PREVIEW_FILL_CANCEL_REQUESTED.load(Ordering::Relaxed)
            || LOCAL_CACHE_COPY_CANCEL_REQUESTED.load(Ordering::Relaxed)
        {
            break;
        }
        let (patient_folder, treatment_folder) = row.map_err(|e| e.to_string())?;
        let treatment_path = workspace.join(patient_folder).join(treatment_folder);
        if !treatment_path.exists() || !treatment_path.is_dir() {
            continue;
        }
        let entries = match fs::read_dir(&treatment_path) {
            Ok(v) => v,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            if PREVIEW_FILL_CANCEL_REQUESTED.load(Ordering::Relaxed)
                || LOCAL_CACHE_COPY_CANCEL_REQUESTED.load(Ordering::Relaxed)
            {
                break;
            }
            let path = entry.path();
            if !path.is_file() || !is_supported_preview_image(&path) {
                continue;
            }
            let meta = match fs::metadata(&path) {
                Ok(v) => v,
                Err(_) => continue,
            };
            let file_size = meta.len();
            let modified_ms = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            let key = build_preview_cache_key(&path, file_size, modified_ms);
            expected.insert(format!("{key}.jpg"));
        }
    }

    Ok(expected)
}

fn run_preview_cache_cleanup_for_workspace(app_handle: &tauri::AppHandle, workspace: &Path) {
    let Ok(_guard) = preview_cache_lock().lock() else {
        return;
    };
    let cache_dir = get_active_preview_cache_dir(app_handle);
    let settings = read_settings(app_handle).unwrap_or_default();
    let cache_size_gb = settings.cache_size_gb.unwrap_or(5).clamp(1, 10);
    let max_cache_bytes = (cache_size_gb as u64) * 1024 * 1024 * 1024;
    cleanup_preview_cache_for_workspace_dir(app_handle, &cache_dir, workspace, max_cache_bytes);
}

fn cleanup_preview_cache_for_workspace_dir(
    app_handle: &tauri::AppHandle,
    cache_dir: &Path,
    workspace: &Path,
    max_cache_bytes: u64,
) {
    if PREVIEW_FILL_CANCEL_REQUESTED.load(Ordering::Relaxed)
        || LOCAL_CACHE_COPY_CANCEL_REQUESTED.load(Ordering::Relaxed)
    {
        return;
    }
    let mut index = load_preview_cache_index(&cache_dir);

    cleanup_preview_cache(&cache_dir, &mut index, max_cache_bytes);
    let expected = collect_workspace_expected_preview_files_from_db(app_handle, workspace)
        .unwrap_or_else(|_| collect_workspace_expected_preview_files(workspace));

    if let Ok(entries) = fs::read_dir(&cache_dir) {
        for entry in entries.flatten() {
            if PREVIEW_FILL_CANCEL_REQUESTED.load(Ordering::Relaxed)
                || LOCAL_CACHE_COPY_CANCEL_REQUESTED.load(Ordering::Relaxed)
            {
                break;
            }
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let is_preview_jpg = is_cache_preview_jpeg(&path);
            if !is_preview_jpg {
                continue;
            }
            let Some(file_name) = path.file_name().and_then(|s| s.to_str()) else {
                continue;
            };
            if !expected.contains(file_name) {
                let _ = fs::remove_file(&path);
            }
        }
    }

    index.entries.retain(|_, entry| {
        expected.contains(&entry.file_name) && fs::metadata(cache_dir.join(&entry.file_name)).is_ok()
    });
    let _ = save_preview_cache_index(&cache_dir, &index);
}

fn emit_import_preview_ready_events(
    app_handle: &tauri::AppHandle,
    rows: &[CachedImagePreviewRow],
) {
    for row in rows {
        let path = row.path.trim().to_string();
        let preview_path = row.preview_path.clone().unwrap_or_default().trim().to_string();
        if path.is_empty() || preview_path.is_empty() {
            continue;
        }
        let _ = app_handle.emit(
            "import-preview-ready",
            ImportPreviewReadyEvent { path, preview_path },
        );
    }
}

fn resolve_cached_previews(
    app_handle: &tauri::AppHandle,
    paths: &[String],
    include_data_url: bool,
    generate_if_missing: bool,
) -> Result<Vec<CachedImagePreviewRow>, String> {
    let settings = read_settings(app_handle).unwrap_or_default();
    let cache_dir = get_active_preview_cache_dir(app_handle);
    let cache_size_gb = settings.cache_size_gb.unwrap_or(5).clamp(1, 10);
    let max_cache_bytes = (cache_size_gb as u64) * 1024 * 1024 * 1024;
    let preview_perf_mode = normalize_preview_performance_mode(
        settings
            .preview_performance_mode
            .as_deref()
            .unwrap_or(PREVIEW_PERF_AUTO),
    );
    resolve_cached_previews_in_cache_dir(
        paths,
        include_data_url,
        generate_if_missing,
        &cache_dir,
        max_cache_bytes,
        &preview_perf_mode,
    )
}

fn resolve_cached_previews_in_cache_dir(
    paths: &[String],
    include_data_url: bool,
    generate_if_missing: bool,
    cache_dir: &Path,
    max_cache_bytes: u64,
    preview_perf_mode: &str,
) -> Result<Vec<CachedImagePreviewRow>, String> {
    let _guard = preview_cache_lock().lock().map_err(|e| e.to_string())?;
    fs::create_dir_all(cache_dir).map_err(|e| e.to_string())?;
    let mut index = load_preview_cache_index(cache_dir);
    let current_ms = now_ms();
    let mut index_changed = false;

    struct PlannedRow {
        path: String,
        source_path: PathBuf,
        kind: String,
        cache_key: String,
        file_name: String,
        cache_file_path: PathBuf,
    }
    struct GenerateTask {
        row_index: usize,
        source_path: PathBuf,
        cache_file_path: PathBuf,
        file_name: String,
    }
    enum RowState {
        Skip,
        Ready(CachedImagePreviewRow),
        Planned(PlannedRow),
    }

    let mut rows: Vec<RowState> = Vec::with_capacity(paths.len());
    let mut tasks: Vec<GenerateTask> = Vec::new();

    for raw_path in paths {
        let path = raw_path.clone();
        if path.is_empty() {
            rows.push(RowState::Skip);
            continue;
        }

        let path_buf = PathBuf::from(&path);
        if !is_supported_preview_image(&path_buf) {
            rows.push(RowState::Ready(CachedImagePreviewRow {
                path,
                kind: "none".to_string(),
                preview_path: None,
                data_url: None,
            }));
            continue;
        }

        let kind = match imagesize::size(&path_buf) {
            Ok(size) => classify_image_ratio(size.width, size.height),
            Err(_) => "other".to_string(),
        };

        let file_meta = match fs::metadata(&path_buf) {
            Ok(meta) => meta,
            Err(_) => {
                rows.push(RowState::Ready(CachedImagePreviewRow {
                    path,
                    kind,
                    preview_path: None,
                    data_url: None,
                }));
                continue;
            }
        };
        let file_size = file_meta.len();
        let modified_ms = file_meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let cache_key = build_preview_cache_key(&path_buf, file_size, modified_ms);
        let file_name = format!("{cache_key}.jpg");
        let cache_file_path = cache_dir.join(&file_name);
        let legacy_cache_key = build_preview_cache_key_legacy(&path_buf, file_size, modified_ms);
        let legacy_cache_file_path = cache_dir.join(format!("{legacy_cache_key}.jpg"));

        if !cache_file_path.exists() && legacy_cache_file_path.exists() {
            let _ = fs::rename(&legacy_cache_file_path, &cache_file_path);
        }
        if cache_file_path.exists() && !is_valid_cached_preview_file(&cache_file_path) {
            let _ = fs::remove_file(&cache_file_path);
        }

        if !cache_file_path.exists() && generate_if_missing {
            tasks.push(GenerateTask {
                row_index: rows.len(),
                source_path: path_buf.clone(),
                cache_file_path: cache_file_path.clone(),
                file_name: file_name.clone(),
            });
        }

        rows.push(RowState::Planned(PlannedRow {
            path,
            source_path: path_buf,
            kind,
            cache_key,
            file_name,
            cache_file_path,
        }));
    }

    if generate_if_missing && !tasks.is_empty() {
        let queue = Arc::new(Mutex::new(VecDeque::from(tasks)));
        let logical_cores = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(1);
        let worker_count = preview_worker_count_for_mode(preview_perf_mode, logical_cores);
        let (tx, rx) = std::sync::mpsc::channel::<(usize, u64)>();
        let mut handles = Vec::new();

        for worker_id in 0..worker_count {
            let queue_clone = Arc::clone(&queue);
            let tx_clone = tx.clone();
            handles.push(std::thread::spawn(move || {
                loop {
                    if PREVIEW_FILL_CANCEL_REQUESTED.load(Ordering::Relaxed)
                        || LOCAL_CACHE_COPY_CANCEL_REQUESTED.load(Ordering::Relaxed)
                    {
                        break;
                    }
                    let task = {
                        let Ok(mut q) = queue_clone.lock() else {
                            break;
                        };
                        q.pop_front()
                    };
                    let Some(task) = task else {
                        break;
                    };

                    if task.cache_file_path.exists() {
                        let size = fs::metadata(&task.cache_file_path).map(|m| m.len()).unwrap_or(0);
                        let _ = tx_clone.send((task.row_index, size));
                        continue;
                    }

                    let bytes = match generate_preview_cache_bytes(&task.source_path) {
                        Ok(v) => v,
                        Err(_) => continue,
                    };
                    let tmp_path = task.cache_file_path.with_file_name(format!(
                        "{}.tmp{}",
                        task.file_name, worker_id
                    ));
                    if fs::write(&tmp_path, &bytes).is_err() {
                        let _ = fs::remove_file(&tmp_path);
                        continue;
                    }
                    if fs::rename(&tmp_path, &task.cache_file_path).is_err() {
                        let _ = fs::remove_file(&tmp_path);
                        continue;
                    }
                    let _ = tx_clone.send((task.row_index, bytes.len() as u64));
                }
            }));
        }
        drop(tx);

        let mut generated_sizes: HashMap<usize, u64> = HashMap::new();
        for (row_index, size) in rx {
            generated_sizes.insert(row_index, size);
        }
        for handle in handles {
            let _ = handle.join();
        }

        for (row_index, size) in generated_sizes {
            let Some(RowState::Planned(planned)) = rows.get(row_index) else {
                continue;
            };
            index.entries.insert(
                planned.cache_key.clone(),
                PreviewCacheEntry {
                    file_name: planned.file_name.clone(),
                    size,
                    last_access_ms: current_ms,
                },
            );
            index_changed = true;
        }
    }

    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        match row {
            RowState::Skip => {}
            RowState::Ready(v) => out.push(v),
            RowState::Planned(planned) => {
                if !planned.cache_file_path.exists() {
                    out.push(CachedImagePreviewRow {
                        path: planned.path,
                        kind: planned.kind,
                        preview_path: None,
                        data_url: None,
                    });
                    continue;
                }

                if generate_if_missing {
                    let cached_size = fs::metadata(&planned.cache_file_path)
                        .map(|m| m.len())
                        .unwrap_or(0);
                    index.entries.insert(
                        planned.cache_key.clone(),
                        PreviewCacheEntry {
                            file_name: planned.file_name.clone(),
                            size: cached_size,
                            last_access_ms: current_ms,
                        },
                    );
                    index_changed = true;
                }

                out.push(CachedImagePreviewRow {
                    path: planned.path,
                    kind: planned.kind,
                    preview_path: Some(planned.cache_file_path.to_string_lossy().to_string()),
                    data_url: if include_data_url {
                        let mut bytes = fs::read(&planned.cache_file_path).ok().unwrap_or_default();
                        let mut valid_cached_preview = is_valid_cached_preview_bytes(&bytes);

                        // Self-heal corrupted cache files so broken-image placeholders disappear.
                        if !valid_cached_preview && generate_if_missing {
                            if let Ok(regenerated) = generate_preview_cache_bytes(&planned.source_path) {
                                if fs::write(&planned.cache_file_path, &regenerated).is_ok() {
                                    let regenerated_size = regenerated.len() as u64;
                                    index.entries.insert(
                                        planned.cache_key.clone(),
                                        PreviewCacheEntry {
                                            file_name: planned.file_name.clone(),
                                            size: regenerated_size,
                                            last_access_ms: current_ms,
                                        },
                                    );
                                    index_changed = true;
                                    bytes = regenerated;
                                    valid_cached_preview = true;
                                }
                            }
                        }

                        if valid_cached_preview {
                            Some(format!(
                                "data:image/jpeg;base64,{}",
                                base64::engine::general_purpose::STANDARD.encode(bytes)
                            ))
                        } else {
                            None
                        }
                    } else {
                        None
                    },
                });
            }
        }
    }

    if generate_if_missing {
        cleanup_preview_cache(cache_dir, &mut index, max_cache_bytes);
        index_changed = true;
    }
    if index_changed {
        let _ = save_preview_cache_index(cache_dir, &index);
    }
    Ok(out)
}

fn metadata_to_search_text(metadata: &PatientMetadata) -> String {
    let mut metadata_tokens = Vec::new();
    if !metadata.id.trim().is_empty() {
        metadata_tokens.push(metadata.id.trim().to_lowercase());
    }
    metadata_tokens.extend(
        metadata
            .keywords
            .iter()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_lowercase()),
    );
    metadata_tokens.extend(
        metadata
            .searchterms
            .iter()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_lowercase()),
    );
    metadata_tokens.join(" ")
}

fn upsert_patient_index_row(
    conn: &Connection,
    workspace_dir: &str,
    folder_name: &str,
    last_name: &str,
    first_name: &str,
    patient_id: &str,
    metadata_text: &str,
) -> Result<(), String> {
    let search_text = build_search_text(last_name, first_name, metadata_text);
    conn.execute(
        "INSERT INTO patient_index (workspace_dir, folder_name, last_name, first_name, patient_id, search_text)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(workspace_dir, folder_name) DO UPDATE SET
           last_name = excluded.last_name,
           first_name = excluded.first_name,
           patient_id = excluded.patient_id,
           search_text = excluded.search_text",
        params![
            workspace_dir,
            folder_name,
            last_name,
            first_name,
            patient_id,
            search_text
        ],
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
fn create_patient_with_metadata(
    app_handle: tauri::AppHandle,
    workspace_dir: String,
    last_name: String,
    first_name: String,
    patient_id: String,
) -> Result<String, String> {
    let workspace = PathBuf::from(&workspace_dir);
    if !workspace.exists() || !workspace.is_dir() {
        return Err("workspace directory does not exist".to_string());
    }

    let last_name = last_name.trim_end();
    let first_name = first_name.trim_end();
    let patient_id = patient_id.trim();

    if last_name.trim().is_empty() || first_name.trim().is_empty() || patient_id.is_empty() {
        return Err("last name, first name and id are required".to_string());
    }

    if last_name.contains('/') || last_name.contains('\\') || first_name.contains('/') || first_name.contains('\\') {
        return Err("invalid characters in patient name".to_string());
    }

    let base_folder_name = format!("{}, {}", last_name, first_name);
    let folder_name = if workspace.join(&base_folder_name).exists() {
        format!("{base_folder_name} ({patient_id})")
    } else {
        base_folder_name
    };
    let patient_folder = workspace.join(&folder_name);
    if patient_folder.exists() {
        return Err("patient folder already exists for this name and ID".to_string());
    }

    fs::create_dir(&patient_folder).map_err(|e| e.to_string())?;

    let metadata = PatientMetadata {
        id: patient_id.to_string(),
        keywords: vec![],
        searchterms: vec![],
    };
    let metadata_json = serde_json::to_string_pretty(&metadata).map_err(|e| e.to_string())?;
    fs::write(patient_metadata_path(&patient_folder), metadata_json).map_err(|e| e.to_string())?;

    let conn = open_db(&app_handle)?;
    let workspace_key = workspace.to_string_lossy().to_string();
    let metadata_text = metadata_to_search_text(&metadata);
    upsert_patient_index_row(
        &conn,
        &workspace_key,
        &folder_name,
        last_name,
        first_name,
        patient_id,
        &metadata_text,
    )?;

    Ok(folder_name)
}

#[tauri::command]
fn save_patient_metadata(
    app_handle: tauri::AppHandle,
    workspace_dir: String,
    folder_name: String,
    id: String,
    keywords: Vec<String>,
    searchterms: Vec<String>,
) -> Result<(), String> {
    let workspace = PathBuf::from(&workspace_dir);
    if !workspace.exists() || !workspace.is_dir() {
        return Err("workspace directory does not exist".to_string());
    }

    let folder_name = folder_name.trim();
    if folder_name.is_empty() {
        return Err("folder_name is required".to_string());
    }

    let folder_path = workspace.join(folder_name);
    if !folder_path.exists() || !folder_path.is_dir() {
        return Err("patient folder does not exist".to_string());
    }

    let metadata = PatientMetadata {
        id: id.trim().to_string(),
        keywords: keywords
            .into_iter()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect(),
        searchterms: searchterms
            .into_iter()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect(),
    };
    let metadata_json = serde_json::to_string_pretty(&metadata).map_err(|e| e.to_string())?;
    fs::write(patient_metadata_path(&folder_path), metadata_json).map_err(|e| e.to_string())?;

    let (last_name, first_name) = split_patient_name(folder_name);
    let metadata_text = metadata_to_search_text(&metadata);
    let conn = open_db(&app_handle)?;
    upsert_patient_index_row(
        &conn,
        &workspace.to_string_lossy(),
        folder_name,
        &last_name,
        &first_name,
        metadata.id.as_str(),
        &metadata_text,
    )?;

    Ok(())
}

#[tauri::command]
fn save_patient_id(
    app_handle: tauri::AppHandle,
    workspace_dir: String,
    folder_name: String,
    id: String,
) -> Result<(), String> {
    let workspace = PathBuf::from(&workspace_dir);
    if !workspace.exists() || !workspace.is_dir() {
        return Err("workspace directory does not exist".to_string());
    }

    let folder_name = folder_name.trim();
    if folder_name.is_empty() {
        return Err("folder_name is required".to_string());
    }

    let id = id.trim();
    if id.is_empty() {
        return Err("id is required".to_string());
    }

    let folder_path = workspace.join(folder_name);
    if !folder_path.exists() || !folder_path.is_dir() {
        return Err("patient folder does not exist".to_string());
    }

    let metadata_path = patient_metadata_path(&folder_path);
    let mut metadata_value = read_patient_metadata_value(&folder_path).unwrap_or_else(|| json!({}));
    if !metadata_value.is_object() {
        metadata_value = json!({});
    }
    if let Some(metadata_obj) = metadata_value.as_object_mut() {
        metadata_obj.insert("id".to_string(), Value::String(id.to_string()));
        if !metadata_obj.contains_key("keywords") {
            metadata_obj.insert("keywords".to_string(), json!([]));
        }
        if !metadata_obj.contains_key("searchterms") {
            metadata_obj.insert("searchterms".to_string(), json!([]));
        }
    }
    let metadata_json = serde_json::to_string_pretty(&metadata_value).map_err(|e| e.to_string())?;
    fs::write(metadata_path, metadata_json).map_err(|e| e.to_string())?;

    let mut metadata_tokens = Vec::new();
    collect_metadata_tokens(&metadata_value, &mut metadata_tokens);
    let metadata_text = metadata_tokens.join(" ");

    let (last_name, first_name) = split_patient_name(folder_name);
    let conn = open_db(&app_handle)?;
    upsert_patient_index_row(
        &conn,
        &workspace.to_string_lossy(),
        folder_name,
        &last_name,
        &first_name,
        id,
        &metadata_text,
    )?;

    Ok(())
}

#[tauri::command]
fn load_patient_keywords(
    workspace_dir: String,
    folder_name: String,
) -> Result<Vec<String>, String> {
    let workspace = PathBuf::from(&workspace_dir);
    if !workspace.exists() || !workspace.is_dir() {
        return Err("workspace directory does not exist".to_string());
    }

    let folder_name = folder_name.trim();
    if folder_name.is_empty() {
        return Err("folder_name is required".to_string());
    }

    let folder_path = workspace.join(folder_name);
    if !folder_path.exists() || !folder_path.is_dir() {
        return Err("patient folder does not exist".to_string());
    }

    let metadata_value = read_patient_metadata_value(&folder_path);
    let Some(value) = metadata_value else {
        return Ok(vec![]);
    };

    let mut out = Vec::new();
    if let Some(obj) = value.as_object() {
        if let Some(raw_keywords) = obj.get("keywords") {
            match raw_keywords {
                Value::Array(items) => {
                    for item in items {
                        let text = item.as_str().unwrap_or("").trim();
                        if text.is_empty() {
                            continue;
                        }
                        out.push(text.to_string());
                    }
                }
                Value::String(s) => {
                    let text = s.trim();
                    if !text.is_empty() {
                        out.push(text.to_string());
                    }
                }
                _ => {}
            }
        }
    }

    let mut deduped = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for keyword in out {
        let key = keyword.to_lowercase();
        if seen.contains(&key) {
            continue;
        }
        seen.insert(key);
        deduped.push(keyword);
    }

    Ok(deduped)
}

#[tauri::command]
fn save_patient_keywords(
    app_handle: tauri::AppHandle,
    workspace_dir: String,
    folder_name: String,
    keywords: Vec<String>,
) -> Result<(), String> {
    let workspace = PathBuf::from(&workspace_dir);
    if !workspace.exists() || !workspace.is_dir() {
        return Err("workspace directory does not exist".to_string());
    }

    let folder_name = folder_name.trim();
    if folder_name.is_empty() {
        return Err("folder_name is required".to_string());
    }

    let folder_path = workspace.join(folder_name);
    if !folder_path.exists() || !folder_path.is_dir() {
        return Err("patient folder does not exist".to_string());
    }

    let mut cleaned_keywords = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for keyword in keywords {
        let trimmed = keyword.trim();
        if trimmed.is_empty() {
            continue;
        }
        let key = trimmed.to_lowercase();
        if seen.contains(&key) {
            continue;
        }
        seen.insert(key);
        cleaned_keywords.push(trimmed.to_string());
    }

    let metadata_path = patient_metadata_path(&folder_path);
    let mut metadata_value = read_patient_metadata_value(&folder_path).unwrap_or_else(|| json!({}));
    if !metadata_value.is_object() {
        metadata_value = json!({});
    }
    if let Some(metadata_obj) = metadata_value.as_object_mut() {
        metadata_obj.insert(
            "keywords".to_string(),
            Value::Array(cleaned_keywords.iter().cloned().map(Value::String).collect()),
        );
        if !metadata_obj.contains_key("id") {
            metadata_obj.insert("id".to_string(), Value::String(String::new()));
        }
        if !metadata_obj.contains_key("searchterms") {
            metadata_obj.insert("searchterms".to_string(), json!([]));
        }
    }
    let metadata_json = serde_json::to_string_pretty(&metadata_value).map_err(|e| e.to_string())?;
    fs::write(metadata_path, metadata_json).map_err(|e| e.to_string())?;

    let mut metadata_tokens = Vec::new();
    collect_metadata_tokens(&metadata_value, &mut metadata_tokens);
    let metadata_text = metadata_tokens.join(" ");
    let patient_id = metadata_id_from_value(&metadata_value);
    let (last_name, first_name) = split_patient_name(folder_name);

    let conn = open_db(&app_handle)?;
    upsert_patient_index_row(
        &conn,
        &workspace.to_string_lossy(),
        folder_name,
        &last_name,
        &first_name,
        &patient_id,
        &metadata_text,
    )?;

    Ok(())
}

#[tauri::command]
fn is_patient_id_taken(
    app_handle: tauri::AppHandle,
    workspace_dir: String,
    patient_id: String,
    exclude_folder_name: Option<String>,
) -> Result<bool, String> {
    let patient_id = patient_id.trim().to_string();
    if patient_id.is_empty() {
        return Ok(false);
    }

    let conn = open_db(&app_handle)?;
    let taken = if let Some(folder_name) = exclude_folder_name {
        let folder_name = folder_name.trim().to_string();
        conn.query_row(
            "SELECT EXISTS(
                SELECT 1
                FROM patient_index
                WHERE workspace_dir = ?1
                  AND patient_id = ?2
                  AND folder_name != ?3
             )",
            params![workspace_dir, patient_id, folder_name],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|e| e.to_string())?
            != 0
    } else {
        conn.query_row(
            "SELECT EXISTS(
                SELECT 1
                FROM patient_index
                WHERE workspace_dir = ?1
                  AND patient_id = ?2
             )",
            params![workspace_dir, patient_id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|e| e.to_string())?
            != 0
    };

    Ok(taken)
}

#[tauri::command]
fn save_workspace(app_handle: tauri::AppHandle, workspace_dir: String) -> Result<(), String> {
    let mut settings = read_settings(&app_handle)?;
    settings.workspace_dir = Some(workspace_dir);
    write_settings(&app_handle, &settings)
}

#[tauri::command]
fn save_import_wizard_dir(app_handle: tauri::AppHandle, import_wizard_dir: String) -> Result<(), String> {
    let import_wizard_dir = import_wizard_dir.trim();
    if import_wizard_dir.is_empty() {
        return Err("import wizard directory is required".to_string());
    }
    let folder = PathBuf::from(import_wizard_dir);
    if !folder.exists() || !folder.is_dir() {
        return Err("import wizard directory does not exist".to_string());
    }
    if import_wizard_cache_dir_is_protected(&app_handle, &folder) {
        return Err("import wizard folder conflicts with main/local preview cache".to_string());
    }

    let mut settings = read_settings(&app_handle)?;
    settings.import_wizard_dir = Some(folder.to_string_lossy().to_string());
    write_settings(&app_handle, &settings)
}

#[tauri::command]
fn set_import_wizard_live_preview(app_handle: tauri::AppHandle, enabled: bool) -> Result<bool, String> {
    let mut settings = read_settings(&app_handle)?;
    settings.import_wizard_live_preview = Some(enabled);
    write_settings(&app_handle, &settings)?;
    Ok(enabled)
}

#[tauri::command]
fn clear_workspace(app_handle: tauri::AppHandle) -> Result<(), String> {
    let mut settings = read_settings(&app_handle)?;
    settings.workspace_dir = None;
    write_settings(&app_handle, &settings)?;

    let conn = open_db(&app_handle)?;
    conn.execute("DELETE FROM patient_index", [])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM patient_treatment_index", [])
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
fn delete_database(app_handle: tauri::AppHandle) -> Result<(), String> {
    let db_path = get_db_path(&app_handle);
    if db_path.exists() {
        fs::remove_file(&db_path).map_err(|e| e.to_string())?;
    }
    let _ = open_db(&app_handle)?;
    Ok(())
}

#[tauri::command]
fn open_workspace_dir(workspace_dir: String) -> Result<(), String> {
    let workspace = PathBuf::from(&workspace_dir);
    if !workspace.exists() || !workspace.is_dir() {
        return Err("workspace directory does not exist".to_string());
    }

    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = Command::new("open");
        c.arg(&workspace_dir);
        c
    };

    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = Command::new("explorer");
        c.arg(&workspace_dir);
        c
    };

    #[cfg(all(unix, not(target_os = "macos")))]
    let mut cmd = {
        let mut c = Command::new("xdg-open");
        c.arg(&workspace_dir);
        c
    };

    cmd.spawn().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn open_preview_cache_dir(app_handle: tauri::AppHandle, workspace_dir: Option<String>) -> Result<(), String> {
    let settings = read_settings(&app_handle).unwrap_or_default();
    let workspace_value = workspace_dir
        .unwrap_or_else(|| settings.workspace_dir.unwrap_or_default())
        .trim()
        .to_string();
    let cache_dir = if workspace_value.is_empty() {
        get_preview_cache_dir(&app_handle)
    } else {
        let workspace = PathBuf::from(workspace_value);
        let main_cache_dir = get_local_cache_copy_dir(&workspace);
        fs::create_dir_all(&main_cache_dir).map_err(|e| e.to_string())?;
        main_cache_dir
    };
    fs::create_dir_all(&cache_dir).map_err(|e| e.to_string())?;

    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = Command::new("open");
        c.arg(&cache_dir);
        c
    };

    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = Command::new("explorer");
        c.arg(&cache_dir);
        c
    };

    #[cfg(all(unix, not(target_os = "macos")))]
    let mut cmd = {
        let mut c = Command::new("xdg-open");
        c.arg(&cache_dir);
        c
    };

    cmd.spawn().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn open_path_with_default(path: String) -> Result<(), String> {
    let target = path.trim().to_string();
    if target.is_empty() {
        return Err("path is required".to_string());
    }

    let path_buf = PathBuf::from(&target);
    if !path_buf.exists() {
        return Err("path does not exist".to_string());
    }

    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = Command::new("open");
        c.arg(&target);
        c
    };

    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = Command::new("explorer");
        c.arg(&target);
        c
    };

    #[cfg(all(unix, not(target_os = "macos")))]
    let mut cmd = {
        let mut c = Command::new("xdg-open");
        c.arg(&target);
        c
    };

    cmd.spawn().map_err(|e| e.to_string())?;
    Ok(())
}

fn copy_dir_recursive(source: &Path, destination: &Path) -> Result<(), String> {
    fs::create_dir_all(destination).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(source).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let src_path = entry.path();
        let dst_path = destination.join(entry.file_name());
        let file_type = entry.file_type().map_err(|e| e.to_string())?;
        if file_type.is_dir() {
            copy_dir_recursive(&src_path, &dst_path)?;
            continue;
        }
        if file_type.is_file() {
            fs::copy(&src_path, &dst_path).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn non_conflicting_folder_path(destination_root: &Path, folder_name: &str) -> PathBuf {
    let normalized = folder_name.trim();
    let candidate = destination_root.join(normalized);
    if !candidate.exists() {
        return candidate;
    }
    let mut index: u32 = 2;
    loop {
        let next = destination_root.join(format!("{normalized} ({index})"));
        if !next.exists() {
            return next;
        }
        index = index.saturating_add(1);
    }
}

fn non_conflicting_file_path(destination_root: &Path, file_name: &str) -> PathBuf {
    let normalized = file_name.trim();
    let candidate = destination_root.join(normalized);
    if !candidate.exists() {
        return candidate;
    }

    let source_path = Path::new(normalized);
    let stem = source_path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".to_string());
    let ext = source_path
        .extension()
        .map(|e| e.to_string_lossy().to_string())
        .unwrap_or_default();

    let mut index: u32 = 2;
    loop {
        let next_name = if ext.is_empty() {
            format!("{stem} ({index})")
        } else {
            format!("{stem} ({index}).{ext}")
        };
        let next = destination_root.join(next_name);
        if !next.exists() {
            return next;
        }
        index = index.saturating_add(1);
    }
}

fn treatment_file_row_from_entry(entry: fs::DirEntry) -> Result<Option<TreatmentFileRow>, String> {
    let file_type = entry.file_type().map_err(|e| e.to_string())?;
    if !file_type.is_file() {
        return Ok(None);
    }

    let path_buf = entry.path();
    let metadata = entry.metadata().map_err(|e| e.to_string())?;
    let modified_ms = metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let created_ms = metadata
        .created()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(modified_ms);

    Ok(Some(TreatmentFileRow {
        path: path_buf.to_string_lossy().to_string(),
        name: entry.file_name().to_string_lossy().to_string(),
        size: metadata.len(),
        created_ms,
        modified_ms,
        is_image: is_supported_preview_image(&path_buf),
    }))
}

#[tauri::command]
fn copy_treatment_folder_to_destination(
    workspace_dir: String,
    patient_folder: String,
    treatment_folder: String,
    destination_dir: String,
) -> Result<String, String> {
    let workspace = PathBuf::from(workspace_dir.trim());
    if !workspace.exists() || !workspace.is_dir() {
        return Err("workspace directory does not exist".to_string());
    }

    let patient_folder = patient_folder.trim();
    if patient_folder.is_empty() {
        return Err("patient folder is required".to_string());
    }

    let treatment_folder = treatment_folder.trim();
    if treatment_folder.is_empty() {
        return Err("treatment folder is required".to_string());
    }

    let destination_root = PathBuf::from(destination_dir.trim());
    if !destination_root.exists() || !destination_root.is_dir() {
        return Err("destination directory does not exist".to_string());
    }

    let source_folder = workspace.join(patient_folder).join(treatment_folder);
    if !source_folder.exists() || !source_folder.is_dir() {
        return Err("source treatment folder does not exist".to_string());
    }

    let destination_folder = non_conflicting_folder_path(&destination_root, treatment_folder);
    copy_dir_recursive(&source_folder, &destination_folder)?;
    Ok(destination_folder.to_string_lossy().to_string())
}

#[tauri::command]
fn copy_file_to_destination(source_path: String, destination_dir: String) -> Result<String, String> {
    let source_path = source_path.trim();
    if source_path.is_empty() {
        return Err("source path is required".to_string());
    }
    let source = PathBuf::from(source_path);
    if !source.exists() || !source.is_file() {
        return Err("source file does not exist".to_string());
    }

    let destination_dir = destination_dir.trim();
    if destination_dir.is_empty() {
        return Err("destination directory is required".to_string());
    }
    let destination_root = PathBuf::from(destination_dir);
    if !destination_root.exists() || !destination_root.is_dir() {
        return Err("destination directory does not exist".to_string());
    }

    let file_name = source
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .ok_or_else(|| "source file name is invalid".to_string())?;
    let destination_path = non_conflicting_file_path(&destination_root, &file_name);
    fs::copy(&source, &destination_path).map_err(|e| e.to_string())?;
    Ok(destination_path.to_string_lossy().to_string())
}

#[tauri::command]
fn copy_patient_folder_to_destination(
    workspace_dir: String,
    patient_folder: String,
    destination_dir: String,
) -> Result<String, String> {
    let workspace = PathBuf::from(workspace_dir.trim());
    if !workspace.exists() || !workspace.is_dir() {
        return Err("workspace directory does not exist".to_string());
    }

    let patient_folder = patient_folder.trim();
    if patient_folder.is_empty() {
        return Err("patient folder is required".to_string());
    }

    let destination_root = PathBuf::from(destination_dir.trim());
    if !destination_root.exists() || !destination_root.is_dir() {
        return Err("destination directory does not exist".to_string());
    }

    let source_folder = workspace.join(patient_folder);
    if !source_folder.exists() || !source_folder.is_dir() {
        return Err("source patient folder does not exist".to_string());
    }

    let destination_folder = non_conflicting_folder_path(&destination_root, patient_folder);
    copy_dir_recursive(&source_folder, &destination_folder)?;
    Ok(destination_folder.to_string_lossy().to_string())
}

#[tauri::command]
fn list_treatment_files(
    workspace_dir: String,
    patient_folder: String,
    treatment_folder: String,
) -> Result<Vec<TreatmentFileRow>, String> {
    let mut offset = 0usize;
    let mut out = Vec::new();
    loop {
        let page = list_treatment_files_page(
            workspace_dir.clone(),
            patient_folder.clone(),
            treatment_folder.clone(),
            offset,
            500,
        )?;
        let batch_len = page.rows.len();
        out.extend(page.rows);
        if !page.has_more || batch_len < 1 {
            break;
        }
        offset = offset.saturating_add(batch_len);
    }
    Ok(out)
}

#[tauri::command]
fn list_treatment_files_page(
    workspace_dir: String,
    patient_folder: String,
    treatment_folder: String,
    offset: usize,
    limit: usize,
) -> Result<TreatmentFilePageRow, String> {
    let workspace = PathBuf::from(workspace_dir.trim());
    if !workspace.exists() || !workspace.is_dir() {
        return Err("workspace directory does not exist".to_string());
    }

    let patient_folder = patient_folder.trim();
    if patient_folder.is_empty() {
        return Err("patient folder is required".to_string());
    }
    let treatment_folder = treatment_folder.trim();
    if treatment_folder.is_empty() {
        return Err("treatment folder is required".to_string());
    }

    let treatment_path = workspace.join(patient_folder).join(treatment_folder);
    if !treatment_path.exists() || !treatment_path.is_dir() {
        return Err("treatment folder does not exist".to_string());
    }

    let page_size = limit.clamp(1, 500);
    let mut scanned_count = 0usize;
    let mut out = Vec::with_capacity(page_size.saturating_add(1));
    for entry in fs::read_dir(&treatment_path).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let file_type = entry.file_type().map_err(|e| e.to_string())?;
        if !file_type.is_file() {
            continue;
        }
        scanned_count = scanned_count.saturating_add(1);
        if scanned_count <= offset {
            continue;
        }
        let row = match treatment_file_row_from_entry(entry)? {
            Some(v) => v,
            None => continue,
        };
        out.push(row);
        if out.len() > page_size {
            break;
        }
    }
    let has_more = out.len() > page_size;
    if has_more {
        out.truncate(page_size);
    }
    let total_count = if has_more {
        offset.saturating_add(out.len()).saturating_add(1)
    } else {
        offset.saturating_add(out.len())
    };

    Ok(TreatmentFilePageRow {
        total_count: total_count as u64,
        has_more,
        rows: out,
    })
}

#[tauri::command]
fn list_patient_overview(
    app_handle: tauri::AppHandle,
    workspace_dir: String,
    patient_folder: String,
) -> Result<PatientOverviewRow, String> {
    let workspace = PathBuf::from(workspace_dir.trim());
    if !workspace.exists() || !workspace.is_dir() {
        return Err("workspace directory does not exist".to_string());
    }

    let patient_folder = patient_folder.trim();
    if patient_folder.is_empty() {
        return Err("patient folder is required".to_string());
    }

    let patient_path = workspace.join(patient_folder);
    if !patient_path.exists() || !patient_path.is_dir() {
        return Err("patient folder does not exist".to_string());
    }

    let conn = open_db(&app_handle)?;
    let mut folder_rows: Vec<PatientFolderOverviewRow> = Vec::new();
    {
        let mut stmt = conn
            .prepare(
                "SELECT folder_name, folder_date, treatment_name
                 FROM patient_treatment_index
                 WHERE workspace_dir = ?1 AND patient_folder = ?2
                 ORDER BY folder_date DESC, folder_name DESC",
            )
            .map_err(|e| e.to_string())?;

        let mapped = stmt
            .query_map(params![workspace_dir, patient_folder], |row| {
                Ok(PatientFolderOverviewRow {
                    folder_name: row.get::<_, String>(0)?,
                    folder_date: row.get::<_, String>(1)?,
                    treatment_name: row.get::<_, String>(2)?,
                    preview_paths: Vec::new(),
                })
            })
            .map_err(|e| e.to_string())?;

        for row in mapped {
            folder_rows.push(row.map_err(|e| e.to_string())?);
        }
    }

    for folder in &mut folder_rows {
        let folder_name = folder.folder_name.trim().to_string();
        if folder_name.is_empty() {
            continue;
        }
        let folder_path = patient_path.join(&folder_name);
        if !folder_path.exists() || !folder_path.is_dir() {
            continue;
        }
        let mut image_paths: Vec<String> = Vec::new();
        for entry in fs::read_dir(&folder_path).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let file_type = entry.file_type().map_err(|e| e.to_string())?;
            if !file_type.is_file() {
                continue;
            }
            let path_buf = entry.path();
            if !is_supported_preview_image(&path_buf) {
                continue;
            }
            image_paths.push(path_buf.to_string_lossy().to_string());
        }
        image_paths.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()));
        folder.preview_paths = image_paths.into_iter().take(3).collect();
    }

    let mut root_files: Vec<TreatmentFileRow> = Vec::new();
    for entry in fs::read_dir(&patient_path).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if let Some(row) = treatment_file_row_from_entry(entry)? {
            if row.name == ".mpm-metadata.json" {
                continue;
            }
            root_files.push(row);
        }
    }
    root_files.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

    Ok(PatientOverviewRow {
        treatment_folders: folder_rows,
        root_files,
    })
}

#[tauri::command]
fn list_import_wizard_files(folder_dir: String) -> Result<Vec<ImportWizardFileRow>, String> {
    let folder_dir = folder_dir.trim();
    if folder_dir.is_empty() {
        return Err("folder directory is required".to_string());
    }

    let folder = PathBuf::from(folder_dir);
    if !folder.exists() || !folder.is_dir() {
        return Err("folder directory does not exist".to_string());
    }

    let mut out = Vec::new();
    for entry in fs::read_dir(&folder).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let file_type = entry.file_type().map_err(|e| e.to_string())?;
        if !file_type.is_file() {
            continue;
        }

        let path_buf = entry.path();
        let metadata = entry.metadata().map_err(|e| e.to_string())?;
        let modified_ms = metadata
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let created_ms = metadata
            .created()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(modified_ms);

        out.push(ImportWizardFileRow {
            path: path_buf.to_string_lossy().to_string(),
            name: entry.file_name().to_string_lossy().to_string(),
            size: metadata.len(),
            created_ms,
            modified_ms,
            is_image: is_supported_preview_image(&path_buf),
        });
    }

    out.sort_by(|a, b| {
        b.modified_ms
            .cmp(&a.modified_ms)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(out)
}

#[tauri::command]
fn ensure_import_wizard_preview_cache(app_handle: tauri::AppHandle, folder_dir: String) -> Result<String, String> {
    let folder_dir = folder_dir.trim();
    if folder_dir.is_empty() {
        return Err("folder directory is required".to_string());
    }

    let folder = PathBuf::from(folder_dir);
    if !folder.exists() || !folder.is_dir() {
        return Err("folder directory does not exist".to_string());
    }
    if import_wizard_cache_dir_is_protected(&app_handle, &folder) {
        return Err("import wizard folder conflicts with main/local preview cache".to_string());
    }

    let cache_dir = folder.join(".preview-cache");
    fs::create_dir_all(&cache_dir).map_err(|e| e.to_string())?;
    Ok(cache_dir.to_string_lossy().to_string())
}

fn clear_import_wizard_preview_cache_for_folder(folder: &Path) -> Result<(), String> {
    let cache_dir = folder.join(".preview-cache");
    fs::create_dir_all(&cache_dir).map_err(|e| e.to_string())?;

    if let Ok(entries) = fs::read_dir(&cache_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_dir() {
                let _ = fs::remove_dir_all(&path);
            } else {
                let _ = fs::remove_file(&path);
            }
        }
    }

    save_preview_cache_index(&cache_dir, &PreviewCacheIndex::default())
}

#[tauri::command]
fn clear_import_wizard_preview_cache(app_handle: tauri::AppHandle, folder_dir: String) -> Result<bool, String> {
    let folder_dir = folder_dir.trim();
    if folder_dir.is_empty() {
        return Err("folder directory is required".to_string());
    }

    let folder = PathBuf::from(folder_dir);
    if !folder.exists() || !folder.is_dir() {
        return Err("folder directory does not exist".to_string());
    }
    if import_wizard_cache_dir_is_protected(&app_handle, &folder) {
        return Err("refusing to clear protected preview cache directory".to_string());
    }

    clear_import_wizard_preview_cache_for_folder(&folder)?;
    Ok(true)
}

#[tauri::command]
fn open_import_wizard_preview_window(app_handle: tauri::AppHandle, path: String) -> Result<bool, String> {
    let path = path.trim().to_string();
    if path.is_empty() {
        return Err("path is required".to_string());
    }
    let source = PathBuf::from(&path);
    if !source.exists() || !source.is_file() {
        return Err("preview source file does not exist".to_string());
    }
    if let Ok(mut current) = import_wizard_preview_path_store().lock() {
        *current = path.clone();
    }

    let label = "import_wizard_preview";
    let window = if let Some(existing) = app_handle.get_webview_window(label) {
        existing
    } else {
        let settings = read_settings(&app_handle).unwrap_or_default();
        let state = settings.import_wizard_preview_window_state;
        let (width, height) = match state {
            Some(s) if !s.maximized => {
                let w = s.width.max(420).min(1600);
                let h = s.height.max(320).min(1200);
                (w, h)
            }
            _ => (820, 620),
        };

        tauri::WebviewWindowBuilder::new(
            &app_handle,
            label,
            tauri::WebviewUrl::App("import-preview.html".into()),
        )
        .title("Import Live Preview")
        .inner_size(width as f64, height as f64)
        .min_inner_size(520.0, 420.0)
        .resizable(true)
        .center()
        .build()
        .map_err(|e| e.to_string())?
    };

    window.show().map_err(|e| e.to_string())?;
    window
        .emit("import-wizard-preview-file", serde_json::json!({ "path": path }))
        .map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command]
fn get_import_wizard_preview_data_url(path: String) -> Result<String, String> {
    let path = path.trim().to_string();
    if path.is_empty() {
        return Err("path is required".to_string());
    }
    let source = PathBuf::from(&path);
    if !source.exists() || !source.is_file() {
        return Err("preview source file does not exist".to_string());
    }

    let ext = source
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    let mime = match ext.as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        "tif" | "tiff" => "image/tiff",
        _ => "application/octet-stream",
    };

    let bytes = fs::read(&source).map_err(|e| e.to_string())?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
    Ok(format!("data:{mime};base64,{b64}"))
}

#[tauri::command]
fn close_import_wizard_preview_window(app_handle: tauri::AppHandle) -> Result<bool, String> {
    if let Ok(mut current) = import_wizard_preview_path_store().lock() {
        current.clear();
    }
    let Some(window) = app_handle.get_webview_window("import_wizard_preview") else {
        return Ok(false);
    };
    window.close().map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command]
fn close_import_wizard_helper_window(app_handle: tauri::AppHandle) -> Result<bool, String> {
    let Some(window) = app_handle.get_webview_window("import_wizard_helper") else {
        return Ok(false);
    };
    window.close().map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command]
fn get_current_import_wizard_preview_path() -> Result<String, String> {
    let current = import_wizard_preview_path_store()
        .lock()
        .map_err(|e| e.to_string())?;
    Ok(current.clone())
}

#[tauri::command]
fn notify_import_wizard_completed(
    app_handle: tauri::AppHandle,
    workspace_dir: String,
    patient_folder: String,
    target_folder: String,
    job_id: Option<u64>,
    import_wizard_dir: Option<String>,
) -> Result<bool, String> {
    app_handle
        .emit(
            "import-wizard-completed",
            ImportWizardCompletedEvent {
                workspace_dir: workspace_dir.trim().to_string(),
                patient_folder: patient_folder.trim().to_string(),
                target_folder: target_folder.trim().to_string(),
                job_id,
                import_wizard_dir: import_wizard_dir
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty()),
            },
        )
        .map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command]
fn remove_import_wizard_cached_preview(
    app_handle: tauri::AppHandle,
    folder_dir: String,
    path: String,
) -> Result<bool, String> {
    let folder_dir = folder_dir.trim();
    if folder_dir.is_empty() {
        return Err("folder directory is required".to_string());
    }
    let folder = PathBuf::from(folder_dir);
    if !folder.exists() || !folder.is_dir() {
        return Err("folder directory does not exist".to_string());
    }
    if import_wizard_cache_dir_is_protected(&app_handle, &folder) {
        return Err("refusing to modify protected preview cache directory".to_string());
    }

    let path = path.trim();
    if path.is_empty() {
        return Err("path is required".to_string());
    }
    let source_path = PathBuf::from(path);
    if !is_supported_preview_image(&source_path) {
        return Ok(false);
    }

    let file_meta = fs::metadata(&source_path).map_err(|e| e.to_string())?;
    let file_size = file_meta.len();
    let modified_ms = file_meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    let cache_key = build_preview_cache_key(&source_path, file_size, modified_ms);
    let legacy_key = build_preview_cache_key_legacy(&source_path, file_size, modified_ms);
    let cache_dir = folder.join(".preview-cache");
    fs::create_dir_all(&cache_dir).map_err(|e| e.to_string())?;

    let _guard = preview_cache_lock().lock().map_err(|e| e.to_string())?;
    let mut index = load_preview_cache_index(&cache_dir);

    let mut changed = false;
    let mut candidate_keys = vec![cache_key.clone(), legacy_key.clone()];
    candidate_keys.sort();
    candidate_keys.dedup();

    for key in candidate_keys {
        if let Some(entry) = index.entries.remove(&key) {
            let _ = fs::remove_file(cache_dir.join(entry.file_name));
            changed = true;
        } else {
            let _ = fs::remove_file(cache_dir.join(format!("{key}.jpg")));
        }
    }

    if changed {
        save_preview_cache_index(&cache_dir, &index)?;
    }
    Ok(changed)
}

#[tauri::command]
fn list_patient_treatment_folders(
    app_handle: tauri::AppHandle,
    workspace_dir: String,
    patient_folder: String,
) -> Result<Vec<String>, String> {
    let patient_folder = patient_folder.trim();
    if patient_folder.is_empty() {
        return Err("patient folder is required".to_string());
    }

    let conn = open_db(&app_handle)?;
    let mut out = Vec::new();
    let mut stmt = conn
        .prepare(
            "SELECT folder_name
             FROM patient_treatment_index
             WHERE workspace_dir = ?1 AND patient_folder = ?2
             ORDER BY folder_date COLLATE NOCASE, folder_name COLLATE NOCASE",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map(params![workspace_dir, patient_folder], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    for row in rows {
        out.push(row.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

#[tauri::command]
fn list_patient_timeline_entries(
    app_handle: tauri::AppHandle,
    workspace_dir: String,
    patient_folder: String,
) -> Result<Vec<PatientTreatmentRow>, String> {
    let patient_folder = patient_folder.trim();
    if patient_folder.is_empty() {
        return Err("patient folder is required".to_string());
    }

    let conn = open_db(&app_handle)?;
    let mut out = Vec::new();
    let mut stmt = conn
        .prepare(
            "SELECT folder_name, folder_date, treatment_name
             FROM patient_treatment_index
             WHERE workspace_dir = ?1 AND patient_folder = ?2
             ORDER BY folder_date COLLATE NOCASE, folder_name COLLATE NOCASE",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map(params![workspace_dir, patient_folder], |row| {
            Ok(PatientTreatmentRow {
                folder_name: row.get::<_, String>(0)?,
                folder_date: row.get::<_, String>(1)?,
                treatment_name: row.get::<_, String>(2)?,
            })
        })
        .map_err(|e| e.to_string())?;
    for row in rows {
        out.push(row.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

fn reindex_patient_folders_internal<F>(
    app_handle: &tauri::AppHandle,
    workspace: &Path,
    mut on_progress: F,
) -> Result<usize, String>
where
    F: FnMut(u64, u64),
{
    if !workspace.exists() || !workspace.is_dir() {
        on_progress(0, 0);
        return Ok(0);
    }

    let mut patient_dirs: Vec<(String, PathBuf)> = Vec::new();
    for entry in fs::read_dir(workspace).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let file_type = entry.file_type().map_err(|e| e.to_string())?;
        if !file_type.is_dir() {
            continue;
        }
        let folder_name = entry.file_name().to_string_lossy().into_owned();
        if folder_name.starts_with('.') || !is_valid_patient_folder_name(&folder_name) {
            continue;
        }
        patient_dirs.push((folder_name, entry.path()));
    }

    let total = patient_dirs.len() as u64;
    on_progress(0, total);

    let mut folders: Vec<(String, String, String, String, String)> = Vec::new();
    let mut treatment_rows: Vec<(String, String, String, String)> = Vec::new();

    for (index, (folder_name, patient_path)) in patient_dirs.into_iter().enumerate() {
        let (last_name, first_name) = split_patient_name(&folder_name);
        let metadata = read_patient_metadata(&patient_path);
        let metadata_value = read_patient_metadata_value(&patient_path);
        let mut patient_id = String::new();
        let mut metadata_tokens = Vec::new();
        if let Some(meta) = metadata {
            patient_id = meta.id.trim().to_string();
            if !patient_id.is_empty() {
                metadata_tokens.push(patient_id.to_lowercase());
            }
            metadata_tokens.extend(meta.keywords.into_iter().map(|s| s.to_lowercase()));
            metadata_tokens.extend(meta.searchterms.into_iter().map(|s| s.to_lowercase()));
        }
        if let Some(value) = metadata_value {
            if patient_id.is_empty() {
                patient_id = metadata_id_from_value(&value);
            }
            collect_metadata_tokens(&value, &mut metadata_tokens);
        }
        let metadata_text = metadata_tokens.join(" ");
        folders.push((folder_name.clone(), last_name, first_name, patient_id, metadata_text));

        for child in fs::read_dir(&patient_path).map_err(|e| e.to_string())? {
            let child = child.map_err(|e| e.to_string())?;
            let child_type = child.file_type().map_err(|e| e.to_string())?;
            if !child_type.is_dir() {
                continue;
            }
            let child_name = child.file_name().to_string_lossy().into_owned();
            if let Some((folder_date, treatment_name)) = parse_treatment_folder_components(&child_name) {
                treatment_rows.push((folder_name.clone(), child_name, folder_date, treatment_name));
            }
        }

        let completed = (index + 1) as u64;
        on_progress(completed, total);
    }

    folders.sort_by_key(|(_, last_name, first_name, _, _)| {
        (last_name.to_lowercase(), first_name.to_lowercase())
    });

    let workspace_dir = workspace.to_string_lossy().to_string();
    let mut conn = open_db(app_handle)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "DELETE FROM patient_index WHERE workspace_dir = ?1",
        params![workspace_dir.clone()],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "DELETE FROM patient_treatment_index WHERE workspace_dir = ?1",
        params![workspace_dir.clone()],
    )
    .map_err(|e| e.to_string())?;

    for (folder_name, last_name, first_name, patient_id, metadata_text) in &folders {
        let search_text = build_search_text(last_name, first_name, metadata_text);
        tx.execute(
            "INSERT INTO patient_index (workspace_dir, folder_name, last_name, first_name, patient_id, search_text)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                workspace_dir.clone(),
                folder_name,
                last_name,
                first_name,
                patient_id,
                search_text
            ],
        )
        .map_err(|e| e.to_string())?;
    }

    for (patient_folder, folder_name, folder_date, treatment_name) in &treatment_rows {
        tx.execute(
            "INSERT INTO patient_treatment_index (workspace_dir, patient_folder, folder_name, folder_date, treatment_name)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                workspace_dir.clone(),
                patient_folder,
                folder_name,
                folder_date,
                treatment_name
            ],
        )
        .map_err(|e| e.to_string())?;
    }

    tx.commit().map_err(|e| e.to_string())?;
    Ok(folders.len())
}

#[tauri::command]
fn reindex_patient_folders(app_handle: tauri::AppHandle, workspace_dir: String) -> Result<usize, String> {
    let workspace = PathBuf::from(workspace_dir);
    reindex_patient_folders_internal(&app_handle, &workspace, |_completed, _total| {})
}

#[tauri::command]
fn get_workspace_reindex_status() -> Result<WorkspaceReindexStatus, String> {
    workspace_reindex_status_store()
        .lock()
        .map(|status| status.clone())
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn start_workspace_reindex(
    app_handle: tauri::AppHandle,
    workspace_dir: String,
) -> Result<bool, String> {
    let workspace_dir = workspace_dir.trim().to_string();
    if workspace_dir.is_empty() {
        return Err("workspace directory is required".to_string());
    }
    let workspace = PathBuf::from(&workspace_dir);
    if !workspace.exists() || !workspace.is_dir() {
        return Err("workspace directory does not exist".to_string());
    }

    if WORKSPACE_REINDEX_RUNNING
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Ok(false);
    }

    set_workspace_reindex_status(
        &app_handle,
        true,
        &workspace_dir,
        0,
        0,
        0,
        "Preparing",
        None,
    );

    let app_handle_clone = app_handle.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut last_emitted_completed = 0_u64;
        let mut last_emitted_total = 0_u64;
        let result = reindex_patient_folders_internal(
            &app_handle_clone,
            &workspace,
            |completed, total| {
                // Avoid flooding the frontend with progress events for very large directories.
                let should_emit = total == 0
                    || completed == total
                    || completed <= 2
                    || completed.saturating_sub(last_emitted_completed) >= 20
                    || total != last_emitted_total;
                if !should_emit {
                    return;
                }
                last_emitted_completed = completed;
                last_emitted_total = total;
                set_workspace_reindex_status(
                    &app_handle_clone,
                    true,
                    &workspace_dir,
                    completed,
                    total,
                    completed,
                    "Indexing folders",
                    None,
                );
            },
        );

        match result {
            Ok(indexed_count) => {
                let total = last_emitted_total.max(indexed_count as u64);
                set_workspace_reindex_status(
                    &app_handle_clone,
                    false,
                    &workspace_dir,
                    total,
                    total,
                    indexed_count as u64,
                    "Complete",
                    None,
                );
            }
            Err(err) => {
                set_workspace_reindex_status(
                    &app_handle_clone,
                    false,
                    &workspace_dir,
                    last_emitted_completed,
                    last_emitted_total,
                    0,
                    "Failed",
                    Some(err),
                );
            }
        }

        WORKSPACE_REINDEX_RUNNING.store(false, Ordering::Relaxed);
    });

    Ok(true)
}

#[tauri::command]
fn search_patients(
    app_handle: tauri::AppHandle,
    workspace_dir: String,
    query: String,
) -> Result<Vec<PatientSearchRow>, String> {
    let page = search_patients_page(app_handle, workspace_dir, query, 0, 250)?;
    Ok(page.rows)
}

#[tauri::command]
fn search_patients_page(
    app_handle: tauri::AppHandle,
    workspace_dir: String,
    query: String,
    offset: usize,
    limit: usize,
) -> Result<PatientSearchPageRow, String> {
    let conn = open_db(&app_handle)?;
    let q = query.trim().to_lowercase();
    let mut rows_out: Vec<PatientSearchRow> = Vec::new();
    let page_size = limit.clamp(1, 500);
    let fetch_limit = page_size.saturating_add(1);

    if q.is_empty() {
        let mut stmt = conn
            .prepare(
                "SELECT folder_name, patient_id
                 FROM patient_index
                 WHERE workspace_dir = ?1
                 ORDER BY last_name COLLATE NOCASE, first_name COLLATE NOCASE
                 LIMIT ?2 OFFSET ?3",
            )
            .map_err(|e| e.to_string())?;

        let rows = stmt
            .query_map(params![workspace_dir, fetch_limit as i64, offset as i64], |row| {
                Ok(PatientSearchRow {
                    folder_name: row.get::<_, String>(0)?,
                    patient_id: row.get::<_, String>(1)?,
                })
            })
            .map_err(|e| e.to_string())?;

        for row in rows {
            rows_out.push(row.map_err(|e| e.to_string())?);
        }
    } else {
        let pattern = format!("%{}%", q);
        let mut stmt = conn
            .prepare(
                "SELECT folder_name, patient_id
                 FROM patient_index
                 WHERE workspace_dir = ?1 AND search_text LIKE ?2
                 ORDER BY last_name COLLATE NOCASE, first_name COLLATE NOCASE
                 LIMIT ?3 OFFSET ?4",
            )
            .map_err(|e| e.to_string())?;

        let rows = stmt
            .query_map(params![workspace_dir, pattern, fetch_limit as i64, offset as i64], |row| {
                Ok(PatientSearchRow {
                    folder_name: row.get::<_, String>(0)?,
                    patient_id: row.get::<_, String>(1)?,
                })
            })
            .map_err(|e| e.to_string())?;

        for row in rows {
            rows_out.push(row.map_err(|e| e.to_string())?);
        }
    }

    let has_more = rows_out.len() > page_size;
    if has_more {
        rows_out.truncate(page_size);
    }
    Ok(PatientSearchPageRow { rows: rows_out, has_more })
}

#[tauri::command]
fn get_invalid_patient_folders(workspace_dir: String) -> Result<InvalidPatientFoldersRow, String> {
    get_invalid_patient_folders_page(workspace_dir, 0, 250)
}

#[tauri::command]
fn get_invalid_patient_folders_page(
    workspace_dir: String,
    offset: usize,
    limit: usize,
) -> Result<InvalidPatientFoldersRow, String> {
    let workspace = PathBuf::from(workspace_dir.trim());
    if !workspace.exists() || !workspace.is_dir() {
        return Ok(InvalidPatientFoldersRow {
            invalid_count: 0,
            invalid_folders: Vec::new(),
            invalid_files: Vec::new(),
            has_more: false,
        });
    }

    let page_size = limit.clamp(1, 500);
    let mut seen_count = 0usize;
    let mut rows: Vec<(bool, String)> = Vec::with_capacity(page_size.saturating_add(1));
    for entry in fs::read_dir(&workspace).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let file_type = entry.file_type().map_err(|e| e.to_string())?;
        let folder_name = entry.file_name().to_string_lossy().into_owned();
        if folder_name.starts_with('.') {
            continue;
        }
        if file_type.is_dir() {
            if is_valid_patient_folder_name(&folder_name) {
                continue;
            }
            seen_count = seen_count.saturating_add(1);
            if seen_count <= offset {
                continue;
            }
            rows.push((true, folder_name));
        } else if file_type.is_file() {
            seen_count = seen_count.saturating_add(1);
            if seen_count <= offset {
                continue;
            }
            rows.push((false, folder_name));
        }
        if rows.len() > page_size {
            break;
        }
    }
    let has_more = rows.len() > page_size;
    if has_more {
        rows.truncate(page_size);
    }
    let invalid_count = if has_more {
        offset.saturating_add(rows.len()).saturating_add(1) as u64
    } else {
        offset.saturating_add(rows.len()) as u64
    };
    let mut shown_folders = Vec::new();
    let mut shown_files = Vec::new();
    for (is_folder, name) in rows {
        if is_folder {
            shown_folders.push(name);
        } else {
            shown_files.push(name);
        }
    }

    Ok(InvalidPatientFoldersRow {
        invalid_count,
        invalid_folders: shown_folders,
        invalid_files: shown_files,
        has_more,
    })
}

#[tauri::command]
async fn get_image_preview_kinds(paths: Vec<String>) -> Result<Vec<ImagePreviewKindRow>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut out = Vec::with_capacity(paths.len());

        for raw_path in paths {
            let path = raw_path;
            if path.is_empty() {
                continue;
            }

            let path_buf = PathBuf::from(&path);
            let kind = if is_supported_preview_image(&path_buf) {
                match imagesize::size(&path_buf) {
                    Ok(size) => classify_image_ratio(size.width, size.height),
                    Err(_) => "other".to_string(),
                }
            } else {
                "none".to_string()
            };

            out.push(ImagePreviewKindRow { path, kind });
        }

        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn get_image_previews(paths: Vec<String>) -> Result<Vec<ImagePreviewRow>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut out = Vec::with_capacity(paths.len());

        for raw_path in paths {
            let path = raw_path;
            if path.is_empty() {
                continue;
            }

            let path_buf = PathBuf::from(&path);
            if !is_supported_preview_image(&path_buf) {
                out.push(ImagePreviewRow {
                    path,
                    kind: "none".to_string(),
                    data_url: None,
                });
                continue;
            }

            let kind = match imagesize::size(&path_buf) {
                Ok(size) => classify_image_ratio(size.width, size.height),
                Err(_) => "other".to_string(),
            };
            let data_url = generate_preview_data_url(&path_buf);

            out.push(ImagePreviewRow {
                path,
                kind,
                data_url,
            });
        }

        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn get_quick_image_previews(paths: Vec<String>) -> Result<Vec<ImagePreviewRow>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut out = Vec::with_capacity(paths.len());

        for raw_path in paths {
            let path = raw_path;
            if path.is_empty() {
                continue;
            }

            let path_buf = PathBuf::from(&path);
            if !is_supported_preview_image(&path_buf) {
                out.push(ImagePreviewRow {
                    path,
                    kind: "none".to_string(),
                    data_url: None,
                });
                continue;
            }

            let kind = match imagesize::size(&path_buf) {
                Ok(size) => classify_image_ratio(size.width, size.height),
                Err(_) => "other".to_string(),
            };
            let data_url = generate_quick_preview_data_url(&path_buf);

            out.push(ImagePreviewRow {
                path,
                kind,
                data_url,
            });
        }

        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn get_cached_image_previews(
    app_handle: tauri::AppHandle,
    paths: Vec<String>,
    include_data_url: Option<bool>,
    generate_if_missing: Option<bool>,
) -> Result<Vec<CachedImagePreviewRow>, String> {
    let include_data_url = include_data_url.unwrap_or(true);
    let generate_if_missing = generate_if_missing.unwrap_or(true);
    let app_handle_for_resolve = app_handle.clone();
    let rows = tauri::async_runtime::spawn_blocking(move || {
        resolve_cached_previews(
            &app_handle_for_resolve,
            &paths,
            include_data_url,
            generate_if_missing,
        )
    })
    .await
    .map_err(|e| e.to_string())??;

    if generate_if_missing {
        schedule_local_cache_copy_sync_if_enabled(&app_handle);
    }

    Ok(rows)
}

#[tauri::command]
async fn get_import_wizard_cached_previews(
    app_handle: tauri::AppHandle,
    folder_dir: String,
    paths: Vec<String>,
    include_data_url: Option<bool>,
    generate_if_missing: Option<bool>,
) -> Result<Vec<CachedImagePreviewRow>, String> {
    let folder_dir = folder_dir.trim().to_string();
    if folder_dir.is_empty() {
        return Err("folder directory is required".to_string());
    }
    let folder = PathBuf::from(&folder_dir);
    if !folder.exists() || !folder.is_dir() {
        return Err("folder directory does not exist".to_string());
    }
    if import_wizard_cache_dir_is_protected(&app_handle, &folder) {
        return Err("import wizard folder conflicts with main/local preview cache".to_string());
    }

    let include_data_url = include_data_url.unwrap_or(true);
    let generate_if_missing = generate_if_missing.unwrap_or(true);
    let settings = read_settings(&app_handle).unwrap_or_default();
    let cache_size_gb = settings.cache_size_gb.unwrap_or(5).clamp(1, 10);
    let max_cache_bytes = (cache_size_gb as u64) * 1024 * 1024 * 1024;
    let preview_perf_mode = normalize_preview_performance_mode(
        settings
            .preview_performance_mode
            .as_deref()
            .unwrap_or(PREVIEW_PERF_AUTO),
    );
    let cache_dir = folder.join(".preview-cache");

    tauri::async_runtime::spawn_blocking(move || {
        resolve_cached_previews_in_cache_dir(
            &paths,
            include_data_url,
            generate_if_missing,
            &cache_dir,
            max_cache_bytes,
            &preview_perf_mode,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn get_existing_cached_preview_paths(
    app_handle: tauri::AppHandle,
    paths: Vec<String>,
) -> Result<Vec<CachedPreviewPathRow>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let cache_dir = get_active_preview_cache_dir(&app_handle);
        let mut out = Vec::with_capacity(paths.len());

        for raw_path in paths {
            let path = raw_path;
            if path.is_empty() {
                continue;
            }

            let path_buf = PathBuf::from(&path);
            if !is_supported_preview_image(&path_buf) {
                out.push(CachedPreviewPathRow {
                    path,
                    preview_path: None,
                });
                continue;
            }

            let file_meta = match fs::metadata(&path_buf) {
                Ok(meta) => meta,
                Err(_) => {
                    out.push(CachedPreviewPathRow {
                        path,
                        preview_path: None,
                    });
                    continue;
                }
            };

            let file_size = file_meta.len();
            let modified_ms = file_meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            let cache_file_path =
                resolve_existing_cache_file_path(&cache_dir, &path_buf, file_size, modified_ms);

            out.push(CachedPreviewPathRow {
                path,
                preview_path: if cache_file_path.exists() && is_valid_cached_preview_file(&cache_file_path) {
                    Some(cache_file_path.to_string_lossy().to_string())
                } else {
                    None
                },
            });
        }

        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn prefetch_treatment_folder_previews(
    app_handle: tauri::AppHandle,
    workspace_dir: String,
    patient_folder: String,
    treatment_folders: Vec<String>,
) -> Result<(), String> {
    let workspace = PathBuf::from(workspace_dir.trim());
    if !workspace.exists() || !workspace.is_dir() {
        return Ok(());
    }

    let patient_folder = patient_folder.trim().to_string();
    if patient_folder.is_empty() {
        return Ok(());
    }

    let selected_folders: Vec<String> = treatment_folders
        .into_iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .take(PREVIEW_PREFETCH_FOLDERS)
        .collect();

    if selected_folders.is_empty() {
        return Ok(());
    }

    let app_handle_for_resolve = app_handle.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let mut image_paths = Vec::new();
        for treatment_folder in selected_folders {
            let treatment_path = workspace.join(&patient_folder).join(&treatment_folder);
            if !treatment_path.exists() || !treatment_path.is_dir() {
                continue;
            }

            let mut folder_paths = Vec::new();
            for entry in fs::read_dir(&treatment_path).map_err(|e| e.to_string())? {
                let entry = entry.map_err(|e| e.to_string())?;
                let file_type = entry.file_type().map_err(|e| e.to_string())?;
                if !file_type.is_file() {
                    continue;
                }
                let p = entry.path();
                if !is_supported_preview_image(&p) {
                    continue;
                }
                folder_paths.push(p.to_string_lossy().to_string());
            }
            folder_paths.sort();
            image_paths.extend(folder_paths.into_iter().take(PREVIEW_PREFETCH_IMAGES_PER_FOLDER));
        }

        if image_paths.is_empty() {
            return Ok::<(), String>(());
        }
        let _ = resolve_cached_previews(&app_handle_for_resolve, &image_paths, false, true)?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())??;

    schedule_local_cache_copy_sync_if_enabled(&app_handle);
    Ok(())
}

#[tauri::command]
fn start_import_files(
    app_handle: tauri::AppHandle,
    workspace_dir: String,
    patient_folder: String,
    existing_folder: Option<String>,
    date: Option<String>,
    treatment_name: Option<String>,
    file_paths: Vec<String>,
    delete_origin: bool,
) -> Result<StartImportResponse, String> {
    let workspace_dir = workspace_dir.trim().to_string();
    let patient_folder = patient_folder.trim().to_string();
    if workspace_dir.is_empty() || patient_folder.is_empty() {
        return Err("workspace and patient folder are required".to_string());
    }

    if file_paths.is_empty() {
        return Err("no files selected for import".to_string());
    }

    let workspace_path = PathBuf::from(&workspace_dir);
    if !workspace_path.exists() || !workspace_path.is_dir() {
        return Err("workspace directory does not exist".to_string());
    }
    let patient_path = workspace_path.join(&patient_folder);
    if !patient_path.exists() || !patient_path.is_dir() {
        return Err("patient folder does not exist".to_string());
    }

    let using_existing_folder = existing_folder.is_some();
    let target_folder = if let Some(existing) = existing_folder {
        let e = existing.trim().to_string();
        if e.is_empty() {
            return Err("existing folder is empty".to_string());
        }
        e
    } else {
        let d = date.unwrap_or_default().trim().to_string();
        let t = treatment_name.unwrap_or_default().trim().to_string();
        if d.is_empty() || t.is_empty() {
            return Err("date and folder name are required for new folder".to_string());
        }
        format!("{d} {t}")
    };

    let target_dir = patient_path.join(&target_folder);
    let created_new_folder = if using_existing_folder {
        if !target_dir.exists() || !target_dir.is_dir() {
            return Err("selected existing folder does not exist".to_string());
        }
        false
    } else {
        let created = !target_dir.exists();
        if created {
            fs::create_dir_all(&target_dir).map_err(|e| e.to_string())?;
        } else if !target_dir.is_dir() {
            return Err("target is not a directory".to_string());
        }
        created
    };

    if let Err(err) = ensure_treatment_index_row(
        &open_db(&app_handle)?,
        &workspace_dir,
        &patient_folder,
        &target_folder,
    ) {
        return Err(format!("failed to update treatment index: {err}"));
    }

    let job_id = IMPORT_JOB_COUNTER.fetch_add(1, Ordering::Relaxed);
    let app_handle_clone = app_handle.clone();
    let workspace_dir_for_preview_sync = workspace_dir.clone();
    let import_wizard_cache_dir = read_settings(&app_handle)
        .ok()
        .and_then(|s| s.import_wizard_dir)
        .map(|dir| PathBuf::from(dir.trim()).join(".preview-cache"));
    let import_files = file_paths
        .into_iter()
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>();
    let target_dir_clone = target_dir.clone();
    let workspace_root_for_delete_guard = workspace_path.clone();

    tauri::async_runtime::spawn_blocking(move || {
        struct ImportActiveGuard;
        impl Drop for ImportActiveGuard {
            fn drop(&mut self) {
                IMPORT_ACTIVE_COUNT.fetch_sub(1, Ordering::Relaxed);
            }
        }
        IMPORT_ACTIVE_COUNT.fetch_add(1, Ordering::Relaxed);
        let _import_active_guard = ImportActiveGuard;

        let total_bytes: u64 = import_files
            .iter()
            .filter_map(|p| fs::metadata(p).ok())
            .map(|m| m.len())
            .sum();
        let total_count: u64 = import_files.len() as u64;
        let mut copied_bytes: u64 = 0;
        let mut copied_count: u64 = 0;
        let mut pending_preview_paths: Vec<String> = Vec::new();
        let (preview_tx, preview_rx) = std::sync::mpsc::channel::<Vec<String>>();
        let preview_handle = app_handle_clone.clone();
        let preview_workspace_dir = workspace_dir_for_preview_sync.clone();
        std::thread::spawn(move || {
            while let Ok(batch) = preview_rx.recv() {
                if batch.is_empty() {
                    continue;
                }
                if let Ok(rows) = resolve_cached_previews(&preview_handle, &batch, false, true) {
                    emit_import_preview_ready_events(&preview_handle, &rows);
                }
            }
            // Sync to workspace main cache only after preview generation completes.
            sync_local_cache_copy_if_enabled(&preview_handle, &preview_workspace_dir);
        });

        let emit_progress = |percent: f64, done: bool, error: Option<String>| {
            let payload = ImportProgressEvent {
                job_id,
                percent,
                done,
                error,
            };
            let _ = app_handle_clone.emit("import-progress", payload);
        };

        emit_progress(0.0, false, None);

        for src in import_files {
            let src_path = PathBuf::from(&src);
            let file_name = src_path
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("file")
                .to_string();
            let dst_path = resolve_unique_target_path(&target_dir_clone, &file_name);

            match fs::copy(&src_path, &dst_path) {
                Ok(written) => {
                    if delete_origin {
                        // Safety guard: never delete originals that are inside workspace.
                        if !path_is_inside_dir(&src_path, &workspace_root_for_delete_guard) {
                            let _ = fs::remove_file(&src_path);
                        }
                    }

                    if is_supported_preview_image(&dst_path) {
                        if let Some(cache_dir) = import_wizard_cache_dir.as_ref() {
                            let _ = seed_active_preview_cache_from_import_wizard_cache(
                                &app_handle_clone,
                                cache_dir,
                                &src_path,
                                &dst_path,
                            );
                        }
                        pending_preview_paths.push(dst_path.to_string_lossy().to_string());
                        if pending_preview_paths.len() >= IMPORT_PREVIEW_MICROBATCH_SIZE {
                            let batch = std::mem::take(&mut pending_preview_paths);
                            let _ = preview_tx.send(batch);
                        }
                    }

                    copied_bytes = copied_bytes.saturating_add(written);
                    copied_count = copied_count.saturating_add(1);
                    let percent = if total_bytes > 0 {
                        (copied_bytes as f64 / total_bytes as f64) * 100.0
                    } else if total_count > 0 {
                        (copied_count as f64 / total_count as f64) * 100.0
                    } else {
                        100.0
                    };
                    emit_progress(percent.clamp(0.0, 100.0), false, None);
                }
                Err(err) => {
                    emit_progress(100.0, true, Some(err.to_string()));
                    return;
                }
            }
        }

        if !pending_preview_paths.is_empty() {
            let batch = std::mem::take(&mut pending_preview_paths);
            let _ = preview_tx.send(batch);
        }
        drop(preview_tx);
        emit_progress(100.0, true, None);
    });

    Ok(StartImportResponse {
        job_id,
        target_folder,
        created_new_folder,
    })
}

#[tauri::command]
fn load_settings(app_handle: tauri::AppHandle) -> Result<Settings, String> {
    read_settings(&app_handle)
}

#[tauri::command]
fn set_cache_size_gb(app_handle: tauri::AppHandle, cache_size_gb: u8) -> Result<u8, String> {
    if !(1..=10).contains(&cache_size_gb) {
        return Err("cache_size_gb must be between 1 and 10".to_string());
    }

    let mut settings = read_settings(&app_handle)?;
    settings.cache_size_gb = Some(cache_size_gb);
    write_settings(&app_handle, &settings)?;
    Ok(cache_size_gb)
}

#[tauri::command]
fn set_preview_performance_mode(
    app_handle: tauri::AppHandle,
    mode: String,
) -> Result<String, String> {
    let normalized = normalize_preview_performance_mode(&mode);
    let mut settings = read_settings(&app_handle)?;
    settings.preview_performance_mode = Some(normalized.clone());
    write_settings(&app_handle, &settings)?;
    Ok(normalized)
}

#[tauri::command]
async fn set_keep_local_cache_copy(
    app_handle: tauri::AppHandle,
    workspace_dir: String,
    enabled: bool,
) -> Result<LocalCacheCopyStatusRow, String> {
    if IMPORT_ACTIVE_COUNT.load(Ordering::Relaxed) > 0 || PREVIEW_FILL_RUNNING.load(Ordering::Relaxed) {
        return Err("cannot change local cache mode while preview creation is active".to_string());
    }

    let mut settings = read_settings(&app_handle)?;
    settings.keep_local_cache_copy = Some(enabled);
    write_settings(&app_handle, &settings)?;

    if !enabled {
        LOCAL_CACHE_COPY_RUNNING.store(false, Ordering::Relaxed);
        set_local_cache_copy_runtime_state("disabled", None);
        let runtime = local_cache_copy_runtime()
            .lock()
            .map_err(|e| e.to_string())?;
        return Ok(local_cache_copy_status_row(&app_handle, false, false, &runtime));
    }

    let workspace = PathBuf::from(workspace_dir.trim());
    if !workspace.exists() || !workspace.is_dir() {
        let runtime = local_cache_copy_runtime()
            .lock()
            .map_err(|e| e.to_string())?;
        return Ok(local_cache_copy_status_row(&app_handle, true, false, &runtime));
    }

    if LOCAL_CACHE_COPY_RUNNING
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        let runtime = local_cache_copy_runtime()
            .lock()
            .map_err(|e| e.to_string())?;
        return Ok(local_cache_copy_status_row(&app_handle, true, true, &runtime));
    }
    LOCAL_CACHE_COPY_CANCEL_REQUESTED.store(false, Ordering::Relaxed);
    PREVIEW_FILL_CANCEL_REQUESTED.store(false, Ordering::Relaxed);

    let app_handle_clone = app_handle.clone();
    let workspace_clone = workspace.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        run_local_cache_copy_sync(&app_handle_clone, &workspace_clone, true)
    })
    .await
    .map_err(|e| e.to_string())?;
    LOCAL_CACHE_COPY_RUNNING.store(false, Ordering::Relaxed);
    result?;

    let runtime = local_cache_copy_runtime()
        .lock()
        .map_err(|e| e.to_string())?;
    Ok(local_cache_copy_status_row(&app_handle, true, false, &runtime))
}

#[tauri::command]
fn get_local_cache_copy_status(
    app_handle: tauri::AppHandle,
) -> Result<LocalCacheCopyStatusRow, String> {
    let settings = read_settings(&app_handle).unwrap_or_default();
    let enabled = settings.keep_local_cache_copy.unwrap_or(false);
    let running = LOCAL_CACHE_COPY_RUNNING.load(Ordering::Relaxed);
    let runtime = local_cache_copy_runtime()
        .lock()
        .map_err(|e| e.to_string())?;
    Ok(local_cache_copy_status_row(&app_handle, enabled, running, &runtime))
}

#[tauri::command]
async fn sync_local_cache_copy(
    app_handle: tauri::AppHandle,
    workspace_dir: String,
) -> Result<LocalCacheCopyStatusRow, String> {
    let settings = read_settings(&app_handle).unwrap_or_default();
    let enabled = settings.keep_local_cache_copy.unwrap_or(false);
    if !enabled {
        let runtime = local_cache_copy_runtime()
            .lock()
            .map_err(|e| e.to_string())?;
        return Ok(local_cache_copy_status_row(&app_handle, false, false, &runtime));
    }

    let workspace = PathBuf::from(workspace_dir.trim());
    if !workspace.exists() || !workspace.is_dir() {
        let runtime = local_cache_copy_runtime()
            .lock()
            .map_err(|e| e.to_string())?;
        return Ok(local_cache_copy_status_row(&app_handle, true, false, &runtime));
    }

    if LOCAL_CACHE_COPY_RUNNING
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        let runtime = local_cache_copy_runtime()
            .lock()
            .map_err(|e| e.to_string())?;
        return Ok(local_cache_copy_status_row(&app_handle, true, true, &runtime));
    }
    LOCAL_CACHE_COPY_CANCEL_REQUESTED.store(false, Ordering::Relaxed);
    PREVIEW_FILL_CANCEL_REQUESTED.store(false, Ordering::Relaxed);
    let Some(io_guard) = HeavyIoTaskGuard::acquire() else {
        let runtime = local_cache_copy_runtime()
            .lock()
            .map_err(|e| e.to_string())?;
        return Ok(local_cache_copy_status_row(&app_handle, true, false, &runtime));
    };

    let app_handle_clone = app_handle.clone();
    let workspace_clone = workspace.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let _io_guard = io_guard;
        run_local_cache_copy_sync(&app_handle_clone, &workspace_clone, false)
    })
    .await
    .map_err(|e| e.to_string())?;
    LOCAL_CACHE_COPY_RUNNING.store(false, Ordering::Relaxed);
    result?;

    let runtime = local_cache_copy_runtime()
        .lock()
        .map_err(|e| e.to_string())?;
    Ok(local_cache_copy_status_row(&app_handle, true, false, &runtime))
}

#[tauri::command]
fn delete_local_cache_copy_files(app_handle: tauri::AppHandle) -> Result<(), String> {
    if IMPORT_ACTIVE_COUNT.load(Ordering::Relaxed) > 0 || PREVIEW_FILL_RUNNING.load(Ordering::Relaxed) {
        return Err("cannot delete local cache while preview creation is active".to_string());
    }

    let cache_dir = preview_cache_dir_path(&app_handle);
    let _guard = preview_cache_lock().lock().map_err(|e| e.to_string())?;
    if !cache_dir.exists() {
        return Ok(());
    }

    // Safety guard: never allow this command to target workspace main cache.
    if let Ok(settings) = read_settings(&app_handle) {
        if let Some(workspace_dir) = settings.workspace_dir {
            let workspace_main_cache = get_local_cache_copy_dir(Path::new(workspace_dir.trim()));
            let local_canon = fs::canonicalize(&cache_dir).unwrap_or(cache_dir.clone());
            let main_canon = fs::canonicalize(&workspace_main_cache).unwrap_or(workspace_main_cache);
            if local_canon == main_canon {
                return Err("refusing to delete workspace main cache via local cache delete".to_string());
            }
        }
    }

    if let Ok(entries) = fs::read_dir(&cache_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                let _ = fs::remove_dir_all(path);
            } else {
                let _ = fs::remove_file(path);
            }
        }
    }
    Ok(())
}

#[tauri::command]
fn get_preview_cache_stats(app_handle: tauri::AppHandle) -> Result<PreviewCacheStatsRow, String> {
    let settings = read_settings(&app_handle).unwrap_or_default();
    let cache_size_gb = settings.cache_size_gb.unwrap_or(5).clamp(1, 10);
    let max_bytes = (cache_size_gb as u64) * 1024 * 1024 * 1024;
    let cache_dir = get_active_preview_cache_dir(&app_handle);
    let used_bytes = if let Ok(_guard) = preview_cache_lock().try_lock() {
        let mut index = load_preview_cache_index(&cache_dir);
        cleanup_preview_cache(&cache_dir, &mut index, max_bytes);
        index.entries.retain(|_, entry| {
            let path = cache_dir.join(&entry.file_name);
            fs::metadata(&path).is_ok()
        });
        let _ = save_preview_cache_index(&cache_dir, &index);
        compute_preview_cache_used_bytes(&cache_dir)
    } else {
        // Avoid blocking UI calls (e.g. cache slider updates) while background fill holds the lock.
        compute_preview_cache_used_bytes(&cache_dir)
    };

    let used_percent = if max_bytes > 0 {
        ((used_bytes as f64 / max_bytes as f64) * 100.0).clamp(0.0, 100.0)
    } else {
        0.0
    };

    Ok(PreviewCacheStatsRow {
        used_bytes,
        max_bytes,
        used_percent,
    })
}

#[tauri::command]
async fn run_system_update(app_handle: tauri::AppHandle) -> Result<SystemUpdateResult, String> {
    let updater = app_handle
        .updater_builder()
        .build()
        .map_err(|e| e.to_string())?;

    let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
        return Ok(SystemUpdateResult {
            updated: false,
            version: None,
        });
    };

    let next_version = update.version.to_string();
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|e| e.to_string())?;

    Ok(SystemUpdateResult {
        updated: true,
        version: Some(next_version),
    })
}

#[tauri::command]
fn get_preview_debug_counts(
    app_handle: tauri::AppHandle,
    workspace_dir: String,
) -> Result<PreviewDebugCountsRow, String> {
    let workspace_key = workspace_dir.trim().to_string();
    if workspace_key.is_empty() {
        return Ok(PreviewDebugCountsRow::default());
    }

    let now = now_ms();
    let mut row = PreviewDebugCountsRow::default();
    let mut should_start_refresh = false;

    if let Ok(mut cache) = preview_debug_counts_store().lock() {
        let entry = cache
            .entry(workspace_key.clone())
            .or_insert_with(PreviewDebugCountsCacheEntry::default);
        row = entry.row.clone();
        let stale = now.saturating_sub(entry.updated_ms) > PREVIEW_DEBUG_COUNTS_CACHE_TTL_MS;
        if (entry.updated_ms == 0 || stale) && !entry.running {
            entry.running = true;
            should_start_refresh = true;
        }
    }

    if should_start_refresh {
        let app_handle_clone = app_handle.clone();
        let workspace_key_clone = workspace_key.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let result = if let Some(_io_guard) = HeavyIoTaskGuard::acquire() {
                compute_preview_debug_counts(&app_handle_clone, &workspace_key_clone)
            } else {
                Err("heavy io busy".to_string())
            };
            if let Ok(mut cache) = preview_debug_counts_store().lock() {
                let entry = cache
                    .entry(workspace_key_clone.clone())
                    .or_insert_with(PreviewDebugCountsCacheEntry::default);
                if let Ok(next_row) = result {
                    entry.row = next_row;
                    entry.updated_ms = now_ms();
                }
                entry.running = false;
            }
        });
    }

    Ok(row)
}

fn compute_preview_debug_counts(
    app_handle: &tauri::AppHandle,
    workspace_dir: &str,
) -> Result<PreviewDebugCountsRow, String> {
    let workspace = PathBuf::from(workspace_dir.trim());
    let mut db_image_count = 0_u64;

    if workspace.exists() && workspace.is_dir() {
        let conn = open_db(app_handle)?;
        let mut stmt = conn
            .prepare(
                "SELECT patient_folder, folder_name
                 FROM patient_treatment_index
                 WHERE workspace_dir = ?1",
            )
            .map_err(|e| e.to_string())?;

        let rows = stmt
            .query_map(params![workspace_dir], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|e| e.to_string())?;

        for row in rows {
            let (patient_folder, treatment_folder) = row.map_err(|e| e.to_string())?;
            let treatment_path = workspace.join(patient_folder).join(treatment_folder);
            if !treatment_path.exists() || !treatment_path.is_dir() {
                continue;
            }
            let entries = match fs::read_dir(&treatment_path) {
                Ok(v) => v,
                Err(_) => continue,
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if !path.is_file() || !is_supported_preview_image(&path) {
                    continue;
                }
                db_image_count = db_image_count.saturating_add(1);
            }
        }
    }

    let cache_dir = get_active_preview_cache_dir(app_handle);
    let cache_image_count = if workspace.exists() && workspace.is_dir() {
        let conn = open_db(app_handle)?;
        let mut mapped_count = 0_u64;
        let mut stmt = conn
            .prepare(
                "SELECT patient_folder, folder_name
                 FROM patient_treatment_index
                 WHERE workspace_dir = ?1",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![workspace_dir], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (patient_folder, treatment_folder) = row.map_err(|e| e.to_string())?;
            let treatment_path = workspace.join(patient_folder).join(treatment_folder);
            if !treatment_path.exists() || !treatment_path.is_dir() {
                continue;
            }
            let entries = match fs::read_dir(&treatment_path) {
                Ok(v) => v,
                Err(_) => continue,
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if !path.is_file() || !is_supported_preview_image(&path) {
                    continue;
                }
                let meta = match fs::metadata(&path) {
                    Ok(m) => m,
                    Err(_) => continue,
                };
                let file_size = meta.len();
                let modified_ms = meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0);
                let cache_file_path =
                    resolve_existing_cache_file_path(&cache_dir, &path, file_size, modified_ms);
                if cache_file_path.exists() {
                    mapped_count = mapped_count.saturating_add(1);
                }
            }
        }
        mapped_count
    } else {
        compute_preview_cache_image_count(&cache_dir)
    };

    Ok(PreviewDebugCountsRow {
        db_image_count,
        cache_image_count,
    })
}

#[tauri::command]
async fn cleanup_preview_cache_for_workspace(
    app_handle: tauri::AppHandle,
    workspace_dir: String,
) -> Result<(), String> {
    PREVIEW_FILL_CANCEL_REQUESTED.store(false, Ordering::Relaxed);
    LOCAL_CACHE_COPY_CANCEL_REQUESTED.store(false, Ordering::Relaxed);
    tauri::async_runtime::spawn_blocking(move || {
        let workspace = PathBuf::from(workspace_dir.trim());
        if !workspace.exists() || !workspace.is_dir() {
            return Ok(());
        }
        run_preview_cache_cleanup_for_workspace(&app_handle, &workspace);
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
fn get_preview_fill_status() -> bool {
    PREVIEW_FILL_RUNNING.load(Ordering::Relaxed)
}

#[tauri::command]
fn stop_all_cache_tasks(app_handle: tauri::AppHandle) -> Result<bool, String> {
    let any_running = PREVIEW_FILL_RUNNING.load(Ordering::Relaxed)
        || LOCAL_CACHE_COPY_RUNNING.load(Ordering::Relaxed);
    PREVIEW_FILL_CANCEL_REQUESTED.store(true, Ordering::Relaxed);
    LOCAL_CACHE_COPY_CANCEL_REQUESTED.store(true, Ordering::Relaxed);
    let _ = app_handle.emit(
        "preview-fill-progress",
        PreviewFillProgressEvent {
            running: true,
            message: "Pausing...".to_string(),
            completed: 0,
            total: 0,
        },
    );
    Ok(any_running)
}

#[tauri::command]
fn stop_background_preview_fill(app_handle: tauri::AppHandle) -> Result<bool, String> {
    if !PREVIEW_FILL_RUNNING.load(Ordering::Relaxed) {
        return Ok(false);
    }
    PREVIEW_FILL_CANCEL_REQUESTED.store(true, Ordering::Relaxed);
    let _ = app_handle.emit(
        "preview-fill-progress",
        PreviewFillProgressEvent {
            running: true,
            message: "Pausing...".to_string(),
            completed: 0,
            total: 0,
        },
    );
    Ok(true)
}

#[tauri::command]
fn start_background_preview_fill(
    app_handle: tauri::AppHandle,
    workspace_dir: String,
) -> Result<bool, String> {
    let workspace = PathBuf::from(workspace_dir.trim());
    if !workspace.exists() || !workspace.is_dir() {
        return Err("workspace directory does not exist".to_string());
    }

    if PREVIEW_FILL_RUNNING
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Ok(false);
    }
    let Some(io_guard) = HeavyIoTaskGuard::acquire() else {
        PREVIEW_FILL_RUNNING.store(false, Ordering::Relaxed);
        return Ok(false);
    };
    PREVIEW_FILL_CANCEL_REQUESTED.store(false, Ordering::Relaxed);
    LOCAL_CACHE_COPY_CANCEL_REQUESTED.store(false, Ordering::Relaxed);

    let _ = app_handle.emit(
        "preview-fill-status",
        PreviewFillStatusEvent { running: true },
    );
    let app_handle_clone = app_handle.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _io_guard = io_guard;
        const BATCH_SIZE: usize = 18;
        const QUEUE_CAPACITY: usize = 220;
        let workspace_dir_value = workspace.to_string_lossy().to_string();
        let (tx, rx) = std::sync::mpsc::sync_channel::<String>(QUEUE_CAPACITY);
        let discovered_total = Arc::new(AtomicU64::new(0));
        let discovered_total_clone = Arc::clone(&discovered_total);
        let producer = std::thread::spawn(move || {
            let mut stack = vec![workspace];
            while let Some(dir) = stack.pop() {
                if PREVIEW_FILL_CANCEL_REQUESTED.load(Ordering::Relaxed)
                    || LOCAL_CACHE_COPY_CANCEL_REQUESTED.load(Ordering::Relaxed)
                {
                    break;
                }
                let entries = match fs::read_dir(&dir) {
                    Ok(v) => v,
                    Err(_) => continue,
                };

                for entry in entries {
                    let Ok(entry) = entry else {
                        continue;
                    };
                    let path = entry.path();
                    let Ok(file_type) = entry.file_type() else {
                        continue;
                    };

                    if file_type.is_dir() {
                        stack.push(path);
                        continue;
                    }
                    if !file_type.is_file() || !is_supported_preview_image(&path) {
                        continue;
                    }

                    discovered_total_clone.fetch_add(1, Ordering::Relaxed);
                    if tx.send(path.to_string_lossy().to_string()).is_err() {
                        break;
                    }
                }
            }
        });

        let mut completed = 0_u64;
        let mut producer_finished = false;
        let mut batch: Vec<String> = Vec::with_capacity(BATCH_SIZE);
        let mut total_hint = 0_u64;
        emit_preview_fill_progress(&app_handle_clone, true, "Creating new previews (0/0)", 0, 0);

        loop {
            if PREVIEW_FILL_CANCEL_REQUESTED.load(Ordering::Relaxed)
                || LOCAL_CACHE_COPY_CANCEL_REQUESTED.load(Ordering::Relaxed)
            {
                break;
            }
            match rx.recv_timeout(Duration::from_millis(100)) {
                Ok(path) => batch.push(path),
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    producer_finished = true;
                }
            }

            if batch.len() >= BATCH_SIZE || (producer_finished && !batch.is_empty()) {
                let chunk = std::mem::take(&mut batch);
                let chunk_len = chunk.len() as u64;
                let _ = resolve_cached_previews(&app_handle_clone, &chunk, false, true);
                completed = completed.saturating_add(chunk_len);
                let discovered_now = discovered_total.load(Ordering::Relaxed);
                total_hint = total_hint.max(discovered_now).max(completed);
                emit_preview_fill_progress(
                    &app_handle_clone,
                    true,
                    format!("Creating new previews ({completed}/{total_hint})"),
                    completed,
                    total_hint,
                );
                std::thread::sleep(Duration::from_millis(16));
            }

            if producer_finished && batch.is_empty() {
                break;
            }
        }

        let _ = producer.join();
        if !batch.is_empty() {
            let chunk = std::mem::take(&mut batch);
            let chunk_len = chunk.len() as u64;
            let _ = resolve_cached_previews(&app_handle_clone, &chunk, false, true);
            completed = completed.saturating_add(chunk_len);
            let discovered_now = discovered_total.load(Ordering::Relaxed);
            total_hint = total_hint.max(discovered_now).max(completed);
            emit_preview_fill_progress(
                &app_handle_clone,
                true,
                format!("Creating new previews ({completed}/{total_hint})"),
                completed,
                total_hint,
            );
        }

        let final_total = total_hint
            .max(discovered_total.load(Ordering::Relaxed))
            .max(completed);
        if PREVIEW_FILL_CANCEL_REQUESTED.load(Ordering::Relaxed)
            || LOCAL_CACHE_COPY_CANCEL_REQUESTED.load(Ordering::Relaxed)
        {
            PREVIEW_FILL_RUNNING.store(false, Ordering::Relaxed);
            PREVIEW_FILL_CANCEL_REQUESTED.store(false, Ordering::Relaxed);
            emit_preview_fill_progress(&app_handle_clone, false, "Paused", completed, final_total);
            let _ = app_handle_clone.emit(
                "preview-fill-status",
                PreviewFillStatusEvent { running: false },
            );
            return;
        }

        // First create previews in local cache; sync to workspace main cache afterwards.
        sync_local_cache_copy_if_enabled(&app_handle_clone, &workspace_dir_value);

        if IMPORT_ACTIVE_COUNT.load(Ordering::Relaxed) > 0 {
            emit_preview_fill_progress(
                &app_handle_clone,
                true,
                "Cleanup on hold (import in progress)",
                completed,
                final_total,
            );
        } else {
            emit_preview_fill_progress(&app_handle_clone, true, "Removing old files", completed, final_total);
            run_preview_cache_cleanup(&app_handle_clone);
            emit_preview_fill_progress(&app_handle_clone, true, "Clearing duplicates", completed, final_total);
            run_preview_cache_cleanup(&app_handle_clone);
        }

        PREVIEW_FILL_RUNNING.store(false, Ordering::Relaxed);
        PREVIEW_FILL_CANCEL_REQUESTED.store(false, Ordering::Relaxed);
        emit_preview_fill_progress(&app_handle_clone, false, "Up to date", completed, final_total);
        let _ = app_handle_clone.emit(
            "preview-fill-status",
            PreviewFillStatusEvent { running: false },
        );
    });

    Ok(true)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = apply_saved_window_state(&app.handle(), &window);
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            match event {
                tauri::WindowEvent::Resized(_) | tauri::WindowEvent::Moved(_) | tauri::WindowEvent::CloseRequested { .. } => {
                    if window.label() == "main" {
                        let _ = persist_main_window_state(&window.app_handle(), window);
                    } else if window.label() == "import_wizard_preview" {
                        let _ = persist_import_wizard_preview_window_state(&window.app_handle(), window);
                    }
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            save_workspace,
            save_import_wizard_dir,
            set_import_wizard_live_preview,
            clear_workspace,
            delete_database,
            open_workspace_dir,
            open_preview_cache_dir,
            open_path_with_default,
            copy_treatment_folder_to_destination,
            copy_file_to_destination,
            copy_patient_folder_to_destination,
            list_import_wizard_files,
            ensure_import_wizard_preview_cache,
            clear_import_wizard_preview_cache,
            open_import_wizard_preview_window,
            get_import_wizard_preview_data_url,
            get_current_import_wizard_preview_path,
            close_import_wizard_preview_window,
            close_import_wizard_helper_window,
            notify_import_wizard_completed,
            remove_import_wizard_cached_preview,
            list_patient_treatment_folders,
            list_patient_timeline_entries,
            list_patient_overview,
            list_treatment_files,
            list_treatment_files_page,
            create_patient_with_metadata,
            save_patient_metadata,
            save_patient_id,
            load_patient_keywords,
            save_patient_keywords,
            is_patient_id_taken,
            reindex_patient_folders,
            start_workspace_reindex,
            get_workspace_reindex_status,
            search_patients,
            search_patients_page,
            get_invalid_patient_folders,
            get_invalid_patient_folders_page,
            get_image_preview_kinds,
            get_image_previews,
            get_quick_image_previews,
            get_cached_image_previews,
            get_import_wizard_cached_previews,
            get_existing_cached_preview_paths,
            prefetch_treatment_folder_previews,
            start_import_files,
            set_cache_size_gb,
            set_preview_performance_mode,
            set_keep_local_cache_copy,
            get_local_cache_copy_status,
            sync_local_cache_copy,
            delete_local_cache_copy_files,
            get_preview_cache_stats,
            run_system_update,
            get_preview_debug_counts,
            cleanup_preview_cache_for_workspace,
            get_preview_fill_status,
            stop_all_cache_tasks,
            stop_background_preview_fill,
            start_background_preview_fill,
            load_settings
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
