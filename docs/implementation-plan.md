# multi-llm 実装計画書

## 1. プロジェクト概要

### 目的

複数の AI コーディングアシスタント（Claude Code CLI / Codex）を並列にタブ管理し、macOS 上で軽量に動作するデスクトップアプリケーションを構築する。

### 解決する課題

| 課題 | 現状 | multi-llm での解決 |
|------|------|-------------------|
| 並列作業の困難さ | ターミナルを複数開き、手動で切り替え | タブ/グリッドで一覧管理、ステータスで進捗把握 |
| 画像添付の不便さ | CLI は画像をパスで指定する必要がある | ドラッグ&ドロップ / クリップボードペーストで添付 |
| 入力編集の制約 | ターミナルの1行入力で編集しにくい | リッチテキストエリアで複数行編集可能 |
| 出力の視認性 | ターミナルの生テキストで見にくい | xterm.js WebGL レンダリングで高品質表示 |
| リソース消費 | Cursor は Electron ベースでメモリ消費が激しい | Tauri 2 (WKWebView) + SolidJS で軽量動作 |

---

## 2. 技術スタック

### フロントエンド

| 技術 | バージョン | 選定理由 |
|------|-----------|---------|
| SolidJS | 1.9+ | Fine-grained reactivity で仮想 DOM なし。React より高速でバンドルサイズ小 |
| TypeScript | 5.5+ | 型安全性の確保 |
| xterm.js | 5.5+ | ブラウザベースターミナルエミュレータのデファクト |
| @xterm/addon-webgl | 0.18+ | GPU アクセラレーション描画 |
| @xterm/addon-fit | 0.10+ | コンテナリサイズ追従 |
| Vite | 6+ | 高速ビルド、Tauri 公式サポート |

### バックエンド (Rust)

| 技術 | 選定理由 |
|------|---------|
| Tauri 2 | Electron 比でメモリ 1/10、バイナリサイズ 1/5。macOS WKWebView 活用 |
| portable-pty | クロスプラットフォーム PTY 管理 |
| tokio | 非同期ランタイム。PTY I/O の並列処理 |
| tracing | 構造化ログ出力。PTY ライフサイクル・エラーのデバッグ用 |
| notify | ファイルシステム監視（サイドバー更新用） |
| ignore | .gitignore パース（ripgrep と同じライブラリ） |
| serde / serde_json | Tauri コマンドの JSON シリアライズ |

### CSS 方針

- CSS Modules（`.module.css`）を採用し、クラス名の衝突を防止
- グローバルスタイルは `index.css` のみ

### SolidJS Store 方針

- `createStore` を使用し、`produce` / `reconcile` による immutable 更新パターン
- Store は状態管理のみに専念し、Tauri IPC 呼び出しは `lib/commands/` 経由で行う
- Store 間の依存は Context API で管理

---

## 3. アーキテクチャ図

```
┌─────────────────────────────────────────────────────────┐
│                    macOS Application                     │
│                                                         │
│  ┌───────────────────────────────────────────────────┐  │
│  │              SolidJS Frontend (WKWebView)          │  │
│  │                                                   │  │
│  │  ┌─────────┐  ┌─────────────────────────────┐    │  │
│  │  │Sidebar  │  │  Tab Container               │    │  │
│  │  │         │  │  ┌─────────┐  ┌─────────┐   │    │  │
│  │  │ File    │  │  │ Tab 1   │  │ Tab 2   │   │    │  │
│  │  │ Tree    │  │  │┌───────┐│  │┌───────┐│   │    │  │
│  │  │         │  │  ││xterm  ││  ││xterm  ││   │    │  │
│  │  │         │  │  │└───────┘│  │└───────┘│   │    │  │
│  │  │         │  │  │┌───────┐│  │┌───────┐│   │    │  │
│  │  │         │  │  ││Input  ││  ││Input  ││   │    │  │
│  │  │         │  │  │└───────┘│  │└───────┘│   │    │  │
│  │  └─────────┘  └─────────────────────────────┘    │  │
│  └───────────────────────────────────────────────────┘  │
│                         │                               │
│                   Tauri IPC Bridge                       │
│                         │                               │
│  ┌───────────────────────────────────────────────────┐  │
│  │              Rust Backend (Tauri Core)             │  │
│  │                                                   │  │
│  │  ┌──────────┐  ┌──────────┐  ┌───────────────┐   │  │
│  │  │PTY       │  │File      │  │CLI            │   │  │
│  │  │Manager   │  │System    │  │Registry       │   │  │
│  │  │          │  │Watcher   │  │               │   │  │
│  │  │ PTY 1    │  │          │  │ claude-code   │   │  │
│  │  │ PTY 2    │  │ notify   │  │ codex         │   │  │
│  │  │ PTY N    │  │          │  │               │   │  │
│  │  └──────────┘  └──────────┘  └───────────────┘   │  │
│  └───────────────────────────────────────────────────┘  │
│                         │                               │
│              ┌──────────┴──────────┐                    │
│              │   OS PTY (macOS)    │                    │
│              │  /bin/zsh sessions  │                    │
│              └─────────────────────┘                    │
└─────────────────────────────────────────────────────────┘
```

