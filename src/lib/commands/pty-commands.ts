import { invoke } from "@tauri-apps/api/core";
import type { CliConfig, SessionFlags } from "../../types";

interface PtySpawnConfig {
  cliType: string;
  mode: string;
  model?: string;
  workingDir: string;
  cols?: number;
  rows?: number;
  commandOverride?: string;
  argsOverride?: string[];
  sessionFlags?: SessionFlags;
}

export async function spawnPty(
  config: CliConfig,
  cols?: number,
  rows?: number,
  sessionFlags?: SessionFlags,
): Promise<string> {
  return invoke<string>("spawn_pty", {
    config: {
      cliType: config.cliType,
      mode: config.mode,
      model: config.model,
      workingDir: config.workingDir,
      cols,
      rows,
      sessionFlags,
    } satisfies PtySpawnConfig,
  });
}

export async function writePty(ptyId: string, data: string): Promise<void> {
  return invoke("write_pty", { ptyId, data });
}

export interface ImageAttachmentPayload {
  path: string;      // absolute path to temp image file
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

/**
 * Discards the entire pty/stream session, including the CLI's `session_id`.
 * The next `spawnPty` starts a fresh conversation with no `--resume`
 * context. Use `interruptPty` instead when cancelling a running response
 * but wanting the next message to continue the same thread.
 */
export async function killPty(ptyId: string): Promise<void> {
  return invoke("kill_pty", { ptyId });
}

/**
 * Interrupts a stream session's running child process without discarding
 * the session record. The next `sendMessage` call on this pty id resumes
 * the same conversation (via CLI `--resume`), preserving the model's
 * context. Use this instead of `killPty` when cancelling the current
 * response mid-stream.
 */
export async function interruptPty(ptyId: string): Promise<void> {
  return invoke("interrupt_pty", { ptyId });
}

export async function getStreamSessionId(ptyId: string): Promise<string> {
  return invoke<string>("get_stream_session_id", { ptyId });
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

/** Spawn an ephemeral PTY for a one-off command (e.g. `claude auth login`). */
export async function spawnEphemeralPty(
  command: string,
  args: string[],
  workingDir: string,
  cols?: number,
  rows?: number,
): Promise<string> {
  return invoke<string>("spawn_pty", {
    config: {
      cliType: "shell",
      mode: "default",
      workingDir,
      cols,
      rows,
      commandOverride: command,
      argsOverride: args,
    } satisfies PtySpawnConfig,
  });
}
