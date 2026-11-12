"""ジョブの API（/api/jobs…）と、時間のかかる API をジョブとして動かす経路のテスト

前半は、合図で止められる偽の処理を持つ小さなアプリで、API の約束ごとを確かめる。
後半は、本物のアプリ（web.api）の時間のかかる API が、どれもジョブの仕組みを通っていることを確かめる
（モデルを使う部分は偽の関数に差し替える。本物のモデルは動かさない）。
"""
import asyncio
import io
import threading
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf
from fastapi import FastAPI, Form, HTTPException, Query
from httpx import ASGITransport, AsyncClient

import access_control
import background_jobs
from background_jobs import JobManager
from web import job_routes

STAGES = [("first", "1 つ目をしています"), ("second", "2 つ目をしています")]
TOKEN = "s3cret-token"


class Gate:
    """偽の処理を、テストの側から進めるための合図"""

    def __init__(self):
        self.entered = threading.Event()
        self.release = threading.Event()

    def pause(self):
        self.entered.set()
        assert self.release.wait(10), "テストが処理を進めなかった"


@pytest.fixture(autouse=True)
def manager(monkeypatch):
    """テストごとに、共有のジョブの管理を新しいものに差し替える"""
    m = JobManager()
    monkeypatch.setattr(background_jobs, "_default_manager", m)
    yield m
    m.shutdown(timeout=5)


def client_for(app):
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def entered(gate):
    """偽の処理が合図のところまで来るのを、イベントループを止めずに待つ"""
    for _ in range(1000):
        if gate.entered.is_set():
            return
        await asyncio.sleep(0.005)
    raise AssertionError("処理が始まらなかった")


async def poll(client, job_id, until=("done", "error", "cancelled"), headers=None):
    """ジョブが終わるまで状態を聞き続け、最後の状態を返す"""
    for _ in range(4000):
        resp = await client.get(f"/api/jobs/{job_id}", headers=headers)
        assert resp.status_code == 200, resp.text
        body = resp.json()
        if body["state"] in until:
            return body
        await asyncio.sleep(0.005)
    raise AssertionError(f"ジョブが終わらなかった: {body}")


def make_app(gate=None, prepared=None):
    """偽の時間のかかる API を 1 つ持つアプリ"""
    app = FastAPI()
    app.include_router(job_routes.router)

    @app.post("/api/fake")
    async def fake(
        name: str = Form("song.wav"),
        mode: str = Form("ok"),
        run_async: bool = Query(False, alias="async"),
    ):
        def prepare():
            if prepared is not None:
                prepared.append(name)
            if mode == "bad-input":
                raise HTTPException(400, "ファイル名が不正です")
            return name.upper()

        def task(job, value):
            job.enter_stage("first")
            if gate is not None:
                gate.pause()
            job.enter_stage("second")
            job.set_progress(0.5)
            if mode == "fail":
                raise RuntimeError("Demucs の実行に失敗しました。")
            if mode == "not-found":
                raise HTTPException(404, "カルテが見つかりません")
            if mode == "nan":
                return {"loudness": float("nan")}
            return {"name": value}

        return await job_routes.dispatch(
            "fake", title="偽の処理", filename=name, stages=STAGES,
            prepare=prepare, task=task, run_async=run_async,
        )

    return app


