import { For, Show, createSignal, createEffect, onMount, onCleanup } from "solid-js";
import { useTabStore } from "../../stores/tab-store";
import { ChatPanel } from "../chat/chat-panel";
import { TerminalPanel } from "../terminal/terminal-panel";
import { FileViewer } from "../sidebar/file-viewer";
import { StatusIndicator } from "../status/status-indicator";
import { ClawdIcon, CodexIcon, TerminalIcon } from "../icons";
import type { PaneGroupNode, Tab, SplitDirection } from "../../types";
import styles from "./pane-group.module.css";

interface PaneGroupProps {
  node: PaneGroupNode;
  onCloseTab: (tabId: string) => void;
  onRestartTab: (tab: Tab) => void;
}

type DropEdge = "left" | "right" | "top" | "bottom" | "center" | null;

// ─────────────────────────────────────────────────────────────────────────────
// Module-level pointer-drag state (shared across all PaneGroup instances).
// HTML Drag-and-Drop API is unreliable in Tauri/WKWebView on macOS, so we
// implement DnD entirely with pointer events.
// ─────────────────────────────────────────────────────────────────────────────
const [isDragging, setIsDragging] = createSignal(false);
const [dragX, setDragX] = createSignal(0);
const [dragY, setDragY] = createSignal(0);
// Prevents click from firing on the tab after a drag gesture
let wasRecentDrag = false;

