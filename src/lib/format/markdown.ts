import { escapeHtml } from "./html";

/**
 * Convert a markdown text block into an HTML string.
 * Handles headings, lists, checkboxes, tables, horizontal rules, and inline formatting.
 *
 * @param applyInline - function to apply inline formatting (bold, italic, code, links)
 * @param cssClasses - CSS module class names for styling
 */
export function formatInline(
  text: string,
  applyInline: (s: string) => string,
  cssClasses: Record<string, string>,
): string {
  const lines = text.split("\n");
  const result: string[] = [];
  let inList = false;
  let tableLines: string[] = [];

  const flushList = () => { if (inList) { result.push("</ul>"); inList = false; } };
  const flushTableBlock = () => {
    if (tableLines.length > 0) {
      result.push(flushTable(tableLines, applyInline, cssClasses));
      tableLines = [];
    }
  };

  for (const rawLine of lines) {
    const line = escapeHtml(rawLine);

    // Table row
    if (line.match(/^\|/)) {
      flushList();
      tableLines.push(line); // already escaped
      continue;
    }
    flushTableBlock();

    // Headings
    const h3Match = line.match(/^### (.+)/);
    if (h3Match) { flushList(); result.push(`<h4 class="${cssClasses.mdH3}">${applyInline(h3Match[1])}</h4>`); continue; }
    const h2Match = line.match(/^## (.+)/);
    if (h2Match) { flushList(); result.push(`<h3 class="${cssClasses.mdH2}">${applyInline(h2Match[1])}</h3>`); continue; }
    const h1Match = line.match(/^# (.+)/);
    if (h1Match) { flushList(); result.push(`<h2 class="${cssClasses.mdH1}">${applyInline(h1Match[1])}</h2>`); continue; }

    // Horizontal rule
    if (line.match(/^---+$/)) { flushList(); result.push(`<hr class="${cssClasses.mdHr}"/>`); continue; }

    // Checkbox list
    const cbMatch = line.match(/^[-*] \[([ xX✓✅])\] (.+)/);
    if (cbMatch) {
      if (!inList) { result.push(`<ul class="${cssClasses.mdList}" style="list-style:none;padding-left:4px;">`); inList = true; }
      const checked = cbMatch[1] !== " ";
      const icon = checked ? "✅" : "☐";
      const textStyle = checked ? 'style="text-decoration:line-through;opacity:0.6"' : "";
      result.push(`<li><span style="margin-right:4px">${icon}</span><span ${textStyle}>${applyInline(cbMatch[2])}</span></li>`);
      continue;
    }

    // Unordered list
    const liMatch = line.match(/^[-*] (.+)/);
    if (liMatch) {
      if (!inList) { result.push(`<ul class="${cssClasses.mdList}">`); inList = true; }
      result.push(`<li>${applyInline(liMatch[1])}</li>`);
      continue;
    }

    // Numbered list
    const olMatch = line.match(/^\d+\.\s+(.+)/);
    if (olMatch) {
      if (!inList) { result.push(`<ul class="${cssClasses.mdList}" style="list-style:decimal">`); inList = true; }
      result.push(`<li>${applyInline(olMatch[1])}</li>`);
      continue;
    }

    flushList();

    // Empty line
    if (line.trim() === "") { result.push("<br/>"); continue; }

    result.push(applyInline(line));
    result.push("<br/>");
  }

  flushList();
  flushTableBlock();
  return result.join("");
}

function flushTable(
  tableLines: string[],
  applyInline: (s: string) => string,
  cssClasses: Record<string, string>,
): string {
  const rows = tableLines
    .map(line => line.split("|").slice(1, -1).map(c => c.trim())) // already escaped
    .filter(row => !row.every(c => /^[-: ]+$/.test(c)));
  if (rows.length === 0) return "";
  const [headers, ...data] = rows;
  const ths = (headers ?? []).map(h => `<th>${applyInline(h)}</th>`).join("");
  const trs = data.map(row =>
    `<tr>${row.map(cell => `<td>${applyInline(cell)}</td>`).join("")}</tr>`
  ).join("");
  return `<table class="${cssClasses.mdTable}"><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table>`;
}