class TestAsyncStart:
    @pytest.mark.asyncio
    async def test_始めるとすぐ返り_聞きに行くと進み具合と結果が分かる(self):
        gate = Gate()
        async with client_for(make_app(gate)) as client:
            resp = await client.post("/api/fake?async=1", data={"name": "song.wav"})
            assert resp.status_code == 202
            started = resp.json()
            assert started["kind"] == "fake" and started["title"] == "偽の処理"
            assert started["filename"] == "song.wav"
            assert started["state"] in ("queued", "running")
            assert started["stage_count"] == 2
            assert started["result"] is None and started["error"] is None

            await entered(gate)
            running = (await client.get(f"/api/jobs/{started['id']}")).json()
            assert running["state"] == "running"
            assert (running["stage"], running["stage_key"], running["stage_index"]) == (
                "1 つ目をしています", "first", 0)
            assert running["progress"] is None
            assert running["elapsed_sec"] >= 0

            gate.release.set()
            done = await poll(client, started["id"])
            assert done["state"] == "done"
            assert done["result"] == {"name": "SONG.WAV"}
            assert (done["stage_key"], done["stage_index"], done["progress"]) == ("second", 1, 0.5)

    @pytest.mark.asyncio
    async def test_結果は_待つ呼び方が返すものと同じ(self):
        async with client_for(make_app()) as client:
            sync = await client.post("/api/fake", data={"name": "a.wav"})
            assert sync.status_code == 200
            started = (await client.post("/api/fake?async=1", data={"name": "a.wav"})).json()
            done = await poll(client, started["id"])
            assert done["result"] == sync.json() == {"name": "A.WAV"}

    @pytest.mark.asyncio
    async def test_失敗は_待つ呼び方と同じ状態コードと理由で残る(self):
        async with client_for(make_app()) as client:
            for mode, status, detail in (
                ("fail", 500, "Demucs の実行に失敗しました。"),
                ("not-found", 404, "カルテが見つかりません"),
            ):
                sync = await client.post("/api/fake", data={"mode": mode})
                assert (sync.status_code, sync.json()) == (status, {"detail": detail})

                started = (await client.post("/api/fake?async=1", data={"mode": mode})).json()
                failed = await poll(client, started["id"])
                assert failed["state"] == "error"
                assert failed["error"] == {"status": status, "detail": detail}
                assert failed["result"] is None

    @pytest.mark.asyncio
    async def test_JSONにできない結果は_失敗として残り_状態を聞くAPIは壊れない(self):
        async with client_for(make_app()) as client:
            sync = await client.post("/api/fake", data={"mode": "nan"})
            assert sync.status_code == 500 and "JSON" in sync.json()["detail"]

            started = (await client.post("/api/fake?async=1", data={"mode": "nan"})).json()
            failed = await poll(client, started["id"])
            assert failed["state"] == "error"
            assert failed["error"] == {"status": 500, "detail": sync.json()["detail"]}

    @pytest.mark.asyncio
    async def test_入力の誤りは_ジョブを作らずにその場で返す(self, manager):
        async with client_for(make_app()) as client:
            resp = await client.post("/api/fake?async=1", data={"mode": "bad-input"})
            assert (resp.status_code, resp.json()) == (400, {"detail": "ファイル名が不正です"})
            assert manager.jobs() == []
            # 待つ呼び方でも同じ応答
            resp = await client.post("/api/fake", data={"mode": "bad-input"})
            assert (resp.status_code, resp.json()) == (400, {"detail": "ファイル名が不正です"})


class TestBusy:
    @pytest.mark.asyncio
    async def test_動いている間の開始は409で_何が動いているかが分かる(self):
        gate = Gate()
        prepared = []
        async with client_for(make_app(gate, prepared)) as client:
            first = (await client.post("/api/fake?async=1", data={"name": "first.wav"})).json()
            await entered(gate)

            resp = await client.post("/api/fake?async=1", data={"name": "second.wav"})
            assert resp.status_code == 409
            body = resp.json()
            assert body["code"] == "job_busy"
            assert isinstance(body["detail"], str) and "first.wav" in body["detail"] and "偽の処理" in body["detail"]
            assert body["job"]["id"] == first["id"] and body["job"]["state"] == "running"
            assert "result" not in body["job"]
            assert prepared == ["first.wav"], "断るときは、アップロードの保存などの前処理をしない"

            gate.release.set()
            await poll(client, first["id"])
            again = await client.post("/api/fake?async=1", data={"name": "second.wav"})
            assert again.status_code == 202

    @pytest.mark.asyncio
    async def test_待つ呼び方は断られず_順番が来てから動く(self):
        gate = Gate()
        prepared = []
        async with client_for(make_app(gate, prepared)) as client:
            first = (await client.post("/api/fake?async=1", data={"name": "first.wav"})).json()
            await entered(gate)

            waiting = asyncio.create_task(client.post("/api/fake", data={"name": "second.wav"}))
            await asyncio.sleep(0.05)
            assert not waiting.done()
            assert prepared == ["first.wav"], "前のジョブが動いている間は、前処理（アップロードの保存）もしない"
            listing = (await client.get("/api/jobs")).json()
            assert [j["state"] for j in listing["jobs"]] == ["queued", "running"]
            assert listing["active"]["id"] == first["id"]

            gate.release.set()
            resp = await waiting
            assert (resp.status_code, resp.json()) == (200, {"name": "SECOND.WAV"})
            assert prepared == ["first.wav", "second.wav"]

    @pytest.mark.asyncio
    async def test_処理が動いている間も_ほかのAPIは応える(self):
        """待つ呼び方でも、処理は別スレッドで動く。状態を聞く API が止まらない"""
        gate = Gate()
        async with client_for(make_app(gate)) as client:
            waiting = asyncio.create_task(client.post("/api/fake", data={"name": "sync.wav"}))
            await entered(gate)
            listing = (await client.get("/api/jobs")).json()
            assert listing["active"]["filename"] == "sync.wav", "待つ呼び方で始めた処理も、ジョブとして見える"
            gate.release.set()
            assert (await waiting).status_code == 200


