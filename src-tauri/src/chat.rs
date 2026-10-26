//! Runs a chat turn through the Claude Code or Codex CLI, so replies come out
//! of the user's own subscription. Each thread keeps one CLI session per
//! provider; a side chat's first turn forks its parent's session so it starts
//! with the whole parent conversation in context.

use crate::library::{new_id, now, Anchor, Library, LibraryState, Message, Settings, Thread};
use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const GUIDE: &str = "You are a research assistant inside Paper Study, a desktop app where I read and discuss academic papers. Answer in Markdown.
- Read the paper files before answering questions about their content. paper.txt is the extracted text with \"=== Page N ===\" markers, best for searching and quoting; open paper.pdf when figures, tables or equations matter.
- Cite pages for claims taken from a paper: write [p. 4] when one paper is in play, or [2, p. 4] (paper number, then page) when several are.
- Write math in LaTeX: $...$ inline and $$...$$ on its own lines for display equations.
- Be precise. Say plainly when something is not in the papers, and keep what a paper claims apart from your own assessment.
- The files are read-only reference material: do not create or edit files.";

const BRAINSTORM: &str = "You are a research partner inside Paper Study, a desktop app for finding and reading academic papers. Answer in Markdown.
We are brainstorming before a literature search. Help me sharpen the research question: ask a clarifying question when it is vague, suggest angles, terminology, competing approaches, adjacent fields, and well-known works worth checking. Keep replies conversational and concise.
Later I will run a deep search of arXiv and Semantic Scholar from this conversation, so don't present papers recalled from memory as a complete list.
Write math in LaTeX: $...$ inline and $$...$$ for display equations.";

#[derive(Default)]
pub struct Running {
    pids: Mutex<HashMap<String, u32>>,
    stopped: Mutex<HashSet<String>>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ChatEvent<'a> {
    thread_id: &'a str,
    /// "delta" appends text to the reply; "activity" is a status line such as a file read.
    kind: &'a str,
    text: String,
}

enum Session {
    New,
    Resume(String),
    Fork(String),
}

enum Ev {
    Delta(String),
    Activity(String),
}

struct Outcome {
    text: String,
    session_id: Option<String>,
    is_error: bool,
}

// ---------------------------------------------------------------- prompts

fn short_authors(authors: &[String]) -> String {
    match authors.len() {
        0 => String::new(),
        1 | 2 => authors.join(" and "),
        _ => format!("{} et al.", authors[0]),
    }
}

