# 20 並列実機テスト手順

> Phase 1 〜 5a でヘッドレスエージェントエンジンが完成した状態で、
> 実機の Mac で **20 個の Claude / Codex セッションを同時に動かす**
> ことを検証する手動テスト計画。Phase 4（PTY 完全撤去）の前提となる
> ベースライン取得が目的。

## 前提

- Chorus を `pnpm tauri dev` で起動できる環境
- 認証済みの `claude` CLI（`claude auth status` が OK）
- もしくは `codex` CLI（`codex login` 済）
- macOS 14+
- Anthropic / OpenAI のレート上限と課金見積もりを確認済み

## API コスト見積もり

| シナリオ | 1 ペイン | 20 ペイン |
|---|---|---|
| 1 ターン × 短文応答（"say hi"） | $0.001〜$0.005 | $0.02〜$0.10 |
| 5 ターン × 中規模コード生成 | $0.05〜$0.20 | $1〜$4 |

「動作確認」目的なら **20 ペイン × 1 ターン × "say hi"** で十分。
Sonnet 4.6 / GPT-5 mini など安いモデルを選ぶとさらに圧縮できる。

## テスト前準備

### 1. fd 上限の確認

```bash
ulimit -n        # 通常 256〜10240
launchctl limit maxfiles  # macOS のシステム上限
```

Chorus 起動時に `setrlimit(RLIMIT_NOFILE, 4096)` で soft limit を
4096 に上げているが、shell の上限が低いと CLI 子プロセスが
fd を引き継げない可能性がある。

### 2. アクティビティモニタを起動

検証中の RSS と CPU を観察する。

```bash
open -a "Activity Monitor"
```

### 3. ベースライン RSS 計測

Chorus 未起動時のシステム空きメモリを記録。

```bash
vm_stat | grep "Pages free"
```

## 起動と切替

```bash
cd /path/to/chorus
pnpm tauri dev
```

起動後、TopBar の歯車アイコン → **Engine** → **Headless** を選択。
左下のステータスや TopBar の歯車内表示で `Headless ✓` がチェック
されていることを確認。

## テストシナリオ

### A. ペイン作成スループット

1. `⌘1` または TopBar の `+` で claude-code ペインを 1 つ開く
2. 起動完了（`status: idle`）を確認
3. 同様に `⌘1` を素早く 19 回連続実行（合計 20 ペイン）
4. 期待結果:
   - 全ペインが 30 秒以内に `idle` 状態へ
   - エラーダイアログが出ない
   - Activity Monitor で `claude` プロセスが 20 個リストアップ

```bash
# 別ターミナルで子プロセス数を確認
pgrep -f 'claude.*--input-format' | wc -l    # 20 を期待
```

### B. fd 使用量

```bash
# Chorus の PID を取得して fd 数を確認
ps -ax | grep -i chorus | grep -v grep
lsof -p <CHORUS_PID> | wc -l
```

期待値: 200〜400（20 セッション × stdin/stdout/stderr ≒ 60 + Chorus 本体 ≒ 150）。
4096 (`RLIMIT_NOFILE` soft) に対して十分余裕。

### C. RSS とメモリ傾向

Activity Monitor で `claude` プロセスを 20 個全部選択し、合計を見る。

| 期待値（参考） | 値 |
|---|---|
| `claude` 1 プロセス RSS | 100〜250 MB |
| 20 プロセス合計 | 2〜5 GB |
| Chorus 本体 RSS | 200〜500 MB |

> 4 GB を大きく超えるようなら、claude 1 プロセスあたりの RSS が
> 想定より大きい（Anthropic 側の最近のリリースで肥大化した
> 可能性）。Chorus 自体のメモリ問題ではない。

### D. 1 ターン応答スループット

1. 全 20 ペインの入力欄に `say hi` をペースト
2. 各ペインで `Enter` 送信（手動 or 自動化スクリプト）
3. 期待結果:
   - 全ペインが 60 秒以内に応答完了（`status: idle` 復帰）
   - UI が固まらない（ペインのタブ切替が即応する）
   - 1 ペインのレスポンスが他ペインの描画を遅延させない

