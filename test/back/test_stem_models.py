"""追加の分離モデル（stem_models）と、ドラムの細分化（separate）のテスト

本物のモデルも Demucs も動かさない。ダウンロードと Demucs の起動は差し替える。
"""
import asyncio
import contextlib
import hashlib

import numpy as np
import pytest
import soundfile as sf
from httpx import ASGITransport, AsyncClient

import background_jobs
import demucs_progress
import separate
import stem_models

PAYLOAD = b"fake-model-bytes" * 64


@pytest.fixture
def data_dir(tmp_path, monkeypatch):
    """データ置き場を一時ディレクトリへ向ける"""
    monkeypatch.setenv("BUNRI_DATA_DIR", str(tmp_path))
    return tmp_path


@pytest.fixture
def fake_model(monkeypatch, data_dir):
    """小さな偽のモデルを 1 つ定義する（本物は 160 MB 在るので使わない）"""
    spec = {
        "file": "fake.safetensors",
        "sha256": hashlib.sha256(PAYLOAD).hexdigest(),
        "size": len(PAYLOAD),
        "stems": {"bombo": "drums_kick", "redoblante": "drums_snare", "toms": "drums_toms", "platillos": "drums_cymbals"},
    }
    monkeypatch.setitem(stem_models.ADDON_MODELS, "drumsep", spec)
    return spec


def _fetch_ok(url, dest):
    with open(dest, "wb") as f:
        f.write(PAYLOAD)


def _chunked_fetch(url, dest, on_bytes=None):
    """``stem_models._http_fetch`` の代わり。4 つに分けて書き、そのたびに合計を伝える"""
    step = len(PAYLOAD) // 4
    done = 0
    with open(dest, "wb") as f:
        for i in range(0, len(PAYLOAD), step):
            block = PAYLOAD[i:i + step]
            f.write(block)
            done += len(block)
            if on_bytes is not None:
                on_bytes(done)


class TestEnsureModel:
    def test_無ければダウンロードして置く(self, fake_model, data_dir):
        calls = []

        def fetch(url, dest):
            calls.append(url)
            _fetch_ok(url, dest)

        path = stem_models.ensure_model("drumsep", fetch=fetch)
        assert path == data_dir / "models" / "fake.safetensors"
        assert path.read_bytes() == PAYLOAD
        assert calls == [stem_models.DEFAULT_BASE_URL + "/fake.safetensors"]
        assert not list(path.parent.glob("*.part"))

    def test_在ればダウンロードしない(self, fake_model):
        stem_models.ensure_model("drumsep", fetch=_fetch_ok)

        def fetch(url, dest):
            raise AssertionError("2 回目は取りに行かないはず")

        assert stem_models.ensure_model("drumsep", fetch=fetch).is_file()

    def test_ハッシュが合わなければ置かずに失敗する(self, fake_model):
        def fetch(url, dest):
            with open(dest, "wb") as f:
                f.write(b"x" * len(PAYLOAD))

        with pytest.raises(stem_models.ModelUnavailableError, match="一致しません"):
            stem_models.ensure_model("drumsep", fetch=fetch)
        path = stem_models.model_path("drumsep")
        assert not path.exists()
        assert not list(path.parent.glob("*.part"))

    def test_ダウンロードの失敗は利用者に見せられる文になる(self, fake_model):
        def fetch(url, dest):
            raise OSError("no route")

        with pytest.raises(stem_models.ModelUnavailableError, match="ダウンロードできません"):
            stem_models.ensure_model("drumsep", fetch=fetch)
        assert not stem_models.is_cached("drumsep")

    def test_途中で切れたファイルは在ることにしない(self, fake_model):
        path = stem_models.model_path("drumsep")
        path.write_bytes(PAYLOAD[:10])
        assert not stem_models.is_cached("drumsep")
        assert stem_models.model_status("drumsep") == {"model": "drumsep", "cached": False, "missing": 1}

    def test_HTTPで落とすあいだ_落とした量を伝える(self, fake_model, monkeypatch):
        seen = []
        monkeypatch.setattr(stem_models, "_http_fetch", _chunked_fetch)
        path = stem_models.ensure_model("drumsep", on_bytes=seen.append)
        assert path.read_bytes() == PAYLOAD
        assert seen == sorted(seen) and seen[-1] == len(PAYLOAD) and len(seen) > 1

    def test_途中でやめたら_書きかけを残さずにその例外を外へ出す(self, fake_model, monkeypatch):
        monkeypatch.setattr(stem_models, "_http_fetch", _chunked_fetch)

        def stop(done):
            raise background_jobs.JobCancelled()

        with pytest.raises(background_jobs.JobCancelled):
            stem_models.ensure_model("drumsep", on_bytes=stop)
        path = stem_models.model_path("drumsep")
        assert not path.exists()
        assert not list(path.parent.glob("*.part"))

    def test_HTTPの読み取りは_ブロックごとに合計を伝える(self, tmp_path, monkeypatch):
        import httpx

        class Response:
            def raise_for_status(self):
                pass

            def iter_bytes(self, size):
                yield from (b"ab", b"cde", b"f")

        @contextlib.contextmanager
        def stream(method, url, **kwargs):
            assert (method, url, kwargs["follow_redirects"]) == ("GET", "http://example.invalid/m", True)
            yield Response()

        monkeypatch.setattr(httpx, "stream", stream)
        seen = []
        stem_models._http_fetch("http://example.invalid/m", tmp_path / "m.part", on_bytes=seen.append)
        assert (tmp_path / "m.part").read_bytes() == b"abcdef"
        assert seen == [2, 5, 6]

    def test_配布元は環境変数で差し替えられる(self, fake_model, monkeypatch):
        monkeypatch.setenv("BUNRI_MODEL_BASE_URL", "http://127.0.0.1:9/m/")
        assert stem_models.model_url("drumsep") == "http://127.0.0.1:9/m/fake.safetensors"

    def test_知らない名前はKeyError(self, data_dir):
        with pytest.raises(KeyError):
            stem_models.ensure_model("nope")

    def test_本物の定義は形がそろっている(self):
        spec = stem_models.ADDON_MODELS["drumsep"]
        assert spec["file"].endswith(".safetensors")
        assert len(spec["sha256"]) == 64 and int(spec["sha256"], 16) >= 0
        assert spec["size"] > 0
        for key in spec["stems"].values():
            assert key in separate.STEM_LABELS


