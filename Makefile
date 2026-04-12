# bunri DAW — コマンド集
# 使い方: make <コマンド>

.PHONY: help install install-frontend build web dev test lint clean

help: ## コマンド一覧を表示
	@echo ""
	@echo "  bunri DAW"
	@echo "  ─────────────────────────────"
	@echo "  make install           バックエンド依存パッケージをインストール"
	@echo "  make install-frontend  フロントエンド依存パッケージをインストール"
	@echo "  make build             React フロントエンドをビルド"
	@echo "  make web               Web DAW を起動 (http://127.0.0.1:8000)"
	@echo "  make dev               開発モード（Vite HMR + FastAPI）"
	@echo "  make test              全テストを実行（フロント + バック）"
	@echo "  make lint              リント実行（ESLint + ruff）"
	@echo "  make clean             生成ファイルとキャッシュを削除"
	@echo ""

install: ## バックエンド依存パッケージをインストール
	pip install -r requirements.txt

install-frontend: ## フロントエンド依存パッケージをインストール
	cd web-ui && npm ci

build: ## React フロントエンドをビルド
	cd web-ui && npm run build

web: build ## Web DAW を起動（ビルド後にFastAPI起動）
	python run_web.py

dev: ## 開発モード（別ターミナルでFastAPIとViteを起動）
	@echo "別ターミナルで以下を実行してください:"
	@echo "  1) python run_web.py         (FastAPI: http://127.0.0.1:8000)"
	@echo "  2) cd web-ui && npm run dev  (Vite HMR: http://127.0.0.1:3000)"

test: ## 全テストを実行
	cd web-ui && npm test
	python -m pytest test/back/ -v

lint: ## リント実行
	cd web-ui && npx eslint .
	ruff check .

clean: ## 生成ファイルとキャッシュを削除
	rm -rf results uploads projects
	rm -rf web/static/dist
	rm -rf web-ui/node_modules
	rm -rf __pycache__ .pytest_cache .ruff_cache
	find . -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true
