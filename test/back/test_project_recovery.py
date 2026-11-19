"""落ちたときの復旧（自動保存の写し）のテスト

- 置く・読む・開く・消す（目印に名前・利用者のファイルの場所・書いた時刻が入る）
- 置き直すと前の写しは残らない。作業用の写しは移す（2 つ持たない）が、``base`` に指定すれば音声を写せる
- 途中で失敗しても、前の復旧用の写しがそのまま読める（書きかけを見せない）
- 目印が壊れている・写しが無いときは「復旧できるものは無い」
- データの整理が、復旧用の写しを消さない
- API（POST / GET / open / DELETE）
"""
import io
import json
import os
import time
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf
from httpx import ASGITransport, AsyncClient

import audio_utils
import bunri_file
import project_store


@pytest.fixture
def data_dir(tmp_path, monkeypatch):
    """データ置き場を一時ディレクトリへ向ける"""
    monkeypatch.setenv("BUNRI_DATA_DIR", str(tmp_path / "data"))
    return tmp_path / "data"


def wav_bytes(seed=0, seconds=0.3, sr=22050):
    """少しだけ雑音を混ぜたサイン波の WAV"""
    rng = np.random.default_rng(seed)
    t = np.arange(int(seconds * sr)) / sr
    out = io.BytesIO()
    sf.write(out, 0.4 * np.sin(2 * np.pi * 440 * t) + 0.01 * rng.standard_normal(t.size), sr, format="WAV", subtype="PCM_16")
    return out.getvalue()


def note(name, octave, step, length=4):
    return {"note": name, "octave": octave, "step": step, "length": length}


def document(audio_hash=None, notes=(), name="デモ曲"):
    """トラック 1 本の文書。``audio_hash`` を渡すとクリップを 1 つ持つ（None なら音声の無いクリップ）"""
    return {
        "version": 1,
        "meta": {"name": name, "createdAt": None, "appVersion": "0.1.0"},
        "grid": {"bpm": 96.0, "beatsPerBar": 4, "gridOffset": 0.0},
        "tracks": [{
            "name": "Track 1", "role": None, "part": None, "practiceOf": None, "gain": 0, "pan": 0,
            "mute": False, "solo": False, "notes": list(notes), "referenceNotes": None,
            "clips": [{"name": "take.wav", "offset": 0, "duration": 0.3, "audio": audio_hash}],
        }],
        "chart": None, "state": {}, "history": [],
    }


def autosave(doc, base=None, **mark):
    """画面の自動保存と同じ順で呼ぶ（文書を作業用の写しに書いて、復旧用の写しにする）。写しの名前を返す"""
    token = project_store.save_document(doc, base=base)["token"]
    project_store.recovery_put(token, **mark)
    return token


def recovery_files(data_dir):
    """復旧の置き場に在るファイルの名前"""
    return {p.name for p in (data_dir / "recovery").iterdir()}


