"""音源を実際に取得せず、入力とダウンロード処理の境界を確かめる。"""

import argparse
import importlib.util
from pathlib import Path
from unittest.mock import Mock

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
def test_download_options_and_failure_code(monkeypatch, tmp_path, audio_format):
    output = tmp_path / "music"
    monkeypatch.setattr(youtube_audio, "MUSIC_DIR", output)
    monkeypatch.setattr(youtube_audio.shutil, "which", lambda name: f"/bin/{name}")
    run = Mock(return_value=Mock(returncode=7))
    monkeypatch.setattr(youtube_audio.subprocess, "run", run)
    url = "https://www.youtube.com/watch?v=abc&list=def"
    assert youtube_audio.download(url, audio_format) == 7
    assert output.is_dir()
    command = run.call_args.args[0]
    assert command[command.index("--audio-format") + 1] == audio_format
    assert command[command.index("--paths") + 1] == str(output)
    assert {"--no-playlist", "--no-overwrites", "--ignore-config", "--extract-audio"} <= set(command)
    assert command[-2:] == ["--", url]
    assert run.call_args.kwargs == {"check": False}


def test_missing_ffmpeg_does_not_start_download(monkeypatch, tmp_path):
    monkeypatch.setattr(youtube_audio, "MUSIC_DIR", tmp_path / "music")
    monkeypatch.setattr(youtube_audio.shutil, "which", lambda name: None)
    run = Mock()
    monkeypatch.setattr(youtube_audio.subprocess, "run", run)
    assert youtube_audio.download("https://youtu.be/abc", "mp3") == 1
    run.assert_not_called()
    assert not (tmp_path / "music").exists()


def test_interactive_format_retry(monkeypatch):
    answers = iter(["https://youtu.be/abc", "flac", "WAV"])
    monkeypatch.setattr("builtins.input", lambda prompt: next(answers))
    download = Mock(return_value=0)
    monkeypatch.setattr(youtube_audio, "download", download)
    assert youtube_audio.main([]) == 0
    download.assert_called_once_with("https://youtu.be/abc", "wav")


def test_default_format(monkeypatch):
    monkeypatch.setattr("builtins.input", lambda prompt: "")
    download = Mock(return_value=0)
    monkeypatch.setattr(youtube_audio, "download", download)
    assert youtube_audio.main(["https://youtu.be/abc"]) == 0
    download.assert_called_once_with("https://youtu.be/abc", "mp3")


def test_output_is_repository_music():
    assert youtube_audio.MUSIC_DIR == SCRIPT.parent.parent / "music"