### E. レンダリング応答性

ストリーミング中のペイン切替やスクロールがスムーズか確認。
xterm.js を使っていない headless ペインは、PTY ペインで起きていた
「2 ペインで重い」問題が解消されているはず。

### F. クリーンシャットダウン

1. 全 20 ペインを `⌘W` で閉じる、または Chorus を終了
2. 期待結果:
   - `claude` プロセスが 5 秒以内に全て消える（SIGTERM grace + SIGKILL）
   - `~/.config/chorus/headless-locks/` の残存ロックファイルが
     stale で次回起動時に正しく扱われる

```bash
pgrep -f 'claude.*--input-format'    # 出力なしを期待
ls ~/.config/chorus/headless-locks/  # *.lock が残っていてもよい (mtime が古ければ stale)
```

## 計測項目記録テンプレート

```text
日時:           YYYY-MM-DD HH:MM
モデル:         claude-sonnet-4-6 / gpt-5-mini / etc
Chorus 起動時 RSS:    ___ MB
20 ペイン spawn 後 RSS: ___ MB
20 ペイン × 1 ターン応答時間: ___ s (最遅) / ___ s (中央)
fd 数 (lsof | wc -l):  ___
全ペイン idle 復帰までの時間: ___ s
UI 凍結の有無:           あり / なし
クラッシュの有無:         あり / なし
所感:           ___
```

## 失敗時のトラブルシューティング

### 症状: ペインが開かない / spawn 失敗

```bash
# Chorus のログを確認 (tracing 出力)
RUST_LOG=info,headless=debug pnpm tauri dev 2>&1 | grep headless
```

`SpawnError::SpawnFailed` の場合は `claude` のパス解決失敗。
`which claude` で PATH 上にあるか確認。

### 症状: ペイン作成は成功するが応答が来ない

`Engine: Headless` がチェックされているか TopBar で再確認。
`PTY` のままだと従来挙動。

### 症状: 一部ペインが `error` 状態になる

- レート上限到達 → `usage-bar` の `retry in Ns` を確認
- 認証期限切れ → `claude auth status` を別ターミナルで実行
- fd 不足 → `ulimit -n` を 8192 まで上げて再起動

### 症状: アプリ全体が重い

- CPU / メモリの逼迫具合を Activity Monitor で確認
- Chorus 自体が重いのか claude プロセスが重いのか切り分け
- 重ければ `Engine` を `PTY` に戻して比較

## 検証完了の判定基準

以下すべてを満たしたら "20 並列が実機で動く" と判定:

- [ ] 20 ペインを spawn しきれる（spawn 失敗 0）
- [ ] 全ペインが 60 秒以内に 1 ターン応答完了
- [ ] UI が固まらない（ペイン切替・スクロールがスムーズ）
- [ ] fd 数が `RLIMIT_NOFILE` の 80% 未満
- [ ] Chorus 自体の RSS が 1 GB 未満（claude プロセスは別計算）
- [ ] クリーンシャットダウンでゾンビプロセスが残らない

## 次フェーズの判断材料

| 観測 | 推奨次アクション |
|---|---|
| 全項目クリア | Phase 4 (PTY 撤去) を進められる。撤去後に同テストを再実行して差分を比較 |
| RSS 過多 | claude 1 プロセスのメモリ使用量が問題。Phase 1f の stderr peek でモデル選択肢を見直す |
| fd 不足 | `ensure_fd_limit` を 8192 に上げる検討 |
| UI 凍結 | Phase 5b の criterion bench でフロント reactivity の bottleneck 計測 |
| spawn 失敗 | Phase 1f の health-check 強化を先行 |

このテストは PTY 撤去前後の差分を取るためにも有用。
Phase 4 マージ後にも同じ手順を再実行し、メモリ削減率を裏付ける。
