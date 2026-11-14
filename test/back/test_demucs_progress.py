"""Demucs の子プロセスとの進み具合のやり取り（backend/demucs_progress.py）のテスト

本物の Demucs は動かさない。子プロセスの役は、同じ行を出す偽のスクリプトにやらせる。

- 行の読み取りと、ステージ・進み具合への直し方
- 子の側の仕掛け（Demucs のどこに手を入れるか）が、いま入っている Demucs に合っていること
- ``separate.py`` が偽の子プロセス越しに、進み具合を伝え、キャンセルで止まり、書きかけを消すこと

本物の Demucs での確認は ``BUNRI_TEST_DEMUCS=1`` を付けたときだけ動く（モデルが手元に在ることが前提）。
"""
import json
import os
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

import background_jobs
import demucs_progress
import separate
from background_jobs import CANCELLED, DONE, JobManager

BACKEND_DIR = Path(__file__).resolve().parent.parent.parent / "backend"


def until(condition, timeout=10.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if condition():
            return
        time.sleep(0.01)
    raise AssertionError("時間内に条件が成り立たなかった")


class Recorder:
    """ジョブの代わりに、伝えられたことを順に書き留める"""

    def __init__(self):
        self.log = []

    def enter_stage(self, key, label=None):
        self.log.append(("stage", key, label))

    def set_progress(self, fraction):
        self.log.append(("progress", round(fraction, 3)))


def line(event, **fields):
    return demucs_progress.EVENT_PREFIX + json.dumps({"event": event, **fields})


class TestParseEvent:
    def test_目印の付いた行だけをイベントとして読む(self):
        assert demucs_progress.parse_event(line("ready", hooks=True)) == {"event": "ready", "hooks": True}
        assert demucs_progress.parse_event("Separating track song.wav") is None
        assert demucs_progress.parse_event("") is None

    @pytest.mark.parametrize("broken", ["@@bunri {壊れた", "@@bunri [1, 2]", '@@bunri {"no_event": 1}'])
    def test_読めない行はイベントにしない(self, broken):
        assert demucs_progress.parse_event(broken) is None


class TestTracker:
    @pytest.fixture(autouse=True)
    def cached(self, monkeypatch):
        monkeypatch.setattr(demucs_progress, "needs_download", lambda model: False)

    def test_モデルの用意から分離へ進み_区間の数で進み具合が出る(self):
        rec = Recorder()
        tracker = demucs_progress.Tracker(rec, "htdemucs")
        tracker.start()
        tracker.on_line(line("ready", hooks=True))
        assert rec.log == [("stage", "model", None)], "区間が始まるまで、進み具合の数字は出さない"

        tracker.on_line(line("model_ready", passes=1))
        tracker.on_line(line("segments", **{"pass": 0, "done": 0, "total": 4}))
        tracker.on_line(line("segments", **{"pass": 0, "done": 1, "total": 4}))
        tracker.on_line(line("segments", **{"pass": 0, "done": 4, "total": 4}))
        assert rec.log[1:] == [
            ("stage", "separate", None), ("progress", 0.0), ("progress", 0.25), ("progress", 1.0)]

    def test_手元に無いモデルは_ダウンロード中と表示する(self, monkeypatch):
        monkeypatch.setattr(demucs_progress, "needs_download", lambda model: True)
        rec = Recorder()
        demucs_progress.Tracker(rec, "htdemucs").start()
        assert rec.log == [("stage", "model", demucs_progress.DOWNLOAD_LABEL)]

    def test_束ねたモデルは_なめる回数で割る(self):
        rec = Recorder()
        tracker = demucs_progress.Tracker(rec, "htdemucs_ft")
        tracker.start()
        tracker.on_line(line("model_ready", passes=4))
        tracker.on_line(line("segments", **{"pass": 0, "done": 2, "total": 4}))
        tracker.on_line(line("segments", **{"pass": 3, "done": 4, "total": 4}))
        assert [e for e in rec.log if e[0] == "progress"] == [("progress", 0.125), ("progress", 1.0)]

    def test_なめる回数が知らされた数を超えても_1を超えない(self):
        rec = Recorder()
        tracker = demucs_progress.Tracker(rec, "htdemucs")
        tracker.start()
        tracker.on_line(line("model_ready", passes=1))
        tracker.on_line(line("segments", **{"pass": 1, "done": 1, "total": 2}))
        assert rec.log[-1] == ("progress", 0.75)

    def test_仕掛けが効かないときは_分離のステージにまとめ_数字は出さない(self):
        rec = Recorder()
        tracker = demucs_progress.Tracker(rec, "htdemucs")
        tracker.start()
        tracker.on_line(line("ready", hooks=False))
        assert rec.log == [("stage", "model", None), ("stage", "separate", None)]

    def test_2回目の分離は_モデルのステージを設けない(self):
        rec = Recorder()
        tracker = demucs_progress.Tracker(rec, "htdemucs_6s", stage="separate_other", model_stage=None)
        tracker.start()
        tracker.on_line(line("model_ready", passes=1))
        assert rec.log == [("stage", "separate_other", None)]

    def test_イベントでない行はログに流す(self, capsys):
        rec = Recorder()
        tracker = demucs_progress.Tracker(rec, "htdemucs")
        tracker.on_line("Separating track song.wav")
        assert capsys.readouterr().out == "Separating track song.wav\n"
        assert rec.log == []


class TestNeedsDownload:
    def test_手元の有無はmodel_cacheに聞く(self, monkeypatch):
        import model_cache

        monkeypatch.setattr(model_cache, "model_status", lambda name: {"cached": name == "have"})
        assert demucs_progress.needs_download("have") is False
        assert demucs_progress.needs_download("missing") is True

    def test_分からないモデルはダウンロード扱いにしない(self, monkeypatch):
        import model_cache

        def unknown(name):
            raise KeyError(name)

        monkeypatch.setattr(model_cache, "model_status", unknown)
        assert demucs_progress.needs_download("whatever") is False


def events(capsys):
    """標準出力に出たイベントを順に返す"""
    return [e for e in map(demucs_progress.parse_event, capsys.readouterr().out.splitlines()) if e]


class TestChildSide:
    def test_区間を回すごとに済んだ数を出す(self, capsys):
        seen = []
        for item in demucs_progress.report_segments(["a", "b"], pass_index=2):
            seen.append((item, len(events(capsys))))
        # 1 つ目を受け取った時点で出ているのは「0 個済み」だけ。処理し終えてから「1 個済み」が出る
        assert seen == [("a", 1), ("b", 1)]
        assert events(capsys) == [{"event": "segments", "pass": 2, "done": 2, "total": 2}]

    def test_モデルの用意が終わると_なめる回数を知らせる(self, capsys):
        class Bag:
            models = [object(), object(), object(), object()]

        class Single:
            pass

        class FakeSeparator:
            def __init__(self, model):
                self.model = model

        create = demucs_progress.wrap_separator(FakeSeparator)
        assert isinstance(create(model=Bag()), FakeSeparator)
        create(model=Single())
        assert events(capsys) == [
            {"event": "model_ready", "passes": 4}, {"event": "model_ready", "passes": 1}]

    def test_頼まれていなければ何もしない(self, monkeypatch, capsys):
        monkeypatch.delenv(demucs_progress.ENV_FLAG, raising=False)
        assert demucs_progress.setup_child() is False
        assert capsys.readouterr().out == ""

    def test_いま入っているDemucsに_手を入れる場所が在る(self, monkeypatch, capsys):
        """Demucs の内部の名前に頼っているので、版が変わって無くなったら、ここで気づく"""
        import demucs.apply
        import demucs.separate

        # テストのあとで元に戻るよう、今の値で上書きしてから手を入れる
        monkeypatch.setattr(demucs.apply, "tqdm", demucs.apply.tqdm)
        monkeypatch.setattr(demucs.separate, "Separator", demucs.separate.Separator)
        assert callable(demucs.apply.tqdm.tqdm)

        assert demucs_progress.install_hooks() is True
        futures = [("f0", 0), ("f1", 5)]
        # demucs.apply と同じ呼び方
        assert list(demucs.apply.tqdm.tqdm(futures, unit_scale=5.25, ncols=120, unit="seconds", disable=True)) == futures
        assert list(demucs.apply.tqdm.tqdm(futures, disable=True)) == futures
        got = events(capsys)
        assert got[0] == {"event": "segments", "pass": 0, "done": 0, "total": 2}
        assert got[2] == {"event": "segments", "pass": 0, "done": 2, "total": 2}
        assert got[3]["pass"] == 1, "進捗バーが作られるたびに、なめる回数が進む"

    def test_親が居なくなると子は自分で終わる(self):
        code = (
            "import sys, time\n"
            f"sys.path.insert(0, {str(BACKEND_DIR)!r})\n"
            "import demucs_progress\n"
            "demucs_progress.watch_parent()\n"
            "print('ready', flush=True)\n"
            "time.sleep(600)\n"
        )
        proc = subprocess.Popen([sys.executable, "-c", code], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
        try:
            assert proc.stdout.readline().strip() == b"ready"
            proc.stdin.close()   # 親が強制終了されると、OS がこのパイプを閉じる
            assert proc.wait(timeout=10) == 1
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.wait(timeout=10)
            proc.stdout.close()


# 本物の _demucs_runner.py の代わりに動かすスクリプト。同じ引数を受け取り、同じ行を出し、
# ステムの WAV を書く。FAKE_DEMUCS_DELAY（秒）だけ区間ごとに待つ
FAKE_RUNNER = '''
import os, sys, time
sys.path.insert(0, {backend!r})
import numpy as np
import soundfile as sf
import demucs_progress

args = sys.argv[1:]
out = args[args.index("--out") + 1]
model = args[args.index("-n") + 1]
track = args[-1]
two = "--two-stems" in args
delay = float(os.environ.get("FAKE_DEMUCS_DELAY", "0"))
total = int(os.environ.get("FAKE_DEMUCS_SEGMENTS", "4"))

if os.environ.get(demucs_progress.ENV_FLAG) == "1":
    demucs_progress.watch_parent()
    demucs_progress.emit("ready", hooks=True)
print("Separating track", track, flush=True)
if os.environ.get("FAKE_DEMUCS_FAIL"):
    sys.exit(1)
demucs_progress.emit("model_ready", passes=1)
for _ in demucs_progress.report_segments(list(range(total)), 0):
    time.sleep(delay)

stems = ["vocals", "no_vocals"] if two else {{
    "htdemucs": ["vocals", "drums", "bass", "other"],
    "htdemucs_6s": ["vocals", "drums", "bass", "guitar", "piano", "other"],
    "drumsep": ["bombo", "redoblante", "toms", "platillos"],
}}[model]
name = os.path.splitext(os.path.basename(track))[0]
target = os.path.join(out, model, name)
os.makedirs(target, exist_ok=True)
tone = 0.3 * np.sin(2 * np.pi * 440 * np.arange(4410) / 44100)
for stem in stems:
    sf.write(os.path.join(target, stem + ".wav"), tone, 44100)
'''


@pytest.fixture
def fake_demucs(tmp_path, monkeypatch):
    """Demucs の子プロセスを偽のスクリプトに差し替える。モデルは手元に在ることにする"""
    runner = tmp_path / "fake_runner.py"
    runner.write_text(FAKE_RUNNER.format(backend=str(BACKEND_DIR)), encoding="utf-8")
    monkeypatch.setattr(separate, "RUNNER", runner)
    monkeypatch.setattr(demucs_progress, "needs_download", lambda model: False)
    return runner


@pytest.fixture
def manager():
    m = JobManager()
    yield m
    m.shutdown(timeout=5)


@pytest.fixture
def song(tmp_path):
    path = tmp_path / "song.wav"
    sf.write(str(path), 0.3 * np.sin(2 * np.pi * 220 * np.arange(22050) / 44100), 44100)
    return path


def watch(job, seen):
    """ジョブが終わるまで状態を集める（ステージと進み具合がどう移ったかを見るため）"""
    while not job.wait(0.005):
        snap = job.snapshot()
        if not seen or (snap["stage_key"], snap["progress"]) != (seen[-1]["stage_key"], seen[-1]["progress"]):
            seen.append(snap)


class TestSeparateThroughFakeChild:
    def test_ジョブ無しでも今までどおり分離できる(self, fake_demucs, song, tmp_path):
        paths = separate.separate_audio(str(song), output_dir=str(tmp_path / "out"), model="htdemucs")
        assert sorted(paths) == ["no_vocals", "vocals"]
        assert all(p.exists() for p in paths.values())

    def test_分離の進み具合がジョブに伝わる(self, fake_demucs, manager, song, tmp_path, monkeypatch):
        monkeypatch.setenv("FAKE_DEMUCS_DELAY", "0.05")
        monkeypatch.setenv("FAKE_DEMUCS_SEGMENTS", "5")
        out = tmp_path / "out"
        job = manager.submit(
            "separate",
            lambda job: sorted(separate.separate_audio(
                str(song), output_dir=str(out), model="htdemucs", two_stems=False, job=job)),
            stages=separate.SEPARATE_STAGES,
        )
        seen = []
        watch(job, seen)

        snap = job.snapshot()
        assert snap["state"] == DONE, snap
        assert snap["result"] == ["bass", "drums", "other", "vocals"]
        keys = [s["stage_key"] for s in seen if s["stage_key"]]
        assert keys[0] == "model" and "separate" in keys
        assert keys == sorted(keys, key=["model", "separate"].index), "ステージは後戻りしない"
        fractions = [s["progress"] for s in seen if s["stage_key"] == "separate" and s["progress"] is not None]
        assert fractions and fractions == sorted(fractions) and fractions[-1] <= 1.0
        assert any(0 < f < 1 for f in fractions), "途中の進み具合が 1 つも見えなかった"
        assert all(s["progress"] is None for s in seen if s["stage_key"] == "model")

    def test_詳細分離は_その他の再分離を別のステージとして見せる(self, fake_demucs, manager, song, tmp_path):
        out = tmp_path / "out"
        stages = []

        def work(job):
            original = job.enter_stage

            def enter(key, label=None):
                stages.append(key)
                return original(key, label)

            job.enter_stage = enter
            return sorted(separate.deep_separate(str(song), output_dir=str(out), job=job))

        job = manager.submit("deep_separate", work, stages=separate.DEEP_SEPARATE_STAGES)
        assert job.wait(30)
        snap = job.snapshot()
        assert snap["state"] == DONE, snap
        assert stages == ["model", "separate", "separate_other"]
        assert stages == [key for key, _ in separate.DEEP_SEPARATE_STAGES]
        assert "other_vocals" in snap["result"] and "other" not in snap["result"]

    def test_詳細分離でドラムを分けると_その分離も別のステージとして進み具合が出る(
        self, fake_demucs, manager, song, tmp_path, monkeypatch,
    ):
        out = tmp_path / "out"
        # 追加のモデルは手元に在ることにする（偽の子プロセスは、渡されたファイルを開かない）
        monkeypatch.setattr(separate, "_ensure_drum_model", lambda job: tmp_path / "drumsep.safetensors")
        seen = []
        job = manager.submit(
            "deep_separate",
            lambda job: list(separate.deep_separate(str(song), output_dir=str(out), split_drums=True, job=job)),
            stages=separate.deep_separate_stages(split_drums=True),
        )
        watch(job, seen)
        snap = job.snapshot()
        assert snap["state"] == DONE, snap
        keys = [s["stage_key"] for s in seen if s["stage_key"]]
        assert list(dict.fromkeys(keys)) == ["model", "separate", "separate_drums", "separate_other"]
        assert snap["stage_count"] == 4
        # ドラムの部位は drums の直後に並ぶ。出力は deep_drums/ の下
        result = snap["result"]
        at = result.index("drums")
        assert result[at + 1:at + 5] == ["drums_kick", "drums_snare", "drums_toms", "drums_cymbals"]
        assert (out / "deep_drums" / "drumsep" / "drums" / "bombo.wav").is_file()

    def test_キャンセルすると子プロセスが止まり_書きかけの出力が消える(
            self, fake_demucs, manager, song, tmp_path, monkeypatch):
        monkeypatch.setenv("FAKE_DEMUCS_DELAY", "0.2")
        monkeypatch.setenv("FAKE_DEMUCS_SEGMENTS", "200")   # 放っておくと 40 秒かかる
        out = tmp_path / "out"
        track_dir = out / "htdemucs" / "song"
        track_dir.mkdir(parents=True)
        (track_dir / "vocals.wav").write_bytes(b"left over from a previous run")

        job = manager.submit(
            "separate",
            lambda job: separate.separate_audio(str(song), output_dir=str(out), model="htdemucs", job=job),
            stages=separate.SEPARATE_STAGES,
        )
        until(lambda: (job.snapshot()["progress"] or 0) > 0)

        started = time.monotonic()
        manager.cancel(job.id)
        assert job.wait(5), "キャンセルしても止まらない"
        assert time.monotonic() - started < 3
        assert job.snapshot()["state"] == CANCELLED
        assert not track_dir.exists(), "書きかけのステムが残っている"
        # 枠が空いたので、次のジョブを始められる
        assert manager.submit("separate", lambda job: "next").wait(5)

    def test_子プロセスが失敗したら_今までと同じ理由で失敗する(self, fake_demucs, song, tmp_path, monkeypatch):
        monkeypatch.setenv("FAKE_DEMUCS_FAIL", "1")
        with pytest.raises(RuntimeError, match="Demucs の実行に失敗しました"):
            separate.separate_audio(str(song), output_dir=str(tmp_path / "out"))


@pytest.mark.skipif(os.environ.get("BUNRI_TEST_DEMUCS") != "1", reason="本物の Demucs を動かす。BUNRI_TEST_DEMUCS=1 で有効")
class TestRealDemucs:
    """本物の Demucs（htdemucs_6s）で、進み具合とキャンセルを確かめる。モデルのダウンロードはしない"""

    MODEL = "htdemucs_6s"

    @pytest.fixture
    def clip(self, tmp_path):
        if demucs_progress.needs_download(self.MODEL):
            pytest.skip(f"{self.MODEL} が手元に無い（ダウンロードはしない）")
        sr = 44100
        t = np.arange(sr * 40) / sr
        audio = 0.3 * np.sin(2 * np.pi * 220 * t) + 0.2 * np.sin(2 * np.pi * 55 * t)
        path = tmp_path / "clip.wav"
        sf.write(str(path), np.column_stack([audio, audio]), sr)
        return path

    def test_区間ごとの進み具合が出て_最後まで終わる(self, manager, clip, tmp_path):
        job = manager.submit(
            "separate",
            lambda job: sorted(separate.separate_audio(
                str(clip), output_dir=str(tmp_path / "out"), model=self.MODEL, two_stems=False, job=job)),
            stages=separate.SEPARATE_STAGES,
        )
        seen = []
        watch(job, seen)
        snap = job.snapshot()
        assert snap["state"] == DONE, snap
        assert len(snap["result"]) == 6
        fractions = [s["progress"] for s in seen if s["stage_key"] == "separate" and s["progress"] is not None]
        print("\n本物の Demucs の進み具合:", fractions, f"{snap['elapsed_sec']} 秒")
        assert len(fractions) >= 3 and fractions == sorted(fractions) and fractions[-1] == 1.0
        assert [s["stage_key"] for s in seen if s["stage_key"]][0] == "model"

    def test_キャンセルすると数秒以内に止まる(self, manager, clip, tmp_path):
        out = tmp_path / "out"
        job = manager.submit(
            "separate",
            lambda job: separate.separate_audio(
                str(clip), output_dir=str(out), model=self.MODEL, two_stems=False, job=job),
            stages=separate.SEPARATE_STAGES,
        )
        until(lambda: (job.snapshot()["progress"] or 0) > 0, timeout=120)
        started = time.monotonic()
        manager.cancel(job.id)
        assert job.wait(10)
        took = time.monotonic() - started
        print(f"\nキャンセルから止まるまで: {took:.2f} 秒")
        assert took < 5
        assert job.snapshot()["state"] == CANCELLED
        assert not (out / self.MODEL / "clip").exists()
