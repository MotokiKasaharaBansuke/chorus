import { describe, it, expect } from "vitest";

import type { CliConfig } from "../../types";

import { decidePaneKind } from "./decide-pane-kind";

const baseConfig = (cliType: CliConfig["cliType"]): CliConfig => ({
  cliType,
  mode: "default",
  workingDir: "/tmp",
});

describe("decidePaneKind", () => {
  it("forces shell to PTY regardless of engineDefault", () => {
    expect(decidePaneKind(baseConfig("shell"), "headless")).toBe("pty");
    expect(decidePaneKind(baseConfig("shell"), "pty")).toBe("pty");
  });

  it("forces file-viewer to PTY regardless of engineDefault", () => {
    expect(decidePaneKind(baseConfig("file-viewer"), "headless")).toBe("pty");
  });

  it("returns headless for claude-code when engineDefault is headless", () => {
    expect(decidePaneKind(baseConfig("claude-code"), "headless")).toBe("headless");
  });

  it("returns headless for codex when engineDefault is headless", () => {
    expect(decidePaneKind(baseConfig("codex"), "headless")).toBe("headless");
  });

  it("returns pty for claude-code when engineDefault is pty", () => {
    expect(decidePaneKind(baseConfig("claude-code"), "pty")).toBe("pty");
  });

  it("returns pty for codex when engineDefault is pty", () => {
    expect(decidePaneKind(baseConfig("codex"), "pty")).toBe("pty");
  });
});
