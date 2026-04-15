import { createSignal } from "solid-js";
import type { ReviewCliType } from "../types";
import type { Settings, WorktreeSettings } from "../types/settings";
import { DEFAULT_SETTINGS } from "../types/settings";
import { loadSettings, saveSettings } from "../lib/commands";

const [reviewCliType, setReviewCliType] = createSignal<ReviewCliType>(DEFAULT_SETTINGS.reviewCliType);
const [worktree, setWorktree] = createSignal<WorktreeSettings>(DEFAULT_SETTINGS.worktree);
const [loaded, setLoaded] = createSignal(false);

function snapshot(): Settings {
  return { reviewCliType: reviewCliType(), worktree: worktree() };
}

async function persist(): Promise<void> {
  try {
    await saveSettings(snapshot());
  } catch (e) {
    console.error("Failed to persist settings:", e);
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function debouncedSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { persist(); saveTimer = null; }, 250);
}

export function useSettingsStore() {
  return {
    get reviewCliType(): ReviewCliType { return reviewCliType(); },
    setReviewCliType(type: ReviewCliType) { setReviewCliType(type); debouncedSave(); },

    get worktree(): WorktreeSettings { return worktree(); },
    setWorktree(next: WorktreeSettings) { setWorktree(next); debouncedSave(); },
    patchWorktree(patch: Partial<WorktreeSettings>) {
      setWorktree({ ...worktree(), ...patch });
      debouncedSave();
    },

    get loaded(): boolean { return loaded(); },

    async initialize(): Promise<void> {
      try {
        const s = await loadSettings();
        setReviewCliType(s.reviewCliType);
        setWorktree(s.worktree);
      } catch (e) {
        console.error("Failed to load settings, using defaults:", e);
        setReviewCliType(DEFAULT_SETTINGS.reviewCliType);
        setWorktree(DEFAULT_SETTINGS.worktree);
      } finally {
        setLoaded(true);
      }
    },
  };
}