---

## 4. ディレクトリ構成

```
multi-llm/
├── CLAUDE.md
├── package.json
├── tsconfig.json
├── vite.config.ts
├── docs/
│   └── implementation-plan.md          # 本ドキュメント
│
├── src/                                # SolidJS フロントエンド
│   ├── index.tsx                       # エントリポイント
│   ├── app.tsx                         # ルートコンポーネント
│   ├── index.css                       # グローバルスタイル
│   │
│   ├── components/
│   │   ├── tab-bar/
│   │   │   ├── tab-bar.tsx             # タブバー本体
│   │   │   ├── tab-bar.module.css
│   │   │   ├── tab-item.tsx            # 個別タブ
│   │   │   └── tab-item.test.tsx
│   │   │
│   │   ├── terminal/
│   │   │   ├── terminal-panel.tsx      # xterm.js ラッパー
│   │   │   ├── terminal-panel.module.css
│   │   │   ├── terminal-panel.test.tsx
│   │   │   └── use-terminal.ts         # xterm.js 初期化フック
│   │   │
│   │   ├── input/
│   │   │   ├── rich-input.tsx          # リッチ入力コンポーネント
│   │   │   ├── rich-input.module.css
│   │   │   ├── rich-input.test.tsx
│   │   │   ├── image-attachment.tsx    # 画像添付 UI
│   │   │   └── use-image-drop.ts       # D&D / ペーストフック
│   │   │
│   │   ├── sidebar/
│   │   │   ├── sidebar.tsx             # サイドバー本体
│   │   │   ├── sidebar.module.css
│   │   │   ├── file-tree.tsx           # ファイルツリー
│   │   │   ├── file-tree.test.tsx
│   │   │   ├── file-node.tsx           # ツリーノード
│   │   │   ├── file-preview.tsx        # ファイルプレビュー
│   │   │   └── use-file-tree.ts        # 遅延ロードフック
│   │   │
│   │   ├── status/
│   │   │   ├── status-indicator.tsx    # ステータスドット
│   │   │   └── status-indicator.test.tsx
│   │   │
│   │   ├── layout/
│   │   │   ├── split-pane.tsx          # リサイズ可能分割パネル
│   │   │   ├── grid-container.tsx      # タブグリッドレイアウト
│   │   │   └── grid-container.test.tsx
│   │   │
│   │   └── settings/
│   │       ├── cli-settings-modal.tsx  # CLI 起動設定モーダル
│   │       └── cli-settings-modal.test.tsx
│   │
│   ├── stores/
│   │   ├── tab-store.ts                # タブ状態管理（状態のみ、IPC 呼び出しなし）
│   │   ├── tab-store.test.ts
│   │   ├── sidebar-store.ts            # サイドバー状態
│   │   └── settings-store.ts           # 設定状態
│   │
│   ├── lib/
│   │   ├── commands/                   # Tauri IPC ラッパー（Rust側と対称構造）
│   │   │   ├── pty-commands.ts         # PTY 操作コマンド
│   │   │   ├── fs-commands.ts          # ファイル操作コマンド
│   │   │   ├── cli-commands.ts         # CLI 起動コマンド
│   │   │   └── image-commands.ts       # 画像一時保存コマンド
│   │   │
│   │   ├── parsers/                    # PTY 出力パーサー
│   │   │   ├── pty-output-parser.ts    # パーサー本体
│   │   │   ├── pty-output-parser.test.ts
│   │   │   ├── claude-code-patterns.ts # Claude Code 固有パターン
│   │   │   └── codex-patterns.ts       # Codex 固有パターン
│   │   │
│   │   ├── keyboard-shortcuts.ts       # ショートカット管理
│   │   ├── keyboard-shortcuts.test.ts
│   │   ├── image-encoder.ts            # 画像 Base64 エンコード
│   │   └── image-encoder.test.ts
│   │
│   └── types/
│       ├── index.ts                    # バレルファイル
│       ├── tab.ts                      # タブ + ステータス型定義
│       ├── cli-config.ts               # CLI 設定型定義
│       └── file-tree.ts                # ファイルツリー型定義（フェーズ4で追加）
│
├── src-tauri/                          # Rust バックエンド
│   ├── Cargo.toml
│   ├── tauri.conf.json                 # permissions 設定含む
│   ├── build.rs
│   ├── icons/
│   │
│   └── src/
│       ├── main.rs                     # エントリポイント
│       ├── lib.rs                      # モジュール公開
│       ├── error.rs                    # 共通エラー型 AppError
│       │
│       ├── pty/
│       │   ├── mod.rs
│       │   ├── manager.rs              # PTY ライフサイクル管理
│       │   ├── session.rs              # 個別 PTY セッション
│       │   └── output_buffer.rs        # 16ms バッチバッファ
│       │
│       ├── commands/
│       │   ├── mod.rs
│       │   ├── pty_commands.rs         # PTY 操作 Tauri コマンド
│       │   ├── fs_commands.rs          # ファイルシステムコマンド
│       │   ├── cli_commands.rs         # CLI 起動コマンド
│       │   └── image_commands.rs       # 画像一時保存コマンド
│       │
│       ├── fs/
│       │   ├── mod.rs
│       │   ├── watcher.rs              # ファイル変更監視
│       │   └── tree.rs                 # ディレクトリツリー構築
│       │
│       └── cli/
│           ├── mod.rs
│           └── registry.rs             # CLI 定義情報（バイナリパス、引数パターン）
│
└── tests/
    └── e2e/
        └── basic-flow.test.ts          # E2E テスト
```

