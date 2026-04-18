"""マルチトラックミキサー（最大4トラック）"""
import numpy as np
import soundfile as sf

from audio_utils import sec_to_samples, save_tmp, to_stereo


def _resample(data, sr_from, sr_to):
    """線形補間による簡易リサンプルを行う。

    サンプルレートが同一の場合は入力をそのまま返す（コピーなし）。
    異なる場合は np.interp による線形補間でリサンプルする。

    Args:
        data: 入力波形配列（numpy.ndarray）。
            モノラル shape=(N,) またはステレオ shape=(N, 2)。
        sr_from: 入力のサンプルレート（Hz）。正の整数。
        sr_to: 出力のサンプルレート（Hz）。正の整数。

    Returns:
        numpy.ndarray: リサンプル後の波形配列。
            sr_from == sr_to の場合は入力と同じオブジェクトを返す。
    """
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
    """等パワーパンニングをステレオ信号に適用する。

    モノラルの場合は先にステレオに変換する。
    cos/sin カーブを使った等パワーパンニングにより、中央でもレベルが
    下がらないパン特性を実現する。

    Args:
        data: 入力波形配列（numpy.ndarray）。
            モノラル shape=(N,) またはステレオ shape=(N, 2)。
        pan: パン位置。-1.0（完全左）〜 0.0（中央）〜 1.0（完全右）の実数。

    Returns:
        numpy.ndarray: パン適用後のステレオ配列（shape=(N, 2)）。
            入力のコピーに対してゲインを適用して返す。
    """
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
    """最大 4 トラックをミックスダウンして 1 つの WAV ファイルに書き出す。

    各トラックに対して音量・パン・ミュートを適用した後、加算合成する。
    サンプルレートが異なるトラックは最初に読み込んだトラックのサンプルレートに
    合わせてリサンプルする。最後にマスターボリュームを適用する。

    Args:
        file1: トラック 1 のファイルパスまたはファイルオブジェクト。None でスキップ。
        vol1: トラック 1 の音量（dB）。正値で増幅、負値で減衰。
        pan1: トラック 1 のパン位置。-1.0（左）〜 0.0（中央）〜 1.0（右）。
        mute1: トラック 1 のミュートフラグ（bool）。True でスキップ。
        file2: トラック 2 のファイルパスまたはファイルオブジェクト。None でスキップ。
        vol2: トラック 2 の音量（dB）。
        pan2: トラック 2 のパン位置。
        mute2: トラック 2 のミュートフラグ（bool）。
        file3: トラック 3 のファイルパスまたはファイルオブジェクト。None でスキップ。
        vol3: トラック 3 の音量（dB）。
        pan3: トラック 3 のパン位置。
        mute3: トラック 3 のミュートフラグ（bool）。
        file4: トラック 4 のファイルパスまたはファイルオブジェクト。None でスキップ。
        vol4: トラック 4 の音量（dB）。
        pan4: トラック 4 のパン位置。
        mute4: トラック 4 のミュートフラグ（bool）。
        master_vol: マスターボリューム（dB）。全トラック合成後に適用される。

    Returns:
        str: 保存された一時 WAV ファイルのパス。ステレオ 2 チャンネル。
            サンプルレートは最初に読み込まれたトラックのサンプルレートに準拠。

    Raises:
        ValueError: ミュートされていないトラックが 1 つもない場合
            （全トラックが None またはミュート）。

    Side Effects:
        results/edited/ にファイルを書き出す。
    """
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
