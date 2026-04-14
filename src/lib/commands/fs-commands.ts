import { invoke } from "@tauri-apps/api/core";
import type { FileNode } from "../../types";

export async function listDirectory(path: string, depth?: number): Promise<FileNode[]> {
  return invoke<FileNode[]>("list_directory", { path, depth });
}

export async function readFile(path: string): Promise<string> {
  return invoke<string>("read_file", { path });
}

export interface SessionInfo {
  sessionId: string;
  lastModified: number;
  firstLine: string;
}

export async function listSessions(workingDir: string): Promise<SessionInfo[]> {
  return invoke<SessionInfo[]>("list_sessions", { workingDir });
}

export async function readSession(workingDir: string, sessionId: string): Promise<string[]> {
  return invoke<string[]>("read_session", { workingDir, sessionId });
}

export async function listCodexSessions(workingDir: string): Promise<SessionInfo[]> {
  return invoke<SessionInfo[]>("list_codex_sessions", { workingDir });
}

export async function readCodexSession(sessionPath: string): Promise<string[]> {
  return invoke<string[]>("read_codex_session", { sessionPath });
}

export async function gitChangedFiles(workingDir: string): Promise<string[]> {
  return invoke<string[]>("git_changed_files", { workingDir });
}
