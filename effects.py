"""音声エフェクト（EQ、コンプレッサー、リバーブ、ディレイ）"""
import numpy as np

from audio_utils import load_audio, save_tmp, to_stereo


def eq_3band(file_obj, low_db, mid_db, high_db):
    """3 バンドイコライザーを適用する。

    周波数帯域を Low（300 Hz 未満）/ Mid（300〜3000 Hz）/ High（3000 Hz 以上）の
    3 つに分け、それぞれ指定した dB 値でゲインを調整する。
    FFT を使って周波数領域で処理するため位相特性は理想的ではないが、
    CPU 負荷が低い。

    Args:
        file_obj: 入力 WAV ファイルのパスまたはファイルオブジェクト。
        low_db: 低域ゲイン（dB）。300 Hz 未満の帯域に適用。負値で減衰。
        mid_db: 中域ゲイン（dB）。300〜3000 Hz の帯域に適用。
        high_db: 高域ゲイン（dB）。3000 Hz 以上の帯域に適用。

    Returns:
        str: 保存された一時 WAV ファイルのパス。

    Side Effects:
        results/edited/ にファイルを書き出す。
    """
    data, sr = load_audio(file_obj)
    # FFTで周波数領域に変換
    if data.ndim == 2:
        result = np.zeros_like(data)
        for ch in range(data.shape[1]):
            result[:, ch] = _eq_channel(data[:, ch], sr, low_db, mid_db, high_db)
    else:
        result = _eq_channel(data, sr, low_db, mid_db, high_db)
    return save_tmp(np.clip(result, -1.0, 1.0), sr, "eq")


def _eq_channel(signal, sr, low_db, mid_db, high_db):
    """モノラル信号に 3 バンド EQ を適用する。

    FFT で周波数領域に変換し、各帯域に dB ゲインを乗算してから
    IFFT で時間領域に戻す。

    Args:
        signal: モノラル波形配列（numpy.ndarray, shape=(N,)）。
        sr: サンプルレート（Hz）。正の整数。
        low_db: 低域（300 Hz 未満）のゲイン（dB）。
        mid_db: 中域（300〜3000 Hz）のゲイン（dB）。
        high_db: 高域（3000 Hz 以上）のゲイン（dB）。

    Returns:
        numpy.ndarray: EQ 処理後のモノラル波形配列（shape=(N,)）。
    """
    n = len(signal)
    freqs = np.fft.rfftfreq(n, d=1.0 / sr)
    spectrum = np.fft.rfft(signal)

    gains = np.ones(len(freqs))
    gains[freqs < 300] = 10 ** (low_db / 20)
    gains[(freqs >= 300) & (freqs < 3000)] = 10 ** (mid_db / 20)
    gains[freqs >= 3000] = 10 ** (high_db / 20)

    spectrum *= gains
    return np.fft.irfft(spectrum, n=n)


def compressor(file_obj, threshold_db, ratio, attack_ms, release_ms):
    """ダイナミクスコンプレッサーを適用する。

    エンベロープフォロワーで信号の振幅を追跡し、スレッショルドを超えた部分を
    ratio に従って圧縮する。アタック／リリースは指数平滑で滑らかに変化する。

    Args:
        file_obj: 入力 WAV ファイルのパスまたはファイルオブジェクト。
        threshold_db: コンプレッションが始まるしきい値（dB）。
            例: -12.0 の場合、-12 dBFS を超えた信号を圧縮。
        ratio: 圧縮比。1.0 以上の実数。例: 4.0 → 4:1 圧縮。
            値が大きいほど強くかかる。
        attack_ms: アタックタイム（ミリ秒）。信号がしきい値を超えてから
            コンプレッサーが反応するまでの時間。0 より大きい値。
        release_ms: リリースタイム（ミリ秒）。信号がしきい値を下回ってから
            ゲインが元に戻るまでの時間。0 より大きい値。

    Returns:
        str: 保存された一時 WAV ファイルのパス。

    Side Effects:
        results/edited/ にファイルを書き出す。
    """
    data, sr = load_audio(file_obj)

    threshold = 10 ** (threshold_db / 20)
    attack_samples = max(int(sr * attack_ms / 1000), 1)
    release_samples = max(int(sr * release_ms / 1000), 1)

    if data.ndim == 2:
        envelope = np.max(np.abs(data), axis=1)
    else:
        envelope = np.abs(data)

    # エンベロープフォロワー
    smoothed = np.zeros_like(envelope)
    smoothed[0] = envelope[0]
    for i in range(1, len(envelope)):
        if envelope[i] > smoothed[i - 1]:
            coeff = 1.0 - np.exp(-1.0 / attack_samples)
        else:
            coeff = 1.0 - np.exp(-1.0 / release_samples)
        smoothed[i] = smoothed[i - 1] + coeff * (envelope[i] - smoothed[i - 1])

    # ゲインリダクション計算
    gain = np.ones_like(smoothed)
    above = smoothed > threshold
    if np.any(above):
        gain[above] = threshold * (smoothed[above] / threshold) ** (1.0 / ratio - 1.0) / smoothed[above]
        gain[above] = np.clip(gain[above], 0.0, 1.0)

    if data.ndim == 2:
        gain = gain[:, np.newaxis]

    result = data * gain
    return save_tmp(np.clip(result, -1.0, 1.0), sr, "comp")


