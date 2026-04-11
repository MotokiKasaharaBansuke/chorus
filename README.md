# Chorus

A macOS desktop app for running multiple AI coding assistants side by side. Manage Claude Code and Codex sessions in parallel panes with a VS Code-inspired split layout.

## Features

- **Multi-pane layout** — Run Claude Code and Codex sessions simultaneously in resizable split panes
- **VS Code-style tabs** — Drag tabs between pane groups or drop on edges to create new splits
- **File viewer** — Open project files as tabs alongside your AI sessions
- **Image support** — Paste or drag-and-drop images into chat (displayed as thumbnails)
- **Quick launch** — `⌘1` for Claude Code, `⌘2` for Codex (opens in a new split)
- **Equalize panes** — One click to distribute pane sizes evenly (`⌘E`)
- **Input history** — Arrow up/down to recall previous messages
- **Model picker** — Switch between Claude/Codex models per session
- **Sidebar** — File tree explorer with syntax-highlighted file viewer
- **Bottom terminal** — Integrated shell terminal panel
- **Configurable** — Font size, launch mode (default/plan/bypass-permissions), and zoom level

## Requirements

- macOS (Apple Silicon or Intel)
- [Rust](https://rustup.rs/) (for building the Tauri backend)
- [Node.js](https://nodejs.org/) 22+
- [pnpm](https://pnpm.io/)

## Getting Started

```bash
# Install dependencies
pnpm install

# Run in development mode
pnpm tauri dev

# Open with a specific project directory
pnpm tauri dev -- -- --directory=/path/to/your/project

# Build for production (.app + .dmg)
pnpm tauri build
```

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `⌘T` | New pane (opens settings modal) |
| `⌘1` | Quick-launch Claude Code in new split |
| `⌘2` | Quick-launch Codex in new split |
| `⌘W` | Close active tab |
| `⌘E` | Equalize pane sizes |
| `⌘B` | Toggle sidebar |
| `` ⌘` `` | Toggle bottom terminal |
| `⌘+` / `⌘-` | Zoom in / out |
| `⌘0` | Reset zoom |
| `↑` / `↓` | Input history navigation |
| `Shift+Tab` | Cycle permission mode |

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Desktop runtime | [Tauri 2](https://v2.tauri.app/) (Rust) |
| Terminal emulation | [portable-pty](https://crates.io/crates/portable-pty) + [xterm.js](https://xtermjs.org/) (WebGL) |
| Frontend framework | [SolidJS](https://www.solidjs.com/) |
| Build tooling | [Vite 6](https://vite.dev/) |
| Styling | CSS Modules |
| Testing | [Vitest](https://vitest.dev/) |

## Architecture

```
┌──────────────────────────────────────────────┐
│                  Top Bar                     │
├────────┬─────────────────────────────────────┤
│        │  ┌─────────┬─────────┬─────────┐   │
│  Side  │  │ Tab Bar │ Tab Bar │ Tab Bar │   │
│  bar   │  ├─────────┼─────────┼─────────┤   │
│        │  │ Claude  │  Codex  │  File   │   │
│ (file  │  │  Code   │         │ Viewer  │   │
│  tree) │  │ session │ session │         │   │
│        │  └─────────┴─────────┴─────────┘   │
├────────┴─────────────────────────────────────┤
│              Bottom Terminal                 │
└──────────────────────────────────────────────┘
```

The layout uses a **recursive binary split tree**. Each leaf node is a **PaneGroup** containing one or more tabs. Splits can be horizontal or vertical, and ratios are adjustable by dragging the divider.

## Project Structure

```
src/
├── components/
│   ├── chat/          # Chat panel, input, message bubbles
│   ├── layout/        # PaneGroup, ResizableSplit, LayoutRenderer
│   ├── top-bar/       # Top bar with settings dropdown
│   ├── sidebar/       # File tree and file viewer
│   ├── terminal/      # xterm.js terminal panel
│   └── settings/      # CLI settings modal
├── hooks/             # useKeyboardShortcuts, useBottomTerminal, useResizeHandle
├── stores/            # SolidJS stores (tab-store, sidebar-store)
├── lib/
│   ├── commands/      # Tauri IPC wrappers
│   ├── layout/        # Layout tree pure functions + tests
│   └── parsers/       # PTY output parsers
└── types/             # TypeScript type definitions

src-tauri/src/
├── pty/               # PTY session management
├── commands/          # Tauri command handlers
├── cli/               # CLI binary detection and arg building
└── fs/                # File system operations
```

## Development

```bash
# Run tests
pnpm vitest run

# Run tests in watch mode
pnpm vitest

# Build frontend only (for checking TypeScript errors)
pnpm build
```

## License

MIT
