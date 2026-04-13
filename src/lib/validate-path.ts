/**
 * True only for paths that Chorus wrote into the temp image directory (no traversal).
 * Note: This is a string-level check (defense-in-depth). The Rust backend is the
 * trust boundary and should canonicalize paths before serving.
 */
export function isValidTempImagePath(path: string): boolean {
  return path.startsWith("/tmp/chorus-images/")
    && !path.includes("..")
    && !/[\x00-\x1f]/.test(path);
}
