import { describe, it, expect } from "vitest";
import {
  createPaneGroup,
  findPaneGroup,
  findPaneGroupContainingTab,
  findFirstPaneGroup,
  getAllPaneGroups,
  addTabToPaneGroup,
  removeTabFromTree,
  splitPaneGroup,
  setActiveTab,
  updateSplitRatio,
  equalizeSplits,
} from "./layout-tree";
import type { LayoutNode, PaneGroupNode, SplitNode } from "../../types";

describe("createPaneGroup", () => {
  it("creates a group with given tabs", () => {
    const g = createPaneGroup(["t1", "t2"], "t1");
    expect(g.type).toBe("pane-group");
    expect(g.tabIds).toEqual(["t1", "t2"]);
    expect(g.activeTabId).toBe("t1");
  });

  it("defaults activeTabId to first tab", () => {
    const g = createPaneGroup(["t1"]);
    expect(g.activeTabId).toBe("t1");
  });

  it("handles empty tabs", () => {
    const g = createPaneGroup([]);
    expect(g.tabIds).toEqual([]);
    expect(g.activeTabId).toBeNull();
  });
});

describe("findPaneGroup", () => {
  it("finds a top-level group", () => {
    const g = createPaneGroup(["t1"]);
    expect(findPaneGroup(g, g.id)).toBe(g);
  });

  it("returns null for non-existent id", () => {
    const g = createPaneGroup(["t1"]);
    expect(findPaneGroup(g, "nonexistent")).toBeNull();
  });

  it("finds nested group in split", () => {
    const left = createPaneGroup(["t1"]);
    const right = createPaneGroup(["t2"]);
    const split: SplitNode = { type: "split", id: "s1", direction: "horizontal", children: [left, right], ratio: 0.5 };
    expect(findPaneGroup(split, right.id)).toBe(right);
  });
});

describe("findPaneGroupContainingTab", () => {
  it("finds group containing the tab", () => {
    const g = createPaneGroup(["t1", "t2"]);
    expect(findPaneGroupContainingTab(g, "t2")?.id).toBe(g.id);
  });

  it("returns null for non-existent tab", () => {
    const g = createPaneGroup(["t1"]);
    expect(findPaneGroupContainingTab(g, "nonexistent")).toBeNull();
  });
});

describe("addTabToPaneGroup", () => {
  it("adds tab to the target group", () => {
    const g = createPaneGroup(["t1"]);
    const result = addTabToPaneGroup(g, g.id, "t2") as PaneGroupNode;
    expect(result.tabIds).toEqual(["t1", "t2"]);
    expect(result.activeTabId).toBe("t2");
  });

  it("does not modify non-target group", () => {
    const g = createPaneGroup(["t1"]);
    const result = addTabToPaneGroup(g, "other-id", "t2");
    expect((result as PaneGroupNode).tabIds).toEqual(["t1"]);
  });
});

describe("removeTabFromTree", () => {
  it("removes tab from group", () => {
    const g = createPaneGroup(["t1", "t2"]);
    const result = removeTabFromTree(g, "t1") as PaneGroupNode;
    expect(result.tabIds).toEqual(["t2"]);
  });

  it("returns null when last tab removed", () => {
    const g = createPaneGroup(["t1"]);
    expect(removeTabFromTree(g, "t1")).toBeNull();
  });

  it("collapses split when one child becomes empty", () => {
    const left = createPaneGroup(["t1"]);
    const right = createPaneGroup(["t2"]);
    const split: SplitNode = { type: "split", id: "s1", direction: "horizontal", children: [left, right], ratio: 0.5 };
    const result = removeTabFromTree(split, "t1");
    expect(result?.type).toBe("pane-group");
    expect((result as PaneGroupNode).tabIds).toEqual(["t2"]);
  });

  it("updates activeTabId when active tab removed", () => {
    const g = createPaneGroup(["t1", "t2", "t3"]);
    (g as PaneGroupNode).activeTabId = "t2";
    const result = removeTabFromTree(g, "t2") as PaneGroupNode;
    expect(result.tabIds).toEqual(["t1", "t3"]);
    // activeTabId should switch to a remaining tab
    expect(result.tabIds).toContain(result.activeTabId);
  });
});

