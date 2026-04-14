import { describe, it, expect, vi, beforeEach } from "vitest";

interface TauriEvent {
  payload: { root: string; paths: string[] };
}
type RawListener = (event: TauriEvent) => void;

let tauriListener: RawListener | null = null;
const mockUnlisten = vi.fn();

type ListenImpl = (_event: string, cb: RawListener) => Promise<() => void>;
const defaultListenImpl: ListenImpl = async (_e, cb) => {
  tauriListener = cb;
  return mockUnlisten;
};
let listenImpl: ListenImpl = defaultListenImpl;
const mockListen = vi.fn((event: string, cb: RawListener) => listenImpl(event, cb));

vi.mock("@tauri-apps/api/event", () => ({
  listen: (event: string, cb: RawListener) => mockListen(event, cb),
}));

function emit(payload: { root: string; paths: string[] }) {
  tauriListener!({ payload });
}

import { subscribeFsChange, __resetFsChangeBusForTests } from "./fs-change-bus";

function flushPromises() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("fs-change-bus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tauriListener = null;
    listenImpl = defaultListenImpl;
    __resetFsChangeBusForTests();
  });

  it("invokes subscriber when fs-change event fires", async () => {
    const handler = vi.fn();
    const unsubscribe = subscribeFsChange(handler);
    await flushPromises();

    emit({ root: "/a", paths: ["/a/b"] });
    expect(handler).toHaveBeenCalledWith({ root: "/a", paths: ["/a/b"] });

    unsubscribe();
  });

  it("starts Tauri listener only once for multiple subscribers", async () => {
    const unsub1 = subscribeFsChange(() => {});
    const unsub2 = subscribeFsChange(() => {});
    await flushPromises();

    expect(mockListen).toHaveBeenCalledTimes(1);

    unsub1();
    unsub2();
  });

  it("tears down Tauri listener when last subscriber leaves", async () => {
    const unsub1 = subscribeFsChange(() => {});
    const unsub2 = subscribeFsChange(() => {});
    await flushPromises();

    unsub1();
    expect(mockUnlisten).not.toHaveBeenCalled();

    unsub2();
    await flushPromises();
    expect(mockUnlisten).toHaveBeenCalledTimes(1);
  });

  it("unlistens once Tauri resolves, even if subscriber left while pending", async () => {
    let resolveListen: ((fn: () => void) => void) | null = null;
    listenImpl = (_e, cb) =>
      new Promise<() => void>((resolve) => {
        tauriListener = cb;
        resolveListen = (fn) => resolve(fn);
      });

    const unsub = subscribeFsChange(() => {});
    unsub(); // last subscriber leaves before `listen` resolves

    resolveListen!(mockUnlisten);
    await flushPromises();

    expect(mockUnlisten).toHaveBeenCalledTimes(1);
  });

  it("keeps Tauri listener alive if a new subscriber arrives before resolve", async () => {
    let resolveListen: ((fn: () => void) => void) | null = null;
    listenImpl = (_e, cb) =>
      new Promise<() => void>((resolve) => {
        tauriListener = cb;
        resolveListen = (fn) => resolve(fn);
      });

    const unsub1 = subscribeFsChange(() => {});
    unsub1();
    const unsub2 = subscribeFsChange(() => {}); // re-starts before resolve

    resolveListen!(mockUnlisten);
    await flushPromises();

    expect(mockUnlisten).not.toHaveBeenCalled();
    unsub2();
  });

  it("isolates listener errors", async () => {
    const bad = vi.fn(() => { throw new Error("boom"); });
    const good = vi.fn();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const unsub1 = subscribeFsChange(bad);
    const unsub2 = subscribeFsChange(good);
    await flushPromises();

    emit({ root: "/a", paths: ["/a/x"] });
    expect(good).toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalled();

    unsub1();
    unsub2();
    consoleError.mockRestore();
  });
});