function startPointerDrag(tabId: string, sourceGroupId: string, startX: number, startY: number) {
  // Guard against multiple simultaneous drags (e.g. two-finger tap)
  if (isDragging()) return;

  let started = false;

  const resetDragState = () => {
    setIsDragging(false);
    setDragX(0);
    setDragY(0);
  };

  const onMove = (e: PointerEvent) => {
    if (!started && Math.hypot(e.clientX - startX, e.clientY - startY) > 4) {
      started = true;
      document.body.style.userSelect = "none";
      document.body.style.cursor = "grabbing";
      setIsDragging(true);
    }
    if (started) {
      e.preventDefault();
      setDragX(e.clientX);
      setDragY(e.clientY);
    }
  };

  const cleanup = () => {
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
    document.removeEventListener("pointercancel", onCancel);
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
  };

  const onUp = (e: PointerEvent) => {
    cleanup();
    if (started) {
      wasRecentDrag = true;
      setTimeout(() => { wasRecentDrag = false; }, 100);
      window.dispatchEvent(new CustomEvent("mlm-tab-drop", {
        detail: { x: e.clientX, y: e.clientY, tabId, sourceGroupId },
      }));
      resetDragState();
    }
  };

  const onCancel = () => {
    cleanup();
    if (started) resetDragState();
  };

  document.addEventListener("pointermove", onMove, { passive: false });
  document.addEventListener("pointerup", onUp);
  document.addEventListener("pointercancel", onCancel);
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function edgeClass(edge: string): string {
  switch (edge) {
    case "left":   return styles.dropLeft;
    case "right":  return styles.dropRight;
    case "top":    return styles.dropTop;
    case "bottom": return styles.dropBottom;
    default:       return styles.dropCenter;
  }
}

function computeDropEdge(x: number, y: number, rect: DOMRect): DropEdge {
  const rx = (x - rect.left) / rect.width;
  const ry = (y - rect.top) / rect.height;
  const margin = 0.30;
  if (rx < margin) return "left";
  if (rx > 1 - margin) return "right";
  if (ry < margin) return "top";
  if (ry > 1 - margin) return "bottom";
  return "center";
}

function isInRect(x: number, y: number, rect: DOMRect) {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────
export function PaneGroup(props: PaneGroupProps) {
  const store = useTabStore();
  const [dropEdge, setDropEdge] = createSignal<DropEdge>(null);
  const [tabBarDragOver, setTabBarDragOver] = createSignal(false);
  let contentRef: HTMLDivElement | undefined;
  let tabBarRef: HTMLDivElement | undefined;

  const isFocused = () => store.focusedGroupId === props.node.id;

  function renderContent(tab: Tab) {
    if (tab.cliConfig.cliType === "file-viewer" && tab.filePath) {
      return <FileViewer path={tab.filePath} onClose={() => props.onCloseTab(tab.id)} />;
    }
    if (tab.cliConfig.cliType === "claude-code" || tab.cliConfig.cliType === "codex") {
      return <ChatPanel tab={tab} />;
    }
    return <TerminalPanel tab={tab} isActive={true} />;
  }

  function edgeToSplit(edge: DropEdge): { direction: SplitDirection; side: "before" | "after" } | null {
    switch (edge) {
      case "left":   return { direction: "horizontal", side: "before" };
      case "right":  return { direction: "horizontal", side: "after" };
      case "top":    return { direction: "vertical",   side: "before" };
      case "bottom": return { direction: "vertical",   side: "after" };
      default: return null;
    }
  }

  function performDrop(tabId: string, sourceGroupId: string, edge: DropEdge) {
    if (edge === "center") {
      if (sourceGroupId !== props.node.id) {
        store.moveTabToGroup(tabId, props.node.id);
      }
    } else {
      const split = edgeToSplit(edge);
      if (!split) return;
      if (sourceGroupId === props.node.id) {
        store.splitGroup(props.node.id, split.direction, tabId, split.side);
      } else {
        store.moveTabToGroup(tabId, props.node.id);
        store.splitGroup(props.node.id, split.direction, tabId, split.side);
      }
    }
  }

  // ── Drop-zone indicators: update reactively as cursor moves ───────────────
  createEffect(() => {
    if (!isDragging()) {
      setDropEdge(null);
      setTabBarDragOver(false);
      return;
    }

    const x = dragX();
    const y = dragY();

    // Tab bar takes priority (dropping here = add to group)
    if (tabBarRef) {
      const rect = tabBarRef.getBoundingClientRect();
      if (isInRect(x, y, rect)) {
        setTabBarDragOver(true);
        setDropEdge(null);
        return;
      }
    }
    setTabBarDragOver(false);

    // Content area (edge detection for split)
    if (contentRef) {
      const rect = contentRef.getBoundingClientRect();
      if (isInRect(x, y, rect)) {
        setDropEdge(computeDropEdge(x, y, rect));
        return;
      }
    }
    setDropEdge(null);
  });

  // ── Handle the drop event dispatched on pointer-up ────────────────────────
  onMount(() => {
    function handleTabDrop(e: Event) {
      const { x, y, tabId, sourceGroupId } = (e as CustomEvent).detail as {
        x: number; y: number; tabId: string; sourceGroupId: string;
      };

      setDropEdge(null);
      setTabBarDragOver(false);

      // Tab bar drop → add to group
      if (tabBarRef) {
        const rect = tabBarRef.getBoundingClientRect();
        if (isInRect(x, y, rect)) {
          if (sourceGroupId !== props.node.id) {
            store.moveTabToGroup(tabId, props.node.id);
          }
          return;
        }
      }

      // Content area drop → split or join
      if (contentRef) {
        const rect = contentRef.getBoundingClientRect();
        if (isInRect(x, y, rect)) {
          performDrop(tabId, sourceGroupId, computeDropEdge(x, y, rect));
        }
      }
    }

    window.addEventListener("mlm-tab-drop", handleTabDrop);
    onCleanup(() => window.removeEventListener("mlm-tab-drop", handleTabDrop));
  });

  return (
    <div
      class={`${styles.paneGroup} ${isFocused() ? styles.focused : ""}`}
      onClick={() => store.setFocusedGroup(props.node.id)}
    >
      {/* Tab bar */}
      <div
        ref={tabBarRef}
        class={`${styles.tabBar} ${tabBarDragOver() ? styles.tabBarDragOver : ""}`}
      >
        <div class={styles.tabList}>{/* tabs */}
          <For each={props.node.tabIds}>
            {(tabId) => {
              const tab = () => store.getTab(tabId);
              const isActive = () => props.node.activeTabId === tabId;
              return (
                <Show when={tab()}>
                  {(t) => (
                    <div
                      class={`${styles.tab} ${isActive() ? styles.tabActive : ""} ${
                        t().cliConfig.mode === "dangerously-skip-permissions" ? styles.tabDanger : ""
                      }`}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (wasRecentDrag) return;
                        store.setActiveTabInGroup(props.node.id, tabId);
                      }}
                      onPointerDown={(e) => {
                        if (e.button !== 0) return;
                        startPointerDrag(tabId, props.node.id, e.clientX, e.clientY);
                      }}
                    >
                      <span class={styles.tabIcon}>
                        {t().cliConfig.cliType === "claude-code" && <ClawdIcon size={12} />}
                        {t().cliConfig.cliType === "codex" && <CodexIcon size={11} />}
                        {t().cliConfig.cliType === "shell" && <TerminalIcon size={11} />}
                        {t().cliConfig.cliType === "file-viewer" && <span style={{ "font-size": "10px" }}>📄</span>}
                      </span>
                      <StatusIndicator status={t().status} />
                      <span class={styles.tabTitle}>{t().title}</span>
                      {t().cliConfig.mode === "dangerously-skip-permissions" && (
                        <span class={styles.dangerDot} />
                      )}
                      <button
                        class={styles.tabClose}
                        onClick={(e) => { e.stopPropagation(); props.onCloseTab(tabId); }}
                        onPointerDown={(e) => e.stopPropagation()}
                      >×</button>
                    </div>
                  )}
                </Show>
              );
            }}
          </For>
        </div>

        {/* Active tab's directory — shown right of tabs for quick identification */}
        {(() => {
          const activeTab = () => store.getTab(props.node.activeTabId ?? "");
          const dir = () => {
            const wd = activeTab()?.cliConfig.workingDir;
            if (!wd) return null;
            return wd.split("/").filter(Boolean).pop() ?? wd;
          };
          const fullPath = () => activeTab()?.cliConfig.workingDir ?? "";
          return (
            <Show when={dir()}>
              {(d) => (
                <div class={styles.dirBadge} title={fullPath()}>
                  <svg width="9" height="9" viewBox="0 0 12 12" fill="none" style={{ "flex-shrink": 0 }}>
                    <path d="M1 3.5A1.5 1.5 0 012.5 2h2l1 1.5H9.5A1.5 1.5 0 0111 5v4A1.5 1.5 0 019.5 10.5h-7A1.5 1.5 0 011 9V3.5z" fill="currentColor" opacity=".7"/>
                  </svg>
                  {d()}
                </div>
              )}
            </Show>
          );
        })()}
      </div>

      {/* Content area with VS Code-style drop indicators */}
      <div ref={contentRef} class={styles.content}>
        <Show when={dropEdge()}>
          {(edge) => <div class={`${styles.dropIndicator} ${edgeClass(edge())}`} />}
        </Show>

        <For each={props.node.tabIds}>
          {(tabId) => {
            const tab = () => store.getTab(tabId);
            const isActive = () => props.node.activeTabId === tabId;
            return (
              <Show when={tab()}>
                {(t) => (
                  <div
                    class={styles.contentPanel}
                    style={{ display: isActive() ? "flex" : "none" }}
                    data-tab-id={tabId}
                  >
                    {renderContent(t())}
                  </div>
                )}
              </Show>
            );
          }}
        </For>
      </div>
    </div>
  );
}
