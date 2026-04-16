import { invoke } from "@tauri-apps/api/core";
import type { CliConfig } from "../../types";

interface PtySpawnConfig {
  cliType: string;
  mode: string;
  model?: string;
  workingDir: string;
  cols?: number;
  rows?: number;
}

export async function spawnPty(
  config: CliConfig,
  cols?: number,
  rows?: number,
): Promise<string> {
  return invoke<string>("spawn_pty", {
    config: {
      cliType: config.cliType,
      mode: config.mode,
      model: config.model,
      workingDir: config.workingDir,
      cols,
      rows,
    } satisfies PtySpawnConfig,
  });
}

export async function writePty(ptyId: string, data: string): Promise<void> {
  return invoke("write_pty", { ptyId, data });
}

export interface ImageAttachmentPayload {
  data: string;      // base64-encoded image data (no data: prefix)
  mediaType: string; // e.g. "image/png"
}

export async function sendMessage(
  paneId: string,
  message: string,
  images?: ReadonlyArray<ImageAttachmentPayload>,
): Promise<void> {
  return invoke("send_message", {
    paneId,
    message,
    images: images && images.length > 0 ? images : null,
  });
}

export async function resizePty(ptyId: string, cols: number, rows: number): Promise<void> {
  return invoke("resize_pty", { ptyId, cols, rows });
}

export async function killPty(ptyId: string): Promise<void> {
  return invoke("kill_pty", { ptyId });
}

export async function listSessionIds(): Promise<string[]> {
  return invoke<string[]>("list_session_ids");
}

export async function killZombieSessions(keepIds: string[]): Promise<number> {
  return invoke<number>("kill_zombie_sessions", { keepIds });
}

export interface ZombieSessionInfo {
  id: string;
  cliType: string;
}

export async function listZombieSessions(keepIds: string[]): Promise<ZombieSessionInfo[]> {
  return invoke<ZombieSessionInfo[]>("list_zombie_sessions", { keepIds });
}

export async function killSessionById(id: string): Promise<boolean> {
  return invoke<boolean>("kill_session_by_id", { id });
}
