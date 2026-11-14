# bunri DAW — コマンド集
# 使い方: make <コマンド>

.PHONY: help install install-frontend install-desktop desktop desktop-build dev-web e2e e2e-desktop test lint clean check check-all check-plan check-harness harness-sync harness-setup

help: ## コマンド一覧を表示
	@echo ""
	@echo "  bunri DAW"
	@echo "  ─────────────────────────────"
	@echo "  make install           バックエンド依存パッケージをインストール"
	@echo "  make install-frontend  フロントエンド依存パッケージをインストール"
	@echo "  make install-desktop   デスクトップ版の依存（Tauri CLI）をインストール"
	@echo "  make desktop           デスクトップ版を開発モードで起動（Rust と uv が要る）"
	@echo "  make desktop-build     デスクトップ版の配布物（.app / .dmg）をビルド"
	@echo "  make dev-web           開発用: 画面をブラウザで開けるようにする（Vite + API サーバ）"
	@echo "  make e2e               ブラウザを自動操作するテスト（Playwright）"
	@echo "  make e2e-desktop       本物の窓（デスクトップアプリ）を自動操作するテスト（mac のみ）"
	@echo "  make test              全テストを実行（フロント + バック + Rust）"
	@echo "  make lint              リント実行（ESLint + ruff + cargo fmt / clippy）"
	@echo "  make check             変更した領域を検証（UI / API 変更は E2E も含む）"
	@echo "  make check-plan        検証対象とコマンドを表示（実行しない）"
	@echo "  make check-all         全領域の検証とブラウザ / 本物の窓の E2E"
	@echo "  make check-harness     Codex 設定の同期とハーネスのテスト"
	@echo "  make harness-sync      共通ルール・MCP から Codex 用ファイルを生成"
	@echo "  make harness-setup     Codex ハーネスを同期し、この clone の Git hook を有効化"
	@echo "  make clean             生成ファイルとキャッシュを削除"
	@echo ""

install: ## バックエンド依存パッケージをインストール（uv.lock のとおりに .venv へ入れる）
	uv sync

install-frontend: ## フロントエンド依存パッケージをインストール
	cd web-ui && npm ci

install-desktop: ## デスクトップ版の依存（Tauri CLI）をインストール
	npm ci

desktop: ## デスクトップ版を開発モードで起動（窓が開き、Python sidecar も一緒に起動する）
	npm run tauri dev

desktop-build: ## デスクトップ版の配布物（.app / .dmg）をビルド（出力: src-tauri/target/release/bundle/）
	npm run tauri build

dev-web: ## 開発用: 画面をブラウザで開けるようにする（準備ができると URL を JSON で出す。Ctrl+C で止まる）
	node scripts/dev-web.mjs

e2e: ## ブラウザを自動操作するテスト（必要なサーバは自分で起動して止める。初回は npx playwright install が要る）
	cd web-ui && npm run e2e

e2e-desktop: ## 本物の窓を自動操作するテスト（テスト用にビルドし、アプリを起動して止める。mac のみ。初回のビルドは数分）
	cd web-ui && npm run e2e:desktop

test: ## 全テストを実行
	cd web-ui && npm test
	uv run python -m pytest test/back/ -v
	cd src-tauri && cargo test --workspace

lint: ## リント実行
	cd web-ui && npx eslint .
	uv run ruff check .
	cd src-tauri && cargo fmt --all --check && cargo clippy --workspace --all-targets -- -D warnings
	cd src-tauri && cargo clippy --all-targets --features e2e -- -D warnings
	@# 窓を自動操作する WebDriver サーバ (機能 e2e) が、既定のビルドに入っていないこと
	cd src-tauri && ! cargo tree -e normal --prefix none | grep -q '^tauri-plugin-wdio-webdriver '

check: ## 変更した領域を検証する（生成物・ユーザーデータ・別 worktree は除外）
	node scripts/check.mjs

check-all: ## 全領域とブラウザ / 本物の窓を検証する
	node scripts/check.mjs --scope all --e2e

check-plan: ## 変更した領域の検証プランを表示する
	node scripts/check.mjs --list

check-harness: ## Codex 設定の同期とハーネス自体を検証する
	node scripts/check.mjs --scope harness

harness-sync: ## Claude / Codex 共通文書と MCP から Codex 用ファイルを生成する
	node scripts/sync-codex-harness.mjs

harness-setup: ## この clone のハーネスと Git hook を用意する（依存のインストールはしない）
	node scripts/setup-harness.mjs

clean: ## 生成ファイルとキャッシュを削除（注意: uploads / results / projects のデータも消す）
	rm -rf results uploads projects
	rm -rf web-ui/dist
	rm -rf web-ui/node_modules
	rm -rf __pycache__ .pytest_cache .ruff_cache
	find . -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true
