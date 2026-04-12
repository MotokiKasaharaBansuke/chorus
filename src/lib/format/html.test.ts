import { describe, it, expect } from "vitest";
import { sanitizeHref, escapeHtml, highlightDiffLine } from "../../lib/format/html";

describe("sanitizeHref", () => {
  it("blocks javascript: protocol", () => {
    expect(sanitizeHref("javascript:alert(1)")).toBe("#");
  });

  it("blocks JavaScript: (case insensitive)", () => {
    expect(sanitizeHref("JavaScript:alert(1)")).toBe("#");
  });

  it("blocks data: protocol", () => {
    expect(sanitizeHref("data:text/html,<script>")).toBe("#");
  });

  it("blocks vbscript: protocol", () => {
    expect(sanitizeHref("vbscript:MsgBox")).toBe("#");
  });

  it("allows https URLs", () => {
    expect(sanitizeHref("https://example.com")).toBe("https://example.com");
  });

  it("allows http URLs", () => {
    expect(sanitizeHref("http://example.com")).toBe("http://example.com");
  });

  it("allows relative URLs", () => {
    expect(sanitizeHref("/path/to/file")).toBe("/path/to/file");
  });

  it("allows anchor links", () => {
    expect(sanitizeHref("#section")).toBe("#section");
  });

  it("escapes double quotes in URL", () => {
    expect(sanitizeHref('https://example.com/"test')).toBe("https://example.com/&quot;test");
  });

  it("blocks javascript: with leading whitespace", () => {
    expect(sanitizeHref("  javascript:alert(1)")).toBe("#");
  });

  // Control character bypass tests
  it("blocks javascript: with tab prefix", () => {
    expect(sanitizeHref("\tjavascript:alert(1)")).toBe("#");
  });

  it("blocks javascript: with null byte prefix", () => {
    expect(sanitizeHref("\x00javascript:alert(1)")).toBe("#");
  });

  it("blocks javascript: with newline prefix", () => {
    expect(sanitizeHref("\njavascript:alert(1)")).toBe("#");
  });

  it("blocks javascript: with zero-width space", () => {
    expect(sanitizeHref("\u200bjavascript:alert(1)")).toBe("#");
  });

  it("blocks data: with control characters mixed in", () => {
    expect(sanitizeHref("\x01data:text/html,<script>")).toBe("#");
  });
});

describe("escapeHtml", () => {
  it("escapes &", () => {
    expect(escapeHtml("a & b")).toBe("a &amp; b");
  });

  it("escapes <", () => {
    expect(escapeHtml("<script>")).toBe("&lt;script&gt;");
  });

  it("escapes >", () => {
    expect(escapeHtml("a > b")).toBe("a &gt; b");
  });

  it("escapes double quotes", () => {
    expect(escapeHtml('"hello"')).toBe("&quot;hello&quot;");
  });

  it("handles empty string", () => {
    expect(escapeHtml("")).toBe("");
  });

  it("passes through safe text", () => {
    expect(escapeHtml("hello world")).toBe("hello world");
  });

  it("escapes multiple entities in one string", () => {
    expect(escapeHtml('<a href="x">&')).toBe("&lt;a href=&quot;x&quot;&gt;&amp;");
  });
});

describe("highlightDiffLine", () => {
  it("escapes HTML before highlighting", () => {
    const result = highlightDiffLine('<script>alert(1)</script>');
    expect(result).not.toContain("<script>");
    expect(result).toContain("&lt;script&gt;");
  });

  it("highlights keywords", () => {
    const result = highlightDiffLine("const x = 1;");
    expect(result).toContain("color:#c586c0");
    expect(result).toContain("const");
  });

  it("highlights single-quoted strings", () => {
    const result = highlightDiffLine("const s = 'hello';");
    expect(result).toContain("color:#ce9178");
  });

  it("highlights numbers", () => {
    const result = highlightDiffLine("const n = 42;");
    expect(result).toContain("color:#b5cea8");
  });

  it("handles empty string", () => {
    expect(highlightDiffLine("")).toBe("");
  });
});
