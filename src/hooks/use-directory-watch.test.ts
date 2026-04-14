import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

type BusListener = (payload: { root: string; paths: string[] }) => void;
let currentListener: BusListener | null = null;
const mockSubscribe = vi.fn((listener: BusListener) => {
  currentListener = listener;
  return () => { currentListener = null; };
});

vi.mock("../lib/fs-change-bus", () => ({
  subscribeFsChange: (fn: BusListener) => mockSubscribe(fn),
}));

interface EffectCtx {
  cleanups: Array<() => void>;
}
const ctx: EffectCtx = { cleanups: [] };

vi.mock("solid-js", () => ({
  createEffect: (fn: () => void) => fn(),
  onCleanup: (fn: () => void) => ctx.cleanups.push(fn),
}));

import { useDirectoryWatch } from "./use-directory-watch";

function teardown() {
  while (ctx.cleanups.length > 0) ctx.cleanups.pop()!();
}

describe("useDirectoryWatch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    currentListener = null;
  });

  afterEach(() => {
    teardown();
    vi.useRealTimers();
  });

  it("calls onDirectoryChanged when a direct child path changes", () => {
    const onChange = vi.fn();
    useDirectoryWatch({ dir: () => "/root", onDirectoryChanged: onChange });

    currentListener!({ root: "/root", paths: ["/root/new-file.ts"] });
    vi.advanceTimersByTime(200);

    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("ignores changes not in the directory", () => {
    const onChange = vi.fn();
    useDirectoryWatch({ dir: () => "/root", onDirectoryChanged: onChange });

    currentListener!({ root: "/root", paths: ["/other/file.ts"] });
    vi.advanceTimersByTime(200);

    expect(onChange).not.toHaveBeenCalled();
  });

  it("coalesces rapid bursts into a single call (trailing debounce)", () => {
    const onChange = vi.fn();
    useDirectoryWatch({ dir: () => "/root", onDirectoryChanged: onChange });

    currentListener!({ root: "/root", paths: ["/root/a"] });
    vi.advanceTimersByTime(50);
    currentListener!({ root: "/root", paths: ["/root/b"] });
    vi.advanceTimersByTime(50);
    currentListener!({ root: "/root", paths: ["/root/c"] });
    vi.advanceTimersByTime(200);

    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("does not subscribe when dir is undefined", () => {
    const onChange = vi.fn();
    useDirectoryWatch({ dir: () => undefined, onDirectoryChanged: onChange });

    expect(mockSubscribe).not.toHaveBeenCalled();
  });

  it("unsubscribes and clears pending timer on cleanup", () => {
    const onChange = vi.fn();
    useDirectoryWatch({ dir: () => "/root", onDirectoryChanged: onChange });

    currentListener!({ root: "/root", paths: ["/root/x"] });
    teardown();
    vi.advanceTimersByTime(500);

    expect(onChange).not.toHaveBeenCalled();
    expect(currentListener).toBeNull();
  });
});
