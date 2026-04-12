import { describe, it, expect } from "vitest";
import { sanitizeHref, escapeHtml } from "../../lib/format/html";

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
