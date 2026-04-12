import { sanitizeHref } from "./html";

interface InlineStyles {
  mdLink: string;
  inlineCode: string;
}

/**
 * Convert inline Markdown to HTML.
 * Input MUST be HTML-escaped (via escapeHtml) before calling.
 * Uses placeholder pattern to prevent auto-link from matching inside href attributes.
 */
export function applyInline(text: string, css: InlineStyles): string {
  // Step 1: Replace Markdown links with placeholders
  const placeholders: string[] = [];
  let result = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) => {
    const idx = placeholders.length;
    placeholders.push(`<a class="${css.mdLink}" href="${sanitizeHref(url)}" data-external-link="true">${label}</a>`);
    return `\x00LINK${idx}\x00`;
  });

  // Step 2: Inline formatting
  result = result
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/`([^`]+)`/g, `<code class="${css.inlineCode}">$1</code>`);

  // Step 3: Auto-link bare URLs (safe — Markdown links already replaced with placeholders)
  result = result.replace(/(https?:\/\/[^\s<>\x00]+)/g, (url) =>
    `<a class="${css.mdLink}" href="${sanitizeHref(url)}" data-external-link="true">${url}</a>`
  );

  // Step 4: Restore placeholders
  result = result.replace(/\x00LINK(\d+)\x00/g, (_, idx) => placeholders[parseInt(idx, 10)] ?? "");

  return result;
}
