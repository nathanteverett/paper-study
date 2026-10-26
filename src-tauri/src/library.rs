//! The on-disk library: papers, threads and settings in `library.json`,
//! with each paper's PDF and extracted text under `papers/<id>/`.
//! The CLIs run with the library root as their working directory, so the
//! relative paths we hand them (`papers/<id>/paper.pdf`) resolve there.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Paper {
    pub id: String,
    pub title: String,
    pub authors: Vec<String>,
    pub year: Option<i32>,
    #[serde(rename = "abstract")]
    pub abstract_text: Option<String>,
    pub venue: Option<String>,
    pub source: String,
    pub external_id: Option<String>,
    pub url: Option<String>,
    pub has_pdf: bool,
    pub has_text: bool,
    pub added_at: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Anchor {
    pub paper_id: String,
    pub page: u32,
    pub quote: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Message {
    pub id: String,
    pub role: String,
    pub text: String,
    pub provider: Option<String>,
    pub at: i64,
    pub error: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Thread {
    pub id: String,
    pub title: String,
    /// "paper": a paper's main thread or a side chat under it.
    /// "research": a thread across several papers, or none.
    /// "discover": a brainstorm that ends in a deep literature search.
    pub kind: String,
    /// Papers in this conversation's context. One for a paper's main thread,
    /// several (or none) for a research thread.
    pub paper_ids: Vec<String>,
    /// Set on side chats: the thread they branched from.
    pub parent_id: Option<String>,
    /// Set on side chats opened from a PDF selection.
    pub anchor: Option<Anchor>,
    pub provider: String,
    /// CLI session id per provider ("claude" / "codex"), used to resume.
    pub sessions: HashMap<String, String>,
    pub messages: Vec<Message>,
    /// Deep research results for "discover" threads, shaped by the UI.
    pub findings: Option<serde_json::Value>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub default_provider: String,
    pub claude_path: String,
    pub claude_model: String,
    pub claude_extra_args: String,
    pub codex_path: String,
    pub codex_model: String,
    pub codex_extra_args: String,
    /// Lets Claude use WebSearch/WebFetch to find related work.
    pub allow_web: bool,
    pub semantic_scholar_key: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            default_provider: "claude".into(),
            claude_path: String::new(),
            claude_model: String::new(),
            claude_extra_args: String::new(),
            codex_path: String::new(),
            codex_model: String::new(),
            codex_extra_args: String::new(),
            allow_web: true,
            semantic_scholar_key: String::new(),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Data {
    pub papers: Vec<Paper>,
    pub threads: Vec<Thread>,
    pub settings: Settings,
}

pub struct Library {
    pub root: PathBuf,
    pub data: Data,
}

pub struct LibraryState(pub Mutex<Library>);

pub fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn new_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()[..12].to_string()
}

impl Library {
    pub fn load(root: PathBuf) -> Result<Self, String> {
        fs::create_dir_all(root.join("papers")).map_err(|e| e.to_string())?;
        let file = root.join("library.json");
        let data = if file.exists() {
            let raw = fs::read_to_string(&file).map_err(|e| e.to_string())?;
            serde_json::from_str(&raw).map_err(|e| format!("library.json is unreadable: {e}"))?
        } else {
            Data::default()
        };
        Ok(Self { root, data })
    }

    pub fn save(&self) -> Result<(), String> {
        let raw = serde_json::to_string_pretty(&self.data).map_err(|e| e.to_string())?;
        // Write then rename so a crash never leaves a half-written library.
        let tmp = self.root.join("library.json.tmp");
        fs::write(&tmp, raw).map_err(|e| e.to_string())?;
        fs::rename(&tmp, self.root.join("library.json")).map_err(|e| e.to_string())
    }

    pub fn paper_dir(&self, id: &str) -> PathBuf {
        self.root.join("papers").join(id)
    }

    pub fn pdf_path(&self, id: &str) -> PathBuf {
        self.paper_dir(id).join("paper.pdf")
    }

    pub fn text_path(&self, id: &str) -> PathBuf {
        self.paper_dir(id).join("paper.txt")
    }

    pub fn paper(&self, id: &str) -> Option<&Paper> {
        self.data.papers.iter().find(|p| p.id == id)
    }

    pub fn thread(&self, id: &str) -> Option<&Thread> {
        self.data.threads.iter().find(|t| t.id == id)
    }

    pub fn thread_mut(&mut self, id: &str) -> Option<&mut Thread> {
        self.data.threads.iter_mut().find(|t| t.id == id)
    }

    /// Adds a paper, writing its PDF bytes if we have them.
    pub fn insert_paper(&mut self, mut paper: Paper, pdf: Option<&[u8]>) -> Result<Paper, String> {
        fs::create_dir_all(self.paper_dir(&paper.id)).map_err(|e| e.to_string())?;
        if let Some(bytes) = pdf {
            fs::write(self.pdf_path(&paper.id), bytes).map_err(|e| e.to_string())?;
            paper.has_pdf = true;
        }
        self.data.papers.insert(0, paper.clone());
        self.save()?;
        Ok(paper)
    }
}

pub fn read_pdf_file(path: &Path) -> Result<Vec<u8>, String> {
    let bytes = fs::read(path).map_err(|e| format!("Could not read {}: {e}", path.display()))?;
    if !bytes.starts_with(b"%PDF") {
        return Err("That file is not a PDF.".into());
    }
    Ok(bytes)
}

pub fn title_from_filename(path: &Path) -> String {
    path.file_stem()
        .map(|s| s.to_string_lossy().replace(['_', '-'], " "))
        .unwrap_or_else(|| "Untitled paper".into())
}
