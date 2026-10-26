import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  api,
  errorText,
  providerLabel,
  shortAuthors,
  type Findings,
  type Message,
  type Paper,
  type Provider,
  type SearchQuery,
  type SearchResult,
  type Settings,
  type Thread,
} from "../api";
import {
  buildFindings,
  emptyFindings,
  parseBlock,
  PLAN_DISPLAY,
  PLAN_PROMPT,
  rankDisplay,
  rankPrompt,
  runSearches,
  stripBlocks,
} from "../deepResearch";
import { ChatPanel, type Pending } from "./ChatPanel";

interface Props {
  thread: Thread;
  papers: Paper[];
  settings: Settings;
  pending: Pending | undefined;
  busy: boolean;
  /** In-progress deep research, kept by the app so it survives leaving the studio. */
  live: Findings | undefined;
  setLive: (f: Findings | null) => void;
  send: (text: string, provider: Provider, display?: string) => Promise<Message | null>;
  onCancel: () => void;
  onFindingsSaved: (f: Findings) => void;
  onAddPaper: (r: SearchResult) => Promise<void>;
  onCompare: (paperIds: string[]) => void;
  onOpenPaper: (paperId: string) => void;
  onCollapse: () => void;
  onDelete: () => void;
}

const MAX_CANDIDATES = 120;

export function Studio(props: Props) {
  const { thread, papers } = props;
  const findings = props.live ?? thread.findings;
  const running = !!props.live && props.live.stage !== "done" && props.live.stage !== "error";
  const provider = thread.provider;

  const runDeepResearch = async () => {
    let f = emptyFindings();
    const update = (next: Findings) => {
      f = next;
      props.setLive(next);
    };
    const finish = async (final: Findings) => {
      await api.saveFindings(thread.id, final);
      props.onFindingsSaved(final);
      props.setLive(null);
    };
    const fail = (error: string) => finish({ ...f, stage: "error", error, at: Date.now() });

    try {
      update(f);
      const plan = await props.send(PLAN_PROMPT, provider, PLAN_DISPLAY);
      if (!plan || plan.error) return await fail(plan?.text ?? "The assistant did not reply.");
      const queries = (parseBlock<{ queries?: SearchQuery[] }>(plan.text, "plan")?.queries ?? [])
        .filter((q) => q?.q?.trim())
        .slice(0, 8);
      if (!queries.length) return await fail("The assistant's reply didn't include a search plan. Try again.");

      update({ ...f, stage: "searching", queries });
      const all = await runSearches(queries, !!props.settings.semanticScholarKey.trim(), (searched) =>
        update({ ...f, searched }),
      );
      const candidates = all.slice(0, MAX_CANDIDATES);
      if (!candidates.length) return await fail("The searches returned no papers. Brainstorm a little more, then retry.");

      update({ ...f, stage: "ranking", candidates: candidates.length });
      const rank = await props.send(rankPrompt(candidates), provider, rankDisplay(candidates.length));
      if (!rank || rank.error) return await fail(rank?.text ?? "The assistant did not reply.");
      const reply = parseBlock<Parameters<typeof buildFindings>[1]>(rank.text, "findings");
      if (!reply) return await fail("The assistant's reply didn't include ranked findings. Try again.");
      await finish(buildFindings(f, reply, candidates, stripBlocks(rank.text)));
    } catch (e) {
      await fail(errorText(e));
    }
  };

  return (
    <section className="studio">
      <header className="studio-bar">
        <button className="ghost small" onClick={props.onCollapse} title="Back to reading">
          ← Back
        </button>
        <div className="studio-title">
          <span className="eyebrow">Research studio</span>
          <h1>{thread.title}</h1>
        </div>
        <Stepper findings={findings} running={running} />
        <button
          className="icon-btn"
          title="Delete this brainstorm"
          onClick={() => {
            if (confirm(`Delete “${thread.title}”?`)) props.onDelete();
          }}
        >
          ✕
        </button>
      </header>

      <div className="studio-body">
        <ChatPanel
          variant="studio"
          thread={thread}
          family={[{ thread, depth: 0 }]}
          papers={papers}
          pending={props.pending}
          busy={props.busy}
          focusNonce={0}
          onSelect={() => {}}
          onSend={(text, p) => void props.send(text, p)}
          onCancel={props.onCancel}
          onDelete={props.onDelete}
          onCite={() => {}}
          onAnchor={() => {}}
        />
        <FindingsPanel
          findings={findings ?? null}
          running={running}
          canRun={!props.busy && !running}
          hasChat={thread.messages.length > 0}
          provider={provider}
          papers={papers}
          onRun={() => void runDeepResearch()}
          onAddPaper={props.onAddPaper}
          onCompare={props.onCompare}
          onOpenPaper={props.onOpenPaper}
        />
      </div>
    </section>
  );
}

function Stepper({ findings, running }: { findings: Findings | null; running: boolean }) {
  const step = findings?.stage === "done" && !running ? 3 : running ? 2 : 1;
  const labels = ["Brainstorm", "Deep research", "Review"];
  return (
    <ol className="stepper" aria-label="Progress">
      {labels.map((l, i) => (
        <li key={l} className={i + 1 < step ? "done" : i + 1 === step ? "on" : ""}>
          <span>{i + 1}</span>
          {l}
        </li>
      ))}
    </ol>
  );
}

