import { createSignal, Show } from "solid-js";
import { readFile } from "../../lib/commands";
import styles from "./sidebar.module.css";

interface FilePreviewProps {
  path: string | null;
  onClose: () => void;
}

export function FilePreview(props: FilePreviewProps) {
  const [content, setContent] = createSignal<string>("");
  const [error, setError] = createSignal<string>("");
  const [isLoading, setIsLoading] = createSignal(false);

  let prevPath = "";

  // Watch for path changes
  const loadFile = async (path: string) => {
    if (!path || path === prevPath) return;
    prevPath = path;
    setIsLoading(true);
    setError("");
    try {
      const text = await readFile(path);
      setContent(text);
    } catch (e) {
      setError(String(e));
      setContent("");
    }
    setIsLoading(false);
  };

  // Reactive effect via getter
  const currentPath = () => {
    const p = props.path;
    if (p) loadFile(p);
    return p;
  };

  return (
    <Show when={currentPath()}>
      <div class={styles.preview}>
        <div class={styles.previewHeader}>
          <span class={styles.previewPath}>{props.path}</span>
          <button class={styles.previewClose} onClick={props.onClose}>×</button>
        </div>
        <Show when={isLoading()}>
          <div class={styles.previewLoading}>Loading...</div>
        </Show>
        <Show when={error()}>
          <div class={styles.previewError}>{error()}</div>
        </Show>
        <Show when={!isLoading() && !error()}>
          <pre class={styles.previewContent}>{content()}</pre>
        </Show>
      </div>
    </Show>
  );
}
