import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock modules before importing the hook
const mockSpawnPty = vi.fn();
const mockSendMessage = vi.fn();
const mockGitChangedFiles = vi.fn();
const mockOpenTab = vi.fn();
const mockSetActiveTab = vi.fn();
const mockUpdateStatus = vi.fn();

vi.mock("../lib/commands", () => ({
  spawnPty: (...args: unknown[]) => mockSpawnPty(...args),
  sendMessage: (...args: unknown[]) => mockSendMessage(...args),
  gitChangedFiles: (...args: unknown[]) => mockGitChangedFiles(...args),
}));

vi.mock("../stores/tab-store", () => ({
  useTabStore: () => ({
    canOpenTab: true,
    tabs: [],
    openTab: mockOpenTab,
    setActiveTab: mockSetActiveTab,
    updateStatus: mockUpdateStatus,
  }),
}));

// SolidJS createSignal mock — minimal reactive primitive for tests
vi.mock("solid-js", () => {
  function createSignal<T>(init: T): [() => T, (v: T) => void] {
    let value = init;
    return [() => value, (v: T) => { value = v; }];
  }
  return { createSignal };
});

import { useCodexReview } from "./use-codex-review";
import type { Tab } from "../types";

function makeTab(overrides?: Partial<Tab>): Tab {
  return {
    id: "tab-1",
    title: "Claude 1",
    status: "waiting",
    cliConfig: { cliType: "claude-code", mode: "default", workingDir: "/test/project" },
    ...overrides,
  };
}

describe("useCodexReview", () => {
  let messages: string[];
  let addMessage: (t: string) => void;

  beforeEach(() => {
    vi.clearAllMocks();
    messages = [];
    addMessage = (t: string) => messages.push(t);
  });

  it("shows message when no changed files detected", async () => {
    mockGitChangedFiles.mockResolvedValue([]);
    const { requestReview } = useCodexReview({ tab: makeTab(), addMessage });

    await requestReview();

    expect(mockGitChangedFiles).toHaveBeenCalledWith("/test/project");
    expect(messages).toEqual(["[No changed files detected.]"]);
    expect(mockSpawnPty).not.toHaveBeenCalled();
  });

  it("spawns Codex tab and sends review prompt on success", async () => {
    mockGitChangedFiles.mockResolvedValue(["src/app.ts", "src/lib.ts"]);
    mockSpawnPty.mockResolvedValue("codex-pty-1");
    mockSendMessage.mockResolvedValue(undefined);

    const { requestReview } = useCodexReview({ tab: makeTab(), addMessage });
    await requestReview();

    expect(mockSpawnPty).toHaveBeenCalledWith({
      cliType: "codex",
      mode: "default",
      workingDir: "/test/project",
    });
    expect(mockSendMessage).toHaveBeenCalledWith(
      "codex-pty-1",
      expect.stringContaining("`src/app.ts`"),
    );
    expect(mockSetActiveTab).toHaveBeenCalledWith("codex-pty-1");
  });

  it("retries sendMessage when Codex CLI is not ready", async () => {
    mockGitChangedFiles.mockResolvedValue(["file.ts"]);
    mockSpawnPty.mockResolvedValue("codex-pty-2");
    mockSendMessage
      .mockRejectedValueOnce(new Error("not ready"))
      .mockRejectedValueOnce(new Error("not ready"))
      .mockResolvedValue(undefined);

    const { requestReview } = useCodexReview({ tab: makeTab(), addMessage });
    await requestReview();

    expect(mockSendMessage).toHaveBeenCalledTimes(3);
    expect(mockSetActiveTab).toHaveBeenCalledWith("codex-pty-2");
    expect(messages).toEqual([]);
  });

  it("reports error after all retries fail", async () => {
    mockGitChangedFiles.mockResolvedValue(["file.ts"]);
    mockSpawnPty.mockResolvedValue("codex-pty-3");
    mockSendMessage.mockRejectedValue(new Error("always fails"));

    const { requestReview } = useCodexReview({ tab: makeTab(), addMessage });
    await requestReview();

    expect(mockSendMessage).toHaveBeenCalledTimes(5);
    expect(messages[0]).toContain("always fails");
  });

  it("prevents double invocation via isReviewInProgress guard", async () => {
    let resolveGit: (v: string[]) => void;
    mockGitChangedFiles.mockImplementation(
      () => new Promise<string[]>((r) => { resolveGit = r; }),
    );

    const { requestReview, isReviewInProgress } = useCodexReview({ tab: makeTab(), addMessage });

    const p1 = requestReview();
    expect(isReviewInProgress()).toBe(true);

    // Second call should be no-op
    const p2 = requestReview();
    expect(mockGitChangedFiles).toHaveBeenCalledTimes(1);

    resolveGit!([]); // resolve to let p1 complete
    await p1;
    await p2;
    expect(isReviewInProgress()).toBe(false);
  });

  it("reports error when gitChangedFiles fails", async () => {
    mockGitChangedFiles.mockRejectedValue(new Error("not a git repo"));
    const { requestReview } = useCodexReview({ tab: makeTab(), addMessage });

    await requestReview();

    expect(messages[0]).toContain("not a git repo");
    expect(mockSpawnPty).not.toHaveBeenCalled();
  });

  it("reports error when spawnPty fails", async () => {
    mockGitChangedFiles.mockResolvedValue(["file.ts"]);
    mockSpawnPty.mockRejectedValue(new Error("codex not found"));

    const { requestReview } = useCodexReview({ tab: makeTab(), addMessage });
    await requestReview();

    expect(messages[0]).toContain("codex not found");
  });
});
