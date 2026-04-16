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
  countLeafPanes,
} from "./layout-tree";
import type { PaneGroupNode, SplitNode } from "../../types";

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

describe("removeTabFromTree — proxy safety", () => {
  it("returns a new object for unchanged pane-groups (never the input reference)", () => {
    const a = createPaneGroup(["t1"]);
    const b = createPaneGroup(["t2"]);
    const split: SplitNode = { type: "split", id: "s1", direction: "horizontal", children: [a, b], ratio: 0.5 };
    const result = removeTabFromTree(split, "t1") as PaneGroupNode;
    expect(result).not.toBe(b);
    expect(result).toEqual(b);
  });

  it("returns new objects for all surviving nodes in a deep tree", () => {
    const a = createPaneGroup(["t1"]);
    const b = createPaneGroup(["t2"]);
    const c = createPaneGroup(["t3"]);
    const inner: SplitNode = { type: "split", id: "s2", direction: "horizontal", children: [b, c], ratio: 0.5 };
    const outer: SplitNode = { type: "split", id: "s1", direction: "horizontal", children: [a, inner], ratio: 0.5 };
    const result = removeTabFromTree(outer, "t2") as SplitNode;
    expect(result.children[0]).not.toBe(a);
    expect(result.children[1]).not.toBe(c);
    expect((result.children[0] as PaneGroupNode).tabIds).toEqual(["t1"]);
    expect((result.children[1] as PaneGroupNode).tabIds).toEqual(["t3"]);
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

  it("returns the group unchanged when it has only the tab being split", () => {
    const g = createPaneGroup(["t1"]);
    const result = splitPaneGroup(g, g.id, "horizontal", "t1", "after");
    expect(result.type).toBe("pane-group");
    expect((result as PaneGroupNode).tabIds).toEqual(["t1"]);
    expect(result).not.toBe(g);
  });

  it("splits normally when tabId does not exist in the group", () => {
    const g = createPaneGroup(["t1", "t2"]);
    const result = splitPaneGroup(g, g.id, "horizontal", "nonexistent", "after") as SplitNode;
    expect(result.type).toBe("split");
    expect((result.children[0] as PaneGroupNode).tabIds).toEqual(["t1", "t2"]);
    expect((result.children[1] as PaneGroupNode).tabIds).toEqual(["nonexistent"]);
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

describe("setActiveTab — proxy safety", () => {
  it("returns new objects for non-target groups", () => {
    const a = createPaneGroup(["t1", "t2"]);
    const b = createPaneGroup(["t3"]);
    const split: SplitNode = { type: "split", id: "s1", direction: "horizontal", children: [a, b], ratio: 0.5 };
    const result = setActiveTab(split, a.id, "t2") as SplitNode;
    expect(result.children[1]).not.toBe(b);
    expect((result.children[1] as PaneGroupNode).tabIds).toEqual(["t3"]);
  });
});

describe("equalizeSplits — proxy safety", () => {
  it("returns new objects for all leaf groups", () => {
    const a = createPaneGroup(["t1"]);
    const b = createPaneGroup(["t2"]);
    const split: SplitNode = { type: "split", id: "s1", direction: "horizontal", children: [a, b], ratio: 0.7 };
    const result = equalizeSplits(split) as SplitNode;
    expect(result.children[0]).not.toBe(a);
    expect(result.children[1]).not.toBe(b);
  });
});

describe("splitPaneGroup — proxy safety", () => {
  it("returns new objects for non-target groups in a split tree", () => {
    const a = createPaneGroup(["t1", "t2"]);
    const b = createPaneGroup(["t3"]);
    const split: SplitNode = { type: "split", id: "s1", direction: "horizontal", children: [a, b], ratio: 0.5 };
    const result = splitPaneGroup(split, a.id, "horizontal", "t2") as SplitNode;
    const innerSplit = result.children[0] as SplitNode;
    expect(innerSplit.type).toBe("split");
    expect(result.children[1]).not.toBe(b);
    expect((result.children[1] as PaneGroupNode).tabIds).toEqual(["t3"]);
  });
});

describe("removeTabFromTree — edge case", () => {
  it("returns structurally equal but referentially distinct tree for nonexistent tab", () => {
    const a = createPaneGroup(["t1"]);
    const b = createPaneGroup(["t2"]);
    const split: SplitNode = { type: "split", id: "s1", direction: "horizontal", children: [a, b], ratio: 0.5 };
    const result = removeTabFromTree(split, "nonexistent") as SplitNode;
    expect(result).not.toBe(split);
    expect(result.children[0]).not.toBe(a);
    expect(result.children[1]).not.toBe(b);
    expect((result.children[0] as PaneGroupNode).tabIds).toEqual(["t1"]);
    expect((result.children[1] as PaneGroupNode).tabIds).toEqual(["t2"]);
  });
});

describe("addTabToPaneGroup — proxy safety", () => {
  it("returns new objects for non-target groups", () => {
    const a = createPaneGroup(["t1"]);
    const b = createPaneGroup(["t2"]);
    const split: SplitNode = { type: "split", id: "s1", direction: "horizontal", children: [a, b], ratio: 0.5 };
    const result = addTabToPaneGroup(split, a.id, "t3") as SplitNode;
    expect(result.children[1]).not.toBe(b);
    expect((result.children[1] as PaneGroupNode).tabIds).toEqual(["t2"]);
  });
});

describe("updateSplitRatio — proxy safety", () => {
  it("returns new objects for leaf pane-groups", () => {
    const a = createPaneGroup(["t1"]);
    const b = createPaneGroup(["t2"]);
    const split: SplitNode = { type: "split", id: "s1", direction: "horizontal", children: [a, b], ratio: 0.5 };
    const result = updateSplitRatio(split, "s1", 0.3) as SplitNode;
    expect(result.children[0]).not.toBe(a);
    expect(result.children[1]).not.toBe(b);
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

describe("countLeafPanes", () => {
  it("returns 1 for a single pane group", () => {
    const g = createPaneGroup(["t1"]);
    expect(countLeafPanes(g, "horizontal")).toBe(1);
    expect(countLeafPanes(g, "vertical")).toBe(1);
  });

  it("sums children when split direction matches query direction", () => {
    const a = createPaneGroup(["t1"]);
    const b = createPaneGroup(["t2"]);
    const split: SplitNode = { type: "split", id: "s1", direction: "horizontal", children: [a, b], ratio: 0.5 };
    expect(countLeafPanes(split, "horizontal")).toBe(2);
  });

  it("takes max when split direction differs from query direction", () => {
    const a = createPaneGroup(["t1"]);
    const b = createPaneGroup(["t2"]);
    const split: SplitNode = { type: "split", id: "s1", direction: "horizontal", children: [a, b], ratio: 0.5 };
    expect(countLeafPanes(split, "vertical")).toBe(1);
  });

  it("counts correctly in a mixed-direction tree", () => {
    // Layout: (a | b) / c  (horizontal split inside vertical split)
    // Horizontal leaf count: top row has 2 (a|b), bottom has 1 (c) → max(2, 1) = 2
    // Vertical leaf count: top has 1 (max of a,b), bottom has 1 → 1 + 1 = 2
    const a = createPaneGroup(["t1"]);
    const b = createPaneGroup(["t2"]);
    const c = createPaneGroup(["t3"]);
    const hSplit: SplitNode = { type: "split", id: "s1", direction: "horizontal", children: [a, b], ratio: 0.5 };
    const vSplit: SplitNode = { type: "split", id: "s2", direction: "vertical", children: [hSplit, c], ratio: 0.5 };
    expect(countLeafPanes(vSplit, "horizontal")).toBe(2);
    expect(countLeafPanes(vSplit, "vertical")).toBe(2);
  });

  it("counts deeply nested same-direction splits", () => {
    // a | b | c (chained horizontal splits)
    const a = createPaneGroup(["t1"]);
    const b = createPaneGroup(["t2"]);
    const c = createPaneGroup(["t3"]);
    const inner: SplitNode = { type: "split", id: "s2", direction: "horizontal", children: [b, c], ratio: 0.5 };
    const outer: SplitNode = { type: "split", id: "s1", direction: "horizontal", children: [a, inner], ratio: 0.5 };
    expect(countLeafPanes(outer, "horizontal")).toBe(3);
    expect(countLeafPanes(outer, "vertical")).toBe(1);
  });

  it("handles 4-pane grid (2x2)", () => {
    // (a | b) / (c | d)
    const a = createPaneGroup(["t1"]);
    const b = createPaneGroup(["t2"]);
    const c = createPaneGroup(["t3"]);
    const d = createPaneGroup(["t4"]);
    const top: SplitNode = { type: "split", id: "s1", direction: "horizontal", children: [a, b], ratio: 0.5 };
    const bottom: SplitNode = { type: "split", id: "s2", direction: "horizontal", children: [c, d], ratio: 0.5 };
    const root: SplitNode = { type: "split", id: "s3", direction: "vertical", children: [top, bottom], ratio: 0.5 };
    expect(countLeafPanes(root, "horizontal")).toBe(2);
    expect(countLeafPanes(root, "vertical")).toBe(2);
  });
});
