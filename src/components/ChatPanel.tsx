import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { providerLabel, type Anchor, type Paper, type Provider, type Thread } from "../api";
import { Markdown } from "./Markdown";

export interface Pending {
  text: string;
  activity: string[];
}

interface Props {
  thread: Thread;
  /** The root thread and its side chats, in tree order. */
  family: { thread: Thread; depth: number }[];
  papers: Paper[];
  pending: Pending | undefined;
  busy: boolean;
  focusNonce: number;
  onSelect: (threadId: string) => void;
  onSend: (text: string, provider: Provider) => void;
  onCancel: () => void;
  onDelete: (threadId: string) => void;
  onCite: (paperIndex: number, page: number) => void;
  onAnchor: (anchor: Anchor) => void;
  /** "studio": the wide brainstorm chat in the centre, without the thread strip. */
  variant?: "side" | "studio";
}

function suggestions(thread: Thread): string[] {
  if (thread.kind === "discover") {
    return [
      "Help me turn this into a researchable question",
      "What are the main schools of thought here?",
      "Which keywords and adjacent fields should I search?",
    ];
  }
  if (thread.anchor) {
    return ["Explain this passage step by step", "Why does this matter for the paper's argument?", "Give an intuitive example"];
  }
  if (thread.paperIds.length === 0) {
    return [
      "Help me scope a literature review on this topic",
      "Which foundational papers should I read first?",
      "Turn my notes into a research plan",
    ];
  }
  if (thread.paperIds.length > 1) {
    return [
      "Compare the methods and assumptions of these papers",
      "Where do they agree, and where do they conflict?",
      "Propose three research directions that combine their ideas",
    ];
  }
  return [
    "Summarize the paper: problem, method, results",
    "Walk me through the key equations",
    "What are the main limitations and open questions?",
  ];
}

const tabLabel = (t: Thread) => (t.anchor ? `p. ${t.anchor.page} · ${t.title}` : t.title);

export function ChatPanel(props: Props) {
  const { thread, family, papers, pending, busy } = props;
  const [draft, setDraft] = useState("");
  const [provider, setProvider] = useState<Provider>(thread.provider);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    setProvider(thread.provider);
    setDraft("");
    stick.current = true;
  }, [thread.id, thread.provider]);

  useEffect(() => {
    inputRef.current?.focus();
  }, [thread.id, props.focusNonce]);

  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [thread.messages.length, pending?.text, pending?.activity.length, thread.id]);

  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [draft]);

  const send = (text = draft) => {
    const t = text.trim();
    if (!t || busy) return;
    props.onSend(t, provider);
    setDraft("");
    stick.current = true;
  };

  const paperNames = thread.paperIds
    .map((id) => papers.find((p) => p.id === id)?.title)
    .filter(Boolean) as string[];

  const studio = props.variant === "studio";

  return (
    <aside className={`chat ${studio ? "studio-chat" : ""}`}>
      {!studio && (
      <header className="chat-head">
        <div className="thread-strip">
          {family.map(({ thread: t, depth }) => (
            <button
              key={t.id}
              className={`thread-chip ${t.id === thread.id ? "active" : ""}`}
              style={{ marginLeft: depth ? 2 : 0 }}
              onClick={() => props.onSelect(t.id)}
              title={t.anchor ? t.anchor.quote : t.title}
            >
              {depth > 0 && <span className="branch">↳</span>}
              <span className="chip-text">{tabLabel(t)}</span>
            </button>
          ))}
        </div>
        {(thread.parentId || thread.paperIds.length !== 1) && (
          <button
            className="icon-btn"
            title="Delete this conversation"
            onClick={() => {
              if (confirm(`Delete “${thread.title}” and its side chats?`)) props.onDelete(thread.id);
            }}
          >
            ✕
          </button>
        )}
      </header>
      )}

      {thread.paperIds.length > 1 && (
        <div className="context-line">
          {paperNames.map((n, i) => (
            <span key={i} className="ctx-pill" title={n}>
              <b>{i + 1}</b> {n}
            </span>
          ))}
        </div>
      )}

      <div
        className="messages"
        ref={listRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        {thread.anchor && (
          <button className="anchor-card" onClick={() => props.onAnchor(thread.anchor!)}>
            <span className="anchor-page">Page {thread.anchor.page}</span>
            <span className="anchor-quote">“{thread.anchor.quote}”</span>
          </button>
        )}

        {thread.messages.length === 0 && !pending && (
          <div className="empty-chat">
            <p className="dim">
              {thread.kind === "discover"
                ? "Think out loud about what you want to research. When the question feels sharp, run a deep search and the assistant will rank real papers from arXiv and Semantic Scholar."
                : thread.anchor
                ? "A side chat about this passage. It starts with the main conversation's context."
                : thread.paperIds.length === 0
                  ? "A research thread with no papers attached. Plan, brainstorm, or ask for reading suggestions."
                  : "Ask anything about the paper. Select text in the PDF to open a side chat about a passage."}
            </p>
            <div className="suggestions">
              {suggestions(thread).map((s) => (
                <button key={s} onClick={() => send(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {thread.messages.map((m) =>
          m.role === "user" ? (
            <div key={m.id} className="msg user">
              <div className="bubble">{m.text}</div>
            </div>
          ) : (
            <div key={m.id} className={`msg assistant ${m.error ? "error" : ""}`}>
              <Markdown text={m.text} onCite={props.onCite} />
              <div className="msg-foot">
                {m.provider && <span className={`prov-dot ${m.provider}`} />}
                {m.provider && providerLabel[m.provider]}
                <button className="link" onClick={() => void navigator.clipboard.writeText(m.text)}>
                  Copy
                </button>
              </div>
            </div>
          ),
        )}

        {pending && (
          <div className="msg assistant pending">
            {pending.activity.length > 0 && (
              <ul className="activity">
                {pending.activity.slice(-3).map((a, i) => (
                  <li key={i}>{a}</li>
                ))}
              </ul>
            )}
            {pending.text ? (
              <Markdown text={pending.text} onCite={props.onCite} />
            ) : (
              <div className="thinking">
                <span />
                <span />
                <span />
              </div>
            )}
          </div>
        )}
      </div>

      <footer className="composer">
        <div className="composer-box">
          <textarea
            ref={inputRef}
            rows={1}
            value={draft}
            placeholder={
              studio
                ? "What do you want to explore?"
                : thread.anchor
                  ? "Ask about this passage…"
                  : "Ask about the paper…"
            }
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
          />
          <div className="composer-row">
            <div className="seg small">
              {(["claude", "codex"] as Provider[]).map((p) => (
                <button key={p} className={provider === p ? "on" : ""} onClick={() => setProvider(p)}>
                  <span className={`prov-dot ${p}`} />
                  {providerLabel[p]}
                </button>
              ))}
            </div>
            {busy ? (
              <button className="stop" onClick={props.onCancel}>
                Stop
              </button>
            ) : (
              <button className="primary send" disabled={!draft.trim()} onClick={() => send()}>
                Send
              </button>
            )}
          </div>
        </div>
      </footer>
    </aside>
  );
}
