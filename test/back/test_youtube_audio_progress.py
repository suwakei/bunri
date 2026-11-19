"""実際の yt-dlp とローカル配信で、取得が終わる前に進捗が届くか確かめる。"""

import io
import queue
import subprocess
import sys
import threading
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest


def test_progress_arrives_before_download_finishes(tmp_path):
    pytest.importorskip("yt_dlp")
    audio = io.BytesIO()
    with wave.open(audio, "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(44100)
        output.writeframes(bytes(1048576))
    payload = audio.getvalue()
    release = threading.Event()
    finished = threading.Event()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            self.send_response(200)
            self.send_header("Content-Type", "audio/wav")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            try:
                self.wfile.write(payload[:65536])
                self.wfile.flush()
                release.wait(10)
                self.wfile.write(payload[65536:])
                self.wfile.flush()
                finished.set()
            except (BrokenPipeError, ConnectionResetError):
                pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    serving = threading.Thread(target=server.serve_forever, daemon=True)
    serving.start()
    script = Path(__file__).resolve().parents[2] / "scripts" / "youtube_audio.py"
    runner = tmp_path / "runner.py"
    runner.write_text(
        "import importlib.util, pathlib, sys\n"
        f"spec = importlib.util.spec_from_file_location('downloader', {str(script)!r})\n"
        "module = importlib.util.module_from_spec(spec)\n"
        "spec.loader.exec_module(module)\n"
        "module.youtube_url = lambda value: value\n"
        f"module.MUSIC_DIR = pathlib.Path({str(tmp_path / 'music')!r})\n"
        "sys.exit(module.download(sys.argv[1], 'wav'))\n"
    )
    lines = queue.Queue()
    process = subprocess.Popen(
        [sys.executable, str(runner), f"http://127.0.0.1:{server.server_port}/sample.wav"],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    )

    def read_output():
        for line in process.stdout:
            lines.put(line)
        lines.put(None)

    reading = threading.Thread(target=read_output, daemon=True)
    reading.start()
    collected = []
    try:
        while True:
            line = lines.get(timeout=15)
            assert line is not None, "進捗なしで終了: " + "".join(collected)
            collected.append(line)
            if "取得中 [" in line:
                assert not finished.is_set(), "取得が終わるまで進捗が表示されませんでした"
                assert "100.0%" not in line
                break
        release.set()
        assert process.wait(timeout=20) == 0
        assert list((tmp_path / "music").glob("*.wav"))
    finally:
        release.set()
        if process.poll() is None:
            process.kill()
        process.wait()
        reading.join(timeout=5)
        server.shutdown()
        server.server_close()
        serving.join(timeout=5)
