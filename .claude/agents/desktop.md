---
name: desktop
description: bunri の Tauri・Rust、Python sidecar 連携とデスクトップ用スクリプトを実装する。
tools: Read, Edit, Write, Grep, Glob, Bash
---

# デスクトップ担当

共通規約は `.claude/CLAUDE.md`。`docs/desktop-architecture.md` を読む。
担当は `src-tauri/` と `scripts/prepare-desktop.mjs`、必要なデスクトップ依存・設定。
Python と画面の変更が必要なら、契約を親と調整して担当を分ける。

- Rust は窓・セットアップ・sidecar の管理・キーチェーン・MIDI 入力の殻。
  音声解析を Python から重複実装しない。
- 空きポートは Python が決め、stdout の先頭行の listening JSON で Rust に伝える。
- トークン・CORS・`X-Bunri-Token` とクエリトークンの契約を保つ。秘密をログへ出さない。
- sidecar は stdin EOF で子孫も終了する。通常終了・異常終了でプロセスを残さない。
- 署名済みバンドル内部へ書かない。Python の環境とユーザーデータはアプリ用のデータ置き場。
- `src-tauri/binaries/` / `runtime/` は生成物。元のスクリプト・ソースを直す。

検証は `node scripts/check.mjs --scope desktop`（同梱物の準備・fmt・clippy・Rust テスト）。
起動・別窓・MIDI 等の変更では必要なネイティブ動作も確かめ、実施できなかったものを明記する。
