# bunri DAW — マルチステージ Docker ビルド
# Usage: docker compose up

# ---- Stage 1: React フロントエンドビルド ----
FROM node:22-slim AS frontend
WORKDIR /app/web-ui
COPY web-ui/package.json web-ui/package-lock.json ./
RUN npm ci --ignore-scripts
COPY web-ui/ ./
RUN npm run build

# ---- Stage 2: Python ランタイム ----
FROM python:3.11-slim AS runtime
WORKDIR /app

# ffmpeg + fluidsynth 用ランタイム
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg libfluidsynth3 && \
    rm -rf /var/lib/apt/lists/*

# Python 依存
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# アプリケーションコード
COPY *.py ./
COPY web/ ./web/

# SoundFont（存在する場合のみコピー）
COPY soundfont[s]/ ./soundfonts/

# フロントエンドビルド出力をコピー
COPY --from=frontend /app/web-ui/src/ /app/web-ui/src/
COPY --from=frontend /app/web/static/dist/ /app/web/static/dist/

# 作業ディレクトリ
RUN mkdir -p results uploads projects

EXPOSE 8000

CMD ["python", "run_web.py"]
