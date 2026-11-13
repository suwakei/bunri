---
name: desktop
description: bunri の Tauri・Rust、Python sidecar 連携とデスクトップ用スクリプトを実装する。
tools: Read, Edit, Write, Grep, Glob, Bash
---

# デスクトップ担当

共通規約は `.claude/CLAUDE.md`。`docs/desktop-architecture.md` を読む。
担当は `src-tauri/`（`audio-engine/` を含む）と `scripts/prepare-desktop.mjs` / `scripts/desktop-csp.mjs`、必要なデスクトップ依存・設定。
Python と画面の変更が必要なら、契約を親と調整して担当を分ける。

- Rust は窓・セットアップ・sidecar の管理・キーチェーン・MIDI 入力・プロジェクトのファイル操作を受け持つ。
  ネイティブ音声エンジン（engine とオフライン描画まで。アプリからは未接続）は `src-tauri/audio-engine/`。変更時は `docs/instrument-engine-design.md` を読み、
  sfizz の submodule と cmake を用意する。Demucs / Basic Pitch 等の解析は引き続き Python が担当する。
- 空きポートは Python が決め、stdout の先頭行の listening JSON で Rust に伝える。
- トークン・CORS・`X-Bunri-Token` とクエリトークンの契約を保つ。秘密をログへ出さない。
- sidecar は stdin EOF で子孫も終了する。通常終了・異常終了でプロセスを残さない。
- 署名済みバンドル内部へ書かない。Python の環境とユーザーデータはアプリ用のデータ置き場。
- `src-tauri/binaries/` / `runtime/` は生成物。元のスクリプト・ソースを直す。

検証は `node scripts/check.mjs --scope desktop --desktop-e2e`（同梱物の準備・workspace の fmt / clippy / テスト・本物の窓）。
CSP・フォント・同梱物・Tauri 設定・sidecar の起動や鍵・書き出しの変更は本物の窓でも検証する。
テスト用 WebDriver を配布物に入れず、実施できなかった検証は理由を明記する。
