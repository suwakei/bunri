"""音源を実際に取得せず、入力とダウンロード処理の境界を確かめる。"""

import argparse
import importlib.util
import io
import os
import subprocess
import sys
import threading
from pathlib import Path
from unittest.mock import MagicMock, Mock

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "youtube_audio.py"
spec = importlib.util.spec_from_file_location("youtube_audio", SCRIPT)
youtube_audio = importlib.util.module_from_spec(spec)
spec.loader.exec_module(youtube_audio)


@pytest.mark.parametrize("url", [
    "https://www.youtube.com/watch?v=abc&list=def",
    "https://youtu.be/abc",
    "https://music.youtube.com/watch?v=abc",
    "https://www.youtube.com/shorts/abc",
])
def test_accepts_youtube(url):
    assert youtube_audio.youtube_url(f" {url} ") == url


@pytest.mark.parametrize("url", [
    "", "--exec=bad", "file:///tmp/music", "https://youtube.com.evil.test/watch?v=abc",
    "https://evil.test/youtube.com", "https://youtube.com/", "https://youtube.com:bad/watch?v=abc",
    "https://user:password@youtube.com/watch?v=abc",
    "https://www.youtube.com/playlist?list=abc",
    "https://www.youtube.com/@channel/videos",
    "https://www.youtube.com/watch?list=abc",
    "https://www.youtube.com/watch?v=abc&v=def",
    "https://youtu.be/abc/def",
])
def test_rejects_other_inputs(url):
    with pytest.raises(argparse.ArgumentTypeError):
        youtube_audio.youtube_url(url)


@pytest.mark.parametrize("audio_format", ["mp3", "wav"])
def test_download_options_and_failure_code(monkeypatch, tmp_path, capsys, audio_format):
    output = tmp_path / "music"
    monkeypatch.setattr(youtube_audio, "MUSIC_DIR", output)
    monkeypatch.setattr(youtube_audio.shutil, "which", lambda name: f"/bin/{name}")
    process = MagicMock()
    process.__enter__.return_value = process
    process.stdout = iter(["__BUNRI_PROGRESS__finished|2|2|NA\n", "ERROR: test failure\n"])
    process.wait.return_value = 7
    run = Mock(return_value=process)
    monkeypatch.setattr(youtube_audio.subprocess, "Popen", run)
    url = "https://www.youtube.com/watch?v=abc&list=def"
    assert youtube_audio.download(url, audio_format) == 7
    assert output.is_dir()
    command = run.call_args.args[0]
    assert command[command.index("--audio-format") + 1] == audio_format
    assert command[command.index("--paths") + 1] == str(output)
    assert {"--no-playlist", "--no-overwrites", "--ignore-config", "--extract-audio"} <= set(command)
    assert command[-2:] == ["--", url]
    assert "--progress-template" in command
    assert "-u" in command
    assert "--no-quiet" in command
    assert command[command.index("--downloader") + 1] == "native"
    assert run.call_args.kwargs["stdout"] == subprocess.PIPE
    captured = capsys.readouterr()
    assert "変換中" in captured.out
    assert "ERROR: test failure" in captured.out
    assert "取得または変換に失敗" in captured.err


def test_missing_ffmpeg_does_not_start_download(monkeypatch, tmp_path):
    monkeypatch.setattr(youtube_audio, "MUSIC_DIR", tmp_path / "music")
    monkeypatch.setattr(youtube_audio.shutil, "which", lambda name: None)
    run = Mock()
    monkeypatch.setattr(youtube_audio.subprocess, "Popen", run)
    assert youtube_audio.download("https://youtu.be/abc", "mp3") == 1
    run.assert_not_called()
    assert not (tmp_path / "music").exists()


def test_interactive_format_retry(monkeypatch):
    url = "https://www.youtube.com/watch?v=abc&list=def&start_radio=1"
    answers = iter([url, "flac", "WAV"])
    monkeypatch.setattr("builtins.input", lambda prompt: next(answers))
    download = Mock(return_value=0)
    monkeypatch.setattr(youtube_audio, "download", download)
    assert youtube_audio.main([]) == 0
    download.assert_called_once_with(url, "wav")


def test_default_format(monkeypatch):
    monkeypatch.setattr("builtins.input", lambda prompt: "")
    download = Mock(return_value=0)
    monkeypatch.setattr(youtube_audio, "download", download)
    assert youtube_audio.main(["https://youtu.be/abc"]) == 0
    download.assert_called_once_with("https://youtu.be/abc", "mp3")


def test_output_is_repository_music():
    assert youtube_audio.MUSIC_DIR == SCRIPT.parent.parent / "music"


@pytest.mark.parametrize("answer,expected", [("1", "mp3"), ("2", "wav")])
def test_number_selection(monkeypatch, answer, expected):
    monkeypatch.setattr("builtins.input", lambda prompt: answer)
    download = Mock(return_value=0)
    monkeypatch.setattr(youtube_audio, "download", download)
    assert youtube_audio.main(["https://youtu.be/abc"]) == 0
    download.assert_called_once_with("https://youtu.be/abc", expected)


