#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = ["yt-dlp[default]"]
# ///
"""YouTube の動画1本を MP3 / WAV にして、リポジトリ直下の music/ に保存する。"""

import argparse
import queue
import re
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

MUSIC_DIR = Path(__file__).resolve().parent.parent / "music"
PROGRESS_PREFIX = "__BUNRI_PROGRESS__"


def show_progress(process) -> int:
    """子の出力を随時受け取り、進捗のない情報取得・変換の間も動作中と示す。"""
    messages = queue.Queue()

    def read_output():
        try:
            for line in process.stdout:
                messages.put(line)
        except BaseException as exc:
            messages.put(exc)
        finally:
            messages.put(None)

    reader = threading.Thread(target=read_output, daemon=True)
    reader.start()
    terminal = sys.stdout.isatty()
    stage = "動画情報を取得中…"
    started = time.monotonic()
    tick = 0
    visible = False

    def display(text):
        nonlocal visible
        if terminal:
            print(f"\r\033[K{text}", end="", flush=True)
            visible = True
        else:
            print(text, flush=True)

    display(stage)
    try:
        while True:
            try:
                line = messages.get(timeout=0.15)
            except queue.Empty:
                if terminal:
                    spinner = "|/-\\"[tick % 4]
                    display(f"{spinner} {stage}  経過 {time.monotonic() - started:.0f}秒")
                    tick += 1
                continue
            if line is None:
                break
            if isinstance(line, BaseException):
                raise line
            if line.startswith(PROGRESS_PREFIX):
                stage = progress_bar(line)
                display(stage)
            else:
                if visible:
                    print()
                    visible = False
                print(line, end="", flush=True)
        if visible:
            print()
        return process.wait()
    finally:
        # 例外時の子プロセス終了は呼び出し元が行い、読取りスレッドも EOF で終了する。
        if process.poll() is not None:
            reader.join(timeout=1)


def progress_bar(line: str) -> str:
    """取得済みバイト数からバーを作る。総量が不明なときは取得量だけを出す。"""
    values = line.removeprefix(PROGRESS_PREFIX).strip().split("|")
    if len(values) != 4:
        return "ダウンロード中…"
    status, downloaded, total, estimated = values
    try:
        done = max(0, float(downloaded))
    except ValueError:
        done = 0
    size = 0
    for value in (total, estimated):
        try:
            size = float(value)
        except ValueError:
            continue
        if size > 0:
            break
    if size > 0:
        fraction = min(1, done / size)
        filled = int(fraction * 24)
        bar = "#" * filled + "-" * (24 - filled)
        text = f"取得中 [{bar}] {fraction:6.1%}  {done / 1048576:.1f}/{size / 1048576:.1f} MiB"
    else:
        text = f"取得中 [総量不明] {done / 1048576:.1f} MiB"
    if status == "finished":
        text += "  取得完了・音声を変換中…"
    return text


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
        sys.executable, "-u", "-m", "yt_dlp",
        "--ignore-config", "--no-playlist", "--no-overwrites",
        "--format", "bestaudio/best", "--extract-audio",
        "--audio-format", audio_format, "--audio-quality", "0",
        "--windows-filenames", "--trim-filenames", "180",
        "--paths", str(MUSIC_DIR),
        "--output", "%(title).150B [%(id)s].%(ext)s",
        "--print", "after_move:保存しました: %(filepath)s",
        "--no-simulate", "--no-quiet", "--progress", "--newline", "--no-color",
        "--downloader", "native",
        "--socket-timeout", "30", "--retries", "3", "--fragment-retries", "3",
        "--progress-template",
        f"download:{PROGRESS_PREFIX}%(progress.status)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s",
    ]
    # yt-dlp が既定で使う Deno がない環境でも、Node.js があれば利用する。
    if shutil.which("node"):
        command.extend(["--js-runtimes", "node"])
    command.extend(["--", url])
    print(f"保存先: {MUSIC_DIR}\n形式: {audio_format.upper()}", flush=True)
    with subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1) as process:
        try:
            result = show_progress(process)
        except BaseException:
            # 中止・出力先の切断時も取得プロセスを残さない。
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
            raise
    if result:
        print(
            "取得または変換に失敗しました。上のエラーを確認し、通信状態・動画の公開状態・空き容量を確認してください。\n"
            "YouTube 側の変更が原因の場合: uv run --refresh scripts/youtube_audio.py",
            file=sys.stderr,
        )
    return result if result >= 0 else 1


def main(argv: list[str] | None = None) -> int:
    """引数を省略した場合は、URL と形式を対話で受け取る。"""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("url", nargs="?", type=youtube_url, help="YouTube の動画URL（省略すると入力を求めます）")
    parser.add_argument("-f", "--format", choices=("mp3", "wav"), help="保存形式（対話時の既定: mp3）")
    args = parser.parse_args(argv)
    try:
        url = args.url or youtube_url(input("YouTube のURLを貼り付けてください: "))
        audio_format = args.format
        if audio_format is None:
            print("保存形式を選んでください:\n  1) MP3\n  2) WAV")
        while audio_format is None:
            answer = input("選択 [1/2]（Enter: 1 = MP3）: ").strip().lower() or "1"
            answer = {"1": "mp3", "2": "wav"}.get(answer, answer)
            if answer in {"mp3", "wav"}:
                audio_format = answer
            else:
                print("1（MP3）または 2（WAV）を入力してください。")
        return download(url, audio_format)
    except argparse.ArgumentTypeError as exc:
        print(str(exc), file=sys.stderr)
        return 2
    except EOFError:
        print("\n入力が終了しました。ターミナルで実行するか --format mp3 / wav を指定してください。", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        print("\n中止しました。", file=sys.stderr)
        return 130
    except OSError as exc:
        print(f"保存または実行に失敗しました: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
