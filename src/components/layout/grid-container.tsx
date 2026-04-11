import { createMemo, type JSX } from "solid-js";
import styles from "./grid-container.module.css";

interface GridContainerProps {
  count: number;
  children: JSX.Element;
}

const MIN_TAB_WIDTH = 400;

export function GridContainer(props: GridContainerProps) {
  let containerRef: HTMLDivElement | undefined;

  const columns = createMemo(() => {
    if (props.count <= 1) return 1;
    // Estimate: if we can't fit all tabs in one row, split into 2 rows
    // We'll use a simple heuristic based on count
    if (props.count <= 3) return props.count;
    if (props.count <= 6) return Math.ceil(props.count / 2);
    return Math.ceil(props.count / 3);
  });

  const rows = createMemo(() => Math.ceil(props.count / columns()));

  return (
    <div
      ref={containerRef}
      class={styles.grid}
      style={{
        "grid-template-columns": `repeat(${columns()}, 1fr)`,
        "grid-template-rows": `repeat(${rows()}, 1fr)`,
      }}
    >
      {props.children}
    </div>
  );
}
