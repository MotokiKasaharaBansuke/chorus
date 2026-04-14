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

/** Which window edges this node touches (used for traffic-light / action-button placement). */
export interface LayoutEdges {
  top: boolean;
  right: boolean;
  left: boolean;
  bottom: boolean;
}

export const ALL_EDGES: LayoutEdges = { top: true, right: true, left: true, bottom: true };
