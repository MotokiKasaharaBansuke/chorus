import { describe, it, expect, vi } from "vitest";
import {
  submitWithBusyRetry,
  type SendOutcome,
  type SubmitWithBusyRetryDeps,
} from "./submit-with-busy-retry";

interface HarnessOptions {
  outcomes: SendOutcome[];
  /** Outcome of the single retry after waitForIdle. Defaults to "error". */
  retryOutcome?: SendOutcome;
  /** If true, waitForIdle rejects (simulates timeout). */
  waitForIdleTimesOut?: boolean;
  /** send() attempt index (0-based) at which isCancelled flips. */
  cancelAt?: number;
  /** If true, isCancelled flips during waitForIdle. */
  cancelDuringWait?: boolean;
}

function createHarness(opts: HarnessOptions) {
  const sendCalls: number[] = [];
  let sendIndex = 0;
  let cancelled = false;

  const deps: SubmitWithBusyRetryDeps = {
    send: async () => {
      sendCalls.push(sendIndex);
      if (opts.cancelAt === sendIndex) cancelled = true;
      const outcome = opts.outcomes[sendIndex] ?? opts.retryOutcome ?? "error";
      sendIndex++;
      return outcome;
    },
    waitForIdle: vi.fn(async () => {
      if (opts.cancelDuringWait) cancelled = true;
      if (opts.waitForIdleTimesOut) throw new Error("timeout");
    }),
    isCancelled: () => cancelled,
    onResetFailed: vi.fn(),
  };

  return { deps, sendCalls };
}

describe("submitWithBusyRetry", () => {
  it("returns 'sent' on first-try success without waiting", async () => {
    const h = createHarness({ outcomes: ["sent"] });
    const result = await submitWithBusyRetry(h.deps);
    expect(result).toBe("sent");
    expect(h.sendCalls).toHaveLength(1);
    expect(h.deps.waitForIdle).not.toHaveBeenCalled();
  });

  it("returns 'error' immediately on non-busy failure", async () => {
    const h = createHarness({ outcomes: ["error"] });
    const result = await submitWithBusyRetry(h.deps);
    expect(result).toBe("error");
    expect(h.sendCalls).toHaveLength(1);
    expect(h.deps.waitForIdle).not.toHaveBeenCalled();
  });

  it("waits for idle on busy then retries successfully", async () => {
    const h = createHarness({ outcomes: ["busy", "sent"] });
    const result = await submitWithBusyRetry(h.deps);
    expect(result).toBe("sent");
    expect(h.sendCalls).toHaveLength(2);
    expect(h.deps.waitForIdle).toHaveBeenCalledTimes(1);
    expect(h.deps.onResetFailed).not.toHaveBeenCalled();
  });

  it("retries after waitForIdle timeout and succeeds", async () => {
    const h = createHarness({
      outcomes: ["busy", "sent"],
      waitForIdleTimesOut: true,
    });
    const result = await submitWithBusyRetry(h.deps);
    expect(result).toBe("sent");
    expect(h.sendCalls).toHaveLength(2);
    expect(h.deps.waitForIdle).toHaveBeenCalledTimes(1);
  });

  it("returns 'error' with onResetFailed when retry also fails", async () => {
    const h = createHarness({
      outcomes: ["busy"],
      retryOutcome: "busy",
    });
    const result = await submitWithBusyRetry(h.deps);
    expect(result).toBe("error");
    expect(h.sendCalls).toHaveLength(2);
    expect(h.deps.onResetFailed).toHaveBeenCalledTimes(1);
  });

  it("returns 'error' with onResetFailed when retry returns error", async () => {
    const h = createHarness({
      outcomes: ["busy"],
      retryOutcome: "error",
    });
    const result = await submitWithBusyRetry(h.deps);
    expect(result).toBe("error");
    expect(h.deps.onResetFailed).toHaveBeenCalledTimes(1);
  });

  it("returns 'cancelled' when cancelled after first busy send", async () => {
    const h = createHarness({
      outcomes: ["busy"],
      cancelAt: 0,
    });
    const result = await submitWithBusyRetry(h.deps);
    expect(result).toBe("cancelled");
    expect(h.sendCalls).toHaveLength(1);
    expect(h.deps.waitForIdle).not.toHaveBeenCalled();
  });

  it("returns 'cancelled' when cancelled during waitForIdle", async () => {
    const h = createHarness({
      outcomes: ["busy", "sent"],
      cancelDuringWait: true,
    });
    const result = await submitWithBusyRetry(h.deps);
    expect(result).toBe("cancelled");
    expect(h.sendCalls).toHaveLength(1);
    expect(h.deps.waitForIdle).toHaveBeenCalledTimes(1);
  });
});