---

## 5. 型設計

### Rust 側

```rust
// src-tauri/src/error.rs
#[derive(Debug, thiserror::Error, serde::Serialize)]
enum AppError {
    #[error("PTY spawn failed: {0}")]
    PtySpawnFailed(String),
    #[error("PTY not found: {0}")]
    PtyNotFound(String),
    #[error("PTY write failed: {0}")]
    PtyWriteFailed(String),
    #[error("File system error: {0}")]
    FileSystemError(String),
    #[error("CLI not found: {0}")]
    CliNotFound(String),
    #[error("Image save failed: {0}")]
    ImageSaveFailed(String),
}

// src-tauri/src/cli/registry.rs
#[derive(Debug, Clone, serde::Deserialize)]
enum CliType {
    ClaudeCode,
    Codex,
    Shell,
}

#[derive(Debug, Clone, serde::Deserialize)]
enum CliMode {
    Default,
    Plan,
    DangerouslySkipPermissions,
}

// src-tauri/src/pty/manager.rs
#[derive(Debug, serde::Deserialize)]
struct PtySpawnConfig {
    cli_type: CliType,
    mode: CliMode,
    model: Option<String>,
    working_dir: String,
}
```

### TypeScript 側

```typescript
// src/types/tab.ts
type TabStatus = "idle" | "running" | "waiting" | "completed" | "error";

type CliType = "claude-code" | "codex" | "shell";

type CliMode = "default" | "plan" | "dangerously-skip-permissions";

interface Tab {
    id: string;           // タブID = PTY ID（1:1対応）
    title: string;
    status: TabStatus;
    cliConfig: CliConfig;
}

interface TabStoreState {
    tabs: ReadonlyArray<Tab>;
    activeTabId: string | null;
    layout: "horizontal" | "grid";
}

// src/types/cli-config.ts
interface CliConfig {
    cliType: CliType;
    mode: CliMode;
    model?: string;
    workingDir: string;
}
```

---

## 6. セキュリティ設計

### 6.1 dangerously-skip-permissions モードのガード

このモードは CLI にファイル削除やコマンド実行を無確認で許可するため、以下の安全策を必須とする。

| 安全策 | 詳細 |
|--------|------|
| 確認ダイアログ | モード選択時に「このモードはファイル削除等を無確認で実行します」と警告し、明示的な確認を要求 |
| 視覚的警告 | タブに赤色の警告バッジ `⚠ DANGEROUS` を常時表示。タブ名の背景色も変更 |
| 型安全 | `mode` は `String` ではなく Rust `enum CliMode` / TS union type で定義（上記型設計参照） |

### 6.2 PTY セキュリティ境界

| 対策 | 詳細 |
|------|------|
| CSP 設定 | `tauri.conf.json` で Content-Security-Policy を設定し、WebView からの不正なスクリプト実行を防止 |
| IPC 制限 | Tauri コマンドの呼び出し元を WebView に限定（Tauri デフォルト） |
| データサイズ上限 | `write_pty` に書き込むデータの上限を 1MB に設定 |

### 6.3 画像一時ファイル管理

| 項目 | 仕様 |
|------|------|
| 保存先 | アプリ専用ディレクトリ `/tmp/multi-llm-{app-session-uuid}/` |
| パーミッション | ファイル `0600`、ディレクトリ `0700` |
| クリーンアップ | 送信完了後に即削除。タブ閉じ時に残存ファイル削除。アプリ終了時に全削除 |
| コマンド定義 | `image_commands.rs` に `save_temp_image(data: Vec<u8>) -> Result<String, AppError>` |

