"""MP4 → WAV / MP3 変換機能（ffmpeg を使用）"""
import subprocess
import shutil
from pathlib import Path

import numpy as np


def _find_ffmpeg():
    """ffmpeg の実行ファイルのパスを検索して返す。

    システムの PATH から ffmpeg を探す。見つからない場合は
    インストール方法を示す詳細なメッセージとともに ValueError を送出する。

    Returns:
        str: ffmpeg 実行ファイルの絶対パス。

    Raises:
        ValueError: ffmpeg が PATH 上に存在しない場合。
            インストール手順（ダウンロード URL、winget、choco）をメッセージに含む。
    """
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
    """変換結果ファイルの出力パスを生成する。

    results/converted/ ディレクトリを作成し、重複を避けるため
    4 桁の乱数サフィックスを付けたファイルパスを返す。

    Args:
        prefix: ファイル名のプレフィックス（str）。通常は入力ファイルのステム名。
        ext: ファイル拡張子（str）。ドットを含む形式で指定。例: ".wav", ".mp3"。

    Returns:
        str: 生成した出力ファイルパス（results/converted/{prefix}_{乱数}{ext}）。

    Side Effects:
        results/converted/ ディレクトリが存在しない場合は作成する。
    """
    out_dir = Path("results") / "converted"
    out_dir.mkdir(parents=True, exist_ok=True)
    return str(out_dir / f"{prefix}_{np.random.randint(10000):04d}{ext}")


def mp4_to_wav(file_obj):
    """MP4 ファイルから音声を抽出して WAV 形式に変換する。

    ffmpeg を使って映像を除去し、PCM 16 ビット・44100 Hz・ステレオの
    WAV ファイルとして書き出す。

    Args:
        file_obj: 入力 MP4 ファイルのパスまたはファイルオブジェクト。None 不可。
            MP4 以外の ffmpeg 対応動画ファイルも処理可能。

    Returns:
        str: 変換後 WAV ファイルのパス（results/converted/ 以下）。

    Raises:
        ValueError: file_obj が None の場合、または ffmpeg が見つからない場合、
            または ffmpeg の変換処理が失敗した場合（標準エラー出力の末尾 500 文字を含む）。

    Side Effects:
        results/converted/ に WAV ファイルを書き出す。
        ffmpeg を外部プロセスとして呼び出す。
    """
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
    """MP4 ファイルから音声を抽出して MP3 形式に変換する。

    ffmpeg と libmp3lame エンコーダを使って映像を除去し、
    指定したビットレートの MP3 ファイルとして書き出す。

    Args:
        file_obj: 入力 MP4 ファイルのパスまたはファイルオブジェクト。None 不可。
            MP4 以外の ffmpeg 対応動画ファイルも処理可能。
        bitrate: MP3 ビットレート（kbps）。正の整数。例: 128、192、320。

    Returns:
        str: 変換後 MP3 ファイルのパス（results/converted/ 以下）。

    Raises:
        ValueError: file_obj が None の場合、または ffmpeg が見つからない場合、
            または ffmpeg の変換処理が失敗した場合（標準エラー出力の末尾 500 文字を含む）。

    Side Effects:
        results/converted/ に MP3 ファイルを書き出す。
        ffmpeg を外部プロセスとして呼び出す。
    """
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
