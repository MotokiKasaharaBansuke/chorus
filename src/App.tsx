import { createSignal, createEffect, For, Show, onMount, onCleanup } from "solid-js";
import { LogicalSize } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useTabStore } from "./stores/tab-store";
import { useSidebarStore } from "./stores/sidebar-store";
import { spawnPty, killPty } from "./lib/commands";
import { TerminalPanel } from "./components/terminal/terminal-panel";
import { Sidebar } from "./components/sidebar/sidebar";
import { LayoutRenderer } from "./components/layout/layout-renderer";
import { CliSettingsModal } from "./components/settings/cli-settings-modal";
import { TopBar } from "./components/top-bar/top-bar";
import { useBottomTerminal } from "./hooks/use-bottom-terminal";
import { useKeyboardShortcuts } from "./hooks/use-keyboard-shortcuts";
import { useResizeHandle } from "./hooks/use-resize-handle";
import type { CliConfig, CliMode, Tab } from "./types";
import "./App.css";

function App() {
  const tabStore = useTabStore();
  const sidebarStore = useSidebarStore();
  const [isModalOpen, setIsModalOpen] = createSignal(false);
  const [quickLaunchMode, setQuickLaunchMode] = createSignal<CliMode>("dangerously-skip-permissions");
  const [fontSize, setFontSize] = createSignal(13);
  const [zoom, setZoom] = createSignal(100);

  const bottomTerminal = useBottomTerminal(() => sidebarStore.workingDir);

  const sidebarResizeDown = useResizeHandle({
    direction: "horizontal",
    getValue: () => sidebarStore.width,
    setValue: (v) => sidebarStore.setWidth(v),
    min: 150,
    max: 500,
  });

  const termResizeDown = useResizeHandle({
    direction: "vertical",
    getValue: () => bottomTerminal.termHeight(),
    setValue: (v) => bottomTerminal.setTermHeight(v),
    min: 80,
    max: 600,
  });

  // --- Image drag-drop ---
  let dropUnlistenRef: (() => void) | null = null;
  let lastDropKey = "";
  let lastDropTime = 0;

  onMount(async () => {
    try {
      const dir = await invoke<string | null>("get_initial_directory");
      if (dir) sidebarStore.setWorkingDir(dir);
    } catch { /* ignore */ }

    const imgExts = ["png","jpg","jpeg","gif","webp","svg","bmp"];
    const webview = getCurrentWebviewWindow();
    dropUnlistenRef = await webview.onDragDropEvent((event) => {
      if (event.payload.type === "drop") {
        const targetId = tabStore.activeTabId;
        if (!targetId) return;
        const imagePaths = event.payload.paths.filter(p => {
          const ext = p.split(".").pop()?.toLowerCase() ?? "";
          return imgExts.includes(ext);
        });
        if (imagePaths.length > 0) {
          const dropKey = imagePaths.join("|");
          const now = Date.now();
          if (dropKey === lastDropKey && now - lastDropTime < 500) return;
          lastDropKey = dropKey;
          lastDropTime = now;
          window.dispatchEvent(new CustomEvent("mlm-image-drop", { detail: { tabId: targetId, paths: imagePaths } }));
        }
        window.dispatchEvent(new CustomEvent("mlm-drag-state", { detail: { tabId: null, over: false } }));
      } else if (event.payload.type === "over") {
        const hasImageFiles = (event.payload.paths ?? []).some(p => {
          const ext = p.split(".").pop()?.toLowerCase() ?? "";
          return imgExts.includes(ext);
        });
        if (hasImageFiles) {
          window.dispatchEvent(new CustomEvent("mlm-drag-state", { detail: { tabId: tabStore.activeTabId, over: true } }));
        }
      } else {
        window.dispatchEvent(new CustomEvent("mlm-drag-state", { detail: { tabId: null, over: false } }));
      }
    });
  });

  onCleanup(() => { dropUnlistenRef?.(); });

  // --- Tab lifecycle ---
  async function handleNewTab(config?: CliConfig) {
    if (!config) { setIsModalOpen(true); return; }
    try {
      const id = await spawnPty(config);
      const cliLabel = config.cliType === "claude-code" ? "Claude"
        : config.cliType === "codex" ? "Codex" : "Shell";
      const tab: Tab = { id, title: `${cliLabel} ${tabStore.tabs.length + 1}`, status: "running", cliConfig: config };
      tabStore.openTab(tab);
      sidebarStore.setWorkingDir(config.workingDir);
    } catch { /* spawn failed */ }
  }

  async function handleCloseTab(id: string) {
    const tab = tabStore.getTab(id);
    if (tab?.cliConfig.cliType !== "file-viewer") {
      try { await killPty(id); } catch { /* */ }
    }
    tabStore.closeTab(id);
  }

  async function handleRestartTab(tab: Tab) {
    if (tab.cliConfig.cliType === "file-viewer") return;
    try { await killPty(tab.id); } catch {}
    tabStore.closeTab(tab.id);
    handleNewTab(tab.cliConfig);
  }

  function handleFileOpen(path: string) {
    const existing = tabStore.tabs.find(t => t.cliConfig.cliType === "file-viewer" && t.filePath === path);
    if (existing) { tabStore.setActiveTab(existing.id); return; }
    const fileName = path.split("/").pop() ?? "file";
    const id = `file-${Date.now()}`;
    const tab: Tab = { id, title: fileName, status: "completed", cliConfig: { cliType: "file-viewer", mode: "default", workingDir: "" }, filePath: path };
    tabStore.openTab(tab);
  }

  async function quickLaunch(cliType: "claude-code" | "codex") {
    const config: CliConfig = { cliType, mode: quickLaunchMode(), workingDir: sidebarStore.workingDir || "~" };
    try {
      const id = await spawnPty(config);
      const label = cliType === "claude-code" ? "Claude" : "Codex";
      const tab: Tab = { id, title: `${label} ${tabStore.tabs.length + 1}`, status: "running", cliConfig: config };
      const focusedGroup = tabStore.focusedGroupId;
      if (focusedGroup && tabStore.layout) {
        tabStore.openTab(tab);
        tabStore.splitGroup(focusedGroup, "horizontal", id, "after");
      } else {
        tabStore.openTab(tab);
      }
      sidebarStore.setWorkingDir(config.workingDir);
    } catch { /* spawn failed */ }
  }

  // --- Zoom & font size ---
  function applyZoom(level: number) {
    const clamped = Math.max(60, Math.min(180, level));
    setZoom(clamped);
    document.body.style.zoom = `${clamped}%`;
    window.dispatchEvent(new CustomEvent("mlm-zoom", { detail: { zoom: clamped } }));
  }

  function applyFontSize(size: number) {
    const clamped = Math.max(10, Math.min(20, size));
    setFontSize(clamped);
    document.documentElement.style.setProperty("--chat-font-size", `${clamped}px`);
  }

  // --- Keyboard shortcuts ---
  useKeyboardShortcuts({
    onNewTab: () => handleNewTab(),
    onCloseActiveTab: () => { const id = tabStore.activeTabId; if (id) handleCloseTab(id); },
    onQuickLaunchClaude: () => quickLaunch("claude-code"),
    onQuickLaunchCodex: () => quickLaunch("codex"),
    onEqualize: () => tabStore.equalize(),
    onToggleSidebar: () => sidebarStore.toggle(),
    onToggleTerminal: () => bottomTerminal.toggle(),
    onZoomIn: () => applyZoom(zoom() + 10),
    onZoomOut: () => applyZoom(zoom() - 10),
    onZoomReset: () => applyZoom(100),
  });

  // --- Dynamic window min size ---
  function countHorizontalColumns(node: import("./types").LayoutNode | null): number {
    if (!node) return 0;
    if (node.type === "pane-group") return 1;
    if (node.type === "split" && node.direction === "horizontal") {
      return countHorizontalColumns(node.children[0]) + countHorizontalColumns(node.children[1]);
    }
    return Math.max(countHorizontalColumns(node.children[0]), countHorizontalColumns(node.children[1]));
  }

  const MIN_PANE_WIDTH = 240;
  const SIDEBAR_WIDTH = 200;
  createEffect(() => {
    const cols = countHorizontalColumns(tabStore.layout);
    const sidebarW = sidebarStore.isOpen ? SIDEBAR_WIDTH : 0;
    const minWidth = Math.max(600, sidebarW + cols * MIN_PANE_WIDTH);
    getCurrentWindow().setMinSize(new LogicalSize(minWidth, 400)).catch(() => {});
  });

  return (
    <div class="app">
      <TopBar
        paneCount={tabStore.tabs.length}
        isSidebarOpen={sidebarStore.isOpen}
        onToggleSidebar={() => sidebarStore.toggle()}
        onToggleTerminal={() => bottomTerminal.toggle()}
        onNewTab={() => handleNewTab()}
        canOpenTab={tabStore.canOpenTab}
        quickLaunchMode={quickLaunchMode()}
        onQuickLaunchModeChange={setQuickLaunchMode}
        fontSize={fontSize()}
        onFontSizeChange={applyFontSize}
      />

      <div class="app-body">
        <Show when={sidebarStore.isOpen}>
          <div class="sidebar-container" style={{ width: `${sidebarStore.width}px` }}>
            <Sidebar workingDir={sidebarStore.workingDir} onFileOpen={handleFileOpen} />
          </div>
          <div class="sidebar-resize" onMouseDown={sidebarResizeDown} />
        </Show>
        <div class="main-area">
          <div class="content-split">
            <div class="layout-area">
              <Show when={tabStore.layout} fallback={
                <div class="empty-state">
                  <div class="empty-icon">●</div>
                  <h2>Chorus</h2>
                  <p>Press ⌘T to open a new pane</p>
                </div>
              }>
                <LayoutRenderer onCloseTab={handleCloseTab} onRestartTab={handleRestartTab} />
              </Show>
            </div>
            <Show when={bottomTerminal.showTerminal()}>
              <div class="bottom-terminal" style={{ height: `${bottomTerminal.termHeight()}px` }}>
                <div class="bottom-terminal-resize" onMouseDown={termResizeDown} />
                <div class="bottom-terminal-header">
                  <div class="bottom-term-tabs">
                    <For each={bottomTerminal.termTabs()}>
                      {(tab) => (
                        <div class={`bottom-term-tab ${tab.id === bottomTerminal.activeTermId() ? "bottom-term-tab-active" : ""}`} onClick={() => bottomTerminal.setActiveTermId(tab.id)}>
                          <svg width="12" height="12" viewBox="0 0 40 40" fill="none"><rect x="4" y="6" width="32" height="28" rx="4" fill="#333"/><text x="20" y="26" text-anchor="middle" fill="#3fb950" font-size="16" font-weight="700" font-family="monospace">$</text></svg>
                          <span>{tab.title}</span>
                          <button class="bottom-term-close" onClick={(e) => { e.stopPropagation(); bottomTerminal.closeTab(tab.id); }}>×</button>
                        </div>
                      )}
                    </For>
                    <button class="bottom-term-add" onClick={bottomTerminal.addTab} title="New Terminal">+</button>
                  </div>
                  <button class="bottom-term-close-all" onClick={bottomTerminal.hide}>×</button>
                </div>
                <div class="bottom-terminal-content">
                  <For each={bottomTerminal.termTabs()}>
                    {(tab) => (
                      <div style={{ display: tab.id === bottomTerminal.activeTermId() ? "flex" : "none", flex: 1, "flex-direction": "column" }}>
                        <TerminalPanel tab={tab} isActive={tab.id === bottomTerminal.activeTermId()} />
                      </div>
                    )}
                  </For>
                </div>
              </div>
            </Show>
          </div>
        </div>
      </div>

      <CliSettingsModal
        isOpen={isModalOpen()}
        defaultWorkingDir={sidebarStore.workingDir}
        onSubmit={(config) => { setIsModalOpen(false); handleNewTab(config); }}
        onCancel={() => setIsModalOpen(false)}
      />
    </div>
  );
}

export default App;
