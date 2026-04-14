import { createSignal, Show, For } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import type { FileNode as FileNodeType } from "../../types";
import { listDirectory } from "../../lib/commands";
import { useDirectoryWatch } from "../../hooks/use-directory-watch";
import { FileIcon } from "./file-icon";
import styles from "./sidebar.module.css";

interface FileNodeProps {
  node: FileNodeType;
  depth: number;
  onFileSelect: (path: string) => void;
}

export function FileNodeComponent(props: FileNodeProps) {
  const [isExpanded, setIsExpanded] = createSignal(false);
  const [children, setChildren] = createStore<{ nodes: FileNodeType[] }>({ nodes: [] });
  const [isLoading, setIsLoading] = createSignal(false);

  async function loadChildren() {
    setIsLoading(true);
    try {
      const nodes = await listDirectory(props.node.path, 1);
      setChildren("nodes", reconcile(nodes, { key: "path", merge: true }));
    } catch (e) {
      console.error("loadChildren failed:", e);
    }
    setIsLoading(false);
  }

  async function toggleExpand() {
    if (!props.node.isDirectory) {
      props.onFileSelect(props.node.path);
      return;
    }

    if (isExpanded()) {
      setIsExpanded(false);
      return;
    }

    await loadChildren();
    setIsExpanded(true);
  }

  useDirectoryWatch({
    dir: () => (isExpanded() ? props.node.path : undefined),
    onDirectoryChanged: loadChildren,
  });

  return (
    <div>
      <div
        class={styles.node}
        style={{ "padding-left": `${props.depth * 12 + 4}px` }}
        onClick={toggleExpand}
      >
        <Show when={props.node.isDirectory}>
          <span class={styles.chevron}>{isExpanded() ? "▾" : "▸"}</span>
        </Show>
        <Show when={!props.node.isDirectory}>
          <span class={styles.chevronSpacer} />
        </Show>
        <FileIcon
          name={props.node.name}
          isDirectory={props.node.isDirectory}
          isExpanded={isExpanded()}
          isSymlink={props.node.isSymlink}
        />
        <span class={`${styles.nodeName} ${props.node.isDirectory ? styles.dirName : ""}`}>
          {props.node.name}
        </span>
        <Show when={isLoading()}>
          <span class={styles.loading}>…</span>
        </Show>
      </div>
      <Show when={isExpanded()}>
        <For each={children.nodes}>
          {(child) => (
            <FileNodeComponent
              node={child}
              depth={props.depth + 1}
              onFileSelect={props.onFileSelect}
            />
          )}
        </For>
      </Show>
    </div>
  );
}
