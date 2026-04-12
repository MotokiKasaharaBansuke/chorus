import { createSignal, Show, createEffect } from "solid-js";
import { readFile } from "../../lib/commands";
import styles from "./file-viewer.module.css";

interface FileViewerProps {
  path: string;
  onClose: () => void;
  contentOverride?: string;
}

const KEYWORD_COLORS: Record<string, string> = {
  ts: "#3178c6", tsx: "#3178c6", js: "#f0db4f", jsx: "#f0db4f",
  rs: "#dea584", py: "#3572a5", go: "#00add8",
  css: "#563d7c", html: "#e34c26", json: "#cb8642",
  md: "#519aba", yaml: "#a074c4", toml: "#6d8086",
  sh: "#8dc149",
};

function getExt(path: string): string {
  const name = path.split("/").pop() ?? "";
  if (name.startsWith(".")) return name.slice(1);
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1) : "";
}

export function FileViewer(props: FileViewerProps) {
  const [content, setContent] = createSignal("");
  const [error, setError] = createSignal("");
  const [isLoading, setIsLoading] = createSignal(true);

  const fileName = () => props.path.split("/").pop() ?? "";
  const ext = () => getExt(props.path);
  const accentColor = () => KEYWORD_COLORS[ext()] ?? "#6e7681";

  createEffect(() => {
    if (props.contentOverride !== undefined) {
      setContent(props.contentOverride);
      setIsLoading(false);
      return;
    }
    const path = props.path;
    setContent("");
    setError("");
    setIsLoading(true);
    readFile(path)
      .then((text) => setContent(text))
      .catch((e) => setError(String(e)))
      .finally(() => setIsLoading(false));
  });

  const lineCount = () => content().split("\n").length;

  return (
    <div class={styles.viewer}>
      <div class={styles.header} style={{ "border-top-color": accentColor() }}>
        <span class={styles.fileName}>{fileName()}</span>
        <span class={styles.filePath}>{props.path}</span>
      </div>
      <div class={styles.body}>
        <Show when={isLoading()}>
          <div class={styles.loading}>Loading…</div>
        </Show>
        <Show when={error()}>
          <div class={styles.error}>{error()}</div>
        </Show>
        <Show when={!isLoading() && !error()}>
          <div class={styles.codeContainer}>
            <div class={styles.lineNumbers}>
              {Array.from({ length: lineCount() }, (_, i) => (
                <div class={styles.lineNum}>{i + 1}</div>
              ))}
            </div>
            <pre class={styles.code}>{content()}</pre>
          </div>
        </Show>
      </div>
    </div>
  );
}
