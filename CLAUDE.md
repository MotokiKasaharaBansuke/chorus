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

## Release

- **release-please** でバージョン管理を自動化
- `feat:` / `fix:` などの Conventional Commits プレフィックスからバージョンを自動決定
- mainにマージされると release-please が自動でバンプPRを作成
- バンプPRをマージ → `v*` タグ自動作成 → GitHub Actions でビルド・リリース
- **手動でのバージョンバンプは不要**（package.json, Cargo.toml, tauri.conf.json は release-please が更新）
- バージョンは3箇所で同期が必要: `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`

### コミットメッセージとバージョンの関係

| プレフィックス | バージョン変更 | 例 |
|---|---|---|
| `feat:` | minor (0.x.0) | `feat: セッション復元機能を追加` |
| `fix:` | patch (0.0.x) | `fix: 画像D&Dが動かない問題を修正` |
| `feat!:` / `BREAKING CHANGE` | major (x.0.0) | `feat!: 設定ファイル形式を変更` |
| `chore:` / `refactor:` / `docs:` | バージョン変更なし | `chore: lint設定を更新` |

## Design Principles

- Stores manage state only. IPC goes through `lib/commands/`
- Tab ID = PTY ID (1:1 mapping)
- PTY output batched at 16ms intervals
- VS Code-style pane groups with tab drag-and-drop
- Layout tree as a recursive binary split (immutable pure functions)
- Temp images stored in `/tmp/chorus-images/`, with 3-stage cleanup
