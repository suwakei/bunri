"""マイク録音の保存処理"""
from pathlib import Path

import numpy as np
import soundfile as sf

from audio_utils import save_tmp


def save_recording(audio_tuple):
    """Gradio の Audio コンポーネントから受け取った録音データを WAV で保存"""
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