### 6.4 Tauri 2 permissions 設定

`tauri.conf.json` で使用する機能ごとに permission を明示的に定義する。

```json
{
  "permissions": [
    "core:default",
    "dialog:default",
    "store:default",
    "shell:allow-spawn",
    "fs:allow-read",
    "fs:allow-write"
  ]
}
```

### 6.5 ログ設計

| 項目 | 仕様 |
|------|------|
| ライブラリ | `tracing` + `tracing-appender` |
| 保存先 | `~/Library/Logs/multi-llm/` |
| ログ対象 | PTY 起動/終了/エラー、IPC コマンド実行、ファイル操作エラー |
| ローテーション | 日次ローテーション、7日保持 |

---

## 7. フェーズ分け実装計画

### フェーズ 1: 基盤構築

**成果物**: Tauri アプリが起動し、単一タブで PTY セッションが動作する

| # | タスク | 詳細 |
|---|--------|------|
| 1.1 | Rust 環境構築 | rustup インストール |
| 1.2 | プロジェクト初期化 | Tauri 2 + SolidJS テンプレート生成 |
| 1.3 | Cargo.toml 設定 | portable-pty / tokio / serde / tracing 追加 |
| 1.4 | 共通エラー型定義 | `error.rs` に `AppError` enum 定義 |
| 1.5 | PTY Manager 実装 | `pty/manager.rs` - PTY の作成・破棄・一覧管理 |
| 1.6 | PTY Session 実装 | `pty/session.rs` - 単一 PTY の読み書き |
| 1.7 | 出力バッチバッファ | `pty/output_buffer.rs` - 16ms 間隔バッチ送信 |
| 1.8 | PTY 終了処理 | SIGTERM → 5秒タイムアウト → SIGKILL のエスカレーション |
| 1.9 | Tauri コマンド定義 | `pty_commands.rs` - spawn / write / resize / kill |
| 1.10 | Tauri イベント設定 | 単一イベント `pty-output` にペイロードで PTY ID を含める |
| 1.11 | アプリ終了フック | `on_exit` で全 PTY を強制終了 |
| 1.12 | xterm.js 統合 | `use-terminal.ts` - xterm.js + WebGL + fit 初期化 |
| 1.13 | TerminalPanel 実装 | xterm.js マウント、Tauri イベント接続 |
| 1.14 | cleanup 処理 | `onCleanup` で terminal.dispose / addon.dispose / unlisten / ResizeObserver.disconnect |
| 1.15 | 動作確認 | アプリ起動 → シェルでコマンド実行可能 |

### フェーズ 2: タブ管理

**成果物**: 複数タブの作成・切替・クローズ、グリッドレイアウトが動作する

| # | タスク | 詳細 |
|---|--------|------|
| 2.1 | tab-store 実装 | タブ一覧・アクティブタブ・レイアウト状態管理（状態のみ、IPC なし） |
| 2.2 | タブ数上限 | 最大 20 タブ。上限時 Cmd+T を無効化し通知表示 |
| 2.3 | TabBar 実装 | タブバー UI、均等幅 `flex: 1` レイアウト |
| 2.4 | TabItem 実装 | タブ名・ステータスインジケータ・閉じるボタン |
| 2.5 | GridContainer 実装 | コンテナ幅 ÷ タブ数 < 400px で自動2行化 |
| 2.6 | SplitPane 実装 | ドラッグリサイズ（上下・左右） |
| 2.7 | キーボードショートカット | Cmd+T / Cmd+W / Cmd+1-9 / Cmd+Shift+E |
| 2.8 | タブ-PTY 紐付け | タブ ID = PTY ID（1:1対応）。タブ閉じ時に PTY kill |
| 2.9 | xterm.js fit 対応 | リサイズ時に fitAddon.fit() + PTY resize 同期 |
| 2.10 | scrollback 管理 | アクティブタブ: 10,000行、非アクティブタブ: 1,000行 |

### フェーズ 3: ステータス表示

**成果物**: 各タブの CLI 実行状態がリアルタイムに表示される

| # | タスク | 詳細 |
|---|--------|------|
| 3.1 | StatusIndicator 実装 | 5 状態のドットアニメーション |
| 3.2 | PTY 出力パーサー本体 | `parsers/pty-output-parser.ts` - ANSI エスケープ除去後にパターンマッチ |
| 3.3 | Claude Code パターン | `parsers/claude-code-patterns.ts` に分離定義 |
| 3.4 | Codex パターン | `parsers/codex-patterns.ts` に分離定義 |
| 3.5 | ステータス自動更新 | PTY 出力を解析し tab-store を更新 |
| 3.6 | PTY 終了検出 | EOF / exit code 検出 → completed or error |
| 3.7 | 再起動ボタン | error 状態のタブに「再起動」ボタン表示。同じ設定で PTY 再作成 |

