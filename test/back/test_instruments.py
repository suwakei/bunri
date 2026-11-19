"""ピアノの準備を小さな ZIP と偽の通信で検証する。本物の音源は取得しない。"""
import asyncio
import contextlib
import hashlib
import io
import json
import stat
import zipfile

import httpx
import pytest

import background_jobs
import instruments

HTTP_DOWNLOAD = instruments._download


def archive_bytes(extra=None):
    """サンプルの代わりに短い文字を入れた配布物を作る。"""
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as package:
        package.writestr("piano/" + instruments.PIANO["sfz"], "<region> sample=Samples/piano.flac")
        package.writestr("piano/LICENSE", "CC BY 3.0")
        package.writestr("piano/Samples/piano.flac", b"fake sample")
        package.writestr("piano/Data/controls.sfz", "// fake")
        if extra:
            name, content = extra
            package.writestr(name, content)
    return buffer.getvalue()


@pytest.fixture
def piano(tmp_path, monkeypatch):
    """データと素材の定義をテストごとに分離する。"""
    monkeypatch.setenv("BUNRI_DATA_DIR", str(tmp_path))
    payload = archive_bytes()
    spec = {**instruments.PIANO, "sha256": hashlib.sha256(payload).hexdigest(), "size": len(payload)}
    monkeypatch.setattr(instruments, "PIANO", spec)

    def download(dest, job):
        dest.write_bytes(payload)

    monkeypatch.setattr(instruments, "_download", download)
    return payload


def test_取得と照合と展開が済んだ版だけを使える(piano, monkeypatch):
    assert not instruments.piano_status()["installed"]
    result = instruments.install_piano()
    assert result["installed"]
    assert result["downloadBytes"] == len(piano)
    folder = instruments.piano_dir()
    assert (folder / "Samples/piano.flac").read_bytes() == b"fake sample"
    assert json.loads((folder / ".installed.json").read_text())["sha256"] == instruments.PIANO["sha256"]
    assert not list(folder.parent.glob("*.part"))
    assert not list(folder.parent.glob(".piano-*"))
    monkeypatch.setattr(instruments, "_download", lambda *args: pytest.fail("準備済みなら取得しない"))
    assert instruments.install_piano() == result


def test_素材だけや目印だけでは準備済みにしない(piano):
    folder = instruments.piano_dir()
    folder.mkdir(parents=True)
    (folder / instruments.PIANO["sfz"]).write_text("fake")
    assert not instruments.piano_status()["installed"]
    instruments.install_piano()
    (folder / "Data").rename(folder / "Data-missing")
    assert not instruments.piano_status()["installed"]


def test_壊れた配布物は破棄して展開しない(piano, monkeypatch):
    monkeypatch.setitem(instruments.PIANO, "sha256", "0" * 64)
    with pytest.raises(instruments.InstrumentUnavailableError, match="一致しません"):
        instruments.install_piano()
    assert not instruments.piano_status()["installed"]
    assert not list(instruments.piano_dir().parent.glob("*.part"))


@pytest.mark.parametrize("name", ["piano/../../escape", "/absolute/file", "piano/link\\escape", "other/file"])
def test_ZIPの外へ書き出さない(piano, tmp_path, name):
    archive = tmp_path / "unsafe.zip"
    archive.write_bytes(archive_bytes((name, b"x")))
    output = tmp_path / "unpacked"
    output.mkdir()
    with pytest.raises(instruments.InstrumentUnavailableError):
        instruments._extract(archive, output, None)
    assert not (tmp_path / "escape").exists()


def test_ZIPのリンクを展開しない(piano, tmp_path):
    archive = tmp_path / "link.zip"
    with zipfile.ZipFile(archive, "w") as package:
        item = zipfile.ZipInfo("piano/link")
        item.create_system = 3
        item.external_attr = (stat.S_IFLNK | 0o777) << 16
        package.writestr(item, "../../elsewhere")
    with pytest.raises(instruments.InstrumentUnavailableError):
        instruments._extract(archive, tmp_path / "unpacked", None)


def test_展開中の中止で準備済みにならず途中の展開を消す(piano, monkeypatch):
    def cancel(archive, folder, job):
        (folder / "partial").write_text("partial")
        raise background_jobs.JobCancelled()

    monkeypatch.setattr(instruments, "_extract", cancel)
    with pytest.raises(background_jobs.JobCancelled):
        instruments.install_piano()
    assert not instruments.piano_status()["installed"]
    assert not list(instruments.piano_dir().parent.glob(".piano-*"))
    assert list(instruments.piano_dir().parent.glob("*.part"))


