import { useEffect, useState } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { api, errorText, providerLabel, type Provider, type ProviderStatus, type Settings } from "../api";

interface Props {
  settings: Settings;
  onSave: (s: Settings) => void;
  onClose: () => void;
}

export function SettingsDialog({ settings, onSave, onClose }: Props) {
  const [s, setS] = useState(settings);
  const [status, setStatus] = useState<Record<Provider, ProviderStatus> | null>(null);
  const [checking, setChecking] = useState(false);
  const [libPath, setLibPath] = useState("");

  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setS((prev) => ({ ...prev, [k]: v }));

  const check = async () => {
    setChecking(true);
    try {
      setStatus(await api.checkProviders());
    } catch (e) {
      alert(errorText(e));
    } finally {
      setChecking(false);
    }
  };

  useEffect(() => {
    void check();
    void api.libraryPath().then(setLibPath);
  }, []);

  const field = (label: string, key: keyof Settings, placeholder: string) => (
    <label className="field">
      <span>{label}</span>
      <input
        value={s[key] as string}
        placeholder={placeholder}
        onChange={(e) => set(key, e.target.value as never)}
        spellCheck={false}
      />
    </label>
  );

  return (
    <div className="modal-back" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <header>
          <h2>Settings</h2>
          <button className="icon-btn" onClick={onClose}>
            ✕
          </button>
        </header>

        <p className="dim">
          Paper Study runs your installed Claude Code and Codex CLIs, so chats use your own subscriptions. Sign in to
          each once in a terminal (<code>claude</code>, then <code>/login</code>; <code>codex login</code>).
        </p>

        <div className="providers">
          {(["claude", "codex"] as Provider[]).map((p) => {
            const st = status?.[p];
            return (
              <div key={p} className="provider-card">
                <div className="provider-name">
                  <span className={`prov-dot ${p}`} />
                  {providerLabel[p]}
                </div>
                <div className={`provider-status ${st?.version ? "ok" : st ? "bad" : ""}`}>
                  {!st ? "Checking…" : st.version ? st.version : st.error}
                </div>
                {st?.path && <code className="path">{st.path}</code>}
              </div>
            );
          })}
        </div>
        <button className="small ghost" onClick={() => void check()} disabled={checking}>
          {checking ? "Checking…" : "Check again"}
        </button>

        <h3>Default assistant</h3>
        <div className="seg small">
          {(["claude", "codex"] as Provider[]).map((p) => (
            <button key={p} className={s.defaultProvider === p ? "on" : ""} onClick={() => set("defaultProvider", p)}>
              {providerLabel[p]}
            </button>
          ))}
        </div>

        <h3>Claude Code</h3>
        <div className="grid2">
          {field("Model", "claudeModel", "Default (e.g. opus, sonnet)")}
          {field("Executable", "claudePath", "Found on PATH")}
        </div>
        {field("Extra arguments", "claudeExtraArgs", "e.g. --add-dir C:\\notes")}
        <label className="check">
          <input type="checkbox" checked={s.allowWeb} onChange={(e) => set("allowWeb", e.target.checked)} />
          Let Claude search the web for related work
        </label>

        <h3>Codex</h3>
        <div className="grid2">
          {field("Model", "codexModel", "Default from ~/.codex/config.toml")}
          {field("Executable", "codexPath", "Found on PATH")}
        </div>
        {field("Extra arguments", "codexExtraArgs", "e.g. -c model_reasoning_effort=high")}

        <h3>Paper search</h3>
        {field("Semantic Scholar API key", "semanticScholarKey", "Optional. Avoids rate limits on the free tier")}

        <h3>Library folder</h3>
        <div className="row">
          <code className="path grow">{libPath}</code>
          <button className="small ghost" onClick={() => void revealItemInDir(`${libPath}\\library.json`)}>
            Show
          </button>
        </div>

        <footer>
          <button className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="primary"
            onClick={() => {
              onSave(s);
              onClose();
            }}
          >
            Save
          </button>
        </footer>
      </div>
    </div>
  );
}