### フェーズ 4: サイドバー

**成果物**: ファイルツリー表示とプレビューが動作する

| # | タスク | 詳細 |
|---|--------|------|
| 4.1 | fs_commands 実装 | `list_directory` / `read_file` Tauri コマンド |
| 4.2 | ignore crate 統合 | .gitignore ルールでフィルタリング |
| 4.3 | シンボリックリンク対策 | リンクは辿らずリンクとして表示。深さ上限 20 階層 |
| 4.4 | ファイルサイズ制限 | プレビュー上限 1MB。超過時は「ファイルが大きすぎます」表示。バイナリは拡張子判定で除外 |
| 4.5 | ディレクトリツリー構築 | `tree.rs` - 遅延ロード対応ツリーデータ |
| 4.6 | FileTree コンポーネント | 仮想スクロール対応ツリー表示 |
| 4.7 | FileNode コンポーネント | 展開/折りたたみ、アイコン、インデント |
| 4.8 | use-file-tree フック | ノード展開時にサブディレクトリ非同期取得 |
| 4.9 | FilePreview 実装 | ファイルクリックで内容プレビュー（shiki） |
| 4.10 | ファイル監視 | .gitignore フィルタ後のディレクトリのみ監視。大規模時はポーリングフォールバック |
| 4.11 | サイドバーリサイズ | ドラッグで幅変更 |
| 4.12 | types/file-tree.ts 追加 | ファイルツリー型定義を追加 |

### フェーズ 5: CLI 起動設定

**成果物**: Claude Code / Codex を各種モードで起動可能

| # | タスク | 詳細 |
|---|--------|------|
| 5.1 | CLI 設定型定義 | `types/cli-config.ts` - CliType, CliMode, CliConfig |
| 5.2 | cli_commands 実装 | CLI バイナリパス検出、起動コマンド組み立て |
| 5.3 | CLI 未インストール検出 | バイナリ不在時にエラーメッセージ + インストール手順リンク表示 |
| 5.4 | dangerousモード確認UI | 選択時に確認ダイアログ + タブに赤色警告バッジ常時表示 |
| 5.5 | CLISettingsModal 実装 | CLI 種別・モード・モデル・作業ディレクトリ選択 |
| 5.6 | settings-store 実装 | 設定の永続化（Tauri store plugin） |
| 5.7 | タブ作成フロー改修 | Cmd+T → 設定モーダル → CLI 起動 → PTY 接続 |
| 5.8 | デフォルト設定 | 前回の設定を記憶、ワンクリック起動 |

### フェーズ 6: リッチ入力

**成果物**: 画像添付・複数行入力が動作する

| # | タスク | 詳細 |
|---|--------|------|
| 6.1 | WKWebView 動作検証 | `contentEditable` / `textarea` の IME・ペースト動作を先行検証 |
| 6.2 | RichInput 実装 | `textarea` ベース（IME 安全）。Shift+Enter で改行、Enter で送信 |
| 6.3 | IME 対策 | `compositionstart` / `compositionend` 監視。コンポジション中は Enter 送信を抑制 |
| 6.4 | use-image-drop フック | ドラッグ&ドロップイベントハンドリング |
| 6.5 | クリップボード画像ペースト | Cmd+V で画像データ取得。ペースト時は `text/plain` のみ取得 |
| 6.6 | image-encoder 実装 | File/Blob → Base64 エンコード |
| 6.7 | image_commands 実装 | Rust 側で専用ディレクトリに保存、パーミッション 0600 |
| 6.8 | 一時ファイルクリーンアップ | 送信後即削除、タブ閉じ時残存削除、アプリ終了時全削除 |
| 6.9 | ImageAttachment UI | 添付画像のサムネイル・削除 |
| 6.10 | 入力送信フロー | Enter → 画像パス付きプロンプトを PTY に write |

### フェーズ 7: パフォーマンス最適化・仕上げ

**成果物**: 本番品質のアプリケーション

| # | タスク | 詳細 |
|---|--------|------|
| 7.1 | WebGL レンダリング確認 | canvas フォールバック含む動作検証 |
| 7.2 | メモリリーク調査 | タブ高速開閉 100 回での検証。cleanup チェックリスト確認 |
| 7.3 | バッチ処理チューニング | 16ms バッファの実測と調整 |
| 7.4 | 仮想スクロール最適化 | 大規模リポジトリ（10,000+ ファイル）検証 |
| 7.5 | エラー表示統一 | 致命的エラー → モーダル、軽微エラー → トースト通知 |
| 7.6 | アプリアイコン作成 | macOS 用 .icns 生成 |
| 7.7 | DMG / .app ビルド | `tauri build` で配布用バイナリ生成 |

