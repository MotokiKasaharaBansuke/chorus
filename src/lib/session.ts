import type { CliConfig, CliMode, PaneKind, ReviewCliType, SessionFlags, TabWorktree, LayoutNode, PaneGroupNode, SplitNode, Tab } from "../types";
import { effectivePaneKind } from "../types";
import { saveSession, loadSession } from "./commands/session-commands";
import { spawnPty, sessionFileExists, restoreSessionFile } from "./commands";
import { spawnHeadless } from "./headless/commands";

const SESSION_VERSION = 1;

// ---- Saved types (index-based, no PTY IDs) ----

interface SavedTab {
  title: string;
  cliConfig: CliConfig;
  lastSessionId?: string;
  worktree?: TabWorktree;
  /** Engine the tab was running on at save time. Absent for legacy
   *  sessions written before Phase 3 — interpreted as `"pty"`. */
  paneKind?: PaneKind;
}

type SavedLayout = SavedSplit | SavedPaneGroup;

interface SavedSplit {
  type: "split";
  direction: "horizontal" | "vertical";
  ratio: number;
  children: [SavedLayout, SavedLayout];
}

interface SavedPaneGroup {
  type: "pane-group";
  tabIndices: number[];
  activeTabIdx: number;
  focused: boolean;
}

export interface SavedSession {
  version: typeof SESSION_VERSION;
  tabs: SavedTab[];
  layout: SavedLayout;
  sidebarOpen: boolean;
  sidebarWidth: number;
  workingDir: string;
  quickLaunchMode: CliMode;
  reviewCliType?: ReviewCliType;
}

export interface RestoredWorkspace {
  tabMap: Record<string, Tab>;
  layout: LayoutNode;
  focusedGroupId: string;
  workingDir: string;
  sidebarOpen: boolean;
  sidebarWidth: number;
  quickLaunchMode: CliMode;
  reviewCliType: ReviewCliType;
}

// ---- Serialize current state ----

function serializeLayout(
  layout: LayoutNode,
  tabIdToIdx: Map<string, number>,
  focusedGroupId: string | null
): SavedLayout {
  if (layout.type === "split") {
    return {
      type: "split",
      direction: layout.direction,
      ratio: layout.ratio,
      children: [
        serializeLayout(layout.children[0], tabIdToIdx, focusedGroupId),
        serializeLayout(layout.children[1], tabIdToIdx, focusedGroupId),
      ],
    };
  }
  const tabIndices = layout.tabIds
    .map(id => tabIdToIdx.get(id))
    .filter((i): i is number => i !== undefined);
  const activeIdx = layout.activeTabId != null ? (tabIdToIdx.get(layout.activeTabId) ?? 0) : 0;
  return {
    type: "pane-group",
    tabIndices,
    activeTabIdx: activeIdx,
    focused: layout.id === focusedGroupId,
  };
}

export function buildSavedSession(
  tabMap: Record<string, Tab>,
  layout: LayoutNode | null,
  focusedGroupId: string | null,
  sidebarOpen: boolean,
  sidebarWidth: number,
  workingDir: string,
  quickLaunchMode: CliMode,
  reviewCliType: ReviewCliType = "codex",
): SavedSession | null {
  if (!layout) return null;

  // Only save CLI tabs (not file-viewer)
  const tabs = Object.values(tabMap).filter(t => t.cliConfig.cliType !== "file-viewer");
  if (tabs.length === 0) return null;

  const tabIdToIdx = new Map(tabs.map((t, i) => [t.id, i]));
  const savedLayout = serializeLayout(layout, tabIdToIdx, focusedGroupId);

  return {
    version: SESSION_VERSION,
    tabs: tabs.map((t) => {
      // Persist `paneKind` only when non-default so legacy session.json
      // files (no `paneKind` key) round-trip unchanged. Restore reads
      // absent as `"pty"` via `effectivePaneKind`.
      const kind = effectivePaneKind(t);
      return {
        title: t.title,
        cliConfig: { ...t.cliConfig },
        lastSessionId: t.lastSessionId,
        worktree: t.worktree,
        ...(kind === "headless" ? { paneKind: "headless" as const } : {}),
      };
    }),
    layout: savedLayout,
    sidebarOpen,
    sidebarWidth,
    workingDir,
    quickLaunchMode,
    reviewCliType,
  };
}

export async function persistSession(session: SavedSession): Promise<void> {
  await saveSession(JSON.stringify(session));
}

// ---- Restore ----

function buildLayout(
  saved: SavedLayout,
  newIds: string[],
  focusedGroupId: { value: string | null }
): LayoutNode {
  if (saved.type === "split") {
    return {
      type: "split",
      id: crypto.randomUUID(),
      direction: saved.direction,
      ratio: saved.ratio,
      children: [
        buildLayout(saved.children[0], newIds, focusedGroupId),
        buildLayout(saved.children[1], newIds, focusedGroupId),
      ],
    } as SplitNode;
  }
  const tabIds = saved.tabIndices
    .map(i => newIds[i])
    .filter((id): id is string => !!id);
  const activeTabId = newIds[saved.activeTabIdx] ?? tabIds[0] ?? null;
  const groupId = crypto.randomUUID();
  if (saved.focused) focusedGroupId.value = groupId;
  return {
    type: "pane-group",
    id: groupId,
    tabIds,
    activeTabId,
  } as PaneGroupNode;
}

