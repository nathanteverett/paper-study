import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type Provider = "claude" | "codex";

export interface Paper {
  id: string;
  title: string;
  authors: string[];
  year: number | null;
  abstract: string | null;
  venue: string | null;
  source: string;
  externalId: string | null;
  url: string | null;
  hasPdf: boolean;
  hasText: boolean;
  addedAt: number;
}

export interface Anchor {
  paperId: string;
  page: number;
  quote: string;
}

export interface Message {
  id: string;
  role: "user" | "assistant";
  text: string;
  provider: Provider | null;
  at: number;
  error: boolean;
}

export type ThreadKind = "paper" | "research" | "discover";

export interface SearchQuery {
  q: string;
  why?: string;
}

export interface FoundPaper {
  result: SearchResult;
  why: string;
}

/** Deep research state for a "discover" thread; persisted as-is by the backend. */
export interface Findings {
  stage: "planning" | "searching" | "ranking" | "done" | "error";
  queries: SearchQuery[];
  searched: number;
  candidates: number;
  overview: string;
  themes: { name: string; summary: string; papers: FoundPaper[] }[];
  gaps: string[];
  nextSteps: string[];
  error: string | null;
  at: number;
}

export interface Thread {
  id: string;
  title: string;
  kind: ThreadKind;
  paperIds: string[];
  parentId: string | null;
  anchor: Anchor | null;
  provider: Provider;
  sessions: Partial<Record<Provider, string>>;
  messages: Message[];
  findings: Findings | null;
  createdAt: number;
  updatedAt: number;
}

export interface Settings {
  defaultProvider: Provider;
  claudePath: string;
  claudeModel: string;
  claudeExtraArgs: string;
  codexPath: string;
  codexModel: string;
  codexExtraArgs: string;
  allowWeb: boolean;
  semanticScholarKey: string;
}

export interface Data {
  papers: Paper[];
  threads: Thread[];
  settings: Settings;
}

export interface SearchResult {
  source: "semanticscholar" | "arxiv";
  id: string;
  title: string;
  authors: string[];
  year: number | null;
  abstract: string | null;
  venue: string | null;
  url: string | null;
  pdfUrl: string | null;
  citationCount: number | null;
}

export interface ProviderStatus {
  path: string | null;
  version: string | null;
  error: string | null;
}

export interface ChatEvent {
  threadId: string;
  kind: "delta" | "activity";
  text: string;
}

export const api = {
  getState: () => invoke<Data>("get_state"),
  libraryPath: () => invoke<string>("library_path"),
  search: (source: string, query: string) => invoke<SearchResult[]>("search_papers", { source, query }),
  addPaper: (result: SearchResult) => invoke<Paper>("add_paper", { result }),
  importPdf: (path: string) => invoke<Paper>("import_pdf", { path }),
  attachPdf: (paperId: string, path: string) => invoke<Paper>("attach_pdf", { paperId, path }),
  updatePaper: (paperId: string, title: string) => invoke<void>("update_paper", { paperId, title }),
  removePaper: (paperId: string) => invoke<void>("remove_paper", { paperId }),
  readPdf: (paperId: string) => invoke<ArrayBuffer>("read_pdf", { paperId }),
  savePaperText: (paperId: string, text: string) => invoke<void>("save_paper_text", { paperId, text }),
  createThread: (thread: {
    title: string;
    kind: ThreadKind;
    paperIds: string[];
    parentId: string | null;
    anchor: Anchor | null;
    provider: Provider;
  }) => invoke<Thread>("create_thread", { thread }),
  renameThread: (threadId: string, title: string) => invoke<void>("rename_thread", { threadId, title }),
  deleteThread: (threadId: string) => invoke<void>("delete_thread", { threadId }),
  saveSettings: (settings: Settings) => invoke<void>("save_settings", { settings }),
  sendMessage: (threadId: string, text: string, provider: Provider, display?: string) =>
    invoke<Message>("send_message", { threadId, text, provider, display: display ?? null }),
  saveFindings: (threadId: string, findings: Findings) => invoke<void>("save_findings", { threadId, findings }),
  cancelMessage: (threadId: string) => invoke<void>("cancel_message", { threadId }),
  checkProviders: () => invoke<Record<Provider, ProviderStatus>>("check_providers"),
  onChatEvent: (cb: (e: ChatEvent) => void): Promise<UnlistenFn> =>
    listen<ChatEvent>("chat-event", (e) => cb(e.payload)),
};

export const providerLabel: Record<Provider, string> = {
  claude: "Claude Code",
  codex: "Codex",
};

export function shortAuthors(authors: string[]): string {
  if (authors.length === 0) return "";
  if (authors.length <= 2) return authors.join(" & ");
  return `${authors[0]} et al.`;
}

export function errorText(e: unknown): string {
  return typeof e === "string" ? e : e instanceof Error ? e.message : JSON.stringify(e);
}
