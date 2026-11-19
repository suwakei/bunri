"""楽器の準備を小さな ZIP と偽の通信で検証する。本物の音源は取得しない。"""
import asyncio
import contextlib
import hashlib
import io
import json
import stat
import zipfile
from pathlib import Path, PurePosixPath

import httpx
import pytest

import background_jobs
import instruments

HTTP_DOWNLOAD = instruments._download


def archive_bytes(extra=None):
    """サンプルの代わりに短い文字を入れた配布物を作る。"""
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as package:
        package.writestr("piano/" + instruments.INSTRUMENTS["salamander"]["sfz"], "<region> sample=Samples/piano.flac")
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
    spec = {**instruments.PACKS["salamander"], "sha256": hashlib.sha256(payload).hexdigest(),
            "size": len(payload), "expandedBytes": 1 << 20, "requiredPaths": ["LICENSE", "Samples", "Data"]}
    monkeypatch.setattr(instruments, "PACKS", {"salamander": spec})
    monkeypatch.setattr(instruments, "INSTRUMENTS", {"salamander": instruments.INSTRUMENTS["salamander"]})
    monkeypatch.setattr(instruments, "_prepare_pack", lambda *args: None)

    def download(dest, job, pack):
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
    assert json.loads((folder / ".installed.json").read_text())["sha256"] == instruments.PACKS["salamander"]["sha256"]
    assert not list(folder.parent.glob("*.part"))
    assert not list(folder.parent.glob(".instrument-*"))
    monkeypatch.setattr(instruments, "_download", lambda *args: pytest.fail("準備済みなら取得しない"))
    assert instruments.install_piano() == result


def test_素材だけや目印だけでは準備済みにしない(piano):
    folder = instruments.piano_dir()
    folder.mkdir(parents=True)
    (folder / instruments.INSTRUMENTS["salamander"]["sfz"]).write_text("fake")
    assert not instruments.piano_status()["installed"]
    instruments.install_piano()
    (folder / "Data").rename(folder / "Data-missing")
    assert not instruments.piano_status()["installed"]


def test_壊れた配布物は破棄して展開しない(piano, monkeypatch):
    monkeypatch.setitem(instruments.PACKS["salamander"], "sha256", "0" * 64)
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
        instruments._extract(archive, output, None, instruments.PACKS["salamander"])
    assert not (tmp_path / "escape").exists()


def test_ZIPのリンクを展開しない(piano, tmp_path):
    archive = tmp_path / "link.zip"
    with zipfile.ZipFile(archive, "w") as package:
        item = zipfile.ZipInfo("piano/link")
        item.create_system = 3
        item.external_attr = (stat.S_IFLNK | 0o777) << 16
        package.writestr(item, "../../elsewhere")
    with pytest.raises(instruments.InstrumentUnavailableError):
        instruments._extract(archive, tmp_path / "unpacked", None, instruments.PACKS["salamander"])


def test_展開中の中止で準備済みにならず途中の展開を消す(piano, monkeypatch):
    def cancel(archive, folder, job, pack):
        (folder / "partial").write_text("partial")
        raise background_jobs.JobCancelled()

    monkeypatch.setattr(instruments, "_extract", cancel)
    with pytest.raises(background_jobs.JobCancelled):
        instruments.install_piano()
    assert not instruments.piano_status()["installed"]
    assert not list(instruments.piano_dir().parent.glob(".instrument-*"))
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
    HTTP_DOWNLOAD(dest, None, instruments.PACKS["salamander"])
    assert dest.read_bytes() == piano


def test_途中で通信が切れたら次回のために取得分を残す(piano, monkeypatch):
    def interrupted(dest, job, pack):
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
        HTTP_DOWNLOAD(dest, None, instruments.PACKS["salamander"])
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
        HTTP_DOWNLOAD(dest, Cancelled(), instruments.PACKS["salamander"])
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


def test_同じ素材の別の楽器を選んでも取得を繰り返さない(piano, monkeypatch):
    instrument = {**instruments.INSTRUMENTS["salamander"], "id": "piano-soft", "name": "柔らかいピアノ"}
    monkeypatch.setitem(instruments.INSTRUMENTS, instrument["id"], instrument)
    received = []

    def download(dest, job, pack):
        received.append(pack["id"])
        dest.write_bytes(piano)

    monkeypatch.setattr(instruments, "_download", download)
    assert instruments.install_instrument("salamander")["installed"]
    assert instruments.install_instrument("piano-soft")["id"] == "piano-soft"
    assert received == ["salamander"]
    statuses = instruments.library_status()["instruments"]
    assert len(statuses) == 2
    assert all(item["installed"] and item["packId"] == "salamander" for item in statuses)


