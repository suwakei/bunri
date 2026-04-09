"""音声エフェクト（EQ、コンプレッサー、リバーブ、ディレイ）"""
import numpy as np

from audio_utils import load_audio, save_tmp, to_stereo


def eq_3band(file_obj, low_db, mid_db, high_db):
    """3バンドイコライザー（Low: ~300Hz / Mid: 300-3000Hz / High: 3000Hz~）"""
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
    """ダイナミクスコンプレッサー"""
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
    """シンプルリバーブ（コムフィルター方式）"""
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
    """ディレイエフェクト"""
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
