import { onCleanup } from "solid-js";

interface ResizeHandleOptions {
  direction: "horizontal" | "vertical";
  getValue: () => number;
  setValue: (v: number) => void;
  min?: number;
  max?: number;
}

/**
 * Returns a mousedown handler for a resize handle.
 * Automatically cleans up listeners on unmount, blur, and visibility change.
 */
export function useResizeHandle(options: ResizeHandleOptions) {
  const { direction, getValue, setValue, min = 100, max = 600 } = options;
  let moveHandler: ((e: MouseEvent) => void) | null = null;
  let upHandler: (() => void) | null = null;
  let rafId: number | null = null;

  function cleanup() {
    if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
    if (moveHandler) document.removeEventListener("mousemove", moveHandler);
    if (upHandler) document.removeEventListener("mouseup", upHandler);
    moveHandler = null;
    upHandler = null;
  }

  function onMouseDown(e: MouseEvent) {
    e.preventDefault();
    cleanup();
    const startPos = direction === "horizontal" ? e.clientX : e.clientY;
    const startValue = getValue();
    let pendingPos: number | null = null;

    function applyResize() {
      rafId = null;
      if (pendingPos === null) return;
      const delta = direction === "horizontal"
        ? pendingPos - startPos
        : startPos - pendingPos;
      pendingPos = null;
      setValue(Math.max(min, Math.min(max, startValue + delta)));
    }

    moveHandler = (ev: MouseEvent) => {
      pendingPos = direction === "horizontal" ? ev.clientX : ev.clientY;
      if (rafId === null) rafId = requestAnimationFrame(applyResize);
    };

    upHandler = cleanup;
    document.addEventListener("mousemove", moveHandler);
    document.addEventListener("mouseup", upHandler);
  }

  function handleVisibilityChange() { if (document.hidden) cleanup(); }
  function handleBlur() { cleanup(); }

  document.addEventListener("visibilitychange", handleVisibilityChange);
  window.addEventListener("blur", handleBlur);

  onCleanup(() => {
    cleanup();
    document.removeEventListener("visibilitychange", handleVisibilityChange);
    window.removeEventListener("blur", handleBlur);
  });

  return onMouseDown;
}
