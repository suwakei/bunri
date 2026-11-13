# bunri — Codex の入口

## 最初に読むもの

1. [.claude/CLAUDE.md](.claude/CLAUDE.md) 全文。製品の方針・設計上の約束・開発手順の共通ソース。
2. 担当する場所の `AGENTS.md` と、そこから指す担当文書。
3. 変更に関係する `docs/` の設計文書だけを読む。

ユーザーとの会話、コメント、docstring は日本語。依頼済みの実装・修正・検証は最後まで進める。
開始時に `git status --short` を確認し、既存の変更を保持する。
`.claude/worktrees/` は別チェックアウトなので探索・検査の対象に入れない。

## 作業の進め方

- 複数領域にまたがる作業は、先に API の引数・戻り値・エラーと担当ファイルを決める。
- 独立して進められる調査・実装・レビューはサブエージェントへ委譲する。同じファイルの編集は重ねない。
- 担当は `backend` / `frontend` / `desktop` / `reviewer`（[.codex/agents/](.codex/agents/)）。カスタムロールを選べないクライアントでは、組み込みエージェントへ対応する `.claude/agents/*.md` を読むよう渡す。
- 小さな修正は自分で完結してよい。親は統合、契約の整合、必要な検証、結果の報告を担当する。
- レビューだけの依頼では編集しない。ロールの担当範囲は指示であり、独立した権限の境界ではない。
- コミット・push・公開は依頼の範囲に従う。ハーネス導入自体は自動コミットしない。

## 検証

`make check-plan` で対象を確認し、`make check` で変更した領域を検査する。
UI の変更はブラウザ E2E も含む。ブランチ全体は `node scripts/check.mjs --base main`、全領域は `make check-all`。
実行できない検査は、その理由と未検証範囲を報告する。検証エラーを隠す、無関係なテストを無効にする、依存を勝手に更新することで通さない。

`make clean` は `uploads/`・`results/`・`projects/` を削除する。ハーネスや通常の検証から実行しない。
`.env` や実音源の内容をプロンプト・ログへ転記しない。実際の LLM API 呼び出しは明示されたときだけ行う。

## Claude Code の資産を読むとき

| Claude 側の表現 | Codex での操作 |
| --- | --- |
| `/feature` | `$bunri-feature` |
| `/qa` | `$bunri-qa` |
| Agent / Task ツール | 利用可能なサブエージェント機能 |
| Read / Grep / Glob | シェルの読み取り・`rg` / `rg --files` |
| Edit / Write | `apply_patch` 等の編集ツール |

Claude の `model`・`tools` 等の frontmatter は Codex の設定へ転記しない。
生成先の `.agents/skills/`・`.codex/agents/`・`.codex/config.toml` は直接編集せず、元文書や `.mcp.json` を直して `make harness-sync`。
導入と使い方は [docs/codex-harness.md](docs/codex-harness.md)。