---

## 8. コンポーネント詳細設計

### 8.1 PTY Manager (Rust)

**責務**: 複数の PTY セッションのライフサイクル管理

```rust
// 主要 Tauri コマンド（全て Result<T, AppError> を返す）
spawn_pty(config: PtySpawnConfig) -> Result<String, AppError>  // タブ ID を返す
write_pty(pty_id: String, data: String) -> Result<(), AppError> // data 上限 1MB
resize_pty(pty_id: String, cols: u16, rows: u16) -> Result<(), AppError>
kill_pty(pty_id: String) -> Result<(), AppError>
```

**出力フロー**:
1. PTY stdout を tokio::spawn で非同期読み取り
2. OutputBuffer に蓄積（16ms 間隔）
3. バッファフラッシュ時に `app.emit("pty-output", PtyOutputPayload { id, data })` で送信

**終了フロー**:
1. `kill_pty` 呼び出し → SIGTERM 送信
2. 5秒タイムアウト → SIGKILL 送信
3. PTY EOF 検出 → exit code を含む `pty-exit` イベント送信
4. アプリ `on_exit` フック → 全 PTY に SIGKILL

### 8.2 Tab Store (SolidJS)

**責務**: タブ一覧・アクティブタブ・レイアウト状態の管理（状態のみ）

```typescript
// 公開 API（Store は状態管理のみ。IPC は lib/commands/ 経由）
openTab(tab: Tab): void
closeTab(id: string): void
setActiveTab(id: string): void
updateStatus(id: string, status: TabStatus): void
equalizeLayout(): void
```

**制約**:
- タブ数上限: 20
- タブ ID = PTY ID（二重管理なし）
- 最後のタブ閉じ時: 新規タブ作成モーダルを表示

### 8.3 Terminal Panel (SolidJS)

**責務**: xterm.js の初期化・PTY 入出力接続・リサイズ追従

**初期化フロー**:
1. onMount で xterm.Terminal 生成
2. WebglAddon ロード（失敗時 canvas フォールバック）、FitAddon ロード
3. `listen("pty-output")` でフィルタリング後 `terminal.write()` に接続
4. `terminal.onData()` で入力を `write_pty` に送信
5. ResizeObserver で `fitAddon.fit()` → `resize_pty` 同期

**cleanup チェックリスト**（`onCleanup` で実行）:
- [ ] `terminal.dispose()`
- [ ] `webglAddon.dispose()`
- [ ] `fitAddon.dispose()`
- [ ] Tauri イベントリスナーの `unlisten()`
- [ ] `ResizeObserver.disconnect()`

### 8.4 Grid Container

**責務**: タブ数とコンテナ幅に応じたレイアウト自動切替

```
ロジック:
  containerWidth / tabCount < minTabWidth(400px)
    → 2行グリッド（上段: ceil(n/2)個、下段: 残り）
  それ以外
    → 1行横並び
```

### 8.5 PTY Output Parser

**責務**: PTY 出力から CLI 状態を検出

```typescript
// ANSI エスケープシーケンス除去後にパターンマッチ
// パターンは CLI ごとに別ファイルに定義

// claude-code-patterns.ts
{ pattern: /❯\s*$/, status: "waiting" }
{ pattern: /Error:|error:|ERROR/, status: "error" }

// codex-patterns.ts
{ pattern: /\$\s*$/, status: "waiting" }

// パターン未一致時のデフォルト: "running"
```

### 8.6 Rich Input

**責務**: 複数行テキスト入力 + 画像添付

**実装方針**: `textarea` ベース（`contentEditable` はWKWebViewでIME問題が多いため）

**入力フロー**:
1. テキスト入力（Shift+Enter で改行、Enter で送信）
2. IME コンポジション中は Enter 送信を抑制
3. 画像 D&D / Cmd+V → Rust 側専用ディレクトリに保存 → パス取得
4. 送信時にテキスト + 画像パスを PTY に write
5. Claude Code の場合: `/image path` コマンドで画像送信
6. 送信完了後に一時ファイル即削除

---

## 9. キーボードショートカット一覧

| ショートカット | 動作 |
|--------------|------|
| `Cmd+T` | 新しいタブを追加（上限 20 タブ） |
| `Cmd+W` | アクティブタブを閉じる |
| `Cmd+1` ~ `Cmd+9` | 対応番号のタブに切り替え |
| `Cmd+Shift+E` | 全タブを均等サイズに均等化 |
| `Cmd+B` | サイドバーの表示/非表示トグル |
| `Cmd+,` | 設定画面を開く |
| `Cmd+Shift+T` | 最後に閉じたタブを復元 |
| `Cmd+Enter` | リッチ入力エリアから送信 |
| `Cmd+V` | 画像のクリップボードペースト |

