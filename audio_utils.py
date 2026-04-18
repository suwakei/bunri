"""音声ファイルの読み書きに関する共通ユーティリティ"""
from pathlib import Path

import numpy as np
import soundfile as sf


def load_audio(file_obj):
    """音声ファイルを読み込み、波形データとサンプルレートを返す。

    soundfile を使って WAV などの音声ファイルを読み込む。
    None が渡された場合は ValueError を送出する。

    Args:
        file_obj: 入力音声ファイルのパス（str / Path）またはファイルオブジェクト。
            None は不可。soundfile が対応する形式（WAV, FLAC 等）のみ。

    Returns:
        tuple[numpy.ndarray, int]: (data, sr) のタプル。
            data は float64 の波形配列。モノラルなら shape=(N,)、
            ステレオなら shape=(N, 2)。sr はサンプルレート（Hz）。

    Raises:
        ValueError: file_obj が None の場合。
        RuntimeError: soundfile が読み込めない形式や破損ファイルの場合。
    """
    if file_obj is None:
        raise ValueError("ファイルをアップロードしてください")
    data, sr = sf.read(file_obj)
    return data, sr


def sec_to_samples(sec, sr):
    """秒をサンプル数に変換する。

    Args:
        sec: 時間（秒）。0以上の実数。
        sr: サンプルレート（Hz）。正の整数。

    Returns:
        int: サンプル数。小数点以下は切り捨て。
    """
    return int(sec * sr)


def save_tmp(data, sr, prefix="edited"):
    """編集結果を results/edited/ 以下の一時 WAV ファイルに保存し、パスを返す。

    出力ディレクトリ results/edited/ が存在しない場合は自動的に作成する。
    ファイル名は ``{prefix}_{4桁乱数}.wav`` の形式となる。

    Args:
        data: 保存する波形データ（numpy.ndarray）。
            モノラル shape=(N,) またはステレオ shape=(N, 2)。
        sr: サンプルレート（Hz）。正の整数。
        prefix: 出力ファイル名のプレフィックス（str）。デフォルトは "edited"。

    Returns:
        str: 保存された WAV ファイルの絶対または相対パス。

    Side Effects:
        results/edited/{prefix}_{乱数}.wav をディスクに書き出す。
        results/edited/ ディレクトリが存在しない場合は作成する。
    """
    out_dir = Path("results") / "edited"
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"{prefix}_{np.random.randint(10000):04d}.wav"
    sf.write(str(out_path), data, sr)
    return str(out_path)


def to_stereo(data):
    """モノラル音声データをステレオに変換する。

    1 次元配列（モノラル）の場合、左右チャンネルを同一波形で複製して
    shape=(N, 2) のステレオ配列を返す。
    すでにステレオ（2 次元）であればそのまま返す。

    Args:
        data: 波形データ（numpy.ndarray）。
            モノラル shape=(N,) またはステレオ shape=(N, 2)。

    Returns:
        numpy.ndarray: shape=(N, 2) のステレオ配列。
            入力がすでにステレオの場合は入力をそのまま返す（コピーなし）。
    """
    if data.ndim == 1:
        return np.column_stack([data, data])
    return data