fn paper_listing(lib: &Library, ids: &[String]) -> String {
    ids.iter()
        .enumerate()
        .filter_map(|(i, id)| {
            let p = lib.paper(id)?;
            let mut s = format!("[{}] \"{}\"", i + 1, p.title);
            if !p.authors.is_empty() {
                s += &format!(" by {}", short_authors(&p.authors));
            }
            if let Some(y) = p.year {
                s += &format!(" ({y})");
            }
            if p.has_text {
                s += &format!("\n    Text: papers/{}/paper.txt", p.id);
            }
            if p.has_pdf {
                s += &format!("\n    PDF:  papers/{}/paper.pdf", p.id);
            }
            if !p.has_pdf && !p.has_text {
                if let Some(a) = &p.abstract_text {
                    s += &format!("\n    (No full text, abstract only) {a}");
                }
            }
            Some(s)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn transcript(thread: &Thread) -> String {
    let start = thread.messages.len().saturating_sub(12);
    thread.messages[start..]
        .iter()
        .filter(|m| !m.error)
        .map(|m| {
            let who = if m.role == "user" { "Me" } else { "Assistant" };
            let mut text: String = m.text.chars().take(2000).collect();
            if m.text.chars().count() > 2000 {
                text.push_str(" […]");
            }
            format!("{who}: {text}")
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn anchor_block(lib: &Library, anchor: &Anchor) -> String {
    let title = lib.paper(&anchor.paper_id).map(|p| p.title.as_str()).unwrap_or("the paper");
    let quote = anchor.quote.trim().replace('\n', "\n> ");
    format!("The passage I selected (page {} of \"{title}\"):\n> {quote}", anchor.page)
}

fn build_prompt(lib: &Library, thread: &Thread, text: &str, session: &Session) -> String {
    match session {
        Session::Resume(_) => text.to_string(),
        Session::Fork(_) => {
            let mut s = String::from("We are branching into a side discussion from the conversation above.");
            if let Some(a) = &thread.anchor {
                s += "\n\n";
                s += &anchor_block(lib, a);
            }
            s + "\n\n" + text
        }
        Session::New if thread.kind == "discover" => {
            let mut s = format!("{BRAINSTORM}\n\n");
            if !thread.messages.is_empty() {
                s += "We already started this conversation with another assistant:\n\n";
                s += &transcript(thread);
                s += "\n\n";
            }
            s + "My message:\n" + text
        }
        Session::New => {
            let mut s = format!("{GUIDE}\n\n");
            if thread.paper_ids.is_empty() {
                s += "No papers are attached to this conversation yet. Help me find papers and plan research; name specific papers (title, authors, year) so I can add them to my library.";
            } else {
                s += "Papers in this conversation (paths are relative to the current directory):\n";
                s += &paper_listing(lib, &thread.paper_ids);
            }
            if let Some(parent) = thread.parent_id.as_deref().and_then(|id| lib.thread(id)) {
                if !parent.messages.is_empty() {
                    s += "\n\nThis is a side chat branched from an earlier conversation. Its recent part:\n\n";
                    s += &transcript(parent);
                }
            }
            if !thread.messages.is_empty() {
                s += "\n\nWe already started this conversation with another assistant:\n\n";
                s += &transcript(thread);
            }
            if let Some(a) = &thread.anchor {
                s += "\n\n";
                s += &anchor_block(lib, a);
            }
            s + "\n\nMy message:\n" + text
        }
    }
}

// ---------------------------------------------------------------- commands

pub fn resolve_program(configured: &str, name: &str) -> Result<PathBuf, String> {
    if !configured.trim().is_empty() {
        return Ok(PathBuf::from(configured.trim()));
    }
    let exts: &[&str] = if cfg!(windows) { &[".exe", ".cmd", ".bat"] } else { &[""] };
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    // Apps started from the Start menu can have a thinner PATH than a terminal.
    if let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) {
        dirs.push(PathBuf::from(&home).join(".local").join("bin"));
    }
    if let Some(appdata) = std::env::var_os("APPDATA") {
        dirs.push(PathBuf::from(appdata).join("npm"));
    }
    for dir in dirs {
        for ext in exts {
            let candidate = dir.join(format!("{name}{ext}"));
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
    }
    Err(format!("Could not find `{name}`. Install it, or set its path in Settings."))
}

fn split_args(extra: &str) -> Vec<String> {
    extra.split_whitespace().map(str::to_string).collect()
}

fn claude_args(settings: &Settings, session: &Session) -> Vec<String> {
    let mut tools = String::from("Read,Grep,Glob");
    if settings.allow_web {
        tools += ",WebSearch,WebFetch";
    }
    let mut args: Vec<String> = [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--strict-mcp-config",
        "--tools",
        &tools,
        "--allowedTools",
        &tools,
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    if !settings.claude_model.trim().is_empty() {
        args.extend(["--model".into(), settings.claude_model.trim().into()]);
    }
    match session {
        Session::New => {}
        Session::Resume(id) => args.extend(["--resume".into(), id.clone()]),
        Session::Fork(id) => args.extend(["--resume".into(), id.clone(), "--fork-session".into()]),
    }
    args.extend(split_args(&settings.claude_extra_args));
    args
}

fn codex_args(settings: &Settings, session: &Session) -> Vec<String> {
    let mut opts: Vec<String> = vec!["--json".into(), "--skip-git-repo-check".into()];
    if !settings.codex_model.trim().is_empty() {
        opts.extend(["-m".into(), settings.codex_model.trim().into()]);
    }
    opts.extend(split_args(&settings.codex_extra_args));
    // The prompt arrives on stdin ("-").
    let mut args: Vec<String> = vec!["exec".into()];
    match session {
        Session::New => {
            args.extend(["-s".into(), "read-only".into()]);
            args.extend(opts);
        }
        Session::Resume(id) => {
            args.push("resume".into());
            args.extend(opts);
            args.push(id.clone());
        }
        Session::Fork(id) => {
            args.push("fork".into());
            args.extend(opts);
            args.push(id.clone());
        }
    }
    args.push("-".into());
    args
}

fn command(program: &PathBuf) -> Command {
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

// ---------------------------------------------------------------- output parsing

fn short(s: &str, n: usize) -> String {
    let s = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if s.chars().count() > n {
        format!("{}…", s.chars().take(n).collect::<String>())
    } else {
        s
    }
}

/// Names a file the CLI touched by its paper title when it is one of ours.
fn describe_path(path: &str, titles: &HashMap<String, String>) -> String {
    let norm = path.replace('\\', "/");
    if let Some(rest) = norm.split("papers/").nth(1) {
        let mut parts = rest.split('/');
        if let (Some(id), Some(file)) = (parts.next(), parts.next()) {
            if let Some(title) = titles.get(id) {
                let kind = if file.ends_with(".pdf") { "PDF" } else { "text" };
                return format!("{} ({kind})", short(title, 60));
            }
        }
    }
    norm.rsplit('/').next().unwrap_or(&norm).to_string()
}

#[derive(Default)]
struct ClaudeParser {
    text: String,
    result: Option<String>,
    session: Option<String>,
    is_error: bool,
    gap: bool,
}

impl ClaudeParser {
    fn feed(&mut self, v: &Value, titles: &HashMap<String, String>) -> Vec<Ev> {
        let mut out = Vec::new();
        match v["type"].as_str() {
            Some("system") => {
                if let Some(s) = v["session_id"].as_str() {
                    self.session = Some(s.into());
                }
            }
            Some("stream_event") => {
                let e = &v["event"];
                match e["type"].as_str() {
                    Some("message_start") if !self.text.is_empty() => self.gap = true,
                    Some("content_block_delta") if e["delta"]["type"] == "text_delta" => {
                        let mut t = e["delta"]["text"].as_str().unwrap_or_default().to_string();
                        if self.gap {
                            t = format!("\n\n{t}");
                            self.gap = false;
                        }
                        self.text += &t;
                        out.push(Ev::Delta(t));
                    }
                    _ => {}
                }
            }
            Some("assistant") => {
                for block in v["message"]["content"].as_array().into_iter().flatten() {
                    if block["type"] != "tool_use" {
                        continue;
                    }
                    let input = &block["input"];
                    let line = match block["name"].as_str().unwrap_or_default() {
                        "Read" => format!("Reading {}", describe_path(input["file_path"].as_str().unwrap_or_default(), titles)),
                        "Grep" => format!("Searching for \u{201c}{}\u{201d}", short(input["pattern"].as_str().unwrap_or_default(), 60)),
                        "Glob" => "Looking through the library".to_string(),
                        "WebSearch" => format!("Searching the web: {}", short(input["query"].as_str().unwrap_or_default(), 80)),
                        "WebFetch" => format!("Opening {}", short(input["url"].as_str().unwrap_or_default(), 80)),
                        other => format!("Using {other}"),
                    };
                    out.push(Ev::Activity(line));
                }
            }
            Some("result") => {
                if let Some(s) = v["session_id"].as_str() {
                    self.session = Some(s.into());
                }
                self.is_error = v["is_error"].as_bool().unwrap_or(false);
                self.result = v["result"].as_str().map(str::to_string);
            }
            _ => {}
        }
        out
    }

    fn finish(self, stderr: &str) -> Result<Outcome, String> {
        if let Some(mut result) = self.result {
            if self.is_error {
                if result.contains("Not logged in") {
                    result += "\n\nOpen a terminal, run `claude`, and sign in with `/login`. Paper Study uses that login.";
                }
                return Ok(Outcome { text: result, session_id: None, is_error: true });
            }
            // `result` holds the final answer without the narration between tool calls.
            let text = if result.trim().is_empty() { self.text } else { result };
            return Ok(Outcome { text, session_id: self.session, is_error: false });
        }
        if !self.text.is_empty() {
            return Ok(Outcome { text: self.text, session_id: self.session, is_error: false });
        }
        Err(failure("Claude Code", stderr))
    }
}

#[derive(Default)]
struct CodexParser {
    parts: Vec<String>,
    session: Option<String>,
    error: Option<String>,
}

impl CodexParser {
    fn feed(&mut self, v: &Value, titles: &HashMap<String, String>) -> Vec<Ev> {
        let mut out = Vec::new();
        match v["type"].as_str() {
            Some("thread.started") => self.session = v["thread_id"].as_str().map(str::to_string),
            Some(kind @ ("item.started" | "item.completed")) => {
                let item = &v["item"];
                match (kind, item["type"].as_str().unwrap_or_default()) {
                    ("item.started", "command_execution") => {
                        let cmd = item["command"].as_str().map(str::to_string).unwrap_or_else(|| item["command"].to_string());
                        let line = if cmd.contains("papers/") || cmd.contains("papers\\") {
                            let path = cmd.split_whitespace().find(|w| w.contains("papers")).unwrap_or_default();
                            format!("Reading {}", describe_path(path.trim_matches(['"', '\'']), titles))
                        } else {
                            format!("Running {}", short(&cmd, 70))
                        };
                        out.push(Ev::Activity(line));
                    }
                    ("item.started", "web_search") => {
                        out.push(Ev::Activity(format!("Searching the web: {}", short(item["query"].as_str().unwrap_or_default(), 80))));
                    }
                    ("item.completed", "agent_message") => {
                        let text = item["text"].as_str().unwrap_or_default().to_string();
                        let delta = if self.parts.is_empty() { text.clone() } else { format!("\n\n{text}") };
                        self.parts.push(text);
                        out.push(Ev::Delta(delta));
                    }
                    _ => {}
                }
            }
            Some("turn.failed") => self.error = v["error"]["message"].as_str().map(str::to_string),
            Some("error") => self.error = v["message"].as_str().map(str::to_string),
            _ => {}
        }
        out
    }

    fn finish(self, stderr: &str) -> Result<Outcome, String> {
        if !self.parts.is_empty() {
            return Ok(Outcome { text: self.parts.join("\n\n"), session_id: self.session, is_error: false });
        }
        if let Some(raw) = self.error {
            // Codex nests the API error as a JSON string.
            let parsed: Option<Value> = serde_json::from_str(&raw).ok();
            let message = parsed
                .as_ref()
                .and_then(|p| p["error"]["message"].as_str())
                .map(str::to_string)
                .unwrap_or(raw);
            let hint = if message.contains("model") && message.contains("not supported") {
                "\n\nSet a model your account supports in Settings → Codex model."
            } else {
                ""
            };
            return Ok(Outcome { text: format!("{message}{hint}"), session_id: None, is_error: true });
        }
        Err(failure("Codex", stderr))
    }
}

fn failure(name: &str, stderr: &str) -> String {
    let tail: Vec<&str> = stderr.lines().filter(|l| !l.trim().is_empty()).collect();
    let tail = tail[tail.len().saturating_sub(6)..].join("\n");
    if tail.is_empty() {
        format!("{name} exited without a reply.")
    } else {
        format!("{name} exited without a reply:\n\n```\n{tail}\n```")
    }
}

// ---------------------------------------------------------------- running

#[allow(clippy::too_many_arguments)]
async fn run_cli(
    app: &AppHandle,
    running: &Running,
    thread_id: &str,
    provider: &str,
    program: PathBuf,
    args: Vec<String>,
    prompt: String,
    cwd: PathBuf,
    titles: HashMap<String, String>,
) -> Result<Outcome, String> {
    let mut child = command(&program)
        .args(&args)
        .current_dir(&cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("Could not start {}: {e}", program.display()))?;
    if let Some(pid) = child.id() {
        running.pids.lock().unwrap().insert(thread_id.to_string(), pid);
    }

    let mut stdin = child.stdin.take().ok_or("no stdin")?;
    stdin.write_all(prompt.as_bytes()).await.map_err(|e| e.to_string())?;
    drop(stdin);

    let stderr = child.stderr.take().ok_or("no stderr")?;
    let stderr_task = tokio::spawn(async move {
        let mut s = String::new();
        let _ = BufReader::new(stderr).read_to_string(&mut s).await;
        s
    });

    let mut claude = ClaudeParser::default();
    let mut codex = CodexParser::default();
    let mut lines = BufReader::new(child.stdout.take().ok_or("no stdout")?).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
        let events = if provider == "claude" { claude.feed(&v, &titles) } else { codex.feed(&v, &titles) };
        for ev in events {
            let (kind, text) = match ev {
                Ev::Delta(t) => ("delta", t),
                Ev::Activity(t) => ("activity", t),
            };
            let _ = app.emit("chat-event", ChatEvent { thread_id, kind, text });
        }
    }
    let _ = child.wait().await;
    running.pids.lock().unwrap().remove(thread_id);
    let stderr = stderr_task.await.unwrap_or_default();

    if running.stopped.lock().unwrap().remove(thread_id) {
        let (partial, session) = if provider == "claude" {
            (claude.text, claude.session)
        } else {
            (codex.parts.join("\n\n"), codex.session)
        };
        let text = if partial.trim().is_empty() { "*Stopped.*".to_string() } else { format!("{partial}\n\n*Stopped.*") };
        return Ok(Outcome { text, session_id: session, is_error: false });
    }
    if provider == "claude" {
        claude.finish(&stderr)
    } else {
        codex.finish(&stderr)
    }
}

#[tauri::command]
pub async fn send_message(
    app: AppHandle,
    lib: State<'_, LibraryState>,
    running: State<'_, Running>,
    thread_id: String,
    text: String,
    provider: String,
    // What the transcript shows instead of `text`, for long app-written prompts.
    display: Option<String>,
) -> Result<Message, String> {
    let shown = display.unwrap_or_else(|| text.clone());
    let (program, args, prompt, cwd, titles) = {
        let mut l = lib.0.lock().unwrap();
        let thread = l.thread(&thread_id).cloned().ok_or("Thread not found")?;
        let settings = l.data.settings.clone();
        let session = if let Some(id) = thread.sessions.get(&provider) {
            Session::Resume(id.clone())
        } else if let Some(parent_session) = thread
            .parent_id
            .as_deref()
            .and_then(|p| l.thread(p))
            .and_then(|p| p.sessions.get(&provider))
            .filter(|_| thread.messages.is_empty())
        {
            Session::Fork(parent_session.clone())
        } else {
            Session::New
        };
        let prompt = build_prompt(&l, &thread, &text, &session);
        let (program, args) = match provider.as_str() {
            "claude" => (resolve_program(&settings.claude_path, "claude")?, claude_args(&settings, &session)),
            "codex" => (resolve_program(&settings.codex_path, "codex")?, codex_args(&settings, &session)),
            other => return Err(format!("Unknown provider {other}")),
        };
        let titles = l.data.papers.iter().map(|p| (p.id.clone(), p.title.clone())).collect();

        let t = l.thread_mut(&thread_id).unwrap();
        if t.messages.is_empty() && t.title.starts_with("New ") {
            t.title = short(&shown, 48);
        }
        t.provider = provider.clone();
        t.messages.push(Message {
            id: new_id(),
            role: "user".into(),
            text: shown,
            provider: None,
            at: now(),
            error: false,
        });
        t.updated_at = now();
        l.save()?;
        (program, args, prompt, l.root.clone(), titles)
    };

    let outcome = run_cli(&app, &running, &thread_id, &provider, program, args, prompt, cwd, titles).await;

    let mut l = lib.0.lock().unwrap();
    let t = l.thread_mut(&thread_id).ok_or("Thread was deleted")?;
    let message = match outcome {
        Ok(o) => {
            if let Some(sid) = o.session_id {
                t.sessions.insert(provider.clone(), sid);
            }
            Message { id: new_id(), role: "assistant".into(), text: o.text, provider: Some(provider), at: now(), error: o.is_error }
        }
        Err(e) => Message { id: new_id(), role: "assistant".into(), text: e, provider: Some(provider), at: now(), error: true },
    };
    t.messages.push(message.clone());
    t.updated_at = now();
    l.save()?;
    Ok(message)
}

#[tauri::command]
pub fn cancel_message(running: State<'_, Running>, thread_id: String) {
    let Some(pid) = running.pids.lock().unwrap().remove(&thread_id) else { return };
    running.stopped.lock().unwrap().insert(thread_id);
    // Kill the whole tree: codex.cmd runs node, which runs the agent.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .status();
    }
    #[cfg(not(windows))]
    {
        let _ = std::process::Command::new("kill").arg(pid.to_string()).status();
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatus {
    path: Option<String>,
    version: Option<String>,
    error: Option<String>,
}

async fn probe(configured: &str, name: &str) -> ProviderStatus {
    let program = match resolve_program(configured, name) {
        Ok(p) => p,
        Err(e) => return ProviderStatus { path: None, version: None, error: Some(e) },
    };
    let path = Some(program.display().to_string());
    let run = command(&program).arg("--version").stdin(Stdio::null()).output();
    match tokio::time::timeout(Duration::from_secs(20), run).await {
        Ok(Ok(out)) if out.status.success() => ProviderStatus {
            path,
            version: Some(String::from_utf8_lossy(&out.stdout).trim().to_string()),
            error: None,
        },
        Ok(Ok(out)) => ProviderStatus { path, version: None, error: Some(String::from_utf8_lossy(&out.stderr).trim().to_string()) },
        Ok(Err(e)) => ProviderStatus { path, version: None, error: Some(e.to_string()) },
        Err(_) => ProviderStatus { path, version: None, error: Some("Timed out".into()) },
    }
}

#[tauri::command]
pub async fn check_providers(lib: State<'_, LibraryState>) -> Result<HashMap<String, ProviderStatus>, String> {
    let settings = lib.0.lock().unwrap().data.settings.clone();
    let (claude, codex) = tokio::join!(probe(&settings.claude_path, "claude"), probe(&settings.codex_path, "codex"));
    Ok(HashMap::from([("claude".to_string(), claude), ("codex".to_string(), codex)]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library::{Data, Paper};

    fn titles() -> HashMap<String, String> {
        HashMap::from([("abc".to_string(), "Attention Is All You Need".to_string())])
    }

    fn lines(raw: &[&str]) -> Vec<Value> {
        raw.iter().map(|l| serde_json::from_str(l).unwrap()).collect()
    }

    #[test]
    fn claude_streams_text_activity_and_result() {
        let mut p = ClaudeParser::default();
        let mut events = Vec::new();
        for v in lines(&[
            r#"{"type":"system","subtype":"init","session_id":"s-1"}"#,
            r#"{"type":"stream_event","event":{"type":"message_start"}}"#,
            r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Let me read it."}}}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"C:\\lib\\papers\\abc\\paper.pdf"}}]}}"#,
            r#"{"type":"stream_event","event":{"type":"message_start"}}"#,
            r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"It uses $QK^T$."}}}"#,
            r#"{"type":"result","subtype":"success","is_error":false,"result":"It uses $QK^T$.","session_id":"s-1"}"#,
        ]) {
            events.extend(p.feed(&v, &titles()));
        }
        assert!(matches!(&events[1], Ev::Activity(a) if a == "Reading Attention Is All You Need (PDF)"));
        assert!(matches!(&events[2], Ev::Delta(d) if d == "\n\nIt uses $QK^T$."));
        let out = p.finish("").unwrap();
        assert_eq!(out.text, "It uses $QK^T$.");
        assert_eq!(out.session_id.as_deref(), Some("s-1"));
        assert!(!out.is_error);
    }

    #[test]
    fn claude_not_logged_in_is_an_error_with_a_hint() {
        // Recorded from `claude -p` 2.1.168 without a login.
        let mut p = ClaudeParser::default();
        for v in lines(&[
            r#"{"type":"system","subtype":"init","session_id":"d75b"}"#,
            r#"{"type":"result","subtype":"success","is_error":true,"result":"Not logged in · Please run /login","session_id":"d75b"}"#,
        ]) {
            p.feed(&v, &titles());
        }
        let out = p.finish("").unwrap();
        assert!(out.is_error);
        assert!(out.session_id.is_none());
        assert!(out.text.contains("/login"));
    }

    #[test]
    fn codex_collects_messages_and_commands() {
        let mut p = CodexParser::default();
        let mut events = Vec::new();
        for v in lines(&[
            r#"{"type":"thread.started","thread_id":"t-9"}"#,
            r#"{"type":"turn.started"}"#,
            r#"{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"Get-Content papers/abc/paper.txt"}}"#,
            r#"{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"Scaled dot-product attention [p. 4]."}}"#,
            r#"{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":5}}"#,
        ]) {
            events.extend(p.feed(&v, &titles()));
        }
        assert!(matches!(&events[0], Ev::Activity(a) if a == "Reading Attention Is All You Need (text)"));
        let out = p.finish("").unwrap();
        assert_eq!(out.text, "Scaled dot-product attention [p. 4].");
        assert_eq!(out.session_id.as_deref(), Some("t-9"));
    }

    #[test]
    fn codex_model_error_is_readable() {
        // Recorded from `codex exec --json` 0.151.0 with an unsupported model.
        let mut p = CodexParser::default();
        for v in lines(&[
            r#"{"type":"thread.started","thread_id":"t-1"}"#,
            r#"{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Model metadata for `x` not found."}}"#,
            r#"{"type":"turn.failed","error":{"message":"{\"type\":\"error\",\"status\":400,\"error\":{\"type\":\"invalid_request_error\",\"message\":\"The 'gpt-6.1' model is not supported when using Codex with a ChatGPT account.\",\"code\":\"model_not_found\"}}"}}"#,
        ]) {
            p.feed(&v, &titles());
        }
        let out = p.finish("").unwrap();
        assert!(out.is_error);
        assert!(out.text.starts_with("The 'gpt-6.1' model is not supported"));
        assert!(out.text.contains("Settings"));
    }

    fn library() -> Library {
        let mut data = Data::default();
        data.papers.push(Paper {
            id: "abc".into(),
            title: "Attention Is All You Need".into(),
            authors: vec!["Vaswani".into(), "Shazeer".into(), "Parmar".into()],
            year: Some(2017),
            has_pdf: true,
            has_text: true,
            ..Default::default()
        });
        Library { root: PathBuf::from("lib"), data }
    }

    #[test]
    fn new_prompt_lists_papers_and_anchor() {
        let lib = library();
        let thread = Thread {
            paper_ids: vec!["abc".into()],
            anchor: Some(Anchor { paper_id: "abc".into(), page: 4, quote: "Scaled Dot-Product".into() }),
            ..Default::default()
        };
        let p = build_prompt(&lib, &thread, "Explain", &Session::New);
        assert!(p.contains("[1] \"Attention Is All You Need\" by Vaswani et al. (2017)"));
        assert!(p.contains("papers/abc/paper.txt"));
        assert!(p.contains("(page 4 of \"Attention Is All You Need\"):\n> Scaled Dot-Product"));
        assert!(p.ends_with("My message:\nExplain"));
        assert_eq!(build_prompt(&lib, &thread, "Next", &Session::Resume("s".into())), "Next");
    }

    #[test]
    fn codex_resume_and_fork_put_the_session_last() {
        let s = Settings { codex_model: "o4".into(), ..Default::default() };
        assert_eq!(
            codex_args(&s, &Session::Resume("t-1".into())),
            ["exec", "resume", "--json", "--skip-git-repo-check", "-m", "o4", "t-1", "-"]
        );
        assert_eq!(codex_args(&s, &Session::Fork("t-1".into()))[1], "fork");
        assert_eq!(
            codex_args(&Settings::default(), &Session::New),
            ["exec", "-s", "read-only", "--json", "--skip-git-repo-check", "-"]
        );
    }
}
