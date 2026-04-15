import { describe, it, expect } from "vitest";
import { isShareCargoTarget } from "./share-cargo-target";

describe("isShareCargoTarget", () => {
  it.each(["auto", "always", "never"] as const)(
    'returns true for valid value "%s"',
    (value) => {
      expect(isShareCargoTarget(value)).toBe(true);
    },
  );

  it.each(["", "Auto", "ALWAYS", "off", "yes", "null"])(
    'returns false for invalid value "%s"',
    (value) => {
      expect(isShareCargoTarget(value)).toBe(false);
    },
  );
});