**注意**: テキスト入力フォーカス中はタブ操作系ショートカットを無効化する。

---

## 10. データフロー図

### PTY 入出力フロー

```
[ユーザー入力]
     │
     ▼
[RichInput] ──Enter──▶ [lib/commands/pty-commands.ts]
     │                           │
     │                     invoke("write_pty")
     │                           │
     │ (画像あり)                 ▼
     ▼                     [Tauri IPC]
[image-encoder]                  │
     │                           ▼
     ▼                     [PtyManager]
invoke("save_temp_image")        │
     │                     stdin.write()
     ▼                           │
[Rust /tmp/multi-llm-*/]         ▼
     │                     [CLI Process]
     └── パス取得            (claude / codex)
         → PTY write              │
                             stdout.read()
                                  │
                                  ▼
                            [OutputBuffer]
                            (16ms batch)
                                  │
                         emit("pty-output", { id, data })
                                  │
                                  ▼
                            [Tauri Event]
                                  │
                     ┌────────────┤
                     ▼            ▼
              [xterm.js write]  [pty-output-parser]
                                  │
                                  ▼
                        [tab-store.updateStatus]
                                  │
                                  ▼
                        [StatusIndicator 更新]
```

### ファイルツリーフロー

```
[Sidebar mount]
     │
     ▼
invoke("list_directory", { path, depth: 1 })
     │
     ▼
[Rust: tree.rs + ignore crate] ── .gitignore フィルタ ──▶ [FileNode[]]
     │                          ── symlink は辿らない
     │                          ── 深さ上限 20 階層
     ▼
[FileTree render] ── 仮想スクロール ──▶ [表示領域のみ DOM 生成]
     │
     │ (ノード展開)
     ▼
invoke("list_directory", { path: child_dir, depth: 1 })
     │
     ▼
[子ノード追加 → 再レンダリング]

     │ (ファイルクリック)
     ▼
invoke("read_file", { path, max_size: 1MB })
     │
     ├── サイズ超過 → 「ファイルが大きすぎます」表示
     ├── バイナリ → 「バイナリファイルです」表示
     └── テキスト → shiki でシンタックスハイライト表示

[notify watcher] ── ファイル変更 ──▶ emit("fs-change") ──▶ [refresh]
  (.gitignore フィルタ後のディレクトリのみ監視)
```

---

## 11. 依存ライブラリ一覧

### Rust Crates (Cargo.toml)

| Crate | バージョン | 用途 |
|-------|-----------|------|
| tauri | 2.x | アプリフレームワーク |
| tauri-plugin-store | 2.x | 設定の永続化 |
| tauri-plugin-dialog | 2.x | ディレクトリ選択ダイアログ |
| portable-pty | 0.8+ | PTY 管理 |
| tokio | 1.x (full) | 非同期ランタイム |
| serde | 1.x (derive) | シリアライズ |
| serde_json | 1.x | JSON 処理 |
| thiserror | 2.x | エラー型定義 |
| tracing | 0.1+ | 構造化ログ |
| tracing-appender | 0.2+ | ログファイル出力 |
| notify | 6.x | ファイルシステム監視 |
| ignore | 0.4+ | .gitignore パーサー |
| uuid | 1.x (v4) | セッション ID 生成 |
| base64 | 0.22+ | 画像エンコーディング |
| parking_lot | 0.12+ | 高速 Mutex |

### npm Packages (package.json)

| Package | 用途 |
|---------|------|
| solid-js | UI フレームワーク |
| @tauri-apps/api | Tauri フロントエンド API |
| @tauri-apps/plugin-store | 設定永続化 |
| @tauri-apps/plugin-dialog | ダイアログ |
| @xterm/xterm | ターミナルエミュレータ |
| @xterm/addon-webgl | WebGL レンダリング |
| @xterm/addon-fit | リサイズ追従 |

### 開発用

| Package | 用途 |
|---------|------|
| typescript | 型チェック |
| vite | ビルドツール |
| vite-plugin-solid | SolidJS Vite プラグイン |
| @tauri-apps/cli | Tauri CLI |
| vitest | テストフレームワーク |
| @solidjs/testing-library | テストユーティリティ |
| jsdom | DOM エミュレーション |

---

## 12. タブレイアウト仕様

### 自動グリッド化

```
【タブ 2つ: 横並び均等】
┌──────────────┬──────────────┐
│  Claude ●    │  Codex ✓     │
└──────────────┴──────────────┘

【タブ 4つ: まだ横に収まる】
┌───────┬───────┬───────┬───────┐
│ C1 ●  │ C2 ✓  │ C3 ●  │ Cx ✓  │
└───────┴───────┴───────┴───────┘

【タブ 5つ: 閾値以下 → 2行に自動分割】
┌───────────┬───────────┬──────────┐
│  C1 ●     │  C2 ✓     │  C3 ●    │
├───────────┼───────────┼──────────┤
│  C4 ✓     │  Cx ●     │          │
└───────────┴───────────┴──────────┘
```

