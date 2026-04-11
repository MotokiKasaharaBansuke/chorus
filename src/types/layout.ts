export type SplitDirection = "horizontal" | "vertical";

export interface SplitNode {
  type: "split";
  id: string;
  direction: SplitDirection;
  children: [LayoutNode, LayoutNode];
  ratio: number; // 0-1, proportion of first child
}

export interface PaneGroupNode {
  type: "pane-group";
  id: string;
  tabIds: string[];
  activeTabId: string | null;
}

export type LayoutNode = SplitNode | PaneGroupNode;
