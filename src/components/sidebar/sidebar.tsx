import { createSignal, Show, For, createEffect, onCleanup } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import type { FileNode } from "../../types";
import { listDirectory, watchDirectory, unwatchDirectory } from "../../lib/commands";
import { useDirectoryWatch } from "../../hooks/use-directory-watch";
import { FileNodeComponent } from "./file-node";
import styles from "./sidebar.module.css";

interface SidebarProps {
  workingDir: string;
  displayDir?: string;
  onFileOpen?: (path: string) => void;
}

export function Sidebar(props: SidebarProps) {
  const [tree, setTree] = createStore<{ nodes: FileNode[] }>({ nodes: [] });
  const [isLoading, setIsLoading] = createSignal(false);

  // Rust maintains a single global watcher and atomically swaps targets on each
  // `watch_directory` call, so rapid `workingDir` changes don't need an
  // intermediate `unwatchDirectory()`. We only release the watcher when this
  // component unmounts.
  createEffect(() => {
    const dir = props.workingDir;
    if (!dir) return;
    loadDirectory(dir);
    watchDirectory(dir).catch((e) => console.error("watchDirectory failed:", e));
  });

  onCleanup(() => {
    unwatchDirectory().catch((e) => console.error("unwatchDirectory failed:", e));
  });

  useDirectoryWatch({
    dir: () => props.workingDir || undefined,
    onDirectoryChanged: () => loadDirectory(props.workingDir),
  });

  async function loadDirectory(dir: string) {
    setIsLoading(true);
    try {
      const result = await listDirectory(dir, 1);
      setTree("nodes", reconcile(result, { key: "path", merge: true }));
    } catch (e) {
      console.error("listDirectory failed:", e);
      setTree("nodes", reconcile([], { key: "path", merge: true }));
    }
    setIsLoading(false);
  }

  const projectName = () => {
    const dir = props.displayDir ?? props.workingDir;
    if (!dir) return "EXPLORER";
    const parts = dir.split("/");
    return parts[parts.length - 1]?.toUpperCase() || "EXPLORER";
  };

  return (
    <div class={styles.sidebar}>
      <div class={styles.header}>
        <span class={styles.headerTitle}>{projectName()}</span>
      </div>
      <div class={styles.tree}>
        <Show when={isLoading()}>
          <div class={styles.loadingMsg}>Loading…</div>
        </Show>
        <Show when={!isLoading() && tree.nodes.length === 0 && !props.workingDir}>
          <div class={styles.emptyMsg}>No directory selected</div>
        </Show>
        <For each={tree.nodes}>
          {(node) => (
            <FileNodeComponent
              node={node}
              depth={0}
              onFileSelect={(path) => {
                if (props.onFileOpen) {
                  props.onFileOpen(path);
                }
              }}
            />
          )}
        </For>
      </div>
    </div>
  );
}