@pytest.mark.parametrize("resume", [True, False])
def test_HTTPの続きが取れれば追記し非対応なら取り直す(piano, tmp_path, monkeypatch, resume):
    dest = tmp_path / "part"
    dest.write_bytes(piano[:10])

    @contextlib.contextmanager
    def stream(method, url, **kwargs):
        assert kwargs["headers"] == {"Range": "bytes=10-"}
        remaining = piano[10:] if resume else piano
        headers = {"Content-Range": f"bytes 10-{len(piano) - 1}/{len(piano)}"} if resume else {}
        yield httpx.Response(206 if resume else 200, content=remaining, headers=headers,
                             request=httpx.Request(method, url))

    monkeypatch.setattr(httpx, "stream", stream)
    HTTP_DOWNLOAD(dest, None)
    assert dest.read_bytes() == piano


def test_途中で通信が切れたら次回のために取得分を残す(piano, monkeypatch):
    def interrupted(dest, job):
        dest.write_bytes(piano[:10])
        raise OSError("offline")

    monkeypatch.setattr(instruments, "_download", interrupted)
    with pytest.raises(instruments.InstrumentUnavailableError, match="通信"):
        instruments.install_piano()
    assert instruments.piano_dir().with_suffix(".zip.part").read_bytes() == piano[:10]
    assert not instruments.piano_status()["installed"]


def test_HTTPの再開位置が違ったら追記しない(piano, tmp_path, monkeypatch):
    dest = tmp_path / "part"
    dest.write_bytes(piano[:10])

    @contextlib.contextmanager
    def stream(method, url, **kwargs):
        yield httpx.Response(206, content=piano,
                             headers={"Content-Range": f"bytes 0-{len(piano) - 1}/{len(piano)}"},
                             request=httpx.Request(method, url))

    monkeypatch.setattr(httpx, "stream", stream)
    with pytest.raises(instruments.InstrumentUnavailableError, match="続き"):
        HTTP_DOWNLOAD(dest, None)
    assert dest.read_bytes() == piano[:10]


def test_ダウンロード中に中止しても取得分は残す(piano, tmp_path, monkeypatch):
    dest = tmp_path / "part"
    dest.write_bytes(piano[:10])

    @contextlib.contextmanager
    def stream(method, url, **kwargs):
        yield httpx.Response(206, content=piano[10:],
                             headers={"Content-Range": f"bytes 10-{len(piano) - 1}/{len(piano)}"},
                             request=httpx.Request(method, url))

    class Cancelled:
        def check_cancelled(self):
            raise background_jobs.JobCancelled()

    monkeypatch.setattr(httpx, "stream", stream)
    with pytest.raises(background_jobs.JobCancelled):
        HTTP_DOWNLOAD(dest, Cancelled())
    assert dest.read_bytes() == piano[:10]


def test_APIは状態だけでは取得せず要求でジョブを始める(piano, monkeypatch):
    from web.api import app

    manager = background_jobs.JobManager()
    monkeypatch.setattr(background_jobs, "_default_manager", manager)

    async def run():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            state = await client.get("/api/instruments/piano")
            assert state.status_code == 200
            assert not state.json()["installed"]
            started = await client.post("/api/instruments/piano/install?async=1")
            assert started.status_code == 202
            job = started.json()
            assert job["kind"] == "instrument_install"
            for _ in range(100):
                result = (await client.get("/api/jobs/" + job["id"])).json()
                if result["state"] in ("done", "error"):
                    break
                await asyncio.sleep(0.01)
            assert result["state"] == "done"
            assert result["result"]["installed"]

    try:
        asyncio.run(run())
    finally:
        manager.shutdown()


def test_APIは準備の失敗を503と日本語の理由で返す(piano, monkeypatch):
    from web.api import app

    def failed(job=None):
        raise instruments.InstrumentUnavailableError("ピアノ音源の取得に失敗しました")

    manager = background_jobs.JobManager()
    monkeypatch.setattr(background_jobs, "_default_manager", manager)
    monkeypatch.setattr(instruments, "install_piano", failed)

    async def run():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            result = await client.post("/api/instruments/piano/install")
            assert result.status_code == 503
            assert result.json()["detail"] == "ピアノ音源の取得に失敗しました"

    try:
        asyncio.run(run())
    finally:
        manager.shutdown()
