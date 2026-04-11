import { onMount, onCleanup } from "solid-js";

interface ShortcutHandlers {
  onNewTab: () => void;
  onCloseActiveTab: () => void;
  onQuickLaunchClaude: () => void;
  onQuickLaunchCodex: () => void;
  onEqualize: () => void;
  onToggleSidebar: () => void;
  onToggleTerminal: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomReset: () => void;
}

export function useKeyboardShortcuts(handlers: ShortcutHandlers) {
  function handleKeyDown(e: KeyboardEvent) {
    if (!(e.metaKey || e.ctrlKey)) return;

    switch (e.key) {
      case "t": { e.preventDefault(); handlers.onNewTab(); break; }
      case "w": { e.preventDefault(); handlers.onCloseActiveTab(); break; }
      case "1": { e.preventDefault(); handlers.onQuickLaunchClaude(); break; }
      case "2": { e.preventDefault(); handlers.onQuickLaunchCodex(); break; }
      case "e": { e.preventDefault(); handlers.onEqualize(); break; }
      case "b": { e.preventDefault(); handlers.onToggleSidebar(); break; }
      case "`": { e.preventDefault(); handlers.onToggleTerminal(); break; }
      case "=": case "+": { e.preventDefault(); handlers.onZoomIn(); break; }
      case "-": { e.preventDefault(); handlers.onZoomOut(); break; }
      case "0": { e.preventDefault(); handlers.onZoomReset(); break; }
    }
  }

  onMount(() => document.addEventListener("keydown", handleKeyDown));
  onCleanup(() => document.removeEventListener("keydown", handleKeyDown));
}
