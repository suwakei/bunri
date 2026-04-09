"""音声ファイルの読み書きに関する共通ユーティリティ"""
from pathlib import Path

import numpy as np
import soundfile as sf


def load_audio(file_obj):
    """ファイルを読み込んで (data, samplerate) を返す"""
    if file_obj is None:
        raise ValueError("ファイルをアップロードしてください")
    data, sr = sf.read(file_obj)
    return data, sr


def sec_to_samples(sec, sr):
    return int(sec * sr)


def save_tmp(data, sr, prefix="edited"):
    """編集結果を一時WAVファイルに保存してパスを返す"""
    out_dir = Path("results") / "edited"
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"{prefix}_{np.random.randint(10000):04d}.wav"
    sf.write(str(out_path), data, sr)
    return str(out_path)


def to_stereo(data):
    """モノラルならステレオに変換"""
    if data.ndim == 1:
        return np.column_stack([data, data])
    return data
