import { describe, it, expect, beforeEach } from "vitest";
import { createRoot } from "solid-js";
import { useTabStore } from "./tab-store";
import type { Tab } from "../types";

function makeTab(id: string, cliType: "claude-code" | "codex" | "shell" = "claude-code"): Tab {
  return {
    id,
    title: `Tab ${id}`,
    status: "running",
    cliConfig: { cliType, mode: "default", workingDir: "/tmp" },
  };
}

describe("useTabStore", () => {
  beforeEach(() => {
    createRoot((dispose) => {
      useTabStore()._reset();
      dispose();
    });
  });

  it("starts with empty state", () => {
    createRoot((dispose) => {
      const store = useTabStore();
      expect(store.tabs).toHaveLength(0);
      expect(store.layout).toBeNull();
      expect(store.activeTabId).toBeNull();
      dispose();
    });
  });

  it("openTab creates layout and adds tab", () => {
    createRoot((dispose) => {
      const store = useTabStore();
      store.openTab(makeTab("t1"));
      expect(store.tabs).toHaveLength(1);
      expect(store.layout).not.toBeNull();
      expect(store.layout?.type).toBe("pane-group");
      expect(store.getTab("t1")).toBeDefined();
      dispose();
    });
  });

  it("openTab adds second tab to same group", () => {
    createRoot((dispose) => {
      const store = useTabStore();
      store.openTab(makeTab("t1"));
      store.openTab(makeTab("t2"));
      expect(store.tabs).toHaveLength(2);
      expect(store.layout?.type).toBe("pane-group");
      if (store.layout?.type === "pane-group") {
        expect(store.layout.tabIds).toContain("t1");
        expect(store.layout.tabIds).toContain("t2");
        expect(store.layout.activeTabId).toBe("t2");
      }
      dispose();
    });
  });

  it("closeTab removes tab and collapses empty group", () => {
    createRoot((dispose) => {
      const store = useTabStore();
      store.openTab(makeTab("t1"));
      store.closeTab("t1");
      expect(store.tabs).toHaveLength(0);
      expect(store.layout).toBeNull();
      dispose();
    });
  });

  it("closeTab keeps remaining tabs", () => {
    createRoot((dispose) => {
      const store = useTabStore();
      store.openTab(makeTab("t1"));
      store.openTab(makeTab("t2"));
      store.closeTab("t1");
      expect(store.tabs).toHaveLength(1);
      expect(store.getTab("t2")).toBeDefined();
      dispose();
    });
  });

  it("setActiveTab updates active tab", () => {
    createRoot((dispose) => {
      const store = useTabStore();
      store.openTab(makeTab("t1"));
      store.openTab(makeTab("t2"));
      store.setActiveTab("t1");
      expect(store.activeTabId).toBe("t1");
      dispose();
    });
  });

  it("splitGroup creates a split node", () => {
    createRoot((dispose) => {
      const store = useTabStore();
      store.openTab(makeTab("t1"));
      store.openTab(makeTab("t2"));
      const groupId = store.focusedGroupId;
      if (groupId) {
        store.splitGroup(groupId, "horizontal", "t2", "after");
        expect(store.layout?.type).toBe("split");
      }
      dispose();
    });
  });

  it("updateStatus changes tab status", () => {
    createRoot((dispose) => {
      const store = useTabStore();
      store.openTab(makeTab("t1"));
      store.updateStatus("t1", "waiting");
      expect(store.getTab("t1")?.status).toBe("waiting");
      dispose();
    });
  });

  it("updateTitle changes tab title", () => {
    createRoot((dispose) => {
      const store = useTabStore();
      store.openTab(makeTab("t1"));
      store.updateTitle("t1", "New Title");
      expect(store.getTab("t1")?.title).toBe("New Title");
      dispose();
    });
  });

  it("updateMode changes tab mode", () => {
    createRoot((dispose) => {
      const store = useTabStore();
      store.openTab(makeTab("t1"));
      store.updateMode("t1", "plan");
      expect(store.getTab("t1")?.cliConfig.mode).toBe("plan");
      dispose();
    });
  });

  it("canOpenTab is true initially", () => {
    createRoot((dispose) => {
      const store = useTabStore();
      expect(store.canOpenTab).toBe(true);
      dispose();
    });
  });

  it("closeTab on non-existent id does nothing", () => {
    createRoot((dispose) => {
      const store = useTabStore();
      store.openTab(makeTab("t1"));
      store.closeTab("nonexistent");
      expect(store.tabs).toHaveLength(1);
      dispose();
    });
  });

  it("updatePtyId sets ptyId on existing tab", () => {
    createRoot((dispose) => {
      const store = useTabStore();
      store.openTab(makeTab("t1"));
      expect(store.getTab("t1")?.ptyId).toBeUndefined();
      store.updatePtyId("t1", "pty-new-123");
      expect(store.getTab("t1")?.ptyId).toBe("pty-new-123");
      dispose();
    });
  });

  it("updatePtyId on non-existent tab does nothing", () => {
    createRoot((dispose) => {
      const store = useTabStore();
      store.updatePtyId("nonexistent", "pty-123");
      expect(store.getTab("nonexistent")).toBeUndefined();
      dispose();
    });
  });

  it("updatePtyId preserves tab identity (id unchanged)", () => {
    createRoot((dispose) => {
      const store = useTabStore();
      store.openTab(makeTab("t1"));
      store.updatePtyId("t1", "pty-new");
      const tab = store.getTab("t1");
      expect(tab?.id).toBe("t1");
      expect(tab?.ptyId).toBe("pty-new");
      // Tab is still accessible by original id
      expect(store.tabs).toHaveLength(1);
      dispose();
    });
  });

});
