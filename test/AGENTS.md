# テスト

ルートの [AGENTS.md](../AGENTS.md) と [.claude/CLAUDE.md](../.claude/CLAUDE.md) を読む。
`back/` は [.claude/agents/backend.md](../.claude/agents/backend.md) の担当範囲。
Python テストは `node scripts/check.mjs --scope backend` で一時データ置き場に出力する。
モデル推論のテストには時間がかかる。実際の LLM API を使うテストを通常の検証に加えない。
