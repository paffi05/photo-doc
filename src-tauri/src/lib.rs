use tauri::{Emitter, Manager};
use base64::Engine;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};

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
    window_state: Option<WindowState>,
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

fn persist_window_state(app_handle: &tauri::AppHandle, window: &tauri::Window) -> Result<(), String> {
    let mut settings = read_settings(app_handle)?;
    settings.window_state = Some(snapshot_window_state(window)?);
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
        let first = folder_name[idx + 1..].trim().to_string();
        return (last, first);
    }
    (folder_name.trim().to_string(), String::new())
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
struct PatientTreatmentRow {
    folder_name: String,
    folder_date: String,
    treatment_name: String,
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
struct StartImportResponse {
    job_id: u64,
    target_folder: String,
    created_new_folder: bool,
}

#[derive(Serialize, Clone)]
struct ImportProgressEvent {
    job_id: u64,
    percent: f64,
    done: bool,
    error: Option<String>,
}

static IMPORT_JOB_COUNTER: AtomicU64 = AtomicU64::new(1);

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
) -> Result<(), String> {
    let workspace = PathBuf::from(&workspace_dir);
    if !workspace.exists() || !workspace.is_dir() {
        return Err("workspace directory does not exist".to_string());
    }

    let last_name = last_name.trim();
    let first_name = first_name.trim();
    let patient_id = patient_id.trim();

    if last_name.is_empty() || first_name.is_empty() || patient_id.is_empty() {
        return Err("last name, first name and id are required".to_string());
    }

    if last_name.contains('/') || last_name.contains('\\') || first_name.contains('/') || first_name.contains('\\') {
        return Err("invalid characters in patient name".to_string());
    }

    let folder_name = format!("{}, {}", last_name, first_name);
    let patient_folder = workspace.join(&folder_name);
    if patient_folder.exists() {
        return Err("patient folder already exists".to_string());
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

    Ok(())
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

#[tauri::command]
fn reindex_patient_folders(app_handle: tauri::AppHandle, workspace_dir: String) -> Result<usize, String> {
    let workspace = PathBuf::from(workspace_dir);

    if !workspace.exists() || !workspace.is_dir() {
        return Ok(0);
    }

    let mut folders: Vec<(String, String, String, String, String)> = Vec::new();
    let mut treatment_rows: Vec<(String, String, String, String)> = Vec::new();

    for entry in fs::read_dir(&workspace).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let file_type = entry.file_type().map_err(|e| e.to_string())?;
        if !file_type.is_dir() {
            continue;
        }

        let folder_name = entry.file_name().to_string_lossy().into_owned();
        let patient_path = entry.path();
        let (last_name, first_name) = split_patient_name(&folder_name);
        let metadata = read_patient_metadata(&entry.path());
        let metadata_value = read_patient_metadata_value(&entry.path());
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
    }

    folders.sort_by_key(|(_, last_name, first_name, _, _)| {
        (last_name.to_lowercase(), first_name.to_lowercase())
    });

    let mut conn = open_db(&app_handle)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "DELETE FROM patient_index WHERE workspace_dir = ?1",
        params![workspace.to_string_lossy().to_string()],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "DELETE FROM patient_treatment_index WHERE workspace_dir = ?1",
        params![workspace.to_string_lossy().to_string()],
    )
    .map_err(|e| e.to_string())?;

    for (folder_name, last_name, first_name, patient_id, metadata_text) in &folders {
        let search_text = build_search_text(last_name, first_name, metadata_text);
        tx.execute(
            "INSERT INTO patient_index (workspace_dir, folder_name, last_name, first_name, patient_id, search_text)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                workspace.to_string_lossy().to_string(),
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
                workspace.to_string_lossy().to_string(),
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
fn search_patients(
    app_handle: tauri::AppHandle,
    workspace_dir: String,
    query: String,
) -> Result<Vec<PatientSearchRow>, String> {
    let conn = open_db(&app_handle)?;
    let q = query.trim().to_lowercase();
    let mut rows_out: Vec<PatientSearchRow> = Vec::new();

    if q.is_empty() {
        let mut stmt = conn
            .prepare(
                "SELECT folder_name, patient_id
                 FROM patient_index
                 WHERE workspace_dir = ?1
                 ORDER BY last_name COLLATE NOCASE, first_name COLLATE NOCASE",
            )
            .map_err(|e| e.to_string())?;

        let rows = stmt
            .query_map(params![workspace_dir], |row| {
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
                 ORDER BY last_name COLLATE NOCASE, first_name COLLATE NOCASE",
            )
            .map_err(|e| e.to_string())?;

        let rows = stmt
            .query_map(params![workspace_dir, pattern], |row| {
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

    Ok(rows_out)
}

#[tauri::command]
async fn get_image_preview_kinds(paths: Vec<String>) -> Result<Vec<ImagePreviewKindRow>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut out = Vec::with_capacity(paths.len());

        for raw_path in paths {
            let path = raw_path.trim().to_string();
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
            let path = raw_path.trim().to_string();
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
    let import_files = file_paths
        .into_iter()
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>();
    let target_dir_clone = target_dir.clone();

    tauri::async_runtime::spawn_blocking(move || {
        let total_bytes: u64 = import_files
            .iter()
            .filter_map(|p| fs::metadata(p).ok())
            .map(|m| m.len())
            .sum();
        let total_count: u64 = import_files.len() as u64;
        let mut copied_bytes: u64 = 0;
        let mut copied_count: u64 = 0;

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
                        let _ = fs::remove_file(&src_path);
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = apply_saved_window_state(&app.handle(), &window);
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            match event {
                tauri::WindowEvent::Resized(_) | tauri::WindowEvent::Moved(_) | tauri::WindowEvent::CloseRequested { .. } => {
                    let _ = persist_window_state(&window.app_handle(), window);
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            save_workspace,
            clear_workspace,
            open_workspace_dir,
            list_patient_treatment_folders,
            list_patient_timeline_entries,
            create_patient_with_metadata,
            save_patient_metadata,
            save_patient_id,
            is_patient_id_taken,
            reindex_patient_folders,
            search_patients,
            get_image_preview_kinds,
            get_image_previews,
            start_import_files,
            load_settings
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