class TestRecovery:
    def test_置く_読む_開く_消す(self, data_dir):
        song = wav_bytes()
        h = bunri_file.audio_hash(song)
        assert project_store.recovery_info() is None
        project_store.stage_audio(h, song, "take.wav")
        token = autosave(document(h, [note("C", 4, 0)]), name="デモ曲", path="/Users/me/Documents/bunri/デモ曲.bunri", now=1000.5)

        info = project_store.recovery_info()
        assert info["name"] == "デモ曲" and info["path"] == "/Users/me/Documents/bunri/デモ曲.bunri"
        assert info["file"] is None and info["saved_at"] == 1000.5 and info["size_bytes"] > 0
        # 置き場には、写し 1 つと目印だけ。作業用の写しは移してある (2 つ持たない)
        assert recovery_files(data_dir) == {"recovery.json", f"{token}.bunri"}
        assert not project_store.work_path(token).exists()

        opened = project_store.recovery_open()
        assert opened["token"] != token
        assert {k: opened[k] for k in ("name", "path", "file")} == {k: info[k] for k in ("name", "path", "file")}
        doc = project_store.open_document(opened["token"])
        assert doc["tracks"][0]["notes"] == [note("C", 4, 0)]
        assert project_store.read_audio(opened["token"], h)[1] == "audio/wav"
        # 開いても、復旧用の写しは残る (まだ保存していない変更のまま)
        assert project_store.recovery_info() is not None

        assert project_store.recovery_clear() is True
        assert project_store.recovery_info() is None
        assert recovery_files(data_dir) == set()
        assert project_store.recovery_clear() is False
        with pytest.raises(project_store.ProjectError) as e:
            project_store.recovery_open()
        assert e.value.status == 404

    def test_置き直すと前の写しは残らず_音声は送り直さなくてよい(self, data_dir):
        song = wav_bytes()
        h = bunri_file.audio_hash(song)
        project_store.stage_audio(h, song, "take.wav")
        first = autosave(document(h), name="A")
        # 自動保存の写しは work/ に無いが、base に指定すれば、そこに在る音声は送らなくてよい
        assert project_store.missing_audio(first, [h]) == []
        second = autosave(document(h, [note("E", 4, 4)]), base=first, name="A")
        assert recovery_files(data_dir) == {"recovery.json", f"{second}.bunri"}
        # 利用者の保存も、自動保存の写しを base にできる (音声を送り直さない)
        saved = project_store.save_document(document(h, [note("E", 4, 4), note("G", 4, 8)]), base=second)
        doc = project_store.open_document(saved["token"])
        assert len(doc["tracks"][0]["notes"]) == 2
        assert project_store.read_audio(saved["token"], h) is not None
        # 復旧用の写しを消したあとは、その名前を base にしても何も写せないだけ (送ってもらう)
        project_store.recovery_clear()
        assert project_store.missing_audio(second, [h]) == [h]

    def test_名前もファイルの場所も無いプロジェクト_音声の無いクリップ(self, data_dir):
        token = autosave(document(None, [note("C", 4, 0)]))
        info = project_store.recovery_info()
        assert (info["name"], info["path"], info["file"]) == (None, None, None)
        assert time.time() - info["saved_at"] < 60
        doc = project_store.open_document(project_store.recovery_open()["token"])
        assert doc["tracks"][0]["clips"][0]["audio"] is None
        assert json.loads((data_dir / "recovery" / "recovery.json").read_text(encoding="utf-8"))["token"] == token

    def test_開発用のブラウザ起動の置き場の名前も戻る(self, data_dir):
        autosave(document(), name="学ぶ流れ", file="学ぶ流れ.bunri")
        assert project_store.recovery_open()["file"] == "学ぶ流れ.bunri"

    def test_指定の形が正しくなければ断る(self, data_dir):
        token = project_store.save_document(document())["token"]
        for bad in ({"name": 5}, {"path": ["/x"]}, {"file": "a" * 300}, {"name": "x\x00y"}):
            with pytest.raises(project_store.ProjectError) as e:
                project_store.recovery_put(token, **bad)
            assert e.value.status == 400
        for bad_token in ("../x", "", None, "g" * 24):
            with pytest.raises(project_store.ProjectError) as e:
                project_store.recovery_put(bad_token)
            assert e.value.status == 400
        with pytest.raises(project_store.ProjectError) as e:
            project_store.recovery_put("0" * 24)
        assert e.value.status == 404
        # 断ったときは、作業用の写しも復旧の置き場もそのまま
        assert project_store.work_path(token).exists()
        assert project_store.recovery_info() is None


