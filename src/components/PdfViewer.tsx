import { useEffect, useMemo, useRef, useState } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import "react-pdf/dist/Page/TextLayer.css";
import "react-pdf/dist/Page/AnnotationLayer.css";
import { api, errorText, shortAuthors, type Anchor, type Paper } from "../api";

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url,
).toString();

export interface Jump {
  paperId: string;
  page: number;
  nonce: number;
}

interface Props {
  paper: Paper;
  anchors: Anchor[];
  jump: Jump | null;
  onAsk: (anchor: Anchor, explain: boolean) => void;
  onPaperChanged: (paper: Paper) => void;
}

interface Selection {
  quote: string;
  page: number;
  x: number;
  y: number;
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Plain text with page markers, so the CLIs can grep and cite pages. */
async function extractText(pdf: PDFDocumentProxy): Promise<string> {
  const pages: string[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const content = await (await pdf.getPage(i)).getTextContent();
    let text = "";
    for (const item of content.items) {
      if (!("str" in item)) continue;
      text += item.str;
      if (item.hasEOL) text += "\n";
      else if (item.str && !item.str.endsWith(" ")) text += " ";
    }
    pages.push(`=== Page ${i} ===\n${text.replace(/[ \t]+\n/g, "\n").trim()}`);
  }
  return pages.join("\n\n");
}

export function PdfViewer({ paper, anchors, jump, onAsk, onPaperChanged }: Props) {
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [ratio, setRatio] = useState(1.294);
  const [zoom, setZoom] = useState(1);
  const [width, setWidth] = useState(800);
  const [current, setCurrent] = useState(1);
  const [visible, setVisible] = useState<Set<number>>(() => new Set([1, 2, 3]));
  const [selection, setSelection] = useState<Selection | null>(null);
  const [flash, setFlash] = useState<number | null>(null);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const pageRefs = useRef<(HTMLDivElement | null)[]>([]);
  const applied = useRef(0);

  useEffect(() => {
    setBytes(null);
    setLoadError(null);
    setNumPages(0);
    setLoadedFor(null);
    setCurrent(1);
    setVisible(new Set([1, 2, 3]));
    scroller.current?.scrollTo({ top: 0 });
    if (!paper.hasPdf) return;
    let live = true;
    api
      .readPdf(paper.id)
      .then((buf) => live && setBytes(new Uint8Array(buf)))
      .catch((e) => live && setLoadError(errorText(e)));
    return () => {
      live = false;
    };
  }, [paper.id, paper.hasPdf]);

  // pdf.js takes ownership of the buffer it is given, so hand it a copy.
  const file = useMemo(() => (bytes ? { data: bytes.slice() } : null), [bytes]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const pageWidth = Math.round(Math.min(width - 64, 920) * zoom);

  // Render only pages near the viewport; long papers stay responsive.
  useEffect(() => {
    const root = scroller.current;
    if (!root || numPages === 0) return;
    const io = new IntersectionObserver(
      (entries) => {
        setVisible((prev) => {
          const next = new Set(prev);
          for (const e of entries) {
            const n = Number((e.target as HTMLElement).dataset.index);
            if (e.isIntersecting) next.add(n);
          }
          return next;
        });
      },
      { root, rootMargin: "1600px 0px" },
    );
    pageRefs.current.slice(0, numPages).forEach((el) => el && io.observe(el));
    return () => io.disconnect();
  }, [numPages]);

  // A jump can arrive before its paper has loaded (a citation into another
  // paper); apply it once that paper's pages exist, and only once.
  useEffect(() => {
    if (!jump || jump.paperId !== loadedFor || applied.current === jump.nonce) return;
    const el = pageRefs.current[jump.page - 1];
    if (!el) return;
    applied.current = jump.nonce;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
    setFlash(jump.page);
    const t = setTimeout(() => setFlash(null), 1400);
    return () => clearTimeout(t);
  }, [jump, loadedFor]);

  const onScroll = () => {
    setSelection(null);
    const root = scroller.current;
    if (!root) return;
    const mid = root.scrollTop + root.clientHeight / 3;
    let page = 1;
    pageRefs.current.slice(0, numPages).forEach((el, i) => {
      if (el && el.offsetTop <= mid) page = i + 1;
    });
    setCurrent(page);
  };

  const onLoad = async (pdf: PDFDocumentProxy) => {
    setNumPages(pdf.numPages);
    const first = await pdf.getPage(1);
    const vp = first.getViewport({ scale: 1 });
    setRatio(vp.height / vp.width);
    setLoadedFor(paper.id);
    if (!paper.hasText) {
      try {
        await api.savePaperText(paper.id, await extractText(pdf));
        onPaperChanged({ ...paper, hasText: true });
      } catch (e) {
        console.error("text extraction failed", e);
      }
    }
  };

  const onMouseUp = () => {
    const sel = window.getSelection();
    const quote = sel?.toString().replace(/\s+/g, " ").trim() ?? "";
    if (!sel || quote.length < 3 || sel.rangeCount === 0) {
      setSelection(null);
      return;
    }
    const node = sel.anchorNode;
    const el = node instanceof Element ? node : node?.parentElement;
    const pageEl = el?.closest<HTMLElement>("[data-page-number]");
    if (!pageEl) return;
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    setSelection({
      quote,
      page: Number(pageEl.dataset.pageNumber),
      x: rect.left + rect.width / 2,
      y: rect.top,
    });
  };

  const ask = (explain: boolean) => {
    if (!selection) return;
    onAsk({ paperId: paper.id, page: selection.page, quote: selection.quote }, explain);
    window.getSelection()?.removeAllRanges();
    setSelection(null);
  };

  const quotesByPage = useMemo(() => {
    const m = new Map<number, string[]>();
    for (const a of anchors) m.set(a.page, [...(m.get(a.page) ?? []), norm(a.quote)]);
    return m;
  }, [anchors]);

  // One stable renderer per page: a new function makes react-pdf redraw the
  // text layer, and the viewer re-renders on every streamed chat token.
  const textRenderer = useMemo(() => {
    const cache = new Map<number, (item: { str: string }) => string>();
    return (page: number) => {
      let render = cache.get(page);
      if (!render) {
        const quotes = quotesByPage.get(page);
        render = ({ str }) => {
          const s = norm(str);
          if (quotes && s.length > 2 && quotes.some((q) => q.includes(s))) {
            return `<mark class="anchor-mark">${escapeHtml(str)}</mark>`;
          }
          return escapeHtml(str);
        };
        cache.set(page, render);
      }
      return render;
    };
  }, [quotesByPage]);

  const attach = async () => {
    const path = await open({ filters: [{ name: "PDF", extensions: ["pdf"] }] });
    if (typeof path !== "string") return;
    try {
      onPaperChanged(await api.attachPdf(paper.id, path));
    } catch (e) {
      setLoadError(errorText(e));
    }
  };

  const meta = [shortAuthors(paper.authors), paper.year, paper.venue].filter(Boolean).join(" · ");

  return (
    <section className="viewer">
      <header className="viewer-bar">
        <div className="viewer-title">
          <h1 title={paper.title}>{paper.title}</h1>
          {meta && <p>{meta}</p>}
        </div>
        <div className="viewer-tools">
          {numPages > 0 && (
            <span className="page-count">
              {current} <span className="dim">/ {numPages}</span>
            </span>
          )}
          <div className="seg small">
            <button onClick={() => setZoom((z) => Math.max(0.5, +(z - 0.1).toFixed(2)))} title="Zoom out">
              −
            </button>
            <button onClick={() => setZoom(1)} title="Fit width">
              {Math.round(zoom * 100)}%
            </button>
            <button onClick={() => setZoom((z) => Math.min(2.5, +(z + 0.1).toFixed(2)))} title="Zoom in">
              +
            </button>
          </div>
          {paper.url && (
            <button className="ghost small" onClick={() => void openUrl(paper.url!)}>
              Source ↗
            </button>
          )}
        </div>
      </header>

      <div className="viewer-scroll" ref={scroller} onScroll={onScroll} onMouseUp={onMouseUp}>
        {!paper.hasPdf && (
          <div className="no-pdf">
            <h2>No PDF for this paper yet</h2>
            {paper.abstract && <p className="abstract">{paper.abstract}</p>}
            <p className="dim">
              It may not be open access. Download it yourself, then attach it here. The assistant can still discuss
              the abstract.
            </p>
            <div className="row">
              <button className="primary" onClick={attach}>
                Attach PDF…
              </button>
              {paper.url && (
                <button className="ghost" onClick={() => void openUrl(paper.url!)}>
                  Open paper page ↗
                </button>
              )}
            </div>
          </div>
        )}
        {loadError && <div className="banner error">{loadError}</div>}
        {file && (
          <Document
            file={file}
            onLoadSuccess={onLoad}
            onLoadError={(e) => setLoadError(e.message)}
            loading={<div className="viewer-loading">Opening PDF…</div>}
            className="pdf-doc"
          >
            {Array.from({ length: numPages }, (_, i) => (
              <div
                key={i}
                data-index={i + 1}
                ref={(el) => {
                  pageRefs.current[i] = el;
                }}
                className={`pdf-page ${flash === i + 1 ? "flash" : ""}`}
                style={{ width: pageWidth, minHeight: Math.round(pageWidth * ratio) }}
              >
                {visible.has(i + 1) && (
                  <Page
                    pageNumber={i + 1}
                    width={pageWidth}
                    customTextRenderer={textRenderer(i + 1)}
                    loading=""
                  />
                )}
              </div>
            ))}
          </Document>
        )}
      </div>

      {selection && (
        <div
          className="sel-pop"
          style={{ left: selection.x, top: Math.max(selection.y - 48, 8) }}
          onMouseDown={(e) => e.preventDefault()}
        >
          <button onClick={() => ask(true)}>Explain</button>
          <button onClick={() => ask(false)}>Ask in side chat</button>
          <button onClick={() => void navigator.clipboard.writeText(selection.quote).then(() => setSelection(null))}>
            Copy
          </button>
        </div>
      )}
    </section>
  );
}
