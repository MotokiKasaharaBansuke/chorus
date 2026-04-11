import { createSignal, Show, For } from "solid-js";
import type { FileNode as FileNodeType } from "../../types";
import { listDirectory } from "../../lib/commands";
import { FileIcon } from "./file-icon";
import styles from "./sidebar.module.css";

interface FileNodeProps {
  node: FileNodeType;
  depth: number;
  onFileSelect: (path: string) => void;
}

export function FileNodeComponent(props: FileNodeProps) {
  const [isExpanded, setIsExpanded] = createSignal(false);
  const [children, setChildren] = createSignal<FileNodeType[]>([]);
  const [isLoading, setIsLoading] = createSignal(false);

  async function toggleExpand() {
    if (!props.node.isDirectory) {
      props.onFileSelect(props.node.path);
      return;
    }

    if (isExpanded()) {
      setIsExpanded(false);
      return;
    }

    setIsLoading(true);
    try {
      const nodes = await listDirectory(props.node.path, 1);
      setChildren(nodes);
      setIsExpanded(true);
    } catch {
      // ignore
    }
    setIsLoading(false);
  }

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
        <For each={children()}>
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
