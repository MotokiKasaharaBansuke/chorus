# Chorus

macOS desktop app for managing multiple AI coding assistants (Claude Code / Codex) in parallel panes.

## Tech Stack

- **Backend**: Tauri 2 (Rust) + portable-pty
- **Frontend**: SolidJS + TypeScript + xterm.js (WebGL)
- **Build**: Vite 6 + Cargo

## Commands

```bash
pnpm tauri dev      # Dev mode
pnpm tauri build    # Release build (.app + .dmg)
pnpm build          # Frontend only
pnpm vitest run     # Run tests
```

## Directory Structure

- `src/` - SolidJS frontend
  - `components/` - UI components (CSS Modules)
  - `stores/` - SolidJS stores (state only, no IPC)
  - `hooks/` - Custom hooks (keyboard shortcuts, resize, bottom terminal)
  - `lib/commands/` - Tauri IPC wrappers
  - `lib/layout/` - Layout tree pure functions
  - `lib/parsers/` - PTY output parsers
  - `types/` - TypeScript type definitions
- `src-tauri/src/` - Rust backend
  - `pty/` - PTY session management
  - `commands/` - Tauri commands
  - `cli/` - CLI definitions (binary path detection, arg building)
  - `fs/` - File tree traversal
  - `error.rs` - Shared error type

## Design Principles

- Stores manage state only. IPC goes through `lib/commands/`
- Tab ID = PTY ID (1:1 mapping)
- PTY output batched at 16ms intervals
- VS Code-style pane groups with tab drag-and-drop
- Layout tree as a recursive binary split (immutable pure functions)
- Temp images stored in `/tmp/chorus-images/`, with 3-stage cleanup