def _write_wav(path, level):
    """0.2 秒の WAV を書く。level が 0 なら無音"""
    path.parent.mkdir(parents=True, exist_ok=True)
    t = np.linspace(0, 0.2, 4410, dtype=np.float32)
    sf.write(str(path), level * np.sin(2 * np.pi * 220 * t), 22050)
    return path


class TestSeparateDrums:
    def test_モデルのステム名をbunriの名前に直して返す(self, fake_model, tmp_path, monkeypatch):
        drums = _write_wav(tmp_path / "in" / "drums.wav", 0.5)
        out = tmp_path / "out"
        monkeypatch.setattr(separate, "_ensure_drum_model", lambda job: tmp_path / "m.safetensors")
        seen = {}

        def fake_run(cmd, **kwargs):
            seen["cmd"] = cmd
            seen["kwargs"] = kwargs
            for stem in ("bombo", "redoblante", "toms"):
                _write_wav(out / "drumsep" / "drums" / f"{stem}.wav", 0.3)
            return 0

        monkeypatch.setattr(demucs_progress, "run", fake_run)
        paths = separate.separate_drums(str(drums), output_dir=str(out))
        # platillos は書かれなかったので、結果に入らない
        assert set(paths) == {"drums_kick", "drums_snare", "drums_toms"}
        assert paths["drums_kick"].name == "bombo.wav"
        cmd = seen["cmd"]
        assert cmd[cmd.index("--bunri-model-file") + 1] == str(tmp_path / "m.safetensors")
        assert cmd[cmd.index("-n") + 1] == "drumsep"
        assert cmd[-1] == str(drums)
        assert (cmd[cmd.index("--segment") + 1], cmd[cmd.index("--jobs") + 1]) == ("7", "1")
        # 進み具合は「ドラムを分ける」ステージに出す。モデルは用意済みなので、その段は設けない
        assert (seen["kwargs"]["stage"], seen["kwargs"]["model_stage"]) == ("separate_drums", None)

    def test_Demucsが失敗したらRuntimeError(self, fake_model, tmp_path, monkeypatch):
        drums = _write_wav(tmp_path / "drums.wav", 0.5)
        monkeypatch.setattr(separate, "_ensure_drum_model", lambda job: tmp_path / "m.safetensors")
        monkeypatch.setattr(demucs_progress, "run", lambda cmd, **kw: 1)
        with pytest.raises(RuntimeError):
            separate.separate_drums(str(drums), output_dir=str(tmp_path / "out"))

    def test_入力が無ければFileNotFoundError(self, fake_model, tmp_path):
        with pytest.raises(FileNotFoundError):
            separate.separate_drums(str(tmp_path / "none.wav"))