@pytest.mark.parametrize("error,code,message", [
    (PermissionError("denied"), 1, "保存または実行に失敗"),
    (EOFError(), 2, "入力が終了"),
    (KeyboardInterrupt(), 130, "中止しました"),
])
def test_errors_without_traceback(monkeypatch, capsys, error, code, message):
    monkeypatch.setattr(youtube_audio, "download", Mock(side_effect=error))
    assert youtube_audio.main(["https://youtu.be/abc", "--format", "mp3"]) == code
    assert message in capsys.readouterr().err


def test_progress_bar():
    text = youtube_audio.progress_bar("__BUNRI_PROGRESS__downloading|1048576|2097152|NA")
    assert "############------------" in text
    assert "50.0%" in text
    assert "1.0/2.0 MiB" in text
    assert "総量不明" in youtube_audio.progress_bar("__BUNRI_PROGRESS__downloading|1048576|NA|NA")
    assert "50.0%" in youtube_audio.progress_bar("__BUNRI_PROGRESS__downloading|1|NA|2")
    assert "変換中" in youtube_audio.progress_bar("__BUNRI_PROGRESS__finished|2|2|NA")


def test_waiting_indicator_and_progress_update_before_child_exit(monkeypatch):
    # 子を入力待ちで止め、表示されたことを合図に次へ進める。完了後の一括出力では通らない。
    with subprocess.Popen(
        [sys.executable, "-u", "-c",
         "input(); print('__BUNRI_PROGRESS__downloading|1|2|NA', flush=True); input()"],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True,
    ) as process:
        seen = set()

        class Terminal(io.StringIO):
            def isatty(self):
                return True

            def write(self, text):
                for key in ("経過", "50.0%"):
                    if key in text and key not in seen:
                        assert process.poll() is None
                        seen.add(key)
                        process.stdin.write("\n")
                        process.stdin.flush()
                return super().write(text)

        terminal = Terminal()
        monkeypatch.setattr(youtube_audio.sys, "stdout", terminal)
        timer = threading.Timer(5, process.kill)
        timer.start()
        try:
            assert youtube_audio.show_progress(process) == 0
            assert seen == {"経過", "50.0%"}
            assert "動画情報を取得中" in terminal.getvalue()
        finally:
            timer.cancel()


def test_interrupt_terminates_child(monkeypatch, tmp_path):
    monkeypatch.setattr(youtube_audio, "MUSIC_DIR", tmp_path / "music")
    monkeypatch.setattr(youtube_audio.shutil, "which", lambda name: "/bin/tool")
    process = MagicMock()
    process.__enter__.return_value = process
    process.stdout.__iter__.side_effect = KeyboardInterrupt
    monkeypatch.setattr(youtube_audio.subprocess, "Popen", Mock(return_value=process))
    assert youtube_audio.main(["https://youtu.be/abc", "--format", "mp3"]) == 130
    process.terminate.assert_called_once()


@pytest.mark.parametrize("url", [
    None,
    "https://youtu.be/abc",
    "https://www.youtube.com/watch?v=abc&list=def",
    "https://youtu.be/abc?si=some-token",
    "https://www.youtube.com/watch?v=abc&tag=`whoami`",
])
def test_make_dl_passes_url_as_one_argument(tmp_path, url):
    # uv の代わりに引数を記録し、ネットワーク通信なしで make の入口を通す。
    uv = tmp_path / "uv"
    uv.write_text('#!/bin/sh\nprintf "%s\\n" "$@"\n')
    uv.chmod(0o755)
    result = subprocess.run(
        ["make", "--no-print-directory", "dl", *([url] if url else [])], cwd=SCRIPT.parent.parent,
        env={**os.environ, "PATH": f"{tmp_path}{os.pathsep}{os.environ['PATH']}"},
        capture_output=True, text=True,
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.splitlines() == ["run", "scripts/youtube_audio.py", *([url] if url else [])]


@pytest.mark.parametrize("arguments", [["https://youtu.be/abc", "clean"], ["bad-url"]])
def test_make_dl_rejects_invalid_or_extra_arguments(arguments):
    # -n でレシピを実行せず、危険な別ターゲットが混ざった場合も入口で拒否する。
    result = subprocess.run(
        ["make", "-n", "dl", *arguments], cwd=SCRIPT.parent.parent, capture_output=True, text=True,
    )
    assert result.returncode != 0
    assert not result.stdout


def test_make_does_not_evaluate_url_expression(tmp_path):
    marker = tmp_path / "unexpected"
    url = f"https://www.youtube.com/watch?v=abc&tag=$(shell touch {marker})"
    subprocess.run(
        ["make", "-n", "dl", url], cwd=SCRIPT.parent.parent, capture_output=True, text=True,
    )
    assert not marker.exists()
