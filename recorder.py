"""マイク録音の保存処理"""
from pathlib import Path

import numpy as np
import soundfile as sf

from audio_utils import save_tmp


def save_recording(audio_tuple):
    """Gradio の Audio コンポーネントから受け取った録音データを WAV で保存する。

    Gradio の Audio コンポーネントは (sample_rate, numpy_array) のタプルを
    返す。整数型（int16 / int32）の場合は float32 に正規化してから保存する。

    Args:
        audio_tuple: Gradio の Audio コンポーネントが返す録音データ。
            (sample_rate: int, data: numpy.ndarray) の形式のタプル。
            data の dtype は float32、int16、int32 のいずれかを想定。
            None の場合は ValueError を送出する。

    Returns:
        str: 保存された一時 WAV ファイルのパス（results/edited/ 以下）。

    Raises:
        ValueError: audio_tuple が None の場合。

    Side Effects:
        results/edited/ に WAV ファイルを書き出す。
    """
    if audio_tuple is None:
        raise ValueError("録音データがありません")

    # Gradio Audio は (sample_rate, numpy_array) のタプル
    sr, data = audio_tuple

    # int16 → float に変換（Gradio はint16で渡すことがある）
    if data.dtype == np.int16:
        data = data.astype(np.float32) / 32768.0
    elif data.dtype == np.int32:
        data = data.astype(np.float32) / 2147483648.0

    return save_tmp(data, sr, "rec")
