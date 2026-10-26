import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, errorText, shortAuthors, type Paper, type SearchResult, type Thread } from "../api";

interface Props {
  papers: Paper[];
  researchThreads: Thread[];
  activePaperId: string | null;
  activeThreadId: string | null;
  onOpenPaper: (id: string) => void;
  onOpenThread: (id: string) => void;
  onPaperAdded: (paper: Paper) => void;
  onRemovePaper: (id: string) => void;
  onNewResearch: (paperIds: string[]) => void;
  brainstorms: Thread[];
  onBrainstorm: (query: string) => void;
  onSettings: () => void;
}

type Tab = "library" | "discover";
type Source = "semanticscholar" | "arxiv";

export function Sidebar(props: Props) {
  const [tab, setTab] = useState<Tab>(props.papers.length ? "library" : "discover");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [query, setQuery] = useState("");
  const [source, setSource] = useState<Source>("arxiv");
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [adding, setAdding] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const inLibrary = new Set(props.papers.map((p) => p.externalId).filter(Boolean));

  const search = async (src = source) => {
    if (!query.trim()) return;
    setSearching(true);
    setError(null);
    try {
      setResults(await api.search(src, query.trim()));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSearching(false);
    }
  };

  const add = async (r: SearchResult) => {
    setAdding((s) => new Set(s).add(r.id));
    try {
      const paper = await api.addPaper(r);
      props.onPaperAdded(paper);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setAdding((s) => {
        const n = new Set(s);
        n.delete(r.id);
        return n;
      });
    }
  };

  const importPdf = async () => {
    const picked = await open({ multiple: true, filters: [{ name: "PDF", extensions: ["pdf"] }] });
    const paths = Array.isArray(picked) ? picked : picked ? [picked] : [];
    for (const path of paths) {
      try {
        props.onPaperAdded(await api.importPdf(path));
      } catch (e) {
        setError(errorText(e));
      }
    }
    if (paths.length) setTab("library");
  };

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const shown = props.papers.filter((p) =>
    `${p.title} ${p.authors.join(" ")}`.toLowerCase().includes(filter.toLowerCase()),
  );

  return (
    <nav className="sidebar">
      <div className="brand">
        <span className="brand-mark" />
        <span>Paper Study</span>
      </div>

      <div className="seg tabs">
        <button className={tab === "library" ? "on" : ""} onClick={() => setTab("library")}>
          Library <span className="count">{props.papers.length}</span>
        </button>
        <button className={tab === "discover" ? "on" : ""} onClick={() => setTab("discover")}>
          Discover
        </button>
      </div>

      {error && (
        <div className="banner error" onClick={() => setError(null)}>
          {error}
        </div>
      )}

      {tab === "discover" ? (
        <div className="side-scroll">
          <form
            className="search"
            onSubmit={(e) => {
              e.preventDefault();
              void search();
            }}
          >
            <div className="search-row">
              <input
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  if (!e.target.value) setResults(null);
                }}
                placeholder="Search papers, e.g. diffusion transformers"
                autoFocus
              />
              <button
                type="button"
                className="expand-btn"
                title="Expand into a brainstorm chat that ends in deep research"
                onClick={() => props.onBrainstorm(query)}
              >
                ⤢
              </button>
            </div>
            <div className="seg small full">
              {(
                [
                  ["arxiv", "arXiv"],
                  ["semanticscholar", "Semantic Scholar"],
                ] as [Source, string][]
              ).map(([s, label]) => (
                <button
                  type="button"
                  key={s}
                  className={source === s ? "on" : ""}
                  onClick={() => {
                    setSource(s);
                    if (query.trim()) void search(s);
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          </form>

          {!results && (
            <div className="studio-cta">
              <button className="cta" onClick={() => props.onBrainstorm(query)}>
                <b>Brainstorm, then deep research</b>
                <span>Talk the idea through, then let the assistant search and rank the literature.</span>
              </button>
              {props.brainstorms.length > 0 && (
                <>
                  <div className="section-head">
                    <span>Brainstorms</span>
                  </div>
                  <ul className="threads">
                    {props.brainstorms.map((t) => (
                      <li key={t.id}>
                        <button
                          className={`thread-row ${t.id === props.activeThreadId ? "active" : ""}`}
                          onClick={() => props.onOpenThread(t.id)}
                        >
                          <span className="paper-title">{t.title}</span>
                          <span className="meta">
                            {t.findings?.stage === "done"
                              ? `${t.findings.themes.reduce((n, th) => n + th.papers.length, 0)} papers found`
                              : `${t.messages.length} messages`}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}
          {searching && <p className="dim pad">Searching…</p>}
          {results?.length === 0 && !searching && <p className="dim pad">No results.</p>}
          <ul className="results">
            {results?.map((r) => {
              const added = inLibrary.has(r.id);
              return (
                <li key={`${r.source}-${r.id}`} className="result">
                  <button className="result-title" onClick={() => setExpanded(expanded === r.id ? null : r.id)}>
                    {r.title}
                  </button>
                  <p className="meta">
                    {[shortAuthors(r.authors), r.year, r.venue].filter(Boolean).join(" · ")}
                    {r.citationCount != null && <> · {r.citationCount.toLocaleString()} cites</>}
                  </p>
                  {expanded === r.id && r.abstract && <p className="abstract">{r.abstract}</p>}
                  <div className="row">
                    {added ? (
                      <span className="tag ok">In library</span>
                    ) : (
                      <button className="small primary" disabled={adding.has(r.id)} onClick={() => void add(r)}>
                        {adding.has(r.id) ? "Adding…" : "Add"}
                      </button>
                    )}
                    <span className={`tag ${r.pdfUrl ? "" : "muted"}`}>{r.pdfUrl ? "PDF" : "No open PDF"}</span>
                    {r.url && (
                      <button className="link" onClick={() => void openUrl(r.url!)}>
                        Page ↗
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      ) : (
        <div className="side-scroll">
          <div className="row pad-x">
            <input
              className="filter"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter library"
            />
            <button className="small ghost" onClick={() => void importPdf()} title="Import PDF files">
              Import
            </button>
          </div>

          {props.papers.length === 0 && (
            <div className="empty-side">
              <p>Your library is empty.</p>
              <p className="dim">Search in Discover, or import PDFs you already have.</p>
            </div>
          )}

          <ul className="papers">
            {shown.map((p) => (
              <li key={p.id} className={`paper-row ${p.id === props.activePaperId ? "active" : ""}`}>
                <input
                  type="checkbox"
                  checked={selected.has(p.id)}
                  onChange={() => toggle(p.id)}
                  title="Select to discuss several papers together"
                />
                <button className="paper-open" onClick={() => props.onOpenPaper(p.id)}>
                  <span className="paper-title">{p.title}</span>
                  <span className="meta">
                    {[shortAuthors(p.authors), p.year].filter(Boolean).join(" · ")}
                    {!p.hasPdf && <span className="tag muted">abstract</span>}
                  </span>
                </button>
                <button
                  className="icon-btn hover"
                  title="Remove from library"
                  onClick={() => {
                    if (confirm(`Remove “${p.title}” and its conversations?`)) props.onRemovePaper(p.id);
                  }}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>

          <div className="section-head">
            <span>Research threads</span>
            <button
              className="small ghost"
              onClick={() => {
                props.onNewResearch([...selected]);
                setSelected(new Set());
              }}
            >
              {selected.size ? `Discuss ${selected.size} selected` : "New thread"}
            </button>
          </div>
          <ul className="threads">
            {props.researchThreads.length === 0 && (
              <li className="dim pad">Tick papers above to compare them, or start an open research thread.</li>
            )}
            {props.researchThreads.map((t) => (
              <li key={t.id}>
                <button
                  className={`thread-row ${t.id === props.activeThreadId ? "active" : ""}`}
                  onClick={() => props.onOpenThread(t.id)}
                >
                  <span className="paper-title">{t.title}</span>
                  <span className="meta">
                    {t.paperIds.length} paper{t.paperIds.length === 1 ? "" : "s"} · {t.messages.length} messages
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <button className="settings-btn" onClick={props.onSettings}>
        <span>⚙</span> Settings
      </button>
    </nav>
  );
}
