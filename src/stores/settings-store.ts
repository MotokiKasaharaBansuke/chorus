import { createSignal } from "solid-js";
import type { ReviewCliType } from "../types";
import type {
  DefaultCliType,
  EngineDefault,
  Settings,
  WorktreeSettings,
} from "../types/settings";
import { DEFAULT_SETTINGS } from "../types/settings";
import { loadSettings, saveSettings } from "../lib/commands";

const DEFAULT_ENGINE: EngineDefault = DEFAULT_SETTINGS.engineDefault ?? "pty";
const DEFAULT_CLI_TYPE: DefaultCliType =
  DEFAULT_SETTINGS.defaultCliType ?? "claude-code";

const [reviewCliType, setReviewCliType] = createSignal<ReviewCliType>(DEFAULT_SETTINGS.reviewCliType);
const [engineDefault, setEngineDefaultSignal] = createSignal<EngineDefault>(DEFAULT_ENGINE);
const [defaultCliType, setDefaultCliTypeSignal] =
  createSignal<DefaultCliType>(DEFAULT_CLI_TYPE);
const [worktree, setWorktree] = createSignal<WorktreeSettings>(DEFAULT_SETTINGS.worktree);
const [loaded, setLoaded] = createSignal(false);

function snapshot(): Settings {
  return {
    reviewCliType: reviewCliType(),
    engineDefault: engineDefault(),
    defaultCliType: defaultCliType(),
    worktree: worktree(),
  };
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

    get engineDefault(): EngineDefault { return engineDefault(); },
    setEngineDefault(engine: EngineDefault) { setEngineDefaultSignal(engine); debouncedSave(); },

    get defaultCliType(): DefaultCliType { return defaultCliType(); },
    setDefaultCliType(cli: DefaultCliType) { setDefaultCliTypeSignal(cli); debouncedSave(); },

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
        setEngineDefaultSignal(s.engineDefault ?? DEFAULT_ENGINE);
        setDefaultCliTypeSignal(s.defaultCliType ?? DEFAULT_CLI_TYPE);
        setWorktree(s.worktree);
      } catch (e) {
        console.error("Failed to load settings, using defaults:", e);
        setReviewCliType(DEFAULT_SETTINGS.reviewCliType);
        setEngineDefaultSignal(DEFAULT_ENGINE);
        setDefaultCliTypeSignal(DEFAULT_CLI_TYPE);
        setWorktree(DEFAULT_SETTINGS.worktree);
      } finally {
        setLoaded(true);
      }
    },
  };
}