class TestCancelAndLookup:
    @pytest.mark.asyncio
    async def test_キャンセルを頼むと_止まった時点でcancelledになる(self):
        gate = Gate()
        async with client_for(make_app(gate)) as client:
            started = (await client.post("/api/fake?async=1")).json()
            await entered(gate)

            resp = await client.post(f"/api/jobs/{started['id']}/cancel")
            assert resp.status_code == 200
            body = resp.json()
            assert body["state"] == "running" and body["cancel_requested"] is True
            # 何度頼んでもよい
            assert (await client.post(f"/api/jobs/{started['id']}/cancel")).status_code == 200

            gate.release.set()
            final = await poll(client, started["id"])
            assert final["state"] == "cancelled"
            assert final["result"] is None and final["error"] is None
            # 終わったジョブへのキャンセルは何もしない
            after = await client.post(f"/api/jobs/{started['id']}/cancel")
            assert after.status_code == 200 and after.json()["state"] == "cancelled"

    @pytest.mark.asyncio
    async def test_待つ呼び方の処理をキャンセルすると_その呼び出しは409で返る(self, manager):
        gate = Gate()
        async with client_for(make_app(gate)) as client:
            waiting = asyncio.create_task(client.post("/api/fake", data={"name": "sync.wav"}))
            await entered(gate)
            job_id = (await client.get("/api/jobs")).json()["active"]["id"]
            await client.post(f"/api/jobs/{job_id}/cancel")
            gate.release.set()
            resp = await waiting
            assert (resp.status_code, resp.json()) == (409, {"detail": "処理はキャンセルされました"})

    @pytest.mark.asyncio
    async def test_無いジョブは404(self):
        async with client_for(make_app()) as client:
            for resp in (await client.get("/api/jobs/nope"), await client.post("/api/jobs/nope/cancel")):
                assert resp.status_code == 404
                assert isinstance(resp.json()["detail"], str)

    @pytest.mark.asyncio
    async def test_開き直した画面は_一覧から動いているジョブと終わったジョブを見つけられる(self):
        gate = Gate()
        async with client_for(make_app(gate)) as client:
            empty = (await client.get("/api/jobs")).json()
            assert empty == {"active": None, "jobs": []}

            started = (await client.post("/api/fake?async=1", data={"name": "song.wav"})).json()
            await entered(gate)
            listing = (await client.get("/api/jobs")).json()
            assert listing["active"]["id"] == started["id"]
            assert listing["active"]["stage_key"] == "first"

            gate.release.set()
            await poll(client, started["id"])
            listing = (await client.get("/api/jobs")).json()
            assert listing["active"] is None
            assert [j["id"] for j in listing["jobs"]] == [started["id"]]
            assert listing["jobs"][0]["state"] == "done"
            assert "result" not in listing["jobs"][0], "一覧には結果を入れない（大きいことがある）"
            assert (await client.get(f"/api/jobs/{started['id']}")).json()["result"] == {"name": "SONG.WAV"}

    @pytest.mark.asyncio
    async def test_期限の切れたジョブは404になる(self, monkeypatch):
        now = [1000.0]
        expiring = JobManager(ttl_sec=60, clock=lambda: now[0])
        monkeypatch.setattr(background_jobs, "_default_manager", expiring)
        async with client_for(make_app()) as client:
            started = (await client.post("/api/fake?async=1")).json()
            await poll(client, started["id"])
            now[0] += 61
            assert (await client.get(f"/api/jobs/{started['id']}")).status_code == 404
            assert (await client.get("/api/jobs")).json()["jobs"] == []


