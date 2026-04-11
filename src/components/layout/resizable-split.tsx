import { createSignal, onCleanup, type JSX } from "solid-js";
import type { SplitDirection } from "../../types";
import styles from "./resizable-split.module.css";

interface ResizableSplitProps {
  direction: SplitDirection;
  ratio: number;
  first: JSX.Element;
  second: JSX.Element;
  onRatioChange?: (ratio: number) => void;
}

export function ResizableSplit(props: ResizableSplitProps) {
  const [isDragging, setIsDragging] = createSignal(false);
  let containerRef: HTMLDivElement | undefined;

  // Track active listeners for cleanup on unmount or focus loss
  let activeMoveHandler: ((e: MouseEvent) => void) | null = null;
  let activeUpHandler: (() => void) | null = null;

  function cleanupDragListeners() {
    if (activeMoveHandler) document.removeEventListener("mousemove", activeMoveHandler);
    if (activeUpHandler) document.removeEventListener("mouseup", activeUpHandler);
    activeMoveHandler = null;
    activeUpHandler = null;
    setIsDragging(false);
  }

  function handleMouseDown(e: MouseEvent) {
    e.preventDefault();
    if (!containerRef) return;
    cleanupDragListeners(); // Ensure no stale listeners
    setIsDragging(true);

    const isHorizontal = props.direction === "horizontal";
    const MIN_PX = 240;

    activeMoveHandler = (e: MouseEvent) => {
      if (!containerRef) return;
      const rect = containerRef.getBoundingClientRect();
      const pos = isHorizontal ? e.clientX - rect.left : e.clientY - rect.top;
      const total = isHorizontal ? rect.width : rect.height;
      const minRatio = Math.min(0.3, MIN_PX / total);
      const maxRatio = Math.max(0.7, 1 - MIN_PX / total);
      const newRatio = Math.max(minRatio, Math.min(maxRatio, pos / total));
      props.onRatioChange?.(newRatio);
    };

    activeUpHandler = cleanupDragListeners;

    document.addEventListener("mousemove", activeMoveHandler);
    document.addEventListener("mouseup", activeUpHandler);
  }

  // Cleanup on blur/visibility change (prevents leak if mouseup never fires)
  function handleVisibilityChange() { if (document.hidden) cleanupDragListeners(); }
  function handleBlur() { cleanupDragListeners(); }

  document.addEventListener("visibilitychange", handleVisibilityChange);
  window.addEventListener("blur", handleBlur);

  onCleanup(() => {
    cleanupDragListeners();
    document.removeEventListener("visibilitychange", handleVisibilityChange);
    window.removeEventListener("blur", handleBlur);
  });

  const isH = () => props.direction === "horizontal";

  // Use getter functions so SolidJS tracks props.ratio reactively
  const firstFlex = () => `${props.ratio} 0 0%`;
  const secondFlex = () => `${1 - props.ratio} 0 0%`;

  return (
    <div
      ref={containerRef}
      class={`${styles.container} ${isH() ? styles.horizontal : styles.vertical}`}
    >
      <div
        class={styles.first}
        style={{ flex: firstFlex() }}
      >
        {props.first}
      </div>
      <div
        class={`${styles.handle} ${isDragging() ? styles.dragging : ""} ${isH() ? styles.handleH : styles.handleV}`}
        onMouseDown={handleMouseDown}
      />
      <div
        class={styles.second}
        style={{ flex: secondFlex() }}
      >
        {props.second}
      </div>
    </div>
  );
}
