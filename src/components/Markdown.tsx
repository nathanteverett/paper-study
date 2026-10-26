import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { openUrl } from "@tauri-apps/plugin-opener";
import "katex/dist/katex.min.css";

/**
 * Models write math as \( \) / \[ \] as often as $ / $$; remark-math only
 * reads dollars. Citations like [p. 4] or [2, p. 4] become links the chat
 * panel turns into page-jump chips. Fenced code is left alone.
 */
function prepare(text: string): string {
  // Deep research replies end in a JSON block for the app; show a note instead.
  const notes: Record<string, string> = {
    plan: "Search plan captured. Running the searches.",
    findings: "Findings captured. See the Findings panel.",
  };
  return text
    .replace(/```(plan|findings)\s*[\s\S]*?(```|$)/g, (_, tag: string) => `\n\n> *${notes[tag]}*\n\n`)
    .split(/(```[\s\S]*?```)/g)
    .map((part, i) => {
      if (i % 2 === 1) return part;
      return part
        .replace(/\\\[([\s\S]+?)\\\]/g, (_, m) => `\n$$\n${m.trim()}\n$$\n`)
        .replace(/\\\(([\s\S]+?)\\\)/g, (_, m) => `$${m.trim()}$`)
        .replace(
          /\[(?:(\d+),\s*)?(?:pp?\.|pages?)\s*(\d+)(?:\s*[-–]\s*\d+)?\]/g,
          (all, paper, page) => `[${all.slice(1, -1)}](#cite-${paper ?? 1}-${page})`,
        );
    })
    .join("");
}

interface Props {
  text: string;
  onCite?: (paperIndex: number, page: number) => void;
}

export const Markdown = memo(function Markdown({ text, onCite }: Props) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={{
          a({ href, children }) {
            const cite = href?.match(/^#cite-(\d+)-(\d+)$/);
            if (cite) {
              return (
                <button
                  className="cite"
                  title="Show this page"
                  onClick={() => onCite?.(Number(cite[1]), Number(cite[2]))}
                >
                  {children}
                </button>
              );
            }
            return (
              <a
                href={href}
                onClick={(e) => {
                  e.preventDefault();
                  if (href?.startsWith("http")) void openUrl(href);
                }}
              >
                {children}
              </a>
            );
          },
        }}
      >
        {prepare(text)}
      </ReactMarkdown>
    </div>
  );
});
