# bunri を Codex で開発する

`service/pairbrush` の「Claude と Codex で規約を共有し、Codex の入口を生成する」構成を bunri に合わせた。
リポジトリ内の設定なので、他のプロジェクトにも使われる `~/.codex/config.toml` は変更しない。
モデル・推論量・承認・ネットワーク設定は、利用中の Codex セッションの設定を引き継ぐ。

## 導入

リポジトリのルートで実行する。Node.js 22 以上と Git が必要。

```bash
make harness-setup
make check-harness
```

`harness-setup` は生成設定を同期し、この clone の `core.hooksPath` を `.githooks` にする。
有効な既存 hooks があれば置き換えずに停止する。依存のインストール、stage、commit、push は行わない。
他の worktree と Git のローカル設定を共有している場合、この設定も共有される。
解除するときは `git config --local --unset core.hooksPath`（設定が `.githooks` であることを確認してから）。

アプリの依存がまだ無ければ、既存の手順で準備する。音のエンジンの検証には sfizz の submodule と cmake も要る。

```bash
make install
make install-frontend
make install-desktop
git submodule update --init --recursive
# cmake が無ければ、macOS では brew install cmake
cd web-ui
npx playwright install chromium webkit
```

Codex でこのリポジトリを開いて新しいセッションを開始する。CLI ならルートで `codex`。
既に開いているセッションは、設定・スキルを確実に読み直すため新しいセッションに切り替える。
プロジェクトが未信頼なら Codex 側でプロジェクトを信頼する必要がある。
`codex mcp list` または CLI の `/mcp` で `playwright` を確認できる。

## 依頼の例

```text
$bunri-feature ミキサーにミュート機能を追加して。必要なら担当を分けて、画面操作まで検証して
$bunri-qa 今の変更を検証して、失敗の原因を調べて
reviewer に main との差分を確認させて
```

通常の日本語で依頼しても、`AGENTS.md` の作業ルールは使われる。
担当ロールは backend / frontend / desktop / reviewer。カスタムロールを選べないクライアントでは、
親が対応する `.claude/agents/*.md` を組み込みエージェントへ渡す。
reviewer の読み取り専用という指示は、独立した sandbox を作る設定ではない。

## 規約の置き場

| 共通ソース | Codex が読む入口 |
| --- | --- |
| `.claude/CLAUDE.md` | ルートと各領域の `AGENTS.md` |
| `.claude/skills/feature/SKILL.md` | `.agents/skills/bunri-feature/SKILL.md` |
| `.claude/skills/qa/SKILL.md` | `.agents/skills/bunri-qa/SKILL.md` |
| `.claude/agents/{backend,frontend,desktop,reviewer}.md` | `.codex/agents/*.toml` |
| `.mcp.json` | `.codex/config.toml` |

スキル・担当文書・MCP 設定を変えたら `make harness-sync` を実行し、ソースと生成物を一緒に commit する。
手書きの設定と生成先が衝突したら生成器は停止する。管理対象でないスキルやロールは消さない。
新しい MCP の設定項目が同期に未対応なら、黙って捨てずにエラーになる。
`.claude/skills/grilling` は会話を止めて面談する専用ワークフローのため、通常の開発ハーネスには公開しない。

## 検証

| コマンド | 対象 |
| --- | --- |
| `make check-plan` | 未コミット変更から選んだ検証コマンドを表示。実行しない |
| `make check` | stage / 未stage / untracked の変更から必要な検証を実行 |
| `node scripts/check.mjs --base main` | main との merge base 以降の commit と未コミット変更を検証 |
| `node scripts/check.mjs --scope backend` | Python の lint と単体テスト |
| `node scripts/check.mjs --scope frontend --e2e` | 画面の lint・型・単体・build・ブラウザ E2E |
| `node scripts/check.mjs --scope desktop` | 同梱物の準備・workspace の fmt / clippy / Rust テスト・配布物の WebDriver 除外確認 |
| `node scripts/check.mjs --scope desktop --desktop-e2e` | 上記に本物の窓を使う E2E を追加 |
| `make check-all` | 全領域とブラウザ / 本物の窓の E2E |
| `make check-harness` | 生成設定の同期と、変更検出・隔離・生成器の回帰テスト |

`--list` は上記の CLI に追加できる。`--scope` は対象の明示指定で、自動選択より優先する。
UI と `backend/web/` の API 変更はブラウザ E2E を自動で加える。
ネイティブ・CSP・フォント・同梱物・sidecar 接続・鍵・プロジェクト保存や書き出しの変更は、本物の窓の E2E も加える。
明示指定はブラウザが `--e2e`、本物の窓が `--desktop-e2e`。
コミット済みの変更も検証したいときは `--base` を付けるか、対象を明示する。
Makefile と CI の変更は各領域の検証を選ぶ。

検証は失敗したコマンドで止まり、その終了コードを返す。依存不足や環境差による失敗も成功扱いにはしない。
Python テストには毎回新しい一時 `BUNRI_DATA_DIR` を渡す。元から設定されているデータ置き場は削除しない。
`.claude/worktrees/`、依存・ビルド出力・既存の音源やプロジェクトは変更検出対象から除く。
通常の検証に `make clean` を使わない。これは `uploads/`・`results/`・`projects/` も消すコマンド。

ブラウザ E2E は開発用の経路で Chromium / WebKit を操作する。
本物の窓の E2E は macOS のデスクトップアプリをテスト用にビルドして操作する（`make e2e-desktop`）。
テスト専用の WebDriver は配布ビルドへ入れず、検証できる範囲は `docs/ui-testing.md` に従う。
検証ランナーは `BUNRI_E2E_LLM` を子プロセスに渡さず、有料の実 LLM API テストを有効にしない。
明示的に必要な場合だけ、ユーザーの依頼に沿って `BUNRI_E2E_LLM=1 make e2e` で実行する。

## commit 時と CI

pre-commit は stage 済みパスに応じた軽い検査（生成設定、frontend lint / 型、Python lint、Rust fmt）を行う。
自動修正・自動 stage はしない。検査は作業ファイルを読むため、検査する領域とハーネスに未stage／untracked の
関連ファイルがあれば停止する。該当ファイルの変更を揃えて stage するか、コミットに含めない変更を退避してから再実行する。
重いテスト・build・E2E は commit 前の `make check` / `--base` で実行する。

`.github/workflows/harness.yml` でも生成の鮮度とハーネスの回帰テストを検査する。
既存のアプリ用 CI は引き続きアプリの lint・型・build を担当する。

## 仕様の参照

Codex CLI 0.160.1 のローカルコマンドと OpenAI Docs で構成を確認した。
発見順序は [AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md)、
スキルの場所は [Build skills](https://learn.chatgpt.com/docs/build-skills#where-codex-loads-local-skills)、
担当定義と権限継承は [Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents#custom-agents)、
プロジェクトの MCP 設定は [MCP](https://developers.openai.com/codex/mcp/) を参照。