class TestNoHalfWritten:
    def test_目印を書けなかったら_前の復旧用の写しがそのまま読める(self, data_dir, monkeypatch):
        first = autosave(document(None, [note("C", 4, 0)]), name="前の", now=10.0)
        token = project_store.save_document(document(None, [note("D", 4, 0)]))["token"]

        real = Path.write_text

        def failing(self, *args, **kwargs):
            if self.name.endswith(".tmp"):
                raise OSError("ディスクがいっぱい")
            return real(self, *args, **kwargs)

        monkeypatch.setattr(Path, "write_text", failing)
        with pytest.raises(OSError):
            project_store.recovery_put(token, name="新しい", now=20.0)
        monkeypatch.undo()
        monkeypatch.setenv("BUNRI_DATA_DIR", str(data_dir))

        info = project_store.recovery_info()
        assert (info["name"], info["saved_at"]) == ("前の", 10.0)
        doc = project_store.open_document(project_store.recovery_open()["token"])
        assert doc["tracks"][0]["notes"] == [note("C", 4, 0)]
        # 目印の無い写しは、次に置いたときに片付く
        latest = autosave(document(None, [note("E", 4, 0)]), base=first, name="次の")
        assert recovery_files(data_dir) == {"recovery.json", f"{latest}.bunri"}

    def test_写しを移せなかったら_何も変わらない(self, data_dir, monkeypatch):
        autosave(document(None, [note("C", 4, 0)]), name="前の", now=10.0)
        token = project_store.save_document(document())["token"]

        real = Path.replace

        def failing(self, target):
            if Path(target).parent.name == "recovery" and Path(target).suffix == ".bunri":
                raise OSError("移せない")
            return real(self, target)

        monkeypatch.setattr(Path, "replace", failing)
        with pytest.raises(OSError):
            project_store.recovery_put(token, name="新しい")
        monkeypatch.undo()
        monkeypatch.setenv("BUNRI_DATA_DIR", str(data_dir))
        assert project_store.recovery_info()["name"] == "前の"
        assert project_store.work_path(token).exists()

    def test_目印が壊れている_写しが無いなら_復旧できるものは無い(self, data_dir):
        token = autosave(document(), name="A")
        mark = data_dir / "recovery" / "recovery.json"
        good = mark.read_text(encoding="utf-8")

        mark.write_text("{ 途中まで", encoding="utf-8")
        assert project_store.recovery_info() is None
        mark.write_text(json.dumps({"token": "../../etc/passwd"}), encoding="utf-8")
        assert project_store.recovery_info() is None
        mark.write_text(json.dumps(["token"]), encoding="utf-8")
        assert project_store.recovery_info() is None

        mark.write_text(good, encoding="utf-8")
        assert project_store.recovery_info() is not None
        (data_dir / "recovery" / f"{token}.bunri").unlink()
        assert project_store.recovery_info() is None
        with pytest.raises(project_store.ProjectError):
            project_store.recovery_open()
        # 読めない目印は、消すと片付く
        assert project_store.recovery_clear() is False
        assert recovery_files(data_dir) == set()


class TestCleanup:
    def test_データの整理は_復旧用の写しを消さない(self, data_dir):
        song = wav_bytes()
        h = bunri_file.audio_hash(song)
        project_store.stage_audio(h, song, "take.wav")
        token = autosave(document(h, [note("C", 4, 0)]), name="A")
        old = time.time() - 3600
        for p in (data_dir / "recovery").iterdir():
            os.utime(p, (old, old))
        stale = project_store.save_document(document())["token"]
        os.utime(project_store.work_path(stale), (old, old))

        usage = project_store.storage_usage()
        recovery = next(c for c in usage["categories"] if c["key"] == "recovery")
        assert recovery["cleanable"] is False and recovery["files"] == 2 and recovery["bytes"] > 0

        result = project_store.cleanup(min_age_sec=0)
        assert result["removed_files"] >= 1 and not project_store.work_path(stale).exists()
        assert recovery_files(data_dir) == {"recovery.json", f"{token}.bunri"}
        # 整理のあとも、音声ごと続きを開ける
        opened = project_store.recovery_open()
        doc = project_store.open_document(opened["token"])
        assert doc["tracks"][0]["notes"] == [note("C", 4, 0)]
        assert project_store.read_audio(opened["token"], h) is not None

    def test_置き場の解決(self, data_dir):
        assert audio_utils.recovery_dir() == data_dir.resolve() / "recovery"
        assert audio_utils.recovery_dir().is_dir()


class TestApi:
    @pytest.fixture
    def client(self):
        from web.api import app
        return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")

    @pytest.mark.asyncio
    async def test_置く_読む_開く_消す(self, client, data_dir):
        r = await client.get("/api/project/recovery")
        assert r.status_code == 200 and r.json() == {"recovery": None}
        r = await client.post("/api/project/recovery/open")
        assert r.status_code == 404
        r = await client.delete("/api/project/recovery")
        assert r.status_code == 200 and r.json() == {"removed": False}

        r = await client.post("/api/project/document", json={"base": None, "document": document(None, [note("C", 4, 0)])})
        token = r.json()["token"]
        r = await client.post("/api/project/recovery", json={"token": token, "name": "デモ", "path": None, "file": "デモ.bunri"})
        assert r.status_code == 200, r.text
        placed = r.json()
        assert placed["name"] == "デモ" and placed["file"] == "デモ.bunri" and placed["size_bytes"] > 0

        r = await client.get("/api/project/recovery")
        assert r.json() == {"recovery": placed}
        r = await client.post("/api/project/recovery/open")
        assert r.status_code == 200
        opened = r.json()
        assert set(opened) == {"token", "name", "path", "file"} and opened["file"] == "デモ.bunri"
        r = await client.post(f"/api/project/open/{opened['token']}")
        assert r.status_code == 200 and r.json()["tracks"][0]["notes"] == [note("C", 4, 0)]

        r = await client.delete("/api/project/recovery")
        assert r.json() == {"removed": True}
        r = await client.get("/api/project/recovery")
        assert r.json() == {"recovery": None}

    @pytest.mark.asyncio
    async def test_写しの指定が正しくなければ断る(self, client, data_dir):
        r = await client.post("/api/project/recovery", json={"token": "../../etc/passwd"})
        assert r.status_code == 400
        r = await client.post("/api/project/recovery", json={"token": "0" * 24})
        assert r.status_code == 404
        r = await client.post("/api/project/recovery", json={})
        assert r.status_code == 400
        assert (await client.get("/api/project/recovery")).json() == {"recovery": None}