def reverb(file_obj, room_size, wet):
    """シンプルリバーブ（コムフィルター方式）を適用する。

    複数の異なるディレイタイムを持つコムフィルターを並列に加算することで
    残響を生成する。room_size が大きいほどディレイが長く残響が豊かになる。

    Args:
        file_obj: 入力 WAV ファイルのパスまたはファイルオブジェクト。
        room_size: 部屋の大きさを表すパラメータ。0.0（小さい部屋）〜
            1.0（大きい部屋）の実数。ディレイタイムとディケイに影響する。
        wet: ウェット量。0.0（原音のみ）〜 1.0（リバーブ最大）の実数。
            ドライ信号との混合比を制御する。

    Returns:
        str: 保存された一時 WAV ファイルのパス。

    Side Effects:
        results/edited/ にファイルを書き出す。
    """
    data, sr = load_audio(file_obj)

    # room_size (0.0~1.0) に応じたディレイタイム群
    base_delays_ms = [23, 29, 37, 43, 53, 61]
    scale = 0.3 + room_size * 0.7
    delays = [int(sr * d * scale / 1000) for d in base_delays_ms]
    decay = 0.3 + room_size * 0.4

    reverb_signal = np.zeros_like(data, dtype=np.float64)
    for delay in delays:
        padded = np.zeros_like(data)
        if data.ndim == 2:
            padded[delay:] = data[:-delay] if delay < len(data) else 0
        else:
            padded[delay:] = data[:-delay] if delay < len(data) else 0
        reverb_signal += padded * decay
        decay *= 0.85

    # wet/dry ミックス
    dry = 1.0 - wet * 0.5
    result = data * dry + reverb_signal * wet
    return save_tmp(np.clip(result, -1.0, 1.0), sr, "reverb")


def delay_effect(file_obj, delay_ms, feedback, wet):
    """ディレイエフェクト（エコー）を適用する。

    指定したディレイタイムで音声を遅延させ、フィードバックで徐々に
    減衰する繰り返しエコーを生成する。フィードバックループは最大 10 回で
    打ち切り（エネルギーが 0.001 未満になった時点でも終了）。

    Args:
        file_obj: 入力 WAV ファイルのパスまたはファイルオブジェクト。
        delay_ms: ディレイタイム（ミリ秒）。0 より大きく、ファイル長未満の値。
        feedback: フィードバック量。0.0〜1.0 の実数。
            値が大きいほど繰り返しエコーが多くなる。1.0 以上で発振する恐れがある。
        wet: ウェット量。0.0（原音のみ）〜 1.0（ディレイ最大）の実数。

    Returns:
        str: 保存された一時 WAV ファイルのパス。

    Raises:
        ValueError: delay_ms から換算したサンプル数が 0 以下またはファイル長以上の場合。

    Side Effects:
        results/edited/ にファイルを書き出す。
    """
    data, sr = load_audio(file_obj)
    delay_samples = int(sr * delay_ms / 1000)

    if delay_samples <= 0 or delay_samples >= len(data):
        raise ValueError("ディレイ時間が不正です")

    result = data.copy().astype(np.float64)
    buf = np.zeros_like(data, dtype=np.float64)

    # フィードバックループ（最大10回で打ち切り）
    current = data.copy().astype(np.float64)
    for _ in range(10):
        delayed = np.zeros_like(current)
        if current.ndim == 2:
            delayed[delay_samples:] = current[:-delay_samples]
        else:
            delayed[delay_samples:] = current[:-delay_samples]
        delayed *= feedback
        buf += delayed
        current = delayed
        if np.max(np.abs(current)) < 0.001:
            break

    result = data * (1.0 - wet * 0.3) + buf * wet
    return save_tmp(np.clip(result, -1.0, 1.0), sr, "delay")
