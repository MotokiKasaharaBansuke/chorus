import { describe, it, expect } from "vitest";
import { decideCloseAction } from "./decide-close-action";
import type { OnPaneClose } from "../../types/settings";

function settings(overrides: Partial<OnPaneClose> = {}): OnPaneClose {
  return {
    promptRemoveWorktree: true,
    backgroundDelete: true,
    autoRemoveOnClose: false,
    ...overrides,
  };
}

describe("decideCloseAction", () => {
  describe("auto-remove on, clean tree", () => {
    it("removes silently regardless of prompt flag", () => {
      expect(decideCloseAction(settings({ autoRemoveOnClose: true, promptRemoveWorktree: true }), false))
        .toEqual({ kind: "silent-remove" });
      expect(decideCloseAction(settings({ autoRemoveOnClose: true, promptRemoveWorktree: false }), false))
        .toEqual({ kind: "silent-remove" });
    });
  });

  describe("auto-remove on, dirty tree", () => {
    it("falls back to prompt so uncommitted work cannot disappear", () => {
      expect(decideCloseAction(settings({ autoRemoveOnClose: true, promptRemoveWorktree: true }), true))
        .toEqual({ kind: "prompt", isDirty: true });
      expect(decideCloseAction(settings({ autoRemoveOnClose: true, promptRemoveWorktree: false }), true))
        .toEqual({ kind: "prompt", isDirty: true });
    });
  });

  describe("auto-remove off, prompt on", () => {
    it("prompts regardless of dirty state", () => {
      expect(decideCloseAction(settings({ autoRemoveOnClose: false, promptRemoveWorktree: true }), false))
        .toEqual({ kind: "prompt", isDirty: false });
      expect(decideCloseAction(settings({ autoRemoveOnClose: false, promptRemoveWorktree: true }), true))
        .toEqual({ kind: "prompt", isDirty: true });
    });
  });

  describe("everything off", () => {
    it("keeps the worktree untouched", () => {
      expect(decideCloseAction(settings({ autoRemoveOnClose: false, promptRemoveWorktree: false }), false))
        .toEqual({ kind: "skip" });
      expect(decideCloseAction(settings({ autoRemoveOnClose: false, promptRemoveWorktree: false }), true))
        .toEqual({ kind: "skip" });
    });
  });
});
