# bunri DAW — コマンド集
# 使い方: make <コマンド>

.PHONY: help install install-frontend requirements build web dev test lint clean

help: ## コマンド一覧を表示
	@echo ""
	@echo "  bunri DAW"
	@echo "  ─────────────────────────────"
	@echo "  make install           バックエンド依存パッケージをインストール"
	@echo "  make install-frontend  フロントエンド依存パッケージをインストール"
	@echo "  make requirements      uv.lock から requirements.txt を作り直す"
	@echo "  make build             React フロントエンドをビルド"
	@echo "  make web               Web DAW を起動 (http://127.0.0.1:8000)"
	@echo "  make dev               開発モード（Vite HMR + FastAPI）"
	@echo "  make test              全テストを実行（フロント + バック）"
	@echo "  make lint              リント実行（ESLint + ruff）"
	@echo "  make clean             生成ファイルとキャッシュを削除"
	@echo ""

install: ## バックエンド依存パッケージをインストール（uv.lock のとおりに .venv へ入れる）
	uv sync

requirements: ## uv.lock から requirements.txt を作り直す（pip と Docker 用）
	@{ printf '# このファイルは uv.lock からの生成物。手で編集しない。\n'; \
	   printf '# 依存の定義は pyproject.toml、更新は `make requirements` (pip と Docker 用に残している)。\n'; \
	   uv export --frozen --no-dev --no-hashes --no-emit-project --no-annotate --no-header -q; } > requirements.txt

install-frontend: ## フロントエンド依存パッケージをインストール
	cd web-ui && npm ci

build: ## React フロントエンドをビルド
	cd web-ui && npm run build

web: build ## Web DAW を起動（ビルド後にFastAPI起動）
	uv run python run_web.py

dev: ## 開発モード（別ターミナルでFastAPIとViteを起動）
	@echo "別ターミナルで以下を実行してください:"
	@echo "  1) uv run python run_web.py  (FastAPI: http://127.0.0.1:8000)"
	@echo "  2) cd web-ui && npm run dev  (Vite HMR: http://127.0.0.1:3000)"

test: ## 全テストを実行
	cd web-ui && npm test
	uv run python -m pytest test/back/ -v

lint: ## リント実行
	cd web-ui && npx eslint .
	uv run ruff check .

clean: ## 生成ファイルとキャッシュを削除
	rm -rf results uploads projects
	rm -rf backend/web/static/dist
	rm -rf web-ui/node_modules
	rm -rf __pycache__ .pytest_cache .ruff_cache
	find . -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true
