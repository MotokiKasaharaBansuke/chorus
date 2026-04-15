import { createSignal } from "solid-js";
import type { ReviewCliType } from "../types";
import type { AccountProfile, Settings, WorktreeSettings } from "../types/settings";
import { DEFAULT_SETTINGS } from "../types/settings";
import { loadSettings, saveSettings } from "../lib/commands";

const [reviewCliType, setReviewCliType] = createSignal<ReviewCliType>(DEFAULT_SETTINGS.reviewCliType);
const [worktree, setWorktree] = createSignal<WorktreeSettings>(DEFAULT_SETTINGS.worktree);
const [accounts, setAccounts] = createSignal<AccountProfile[]>(DEFAULT_SETTINGS.accounts);
const [loaded, setLoaded] = createSignal(false);

function snapshot(): Settings {
  return { reviewCliType: reviewCliType(), worktree: worktree(), accounts: accounts() };
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

    get accounts(): AccountProfile[] { return accounts(); },
    setAccounts(next: AccountProfile[]) { setAccounts(next); debouncedSave(); },
    addAccount(profile: AccountProfile) {
      setAccounts([...accounts(), profile]);
      debouncedSave();
    },
    removeAccount(id: string) {
      setAccounts(accounts().filter(a => a.id !== id));
      debouncedSave();
    },
    findAccount(id: string): AccountProfile | undefined {
      return accounts().find(a => a.id === id);
    },

    get loaded(): boolean { return loaded(); },

    async initialize(): Promise<void> {
      try {
        const s = await loadSettings();
        setReviewCliType(s.reviewCliType);
        setWorktree(s.worktree);
        setAccounts(s.accounts ?? []);
      } catch (e) {
        console.error("Failed to load settings, using defaults:", e);
        setReviewCliType(DEFAULT_SETTINGS.reviewCliType);
        setWorktree(DEFAULT_SETTINGS.worktree);
        setAccounts(DEFAULT_SETTINGS.accounts);
      } finally {
        setLoaded(true);
      }
    },
  };
}
