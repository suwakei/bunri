# bunri DAW

ブラウザ上で動作する軽量 DAW（Digital Audio Workstation）。FastAPI バックエンド + React フロントエンドの構成で、音源分離・ピッチ検出・シンセ・エフェクト・ミキシングなどの機能を提供します。

## 概要

楽曲ファイル（WAV/MP3/FLAC 等）をアップロードすると、Demucs（Meta AI）で楽器パートごとに分離し、各パートのピッチを検出してピアノロールにノートとして自動配置します。配置されたノートは編集可能で、GM 音源やカスタム波形で再生・書き出しができます。

自然言語でノートの提案を受けられる AI アシスタント（ローカル Ollama / クラウド Claude のハイブリッド）も備えています。

## 機能一覧

### DAW 画面 (`/`)

| 機能 | 内容 |
|---|---|
| タイムライン | トラック上にクリップを配置。ドラッグで移動、拍単位スナップ、WAV ファイルのドラッグ&ドロップ対応 |
| ピアノロール | トラックごとに独立。C2〜B6 の範囲でノート編集（ダブルクリックで追加、ドラッグで移動、Delete で削除） |
| オートメーション | ベジェ曲線によるパラメータ変化の描画・編集 |
| シンセサイザー | 基本波形 4 種（Sine / Square / Sawtooth / Triangle）、簡易楽器プリセット 6 種（guitar / violin / chorus / flute / bass / organ）、GM 音源（FluidSynth 経由、84 音色） |
| ドラムマシン | 4 パターン（8ビート / 4つ打ち / ボサノバ / レゲエ）、小節数・音量指定可 |
| エフェクト | EQ（3バンド）/ コンプレッサー / リバーブ / ディレイ / ノーマライズ / ピッチシフト / タイムストレッチ |
| 楽曲完全解析 | ファイルパネルからワンクリックで Demucs 分離 → ポリフォニックピッチ検出 → トラック自動生成 → ピアノロール自動配置 |
| 単音メロディ解析 | pyin ピッチ検出で単音 WAV をピアノロールに変換 |
| AI アシスタント | 自然言語チャットでピアノロールのノート提案。ローカル（Ollama + Gemma 3）またはクラウド（Anthropic Claude）で動作 |
| トランスポート | BPM（20〜300）/ 拍子（4/4, 3/4, 6/8）/ 再生・停止・録音 / メトロノーム / シークバー |
| 録音 | マイク入力からトラックに録音 |
| プロジェクト保存・読込 | JSON 形式で保存・復元 |
| WAV 書き出し | 全トラックをオフラインミックスダウンして WAV エクスポート |

### ツール画面 (`/tools`)

| タブ | 内容 |
|---|---|
| 完全分解 | Demucs 6 ステム分離 → 各ステムをポリフォニックピッチ検出 → 楽器推定 → JSON 出力 |
| 音源分離 | Demucs による 2/4/6 ステム分離（htdemucs / htdemucs_ft / htdemucs_6s） |
| 解析 | 周波数帯域分布、推定楽器構成、テンポ推定 |
| 編集 | トリム / カット / 範囲コピー / 無音挿入 / ループ |
| エフェクト | EQ / コンプレッサー / リバーブ / ディレイ / 音量 / フェード / パン / リバース / ピッチシフト / タイムストレッチ / 速度変更 |
| 一括編集 | 複数ファイルに同一操作を適用 |
| 音源合成 | 2 つの WAV をオーバーレイミックス |
| 変換 | MP4/AVI/MKV 等 → WAV / MP3 変換（ffmpeg 使用） |
| WAV 最適化 | サンプルレート変換（ポリフェーズフィルタ）+ ビット深度変換（TPDF ディザリング）で容量削減 |

### ヘルプ画面 (`/help`)

操作ガイド、画面構成の説明、キーボードショートカット一覧を掲載。

## 技術スタック

| レイヤー | 技術 |
|---|---|
| バックエンド | Python 3.11 / FastAPI / uvicorn |
| 音声処理 | Demucs / librosa / NumPy / SciPy / soundfile / PyFluidSynth |
| フロントエンド | React 19 / TypeScript / Vite 8 / React Router 7 |
| テスト | Vitest + Testing Library（フロントエンド）/ pytest（バックエンド） |
| リント | ESLint + typescript-eslint（フロントエンド）/ ruff（バックエンド） |
| CI | GitHub Actions（lint → type check → test → build） |
| AI アシスタント | Ollama（Gemma 3 4B/12B）/ Anthropic Claude API（オプション） |

## ディレクトリ構成