class Recorder:
    """ジョブの代わりに、伝えられたことを順に書き留める"""

    def __init__(self, cancel_at=None):
        self.log = []
        self._cancel_at = cancel_at

    def enter_stage(self, key, label=None):
        self.log.append(("stage", key))

    def set_progress(self, fraction):
        self.log.append(("progress", round(fraction, 2)))

    def check_cancelled(self):
        if self._cancel_at is not None and len(self.log) >= self._cancel_at:
            raise background_jobs.JobCancelled()


class TestEnsureDrumModel:
    def test_手元に在れば_ダウンロードの段に入らない(self, fake_model):
        path = stem_models.ensure_model("drumsep", fetch=_fetch_ok)
        job = Recorder()
        assert separate._ensure_drum_model(job) == path
        assert job.log == []

    def test_無ければ_ダウンロードの段に入り_落とした割合を伝える(self, fake_model, monkeypatch):
        monkeypatch.setattr(stem_models, "_http_fetch", _chunked_fetch)
        job = Recorder()
        path = separate._ensure_drum_model(job)
        assert path.read_bytes() == PAYLOAD
        assert job.log == [("stage", "drum_model")] + [("progress", f) for f in (0.25, 0.5, 0.75, 1.0)]

    def test_ダウンロードの途中でキャンセルすると止まり_書きかけが残らない(self, fake_model, monkeypatch):
        monkeypatch.setattr(stem_models, "_http_fetch", _chunked_fetch)
        job = Recorder(cancel_at=3)
        with pytest.raises(background_jobs.JobCancelled):
            separate._ensure_drum_model(job)
        assert job.log == [("stage", "drum_model"), ("progress", 0.25), ("progress", 0.5)]
        assert not stem_models.is_cached("drumsep")
        assert not list(stem_models.model_path("drumsep").parent.glob("*.part"))


class TestDeepSeparateStages:
    def test_既定は_今までと同じ3つ(self):
        assert separate.deep_separate_stages() == separate.DEEP_SEPARATE_STAGES

    def test_ドラムを分けるなら_その他の再分離の前にステージが入る(self):
        keys = [key for key, _ in separate.deep_separate_stages(split_drums=True)]
        assert keys == ["model", "separate", "separate_drums", "separate_other"]

    def test_モデルのダウンロードが要るなら_最初にステージが入る(self):
        keys = [key for key, _ in separate.deep_separate_stages(split_drums=True, download_drum_model=True)]
        assert keys == ["drum_model", "model", "separate", "separate_drums", "separate_other"]

    def test_再分離をしないなら_そのステージは入らない(self):
        assert [key for key, _ in separate.deep_separate_stages(recursive_depth=0)] == ["model", "separate"]
        keys = [key for key, _ in separate.deep_separate_stages(recursive_depth=0, split_drums=True)]
        assert keys == ["model", "separate", "separate_drums"]

    def test_ドラムを分けないなら_ダウンロードのステージは入らない(self):
        assert separate.deep_separate_stages(download_drum_model=True) == separate.DEEP_SEPARATE_STAGES


