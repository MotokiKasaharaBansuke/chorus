import type { ShareCargoTarget } from "../../types/settings";

const SHARE_CARGO_TARGET_SET = new Set<string>(["auto", "always", "never"]);

export function isShareCargoTarget(
  value: string,
): value is ShareCargoTarget {
  return SHARE_CARGO_TARGET_SET.has(value);
}
