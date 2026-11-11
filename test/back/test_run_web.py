"""起動スクリプト（backend/run_web.py）のテスト

sidecar として起動したときの約束を確かめる。

- ポートは Python 側が決め、標準出力に 1 行の JSON で知らせる
- トークン無しのリクエストには 401 を返す
- 親（標準入力のパイプを握っている側）が居なくなったら自分で終わる
"""
import json
import os
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

import pytest

import run_web

BACKEND_DIR = Path(__file__).resolve().parent.parent.parent / "backend"


class TestParseArgs:
    def test_ブラウザ版の既定値は今までどおり(self):
        args = run_web.parse_args([])
        assert (args.host, args.port, args.no_browser, args.sidecar) == ("127.0.0.1", 8000, False, False)

    def test_sidecarは空きポートでブラウザを開かない(self):
        args = run_web.parse_args(["--sidecar"])
        assert (args.port, args.no_browser, args.sidecar) == (0, True, True)

    def test_ポートとホストを指定できる(self):
        args = run_web.parse_args(["--host", "0.0.0.0", "--port", "9000", "--no-browser"])
        assert (args.host, args.port, args.no_browser) == ("0.0.0.0", 9000, True)


class TestBindSocket:
    def test_ポート0なら空きポートが決まり_すぐ接続を受けられる(self):
        sock = run_web.bind_socket("127.0.0.1", 0)
        try:
            port = sock.getsockname()[1]
            assert port > 0
            # listen 済みなので、accept される前でも接続は成立する
            with socket.create_connection(("127.0.0.1", port), timeout=2):
                pass
        finally:
            sock.close()

    def test_announceは1行のJSONを出す(self, capsys):
        run_web.announce(12345)
        out = capsys.readouterr().out
        assert out.endswith("\n") and out.count("\n") == 1
        assert json.loads(out) == {"event": "listening", "port": 12345, "pid": os.getpid()}


def _get(port, path, token=None):
    """HTTP GET して (ステータス, 本文) を返す"""
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}")
    if token:
        req.add_header("X-Bunri-Token", token)
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def _alive(pid):
    """プロセスがまだ居るか"""
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


@pytest.mark.skipif(sys.platform == "win32", reason="プロセスの生死確認が POSIX 前提")
class TestSidecar:
    """実際に sidecar として起動して確かめる（空きポートで数秒だけ動かす）"""

    @pytest.fixture
    def sidecar(self, tmp_path):
        env = dict(os.environ, BUNRI_TOKEN="test-token", BUNRI_ALLOWED_ORIGINS="tauri://localhost",
                   BUNRI_DATA_DIR=str(tmp_path))
        proc = subprocess.Popen(
            [sys.executable, str(BACKEND_DIR / "run_web.py"), "--sidecar"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=env,
        )
        try:
            line = proc.stdout.readline()
            yield proc, json.loads(line)
        finally:
            if proc.poll() is None:
                proc.kill()
            proc.wait(timeout=10)
            proc.stdout.close()
            if proc.stdin and not proc.stdin.closed:
                proc.stdin.close()

    def test_ポートを知らせ_トークンで守られ_親が居なくなると終わる(self, sidecar):
        proc, info = sidecar
        assert info["event"] == "listening"
        assert info["pid"] == proc.pid
        port = info["port"]
        assert port not in (0, 8000)

        # トークン無しは 401、トークン付きは通る
        assert _get(port, "/api/gm-instruments")[0] == 401
        status, body = _get(port, "/api/gm-instruments", token="test-token")
        assert status == 200
        assert isinstance(json.loads(body), (list, dict))

        # 親が居なくなった（標準入力のパイプが閉じた）ら、自分で終わる
        proc.stdin.close()
        deadline = time.time() + 10
        while proc.poll() is None and time.time() < deadline:
            time.sleep(0.05)
        assert proc.poll() is not None, "標準入力が閉じても sidecar が終了しない"
        assert not _alive(proc.pid)

    def test_親が居なくなると_起動した子プロセスも終わる(self):
        """demucs の実行などの子プロセスを孤児にしない（サーバは起動しない）"""
        code = (
            "import subprocess, sys, time\n"
            f"sys.path.insert(0, {str(BACKEND_DIR)!r})\n"
            "import run_web\n"
            "run_web.watch_parent()\n"
            "child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(600)'])\n"
            "print(child.pid, flush=True)\n"
            "time.sleep(600)\n"
        )
        proc = subprocess.Popen([sys.executable, "-c", code], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
        try:
            child_pid = int(proc.stdout.readline())
            assert _alive(proc.pid) and _alive(child_pid)

            proc.stdin.close()
            proc.wait(timeout=10)
            deadline = time.time() + 5
            while _alive(child_pid) and time.time() < deadline:
                time.sleep(0.05)
            assert not _alive(child_pid), "親が居なくなっても子プロセスが残っている"
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.wait(timeout=10)
            proc.stdout.close()
