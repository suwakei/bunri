"""
bunri DAW — WAV最適化（容量削減）
動画から生成した高サンプルレート/高ビット深度のWAVを
音質を維持しつつCD品質（44.1kHz/16bit）に変換して容量を削減する。
"""
from audio_utils import load_audio, save_tmp


def get_wav_info(file_path):
    """WAVファイルのメタデータと物理的な詳細情報を返す。

    soundfile を使ってファイルを開かずにヘッダ情報を読み取り、
    ファイルシステムからサイズを取得してまとめる。

    Args:
        file_path: 情報を取得するWAVファイルのパス（文字列または Path オブジェクト）。

    Returns:
        以下のキーを持つ辞書::

            {
                "sample_rate": int,        # サンプルレート（Hz）
                "channels": int,           # チャンネル数（1=モノ, 2=ステレオ）
                "bit_depth": str,          # ビット深度サブタイプ（例: "PCM_16", "PCM_24", "FLOAT"）
                "duration_sec": float,     # 再生時間（秒、小数点以下2桁に丸め）
                "file_size_mb": float,     # ファイルサイズ（MB、小数点以下2桁に丸め）
                "samples": int,            # 総サンプル数（フレーム数）
            }

    Raises:
        RuntimeError: soundfile がファイルを開けない場合（破損・非対応フォーマット等）。
        FileNotFoundError: 指定したパスにファイルが存在しない場合。

    Note:
        ``bit_depth`` は soundfile のサブタイプ文字列をそのまま返す。
        ``"FLOAT"`` は 32bit 浮動小数点、``"DOUBLE"`` は 64bit 浮動小数点を表す。
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
    """WAVファイルを最適化して容量を削減する。

    音質への影響を最小限に抑えながら、以下の変換を順番に行う:

    1. **サンプルレート変換** — ``_resample`` によるポリフェーズリサンプリング。
       ナイキスト周波数以上をローパスフィルタで除去してから変換する。
       可聴域（〜20kHz）は 44.1kHz で完全カバーされる。
    2. **ビット深度変換** — ``_dither_and_quantize`` による TPDF ディザリング後に量子化。
       32bit float → 16bit などの変換時の量子化ノイズを知覚しにくくする。
    3. **クリッピング防止** — 変換後の値を ``[-1.0, 1.0]`` にクリップ。

    出力ファイルは ``results/optimized/`` ディレクトリに保存される。

    Args:
        file_path: 入力WAVファイルのパス（文字列または Path オブジェクト）。
        target_sr: 目標サンプルレート（Hz）。デフォルトは 44100（CD品質）。
            入力と同じ値の場合はリサンプリングをスキップする。
        target_bit_depth: 目標ビット深度。``16`` または ``24`` を指定する。
            それ以外の値が渡された場合は 16bit として処理する。

    Returns:
        以下のキーを持つ辞書::

            {
                "path": str,            # 最適化後ファイルの絶対パス
                "original": dict,       # 元ファイルの get_wav_info() 結果
                "optimized": dict,      # 最適化後ファイルの get_wav_info() 結果
                "reduction_pct": float, # ファイルサイズの削減率（%、小数点以下1桁）
            }

    Raises:
        RuntimeError: soundfile がファイルを読み書きできない場合。
        FileNotFoundError: ``file_path`` が存在しない場合。
        ImportError: scipy がインストールされていない場合（リサンプリング時）。

    Note:
        内部では float64 で処理するため、変換精度は入力フォーマットに依存しない。
        ``results/optimized/`` ディレクトリが存在しない場合は自動作成する。
        出力ファイル名は ``opt_{元ファイル名}_{target_sr}_{target_bit_depth}bit.wav``
        の形式になる。
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
    """ポリフェーズフィルタを使って高品質なサンプルレート変換を行う。

    ``scipy.signal.resample_poly`` を使用する。変換比率は最大公約数で
    簡約するため、整数比で表せないレート間（例: 48000→44100）でも
    正確に処理できる。モノラル・ステレオの両方に対応する。

    Args:
        data: 入力音声データの NumPy 配列。
            モノラルの場合は shape ``(samples,)``、
            ステレオの場合は shape ``(samples, channels)``。
        orig_sr: 入力データのサンプルレート（Hz）。
        target_sr: 変換後の目標サンプルレート（Hz）。

    Returns:
        リサンプル後の音声データ（dtype: ``numpy.float64``）。
        入力と同じ次元数・チャンネル数を保持する。

    Raises:
        ImportError: scipy がインストールされていない場合。

    Note:
        ``orig_sr == target_sr`` の場合は変換を行わずに入力をそのまま返す。
        ステレオの場合はチャンネルごとに独立してリサンプリングし、
        処理後に ``numpy.column_stack`` で結合する。
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
    """TPDF ディザリングを適用してから指定ビット深度に量子化する。

    TPDF（三角確率密度関数）ディザは、2 つの独立した一様分布ノイズを加算して
    三角分布を生成する。これにより量子化ノイズが特定の周波数に集中せず、
    知覚的に目立ちにくい白色ノイズに近い特性になる。

    量子化ステップは ``1 / (2^(bit_depth-1) - 1)`` で計算される。
    処理後もデータは float 形式のまま返す（soundfile での書き込み時に整数変換される）。

    Args:
        data: 入力音声データの NumPy 配列（dtype: float、値域 ``[-1.0, 1.0]``）。
            モノラル・ステレオどちらも可。
        bit_depth: 目標ビット深度（整数）。例: ``16`` または ``24``。

    Returns:
        ディザリングおよび量子化を適用した NumPy 配列（dtype は入力に準じる）。
        値域は入力と同じ ``[-1.0, 1.0]`` に正規化された float 形式。

    Note:
        この関数は量子化後もデータを float のまま返す。クリッピングは行わないため、
        呼び出し元で ``numpy.clip`` を適用することを推奨する。
        ディザノイズのレベルは量子化ステップの ±0.5 LSB（最小量子化単位）以内に収まる。
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
