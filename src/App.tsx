import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  errorText,
  type Anchor,
  type Data,
  type Findings,
  type Message,
  type Paper,
  type Provider,
  type SearchResult,
  type Thread,
} from "./api";
import { Studio } from "./components/Studio";
import { Sidebar } from "./components/Sidebar";
import { PdfViewer, type Jump } from "./components/PdfViewer";
import { ChatPanel, type Pending } from "./components/ChatPanel";
import { SettingsDialog } from "./components/SettingsDialog";

const CHAT_WIDTH_KEY = "chat-width";

function readChatWidth(): number {
  try {
    return Number(localStorage.getItem(CHAT_WIDTH_KEY)) || 460;
  } catch {
    return 460;
  }
}

export default function App() {
  const [data, setData] = useState<Data | null>(null);
  const [paperId, setPaperId] = useState<string | null>(null);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [pending, setPending] = useState<Record<string, Pending>>({});
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [jump, setJump] = useState<Jump | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [focusNonce, setFocusNonce] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [chatWidth, setChatWidth] = useState(readChatWidth);
  const [liveFindings, setLiveFindings] = useState<Record<string, Findings>>({});
  // Where "Back" in the research studio returns to.
  const beforeStudio = useRef<string | null>(null);
  const dataRef = useRef<Data | null>(null);
  dataRef.current = data;

  const reload = useCallback(async () => setData(await api.getState()), []);

  useEffect(() => {
    reload().catch((e) => setError(errorText(e)));
    const unlisten = api.onChatEvent((e) =>
      setPending((prev) => {
        const cur = prev[e.threadId] ?? { text: "", activity: [] };
        const next =
          e.kind === "delta"
            ? { ...cur, text: cur.text + e.text }
            : { ...cur, activity: [...cur.activity, e.text] };
        return { ...prev, [e.threadId]: next };
      }),
    );
    return () => {
      void unlisten.then((f) => f());
    };
  }, [reload]);

  const papers = data?.papers ?? [];
  const threads = data?.threads ?? [];
  const paper = papers.find((p) => p.id === paperId) ?? null;
  const thread = threads.find((t) => t.id === threadId) ?? null;

  // The thread tree the chat panel shows: the root conversation and its side chats.
  const family = useMemo(() => {
    if (!thread) return [];
    let root = thread;
    while (root.parentId) {
      const parent = threads.find((t) => t.id === root.parentId);
      if (!parent) break;
      root = parent;
    }
    const out: { thread: Thread; depth: number }[] = [];
    const walk = (t: Thread, depth: number) => {
      out.push({ thread: t, depth });
      threads
        .filter((c) => c.parentId === t.id)
        .sort((a, b) => a.createdAt - b.createdAt)
        .forEach((c) => walk(c, depth + 1));
    };
    walk(root, 0);
    return out;
  }, [thread, threads]);

  const anchors = useMemo(
    () => threads.flatMap((t) => (t.anchor && t.anchor.paperId === paperId ? [t.anchor] : [])),
    [threads, paperId],
  );

  const researchThreads = useMemo(
    () => threads.filter((t) => t.kind === "research" && !t.parentId).sort((a, b) => b.updatedAt - a.updatedAt),
    [threads],
  );

  const brainstorms = useMemo(
    () => threads.filter((t) => t.kind === "discover").sort((a, b) => b.updatedAt - a.updatedAt),
    [threads],
  );

  const studio = thread?.kind === "discover";

  const defaultProvider: Provider = data?.settings.defaultProvider ?? "claude";

  const mainThreadFor = async (pid: string): Promise<Thread> => {
    const existing = dataRef.current?.threads.find(
      (t) => t.kind === "paper" && !t.parentId && t.paperIds[0] === pid,
    );
    if (existing) return existing;
    const created = await api.createThread({
      title: "Discussion",
      kind: "paper",
      paperIds: [pid],
      parentId: null,
      anchor: null,
      provider: defaultProvider,
    });
    setData((d) => d && { ...d, threads: [...d.threads, created] });
    return created;
  };

  const openPaper = async (pid: string) => {
    setPaperId(pid);
    try {
      setThreadId((await mainThreadFor(pid)).id);
    } catch (e) {
      setError(errorText(e));
    }
  };

  const openThread = (id: string) => {
    const t = threads.find((x) => x.id === id);
    if (t?.kind === "discover" && !studio) beforeStudio.current = threadId;
    setThreadId(id);
    if (t && t.paperIds.length && !t.paperIds.includes(paperId ?? "")) setPaperId(t.paperIds[0]);
  };

  const send = async (tid: string, text: string, provider: Provider, display?: string): Promise<Message | null> => {
    const optimistic = {
      id: `local-${Date.now()}`,
      role: "user" as const,
      text: display ?? text,
      provider: null,
      at: Date.now(),
      error: false,
    };
    setData(
      (d) =>
        d && {
          ...d,
          threads: d.threads.map((t) => (t.id === tid ? { ...t, messages: [...t.messages, optimistic] } : t)),
        },
    );
    setBusy((b) => new Set(b).add(tid));
    setPending((p) => ({ ...p, [tid]: { text: "", activity: [] } }));
    try {
      return await api.sendMessage(tid, text, provider, display);
    } catch (e) {
      setError(errorText(e));
      return null;
    } finally {
      await reload();
      setBusy((b) => {
        const n = new Set(b);
        n.delete(tid);
        return n;
      });
      setPending((p) => {
        const { [tid]: _, ...rest } = p;
        return rest;
      });
    }
  };

  /** Opens a side chat on a PDF selection, under the conversation it belongs to. */
  const askAbout = async (anchor: Anchor, explain: boolean) => {
    try {
      const active = thread && !thread.anchor && thread.paperIds.includes(anchor.paperId) ? thread : null;
      const parent = active ?? (await mainThreadFor(anchor.paperId));
      const quote = anchor.quote.length > 42 ? `${anchor.quote.slice(0, 42).trim()}…` : anchor.quote;
      const side = await api.createThread({
        title: quote,
        kind: parent.kind,
        paperIds: parent.paperIds,
        parentId: parent.id,
        anchor,
        provider: parent.provider,
      });
      setData((d) => d && { ...d, threads: [...d.threads, side] });
      setThreadId(side.id);
      if (explain) void send(side.id, "Explain this passage.", side.provider);
      else setFocusNonce((n) => n + 1);
    } catch (e) {
      setError(errorText(e));
    }
  };

  const cite = (paperIndex: number, page: number) => {
    const pid = thread?.paperIds[paperIndex - 1] ?? thread?.paperIds[0] ?? paperId;
    if (!pid) return;
    setPaperId(pid);
    setJump({ paperId: pid, page, nonce: Date.now() });
  };

  const newResearch = async (paperIds: string[]) => {
    try {
      const t = await api.createThread({
        title: paperIds.length > 1 ? "New comparison" : "New research thread",
        kind: "research",
        paperIds,
        parentId: null,
        anchor: null,
        provider: defaultProvider,
      });
      setData((d) => d && { ...d, threads: [...d.threads, t] });
      setThreadId(t.id);
      if (paperIds.length) setPaperId(paperIds[0]);
    } catch (e) {
      setError(errorText(e));
    }
  };

  /** Expands Discover into the research studio, seeded with whatever was typed in search. */
  const newBrainstorm = async (query: string) => {
    try {
      const topic = query.trim();
      const t = await api.createThread({
        title: topic ? (topic.length > 48 ? `${topic.slice(0, 48)}…` : topic) : "New brainstorm",
        kind: "discover",
        paperIds: [],
        parentId: null,
        anchor: null,
        provider: defaultProvider,
      });
      setData((d) => d && { ...d, threads: [...d.threads, t] });
      if (!studio) beforeStudio.current = threadId;
      setThreadId(t.id);
      if (topic) void send(t.id, `I want to explore: ${topic}`, t.provider);
    } catch (e) {
      setError(errorText(e));
    }
  };

  const addResult = async (r: SearchResult) => {
    try {
      const p = await api.addPaper(r);
      setData((d) => d && { ...d, papers: [p, ...d.papers.filter((x) => x.id !== p.id)] });
    } catch (e) {
      setError(errorText(e));
    }
  };

  const setLive = (tid: string, f: Findings | null) =>
    setLiveFindings((prev) => {
      const { [tid]: _, ...rest } = prev;
      return f ? { ...rest, [tid]: f } : rest;
    });

  const paperChanged = (p: Paper) =>
    setData((d) => d && { ...d, papers: d.papers.map((x) => (x.id === p.id ? p : x)) });

  const startResize = (e: React.PointerEvent) => {
    const startX = e.clientX;
    const startW = chatWidth;
    let w = startW;
    const move = (ev: PointerEvent) => {
      w = Math.min(760, Math.max(340, startW + (startX - ev.clientX)));
      setChatWidth(w);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      try {
        localStorage.setItem(CHAT_WIDTH_KEY, String(w));
      } catch {
        /* width just won't persist */
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  if (!data) {
    return <div className="boot">{error ?? "Opening library…"}</div>;
  }

  return (
    <div className="app" style={{ gridTemplateColumns: studio ? "280px 1fr" : `280px 1fr 6px ${chatWidth}px` }}>
      <Sidebar
        papers={papers}
        researchThreads={researchThreads}
        activePaperId={paperId}
        activeThreadId={threadId}
        onOpenPaper={(id) => void openPaper(id)}
        onOpenThread={openThread}
        onPaperAdded={(p) => {
          setData((d) => d && { ...d, papers: [p, ...d.papers.filter((x) => x.id !== p.id)] });
          void openPaper(p.id);
        }}
        onRemovePaper={async (id) => {
          try {
            await api.removePaper(id);
            await reload();
            if (paperId === id) setPaperId(null);
            if (thread?.paperIds.includes(id) && thread.kind === "paper") setThreadId(null);
          } catch (e) {
            setError(errorText(e));
          }
        }}
        onNewResearch={(ids) => void newResearch(ids)}
        brainstorms={brainstorms}
        onBrainstorm={(q) => void newBrainstorm(q)}
        onSettings={() => setShowSettings(true)}
      />

      <main className="center">
        {error && (
          <div className="banner error floating" onClick={() => setError(null)}>
            {error}
          </div>
        )}
        {studio && thread ? (
          <Studio
            thread={thread}
            papers={papers}
            settings={data.settings}
            pending={pending[thread.id]}
            busy={busy.has(thread.id)}
            live={liveFindings[thread.id]}
            setLive={(f) => setLive(thread.id, f)}
            send={(text, provider, display) => send(thread.id, text, provider, display)}
            onCancel={() => void api.cancelMessage(thread.id)}
            onFindingsSaved={(f) =>
              setData(
                (d) => d && { ...d, threads: d.threads.map((t) => (t.id === thread.id ? { ...t, findings: f } : t)) },
              )
            }
            onAddPaper={addResult}
            onCompare={(ids) => void newResearch(ids)}
            onOpenPaper={(id) => void openPaper(id)}
            onCollapse={() => setThreadId(beforeStudio.current)}
            onDelete={async () => {
              await api.deleteThread(thread.id);
              await reload();
              setThreadId(beforeStudio.current);
            }}
          />
        ) : paper ? (
          <PdfViewer
            paper={paper}
            anchors={anchors}
            jump={jump}
            onAsk={(a, explain) => void askAbout(a, explain)}
            onPaperChanged={paperChanged}
          />
        ) : (
          <Welcome hasPapers={papers.length > 0} />
        )}
      </main>

      {!studio && <div className="resizer" onPointerDown={startResize} />}

      {studio ? null : thread ? (
        <ChatPanel
          thread={thread}
          family={family}
          papers={papers}
          pending={pending[thread.id]}
          busy={busy.has(thread.id)}
          focusNonce={focusNonce}
          onSelect={openThread}
          onSend={(text, provider) => void send(thread.id, text, provider)}
          onCancel={() => void api.cancelMessage(thread.id)}
          onDelete={async (id) => {
            const parent = threads.find((t) => t.id === id)?.parentId ?? null;
            await api.deleteThread(id);
            await reload();
            setThreadId(parent);
          }}
          onCite={cite}
          onAnchor={(a) => {
            setPaperId(a.paperId);
            setJump({ paperId: a.paperId, page: a.page, nonce: Date.now() });
          }}
        />
      ) : (
        <aside className="chat chat-empty">
          <p className="dim">Open a paper or a research thread to start a conversation.</p>
        </aside>
      )}

      {showSettings && (
        <SettingsDialog
          settings={data.settings}
          onClose={() => setShowSettings(false)}
          onSave={async (s) => {
            await api.saveSettings(s);
            setData((d) => d && { ...d, settings: s });
          }}
        />
      )}
    </div>
  );
}

function Welcome({ hasPapers }: { hasPapers: boolean }) {
  return (
    <div className="welcome">
      <div className="welcome-inner">
        <h1>Read closely. Think out loud.</h1>
        <p className="lede">
          A reading room for research papers, with Claude Code and Codex at your side. Chats run on your own
          subscriptions through their command-line tools.
        </p>
        <ol className="steps">
          <li>
            <b>{hasPapers ? "Pick a paper" : "Find papers"}</b>
            <span>
              {hasPapers
                ? "Open one from your library on the left."
                : "Search arXiv in Discover, or expand it into a brainstorm that ends in a deep literature search."}
            </span>
          </li>
          <li>
            <b>Discuss it</b>
            <span>Ask questions in the chat. Answers cite pages; click a citation to jump there.</span>
          </li>
          <li>
            <b>Branch off</b>
            <span>Select any passage to open a side chat that keeps the main conversation's context.</span>
          </li>
          <li>
            <b>Connect ideas</b>
            <span>Tick several papers and start a research thread to compare them and plan next steps.</span>
          </li>
        </ol>
      </div>
    </div>
  );
}
