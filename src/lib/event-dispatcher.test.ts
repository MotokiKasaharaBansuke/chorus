import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((_eventName: string, handler: (event: { payload: unknown }) => void) => {
    listeners.push({ eventName: _eventName, handler });
    return Promise.resolve(() => {});
  }),
}));

interface MockListener {
  eventName: string;
  handler: (event: { payload: unknown }) => void;
}

let listeners: MockListener[] = [];

function emit(eventName: string, payload: unknown) {
  for (const l of listeners) {
    if (l.eventName === eventName) l.handler({ payload });
  }
}

beforeEach(() => {
  listeners = [];
  vi.resetModules();
});

describe("createDispatcher (via ptyOutputDispatcher)", () => {
  it("dispatches events to the correct handler by ID", async () => {
    const { ptyOutputDispatcher } = await import("./event-dispatcher");
    const handler = vi.fn();
    ptyOutputDispatcher.subscribe("pty-1", handler);
    await vi.dynamicImportSettled();

    emit("pty-output", { id: "pty-1", data: "hello" });
    expect(handler).toHaveBeenCalledWith({ id: "pty-1", data: "hello" });
  });

  it("does not dispatch to unrelated handlers", async () => {
    const { ptyOutputDispatcher } = await import("./event-dispatcher");
    const handler1 = vi.fn();
    const handler2 = vi.fn();
    ptyOutputDispatcher.subscribe("pty-1", handler1);
    ptyOutputDispatcher.subscribe("pty-2", handler2);
    await vi.dynamicImportSettled();

    emit("pty-output", { id: "pty-1", data: "test" });
    expect(handler1).toHaveBeenCalledTimes(1);
    expect(handler2).not.toHaveBeenCalled();
  });

  it("unsubscribe removes the handler", async () => {
    const { ptyOutputDispatcher } = await import("./event-dispatcher");
    const handler = vi.fn();
    const unsub = ptyOutputDispatcher.subscribe("pty-1", handler);
    await vi.dynamicImportSettled();

    unsub();
    emit("pty-output", { id: "pty-1", data: "test" });
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("streamEventDispatcher with batchSource", () => {
  it("fans out batch lines to the correct handler", async () => {
    const { streamEventDispatcher } = await import("./event-dispatcher");
    const handler = vi.fn();
    streamEventDispatcher.subscribe("s1", handler);
    await vi.dynamicImportSettled();

    emit("stream-event-batch", { id: "s1", lines: ["line1", "line2", "line3"] });
    expect(handler).toHaveBeenCalledTimes(3);
    expect(handler).toHaveBeenNthCalledWith(1, { id: "s1", data: "line1" });
    expect(handler).toHaveBeenNthCalledWith(2, { id: "s1", data: "line2" });
    expect(handler).toHaveBeenNthCalledWith(3, { id: "s1", data: "line3" });
  });

  it("handles individual stream-event alongside batch", async () => {
    const { streamEventDispatcher } = await import("./event-dispatcher");
    const handler = vi.fn();
    streamEventDispatcher.subscribe("s1", handler);
    await vi.dynamicImportSettled();

    emit("stream-event", { id: "s1", data: "single" });
    expect(handler).toHaveBeenCalledWith({ id: "s1", data: "single" });
  });

  it("ignores malformed batch payloads", async () => {
    const { streamEventDispatcher } = await import("./event-dispatcher");
    const handler = vi.fn();
    streamEventDispatcher.subscribe("s1", handler);
    await vi.dynamicImportSettled();

    emit("stream-event-batch", null);
    emit("stream-event-batch", { id: "s1" });
    emit("stream-event-batch", { id: "s1", lines: [42, null, "valid"] });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ id: "s1", data: "valid" });
  });

  it("processes large batches in chunks via MessageChannel", async () => {
    const { streamEventDispatcher } = await import("./event-dispatcher");
    const handler = vi.fn();
    streamEventDispatcher.subscribe("s1", handler);
    await vi.dynamicImportSettled();

    // 20 lines exceeds BATCH_CHUNK_SIZE (8) → triggers chunked processing
    const lines = Array.from({ length: 20 }, (_, i) => `line${i}`);
    emit("stream-event-batch", { id: "s1", lines });

    // First chunk (8 items) processed synchronously
    expect(handler.mock.calls.length).toBeGreaterThanOrEqual(8);

    // Remaining chunks arrive via MessageChannel — flush all pending tasks
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(handler).toHaveBeenCalledTimes(20);
    expect(handler).toHaveBeenLastCalledWith({ id: "s1", data: "line19" });
  });

  it("abandons in-flight chunks when a newer batch arrives", async () => {
    const { streamEventDispatcher } = await import("./event-dispatcher");
    const handler = vi.fn();
    streamEventDispatcher.subscribe("s1", handler);
    await vi.dynamicImportSettled();

    // Start a large batch — first chunk (8 items) fires synchronously
    const lines1 = Array.from({ length: 20 }, (_, i) => `old${i}`);
    emit("stream-event-batch", { id: "s1", lines: lines1 });
    const afterFirstChunk = handler.mock.calls.length;
    expect(afterFirstChunk).toBeGreaterThanOrEqual(8);

    // Send a new small batch — increments batchGeneration, invalidating
    // any remaining chunks from lines1
    const lines2 = Array.from({ length: 3 }, (_, i) => `new${i}`);
    emit("stream-event-batch", { id: "s1", lines: lines2 });
    const afterSecondBatch = handler.mock.calls.length;

    // Wait for any pending chunks from the first batch
    await new Promise(resolve => setTimeout(resolve, 20));
    // No additional calls should have arrived from the abandoned first batch
    expect(handler).toHaveBeenCalledTimes(afterSecondBatch);
  });
});