class TestDiscardFence:
    """捨てたあと（閉じる・保存しないと決めた）に届いた古い自動保存を、置き直させない。

    画面は、捨てるときに書き途中の自動保存を待たずに DELETE を送る。書き途中の自動保存の POST が DELETE の
    あとに届いても、目印（画面ごとの名前 ``session`` と世代 ``generation``）で古いものと分かれば断る。
    """

    def test_捨てたあとに届いた古い世代の自動保存は断り_写しを置かない(self, data_dir):
        autosave(document(None, [note("C", 4, 0)]), name="前の写し", writer={"session": "s1", "generation": 1})
        assert project_store.recovery_clear(writer={"session": "s1", "generation": 3}) is True
        stale = project_store.save_document(document(None, [note("D", 4, 0)]), base=None)["token"]
        with pytest.raises(project_store.ProjectError) as e:
            project_store.recovery_put(stale, name="古い", writer={"session": "s1", "generation": 2})
        assert e.value.status == 409
        assert project_store.recovery_info() is None
        # 断った作業用の写しは残さない
        assert not project_store.work_path(stale).exists()
        assert not any(p.suffix == ".bunri" for p in (data_dir / "recovery").iterdir())

    def test_捨てたあとの世代と_ほかの画面と_目印なしは置ける(self, data_dir):
        project_store.recovery_clear(writer={"session": "s1", "generation": 3})
        autosave(document(None), name="同じ世代", writer={"session": "s1", "generation": 3})
        assert project_store.recovery_info()["name"] == "同じ世代"
        # 次の起動 (別の画面) は、前の画面の世代に縛られない
        autosave(document(None), name="次の起動", writer={"session": "s2", "generation": 0})
        assert project_store.recovery_info()["name"] == "次の起動"
        autosave(document(None), name="目印なし")
        assert project_store.recovery_info()["name"] == "目印なし"
        # 目印は、置き直しても消えない (同じ画面の古い世代は、まだ断る)
        stale = project_store.save_document(document(None), base=None)["token"]
        with pytest.raises(project_store.ProjectError):
            project_store.recovery_put(stale, writer={"session": "s1", "generation": 2})
        assert project_store.recovery_info()["name"] == "目印なし"

    def test_目印の形が正しくなければ断る(self, data_dir):
        token = project_store.save_document(document(None), base=None)["token"]
        for writer in ({"session": "", "generation": 1}, {"session": "s1", "generation": -1},
                       {"session": "s1", "generation": True}, {"session": "x" * 65, "generation": 1},
                       {"session": "s1"}, "s1"):
            with pytest.raises(project_store.ProjectError) as e:
                project_store.recovery_put(token, writer=writer)
            assert e.value.status == 400
            with pytest.raises(project_store.ProjectError):
                project_store.recovery_clear(writer=writer)
        assert project_store.recovery_info() is None

    @pytest.mark.asyncio
    async def test_API_DELETEの目印で古い自動保存を断る(self, data_dir):
        from web.api import app
        client = AsyncClient(transport=ASGITransport(app=app), base_url="http://test")
        writer = {"session": "abc", "generation": 4}
        r = await client.request("DELETE", "/api/project/recovery", json={"writer": writer})
        assert r.status_code == 200 and r.json() == {"removed": False}
        r = await client.post("/api/project/document", json={"base": None, "document": document(None)})
        token = r.json()["token"]
        r = await client.post("/api/project/recovery", json={"token": token, "writer": {"session": "abc", "generation": 3}})
        assert r.status_code == 409, r.text
        assert (await client.get("/api/project/recovery")).json() == {"recovery": None}
        r = await client.post("/api/project/document", json={"base": None, "document": document(None)})
        r = await client.post("/api/project/recovery", json={"token": r.json()["token"], "writer": writer})
        assert r.status_code == 200, r.text
        r = await client.request("DELETE", "/api/project/recovery", json={"writer": "壊れた"})
        assert r.status_code == 400
