# bunri DAW

ブラウザ上で動作する軽量 DAW（Digital Audio Workstation）です。Demucs による音源分離、ポリフォニックピッチ検出、シンセ、ドラムマシン、エフェクト、WAV 最適化などを備えています。

**「AI生成した音源を分解し、再現可能なノートデータに落とす」** ことを主な目的として作られています。

## 主な機能

| 機能 | 説明 |
|---|---|
| **音源完全分解 (Decompose)** | WAV を Demucs で6ステム分離 → 各パートをポリフォニックピッチ検出 → 楽器推定 → トラック+ピアノロール自動生成 |
| **音源分離** | Demucs によるボーカル/ドラム/ベース/ギター/ピアノ/その他への分離 |
| **シンセサイザー** | 4種の基本波形 + GM 音源（FluidSynth）、ADSR エンベロープ |
| **ドラムマシン** | 8ビート / 4つ打ち / ボサノバ / レゲエのプリセットパターン |
| **タイムライン** | 非破壊編集、クリップのドラッグ配置、拍単位スナップ |
| **ピアノロール** | トラック独立のノート編集（C2〜B6） |
| **エフェクト** | EQ / コンプレッサー / リバーブ / ディレイ / ピッチシフト / タイムストレッチ |
| **WAV 最適化** | サンプルレート/ビット深度変換で容量を 1/3〜1/4 に削減（TPDFディザリング適用） |
| **メトロノーム** | 再生中のクリック音、BPM連動 |
| **録音** | マイクからの録音 → トラックに追加 |
| **プロジェクト保存/読込** | JSON 形式での状態保存 |

## 技術スタック

- **バックエンド**: Python 3.11 / FastAPI / Demucs / librosa / NumPy / SciPy / soundfile
- **フロントエンド**: React 19 + TypeScript + Vite / React Router
- **テスト**: Vitest + Testing Library（フロントエンド）/ pytest（バックエンド）
- **CI**: GitHub Actions（リント・型チェック・テスト・ビルド）

## ディレクトリ構成

```
bunri/
├── .github/workflows/ci.yml    # CIワークフロー（lint/test/build）
├── web/
│   ├── api.py                  # FastAPI バックエンド API
│   └── static/dist/            # React ビルド出力（git管理外）
├── web-ui/                     # React フロントエンド
│   ├── src/
│   │   ├── components/         # UIコンポーネント
│   │   ├── pages/              # DAW/Tools/Help ページ
│   │   ├── lib/                # engine.ts / store.tsx
│   │   ├── styles/             # global.css
│   │   └── __tests__/          # Vitestテスト
│   └── package.json
├── test/back/                  # pytestテスト（バックエンド）
├── test/front -> web-ui/src/__tests__  # シンボリックリンク
│
├── separate.py                 # Demucs 音源分離
├── deep_separate.py            # 6ステム詳細分離
├── decompose.py                # 音源完全分解パイプライン
├── analyze.py                  # WAV → ピアノロール用ノートデータ解析
├── edit.py                     # トリム/カット/フェード/ループ等
├── effects.py                  # EQ/コンプレッサー/リバーブ/ディレイ
├── synth.py                    # シンセ + ドラムマシン + ステップシーケンサー
├── mixer.py                    # マルチトラックミキサー
├── metronome.py                # メトロノーム/BPMユーティリティ
├── pitch_time.py               # ピッチシフト/タイムストレッチ
├── wav_optimize.py             # WAV 最適化（容量削減）
├── overlay.py                  # 音源合成
├── convert.py                  # フォーマット変換（MP4→WAV/MP3）
├── recorder.py                 # マイク録音
├── audio_utils.py              # 共通ユーティリティ
├── _demucs_runner.py           # torchaudio 保存パッチ
├── run_web.py                  # Web版エントリーポイント
├── requirements.txt            # Python依存
├── pyproject.toml              # ruff 設定
└── Makefile                    # 開発コマンド集
```

## 必要環境

- **Python**: 3.11 以上
- **Node.js**: 22 以上（npm 10+）
- **ffmpeg**: フォーマット変換機能を使う場合
- **GPU**: 不要（CPU環境前提で設計）

## セットアップ

### 1. バックエンド依存をインストール

```bash
pip install -r requirements.txt
```

または

```bash
make install
```

### 2. フロントエンド依存をインストール

```bash
cd web-ui
npm ci
cd ..
```

または

```bash
make install-frontend
```

### 3. React をビルド

```bash
make build
```

## 起動方法

### 本番モード（ビルド済みフロントを FastAPI が配信）

```bash
make web
```

内部的には以下を実行しています:

```bash
cd web-ui && npm run build && cd ..
python run_web.py
```

ブラウザで `http://127.0.0.1:8000` が自動的に開きます。

### 開発モード（Vite HMR + FastAPI）

ホットリロードを使いたい場合、2つのターミナルで並行起動します:

```bash
# ターミナル 1: バックエンド (FastAPI)
python run_web.py

# ターミナル 2: フロントエンド (Vite HMR)
cd web-ui
npm run dev
```

Vite は `http://127.0.0.1:3000` で起動し、API リクエストは自動で FastAPI (`:8000`) にプロキシされます。

## 使い方

### DAW 画面 (`/`)

1. 左パネルでシンセ/ドラム/FX/ファイルを選択
2. タイムラインにクリップを配置（D&D 対応）
3. トラック名をクリックするとピアノロールが開く
4. ピアノロールでダブルクリックしてノート追加、ドラッグで移動、Delete で削除
5. ▶ボタンで再生、書出ボタンで WAV エクスポート

### ツール画面 (`/tools`)

| タブ | 機能 |
|---|---|
| **完全分解** | WAV → 6ステム分離 → ノート書き起こし → 楽器推定（BPM自動検出） |
| **音源分離** | Demucs による2/4/6ステム分離 |
| **解析** | 周波数帯域・楽器構成・テンポ等の解析 |
| **編集** | トリム/カット/コピー/無音挿入/ループ |
| **エフェクト** | EQ/コンプレッサー/リバーブ/ディレイ他 |
| **一括編集** | 複数ファイルへの同一処理 |
| **音源合成** | 2ファイルのオーバーレイミックス |
| **変換** | MP4等 → WAV/MP3 変換 |
| **WAV最適化** | サンプルレート/ビット深度変換で容量削減 |

### ヘルプ画面 (`/help`)

操作ガイド、キーボードショートカット、用語集を閲覧できます。

## 開発

### テスト実行

```bash
# フロントエンド (Vitest, 36テスト)
cd web-ui && npm test

# バックエンド (pytest, 91テスト)
python -m pytest test/back/ -v

# 全テスト
make test
```

### リント

```bash
# フロントエンド (ESLint + typescript-eslint)
cd web-ui && npx eslint .

# バックエンド (ruff)
ruff check .

# 両方
make lint
```

### 型チェック

```bash
cd web-ui && npx tsc --noEmit
```

### ビルド

```bash
cd web-ui && npm run build
# または
make build
```

ビルド出力は `web/static/dist/` に生成されます（git管理外）。

## 設計方針

- **CPU環境前提**: GPU不要。低スペックPCでも動作
- **メモリ節約**: Demucs の segment=7 で処理セグメントを短縮
- **並列制限**: jobs=1 で CPU 負荷を最小化
- **WAV入出力**: エンコード/デコードの負荷を避けるため WAV をデフォルトに
- **遅延インポート**: 起動高速化のため、重いモジュール（numpy, librosa等）は関数内でインポート

## ライセンス

このリポジトリの各 Python モジュールは個別にライセンスを定めていません。依存ライブラリ（Demucs 等）のライセンスに従ってください。
