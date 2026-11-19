#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = ["yt-dlp[default]"]
# ///
"""YouTube の動画1本を MP3 / WAV にして、リポジトリ直下の music/ に保存する。"""

import argparse
import re
import shutil
import subprocess
import sys
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

MUSIC_DIR = Path(__file__).resolve().parent.parent / "music"


def youtube_url(value: str) -> str:
    """YouTube の HTTP(S) URL だけを受け付ける。"""
    value = value.strip()
    try:
        parsed = urlsplit(value)
        host = parsed.hostname or ""
        if host == "youtu.be":
            video = re.fullmatch(r"/([\w-]+)/?", parsed.path, flags=re.ASCII)
        elif parsed.path == "/watch":
            identifiers = parse_qs(parsed.query).get("v", [])
            video = len(identifiers) == 1 and re.fullmatch(r"[\w-]+", identifiers[0], flags=re.ASCII)
        else:
            video = re.fullmatch(r"/(?:shorts|live|embed)/([\w-]+)/?", parsed.path, flags=re.ASCII)
        valid = (
            parsed.scheme in {"https", "http"}
            and (host in {"youtu.be", "youtube.com"} or host.endswith(".youtube.com"))
            and not parsed.username
            and not parsed.password
            and parsed.port in {None, 80, 443}
            and bool(video)
        )
    except ValueError:
        valid = False
    if not valid:
        raise argparse.ArgumentTypeError("YouTube の動画URL（https://www.youtube.com/watch?v=… など）を指定してください。")
    return value


def download(url: str, audio_format: str) -> int:
    """変換を子プロセスで行い、成功または失敗の終了コードを返す。"""
    if audio_format not in {"mp3", "wav"}:
        raise ValueError("形式は mp3 または wav を指定してください。")
    url = youtube_url(url)
    missing = [name for name in ("ffmpeg", "ffprobe") if not shutil.which(name)]
    if missing:
        print("FFmpeg が必要です。macOS: brew install ffmpeg", file=sys.stderr)
        return 1
    MUSIC_DIR.mkdir(parents=True, exist_ok=True)
    command = [
        sys.executable, "-m", "yt_dlp",
        "--ignore-config", "--no-playlist", "--no-overwrites",
        "--format", "bestaudio/best", "--extract-audio",
        "--audio-format", audio_format, "--audio-quality", "0",
        "--windows-filenames", "--trim-filenames", "180",
        "--paths", str(MUSIC_DIR),
        "--output", "%(title).150B [%(id)s].%(ext)s",
        "--print", "after_move:保存しました: %(filepath)s",
        "--no-simulate", "--progress",
    ]
    # yt-dlp が既定で使う Deno がない環境でも、Node.js があれば利用する。
    if shutil.which("node"):
        command.extend(["--js-runtimes", "node"])
    command.extend(["--", url])
    print(f"保存先: {MUSIC_DIR}\n形式: {audio_format.upper()}", flush=True)
    return subprocess.run(command, check=False).returncode


def main(argv: list[str] | None = None) -> int:
    """引数を省略した場合は、URL と形式を対話で受け取る。"""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("url", nargs="?", type=youtube_url, help="YouTube の動画URL（省略すると入力を求めます）")
    parser.add_argument("-f", "--format", choices=("mp3", "wav"), help="保存形式（対話時の既定: mp3）")
    args = parser.parse_args(argv)
    try:
        url = args.url or youtube_url(input("YouTube のURLを貼り付けてください: "))
        audio_format = args.format
        while audio_format is None:
            answer = input("保存形式 [mp3/wav]（Enter: mp3）: ").strip().lower() or "mp3"
            if answer in {"mp3", "wav"}:
                audio_format = answer
            else:
                print("mp3 または wav を入力してください。")
        return download(url, audio_format)
    except argparse.ArgumentTypeError as exc:
        print(str(exc), file=sys.stderr)
        return 2
    except (EOFError, KeyboardInterrupt):
        print("\n中止しました。", file=sys.stderr)
        return 130
    except OSError as exc:
        print(f"保存または実行に失敗しました: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
