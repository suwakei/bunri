"""MP4 → WAV / MP3 変換機能（ffmpeg を使用）"""
import subprocess
import shutil
from pathlib import Path

import numpy as np


def _find_ffmpeg():
    """ffmpeg のパスを返す。見つからなければ ValueError"""
    path = shutil.which("ffmpeg")
    if path:
        return path
    raise ValueError(
        "ffmpeg が見つかりません。\n"
        "以下のいずれかの方法でインストールしてください:\n"
        "  1. https://www.gyan.dev/ffmpeg/builds/ から full-shared をダウンロードしてPATHに追加\n"
        "  2. winget install Gyan.FFmpeg\n"
        "  3. choco install ffmpeg"
    )


def _out_path(prefix, ext):
    out_dir = Path("results") / "converted"
    out_dir.mkdir(parents=True, exist_ok=True)
    return str(out_dir / f"{prefix}_{np.random.randint(10000):04d}{ext}")


def mp4_to_wav(file_obj):
    """MP4 から音声を抽出して WAV に変換"""
    if file_obj is None:
        raise ValueError("ファイルをアップロードしてください")
    ffmpeg = _find_ffmpeg()
    src = str(file_obj)
    dst = _out_path(Path(src).stem, ".wav")
    cmd = [ffmpeg, "-i", src, "-vn", "-acodec", "pcm_s16le", "-ar", "44100", "-ac", "2", "-y", dst]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise ValueError(f"変換に失敗しました:\n{result.stderr[-500:]}")
    return dst


def mp4_to_mp3(file_obj, bitrate):
    """MP4 から音声を抽出して MP3 に変換"""
    if file_obj is None:
        raise ValueError("ファイルをアップロードしてください")
    ffmpeg = _find_ffmpeg()
    src = str(file_obj)
    dst = _out_path(Path(src).stem, ".mp3")
    cmd = [ffmpeg, "-i", src, "-vn", "-acodec", "libmp3lame", "-b:a", f"{int(bitrate)}k", "-y", dst]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise ValueError(f"変換に失敗しました:\n{result.stderr[-500:]}")
    return dst
