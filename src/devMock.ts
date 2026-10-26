/**
 * Browser preview: when the UI runs outside Tauri (plain `npm run dev`), fake
 * the backend with sample data so the interface can be designed and checked
 * in any browser. Put a PDF at demo/sample.pdf to see the viewer.
 */
import { mockIPC } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import type { Data, Message, Paper, SearchResult, Thread } from "./api";

const now = Date.now();
const paper: Paper = {
  id: "demo",
  title: "Attention Is All You Need",
  authors: ["Ashish Vaswani", "Noam Shazeer", "Niki Parmar"],
  year: 2017,
  abstract: "The dominant sequence transduction models are based on complex recurrent or convolutional neural networks…",
  venue: "NeurIPS",
  source: "arxiv",
  externalId: "1706.03762",
  url: "https://arxiv.org/abs/1706.03762",
  hasPdf: true,
  hasText: true,
  addedAt: now,
};

const answer = `The core operation is **scaled dot-product attention** [p. 4]:

$$
\\mathrm{Attention}(Q, K, V) = \\mathrm{softmax}\\!\\left(\\frac{QK^\\top}{\\sqrt{d_k}}\\right)V
$$

- Queries $Q$ are compared against keys $K$; the scores weight the values $V$.
- Dividing by $\\sqrt{d_k}$ keeps the dot products from growing with dimension, which would push the softmax into regions with tiny gradients [p. 4].
- **Multi-head attention** runs $h = 8$ of these in parallel on learned projections, then concatenates them [p. 5].

| Layer type | Complexity per layer | Max path length |
|---|---|---|
| Self-attention | $O(n^2 \\cdot d)$ | $O(1)$ |
| Recurrent | $O(n \\cdot d^2)$ | $O(n)$ |`;

const main: Thread = {
  id: "t-main",
  title: "Discussion",
  kind: "paper",
  paperIds: ["demo"],
  parentId: null,
  anchor: null,
  provider: "claude",
  sessions: { claude: "s-1" },
  findings: null,
  messages: [
    { id: "m1", role: "user", text: "Walk me through the key equations", provider: null, at: now, error: false },
    { id: "m2", role: "assistant", text: answer, provider: "claude", at: now, error: false },
  ],
  createdAt: now,
  updatedAt: now,
};

const side: Thread = {
  id: "t-side",
  title: "We suspect that for large values of d_k…",
  kind: "paper",
  paperIds: ["demo"],
  parentId: "t-main",
  anchor: {
    paperId: "demo",
    page: 4,
    quote:
      "We suspect that for large values of d_k, the dot products grow large in magnitude, pushing the softmax function into regions where it has extremely small gradients.",
  },
  provider: "codex",
  sessions: {},
  messages: [],
  findings: null,
  createdAt: now + 1,
  updatedAt: now + 1,
};

const data: Data = {
  papers: [
    paper,
    {
      ...paper,
      id: "p2",
      title: "BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding",
      authors: ["Jacob Devlin", "Ming-Wei Chang"],
      year: 2018,
      hasPdf: false,
      externalId: "1810.04805",
    },
  ],
  threads: [main, side],
  settings: {
    defaultProvider: "claude",
    claudePath: "",
    claudeModel: "",
    claudeExtraArgs: "",
    codexPath: "",
    codexModel: "",
    codexExtraArgs: "",
    allowWeb: true,
    semanticScholarKey: "",
  },
};

