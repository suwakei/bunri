# bunri DAW

## 概要
Demucs (Meta AI) による音源分離と、音声編集・ミキシング・エフェクトを備えた軽量DAW。Gradio Web UIで操作。

## 構成
- `main.py` — Gradio Web UI（メインエントリーポイント）
- `separate.py` — Demucs音源分離ロジック
- `edit.py` — 基本編集（トリム/カット/分割/コピー/音量/フェード/ループ/パン/速度/結合/ノーマライズ/リバース/MP3書き出し）
- `effects.py` — エフェクト（3バンドEQ/コンプレッサー/リバーブ/ディレイ）
- `overlay.py` — 音源合成（オーバーレイ）
- `mixer.py` — マルチトラックミキサー（最大4トラック）
- `recorder.py` — マイク録音
- `convert.py` — フォーマット変換（MP4→WAV/MP3）
- `audio_utils.py` — 共通ユーティリティ
- `_demucs_runner.py` — torchaudio保存パッチ
- `requirements.txt` — 依存パッケージ

## 実行方法
```bash
python main.py
```

## 設計方針
- **CPU環境前提**: GPU不要。低スペックPCでも動作するよう設計
- **メモリ節約**: segment=7（デフォルト）で処理セグメントを短くしメモリ使用量を抑制
- **並列制限**: jobs=1でCPU負荷を最小化
- **WAV入出力**: エンコード/デコードの負荷を避けるためWAVをデフォルトに
- **遅延インポート**: 起動高速化のため、重いモジュール（numpy等）はボタン押下時にインポート
- **モデル**: htdemucs（標準）を推奨。htdemucs_ftは高精度だがCPUでは非常に遅い
