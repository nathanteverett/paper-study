/**
 * Deep research: the assistant turns the brainstorm into search queries, the
 * app runs them against arXiv / Semantic Scholar, and the assistant ranks the
 * real results. Papers only ever come from search results, never from memory.
 */
import { api, type Findings, type SearchQuery, type SearchResult } from "./api";

export const PLAN_DISPLAY = "Deep research · plan the search";
export const rankDisplay = (n: number) => `Deep research · rank ${n} candidates`;

export const PLAN_PROMPT = `Deep research, step 1 of 2: plan the literature search.

Based on our conversation so far, write 4 to 8 search queries that together cover the topic: the core terms, common synonyms, competing or adjacent methods, and the names of key known works. The queries go to the arXiv search API, a keyword match over titles and abstracts, so keep each one 2 to 6 words with no boolean operators or quotes.

Reply with one short paragraph on the search strategy, then exactly one fenced block in this format:

\`\`\`plan
{"queries": [{"q": "...", "why": "..."}]}
\`\`\``;

export function rankPrompt(candidates: SearchResult[]): string {
  const list = candidates
    .map((c, i) => {
      const meta = [c.year, c.authors.slice(0, 3).join(", ")].filter(Boolean).join("; ");
      const abs = (c.abstract ?? "").replace(/\s+/g, " ").slice(0, 380);
      return `[c${i + 1}] ${c.title} (${meta})\n${abs}`;
    })
    .join("\n\n");
  return `Deep research, step 2 of 2: these ${candidates.length} candidate papers came back from arXiv and Semantic Scholar for the searches you planned.

Select the 8 to 15 most relevant to what we discussed and group them into 2 to 5 themes. For each paper, write one sentence on why it matters for my question. Then list gaps (what the search did not cover, or what looks unexplored) and concrete next steps. Use only ids from the list below; never add papers that are not in it.

Reply with a short overview in Markdown (3 to 6 sentences), then exactly one fenced block in this format:

\`\`\`findings
{"themes": [{"name": "...", "summary": "...", "papers": [{"id": "c12", "why": "..."}]}], "gaps": ["..."], "nextSteps": ["..."]}
\`\`\`

Candidates:

${list}`;
}

/** Pulls the JSON out of the last ```tag fence (or a ```json fence as a fallback). */
export function parseBlock<T>(text: string, tag: string): T | null {
  const blocks = [...text.matchAll(new RegExp("```(?:" + tag + "|json)\\s*([\\s\\S]*?)```", "g"))];
  for (const m of blocks.reverse()) {
    try {
      return JSON.parse(m[1]) as T;
    } catch {
      /* try the previous block */
    }
  }
  return null;
}

/** The prose before the fenced block. */
export function stripBlocks(text: string): string {
  return text.replace(/```(?:plan|findings|json)[\s\S]*?```/g, "").trim();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const titleKey = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export async function runSearches(
  queries: SearchQuery[],
  useSemanticScholar: boolean,
  onProgress: (done: number) => void,
): Promise<SearchResult[]> {
  const seen = new Map<string, SearchResult>();
  let done = 0;
  for (const query of queries) {
    const sources = useSemanticScholar ? ["arxiv", "semanticscholar"] : ["arxiv"];
    for (const source of sources) {
      try {
        for (const r of await api.search(source, query.q)) {
          const key = titleKey(r.title);
          const prev = seen.get(key);
          // Keep the richer record when both sources return the paper.
          if (!prev || (!prev.pdfUrl && r.pdfUrl) || (prev.citationCount == null && r.citationCount != null)) {
            seen.set(key, { ...prev, ...r, pdfUrl: r.pdfUrl ?? prev?.pdfUrl ?? null });
          }
        }
      } catch (e) {
        console.warn(`search failed: ${source} "${query.q}"`, e);
      }
    }
    onProgress(++done);
    // arXiv asks API clients to space out requests.
    await sleep(1000);
  }
  return [...seen.values()];
}

export function emptyFindings(): Findings {
  return {
    stage: "planning",
    queries: [],
    searched: 0,
    candidates: 0,
    overview: "",
    themes: [],
    gaps: [],
    nextSteps: [],
    error: null,
    at: Date.now(),
  };
}

interface RankReply {
  themes?: { name?: string; summary?: string; papers?: { id?: string; why?: string }[] }[];
  gaps?: string[];
  nextSteps?: string[];
}

export function buildFindings(base: Findings, reply: RankReply, candidates: SearchResult[], overview: string): Findings {
  const byId = (id: string | undefined) => {
    const n = Number(id?.replace(/^c/i, ""));
    return Number.isInteger(n) && n >= 1 && n <= candidates.length ? candidates[n - 1] : null;
  };
  const themes = (reply.themes ?? [])
    .map((t) => ({
      name: t.name ?? "Theme",
      summary: t.summary ?? "",
      papers: (t.papers ?? []).flatMap((p) => {
        const result = byId(p.id);
        return result ? [{ result, why: p.why ?? "" }] : [];
      }),
    }))
    .filter((t) => t.papers.length > 0);
  return {
    ...base,
    stage: "done",
    overview,
    themes,
    gaps: reply.gaps ?? [],
    nextSteps: reply.nextSteps ?? [],
    at: Date.now(),
  };
}
