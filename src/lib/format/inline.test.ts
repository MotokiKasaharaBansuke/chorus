import { describe, it, expect } from "vitest";
import { applyInline } from "./inline";

const css = { mdLink: "link", inlineCode: "code" };

describe("applyInline", () => {
  it("converts bold", () => {
    expect(applyInline("**hello**", css)).toContain("<strong>hello</strong>");
  });

  it("converts italic", () => {
    expect(applyInline("*hello*", css)).toContain("<em>hello</em>");
  });

  it("converts inline code", () => {
    const result = applyInline("`foo`", css);
    expect(result).toContain('<code class="code">foo</code>');
  });

  it("converts Markdown links", () => {
    const result = applyInline("[click](https://example.com)", css);
    expect(result).toContain('href="https://example.com"');
    expect(result).toContain(">click</a>");
  });

  it("auto-links bare URLs", () => {
    const result = applyInline("visit https://example.com today", css);
    expect(result).toContain('href="https://example.com"');
    expect(result).toContain(">https://example.com</a>");
  });

  it("does not double-link Markdown link URLs", () => {
    const result = applyInline("[Example](https://example.com)", css);
    const linkCount = (result.match(/<a /g) ?? []).length;
    expect(linkCount).toBe(1);
  });

  it("does not double-link when bare URL follows Markdown link", () => {
    const result = applyInline("[a](https://a.com) and https://b.com", css);
    const linkCount = (result.match(/<a /g) ?? []).length;
    expect(linkCount).toBe(2);
  });

  it("does not leave placeholders in output", () => {
    const result = applyInline("[test](https://test.com)", css);
    expect(result).not.toContain("\x00");
  });

  it("sanitizes javascript: in Markdown links", () => {
    const result = applyInline("[click](javascript:alert(1))", css);
    expect(result).toContain('href="#"');
  });

  it("handles empty string", () => {
    expect(applyInline("", css)).toBe("");
  });

  it("passes through plain text unchanged", () => {
    expect(applyInline("hello world", css)).toBe("hello world");
  });
});
