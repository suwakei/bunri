"""ピッチシフト（速度維持）/ タイムストレッチ（音程維持）— フェーズボコーダー実装"""
import numpy as np

from audio_utils import load_audio, save_tmp


def _phase_vocoder(data, sr, stretch_factor, hop_length=512, win_length=2048):
    """
    フェーズボコーダーによるタイムストレッチ。
    stretch_factor > 1 → 伸ばす（遅くする）
    stretch_factor < 1 → 縮める（速くする）
    """
    if data.ndim == 2:
        # ステレオ: チャンネルごとに処理
        return np.column_stack([
            _phase_vocoder_mono(data[:, ch], sr, stretch_factor, hop_length, win_length)
            for ch in range(data.shape[1])
        ])
    return _phase_vocoder_mono(data, sr, stretch_factor, hop_length, win_length)


def _phase_vocoder_mono(signal, sr, stretch_factor, hop_length, win_length):
    """モノラル信号に対するフェーズボコーダー"""
    n_fft = win_length
    hop_out = hop_length
    hop_in = int(hop_length / stretch_factor)

    window = np.hanning(n_fft)

    # 入力フレーム数
    n_frames = 1 + (len(signal) - n_fft) // hop_in
    if n_frames < 2:
        return signal

    # 出力バッファ
    output_length = int(n_frames * hop_out + n_fft)
    output = np.zeros(output_length)
    window_sum = np.zeros(output_length)

    # 初期位相
    phase_advance = np.linspace(0, np.pi * hop_out, n_fft // 2 + 1, endpoint=False)
    prev_phase = np.zeros(n_fft // 2 + 1)

    for i in range(n_frames):
        # 入力フレーム取得
        start_in = i * hop_in
        frame = signal[start_in:start_in + n_fft]
        if len(frame) < n_fft:
            frame = np.pad(frame, (0, n_fft - len(frame)))

        # STFT
        spectrum = np.fft.rfft(frame * window)
        magnitude = np.abs(spectrum)
        phase = np.angle(spectrum)

        # 位相差を計算して位相を進める
        if i == 0:
            synth_phase = phase
        else:
            delta_phase = phase - prev_phase
            delta_phase -= phase_advance
            # -π ～ π に正規化
            delta_phase = delta_phase - 2 * np.pi * np.round(delta_phase / (2 * np.pi))
            synth_phase += phase_advance + delta_phase

        prev_phase = phase

        # ISTFT
        synth_spectrum = magnitude * np.exp(1j * synth_phase)
        frame_out = np.fft.irfft(synth_spectrum, n=n_fft) * window

        # 出力に加算
        start_out = i * hop_out
        end_out = start_out + n_fft
        if end_out > output_length:
            n = output_length - start_out
            output[start_out:] += frame_out[:n]
            window_sum[start_out:] += window[:n] ** 2
        else:
            output[start_out:end_out] += frame_out
            window_sum[start_out:end_out] += window ** 2

    # 正規化
    nonzero = window_sum > 1e-8
    output[nonzero] /= window_sum[nonzero]

    return output


def _resample_linear(data, factor):
    """線形補間によるリサンプル（ピッチ変更用）"""
    orig_len = len(data)
    new_len = int(orig_len / factor)
    if new_len < 2:
        return data[:2]
    x_old = np.linspace(0, 1, orig_len)
    x_new = np.linspace(0, 1, new_len)
    if data.ndim == 2:
        return np.column_stack([
            np.interp(x_new, x_old, data[:, ch])
            for ch in range(data.shape[1])
        ])
    return np.interp(x_new, x_old, data)


def pitch_shift(file_obj, semitones):
    """
    ピッチシフト（速度を維持したまま音程を変更）
    semitones: 半音単位（+12 = 1オクターブ上、-12 = 1オクターブ下）
    """
    data, sr = load_audio(file_obj)
    if semitones == 0:
        return save_tmp(data, sr, "pitch")

    # ピッチ変更倍率
    factor = 2 ** (semitones / 12.0)

    # 1. タイムストレッチで長さを変える（factor倍に伸縮）
    stretched = _phase_vocoder(data, sr, factor)

    # 2. リサンプルで元の長さに戻す（ピッチが変わる）
    result = _resample_linear(stretched, factor)

    return save_tmp(np.clip(result, -1.0, 1.0), sr, "pitch")


def time_stretch(file_obj, rate):
    """
    タイムストレッチ（音程を維持したまま速度を変更）
    rate: 1.0=等速、0.5=半分の速さ、2.0=倍速
    """
    data, sr = load_audio(file_obj)
    if rate <= 0:
        raise ValueError("速度は0より大きくしてください")
    if rate == 1.0:
        return save_tmp(data, sr, "stretch")

    stretch_factor = 1.0 / rate
    result = _phase_vocoder(data, sr, stretch_factor)

    return save_tmp(np.clip(result, -1.0, 1.0), sr, "stretch")