export async function restoreSession(data: string): Promise<RestoredWorkspace | null> {
  let session: SavedSession;
  try {
    session = JSON.parse(data) as SavedSession;
    if (session.version !== SESSION_VERSION || !session.tabs?.length) return null;
  } catch {
    return null;
  }

  // Validate each tab's lastSessionId against the on-disk session store
  // BEFORE passing --resume to the CLI.  If the .jsonl file is missing
  // (e.g. Claude Code pruned it), attempt to restore from Chorus's cache.
  // Only clear the ID when neither original nor cache exists.
  const workingDir = session.workingDir ?? "";
  const validatedTabs = await Promise.all(
    session.tabs.map(async (t) => {
      if (!t.lastSessionId || t.lastSessionId.length === 0) return t;
      const cwd = t.worktree?.path ?? t.cliConfig.workingDir ?? workingDir;
      if (!cwd) return t;
      const exists = await sessionFileExists(cwd, t.lastSessionId).catch(() => false);
      if (exists) return t;
      const restored = await restoreSessionFile(cwd, t.lastSessionId).catch(() => false);
      if (restored) return t;
      return { ...t, lastSessionId: undefined };
    }),
  );

  // Spawn engines for all tabs in parallel.
  //
  // For PTY tabs: when a `lastSessionId` is present we resume the CLI's
  // saved conversation so context survives the app restart.
  //
  // For headless tabs: spawn a new headless session, passing
  // `resumeSessionAt` when available so Claude continues the previous
  // conversation rather than starting fresh.
  //
  // Defence-in-depth: a hand-edited session.json that pairs `paneKind:
  // "headless"` with a non-Claude/Codex `cliType` falls back to PTY here.
  // The backend would also reject (`headless_commands.rs` rejects shell),
  // but resolving it on the frontend keeps the user's tab alive in the
  // legacy engine instead of silently failing the spawn.
  const spawnResults = await Promise.allSettled(
    validatedTabs.map((t) => {
      const kind: PaneKind = t.paneKind ?? "pty";
      const cwd = t.worktree?.path ?? t.cliConfig.workingDir ?? workingDir;
      const cliType = t.cliConfig.cliType;
      const flags: SessionFlags | undefined = t.lastSessionId && t.lastSessionId.length > 0
        ? { resumeSessionAt: t.lastSessionId }
        : undefined;

      if (kind === "headless" && (cliType === "claude-code" || cliType === "codex")) {
        const tabId = `headless-${crypto.randomUUID()}`;
        return spawnHeadless({
          tabId,
          cliType,
          mode: t.cliConfig.mode,
          cwd,
          model: t.cliConfig.model,
          ...(t.lastSessionId && t.lastSessionId.length > 0
            ? { resumeSessionAt: t.lastSessionId }
            : {}),
        });
      }
      return spawnPty(t.cliConfig, undefined, undefined, flags);
    }),
  );

  const newIds: string[] = [];
  const tabMap: Record<string, Tab> = {};

  spawnResults.forEach((result, i) => {
    if (result.status === "fulfilled") {
      const id = result.value;
      const saved = validatedTabs[i];
      newIds.push(id);
      tabMap[id] = {
        id,
        title: saved.title,
        status: "idle",
        cliConfig: { ...saved.cliConfig },
        lastSessionId: saved.lastSessionId,
        worktree: saved.worktree,
        // Propagate `paneKind` only for non-PTY panes so legacy round-trip
        // stays bit-identical for shell + PTY claude/codex tabs.
        ...(saved.paneKind === "headless" ? { paneKind: "headless" as const } : {}),
      };
    } else {
      newIds.push(""); // placeholder for failed spawns
    }
  });

  if (Object.keys(tabMap).length === 0) return null;

  const focusedGroupId = { value: null as string | null };
  const layout = buildLayout(session.layout, newIds, focusedGroupId);

  // If no group was marked focused, use the first pane group
  if (!focusedGroupId.value) {
    const first = findFirstPaneGroup(layout);
    if (first) focusedGroupId.value = first.id;
  }

  return {
    tabMap,
    layout,
    focusedGroupId: focusedGroupId.value ?? "",
    workingDir: session.workingDir,
    sidebarOpen: session.sidebarOpen,
    sidebarWidth: session.sidebarWidth,
    quickLaunchMode: session.quickLaunchMode,
    reviewCliType: session.reviewCliType ?? "codex",
  };
}

function findFirstPaneGroup(node: LayoutNode): PaneGroupNode | null {
  if (node.type === "pane-group") return node;
  return findFirstPaneGroup(node.children[0]) ?? findFirstPaneGroup(node.children[1]);
}

export async function tryLoadSession(): Promise<SavedSession | null> {
  try {
    const raw = await loadSession();
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SavedSession;
    return parsed.version === SESSION_VERSION ? parsed : null;
  } catch {
    return null;
  }
}
