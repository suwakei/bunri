"""マルチトラックミキサー（最大4トラック）"""
import numpy as np
import soundfile as sf

from audio_utils import sec_to_samples, save_tmp, to_stereo


def _resample(data, sr_from, sr_to):
    """簡易リサンプル（線形補間）"""
    if sr_from == sr_to:
        return data
    orig_len = len(data)
    new_len = int(orig_len * sr_to / sr_from)
    x_old = np.linspace(0, 1, orig_len)
    x_new = np.linspace(0, 1, new_len)
    if data.ndim == 2:
        return np.column_stack([
            np.interp(x_new, x_old, data[:, ch])
            for ch in range(data.shape[1])
        ])
    return np.interp(x_new, x_old, data)


def _apply_pan(data, pan):
    """等パワーパンニング適用"""
    data = to_stereo(data)
    angle = (pan + 1) / 2 * (np.pi / 2)
    result = data.copy()
    result[:, 0] *= np.cos(angle)
    result[:, 1] *= np.sin(angle)
    return result


def mix_tracks(
    file1, vol1, pan1, mute1,
    file2, vol2, pan2, mute2,
    file3, vol3, pan3, mute3,
    file4, vol4, pan4, mute4,
    master_vol,
):
    """最大4トラックをミックスダウン"""
    tracks = [
        (file1, vol1, pan1, mute1),
        (file2, vol2, pan2, mute2),
        (file3, vol3, pan3, mute3),
        (file4, vol4, pan4, mute4),
    ]

    loaded = []
    base_sr = None

    for f, vol, pan, mute in tracks:
        if f is None or mute:
            continue
        data, sr = sf.read(f)
        if base_sr is None:
            base_sr = sr
        else:
            data = _resample(data, sr, base_sr)
        data = to_stereo(data)
        gain = 10 ** (vol / 20)
        data = data * gain
        data = _apply_pan(data, pan)
        loaded.append(data)

    if not loaded:
        raise ValueError("ミュートされていないトラックが1つ以上必要です")

    max_len = max(len(d) for d in loaded)
    mixed = np.zeros((max_len, 2))
    for d in loaded:
        mixed[:len(d)] += d

    # マスターボリューム
    master_gain = 10 ** (master_vol / 20)
    mixed *= master_gain

    return save_tmp(np.clip(mixed, -1.0, 1.0), base_sr, "mix")