class TestAuth:
    @pytest.mark.asyncio
    async def test_ジョブのAPIもトークンで守られる(self):
        app = make_app()
        access_control.install(app, TOKEN, ["tauri://localhost"])
        headers = {"X-Bunri-Token": TOKEN}
        async with client_for(app) as client:
            assert (await client.post("/api/fake?async=1")).status_code == 401
            started = await client.post("/api/fake?async=1", headers=headers)
            assert started.status_code == 202
            job_id = started.json()["id"]

            for resp in (
                await client.get("/api/jobs"),
                await client.get(f"/api/jobs/{job_id}"),
                await client.post(f"/api/jobs/{job_id}/cancel"),
                await client.get(f"/api/jobs/{job_id}", headers={"X-Bunri-Token": "wrong"}),
            ):
                assert resp.status_code == 401

            assert (await client.get("/api/jobs", headers=headers)).status_code == 200
            done = await poll(client, job_id, headers=headers)
            assert done["state"] == "done", "トークン無しのキャンセルは効いていない"


# ---- 本物のアプリ ----

HEAVY_ROUTES = ["/api/analyze", "/api/separate", "/api/deep-separate", "/api/decompose", "/api/chart", "/api/chart/regrid"]


@pytest.fixture
def real_app(tmp_path, monkeypatch):
    """本物のアプリ。データ置き場は一時ディレクトリへ向ける"""
    monkeypatch.setenv("BUNRI_DATA_DIR", str(tmp_path))
    from web.api import app
    return app


@pytest.fixture
def wav_bytes():
    buf = io.BytesIO()
    sf.write(buf, 0.3 * np.sin(2 * np.pi * 440 * np.arange(22050) / 44100), 44100, format="WAV")
    return buf.getvalue()


def upload(data, name="song.wav"):
    return {"file": (name, io.BytesIO(data), "audio/wav")}


def write_stems(directory, names):
    """偽の分離結果（鳴っている WAV）を書いて、パスの辞書を返す"""
    directory.mkdir(parents=True, exist_ok=True)
    paths = {}
    for name in names:
        paths[name] = directory / f"{name}.wav"
        sf.write(str(paths[name]), 0.3 * np.sin(2 * np.pi * 440 * np.arange(4410) / 44100), 44100)
    return paths


