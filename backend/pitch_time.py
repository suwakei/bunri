"""ピッチシフト（速度維持）/ タイムストレッチ（音程維持）— フェーズボコーダー実装"""
import numpy as np

from audio_utils import load_audio, save_tmp


def _phase_vocoder(data, sr, stretch_factor, hop_length=512, win_length=2048):
    """フェーズボコーダーによるタイムストレッチを行う。

    ステレオ信号の場合はチャンネルごとに _phase_vocoder_mono を呼び出して
    処理し、結果を列方向に結合して返す。

    stretch_factor > 1 → 伸ばす（遅くする）
    stretch_factor < 1 → 縮める（速くする）

    Args:
        data: 入力波形配列（numpy.ndarray）。
            モノラル shape=(N,) またはステレオ shape=(N, 2)。
        sr: サンプルレート（Hz）。正の整数。現実装では使用しないが将来拡張用。
        stretch_factor: 時間伸縮倍率。0 より大きい実数。
            1.0 = 等速、2.0 = 2 倍に伸ばす、0.5 = 半分に縮める。
        hop_length: STFT のホップサイズ（サンプル数）。デフォルト 512。
        win_length: STFT の窓サイズ（サンプル数）。デフォルト 2048。

    Returns:
        numpy.ndarray: タイムストレッチ後の波形配列。
            入力がモノラルなら shape=(M,)、ステレオなら shape=(M, 2)。
            M は stretch_factor に応じた長さ。
    """
    if data.ndim == 2:
        # ステレオ: チャンネルごとに処理
        return np.column_stack([
            _phase_vocoder_mono(data[:, ch], sr, stretch_factor, hop_length, win_length)
            for ch in range(data.shape[1])
        ])
    return _phase_vocoder_mono(data, sr, stretch_factor, hop_length, win_length)


def _phase_vocoder_mono(signal, sr, stretch_factor, hop_length, win_length):
    """モノラル信号に対してフェーズボコーダーによるタイムストレッチを適用する。

    短時間フーリエ変換（STFT）を使って位相情報を保持しながら
    時間軸を伸縮する。入力ホップを stretch_factor に応じて調整し、
    出力ホップは固定とすることで時間軸を変換する。

    Args:
        signal: モノラル波形配列（numpy.ndarray, shape=(N,), float）。
        sr: サンプルレート（Hz）。正の整数。現実装では未使用。
        stretch_factor: 時間伸縮倍率。0 より大きい実数。
        hop_length: 出力ホップサイズ（サンプル数）。正の整数。
        win_length: FFT 窓サイズ（サンプル数）。正の整数。

    Returns:
        numpy.ndarray: タイムストレッチ後のモノラル波形配列（shape=(M,)）。
            入力フレーム数が 2 未満の場合は入力をそのまま返す。
    """
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
    """線形補間によるリサンプル（ピッチ変更用）を行う。

    サンプル数を factor 分の 1 に変更することで、タイムストレッチ後の
    信号を元の長さに戻しピッチを変換する目的で使用する。

    Args:
        data: 入力波形配列（numpy.ndarray）。
            モノラル shape=(N,) またはステレオ shape=(N, 2)。
        factor: リサンプル倍率。出力サンプル数 = int(N / factor)。
            0 より大きい実数。

    Returns:
        numpy.ndarray: リサンプル後の波形配列。
            モノラル shape=(M,) またはステレオ shape=(M, 2)。
            計算後のサンプル数が 2 未満の場合は先頭 2 サンプルを返す。
    """
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
    """速度を維持したまま音程（ピッチ）をシフトする。

    フェーズボコーダーでタイムストレッチした後、線形補間リサンプルで
    元の長さに戻すことでピッチのみを変化させる。

    処理手順:
        1. factor = 2^(semitones/12) を計算
        2. フェーズボコーダーで factor 倍に時間伸縮
        3. 線形補間で元のサンプル数に戻す（これによりピッチが factor 倍になる）

    Args:
        file_obj: 入力 WAV ファイルのパスまたはファイルオブジェクト。
        semitones: シフトする半音数。正の値で音程アップ、負の値でダウン。
            例: +12 で 1 オクターブ上、-12 で 1 オクターブ下、0 で変化なし。

    Returns:
        str: 保存された一時 WAV ファイルのパス。

    Side Effects:
        results/edited/ にファイルを書き出す。
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
    """音程を維持したまま再生速度を変更する（タイムストレッチ）。

    フェーズボコーダーを使って音程を保ったまま時間軸を伸縮する。
    rate < 1.0 で遅くなり、rate > 1.0 で速くなる。

    Args:
        file_obj: 入力 WAV ファイルのパスまたはファイルオブジェクト。
        rate: 再生速度倍率。0 より大きい実数。
            1.0 = 等速、0.5 = 半分の速さ（2 倍の長さ）、2.0 = 倍速（半分の長さ）。

    Returns:
        str: 保存された一時 WAV ファイルのパス。

    Raises:
        ValueError: rate が 0 以下の場合。

    Side Effects:
        results/edited/ にファイルを書き出す。
    """
    data, sr = load_audio(file_obj)
    if rate <= 0:
        raise ValueError("速度は0より大きくしてください")
    if rate == 1.0:
        return save_tmp(data, sr, "stretch")

    stretch_factor = 1.0 / rate
    result = _phase_vocoder(data, sr, stretch_factor)

    return save_tmp(np.clip(result, -1.0, 1.0), sr, "stretch")
