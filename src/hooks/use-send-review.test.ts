import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChatMessage, Tab } from "../types";
import { extractLastAssistantText } from "./use-send-review";

const mockSendMessage = vi.fn();
const mockGetTab = vi.fn();
const mockSetActiveTab = vi.fn();
const mockUpdateStatus = vi.fn();

vi.mock("../lib/commands", () => ({
  sendMessage: (...args: unknown[]) => mockSendMessage(...args),
}));

vi.mock("../stores/tab-store", () => ({
  useTabStore: () => ({
    getTab: mockGetTab,
    setActiveTab: mockSetActiveTab,
    updateStatus: mockUpdateStatus,
  }),
}));

vi.mock("solid-js", () => {
  function createSignal<T>(init: T): [() => T, (v: T) => void] {
    let value = init;
    return [() => value, (v: T) => { value = v; }];
  }
  return { createSignal };
});

import { useSendReview } from "./use-send-review";

function textMsg(role: "assistant" | "user", text: string): ChatMessage {
  return { role, blocks: [{ kind: "text", text }], isStreaming: false };
}

function makeTab(overrides?: Partial<Tab>): Tab {
  return {
    id: "review-tab",
    title: "Codex 2",
    status: "waiting",
    cliConfig: { cliType: "codex", mode: "default", workingDir: "/test" },
    sourceTabId: "source-tab",
    ...overrides,
  };
}

describe("extractLastAssistantText", () => {
  it("returns null for empty messages", () => {
    expect(extractLastAssistantText([])).toBeNull();
  });

  it("returns null when no assistant messages", () => {
    expect(extractLastAssistantText([textMsg("user", "hello")])).toBeNull();
  });

  it("returns last assistant text", () => {
    const msgs = [
      textMsg("assistant", "first review"),
      textMsg("user", "thanks"),
      textMsg("assistant", "second review"),
    ];
    expect(extractLastAssistantText(msgs)).toBe("second review");
  });

  it("returns null for assistant with no text blocks", () => {
    const msg: ChatMessage = {
      role: "assistant",
      blocks: [{ kind: "tool_use", toolName: "bash", toolId: "1", input: "ls", isStreaming: false }],
      isStreaming: false,
    };
    expect(extractLastAssistantText([msg])).toBeNull();
  });
});

describe("useSendReview", () => {
  let messages: ChatMessage[];
  let logMessages: string[];

  beforeEach(() => {
    vi.clearAllMocks();
    messages = [];
    logMessages = [];
  });

  function makeHook(tab?: Tab) {
    return useSendReview({
      tab: tab ?? makeTab(),
      messages: () => messages,
      addMessage: (t: string) => logMessages.push(t),
    });
  }

  it("has hasSourceTab true when sourceTabId exists", () => {
    const { hasSourceTab } = makeHook();
    expect(hasSourceTab()).toBe(true);
  });

  it("has hasSourceTab false when no sourceTabId", () => {
    const { hasSourceTab } = makeHook(makeTab({ sourceTabId: undefined }));
    expect(hasSourceTab()).toBe(false);
  });

  it("sends review text to source tab", async () => {
    messages = [textMsg("user", "review these"), textMsg("assistant", "LGTM")];
    mockGetTab.mockReturnValue({ id: "source-tab", ptyId: "source-pty" });
    mockSendMessage.mockResolvedValue(undefined);

    const { sendToSource } = makeHook();
    await sendToSource();

    expect(mockSendMessage).toHaveBeenCalledWith(
      "source-pty",
      expect.stringContaining("```\nLGTM\n```"),
    );
    expect(mockSetActiveTab).toHaveBeenCalledWith("source-tab");
  });

  it("shows error when source tab is gone", async () => {
    messages = [textMsg("assistant", "review")];
    mockGetTab.mockReturnValue(undefined);

    const { sendToSource } = makeHook();
    await sendToSource();

    expect(logMessages[0]).toContain("no longer exists");
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it("shows error when no assistant messages", async () => {
    messages = [textMsg("user", "hello")];
    mockGetTab.mockReturnValue({ id: "source-tab" });

    const { sendToSource } = makeHook();
    await sendToSource();

    expect(logMessages[0]).toContain("No review result");
  });

  it("prevents double click", async () => {
    let resolveSend: () => void;
    mockGetTab.mockReturnValue({ id: "source-tab", ptyId: "source-pty" });
    mockSendMessage.mockImplementation(() => new Promise<void>((r) => { resolveSend = r; }));
    messages = [textMsg("assistant", "review text")];

    const { sendToSource, isSending } = makeHook();
    const p1 = sendToSource();
    expect(isSending()).toBe(true);

    const p2 = sendToSource(); // should no-op
    expect(mockSendMessage).toHaveBeenCalledTimes(1);

    resolveSend!();
    await p1;
    await p2;
    expect(isSending()).toBe(false);
  });

  it("truncates very long review text", async () => {
    const longText = "x".repeat(60_000);
    messages = [textMsg("assistant", longText)];
    mockGetTab.mockReturnValue({ id: "source-tab", ptyId: "source-pty" });
    mockSendMessage.mockResolvedValue(undefined);

    const { sendToSource } = makeHook();
    await sendToSource();

    const sentPrompt = mockSendMessage.mock.calls[0][1] as string;
    expect(sentPrompt.length).toBeLessThan(55_000);
    expect(sentPrompt).toContain("[Truncated:");
  });
});
