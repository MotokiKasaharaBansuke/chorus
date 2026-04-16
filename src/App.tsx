import { batch, createSignal, createEffect, createMemo, For, Show, onMount, onCleanup } from "solid-js";
import { LogicalSize } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useTabStore } from "./stores/tab-store";
import { useSidebarStore } from "./stores/sidebar-store";
import { useSettingsStore } from "./stores/settings-store";
import { spawnPty, killPty, findGitRepoRoot, createWorktree, listWorktrees, removeWorktree, gitHasTrackedChanges, listSessionIds, killZombieSessions, listZombieSessions, killSessionById } from "./lib/commands";
import type { ZombieSessionInfo } from "./lib/commands";
import { buildSavedSession, persistSession, restoreSession, tryLoadSession } from "./lib/session";
import { spawnPaneWithWorktree } from "./lib/worktree/spawn-pane";
import { decideCloseAction } from "./lib/worktree/decide-close-action";
import { MIN_PANE_PX } from "./lib/layout/layout-tree";
import { TerminalPanel } from "./components/terminal/terminal-panel";
import { Sidebar } from "./components/sidebar/sidebar";
import { LayoutRenderer } from "./components/layout/layout-renderer";
import { CliSettingsModal } from "./components/settings/cli-settings-modal";
import { WorktreeSettingsModal } from "./components/worktree/worktree-settings-modal";
import { WorktreeErrorDialog } from "./components/worktree/worktree-error-dialog";
import { WorktreeRemoveConfirm } from "./components/worktree/worktree-remove-confirm";
import { UsageModal } from "./components/usage/usage-modal";
import { classifyWorktreeError, type WorktreeErrorInfo } from "./lib/worktree/classify-error";
import { resolveLaunchDir } from "./lib/worktree/resolve-launch-dir";
import { resetWorktree } from "./lib/worktree/reset-worktree";
import { analyzeSessionHealth } from "./lib/zombie-sessions";
import { useUsageStore } from "./stores/usage-store";
import type { TabWorktree } from "./types";
import { TopBar } from "./components/top-bar/top-bar";
import { useBottomTerminal } from "./hooks/use-bottom-terminal";
import { useKeyboardShortcuts } from "./hooks/use-keyboard-shortcuts";
import { useResizeHandle } from "./hooks/use-resize-handle";
import { removeParser } from "./lib/stream-parser-registry";
import { effectivePtyId, isTabStreaming } from "./types";
import type { CliConfig, CliMode, Tab } from "./types";
import chorusIcon from "./assets/chorus-icon.png";
import "./App.css";

