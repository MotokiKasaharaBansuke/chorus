import { describe, it, expect, vi } from "vitest";
import {
  submitWithBusyRetry,
  MAX_BUSY_RETRIES,
  type SendOutcome,
  type SubmitWithBusyRetryDeps,
} from "./submit-with-busy-retry";

interface HarnessOptions {
  outcomes: SendOutcome[];
  afterResetOutcome?: SendOutcome;
  forceResetThrows?: boolean;
  cancelAt?: number; // send attempt index (0-based) at which isCancelled flips
}

function createHarness(opts: HarnessOptions) {
  const sendCalls: number[] = [];
  let sendIndex = 0;
  let resetInvoked = false;
  let cancelled = false;

  const deps: SubmitWithBusyRetryDeps = {
    send: async () => {
      sendCalls.push(sendIndex);
      if (opts.cancelAt === sendIndex) cancelled = true;
      if (resetInvoked) {
        sendIndex++;
        return opts.afterResetOutcome ?? "error";
      }
      const outcome = opts.outcomes[sendIndex] ?? "busy";
      sendIndex++;
      return outcome;
    },
    forceReset: async () => {
      resetInvoked = true;
      if (opts.forceResetThrows) throw new Error("kill failed");
    },
    sleep: vi.fn(async () => {}),
    isCancelled: () => cancelled,
    onForceReset: vi.fn(),
    onResetFailed: vi.fn(),
  };

  return { deps, sendCalls, sleep: deps.sleep as ReturnType<typeof vi.fn>, getResetInvoked: () => resetInvoked };
}

describe("submitWithBusyRetry", () => {
  it("returns 'sent' on first-try success without sleeping", async () => {
    const h = createHarness({ outcomes: ["sent"] });
    const result = await submitWithBusyRetry(h.deps);
    expect(result).toBe("sent");
    expect(h.sendCalls).toHaveLength(1);
    expect(h.sleep).not.toHaveBeenCalled();
    expect(h.getResetInvoked()).toBe(false);
  });

  it("returns 'error' immediately on non-busy failure", async () => {
    const h = createHarness({ outcomes: ["error"] });
    const result = await submitWithBusyRetry(h.deps);
    expect(result).toBe("error");
    expect(h.sendCalls).toHaveLength(1);
    expect(h.sleep).not.toHaveBeenCalled();
  });

  it("retries on busy and returns 'sent' when the CLI clears", async () => {
    const h = createHarness({ outcomes: ["busy", "busy", "sent"] });
    const result = await submitWithBusyRetry(h.deps);
    expect(result).toBe("sent");
    expect(h.sendCalls).toHaveLength(3);
    // Sleeps after each busy, but not after the final sent
    expect(h.sleep).toHaveBeenCalledTimes(2);
    expect(h.getResetInvoked()).toBe(false);
  });

  it("force-resets after MAX_BUSY_RETRIES busy attempts then retries once", async () => {
    const h = createHarness({
      outcomes: Array.from({ length: MAX_BUSY_RETRIES }, () => "busy" as const),
      afterResetOutcome: "sent",
    });
    const result = await submitWithBusyRetry(h.deps);
    expect(result).toBe("sent");
    // MAX retries + 1 post-reset send
    expect(h.sendCalls).toHaveLength(MAX_BUSY_RETRIES + 1);
    expect(h.getResetInvoked()).toBe(true);
    expect(h.deps.onForceReset).toHaveBeenCalledTimes(1);
    expect(h.deps.onResetFailed).not.toHaveBeenCalled();
  });

  it("returns 'error' and signals reset-failed when the post-reset send also fails", async () => {
    const h = createHarness({
      outcomes: Array.from({ length: MAX_BUSY_RETRIES }, () => "busy" as const),
      afterResetOutcome: "error",
    });
    const result = await submitWithBusyRetry(h.deps);
    expect(result).toBe("error");
    expect(h.deps.onForceReset).toHaveBeenCalledTimes(1);
    expect(h.deps.onResetFailed).toHaveBeenCalledTimes(1);
  });

  it("stops immediately when cancelled mid-retry", async () => {
    const h = createHarness({
      outcomes: ["busy", "busy", "sent"],
      cancelAt: 1, // second send flips cancellation
    });
    const result = await submitWithBusyRetry(h.deps);
    expect(result).toBe("cancelled");
    // Second send set the flag; loop re-checks before third send and bails.
    expect(h.sendCalls.length).toBeLessThanOrEqual(2);
    expect(h.getResetInvoked()).toBe(false);
  });

  it("swallows forceReset exceptions and still attempts the fallback send", async () => {
    const h = createHarness({
      outcomes: Array.from({ length: MAX_BUSY_RETRIES }, () => "busy" as const),
      afterResetOutcome: "sent",
      forceResetThrows: true,
    });
    const result = await submitWithBusyRetry(h.deps);
    expect(result).toBe("sent");
    expect(h.deps.onForceReset).toHaveBeenCalledTimes(1);
    // Fallback send must still run even when forceReset threw
    expect(h.sendCalls).toHaveLength(MAX_BUSY_RETRIES + 1);
  });

  it("treats post-reset 'busy' the same as a failed fallback (onResetFailed + error)", async () => {
    const h = createHarness({
      outcomes: Array.from({ length: MAX_BUSY_RETRIES }, () => "busy" as const),
      afterResetOutcome: "busy",
    });
    const result = await submitWithBusyRetry(h.deps);
    expect(result).toBe("error");
    expect(h.deps.onForceReset).toHaveBeenCalledTimes(1);
    expect(h.deps.onResetFailed).toHaveBeenCalledTimes(1);
  });

  it("does not trigger force-reset when cancelled after retries but before reset", async () => {
    const cancelFlag = { cancelled: false };
    const deps: SubmitWithBusyRetryDeps = {
      send: vi.fn(async () => "busy" as SendOutcome),
      forceReset: vi.fn(async () => {}),
      sleep: vi.fn(async () => {
        // Cancel just before the force-reset decision
        cancelFlag.cancelled = true;
      }),
      isCancelled: () => cancelFlag.cancelled,
      onForceReset: vi.fn(),
      onResetFailed: vi.fn(),
    };
    const result = await submitWithBusyRetry(deps);
    expect(result).toBe("cancelled");
    expect(deps.forceReset).not.toHaveBeenCalled();
    expect(deps.onForceReset).not.toHaveBeenCalled();
  });
});
