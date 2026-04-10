# bunri DAW

## 概要
Demucs (Meta AI) による音源分離と、音声編集・ミキシング・エフェクトを備えた軽量DAW。FastAPI + HTML/CSS/JS の Web UI で操作。

## 起動
```bash
python run_web.py
```
ブラウザが自動で `http://127.0.0.1:8000` を開く。

## ファイル構成
| ファイル | 役割 |
|---|---|
| `run_web.py` | エントリーポイント（FastAPI + uvicorn + ブラウザ自動起動） |
| `web/api.py` | FastAPI バックエンド API |
| `web/static/` | フロントエンド（HTML/CSS/JS） |
| `separate.py` | Demucs 音源分離（htdemucs標準） |
| `deep_separate.py` | 6ステム詳細分離（htdemucs_6s） |
| `edit.py` | 基本編集（トリム/カット/分割/コピー/音量/フェード/ループ/パン/速度/結合/ノーマライズ/リバース/MP3書き出し） |
| `effects.py` | エフェクト（3バンドEQ/コンプレッサー/リバーブ/ディレイ） |
| `overlay.py` | 音源合成（オーバーレイ） |
| `mixer.py` | マルチトラックミキサー（最大4トラック） |
| `recorder.py` | マイク録音 |
| `convert.py` | フォーマット変換（MP4→WAV/MP3） |
| `pitch_time.py` | ピッチシフト/タイムストレッチ（フェーズボコーダー実装） |
| `metronome.py` | メトロノーム/BPMユーティリティ |
| `synth.py` | ソフトウェアシンセ + ステップシーケンサー + ドラムマシン（FluidSynth/SoundFont） |
| `analyze.py` | WAV音声解析 → ピアノロール用ノートデータ |
| `audio_utils.py` | 共通ユーティリティ（load_audio / save_tmp等） |
| `_demucs_runner.py` | torchaudio 保存パッチ |

## 依存関係
`requirements.txt` に記載。主要なもの:
- `demucs`, `torch`, `torchaudio` — 音源分離
- `fastapi`, `uvicorn`, `python-multipart` — Web API
- `soundfile` — WAV読み書き
- `numpy` — 音声処理全般（遅延インポート）
- `librosa` — 音声解析
- `pyfluidsynth` — SoundFont シンセ（`soundfonts/MuseScore_General.sf3`を使用）

## 設計方針
- **CPU環境前提**: GPU不要。低スペックPCでも動作するよう設計
- **メモリ節約**: segment=7で処理セグメントを短くしメモリ使用量を抑制
- **並列制限**: jobs=1でCPU負荷を最小化
- **WAV入出力**: エンコード/デコードの負荷を避けるためWAVをデフォルトに
- **遅延インポート**: 起動高速化のため、重いモジュール（numpy等）はボタン押下時にインポート
- **モデル**: htdemucs（標準）を推奨。htdemucs_ftは高精度だがCPUでは非常に遅い

## コーディング規約
- 日本語でdocstring・コメントを書く
- 新しいモジュールは `audio_utils.py` の `load_audio` / `save_tmp` を活用する
- 重いインポート（numpy, librosa等）は関数内で遅延インポートする
- 一時ファイルは `tempfile` を使い、結果は `results/` に保存する
