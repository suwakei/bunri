---
name: qa
description: bunri の変更に必要な検証を選んで実行し、失敗を調査して検証結果を報告する。
---

# bunri の検証

共通規約 `.claude/CLAUDE.md` を読み、ユーザーの依頼範囲と差分を確認する。

- 未コミット変更: `make check-plan` で対象を見て `make check`。
- ブランチ全体: `node scripts/check.mjs --base main --list` で対象を見て、`--list` を外して実行。
- 全領域: `make check-all`。特定領域: `node scripts/check.mjs --scope backend` 等。
- 本物の窓: `node scripts/check.mjs --scope desktop --desktop-e2e`（macOS）。
- ハーネスのみ: `make check-harness`。

Python テストはハーネスが毎回用意する一時データ置き場に出力する。`make clean` を使わない。
UI に関わる変更はブラウザ E2E まで含める。ネイティブ・CSP・フォント・同梱物・sidecar の鍵・書き出しは本物の窓も検証する。
詳しい手順は `docs/ui-testing.md`。
実 LLM API のテストは通常の検証に含めない。

失敗は再現条件とログから調べる。必要な修正だけを加え、該当検査を再実行する。
既存の失敗、今回の回帰、環境不足を根拠とともに区別し、通すためだけの skip やテストの弱体化をしない。
レビューのみを依頼されている場合は、検証計画と不足している証拠を返し、生成物を作るコマンドは実行しない。

最終報告には実行した範囲、成否、実行できなかった項目と理由を簡潔に記す。