describe("splitPaneGroup", () => {
  it("splits a group into two", () => {
    const g = createPaneGroup(["t1", "t2"]);
    const result = splitPaneGroup(g, g.id, "horizontal", "t2", "after") as SplitNode;
    expect(result.type).toBe("split");
    expect(result.direction).toBe("horizontal");
    expect((result.children[0] as PaneGroupNode).tabIds).toEqual(["t1"]);
    expect((result.children[1] as PaneGroupNode).tabIds).toEqual(["t2"]);
  });

  it("splits before when side is 'before'", () => {
    const g = createPaneGroup(["t1", "t2"]);
    const result = splitPaneGroup(g, g.id, "vertical", "t1", "before") as SplitNode;
    expect(result.direction).toBe("vertical");
    expect((result.children[0] as PaneGroupNode).tabIds).toEqual(["t1"]);
    expect((result.children[1] as PaneGroupNode).tabIds).toEqual(["t2"]);
  });
});

describe("setActiveTab", () => {
  it("sets active tab in target group", () => {
    const g = createPaneGroup(["t1", "t2"]);
    const result = setActiveTab(g, g.id, "t2") as PaneGroupNode;
    expect(result.activeTabId).toBe("t2");
  });
});

describe("updateSplitRatio", () => {
  it("updates ratio of target split", () => {
    const left = createPaneGroup(["t1"]);
    const right = createPaneGroup(["t2"]);
    const split: SplitNode = { type: "split", id: "s1", direction: "horizontal", children: [left, right], ratio: 0.5 };
    const result = updateSplitRatio(split, "s1", 0.3) as SplitNode;
    expect(result.ratio).toBe(0.3);
  });
});

describe("equalizeSplits", () => {
  it("sets ratio to 0.5 for two equal leaves", () => {
    const left = createPaneGroup(["t1"]);
    const right = createPaneGroup(["t2"]);
    const split: SplitNode = { type: "split", id: "s1", direction: "horizontal", children: [left, right], ratio: 0.7 };
    const result = equalizeSplits(split) as SplitNode;
    expect(result.ratio).toBe(0.5);
  });

  it("uses leaf-count-based ratios for unbalanced tree", () => {
    // Tree: a | (b | c) → 1 leaf left, 2 leaves right → ratio = 1/3
    const a = createPaneGroup(["t1"]);
    const b = createPaneGroup(["t2"]);
    const c = createPaneGroup(["t3"]);
    const inner: SplitNode = { type: "split", id: "s2", direction: "horizontal", children: [b, c], ratio: 0.8 };
    const outer: SplitNode = { type: "split", id: "s1", direction: "horizontal", children: [a, inner], ratio: 0.3 };
    const result = equalizeSplits(outer) as SplitNode;
    expect(result.ratio).toBeCloseTo(1 / 3);
    expect((result.children[1] as SplitNode).ratio).toBe(0.5);
  });

  it("produces equal widths for 4 panes", () => {
    // a | (b | (c | d)) → ratios: 0.25, 0.333, 0.5
    const a = createPaneGroup(["t1"]);
    const b = createPaneGroup(["t2"]);
    const c = createPaneGroup(["t3"]);
    const d = createPaneGroup(["t4"]);
    const inner2: SplitNode = { type: "split", id: "s3", direction: "horizontal", children: [c, d], ratio: 0.7 };
    const inner1: SplitNode = { type: "split", id: "s2", direction: "horizontal", children: [b, inner2], ratio: 0.6 };
    const outer: SplitNode = { type: "split", id: "s1", direction: "horizontal", children: [a, inner1], ratio: 0.8 };
    const result = equalizeSplits(outer) as SplitNode;
    expect(result.ratio).toBeCloseTo(0.25);
    expect((result.children[1] as SplitNode).ratio).toBeCloseTo(1 / 3);
    expect(((result.children[1] as SplitNode).children[1] as SplitNode).ratio).toBe(0.5);
  });
});

describe("getAllPaneGroups", () => {
  it("returns single group", () => {
    const g = createPaneGroup(["t1"]);
    expect(getAllPaneGroups(g)).toHaveLength(1);
  });

  it("returns all groups from nested tree", () => {
    const a = createPaneGroup(["t1"]);
    const b = createPaneGroup(["t2"]);
    const c = createPaneGroup(["t3"]);
    const inner: SplitNode = { type: "split", id: "s2", direction: "horizontal", children: [b, c], ratio: 0.5 };
    const outer: SplitNode = { type: "split", id: "s1", direction: "horizontal", children: [a, inner], ratio: 0.5 };
    expect(getAllPaneGroups(outer)).toHaveLength(3);
  });
});

describe("findFirstPaneGroup", () => {
  it("returns the leftmost group", () => {
    const a = createPaneGroup(["t1"]);
    const b = createPaneGroup(["t2"]);
    const split: SplitNode = { type: "split", id: "s1", direction: "horizontal", children: [a, b], ratio: 0.5 };
    expect(findFirstPaneGroup(split).id).toBe(a.id);
  });
});