class TestRealEndpoints:
    @pytest.mark.parametrize("path", HEAVY_ROUTES)
    def test_時間のかかるAPIは_どれもasyncを受け付ける(self, real_app, path):
        route = next(r for r in real_app.routes if getattr(r, "path", None) == path)
        aliases = [param.alias for param in route.dependant.query_params]
        assert "async" in aliases

    @pytest.mark.asyncio
    async def test_ジョブのAPIが本物のアプリに付いている(self, real_app):
        async with client_for(real_app) as client:
            assert (await client.get("/api/jobs")).json() == {"active": None, "jobs": []}

    @pytest.mark.asyncio
    async def test_音源分離(self, real_app, wav_bytes, tmp_path, monkeypatch):
        import separate

        calls = []

        def fake_separate(input_path, output_dir, model, two_stems, segment, jobs, job):
            calls.append((Path(input_path).name, model, two_stems, segment, jobs))
            job.enter_stage("model")
            job.enter_stage("separate")
            job.set_progress(1.0)
            return write_stems(Path(output_dir) / model / "song", ["vocals", "no_vocals"])

        monkeypatch.setattr(separate, "separate_audio", fake_separate)
        async with client_for(real_app) as client:
            sync = await client.post("/api/separate", files=upload(wav_bytes), data={"model": "htdemucs"})
            assert sync.status_code == 200, sync.text
            assert sync.json()["vocals"] == {"url": "/api/download/sep_vocals_song.wav", "label": "ボーカル"}

            resp = await client.post("/api/separate?async=1", files=upload(wav_bytes), data={"model": "htdemucs"})
            assert resp.status_code == 202, resp.text
            started = resp.json()
            assert (started["kind"], started["title"], started["filename"]) == ("separate", "パート分離", "song.wav")
            assert started["stage_count"] == len(separate.SEPARATE_STAGES)

            done = await poll(client, started["id"])
            assert done["state"] == "done", done
            assert done["result"] == sync.json()
            assert (done["stage"], done["stage_index"]) == ("パートに分けています", 1)
            assert (await client.get(done["result"]["vocals"]["url"])).status_code == 200
        assert calls == [("song.wav", "htdemucs", True, 7, 1)] * 2

    @pytest.mark.asyncio
    async def test_音源分離の失敗は_今までと同じ形で返る(self, real_app, wav_bytes, monkeypatch):
        import separate

        def failing(*args, **kwargs):
            raise RuntimeError("Demucs の実行に失敗しました。")

        monkeypatch.setattr(separate, "separate_audio", failing)
        async with client_for(real_app) as client:
            sync = await client.post("/api/separate", files=upload(wav_bytes))
            assert (sync.status_code, sync.json()) == (500, {"detail": "Demucs の実行に失敗しました。"})
            started = (await client.post("/api/separate?async=1", files=upload(wav_bytes))).json()
            failed = await poll(client, started["id"])
            assert failed["error"] == {"status": 500, "detail": "Demucs の実行に失敗しました。"}

    @pytest.mark.asyncio
    async def test_不正なファイル名は_ジョブにせず400で返す(self, real_app, wav_bytes, manager):
        async with client_for(real_app) as client:
            for url in ("/api/separate", "/api/separate?async=1"):
                resp = await client.post(url, files=upload(wav_bytes, name="../evil.wav"))
                assert resp.status_code == 400, resp.text
        assert [j.state for j in manager.jobs()] == ["error"], "async の側はジョブを作らない"

    @pytest.mark.asyncio
    @pytest.mark.parametrize("depth, stage_count", [(1, 3), (0, 2)])
    async def test_詳細な音源分離(self, real_app, wav_bytes, monkeypatch, depth, stage_count):
        import separate

        def fake_deep(input_path, output_dir, segment, jobs, recursive_depth, job):
            assert (segment, jobs, recursive_depth) == (7, 1, depth)
            job.enter_stage("separate")
            return write_stems(Path(output_dir) / "htdemucs_6s" / "song", ["vocals", "piano"])

        monkeypatch.setattr(separate, "deep_separate", fake_deep)
        async with client_for(real_app) as client:
            resp = await client.post("/api/deep-separate?async=1", files=upload(wav_bytes), data={"depth": str(depth)})
            assert resp.status_code == 202, resp.text
            started = resp.json()
            assert (started["kind"], started["stage_count"]) == ("deep_separate", stage_count)
            done = await poll(client, started["id"])
            assert done["result"]["piano"] == {"url": "/api/download/deep_piano_song.wav", "label": "ピアノ・鍵盤"}

    @pytest.mark.asyncio
    async def test_音源の分解(self, real_app, wav_bytes, tmp_path, monkeypatch):
        import decompose

        def fake_decompose(input_path, bpm, sensitivity, segment, jobs, job, grid_offset_sec=0.0):
            assert (segment, jobs) == (7, 1)
            job.enter_stage("transcribe")
            stems = write_stems(tmp_path / "work", ["vocals", "bass"])
            return {"bpm": bpm or 123, "stems": {
                name: {"audio_path": str(path), "notes": [], "drum_events": [], "gm_program": None, "mix": {}}
                for name, path in stems.items()
            }}

        monkeypatch.setattr(decompose, "decompose", fake_decompose)
        async with client_for(real_app) as client:
            sync = await client.post("/api/decompose", files=upload(wav_bytes))
            assert sync.status_code == 200, sync.text

            resp = await client.post("/api/decompose?async=1", files=upload(wav_bytes))
            assert resp.status_code == 202, resp.text
            started = resp.json()
            assert (started["kind"], started["title"]) == ("decompose", "パート分離と採譜")
            assert started["stage_count"] == len(decompose.decompose_stages(detect_bpm=True)) == 5
            done = await poll(client, started["id"])
            assert done["result"] == sync.json()
            assert done["result"]["bpm"] == 123
            vocals = done["result"]["stems"]["vocals"]
            assert vocals["audio_url"] == "/api/download/decompose_vocals_song.wav" and "audio_path" not in vocals

            # BPM を指定したら、テンポを調べるステージは並びに入らない
            fixed = (await client.post("/api/decompose?async=1", files=upload(wav_bytes), data={"bpm": "90"})).json()
            assert fixed["stage_count"] == 4
            assert (await poll(client, fixed["id"]))["result"]["bpm"] == 90

    @pytest.mark.asyncio
    async def test_採譜(self, real_app, wav_bytes, monkeypatch):
        import analyze

        notes = [{"note": "A", "octave": 4, "step": 0, "length": 4}]
        monkeypatch.setattr(analyze, "analyze_wav", lambda path, bpm, sensitivity, engine: notes)
        async with client_for(real_app) as client:
            sync = await client.post("/api/analyze", files=upload(wav_bytes))
            assert (sync.status_code, sync.json()) == (200, notes)
            started = (await client.post("/api/analyze?async=1", files=upload(wav_bytes))).json()
            assert (started["kind"], started["stage_count"]) == ("analyze", 1)
            done = await poll(client, started["id"])
            assert done["result"] == notes
            assert done["stage"] == "ノートを読み取っています" and done["progress"] is None

    @pytest.mark.asyncio
    async def test_楽曲カルテは_本物の解析がジョブとして動く(self, real_app, chord_song, tmp_path):
        import song_chart

        data = Path(chord_song[0]).read_bytes()
        async with client_for(real_app) as client:
            resp = await client.post("/api/chart?async=1", files=upload(data, name="job_song.wav"))
            assert resp.status_code == 202, resp.text
            started = resp.json()
            assert (started["kind"], started["filename"]) == ("chart", "job_song.wav")
            assert started["stage_count"] == len(song_chart.CHART_STAGES) + 1

            done = await poll(client, started["id"])
            assert done["state"] == "done", done
            assert set(done["result"]) == {"chart_id", "chart", "peaks", "glossary"}
            assert done["result"]["chart_id"] == "job_song"
            assert done["stage_key"] == "save" and done["stage_index"] == done["stage_count"] - 1

            # 保存されたカルテを、補正した値でジョブとして再計算できる
            regrid = await client.post("/api/chart/regrid?async=1", data={
                "chart_id": "job_song", "bpm": "120", "downbeat_offset": "0.35"})
            assert regrid.status_code == 202, regrid.text
            assert regrid.json()["kind"] == "chart_regrid"
            redone = await poll(client, regrid.json()["id"])
            assert redone["state"] == "done", redone
            assert redone["result"]["chart"]["grid"]["bpm"] == 120.0

            # 待つ呼び方の結果と同じ（カルテはバイト安定）
            sync = await client.post("/api/chart/regrid", data={
                "chart_id": "job_song", "bpm": "120", "downbeat_offset": "0.35"})
            assert sync.status_code == 200 and sync.json() == redone["result"]

    @pytest.mark.asyncio
    async def test_無いカルテの再計算は_ジョブにせず404で返す(self, real_app, manager):
        async with client_for(real_app) as client:
            resp = await client.post("/api/chart/regrid?async=1", data={
                "chart_id": "nope", "bpm": "120", "downbeat_offset": "0"})
            assert (resp.status_code, resp.json()) == (404, {"detail": "カルテが見つかりません"})
        assert manager.jobs() == []

    @pytest.mark.asyncio
    async def test_カルテの作成をキャンセルすると_カルテは保存されない(self, real_app, wav_bytes, tmp_path, monkeypatch):
        import song_chart

        gate = Gate()

        def slow_chart(audio_path, filename, bpm, downbeat_offset, beats_per_bar, job):
            job.enter_stage("grid")
            gate.pause()
            job.enter_stage("key")
            raise AssertionError("キャンセルされたのに先へ進んだ")

        monkeypatch.setattr(song_chart, "build_chart", slow_chart)
        async with client_for(real_app) as client:
            started = (await client.post("/api/chart?async=1", files=upload(wav_bytes, name="c.wav"))).json()
            await entered(gate)
            await client.post(f"/api/jobs/{started['id']}/cancel")
            gate.release.set()
            final = await poll(client, started["id"])
            assert final["state"] == "cancelled"
            assert (await client.get("/api/chart/c")).status_code == 404
        assert not list((tmp_path / "results" / "charts").glob("*.bunri"))

    @pytest.mark.asyncio
    async def test_分離の途中でやめると_置きかけたステムが消える(self, real_app, wav_bytes, tmp_path, monkeypatch):
        import separate

        gate = Gate()

        def fake_separate(input_path, output_dir, model, two_stems, segment, jobs, job):
            return write_stems(Path(output_dir) / model / "song", ["vocals", "no_vocals"])

        monkeypatch.setattr(separate, "separate_audio", fake_separate)

        import web.api as api_module
        real_copy = api_module.shutil.copy2

        def slow_copy(src, dst):
            result = real_copy(src, dst)
            if "sep_vocals" in str(dst):
                gate.pause()   # 1 つ目のステムを置いたところで止まる
            return result

        monkeypatch.setattr(api_module.shutil, "copy2", slow_copy)
        async with client_for(real_app) as client:
            started = (await client.post("/api/separate?async=1", files=upload(wav_bytes))).json()
            await entered(gate)
            assert (tmp_path / "results" / "sep_vocals_song.wav").exists()
            await client.post(f"/api/jobs/{started['id']}/cancel")
            gate.release.set()
            final = await poll(client, started["id"])
            assert final["state"] == "cancelled"
        assert not list((tmp_path / "results").glob("sep_*"))

    @pytest.mark.asyncio
    async def test_分解が動いている間は_ほかの重い処理を始められない(self, real_app, wav_bytes, tmp_path, monkeypatch):
        import decompose

        gate = Gate()

        def slow_decompose(input_path, bpm, sensitivity, segment, jobs, job, grid_offset_sec=0.0):
            job.enter_stage("separate")
            gate.pause()
            return {"bpm": 120, "stems": {}}

        monkeypatch.setattr(decompose, "decompose", slow_decompose)
        async with client_for(real_app) as client:
            first = (await client.post("/api/decompose?async=1", files=upload(wav_bytes, name="first.wav"))).json()
            await entered(gate)

            for path in ("/api/separate", "/api/deep-separate", "/api/analyze", "/api/chart", "/api/decompose"):
                resp = await client.post(f"{path}?async=1", files=upload(wav_bytes, name="second.wav"))
                assert resp.status_code == 409, path
                assert resp.json()["job"]["id"] == first["id"]
                assert "first.wav" in resp.json()["detail"] and "パート分離と採譜" in resp.json()["detail"]
            assert not (tmp_path / "uploads" / "second.wav").exists(), "断った分のアップロードは保存しない"

            gate.release.set()
            assert (await poll(client, first["id"]))["state"] == "done"


