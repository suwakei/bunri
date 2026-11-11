# bunri DAW — コマンド集
# 使い方: make <コマンド>

.PHONY: help install install-frontend install-desktop desktop desktop-build dev-web e2e test lint clean

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
	@echo "  make test              全テストを実行（フロント + バック + Rust）"
	@echo "  make lint              リント実行（ESLint + ruff + cargo fmt / clippy）"
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

test: ## 全テストを実行
	cd web-ui && npm test
	uv run python -m pytest test/back/ -v
	cd src-tauri && cargo test

lint: ## リント実行
	cd web-ui && npx eslint .
	uv run ruff check .
	cd src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings

clean: ## 生成ファイルとキャッシュを削除
	rm -rf results uploads projects
	rm -rf web-ui/dist
	rm -rf web-ui/node_modules
	rm -rf __pycache__ .pytest_cache .ruff_cache
	find . -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true
