import styles from "./sidebar.module.css";

interface FileIconProps {
  name: string;
  isDirectory: boolean;
  isExpanded?: boolean;
  isSymlink?: boolean;
}

// Seti icon font character + color mappings (from Cursor's default theme)
const EXT_ICONS: Record<string, [string, string]> = {
  ts:   ["\uE099", "#519aba"],
  tsx:  ["\uE07D", "#519aba"],
  js:   ["\uE051", "#cbcb41"],
  jsx:  ["\uE07D", "#519aba"],
  mjs:  ["\uE051", "#cbcb41"],
  cjs:  ["\uE051", "#cbcb41"],
  json: ["\uE055", "#cbcb41"],
  css:  ["\uE01D", "#519aba"],
  scss: ["\uE084", "#f55385"],
  html: ["\uE048", "#e37933"],
  md:   ["\uE060", "#519aba"],
  mdx:  ["\uE060", "#519aba"],
  rs:   ["\uE082", "#6d8086"],
  py:   ["\uE07B", "#519aba"],
  go:   ["\uE03A", "#519aba"],
  yaml: ["\uE0A7", "#a074c4"],
  yml:  ["\uE0A7", "#a074c4"],
  toml: ["\uE019", "#6d8086"],
  svg:  ["\uE091", "#a074c4"],
  png:  ["\uE04C", "#a074c4"],
  jpg:  ["\uE04C", "#a074c4"],
  jpeg: ["\uE04C", "#a074c4"],
  gif:  ["\uE04C", "#a074c4"],
  webp: ["\uE04C", "#a074c4"],
  ico:  ["\uE02F", "#cbcb41"],
  sh:   ["\uE089", "#8dc149"],
  bash: ["\uE089", "#8dc149"],
  zsh:  ["\uE089", "#8dc149"],
  sql:  ["\uE022", "#f55385"],
  lock: ["\uE055", "#6d8086"],
  env:  ["\uE019", "#6d8086"],
  log:  ["\uE023", "#6d8086"],
  txt:  ["\uE023", "#d4d7d6"],
  xml:  ["\uE048", "#e37933"],
};

const FILENAME_ICONS: Record<string, [string, string]> = {
  "dockerfile":      ["\uE025", "#519aba"],
  ".dockerignore":   ["\uE025", "#6d8086"],
  ".gitignore":      ["\uE034", "#41535b"],
  ".gitattributes":  ["\uE034", "#41535b"],
  "package.json":    ["\uE055", "#8dc149"],
  "tsconfig.json":   ["\uE097", "#519aba"],
  "tsconfig.node.json": ["\uE097", "#519aba"],
  "cargo.toml":      ["\uE082", "#6d8086"],
  "cargo.lock":      ["\uE082", "#6d8086"],
  ".env":            ["\uE019", "#8dc149"],
  ".env.local":      ["\uE019", "#8dc149"],
};

const DEFAULT_ICON: [string, string] = ["\uE023", "#d4d7d6"];
const FOLDER_ICON = "\uE017";
const FOLDER_OPEN_ICON = "\uE018";
const FOLDER_COLOR = "#c09553";

function getExt(name: string): string {
  if (name.startsWith(".")) return name.slice(1);
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1) : "";
}

export function FileIcon(props: FileIconProps) {
  if (props.isDirectory) {
    return (
      <span class={styles.setiIcon} style={{ color: FOLDER_COLOR }}>
        {props.isExpanded ? FOLDER_OPEN_ICON : FOLDER_ICON}
      </span>
    );
  }

  const lower = props.name.toLowerCase();
  const special = FILENAME_ICONS[lower];
  if (special) {
    return <span class={styles.setiIcon} style={{ color: special[1] }}>{special[0]}</span>;
  }

  // Check .env* pattern
  if (lower.startsWith(".env")) {
    const env = FILENAME_ICONS[".env"];
    if (env) return <span class={styles.setiIcon} style={{ color: env[1] }}>{env[0]}</span>;
  }

  const ext = getExt(lower);
  const icon = EXT_ICONS[ext] ?? DEFAULT_ICON;

  return <span class={styles.setiIcon} style={{ color: icon[1] }}>{icon[0]}</span>;
}
