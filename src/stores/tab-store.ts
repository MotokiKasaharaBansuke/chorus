import { batch } from "solid-js";
import { createStore, produce, reconcile } from "solid-js/store";
import type { Tab, TabStatus, CliMode, LayoutNode, SplitDirection } from "../types";
import {
  createPaneGroup,
  findPaneGroup,
  findPaneGroupContainingTab,
  findFirstPaneGroup,
  getAllPaneGroups,
  addTabToPaneGroup,
  removeTabFromTree,
  equalizeSplits,
  splitPaneGroup,
  setActiveTab,
  updateSplitRatio,
} from "../lib/layout/layout-tree";

const MAX_TABS = 20;

interface WorkspaceState {
  tabMap: Record<string, Tab>;
  layout: LayoutNode | null;
  focusedGroupId: string | null;
}

const [store, setStore] = createStore<WorkspaceState>({
  tabMap: {},
  layout: null,
  focusedGroupId: null,
});

/** Shared helper: mutate a tab by id via produce */
function updateTab(id: string, updater: (tab: Tab) => void) {
  setStore(produce(s => {
    const tab = s.tabMap[id];
    if (tab) updater(tab);
  }));
}

export function useTabStore() {
  return {
    // --- Accessors ---
    get layout() { return store.layout; },
    get focusedGroupId() { return store.focusedGroupId; },

    /** Flat list of all tabs (backward compat) */
    get tabs(): Tab[] {
      return Object.values(store.tabMap);
    },

    /** Active tab ID = active tab of the focused pane group */
    get activeTabId(): string | null {
      if (!store.layout || !store.focusedGroupId) return null;
      const group = findPaneGroup(store.layout, store.focusedGroupId);
      return group?.activeTabId ?? null;
    },

    get activeTab(): Tab | null {
      const id = this.activeTabId;
      return id ? (store.tabMap[id] ?? null) : null;
    },

    get canOpenTab() { return Object.keys(store.tabMap).length < MAX_TABS; },

    getTab(id: string): Tab | undefined {
      return store.tabMap[id];
    },

    // --- Mutations ---

    /** Open a tab in a specific group, or the focused group, or create the first group. */
    openTab(tab: Tab, targetGroupId?: string) {
      if (Object.keys(store.tabMap).length >= MAX_TABS) return;

      setStore(produce(s => {
        s.tabMap[tab.id] = tab;

        if (!s.layout) {
          // First tab: create the first pane group
          const group = createPaneGroup([tab.id], tab.id);
          s.layout = group;
          s.focusedGroupId = group.id;
          return;
        }

        const groupId = targetGroupId ?? s.focusedGroupId;
        if (!groupId) return;

        s.layout = addTabToPaneGroup(s.layout, groupId, tab.id);
        s.focusedGroupId = groupId;
      }));
    },

    closeTab(id: string) {
      setStore(produce(s => {
        delete s.tabMap[id];
        if (!s.layout) return;

        const newLayout = removeTabFromTree(s.layout, id);
        s.layout = newLayout;

        // Update focused group if it was removed
        if (newLayout && s.focusedGroupId) {
          const group = findPaneGroup(newLayout, s.focusedGroupId);
          if (!group) {
            s.focusedGroupId = findFirstPaneGroup(newLayout).id;
          }
        } else if (!newLayout) {
          s.focusedGroupId = null;
        }
      }));
    },

    setFocusedGroup(groupId: string) {
      setStore("focusedGroupId", groupId);
    },

    /** Set active tab within a pane group (also focuses that group) */
    setActiveTab(tabId: string) {
      setStore(produce(s => {
        if (!s.layout) return;
        const group = findPaneGroupContainingTab(s.layout, tabId);
        if (!group) return;
        s.layout = setActiveTab(s.layout, group.id, tabId);
        s.focusedGroupId = group.id;
      }));
    },

    /** Set active tab within a specific group */
    setActiveTabInGroup(groupId: string, tabId: string) {
      setStore(produce(s => {
        if (!s.layout) return;
        s.layout = setActiveTab(s.layout, groupId, tabId);
        s.focusedGroupId = groupId;
      }));
    },

    /** Move a tab from its current group to a target group */
    moveTabToGroup(tabId: string, targetGroupId: string) {
      setStore(produce(s => {
        if (!s.layout) return;
        const sourceGroup = findPaneGroupContainingTab(s.layout, tabId);
        if (!sourceGroup || sourceGroup.id === targetGroupId) return;

        // Remove from source
        let tree: LayoutNode | null = removeTabFromTree(s.layout, tabId);
        if (!tree) {
          // Source was the only tab, tree collapsed. Create target as root.
          const newGroup = createPaneGroup([tabId], tabId);
          s.layout = newGroup;
          s.focusedGroupId = newGroup.id;
          return;
        }

        // Add to target
        s.layout = addTabToPaneGroup(tree, targetGroupId, tabId);
        s.focusedGroupId = targetGroupId;
      }));
    },

    /** Split a pane group, moving a tab to the new split */
    splitGroup(groupId: string, direction: SplitDirection, tabId: string, side: "before" | "after" = "after") {
      setStore(produce(s => {
        if (!s.layout) return;
        s.layout = splitPaneGroup(s.layout, groupId, direction, tabId, side);
        // Focus the new group containing the tab
        const newGroup = findPaneGroupContainingTab(s.layout, tabId);
        if (newGroup) s.focusedGroupId = newGroup.id;
      }));
    },

    updateSplitRatio(splitId: string, ratio: number) {
      setStore(produce(s => {
        if (!s.layout) return;
        s.layout = updateSplitRatio(s.layout, splitId, ratio);
      }));
    },

    updateStatus(id: string, status: TabStatus) {
      updateTab(id, (tab) => { tab.status = status; });
    },

    updateTitle(id: string, title: string) {
      updateTab(id, (tab) => { tab.title = title; });
    },

    updateMode(id: string, mode: CliMode) {
      updateTab(id, (tab) => { tab.cliConfig.mode = mode; });
    },

    updateLastSessionId(id: string, sessionId: string) {
      updateTab(id, (tab) => { tab.lastSessionId = sessionId; });
    },

    updateModel(id: string, model: string | undefined) {
      updateTab(id, (tab) => { tab.cliConfig.model = model; });
    },

    /** Get all pane groups (for rendering) */
    getAllGroups(): import("../types").PaneGroupNode[] {
      if (!store.layout) return [];
      return getAllPaneGroups(store.layout);
    },

    /** Equalize all pane sizes (each leaf gets equal width/height) */
    equalize() {
      if (!store.layout) return;
      const equalized = equalizeSplits(JSON.parse(JSON.stringify(store.layout)) as LayoutNode);
      // Force re-render: SolidJS store proxies don't detect deep immutable replacements
      batch(() => {
        setStore("layout", null as unknown as LayoutNode);
        setStore("layout", equalized);
      });
    },

    /** Restore workspace state (used by session restore) */
    restore(tabMap: Record<string, Tab>, layout: LayoutNode, focusedGroupId: string) {
      setStore(reconcile({ tabMap, layout, focusedGroupId }));
    },

    /** Reset store to initial state (for testing) */
    _reset() {
      setStore({ tabMap: {}, layout: null, focusedGroupId: null });
    },
  };
}
