import { invoke } from "@tauri-apps/api/core";

/**
 * Save a base64-encoded image to the temp directory and return the absolute path.
 * @param base64Data Raw base64 string — must NOT include the `data:image/...;base64,` prefix.
 */
export async function saveTempImage(base64Data: string, extension?: string): Promise<string> {
  if (!base64Data) throw new Error("Empty image data");
  if (base64Data.startsWith("data:")) throw new Error("base64Data must not include the data: URI prefix");
  return invoke<string>("save_temp_image", { data: base64Data, extension });
}

export async function deleteTempImage(path: string): Promise<void> {
  // Extract filename only; Rust constructs the full path to prevent path traversal.
  const filename = path.split("/").pop();
  if (!filename) throw new Error("Invalid image path: no filename component");
  return invoke("delete_temp_image", { filename });
}

export async function cleanupTempImages(): Promise<void> {
  return invoke("cleanup_temp_images");
}
