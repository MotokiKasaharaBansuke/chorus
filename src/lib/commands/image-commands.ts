import { invoke } from "@tauri-apps/api/core";

export async function saveTempImage(base64Data: string, extension?: string): Promise<string> {
  return invoke<string>("save_temp_image", { data: base64Data, extension });
}

export async function deleteTempImage(path: string): Promise<void> {
  // Extract filename only; Rust constructs the full path to prevent path traversal.
  const filename = path.split("/").pop() ?? "";
  return invoke("delete_temp_image", { filename });
}

export async function cleanupTempImages(): Promise<void> {
  return invoke("cleanup_temp_images");
}