```
bunri/
├── .github/workflows/ci.yml     CI ワークフロー
├── web/
│   └── api.py                   FastAPI バックエンド（30+ エンドポイント）
├── web-ui/                      React フロントエンド
│   └── src/
│       ├── pages/               DawPage / ToolsPage / HelpPage
│       ├── components/          HeaderBar / LeftPanel / CenterArea / StatusBar /
│       │                        WelcomeGuide / AssistantPanel
│       ├── lib/                 engine.ts（AudioEngine）/ store.tsx（Context）
│       ├── styles/              global.css
│       └── __tests__/           Vitest テスト（3 ファイル, 36 テスト）
├── test/back/                   pytest テスト（12 ファイル, 113 テスト）
│
├── separate.py                  Demucs 音源分離（htdemucs 標準）
├── deep_separate.py             6 ステム詳細分離（htdemucs_6s）
├── decompose.py                 分離 → ピッチ検出 → 楽器推定 → 統合パイプライン
├── analyze.py                   pyin ピッチ検出 → ノートデータ変換
├── music_assistant.py           LLM ハイブリッド音楽アシスタント
├── synth.py                     シンセ / ドラムマシン / ステップシーケンサー / GM 音源
├── edit.py                      15 種の音声編集操作
├── effects.py                   EQ / コンプレッサー / リバーブ / ディレイ
├── pitch_time.py                フェーズボコーダーによるピッチシフト / タイムストレッチ
├── wav_optimize.py              リサンプル + ディザリングによる WAV 最適化
├── mixer.py                     最大 4 トラックミキサー
├── metronome.py                 メトロノーム生成 / BPM ユーティリティ
├── overlay.py                   音源合成（オーバーレイ）
├── convert.py                   フォーマット変換（ffmpeg 経由）
├── recorder.py                  マイク録音
├── audio_utils.py               load_audio / save_tmp / to_stereo
├── _demucs_runner.py            torchaudio 保存パッチ
├── run_web.py                   エントリーポイント（uvicorn + ブラウザ自動起動）
├── requirements.txt             Python 依存パッケージ
├── pyproject.toml               ruff 設定
└── Makefile                     開発コマンド集
```

## 必要環境

- Python 3.11 以上
- Node.js 22 以上（npm 10+）
- ffmpeg（フォーマット変換機能を使う場合）
- GPU 不要（CPU 環境前提で設計）

## セットアップ

```bash
# 1. バックエンド
pip install -r requirements.txt

# 2. フロントエンド
cd web-ui && npm ci && cd ..

# 3. ビルド
make build
```

### AI アシスタント（オプション）

ローカル LLM（Ollama）またはクラウド LLM（Anthropic Claude）を使う場合のみ設定が必要です。未設定でも他の全機能は動作します。

```bash
# ローカル: Ollama + Gemma 3
ollama pull gemma3:4b
ollama serve

# クラウド: Anthropic Claude
export ANTHROPIC_API_KEY=sk-ant-xxx
```

環境変数:

| 変数 | デフォルト | 説明 |
|---|---|---|
| `OLLAMA_URL` | `http://localhost:11434` | Ollama サーバー URL |
| `OLLAMA_MODEL` | `gemma3:4b` | ローカルモデル名 |
| `ANTHROPIC_API_KEY` | (なし) | Claude API キー |
| `CLAUDE_MODEL` | `claude-haiku-4-5-20251001` | クラウドモデル名 |

## 起動

### 本番モード

```bash
make web
```

`http://127.0.0.1:8000` でブラウザが開きます。

### 開発モード

```bash
# ターミナル 1
python run_web.py

# ターミナル 2
cd web-ui && npm run dev
```

Vite（`:3000`）が FastAPI（`:8000`）に API をプロキシします。

## API エンドポイント

### ページ配信

- `GET /` — DAW 画面（React SPA）
- `GET /tools` — ツール画面
- `GET /help` — ヘルプ画面

### シンセ・シーケンサー

- `POST /api/synth/note` — 単音生成
- `POST /api/synth/sequence` — ステップシーケンサー
- `POST /api/synth/drum` — ドラムパターン生成
- `GET /api/gm-instruments` — GM 楽器一覧
- `POST /api/metronome` — メトロノーム生成

### 音声処理

- `POST /api/effects/{effect_name}` — エフェクト適用
- `POST /api/edit/{action}` — 編集操作
- `POST /api/batch/edit` — 一括編集
- `POST /api/batch/effects` — 一括エフェクト
- `POST /api/mixer` — ミキシング
- `POST /api/overlay` — 音源合成

### 解析・分離

- `POST /api/analyze` — pyin ピッチ解析
- `POST /api/deep-analyze` — 周波数帯域・楽器構成解析
- `POST /api/separate` — Demucs 分離
- `POST /api/deep-separate` — 6 ステム詳細分離
- `POST /api/decompose` — 完全分解パイプライン

### WAV・変換

- `POST /api/wav/info` — WAV ファイル情報
- `POST /api/wav/optimize` — WAV 最適化
- `POST /api/convert/{target}` — フォーマット変換

### AI アシスタント

- `GET /api/assistant/status` — LLM 利用可否
- `POST /api/assistant/chat` — ノート提案

### プロジェクト・ダウンロード

- `POST /api/project/save` — 保存
- `GET /api/project/list` — 一覧
- `GET /api/project/load/{name}` — 読込
- `GET /api/download/{filename}` — ファイルダウンロード

## 開発コマンド

```bash
make install           # バックエンド依存インストール
make install-frontend  # フロントエンド依存インストール
make build             # React ビルド
make web               # ビルド + サーバー起動
make test              # 全テスト実行
make lint              # ESLint + ruff
make clean             # 生成ファイル・キャッシュ削除
```

### テスト

```bash
# フロントエンド（36 テスト）
cd web-ui && npm test

# バックエンド（113 テスト）
python -m pytest test/back/ -v

# 型チェック
cd web-ui && npx tsc --noEmit
```

## 設計方針

- CPU 環境前提で設計。GPU 不要
- Demucs は `segment=7`, `jobs=1` でメモリ使用量と CPU 負荷を抑制
- WAV をデフォルトの入出力形式としてエンコード/デコードの負荷を回避
- 重いモジュール（numpy, librosa 等）は関数内で遅延インポートして起動を高速化
- 新しいモジュールは `audio_utils.py` の `load_audio` / `save_tmp` を使用
- 一時ファイルは `tempfile` を使い、結果は `results/` に保存