const results: SearchResult[] = [
  {
    source: "arxiv",
    id: "2010.11929",
    title: "An Image is Worth 16x16 Words: Transformers for Image Recognition at Scale",
    authors: ["Alexey Dosovitskiy", "Lucas Beyer"],
    year: 2020,
    abstract: "While the Transformer architecture has become the de-facto standard for natural language processing tasks…",
    venue: "arXiv",
    url: "https://arxiv.org/abs/2010.11929",
    pdfUrl: "https://arxiv.org/pdf/2010.11929",
    citationCount: null,
  },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function installDevMock() {
  // Real IPC serializes every reply; clone so the UI never shares objects with the fake backend.
  mockIPC(
    async (cmd, args) => {
      const reply = await handle(cmd, args);
      return reply instanceof ArrayBuffer || reply == null ? reply : structuredClone(reply);
    },
    { shouldMockEvents: true },
  );
}

async function handle(cmd: string, args: unknown): Promise<unknown> {
  const a = (args ?? {}) as Record<string, any>;
  switch (cmd) {
    case "get_state":
      return structuredClone(data);
    case "library_path":
      return "C:\\Users\\you\\AppData\\Roaming\\com.paperstudy.app\\library";
    case "read_pdf": {
      const res = await fetch("/demo/sample.pdf");
      if (!res.ok) throw "No demo/sample.pdf in the project folder.";
      return await res.arrayBuffer();
    }
    case "search_papers":
      await sleep(400);
      // Vary results per query so deep research sees a spread of candidates.
      return results.map((r, i) => ({ ...r, id: `${r.id}-${a.query.length + i}`, title: `${r.title} (${a.query})` }));
    case "save_findings": {
      const t = data.threads.find((x) => x.id === a.threadId);
      if (t) t.findings = a.findings;
      return null;
    }
    case "add_paper": {
      const r = a.result as SearchResult;
      const p: Paper = { ...paper, id: r.id, title: r.title, authors: r.authors, year: r.year, externalId: r.id };
      data.papers.unshift(p);
      return p;
    }
    case "create_thread": {
      const t: Thread = { ...a.thread, id: `t-${Date.now()}`, sessions: {}, messages: [], findings: null, createdAt: Date.now(), updatedAt: Date.now() };
      data.threads.push(t);
      return t;
    }
    case "send_message": {
      const t = data.threads.find((x) => x.id === a.threadId)!;
      t.messages.push({ id: `u${Date.now()}`, role: "user", text: a.display ?? a.text, provider: null, at: Date.now(), error: false });
      await emit("chat-event", { threadId: t.id, kind: "activity", text: "Reading Attention Is All You Need (text)" });
      await sleep(700);
      const reply = String(a.text).startsWith("Deep research, step 1")
        ? 'I\'ll cover the core idea, efficient variants, and vision transfer.\n\n```plan\n{"queries": [{"q": "vision transformer", "why": "core"}, {"q": "efficient attention", "why": "cost"}, {"q": "patch embeddings", "why": "inputs"}]}\n```'
        : String(a.text).startsWith("Deep research, step 2")
          ? 'Three threads stand out: the **ViT** line shows attention scales to images once data is large enough, efficient-attention work cuts the $O(n^2)$ cost, and patch design matters more than expected.\n\n```findings\n{"themes": [{"name": "Transformers for vision", "summary": "Treating image patches as tokens.", "papers": [{"id": "c1", "why": "The original ViT result: pure attention matches CNNs at scale."}, {"id": "c2", "why": "Shows how patch size trades accuracy for compute."}]}, {"name": "Cheaper attention", "summary": "Approximations to quadratic attention.", "papers": [{"id": "c3", "why": "Linear-time attention with a small accuracy cost."}]}], "gaps": ["Little work on very high-resolution inputs."], "nextSteps": ["Compare ViT and a linear-attention variant on one benchmark."]}\n```'
          : "Without the $\\frac{1}{\\sqrt{d_k}}$ factor, each score $q \\cdot k = \\sum_{i=1}^{d_k} q_i k_i$ has variance $d_k$ when the components are independent with unit variance [p. 4].";
      for (const chunk of reply.match(/.{1,24}/g) ?? []) {
        await emit("chat-event", { threadId: t.id, kind: "delta", text: chunk });
        await sleep(60);
      }
      const m: Message = { id: `a${Date.now()}`, role: "assistant", text: reply, provider: a.provider, at: Date.now(), error: false };
      t.messages.push(m);
      return m;
    }
    case "check_providers":
      return {
        claude: { path: "C:\\…\\claude.exe", version: "2.1.168 (Claude Code)", error: null },
        codex: { path: "C:\\…\\codex.cmd", version: "codex-cli 0.151.0", error: null },
      };
    default:
      return null;
  }
}