class TestE2ESlowJob:
    """ブラウザのテスト用の、わざと遅いジョブ（web/e2e_routes.py）"""

    def e2e_app(self):
        from web import e2e_routes

        app = FastAPI()
        app.include_router(job_routes.router)
        app.include_router(e2e_routes.router)
        return app

    @pytest.mark.asyncio
    async def test_本物と同じ名前とステージで進み_割合も出し_キャンセルですぐ止まる(self):
        async with client_for(self.e2e_app()) as client:
            resp = await client.post("/api/e2e/slow-job?kind=separate&seconds=4&filename=song.wav")
            assert resp.status_code == 202, resp.text
            job = resp.json()
            assert (job["kind"], job["title"], job["filename"]) == ("separate", "パート分離", "song.wav")
            assert job["stage_count"] == 2
            # 2 つ目のステージ（分離）に入ると、割合が出る
            body = None
            for _ in range(400):
                body = (await client.get(f"/api/jobs/{job['id']}")).json()
                if body["stage_key"] == "separate" and body["progress"] is not None:
                    break
                await asyncio.sleep(0.01)
            assert body["stage_index"] == 1 and 0 <= body["progress"] <= 1
            # 動いている間の開始は、本物と同じく 409
            busy = await client.post("/api/e2e/slow-job?kind=chart&seconds=1")
            assert busy.status_code == 409 and busy.json()["code"] == "job_busy"
            assert (await client.post(f"/api/jobs/{job['id']}/cancel")).status_code == 200
            done = await poll(client, job["id"])
            assert done["state"] == "cancelled"

    @pytest.mark.asyncio
    async def test_初回のモデルのダウンロードの表示名を出す(self):
        async with client_for(self.e2e_app()) as client:
            job = (await client.post("/api/e2e/slow-job?kind=decompose&seconds=0.3")).json()
            assert job["title"] == "パート分離と採譜"
            done = await poll(client, job["id"])
            assert done["state"] == "done" and done["result"]["ok"] is True

    @pytest.mark.asyncio
    async def test_知らない種類は400(self):
        async with client_for(self.e2e_app()) as client:
            assert (await client.post("/api/e2e/slow-job?kind=unknown")).status_code == 400

    def test_既定のアプリには無い(self):
        """環境変数 BUNRI_E2E_HOOKS=1 のときだけ足す（配布物の sidecar には無い）"""
        from fastapi.testclient import TestClient
        from web import api

        with TestClient(api.app) as client:
            assert client.post("/api/e2e/slow-job").status_code in (404, 405)
            assert client.get("/api/health").json() == {"ok": True}
