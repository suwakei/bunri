# 🎵 音源分離ツール

Demucs（Meta AI）を使ってボーカルと伴奏を分離するツールです。

## セットアップ

```bash
pip install -r requirements.txt
```

## 使い方

### Web UI（推奨）

```bash
python app.py
```

ブラウザで `http://localhost:7860` を開く。

### CLI

```bash
# 2分割（ボーカル / 伴奏）
python separate.py mysong.mp3

# 4分割（ボーカル / ドラム / ベース / その他）
python separate.py mysong.mp3 --four-stems

# 高精度モデル
python separate.py mysong.mp3 --model htdemucs_ft

# WAV出力
python separate.py mysong.mp3 --wav

# 出力先を指定
python separate.py mysong.mp3 -o ./my_output
```

## モデル比較

| モデル        | 精度     | 速度 | 備考             |
|---------------|----------|------|------------------|
| htdemucs      | ★★★★  | 速め | デフォルト推奨   |
| htdemucs_ft   | ★★★★★ | 遅め | 最高精度         |
| mdx_extra     | ★★★★  | 中   | ボーカル特化     |

## GPU利用（推奨）

CUDAが使えるGPU環境では自動的にGPUが使われ、処理が大幅に高速化されます。

## 出力ファイル

`output/<model>/<曲名>/` 以下に生成されます。

- `vocals.mp3` — ボーカルのみ
- `no_vocals.mp3` — 伴奏のみ
- `drums.mp3` — ドラム（4分割時）
- `bass.mp3` — ベース（4分割時）
- `other.mp3` — その他（4分割時）