### ステータスインジケータ

| 状態 | 表示 | 色 | アニメーション |
|------|------|----|--------------|
| idle | ○ | グレー | なし |
| running | ● | 緑 | pulse (1s infinite) |
| waiting | ● | 黄色 | なし |
| completed | ✓ | 青/緑 | なし |
| error | ✗ | 赤 | なし |

**dangerously-skip-permissions モード時**: タブに `⚠ DANGEROUS` 赤色バッジを常時表示

### リサイズ

- 各パネル間にドラッグハンドル（4px 幅）
- ドラッグ中はハンドルをハイライト表示
- `Cmd+Shift+E` で全パネルを均等幅に均等化

---

## 13. エラーハンドリング方針

### エラー表示の分類

| エラー種別 | 表示方法 | 例 |
|-----------|----------|-----|
| 致命的 | モーダルダイアログ | PTY 作成失敗、CLI バイナリ未検出 |
| 軽微 | トースト通知（5秒で自動消去） | ファイル読み取り失敗、画像保存失敗 |
| インライン | コンポーネント内表示 | ファイルサイズ超過、バイナリファイル |

### PTY エラー復旧

| イベント | 対応 |
|---------|------|
| CLI クラッシュ（OOM、SEGV 等） | タブステータス → error、exit code 表示、「再起動」ボタン |
| PTY ハング（応答なし） | kill_pty でSIGTERM → SIGKILL エスカレーション |
| CLI 未インストール | モーダルでエラー表示 + インストール手順リンク |

---

## 14. テスト戦略

### 単体テスト

- `tab-store`: openTab / closeTab / setActiveTab / updateStatus / タブ数上限
- `pty-output-parser`: Claude Code / Codex 各パターン検出、ANSI エスケープ含む出力、誤検出防止
- `image-encoder`: PNG / JPEG / GIF / WebP エンコード、0バイト / 破損ファイル
- `keyboard-shortcuts`: 各ショートカットのハンドラー呼び出し、テキスト入力中の無効化
- `grid-container`: タブ数 1 / 2 / 3 / 4 / 5 / 6 / 10 / 20 でのレイアウト計算

### 統合テスト

- PTY: spawn → write → 出力受信 → kill の一連フロー
- タブ: 作成 → CLI 起動 → ステータス変化 → 閉じ → PTY 破棄
- ファイルツリー: 遅延ロード → 展開 → .gitignore フィルタ
- 画像添付: D&D → 一時保存 → CLI 送信 → 一時ファイル削除

### エッジケーステスト

- タブ 20 個作成時のメモリ使用量
- PTY ハング時の SIGTERM/SIGKILL エスカレーション
- 10,000+ ファイルのリポジトリでのファイルツリー
- シンボリックリンク循環検出
- 100MB ファイルクリック時のプレビュー
- CLI バイナリが PATH に存在しない場合
- アプリ強制終了後の PTY プロセス孤立
- WebGL 非対応時の canvas フォールバック
- タブ高速開閉 100 回でのメモリリーク
- IME 入力中の Enter 抑制

---

## 15. リスクと対策

| リスク | 影響度 | 対策 |
|--------|--------|------|
| portable-pty が macOS で不安定 | 高 | リトライ機構。代替として raw pty fd 操作のフォールバック |
| PTY プロセスのゾンビ化 | 高 | SIGTERM→SIGKILL エスカレーション、on_exit フックで全 PTY 強制終了 |
| xterm.js WebGL クラッシュ | 中 | canvas レンダラーへ自動フォールバック |
| CLI 出力パターンの変更 | 中 | パターン定義を CLI ごとに別ファイルに分離。未一致時は "running" デフォルト |
| 大規模リポジトリでサイドバー重い | 中 | 遅延ロード + 仮想スクロール + .gitignore フィルタ後のみ監視 |
| タブ多数でメモリ逼迫 | 中 | タブ数上限 20、非アクティブタブ scrollback 1,000行 |
| 画像一時ファイルの蓄積 | 中 | 専用ディレクトリ + 3段階クリーンアップ（送信後/タブ閉じ/アプリ終了） |
| 画像添付の Claude Code 互換性 | 中 | `/image` コマンド + Base64 stdin 両方実装 |
| WKWebView の contentEditable 問題 | 中 | textarea ベースで実装。IME compositionイベント監視 |
| notify crate の fd 枯渇 | 低 | .gitignore フィルタ後のディレクトリのみ監視。ポーリングフォールバック |
| シンボリックリンク循環 | 低 | リンクは辿らない。深さ上限 20 階層 |
