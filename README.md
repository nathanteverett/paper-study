# Paper Study

A desktop reading room for research papers. The PDF sits in the middle, and a chat with **Claude Code** or **Codex** sits beside it. Chats run through the installed command-line tools, so they use your existing Claude and ChatGPT subscriptions rather than API keys.

- **Find papers:** search arXiv or Semantic Scholar, and add a result in one click. Open-access PDFs download automatically. You can also import PDFs you already have.
- **Brainstorm, then deep research:** the ⤢ button beside the search box expands it into the Research Studio, a full-width chat that starts from what you typed. When the question is sharp, **Run deep research** works in three steps:
  1. The assistant writes a search plan.
  2. The app runs the plan against arXiv (and Semantic Scholar if you've added a key).
  3. The assistant ranks the real results into themes, gaps and next steps, with an Add button on every paper.

  Papers only ever come from those searches, never from the model's memory.
- **Read and ask:** answers render Markdown and LaTeX math with KaTeX. Page citations such as `[p. 4]` become chips that scroll the PDF to that page.
- **Side chats:** select a passage and choose *Explain* or *Ask in side chat*. The side chat forks the parent conversation's CLI session, so it starts with the full context of the main thread, and the passage stays highlighted in the PDF.
- **Research threads:** tick several papers to compare them, combine ideas and plan next steps. You can also start an open thread with no papers.
- **Switch assistants per message:** if you change from Claude Code to Codex partway through a thread, the new assistant receives the conversation so far.

## Requirements

- [Rust](https://rustup.rs) and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/). On Windows that means the MSVC build tools and WebView2.
- Node 20 or later.
- At least one of these, signed in:
  - Claude Code: run `claude`, then `/login`
  - Codex: run `codex login`. Make sure the model in `~/.codex/config.toml` is one your plan supports, or set one in Settings.

## Run

```bash
npm install
npm run tauri dev       # desktop app with hot reload
npm run tauri build     # installer in src-tauri/target/release/bundle
```

`npm run dev` on its own serves the interface in an ordinary browser with sample data from `src/devMock.ts`. Use it for interface work. Put any PDF at `demo/sample.pdf` to see the viewer.

## How it works

```
src/                    React UI
  App.tsx               state: papers, threads, side chats, page jumps
  components/PdfViewer  react-pdf (pdf.js), lazy page rendering, selection → side chat
  components/ChatPanel  thread chips, streaming replies, assistant switch
  components/Markdown   react-markdown + remark-math + rehype-katex, citation chips
src-tauri/src/
  library.rs            library.json + papers/<id>/paper.pdf, paper.txt
  search.rs             arXiv Atom API, Semantic Scholar Graph API, PDF download
  chat.rs               spawns the CLIs, parses their JSON streams, keeps sessions
```

The library lives in the app data folder. Settings shows its location. Each chat turn runs one of these commands in that folder, with the prompt sent on stdin:

| | First turn | Next turns | Side chat's first turn |
|---|---|---|---|
| Claude Code | `claude -p --output-format stream-json --tools Read,Grep,Glob[,WebSearch,WebFetch]` | `--resume <id>` | `--resume <parent> --fork-session` |
| Codex | `codex exec --json -s read-only` | `codex exec resume <id>` | `codex exec fork <parent>` |

Both assistants get read-only access. When a paper is first opened, the viewer extracts its text with `=== Page N ===` markers. Both CLIs can then grep and quote it, and Claude can also read the PDF itself for figures and equations.

## Tests

```bash
cd src-tauri
cargo test                        # parsers for both CLIs' output and prompt building
cargo test -- --include-ignored   # also hits arXiv and Semantic Scholar live
```

## Known limits and next steps

- Semantic Scholar's free tier often answers `429` without a key. Add a free key in Settings, or use arXiv.
- Highlights match text items on the page, not exact character ranges.
- Ideas for later: Zotero import, notes per thread, a "merge side chat back" summary, exporting a research thread as a document, and an MCP server so other agents can read the library.
