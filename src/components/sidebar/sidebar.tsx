import { createSignal, Show, For, createEffect } from "solid-js";
import type { FileNode } from "../../types";
import { listDirectory } from "../../lib/commands";
import { FileNodeComponent } from "./file-node";
import { FilePreview } from "./file-preview";
import styles from "./sidebar.module.css";

interface SidebarProps {
  workingDir: string;
  onFileOpen?: (path: string) => void;
}

export function Sidebar(props: SidebarProps) {
  const [nodes, setNodes] = createSignal<FileNode[]>([]);
  const [isLoading, setIsLoading] = createSignal(false);

  createEffect(() => {
    const dir = props.workingDir;
    if (dir) {
      loadDirectory(dir);
    }
  });

  async function loadDirectory(dir: string) {
    setIsLoading(true);
    try {
      const result = await listDirectory(dir, 1);
      setNodes(result);
    } catch {
      setNodes([]);
    }
    setIsLoading(false);
  }

  const projectName = () => {
    if (!props.workingDir) return "EXPLORER";
    const parts = props.workingDir.split("/");
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
        <Show when={!isLoading() && nodes().length === 0 && !props.workingDir}>
          <div class={styles.emptyMsg}>No directory selected</div>
        </Show>
        <For each={nodes()}>
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
