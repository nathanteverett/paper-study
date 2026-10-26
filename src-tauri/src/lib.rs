mod chat;
mod library;
mod search;

use library::{new_id, now, Anchor, Data, Library, LibraryState, Paper, Settings, Thread};
use search::SearchResult;
use serde::Deserialize;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{ipc::Response, Manager, State};

type Lib<'a> = State<'a, LibraryState>;

#[tauri::command]
fn get_state(lib: Lib) -> Data {
    lib.0.lock().unwrap().data.clone()
}

#[tauri::command]
fn library_path(lib: Lib) -> String {
    lib.0.lock().unwrap().root.display().to_string()
}

#[tauri::command]
async fn search_papers(lib: Lib<'_>, source: String, query: String) -> Result<Vec<SearchResult>, String> {
    let key = lib.0.lock().unwrap().data.settings.semantic_scholar_key.clone();
    match source.as_str() {
        "arxiv" => search::arxiv(&query).await,
        _ => search::semantic_scholar(&query, &key).await,
    }
}

/// Adds a search result to the library, downloading its PDF when one is open access.
#[tauri::command]
async fn add_paper(lib: Lib<'_>, result: SearchResult) -> Result<Paper, String> {
    let pdf = match &result.pdf_url {
        Some(url) => search::download_pdf(url).await.ok(),
        None => None,
    };
    let paper = Paper {
        id: new_id(),
        title: result.title,
        authors: result.authors,
        year: result.year,
        abstract_text: result.abstract_text,
        venue: result.venue,
        source: result.source,
        external_id: Some(result.id),
        url: result.url,
        added_at: now(),
        ..Default::default()
    };
    lib.0.lock().unwrap().insert_paper(paper, pdf.as_deref())
}

#[tauri::command]
fn import_pdf(lib: Lib, path: String) -> Result<Paper, String> {
    let path = PathBuf::from(path);
    let bytes = library::read_pdf_file(&path)?;
    let paper = Paper {
        id: new_id(),
        title: library::title_from_filename(&path),
        source: "local".into(),
        added_at: now(),
        ..Default::default()
    };
    lib.0.lock().unwrap().insert_paper(paper, Some(&bytes))
}

/// Attaches a local PDF to a paper that was added without one.
#[tauri::command]
fn attach_pdf(lib: Lib, paper_id: String, path: String) -> Result<Paper, String> {
    let bytes = library::read_pdf_file(&PathBuf::from(path))?;
    let mut l = lib.0.lock().unwrap();
    fs::create_dir_all(l.paper_dir(&paper_id)).map_err(|e| e.to_string())?;
    fs::write(l.pdf_path(&paper_id), bytes).map_err(|e| e.to_string())?;
    let paper = l.data.papers.iter_mut().find(|p| p.id == paper_id).ok_or("Paper not found")?;
    paper.has_pdf = true;
    paper.has_text = false;
    let paper = paper.clone();
    l.save()?;
    Ok(paper)
}

#[tauri::command]
fn update_paper(lib: Lib, paper_id: String, title: String) -> Result<(), String> {
    let mut l = lib.0.lock().unwrap();
    let paper = l.data.papers.iter_mut().find(|p| p.id == paper_id).ok_or("Paper not found")?;
    paper.title = title;
    l.save()
}

#[tauri::command]
fn remove_paper(lib: Lib, paper_id: String) -> Result<(), String> {
    let mut l = lib.0.lock().unwrap();
    let _ = fs::remove_dir_all(l.paper_dir(&paper_id));
    l.data.papers.retain(|p| p.id != paper_id);
    // The paper's own threads go with it; research threads just lose it.
    l.data.threads.retain(|t| !(t.kind == "paper" && t.paper_ids.contains(&paper_id)));
    for t in &mut l.data.threads {
        t.paper_ids.retain(|id| id != &paper_id);
    }
    l.save()
}

#[tauri::command]
fn read_pdf(lib: Lib, paper_id: String) -> Result<Response, String> {
    let path = lib.0.lock().unwrap().pdf_path(&paper_id);
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    Ok(Response::new(bytes))
}

/// Stores text the viewer extracted with pdf.js, so either CLI can grep and quote it.
#[tauri::command]
fn save_paper_text(lib: Lib, paper_id: String, text: String) -> Result<(), String> {
    let mut l = lib.0.lock().unwrap();
    fs::write(l.text_path(&paper_id), text).map_err(|e| e.to_string())?;
    if let Some(p) = l.data.papers.iter_mut().find(|p| p.id == paper_id) {
        p.has_text = true;
    }
    l.save()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NewThread {
    title: String,
    kind: String,
    paper_ids: Vec<String>,
    parent_id: Option<String>,
    anchor: Option<Anchor>,
    provider: String,
}

#[tauri::command]
fn create_thread(lib: Lib, thread: NewThread) -> Result<Thread, String> {
    let mut l = lib.0.lock().unwrap();
    let t = Thread {
        id: new_id(),
        title: thread.title,
        kind: thread.kind,
        paper_ids: thread.paper_ids,
        parent_id: thread.parent_id,
        anchor: thread.anchor,
        provider: thread.provider,
        created_at: now(),
        updated_at: now(),
        ..Default::default()
    };
    l.data.threads.push(t.clone());
    l.save()?;
    Ok(t)
}

#[tauri::command]
fn rename_thread(lib: Lib, thread_id: String, title: String) -> Result<(), String> {
    let mut l = lib.0.lock().unwrap();
    l.thread_mut(&thread_id).ok_or("Thread not found")?.title = title;
    l.save()
}

#[tauri::command]
fn delete_thread(lib: Lib, thread_id: String) -> Result<(), String> {
    let mut l = lib.0.lock().unwrap();
    // Remove the thread and every side chat below it.
    let mut doomed = vec![thread_id];
    let mut i = 0;
    while i < doomed.len() {
        let id = doomed[i].clone();
        doomed.extend(l.data.threads.iter().filter(|t| t.parent_id.as_ref() == Some(&id)).map(|t| t.id.clone()));
        i += 1;
    }
    l.data.threads.retain(|t| !doomed.contains(&t.id));
    l.save()
}

#[tauri::command]
fn save_findings(lib: Lib, thread_id: String, findings: serde_json::Value) -> Result<(), String> {
    let mut l = lib.0.lock().unwrap();
    l.thread_mut(&thread_id).ok_or("Thread not found")?.findings = Some(findings);
    l.save()
}

#[tauri::command]
fn save_settings(lib: Lib, settings: Settings) -> Result<(), String> {
    let mut l = lib.0.lock().unwrap();
    l.data.settings = settings;
    l.save()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let root = app.path().app_data_dir()?.join("library");
            let lib = Library::load(root)?;
            app.manage(LibraryState(Mutex::new(lib)));
            app.manage(chat::Running::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_state,
            library_path,
            search_papers,
            add_paper,
            import_pdf,
            attach_pdf,
            update_paper,
            remove_paper,
            read_pdf,
            save_paper_text,
            create_thread,
            rename_thread,
            delete_thread,
            save_findings,
            save_settings,
            chat::send_message,
            chat::cancel_message,
            chat::check_providers,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Paper Study");
}
