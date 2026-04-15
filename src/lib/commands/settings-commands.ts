import { invoke } from "@tauri-apps/api/core";
import type { Settings } from "../../types/settings";

export function loadSettings(): Promise<Settings> {
  return invoke<Settings>("load_settings");
}

export function saveSettings(settings: Settings): Promise<void> {
  return invoke("save_settings", { settings });
}
