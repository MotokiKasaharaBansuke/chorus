import { invoke } from "@tauri-apps/api/core";

export function saveSession(data: string): Promise<void> {
  return invoke("save_session", { data });
}

export function loadSession(): Promise<string | null> {
  return invoke("load_session");
}
