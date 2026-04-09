# 音源分離ツール (bunri)

## 概要
Demucs (Meta AI) を使用してWAVファイルをボーカルと伴奏に分離するGUIツール。

## 構成
- `main.py` — Gradio Web UI（メインエントリーポイント）
- `separate.py` — Demucs呼び出しロジック（CLIとしても使用可能）
- `requirements.txt` — 依存パッケージ

## 実行方法
```bash
# GUI起動
python main.py

# CLI
python separate.py input.wav
```

## 設計方針
- **CPU環境前提**: GPU不要。低スペックPCでも動作するよう設計
- **メモリ節約**: segment=7（デフォルト）で処理セグメントを短くしメモリ使用量を抑制
- **並列制限**: jobs=1でCPU負荷を最小化
- **WAV入出力**: エンコード/デコードの負荷を避けるためWAVをデフォルトに
- **モデル**: htdemucs（標準）を推奨。htdemucs_ftは高精度だがCPUでは非常に遅い
