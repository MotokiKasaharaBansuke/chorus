import { createSignal, type JSX } from "solid-js";
import { MIN_PANE_PX } from "../../lib/layout/layout-tree";
import styles from "./split-pane.module.css";

interface SplitPaneProps {
  left: JSX.Element;
  right: JSX.Element;
  initialLeftWidth?: number;
  minLeft?: number;
  minRight?: number;
}

export function SplitPane(props: SplitPaneProps) {
  const [leftWidth, setLeftWidth] = createSignal(props.initialLeftWidth ?? 250);
  const [isDragging, setIsDragging] = createSignal(false);
  const minLeft = props.minLeft ?? MIN_PANE_PX;
  const minRight = props.minRight ?? MIN_PANE_PX;

  function handleMouseDown(e: MouseEvent) {
    e.preventDefault();
    setIsDragging(true);

    const startX = e.clientX;
    const startWidth = leftWidth();

    function onMouseMove(e: MouseEvent) {
      const delta = e.clientX - startX;
      const newWidth = Math.max(minLeft, startWidth + delta);
      setLeftWidth(newWidth);
    }

    function onMouseUp() {
      setIsDragging(false);
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    }

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }

  return (
    <div class={styles.splitPane}>
      <div class={styles.left} style={{ width: `${leftWidth()}px` }}>
        {props.left}
      </div>
      <div
        class={`${styles.handle} ${isDragging() ? styles.dragging : ""}`}
        onMouseDown={handleMouseDown}
      />
      <div class={styles.right}>
        {props.right}
      </div>
    </div>
  );
}
