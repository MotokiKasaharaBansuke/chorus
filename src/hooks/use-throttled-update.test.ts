import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Stub solid-js onCleanup before importing the module under test
vi.mock("solid-js", () => ({
  onCleanup: vi.fn(),
}));

import { useThrottledUpdate } from "./use-throttled-update";

describe("useThrottledUpdate", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createThrottle(overrides?: {
    isActive?: () => boolean;
    isDisposed?: () => boolean;
  }) {
    const onApply = vi.fn();
    const result = useThrottledUpdate({
      onApply,
      isActive: overrides?.isActive ?? (() => true),
      isDisposed: overrides?.isDisposed ?? (() => false),
    });
    return { onApply, ...result };
  }

  function msg(text: string) {
    return [{ role: "user" as const, blocks: [{ kind: "text" as const, text }], isStreaming: false }];
  }

  it("applies the first event immediately (leading edge)", () => {
    const { handleUpdate, onApply } = createThrottle();
    const m = msg("hello");
    handleUpdate(m);
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply).toHaveBeenCalledWith(m);
  });

  it("throttles rapid successive calls and fires trailing update", () => {
    const { handleUpdate, onApply } = createThrottle();
    handleUpdate(msg("first"));
    expect(onApply).toHaveBeenCalledTimes(1);

    // Fire again within 48ms — should be deferred
    vi.advanceTimersByTime(10);
    handleUpdate(msg("second"));
    expect(onApply).toHaveBeenCalledTimes(1);

    // Fire once more — replaces pending
    vi.advanceTimersByTime(5);
    handleUpdate(msg("third"));
    expect(onApply).toHaveBeenCalledTimes(1);

    // Trailing timer fires at ~48ms from the first call
    vi.advanceTimersByTime(48);
    expect(onApply).toHaveBeenCalledTimes(2);
    expect(onApply).toHaveBeenLastCalledWith(msg("third"));
  });

  it("applies immediately after throttle window passes", () => {
    const { handleUpdate, onApply } = createThrottle();
    handleUpdate(msg("first"));
    expect(onApply).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(55);
    handleUpdate(msg("second"));
    expect(onApply).toHaveBeenCalledTimes(2);
    expect(onApply).toHaveBeenLastCalledWith(msg("second"));
  });

  it("skips updates when isActive returns false", () => {
    const { handleUpdate, onApply } = createThrottle({
      isActive: () => false,
    });
    handleUpdate(msg("hello"));
    expect(onApply).not.toHaveBeenCalled();
  });

  it("skips updates when isDisposed returns true", () => {
    let disposed = false;
    const { handleUpdate, onApply } = createThrottle({
      isDisposed: () => disposed,
    });
    handleUpdate(msg("first"));
    expect(onApply).toHaveBeenCalledTimes(1);

    // Schedule a trailing update, then dispose before it fires
    vi.advanceTimersByTime(10);
    handleUpdate(msg("second"));
    disposed = true;
    vi.advanceTimersByTime(48);
    // Trailing timer should bail out due to disposal
    expect(onApply).toHaveBeenCalledTimes(1);
  });

  it("reset() clears stale state so next event is applied immediately", () => {
    const { handleUpdate, onApply, reset } = createThrottle();
    handleUpdate(msg("first"));
    expect(onApply).toHaveBeenCalledTimes(1);

    // Within throttle window, schedule a trailing update
    vi.advanceTimersByTime(10);
    handleUpdate(msg("second"));
    expect(onApply).toHaveBeenCalledTimes(1);

    // Reset clears pending state
    reset();

    // Next call should apply immediately (not throttled by stale timestamp)
    handleUpdate(msg("third"));
    expect(onApply).toHaveBeenCalledTimes(2);
    expect(onApply).toHaveBeenLastCalledWith(msg("third"));

    // Trailing timer from "second" should NOT fire after reset
    vi.advanceTimersByTime(48);
    expect(onApply).toHaveBeenCalledTimes(2);
  });

  it("does not fire trailing update if no pending messages", () => {
    const { handleUpdate, onApply } = createThrottle();
    handleUpdate(msg("first"));
    expect(onApply).toHaveBeenCalledTimes(1);

    // Let the throttle window pass with no new events
    vi.advanceTimersByTime(50);
    expect(onApply).toHaveBeenCalledTimes(1);
  });
});