interface PanelProps {
  findings: Findings | null;
  running: boolean;
  canRun: boolean;
  hasChat: boolean;
  provider: Provider;
  papers: Paper[];
  onRun: () => void;
  onAddPaper: (r: SearchResult) => Promise<void>;
  onCompare: (paperIds: string[]) => void;
  onOpenPaper: (paperId: string) => void;
}

function FindingsPanel(p: PanelProps) {
  const [adding, setAdding] = useState<Set<string>>(new Set());
  const f = p.findings;
  const libraryId = (r: SearchResult) => p.papers.find((x) => x.externalId === r.id)?.id;

  const add = async (rs: SearchResult[]) => {
    const todo = rs.filter((r) => !libraryId(r));
    setAdding((s) => new Set([...s, ...todo.map((r) => r.id)]));
    for (const r of todo) {
      try {
        await p.onAddPaper(r);
      } finally {
        setAdding((s) => {
          const n = new Set(s);
          n.delete(r.id);
          return n;
        });
      }
    }
  };

  const all = f?.themes.flatMap((t) => t.papers.map((x) => x.result)) ?? [];
  const added = all.map(libraryId).filter(Boolean) as string[];

  return (
    <aside className="findings">
      <header className="findings-head">
        <h2>Findings</h2>
        {f?.stage === "done" && (
          <button className="small ghost" disabled={!p.canRun} onClick={p.onRun}>
            Run again
          </button>
        )}
      </header>

      <div className="findings-scroll">
        {!f && (
          <div className="findings-empty">
            <p>
              Deep research turns this conversation into a search plan, runs it against arXiv
              {" "}and Semantic Scholar, and has {providerLabel[p.provider]} rank what comes back.
            </p>
            <p className="dim">Every paper listed comes from those searches, so none are made up.</p>
            <button className="primary big" disabled={!p.canRun || !p.hasChat} onClick={p.onRun}>
              Run deep research
            </button>
            {!p.hasChat && <p className="dim small-note">Start by describing what you want to explore.</p>}
          </div>
        )}

        {f && f.stage !== "done" && (
          <ul className="progress">
            <Step label="Planning searches" state={f.stage === "planning" ? "on" : "done"} />
            <Step
              label={
                f.stage === "searching"
                  ? `Searching ${f.searched} / ${f.queries.length} queries`
                  : f.queries.length
                    ? `Searched ${f.queries.length} queries`
                    : "Searching arXiv and Semantic Scholar"
              }
              state={f.stage === "planning" ? "todo" : f.stage === "searching" ? "on" : "done"}
            />
            <Step
              label={f.candidates ? `Ranking ${f.candidates} candidates` : "Ranking candidates"}
              state={f.stage === "ranking" ? "on" : f.stage === "error" && f.candidates ? "done" : "todo"}
            />
            {f.stage === "error" && (
              <li className="progress-error">
                {f.error}
                <button className="small primary" disabled={!p.canRun} onClick={p.onRun}>
                  Try again
                </button>
              </li>
            )}
          </ul>
        )}

        {f && f.queries.length > 0 && (
          <div className="queries">
            {f.queries.map((q) => (
              <span key={q.q} className="query" title={q.why}>
                {q.q}
              </span>
            ))}
          </div>
        )}

        {f?.stage === "done" && (
          <>
            <p className="dim found-count">
              {all.length} papers picked from {f.candidates} candidates
            </p>
            <div className="row bulk">
              <button className="small primary" disabled={added.length === all.length} onClick={() => void add(all)}>
                {added.length === all.length ? "All in library" : `Add all ${all.length - added.length}`}
              </button>
              <button className="small ghost" disabled={added.length < 2} onClick={() => p.onCompare(added)}>
                Compare added papers
              </button>
            </div>

            {f.themes.map((t) => (
              <section key={t.name} className="theme">
                <h3>{t.name}</h3>
                {t.summary && <p className="theme-summary">{t.summary}</p>}
                <ul>
                  {t.papers.map(({ result: r, why }) => {
                    const inLib = libraryId(r);
                    return (
                      <li key={r.id} className="found">
                        <button
                          className="found-title"
                          onClick={() => (inLib ? p.onOpenPaper(inLib) : r.url && void openUrl(r.url))}
                          title={inLib ? "Open in the reader" : "Open the paper's page"}
                        >
                          {r.title}
                        </button>
                        <p className="meta">
                          {[shortAuthors(r.authors), r.year, r.venue].filter(Boolean).join(" · ")}
                        </p>
                        {why && <p className="why">{why}</p>}
                        <div className="row">
                          {inLib ? (
                            <button className="small ghost" onClick={() => p.onOpenPaper(inLib)}>
                              Read
                            </button>
                          ) : (
                            <button className="small primary" disabled={adding.has(r.id)} onClick={() => void add([r])}>
                              {adding.has(r.id) ? "Adding…" : "Add"}
                            </button>
                          )}
                          {!r.pdfUrl && <span className="tag muted">No open PDF</span>}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}

            {f.gaps.length > 0 && (
              <section className="theme">
                <h3>Gaps</h3>
                <ul className="bullets">
                  {f.gaps.map((g) => (
                    <li key={g}>{g}</li>
                  ))}
                </ul>
              </section>
            )}
            {f.nextSteps.length > 0 && (
              <section className="theme">
                <h3>Next steps</h3>
                <ul className="bullets">
                  {f.nextSteps.map((g) => (
                    <li key={g}>{g}</li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
      </div>
    </aside>
  );
}

function Step({ label, state }: { label: string; state: "todo" | "on" | "done" }) {
  return <li className={`progress-step ${state}`}>{label}</li>;
}
