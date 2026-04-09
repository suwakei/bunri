# bunri DAW — コマンド集
# 使い方: make <コマンド>

.PHONY: help web gui install kill clean

help: ## コマンド一覧を表示
	@echo.
	@echo  bunri DAW
	@echo  ─────────────────────────────
	@echo  make install   依存パッケージをインストール
	@echo  make web       Web DAW版を起動 (FastAPI)
	@echo  make gui       Gradio版を起動
	@echo  make kill      Python プロセスを停止
	@echo  make clean     生成ファイルを削除
	@echo.

install: ## 依存パッケージをインストール
	pip install -r requirements.txt

web: ## Web DAW版を起動 (http://127.0.0.1:8000)
	python run_web.py

gui: ## Gradio版を起動 (http://127.0.0.1:7860)
	python main.py

kill: ## 実行中のPythonプロセスを停止
	taskkill //F //IM python.exe 2>nul || echo No process found

clean: ## 生成ファイル（results/uploads/projects）を削除
	rd /s /q results 2>nul || echo.
	rd /s /q uploads 2>nul || echo.
	rd /s /q projects 2>nul || echo.
	rd /s /q gradio_results 2>nul || echo.
	echo Cleaned.
