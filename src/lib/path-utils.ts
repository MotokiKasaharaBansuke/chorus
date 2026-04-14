/**
 * Returns the parent directory of a POSIX path.
 * Normalizes trailing slashes so `"/a/b/"` and `"/a/b"` both yield `"/a"`.
 * Returns `""` for paths with no parent segment.
 */
export function parentDir(path: string): string {
  if (!path) return "";
  let end = path.length;
  while (end > 1 && path[end - 1] === "/") end--;
  const lastSlash = path.lastIndexOf("/", end - 1);
  if (lastSlash < 0) return "";
  if (lastSlash === 0) return "/";
  return path.slice(0, lastSlash);
}
