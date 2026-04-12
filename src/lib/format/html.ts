/** Sanitize href: block dangerous protocols */
export function sanitizeHref(url: string): string {
  const trimmed = url.trim().toLowerCase();
  if (trimmed.startsWith("javascript:") || trimmed.startsWith("data:") || trimmed.startsWith("vbscript:")) {
    return "#";
  }
  return url.replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Escape HTML entities */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Simple syntax highlighting for diff lines (VS Code Dark+ palette) */
export function highlightDiffLine(line: string): string {
  // Always escape first to prevent XSS via innerHTML
  let html = escapeHtml(line);
  // Strings
  html = html.replace(/(["'`])(?:(?!\1|\\).|\\.)*\1/g, '<span style="color:#ce9178">$&</span>');
  // Comments
  html = html.replace(/(\/\/.*$)/gm, '<span style="color:#6a9955">$&</span>');
  // Keywords
  html = html.replace(/\b(import|export|from|const|let|var|function|return|if|else|for|while|class|interface|type|async|await|new|this|true|false|null|undefined|extends|implements)\b/g,
    '<span style="color:#c586c0">$&</span>');
  // Types / classes (PascalCase)
  html = html.replace(/\b([A-Z][a-zA-Z0-9]+)\b/g, '<span style="color:#4ec9b0">$&</span>');
  // Numbers
  html = html.replace(/\b(\d+\.?\d*)\b/g, '<span style="color:#b5cea8">$&</span>');
  return html;
}