class TestDeepSeparateWithDrums:
    @pytest.fixture
    def stage1(self, tmp_path, monkeypatch):
        """第1段（htdemucs_6s）を差し替える。other は無音にして、再分離が走らないようにする"""
        def fake_separate_audio(input_path, output_dir, model, **kwargs):
            base = tmp_path / "s1"
            return {
                "vocals": _write_wav(base / "vocals.wav", 0.5),
                "drums": _write_wav(base / "drums.wav", 0.5),
                "bass": _write_wav(base / "bass.wav", 0.5),
                "other": _write_wav(base / "other.wav", 0.0),
            }

        monkeypatch.setattr(separate, "separate_audio", fake_separate_audio)

    def test_ドラムの部位がdrumsの直後に並び無音の部位は落ちる(self, stage1, tmp_path, monkeypatch):
        monkeypatch.setattr(separate, "_ensure_drum_model", lambda job: tmp_path / "m.safetensors")

        def fake_separate_drums(drums_path, output_dir, **kwargs):
            base = tmp_path / "s2"
            return {
                "drums_kick": _write_wav(base / "bombo.wav", 0.5),
                "drums_snare": _write_wav(base / "redoblante.wav", 0.5),
                "drums_toms": _write_wav(base / "toms.wav", 0.0),
                "drums_cymbals": _write_wav(base / "platillos.wav", 0.5),
            }

        monkeypatch.setattr(separate, "separate_drums", fake_separate_drums)
        result = separate.deep_separate("song.wav", output_dir=str(tmp_path / "out"), split_drums=True)
        assert list(result) == ["vocals", "drums", "drums_kick", "drums_snare", "drums_cymbals", "bass"]

    def test_既定ではドラムを分けずモデルも取りに行かない(self, stage1, tmp_path, monkeypatch):
        def boom(*args, **kwargs):
            raise AssertionError("呼ばれないはず")

        monkeypatch.setattr(stem_models, "ensure_model", boom)
        monkeypatch.setattr(stem_models, "is_cached", boom)
        monkeypatch.setattr(separate, "separate_drums", boom)
        result = separate.deep_separate("song.wav", output_dir=str(tmp_path / "out"))
        assert list(result) == ["vocals", "drums", "bass"]

    def test_モデルを用意できなければ分離を始める前に失敗する(self, fake_model, tmp_path, monkeypatch):
        def no_model(name, fetch=None, on_bytes=None):
            raise stem_models.ModelUnavailableError("だめ")

        def boom(*args, **kwargs):
            raise AssertionError("第1段は走らないはず")

        monkeypatch.setattr(stem_models, "ensure_model", no_model)
        monkeypatch.setattr(separate, "separate_audio", boom)
        with pytest.raises(stem_models.ModelUnavailableError):
            separate.deep_separate("song.wav", output_dir=str(tmp_path / "out"), split_drums=True)


class TestRunnerArgs:
    def test_モデルのファイルの指定を抜き取る(self):
        import _demucs_runner as runner

        path, rest = runner._take_model_file(["--out", "o", "--bunri-model-file", "/m.safetensors", "-n", "drumsep", "a.wav"])
        assert path == "/m.safetensors"
        assert rest == ["--out", "o", "-n", "drumsep", "a.wav"]

    def test_指定が無ければそのまま(self):
        import _demucs_runner as runner

        assert runner._take_model_file(["-n", "htdemucs", "a.wav"]) == (None, ["-n", "htdemucs", "a.wav"])

    def test_パスが無ければ止まる(self):
        import _demucs_runner as runner

        with pytest.raises(SystemExit):
            runner._take_model_file(["a.wav", "--bunri-model-file"])


async def _poll(client, job_id):
    """ジョブが終わるまで状態を聞き続け、最後の状態を返す"""
    for _ in range(4000):
        body = (await client.get(f"/api/jobs/{job_id}")).json()
        if body["state"] in ("done", "error", "cancelled"):
            return body
        await asyncio.sleep(0.005)
    raise AssertionError(f"ジョブが終わらなかった: {body}")


