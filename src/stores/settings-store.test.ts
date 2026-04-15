import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const loadSettingsMock = vi.fn();
const saveSettingsMock = vi.fn();

vi.mock("../lib/commands", () => ({
  loadSettings: (...args: unknown[]) => loadSettingsMock(...args),
  saveSettings: (...args: unknown[]) => saveSettingsMock(...args),
}));

import { useSettingsStore } from "./settings-store";
import { DEFAULT_SETTINGS } from "../types/settings";

describe("useSettingsStore", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    loadSettingsMock.mockReset();
    saveSettingsMock.mockReset();
    saveSettingsMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("initialize() populates state from loadSettings", async () => {
    loadSettingsMock.mockResolvedValue({
      reviewCliType: "claudeCode",
      worktree: { ...DEFAULT_SETTINGS.worktree, autoCreate: true, warnThreshold: 42 },
    });

    const store = useSettingsStore();
    await store.initialize();

    expect(store.reviewCliType).toBe("claudeCode");
    expect(store.worktree.autoCreate).toBe(true);
    expect(store.worktree.warnThreshold).toBe(42);
    expect(store.loaded).toBe(true);
  });

  it("setReviewCliType schedules a debounced saveSettings", async () => {
    loadSettingsMock.mockResolvedValue(DEFAULT_SETTINGS);
    const store = useSettingsStore();
    await store.initialize();
    saveSettingsMock.mockClear();

    store.setReviewCliType("codex");
    expect(saveSettingsMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(260);
    expect(saveSettingsMock).toHaveBeenCalledTimes(1);
    expect(saveSettingsMock.mock.calls[0][0]).toMatchObject({ reviewCliType: "codex" });
  });

  it("patchWorktree merges fields and persists", async () => {
    loadSettingsMock.mockResolvedValue(DEFAULT_SETTINGS);
    const store = useSettingsStore();
    await store.initialize();
    saveSettingsMock.mockClear();

    store.patchWorktree({ autoCreate: true, warnThreshold: 5 });
    expect(store.worktree.autoCreate).toBe(true);
    expect(store.worktree.warnThreshold).toBe(5);
    expect(store.worktree.basePath).toBe(DEFAULT_SETTINGS.worktree.basePath);

    await vi.advanceTimersByTimeAsync(260);
    expect(saveSettingsMock).toHaveBeenCalled();
  });

  it("falls back to defaults when loadSettings rejects", async () => {
    loadSettingsMock.mockRejectedValue(new Error("boom"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const store = useSettingsStore();

    await store.initialize();

    expect(store.loaded).toBe(true);
    expect(store.worktree).toEqual(DEFAULT_SETTINGS.worktree);
    errorSpy.mockRestore();
  });
});