def test_素材を確認するのは一覧の中で素材ごとに一度だけ(piano, monkeypatch):
    instrument = {**instruments.INSTRUMENTS["salamander"], "id": "piano-soft"}
    monkeypatch.setitem(instruments.INSTRUMENTS, instrument["id"], instrument)
    seen = []
    monkeypatch.setattr(instruments, "_installed", lambda pack_id: seen.append(pack_id) or False)
    statuses = instruments.library_status()["instruments"]
    assert len(statuses) == 2
    assert seen == ["salamander"]


def test_同じ素材で提供する別の楽器のSFZも揃うまで公開しない(piano, monkeypatch):
    instrument = {**instruments.INSTRUMENTS["salamander"], "id": "missing", "sfz": "missing.sfz"}
    monkeypatch.setitem(instruments.INSTRUMENTS, instrument["id"], instrument)
    with pytest.raises(instruments.InstrumentUnavailableError, match="揃っていません"):
        instruments.install_instrument("salamander")
    assert not instruments.instrument_status("salamander")["installed"]
    assert not (instruments.piano_dir() / ".installed.json").exists()


def test_派生プリセットを作ってから素材全体を公開する(piano, monkeypatch):
    instrument = {**instruments.INSTRUMENTS["salamander"], "id": "choir", "sfz": "derived/choir.sfz"}
    monkeypatch.setitem(instruments.INSTRUMENTS, instrument["id"], instrument)
    seen = []

    def prepare(pack_id, folder, job):
        seen.append(pack_id)
        assert (folder / instruments.INSTRUMENTS["salamander"]["sfz"]).is_file()
        assert not instruments.piano_status()["installed"]
        (folder / "derived").mkdir()
        (folder / "derived/choir.sfz").write_text("<region> sample=../Samples/piano.flac")

    monkeypatch.setattr(instruments, "_prepare_pack", prepare)
    assert instruments.install_instrument("choir")["installed"]
    assert seen == ["salamander"]
    (instruments.piano_dir() / "derived/choir.sfz").unlink()
    assert not instruments.instrument_status("salamander")["installed"]


def test_同梱の楽器はクリックされるまで用意せず通信も行わない(piano, monkeypatch):
    pack = {**instruments.PACKS["salamander"], "id": "retro", "version": "1.0",
            "builtin": True, "size": 0, "expandedBytes": 1024, "requiredPaths": ["LICENSE"]}
    pack.pop("url", None)
    monkeypatch.setitem(instruments.PACKS, "retro", pack)
    instrument = {**instruments.INSTRUMENTS["salamander"], "id": "retro-bell", "pack": "retro", "sfz": "bell.sfz"}
    monkeypatch.setitem(instruments.INSTRUMENTS, instrument["id"], instrument)
    monkeypatch.setattr(instruments, "_download", lambda *args: pytest.fail("同梱楽器は通信しない"))
    monkeypatch.setattr(instruments, "_verify", lambda *args: pytest.fail("同梱楽器はZIPを照合しない"))
    prepared = []

    def prepare(pack_id, folder, job):
        prepared.append(pack_id)
        (folder / "LICENSE").write_text("CC0")
        (folder / "bell.sfz").write_text("<region> sample=*sine")

    monkeypatch.setattr(instruments, "_prepare_pack", prepare)
    assert not instruments.instrument_status("retro-bell")["installed"]
    assert not prepared
    result = instruments.install_instrument("retro-bell")
    assert result["installed"] and result["downloadBytes"] == 0
    assert prepared == ["retro"]
    assert instruments.pack_dir("retro").name == "1.0"
    assert not list(instruments.pack_dir("retro").parent.glob("*.part"))


def test_同梱の準備中のキャンセルも伝播して未完了を公開しない(piano, monkeypatch):
    monkeypatch.setitem(instruments.PACKS["salamander"], "builtin", True)

    def cancel(pack_id, folder, job):
        (folder / "half.wav").write_bytes(b"half")
        raise background_jobs.JobCancelled()

    monkeypatch.setattr(instruments, "_prepare_pack", cancel)
    with pytest.raises(background_jobs.JobCancelled):
        instruments.install_instrument("salamander")
    assert not instruments.piano_status()["installed"]
    assert not list(instruments.piano_dir().parent.glob(".instrument-*"))


def test_6GBの素材もカタログの展開上限を使って確認する(piano, tmp_path, monkeypatch):
    expanded = 6 * 1024 ** 3
    item = zipfile.ZipInfo("root/large.wav")
    item.file_size = expanded

    class LargeArchive:
        def __init__(self, _archive):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

        def infolist(self):
            return [item]

        def open(self, _item):
            return io.BytesIO(b"fake")

    monkeypatch.setattr(instruments.zipfile, "ZipFile", LargeArchive)
    output = tmp_path / "large"
    pack = {**instruments.PACKS["salamander"], "expandedBytes": expanded}
    instruments._extract(tmp_path / "fake.zip", output, None, pack)
    assert (output / "large.wav").is_file()
    pack["expandedBytes"] = expanded - 1
    with pytest.raises(instruments.InstrumentUnavailableError, match="大きすぎます"):
        instruments._extract(tmp_path / "fake.zip", tmp_path / "too-large", None, pack)