class TestApi:
    @pytest.fixture
    def client(self, monkeypatch):
        from web.api import app

        # テストごとに、共有のジョブの管理を新しいものに差し替える
        manager = background_jobs.JobManager()
        monkeypatch.setattr(background_jobs, "_default_manager", manager)
        yield AsyncClient(transport=ASGITransport(app=app), base_url="http://test")
        manager.shutdown(timeout=5)

    @pytest.mark.asyncio
    async def test_追加のモデルの状態を返す(self, fake_model, client):
        async with client:
            resp = await client.get("/api/models/drumsep/status")
            assert resp.status_code == 200
            assert resp.json() == {"model": "drumsep", "cached": False, "missing": 1}
            stem_models.ensure_model("drumsep", fetch=_fetch_ok)
            resp = await client.get("/api/models/drumsep/status")
            assert resp.json()["cached"] is True

    @pytest.mark.asyncio
    async def test_深層分離はsplit_drumsを渡しラベルを付けて返す(self, data_dir, tmp_path, client, monkeypatch):
        seen = {}

        def fake_deep(input_path, **kwargs):
            seen.update(kwargs)
            return {"drums": _write_wav(tmp_path / "d.wav", 0.5), "drums_kick": _write_wav(tmp_path / "k.wav", 0.5)}

        monkeypatch.setattr(separate, "deep_separate", fake_deep)
        wav = _write_wav(tmp_path / "song.wav", 0.5).read_bytes()
        async with client:
            resp = await client.post(
                "/api/deep-separate",
                files={"file": ("song.wav", wav, "audio/wav")},
                data={"depth": "1", "split_drums": "true"},
            )
        assert resp.status_code == 200
        assert seen["split_drums"] is True
        assert resp.json()["drums_kick"]["label"] == "ドラム → キック"

    @pytest.mark.asyncio
    async def test_モデルを用意できなければ503と理由を返す(self, data_dir, tmp_path, client, monkeypatch):
        def fake_deep(input_path, **kwargs):
            raise stem_models.ModelUnavailableError("追加モデルをダウンロードできませんでした")

        monkeypatch.setattr(separate, "deep_separate", fake_deep)
        wav = _write_wav(tmp_path / "song.wav", 0.5).read_bytes()
        async with client:
            resp = await client.post("/api/deep-separate", files={"file": ("song.wav", wav, "audio/wav")}, data={"split_drums": "true"})
        assert resp.status_code == 503
        assert "ダウンロードできません" in resp.json()["detail"]

    @pytest.mark.asyncio
    async def test_ジョブとして始めたときは_503と理由がジョブの失敗に入る(self, fake_model, tmp_path, client, monkeypatch):
        def fake_deep(input_path, **kwargs):
            raise stem_models.ModelUnavailableError("追加モデルをダウンロードできませんでした")

        monkeypatch.setattr(separate, "deep_separate", fake_deep)
        wav = _write_wav(tmp_path / "song.wav", 0.5).read_bytes()
        async with client:
            resp = await client.post(
                "/api/deep-separate?async=1", files={"file": ("song.wav", wav, "audio/wav")}, data={"split_drums": "true"},
            )
            assert resp.status_code == 202, resp.text
            failed = await _poll(client, resp.json()["id"])
        assert failed["state"] == "error"
        assert failed["error"] == {"status": 503, "detail": "追加モデルをダウンロードできませんでした"}

    @pytest.mark.asyncio
    @pytest.mark.parametrize("cached, form, expected", [
        (False, {"split_drums": "true"}, ["drum_model", "model", "separate", "separate_drums", "separate_other"]),
        (True, {"split_drums": "true"}, ["model", "separate", "separate_drums", "separate_other"]),
        (True, {"split_drums": "true", "depth": "0"}, ["model", "separate", "separate_drums"]),
        (False, {}, ["model", "separate", "separate_other"]),
    ])
    async def test_ジョブのステージは_通るものだけが並ぶ(self, fake_model, tmp_path, client, monkeypatch, cached, form, expected):
        if cached:
            stem_models.ensure_model("drumsep", fetch=_fetch_ok)
        seen = {}

        def fake_deep(input_path, job, **kwargs):
            seen.update(kwargs)
            # 並びの最後のステージに入ると、番号が総数 - 1 になる
            job.enter_stage(expected[-1])
            seen["index"] = job.snapshot()["stage_index"]
            return {"drums": _write_wav(tmp_path / "d.wav", 0.5)}

        monkeypatch.setattr(separate, "deep_separate", fake_deep)
        wav = _write_wav(tmp_path / "song.wav", 0.5).read_bytes()
        async with client:
            resp = await client.post("/api/deep-separate?async=1", files={"file": ("song.wav", wav, "audio/wav")}, data=form)
            assert resp.status_code == 202, resp.text
            started = resp.json()
            assert (started["kind"], started["stage_count"]) == ("deep_separate", len(expected))
            done = await _poll(client, started["id"])
        assert done["state"] == "done", done
        assert seen["index"] == len(expected) - 1
        assert seen["split_drums"] is ("split_drums" in form)
        assert seen["recursive_depth"] == int(form.get("depth", "1"))
