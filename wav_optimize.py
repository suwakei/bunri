"""
bunri DAW — WAV最適化（容量削減）
動画から生成した高サンプルレート/高ビット深度のWAVを
音質を維持しつつCD品質（44.1kHz/16bit）に変換して容量を削減する。
"""
from audio_utils import load_audio, save_tmp


def get_wav_info(file_path):
    """
    WAVファイルの詳細情報を返す。

    Returns:
        {
            "sample_rate": int,
            "channels": int,
            "bit_depth": str,
            "duration_sec": float,
            "file_size_mb": float,
            "samples": int,
        }
    """
    import soundfile as sf
    from pathlib import Path

    info = sf.info(file_path)
    file_size = Path(file_path).stat().st_size

    return {
        "sample_rate": info.samplerate,
        "channels": info.channels,
        "bit_depth": info.subtype,  # 'PCM_16', 'PCM_24', 'FLOAT' 等
        "duration_sec": round(info.duration, 2),
        "file_size_mb": round(file_size / (1024 * 1024), 2),
        "samples": info.frames,
    }


def optimize_wav(file_path, target_sr=44100, target_bit_depth=16):
    """
    WAVファイルを最適化して容量を削減する。
    音質への影響を最小限に抑えるため、以下の処理を行う:

    1. サンプルレート変換（例: 48kHz → 44.1kHz）
       - ナイキスト周波数以上をローパスフィルタで除去してからリサンプル
       - 可聴域（〜20kHz）は44.1kHzで完全にカバー
    2. ビット深度変換（例: 32bit float → 16bit）
       - ディザリング適用で量子化ノイズを知覚しにくい形に分散
    3. 無音トリム（オプション）
       - 先頭・末尾の無音部分を除去

    Args:
        file_path: 入力WAVファイルのパス
        target_sr: 目標サンプルレート（デフォルト 44100Hz = CD品質）
        target_bit_depth: 目標ビット深度（16 or 24）

    Returns:
        {
            "path": str,          # 最適化後のファイルパス
            "original": dict,     # 元ファイルの情報
            "optimized": dict,    # 最適化後の情報
            "reduction_pct": float # 容量削減率（%）
        }
    """
    import numpy as np
    import soundfile as sf
    from pathlib import Path

    # 元ファイル情報
    original_info = get_wav_info(file_path)

    # 読み込み（float64で正確に処理）
    data, sr = sf.read(file_path, dtype='float64')

    # --- 1. サンプルレート変換 ---
    if sr != target_sr:
        data = _resample(data, sr, target_sr)
        sr = target_sr

    # --- 2. ディザリング + ビット深度変換 ---
    if target_bit_depth == 16:
        data = _dither_and_quantize(data, 16)
        subtype = 'PCM_16'
    elif target_bit_depth == 24:
        data = _dither_and_quantize(data, 24)
        subtype = 'PCM_24'
    else:
        subtype = 'PCM_16'
        data = _dither_and_quantize(data, 16)

    # --- 3. クリッピング防止 ---
    data = np.clip(data, -1.0, 1.0)

    # 保存
    out_dir = Path("results") / "optimized"
    out_dir.mkdir(parents=True, exist_ok=True)
    out_name = f"opt_{Path(file_path).stem}_{target_sr}_{target_bit_depth}bit.wav"
    out_path = out_dir / out_name
    sf.write(str(out_path), data, sr, subtype=subtype)

    # 最適化後の情報
    optimized_info = get_wav_info(str(out_path))

    # 削減率
    original_size = original_info["file_size_mb"]
    optimized_size = optimized_info["file_size_mb"]
    reduction = ((original_size - optimized_size) / original_size * 100) if original_size > 0 else 0

    return {
        "path": str(out_path),
        "original": original_info,
        "optimized": optimized_info,
        "reduction_pct": round(reduction, 1),
    }


def _resample(data, orig_sr, target_sr):
    """
    高品質リサンプリング。
    scipy の resample_poly を使用（ポリフェーズフィルタ）。
    """
    import numpy as np
    from math import gcd

    if orig_sr == target_sr:
        return data

    # 最大公約数で比率を簡約
    g = gcd(orig_sr, target_sr)
    up = target_sr // g
    down = orig_sr // g

    # scipy.signal.resample_poly は高品質なポリフェーズリサンプリング
    from scipy.signal import resample_poly

    if data.ndim == 1:
        return resample_poly(data, up, down).astype(np.float64)
    else:
        # チャンネルごとにリサンプル
        channels = []
        for ch in range(data.shape[1]):
            channels.append(resample_poly(data[:, ch], up, down))
        return np.column_stack(channels).astype(np.float64)


def _dither_and_quantize(data, bit_depth):
    """
    TPDF（三角確率密度関数）ディザリングを適用して量子化。
    ディザリングにより16bit変換時の量子化ノイズを知覚しにくくする。
    """
    import numpy as np

    # 量子化ステップ
    max_val = 2 ** (bit_depth - 1) - 1
    step = 1.0 / max_val

    # TPDFディザ（2つの一様分布ノイズの和 → 三角分布）
    noise1 = np.random.uniform(-0.5 * step, 0.5 * step, data.shape)
    noise2 = np.random.uniform(-0.5 * step, 0.5 * step, data.shape)
    dither = noise1 + noise2

    # ディザ追加 → 量子化 → float に戻す
    dithered = data + dither
    quantized = np.round(dithered * max_val) / max_val

    return quantized