def test_汎用APIで一覧と不明な楽器と取得の失敗を返す(piano, monkeypatch):
    from web.api import app

    manager = background_jobs.JobManager()
    monkeypatch.setattr(background_jobs, "_default_manager", manager)

    def failed(instrument_id, job=None):
        raise instruments.InstrumentUnavailableError("楽器の素材がありません")

    monkeypatch.setattr(instruments, "install_instrument", failed)

    async def run():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            result = await client.get("/api/instruments")
            assert result.status_code == 200
            status = result.json()["instruments"][0]
            assert status["id"] == "salamander" and status["kind"] == "sampler"
            assert status["category"] and status["packId"] == "salamander"
            assert not status["installed"]
            unknown = await client.post("/api/instruments/unknown/install?async=1")
            assert unknown.status_code == 404
            assert manager.jobs() == []
            failed = await client.post("/api/instruments/salamander/install")
            assert failed.status_code == 503
            assert failed.json()["detail"] == "楽器の素材がありません"

    try:
        asyncio.run(run())
    finally:
        manager.shutdown()


def test_ルートフォルダのない公式配布ZIPも指定どおり展開できる(piano, tmp_path):
    archive = tmp_path / "rootless.zip"
    with zipfile.ZipFile(archive, "w") as package:
        package.writestr("LICENSE", "CC0")
        package.writestr("guitar.sfz", "<region> sample=note.wav")
        package.writestr("note.wav", b"fake")
    output = tmp_path / "instrument"
    pack = {**instruments.PACKS["salamander"], "stripRoot": False}
    instruments._extract(archive, output, None, pack)
    assert (output / "guitar.sfz").is_file()
    assert (output / "note.wav").read_bytes() == b"fake"


def test_カタログには一般的な楽器と声とゲーム音が揃い素材を共有する():
    catalog = json.loads(Path(instruments.__file__).with_name("instrument_catalog.json").read_text())
    packs, entries = catalog["packs"], catalog["instruments"]
    expected = {
        "salamander", "violin", "viola", "cello", "contrabass", "flute", "piccolo", "oboe", "clarinet",
        "bassoon", "french-horn", "trumpet", "trombone", "tuba", "harp", "marimba", "glockenspiel",
        "xylophone", "timpani", "tubular-bells", "organ", "upright-piano", "saxophone", "harmonica",
        "recorder", "ocarina", "harpsichord", "vibraphone", "kalimba", "electric-piano", "electric-guitar",
        "electric-bass", "acoustic-guitar-nylon", "acoustic-guitar-steel", "drum-kit", "solo-voice-ah", "choir-ah",
        "game-lead", "game-square", "game-triangle", "game-saw", "game-flute", "game-strings", "game-brass",
        "game-pad", "game-bass", "game-pluck", "game-bell", "game-organ", "game-voice", "game-piano", "game-drums",
    }
    assert expected <= entries.keys()
    categories = {"鍵盤", "ギター", "ベース", "弦楽器", "金管", "木管", "打楽器", "民族楽器", "声・コーラス", "16bitゲーム", "効果音"}
    for instrument_id, entry in entries.items():
        assert entry["id"] == instrument_id
        assert entry["pack"] in packs
        assert entry["category"] in categories
        assert isinstance(entry["oneShot"], bool)
        assert any("\u3040" <= character <= "\u9fff" for character in entry["name"])
        sfz = PurePosixPath(entry["sfz"])
        assert not sfz.is_absolute() and ".." not in sfz.parts and sfz.suffix == ".sfz"
        assert not any(part in {"modules", "mappings", "maps", "controls"} for part in sfz.parts)
        assert not any(token in sfz.stem.lower() for token in ["keyswitch", "keysw", "-ks", "legacy"])
        if entry["category"] in {"鍵盤", "弦楽器", "金管", "木管", "ギター", "ベース"}:
            assert not entry["oneShot"]
    for pack_id, pack in packs.items():
        assert pack_id == pack["id"]
        assert pack["license"] in {"CC0-1.0", "CC-BY-3.0", "CC-BY-4.0"}
        assert pack["requiredPaths"] and pack["version"] and pack["author"]
        if pack.get("builtin"):
            assert pack["size"] == 0
        else:
            assert pack["url"].startswith("https://") and pack["expandedBytes"] > 0
    assert entries["solo-voice-ah"]["pack"] == entries["choir-ah"]["pack"] == "voice"
    assert "単独男声" in entries["choir-ah"]["description"] and "重ねた合唱" in entries["choir-ah"]["description"]
    assert packs["vcsl"]["expandedBytes"] > 6_000_000_000
    assert packs["acoustic-guitar-nylon"]["stripRoot"] is False