function App() {
  const tabStore = useTabStore();
  const sidebarStore = useSidebarStore();
  const settingsStore = useSettingsStore();
  const usageStore = useUsageStore();
  const [isModalOpen, setIsModalOpen] = createSignal(false);
  const [showUsageModal, setShowUsageModal] = createSignal(false);
  const [quickLaunchMode, setQuickLaunchMode] = createSignal<CliMode>("dangerously-skip-permissions");
  const [fontSize, setFontSize] = createSignal(11);
  const [zoom, setZoom] = createSignal(100);

  const [isWorktreeSettingsOpen, setIsWorktreeSettingsOpen] = createSignal(false);
  const [worktreeError, setWorktreeError] = createSignal<WorktreeErrorInfo | null>(null);
  const [lastSpawnRequest, setLastSpawnRequest] = createSignal<CliConfig | null>(null);
  const [removeConfirm, setRemoveConfirm] = createSignal<
    { worktree: TabWorktree; isDirty: boolean } | null
  >(null);
  const [activeRepoRoot, setActiveRepoRoot] = createSignal<string | null>(null);
  const [zombieSessions, setZombieSessions] = createSignal<ZombieSessionInfo[]>([]);
  const [isActiveTabStale, setIsActiveTabStale] = createSignal(false);
  let spawningCount = 0;

  function spawnPtyForTab(config: CliConfig): Promise<string> {
    return spawnPty(config);
  }

  // Track the repo root of the currently active pane so the worktree
  // settings list can display that repo's worktrees.
  createEffect(() => {
    const tab = tabStore.activeTab;
    if (!tab) { setActiveRepoRoot(null); return; }
    if (tab.worktree?.repoRoot) { setActiveRepoRoot(tab.worktree.repoRoot); return; }
    const dir = tab.cliConfig.workingDir;
    if (!dir) { setActiveRepoRoot(null); return; }
    findGitRepoRoot(dir).then(setActiveRepoRoot).catch(() => setActiveRepoRoot(null));
  });

  const openWorktreePaths = createMemo(() =>
    new Set(tabStore.tabs.map((t) => t.worktree?.path).filter((p): p is string => p != null))
  );

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

  // Sidebar follows the active tab's working directory
  createEffect(() => {
    const dir = tabStore.activeTab?.cliConfig.workingDir;
    if (dir) sidebarStore.setWorkingDir(dir);
  });

  // Auto-save session on state changes (debounced)
  createEffect(() => {
    // Track reactive dependencies
    const layout = tabStore.layout;
    const tabs = tabStore.tabs;
    if (!layout || tabs.length === 0) return;

    const timer = setTimeout(() => {
      const tabMap = Object.fromEntries(tabs.map(t => [t.id, t]));
      const session = buildSavedSession(
        tabMap,
        layout,
        tabStore.focusedGroupId,
        sidebarStore.isOpen,
        sidebarStore.width,
        sidebarStore.workingDir,
        quickLaunchMode(),
        settingsStore.reviewCliType,
      );
      if (session) persistSession(session).catch(() => {});
    }, 500);
    // Cleanup runs both on effect re-execution and component unmount
    return () => clearTimeout(timer);
  });

  // --- IPC: open directory in existing instance (from mlm CLI) ---
  let ipcUnlistenRef: (() => void) | null = null;

  // --- Image drag-drop ---
  let dropUnlistenRef: (() => void) | null = null;
  let lastDropKey = "";
  let lastDropTime = 0;

  onMount(async () => {
    // Load persistent settings (settings.json) before session restore so
    // any UI that reads settings starts from the correct values.
    await settingsStore.initialize();

    // Restore previous session
    const savedSession = await tryLoadSession();
    if (savedSession) {
      const workspace = await restoreSession(JSON.stringify(savedSession));
      if (workspace) {
        tabStore.restore(workspace.tabMap, workspace.layout, workspace.focusedGroupId);
        sidebarStore.setWorkingDir(workspace.workingDir);
        if (workspace.sidebarOpen !== sidebarStore.isOpen) sidebarStore.toggle();
        sidebarStore.setWidth(workspace.sidebarWidth);
        setQuickLaunchMode(workspace.quickLaunchMode);
        settingsStore.setReviewCliType(workspace.reviewCliType);
      }
    }

    try {
      const dir = await invoke<string | null>("get_initial_directory");
      if (dir) sidebarStore.setWorkingDir(dir);
    } catch { /* ignore */ }

    void checkSessionHealth();

    // Listen for IPC "open directory" events sent by the `mlm` CLI.
    // Always adds a new split pane (not a tab in the current pane), then equalizes.
    ipcUnlistenRef = await listen<{ dir: string; cliType?: string }>("mlm-open-dir", async (event) => {
      const { dir, cliType: rawCliType } = event.payload;
      if (!dir || !dir.startsWith("/")) return;
      const cliType: "claude-code" | "codex" = rawCliType === "codex" ? "codex" : "claude-code";
      const config: CliConfig = { cliType, mode: quickLaunchMode(), workingDir: dir };
      try {
        await spawnAndOpenTab(config, { splitIntoNewPane: true });
        tabStore.equalize();
      } catch (e) { console.error("IPC: failed to spawn pane:", e); }
    });

    const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp"]);
    const isImagePath = (p: string) => IMAGE_EXTENSIONS.has(p.split(".").pop()?.toLowerCase() ?? "");

    const webview = getCurrentWebviewWindow();
    /** Find the tab ID at the given coordinates by walking up from elementFromPoint. */
    function findTabIdAtPosition(x: number, y: number): string | null {
      const el = document.elementFromPoint(x, y);
      const container = el?.closest("[data-tab-id]");
      return container?.getAttribute("data-tab-id") ?? null;
    }

    let isDraggingImages = false;

    function emitDragState(tabId: string | null, over: boolean) {
      window.dispatchEvent(new CustomEvent("mlm-drag-state", { detail: { tabId, over } }));
    }

    function resolveTabId(pos: { x: number; y: number } | undefined): string | null {
      return (pos ? findTabIdAtPosition(pos.x, pos.y) : null) ?? tabStore.activeTabId;
    }

    dropUnlistenRef = await webview.onDragDropEvent((event) => {
      const type = event.payload.type;

      if (type === "enter") {
        isDraggingImages = (event.payload.paths ?? []).some(isImagePath);
      }

      if ((type === "enter" || type === "over") && isDraggingImages) {
        emitDragState(resolveTabId(event.payload.position), true);
        return;
      }

      if (type === "drop") {
        const targetId = resolveTabId(event.payload.position);
        if (targetId) {
          const imagePaths = (event.payload.paths ?? []).filter(isImagePath);
          if (imagePaths.length > 0) {
            const deduplicationKey = imagePaths.join("|");
            const now = Date.now();
            if (deduplicationKey !== lastDropKey || now - lastDropTime >= 500) {
              lastDropKey = deduplicationKey;
              lastDropTime = now;
              window.dispatchEvent(new CustomEvent("mlm-image-drop", { detail: { tabId: targetId, paths: imagePaths } }));
            }
          }
        }
      }

      isDraggingImages = false;
      emitDragState(null, false);
    });

    function handleWorktreeResetEvent(e: Event) {
      const { tabId } = (e as CustomEvent).detail as { tabId: string };
      void performWorktreeReset(tabId);
    }
    window.addEventListener("mlm-worktree-reset", handleWorktreeResetEvent);
    onCleanup(() => window.removeEventListener("mlm-worktree-reset", handleWorktreeResetEvent));
  });

  onCleanup(() => { dropUnlistenRef?.(); ipcUnlistenRef?.(); });

  // --- Tab lifecycle ---
  const CLI_LABELS: Record<"claude-code" | "codex" | "shell", string> = { "claude-code": "Claude", "codex": "Codex", "shell": "Shell" };

  async function spawnAndOpenTab(config: CliConfig, options?: { splitIntoNewPane?: boolean }) {
    spawningCount++;
    try {
      const { paneId, finalConfig, worktree, repoRoot } = await spawnPaneWithWorktree(
        config,
        settingsStore.worktree,
        {
          findGitRepoRoot,
          createWorktree: async ({ repoRoot, baseBranch, newBranch, worktree: w }) =>
            await createWorktree({
              repoRoot,
              baseBranch,
              newBranch,
              basePath: w.basePath,
              postCreateHooks: w.postCreateHooks,
              shareCargoTarget: w.shareCargoTarget,
              spotlightExclude: w.spotlightExclude,
            }),
          spawnPty: spawnPtyForTab,
        },
      );

      const effectiveRoot = repoRoot ?? config.workingDir;
      const label = CLI_LABELS[finalConfig.cliType] ?? finalConfig.cliType;
      const title = worktree?.branch
        ? worktree.branch
        : `${label} ${tabStore.tabs.length + 1}`;
      const tab: Tab = {
        id: paneId,
        title,
        status: "waiting",
        cliConfig: finalConfig,
        worktree: worktree
          ? { path: worktree.path, branch: worktree.branch, headSha: worktree.headSha, repoRoot: effectiveRoot }
          : undefined,
      };
      tabStore.openTab(tab);
      if (options?.splitIntoNewPane && tabStore.focusedGroupId && tabStore.layout) {
        tabStore.splitGroup(tabStore.focusedGroupId, "horizontal", paneId, "after");
      }
      sidebarStore.setWorkingDir(effectiveRoot);
      return paneId;
    } finally {
      spawningCount--;
      void checkSessionHealth();
    }
  }

  async function handleNewTab(config?: CliConfig) {
    if (!config) { setIsModalOpen(true); return; }
    setLastSpawnRequest(config);
    try { await spawnAndOpenTab(config); } catch (e) {
      console.error("Failed to open pane:", e);
      setWorktreeError(classifyWorktreeError(e));
    }
  }

  async function runWorktreeRemove(wt: TabWorktree) {
    try {
      await removeWorktree(wt.path, true);
    } catch (e) {
      console.error("Failed to remove worktree:", e);
      setWorktreeError(classifyWorktreeError(e));
    }
  }

  const resettingTabs = new Set<string>();

  async function performWorktreeReset(tabId: string) {
    const tab = tabStore.getTab(tabId);
    if (!tab?.worktree || resettingTabs.has(tabId)) return;

    const { worktree: wt } = tab;
    resettingTabs.add(tabId);
    try {
      const result = await resetWorktree(
        tabId,
        effectivePtyId(tab),
        tab.cliConfig,
        wt,
        settingsStore.worktree,
        {
          killPty,
          removeWorktree,
          createWorktree,
          spawnPty: spawnPtyForTab,
          isTabAlive: (id) => !!tabStore.getTab(id),
        },
      );

      batch(() => {
        tabStore.updatePtyId(tabId, result.newPtyId);
        tabStore.updateTitle(tabId, result.created.branch);
        tabStore.updateWorkingDir(tabId, result.created.path);
        tabStore.updateWorktree(tabId, {
          path: result.created.path,
          branch: result.created.branch,
          headSha: result.created.headSha,
          repoRoot: wt.repoRoot,
        });
        tabStore.updateStatus(tabId, "waiting");
      });
    } catch (e) {
      batch(() => {
        tabStore.updateWorktree(tabId, undefined);
        tabStore.updateStatus(tabId, "error");
      });
      setWorktreeError(classifyWorktreeError(e));
    } finally {
      resettingTabs.delete(tabId);
    }
  }

  async function handleCloseTab(id: string) {
    const tab = tabStore.getTab(id);
    if (tab?.cliConfig.cliType !== "file-viewer") {
      try { await killPty(tab ? effectivePtyId(tab) : id); } catch { /* */ }
    }
    tabStore.closeTab(id);
    removeParser(id);
    usageStore.removeTab(id);
    void checkSessionHealth();

    const wt = tab?.worktree;
    if (!wt) return;
    const onPaneClose = settingsStore.worktree.onPaneClose;
    if (!onPaneClose.autoRemoveOnClose && !onPaneClose.promptRemoveWorktree) return;

    // "Dirty" means the user actually edited tracked files — untracked
    // hook artifacts (e.g. copied `.cargo/config.toml`) are ignored so
    // auto-remove can run on a pane the user never touched.
    // Conservative: on check failure, treat as dirty so silent removal
    // cannot proceed against an unknown state.
    let isDirty = true;
    try {
      isDirty = await gitHasTrackedChanges(wt.path);
    } catch (e) {
      console.warn("gitHasTrackedChanges failed; treating worktree as dirty:", e);
    }

    const action = decideCloseAction(onPaneClose, isDirty);
    if (action.kind === "silent-remove") {
      void runWorktreeRemove(wt);
    } else if (action.kind === "prompt") {
      setRemoveConfirm({ worktree: wt, isDirty: action.isDirty });
    }
  }

  function collectActivePtyIds(): string[] {
    return [
      ...tabStore.tabs.map(t => effectivePtyId(t)),
      ...bottomTerminal.termTabs().map(t => effectivePtyId(t)),
    ];
  }

  async function checkSessionHealth() {
    if (spawningCount > 0) return;
    try {
      const frontendIds = collectActivePtyIds();
      const [zombieInfos, backendIds] = await Promise.all([
        listZombieSessions(frontendIds),
        listSessionIds(),
      ]);
      setZombieSessions(zombieInfos);

      const activeTab = tabStore.activeTab;
      const activePtyId = activeTab && activeTab.cliConfig.cliType !== "file-viewer"
        ? effectivePtyId(activeTab)
        : null;
      const { isActiveStale } = analyzeSessionHealth(backendIds, frontendIds, activePtyId);
      setIsActiveTabStale(isActiveStale);
    } catch {
      setZombieSessions([]);
      setIsActiveTabStale(false);
    }
  }

  createEffect(() => {
    // Re-check session health when the active tab changes
    void tabStore.activeTabId;
    void checkSessionHealth();
  });

  let isRefreshing = false;

  async function handleRefreshActiveTab() {
    const tab = tabStore.activeTab;
    if (!tab || tab.cliConfig.cliType === "file-viewer") return;
    if (isRefreshing) return;
    if (isTabStreaming(tab.status)) return;

    isRefreshing = true;
    const oldPtyId = effectivePtyId(tab);
    try { await killPty(oldPtyId); } catch { /* already dead */ }
    try {
      const newPtyId = await spawnPtyForTab(tab.cliConfig);
      if (!tabStore.getTab(tab.id)) {
        await killPty(newPtyId).catch(() => {});
        return;
      }
      tabStore.updatePtyId(tab.id, newPtyId);
      tabStore.updateStatus(tab.id, "waiting");
      setIsActiveTabStale(false);
      window.dispatchEvent(new CustomEvent("mlm-refresh-tab", { detail: { tabId: tab.id } }));
    } catch {
      if (tabStore.getTab(tab.id)) {
        tabStore.updateStatus(tab.id, "error");
      }
    } finally {
      isRefreshing = false;
      void checkSessionHealth();
    }
  }

  async function handleKillZombie(id: string) {
    try {
      await killSessionById(id);
    } catch { /* best effort */ }
    void checkSessionHealth();
  }

  async function handleKillAllZombies() {
    try {
      await killZombieSessions(collectActivePtyIds());
    } catch { /* best effort */ }
    void checkSessionHealth();
  }

  async function performWorktreeRemove() {
    const entry = removeConfirm();
    if (!entry) return;
    setRemoveConfirm(null);
    if (settingsStore.worktree.onPaneClose.backgroundDelete) {
      void runWorktreeRemove(entry.worktree);
    } else {
      await runWorktreeRemove(entry.worktree);
    }
  }

  async function handleRestartTab(tab: Tab) {
    if (tab.cliConfig.cliType === "file-viewer") return;
    try { await killPty(effectivePtyId(tab)); } catch {}
    tabStore.closeTab(tab.id);
    removeParser(tab.id);
    await handleNewTab(tab.cliConfig);
  }

  function handleFileOpen(path: string) {
    const existing = tabStore.tabs.find(t => t.cliConfig.cliType === "file-viewer" && t.filePath === path);
    if (existing) { tabStore.setActiveTab(existing.id); return; }
    const fileName = path.split("/").pop() ?? "file";
    const id = `file-${Date.now()}`;
    const tab: Tab = { id, title: fileName, status: "completed", cliConfig: { cliType: "file-viewer", mode: "default", workingDir: "" }, filePath: path };
    tabStore.openTab(tab);
  }

  // Open tool output content as a read-only tab
  function handleContentOpen(title: string, content: string) {
    const id = `content-${Date.now()}`;
    const tab: Tab = {
      id,
      title,
      status: "completed",
      cliConfig: { cliType: "file-viewer", mode: "default", workingDir: "" },
      filePath: id, // unique key
      contentOverride: content,
    };
    tabStore.openTab(tab);
  }

  // Listen for content-open events from message bubbles
  const contentOpenHandler = (e: Event) => {
    const detail = (e as CustomEvent).detail;
    if (detail?.title && detail?.content) {
      handleContentOpen(detail.title, detail.content);
    }
  };
  window.addEventListener("mlm-open-content", contentOpenHandler);
  onCleanup(() => window.removeEventListener("mlm-open-content", contentOpenHandler));

  async function quickLaunch(cliType: "claude-code" | "codex") {
    const config: CliConfig = { cliType, mode: quickLaunchMode(), workingDir: resolveLaunchDir(tabStore.activeTab, sidebarStore.workingDir) };
    setLastSpawnRequest(config);
    try { await spawnAndOpenTab(config, { splitIntoNewPane: true }); } catch (e) {
      console.error("Failed to quick-launch pane:", e);
      setWorktreeError(classifyWorktreeError(e));
    }
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
    document.documentElement.style.setProperty("--global-chat-font-size", `${clamped}px`);
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
    onRefreshActiveTab: () => handleRefreshActiveTab(),
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

  const SIDEBAR_WIDTH = 200;
  createEffect(() => {
    const cols = countHorizontalColumns(tabStore.layout);
    const sidebarW = sidebarStore.isOpen ? SIDEBAR_WIDTH : 0;
    const minWidth = Math.max(600, sidebarW + cols * MIN_PANE_PX);
    getCurrentWindow().setMinSize(new LogicalSize(minWidth, 400)).catch(() => {});
  });

  return (
    <div class="app">
      {/* Drag region for macOS traffic lights */}
      <div class="drag-region" data-tauri-drag-region onMouseDown={() => getCurrentWindow().startDragging()} />

      {/* Toolbar: DEV badge (left) + action icons (right) */}
      <div class="toolbar">
        {import.meta.env.DEV && <span class="dev-badge">DEV</span>}
        <TopBar
          isSidebarOpen={sidebarStore.isOpen}
          onToggleSidebar={() => sidebarStore.toggle()}
          onToggleTerminal={() => bottomTerminal.toggle()}
          onNewTab={() => handleNewTab()}
          canOpenTab={tabStore.canOpenTab}
          quickLaunchMode={quickLaunchMode()}
          onQuickLaunchModeChange={setQuickLaunchMode}
          reviewCliType={settingsStore.reviewCliType}
          onReviewCliTypeChange={(t) => settingsStore.setReviewCliType(t)}
          fontSize={fontSize()}
          onFontSizeChange={applyFontSize}
          onOpenWorktreeSettings={() => setIsWorktreeSettingsOpen(true)}
          zombieSessions={zombieSessions()}
          onKillZombie={handleKillZombie}
          onKillAllZombies={handleKillAllZombies}
          hasActiveTab={!!tabStore.activeTab && tabStore.activeTab.cliConfig.cliType !== "file-viewer"}
          isActiveTabStale={isActiveTabStale()}
          onRefreshActiveTab={handleRefreshActiveTab}
          rateLimits={usageStore.rateLimits}
          onViewUsage={() => setShowUsageModal(true)}
        />
      </div>

      <div class="app-body">
        <Show when={sidebarStore.isOpen}>
          <div class="sidebar-container" style={{ width: `${sidebarStore.width}px` }}>
            <Sidebar workingDir={sidebarStore.workingDir} displayDir={tabStore.activeTab?.worktree?.repoRoot} onFileOpen={handleFileOpen} />
          </div>
          <div class="sidebar-resize" onMouseDown={sidebarResizeDown} />
        </Show>
        <div class="main-area">
          <div class="content-split">
            <div class="layout-area">
              <Show when={tabStore.layout} fallback={
                <div class="empty-state">
                  <img src={chorusIcon} alt="" class="empty-logo" />
                  <h2>Chorus</h2>
                  <p class="empty-sub">Run AI coding assistants side by side</p>
                  <div class="empty-shortcuts">
                    <div class="shortcut-row"><kbd>⌘1</kbd><span>Claude Code</span></div>
                    <div class="shortcut-row"><kbd>⌘2</kbd><span>Codex</span></div>
                    <div class="shortcut-row"><kbd>⌘T</kbd><span>New pane</span></div>
                    <div class="shortcut-row"><kbd>⌘B</kbd><span>Toggle sidebar</span></div>
                  </div>
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

      <WorktreeSettingsModal
        isOpen={isWorktreeSettingsOpen()}
        settings={settingsStore.worktree}
        repoRoot={activeRepoRoot()}
        openWorktreePaths={openWorktreePaths()}
        activeWorktreePath={tabStore.activeTab?.worktree?.path ?? null}
        onChange={(patch) => settingsStore.patchWorktree(patch)}
        loadWorktrees={listWorktrees}
        removeWorktree={removeWorktree}
        onClose={() => setIsWorktreeSettingsOpen(false)}
      />

      <WorktreeErrorDialog
        error={worktreeError()}
        onRetry={() => {
          const cfg = lastSpawnRequest();
          setWorktreeError(null);
          if (cfg) handleNewTab(cfg);
        }}
        onClose={() => setWorktreeError(null)}
      />

      <WorktreeRemoveConfirm
        worktree={removeConfirm()?.worktree ?? null}
        isDirty={removeConfirm()?.isDirty ?? false}
        onKeep={() => setRemoveConfirm(null)}
        onRemove={() => { void performWorktreeRemove(); }}
      />

      <Show when={showUsageModal()}>
        <UsageModal
          rateLimits={usageStore.rateLimits}
          onClose={() => setShowUsageModal(false)}
        />
      </Show>
    </div>
  );
}

export default App;
