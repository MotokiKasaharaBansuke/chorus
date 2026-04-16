import type { LayoutNode, PaneGroupNode, SplitNode, SplitDirection } from "../../types";

export const MIN_PANE_PX = 160;

export function generateId(prefix = "pg"): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

export function createPaneGroup(tabIds: string[] = [], activeTabId?: string): PaneGroupNode {
  return {
    type: "pane-group",
    id: generateId("pg"),
    tabIds,
    activeTabId: activeTabId ?? tabIds[0] ?? null,
  };
}

// ── Helpers: reduce duplicated recursion patterns ──

/** Shallow-clone a PaneGroupNode so that SolidJS store setter-proxies
 *  never leak into the raw store state via `produce`. */
function clonePaneGroup(group: PaneGroupNode): PaneGroupNode {
  return { type: "pane-group", id: group.id, tabIds: [...group.tabIds], activeTabId: group.activeTabId };
}

/** Apply a transform to the PaneGroup matching groupId, recurse through splits. */
function mapPaneGroup(
  root: LayoutNode,
  groupId: string,
  transform: (group: PaneGroupNode) => LayoutNode,
): LayoutNode {
  if (root.type === "pane-group") {
    return root.id === groupId ? transform(root) : clonePaneGroup(root);
  }
  return mapSplitChildren(root, (child) => mapPaneGroup(child, groupId, transform));
}

/** Rebuild a SplitNode with a mapper applied to both children. */
function mapSplitChildren(
  split: SplitNode,
  mapper: (child: LayoutNode) => LayoutNode,
): SplitNode {
  return {
    type: "split",
    id: split.id,
    direction: split.direction,
    ratio: split.ratio,
    children: [mapper(split.children[0]), mapper(split.children[1])],
  };
}

// ── Finders ──

export function findPaneGroup(root: LayoutNode, groupId: string): PaneGroupNode | null {
  if (root.type === "pane-group") {
    return root.id === groupId ? root : null;
  }
  return findPaneGroup(root.children[0], groupId) ?? findPaneGroup(root.children[1], groupId);
}

export function findPaneGroupContainingTab(root: LayoutNode, tabId: string): PaneGroupNode | null {
  if (root.type === "pane-group") {
    return root.tabIds.includes(tabId) ? root : null;
  }
  return findPaneGroupContainingTab(root.children[0], tabId)
    ?? findPaneGroupContainingTab(root.children[1], tabId);
}

export function findFirstPaneGroup(root: LayoutNode): PaneGroupNode {
  if (root.type === "pane-group") return root;
  return findFirstPaneGroup(root.children[0]);
}

export function getAllPaneGroups(root: LayoutNode): PaneGroupNode[] {
  if (root.type === "pane-group") return [root];
  return [
    ...getAllPaneGroups(root.children[0]),
    ...getAllPaneGroups(root.children[1]),
  ];
}

// ── Mutations (immutable) ──

/** Add a tab to a pane group. Returns a new tree. */
export function addTabToPaneGroup(root: LayoutNode, groupId: string, tabId: string): LayoutNode {
  return mapPaneGroup(root, groupId, (group) => ({
    type: "pane-group" as const, id: group.id,
    tabIds: [...group.tabIds, tabId],
    activeTabId: tabId,
  }));
}

/** Update the active tab within a pane group. */
export function setActiveTab(root: LayoutNode, groupId: string, tabId: string): LayoutNode {
  return mapPaneGroup(root, groupId, (group) => ({
    type: "pane-group" as const, id: group.id,
    tabIds: [...group.tabIds],
    activeTabId: tabId,
  }));
}

/** Remove a tab from its pane group. If the group becomes empty, collapse the tree. */
export function removeTabFromTree(root: LayoutNode, tabId: string): LayoutNode | null {
  if (root.type === "pane-group") {
    if (!root.tabIds.includes(tabId)) return clonePaneGroup(root);
    const newTabIds = root.tabIds.filter(id => id !== tabId);
    if (newTabIds.length === 0) return null;
    const newActive = root.activeTabId === tabId
      ? newTabIds[Math.min(root.tabIds.indexOf(tabId), newTabIds.length - 1)]
      : root.activeTabId;
    return { type: "pane-group", id: root.id, tabIds: newTabIds, activeTabId: newActive ?? null };
  }

  const left = removeTabFromTree(root.children[0], tabId);
  const right = removeTabFromTree(root.children[1], tabId);

  if (!left) return right;
  if (!right) return left;

  return {
    type: "split", id: root.id, direction: root.direction, ratio: root.ratio,
    children: [left, right],
  };
}

/** Split a pane group: insert a new SplitNode with the tab moved to a new PaneGroup. */
export function splitPaneGroup(
  root: LayoutNode,
  groupId: string,
  direction: SplitDirection,
  tabId: string,
  side: "before" | "after" = "after",
): LayoutNode {
  return mapPaneGroup(root, groupId, (group) => {
    const originalTabIds = group.tabIds.filter(id => id !== tabId);
    if (originalTabIds.length === 0) return clonePaneGroup(group);

    const originalActive = group.activeTabId === tabId
      ? (originalTabIds[0] ?? null)
      : group.activeTabId;
    const originalGroup: PaneGroupNode = {
      type: "pane-group", id: group.id, tabIds: originalTabIds, activeTabId: originalActive,
    };

    const newGroup = createPaneGroup([tabId], tabId);
    const children: [LayoutNode, LayoutNode] = side === "before"
      ? [newGroup, originalGroup]
      : [originalGroup, newGroup];

    return { type: "split", id: generateId("sp"), direction, children, ratio: 0.5 };
  });
}

/** Update split ratio */
export function updateSplitRatio(root: LayoutNode, splitId: string, ratio: number): LayoutNode {
  if (root.type === "pane-group") return clonePaneGroup(root);
  const updated = root.id === splitId ? { ...root, ratio } : root;
  return mapSplitChildren(updated, (child) => updateSplitRatio(child, splitId, ratio));
}

// ── Equalize ──

/** Count leaf panes along a specific axis.
 *  Splits matching the direction sum their children; cross-axis splits take the max. */
export function countLeafPanes(root: LayoutNode, direction: SplitDirection): number {
  if (root.type === "pane-group") return 1;
  const a = countLeafPanes(root.children[0], direction);
  const b = countLeafPanes(root.children[1], direction);
  return root.direction === direction ? a + b : Math.max(a, b);
}

/** Count leaf nodes (pane groups) in a subtree */
export function countLeaves(root: LayoutNode): number {
  if (root.type === "pane-group") return 1;
  return countLeaves(root.children[0]) + countLeaves(root.children[1]);
}

/** Equalize sizes: set each split ratio to leftLeaves/totalLeaves */
export function equalizeSplits(root: LayoutNode): LayoutNode {
  if (root.type === "pane-group") return clonePaneGroup(root);
  const leftLeaves = countLeaves(root.children[0]);
  const totalLeaves = leftLeaves + countLeaves(root.children[1]);
  return {
    type: "split",
    id: root.id,
    direction: root.direction,
    ratio: leftLeaves / totalLeaves,
    children: [
      equalizeSplits(root.children[0]),
      equalizeSplits(root.children[1]),
    ],
  };
}
