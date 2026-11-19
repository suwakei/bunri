"""新モデルのジョブ接続と、実際の子プロセスのキャンセル・後片付け。"""
import time

import pytest

import background_jobs
import demucs_progress
import modern_models
import modern_separate


def test_取得量と区間数の進み具合を別のステージで返す():
    job = background_jobs.Job(kind="decompose", stages=[("model", "準備"), ("separate", "分離")])
    tracker = demucs_progress.Tracker(job, "subroformer")
    tracker.start()
    tracker.on_line('@@bunri {"event":"model_download","done":10,"total":20}')
    assert job.snapshot()["stage_key"] == "model" and job.snapshot()["progress"] == 0.5
    tracker.on_line('@@bunri {"event":"model_ready","passes":1}')
    assert job.snapshot()["stage_key"] == "separate" and job.snapshot()["progress"] is None
    tracker.on_line('@@bunri {"event":"segments","pass":0,"done":2,"total":4}')
    assert job.snapshot()["progress"] == 0.5


def test_失敗理由は子プロセスから受け取って知らせる(tmp_path, monkeypatch):
    source = tmp_path / "input.wav"
    source.touch()
    monkeypatch.setenv("BUNRI_DATA_DIR", str(tmp_path))
    job = background_jobs.Job(kind="decompose", stages=[("model", "準備"), ("separate", "分離")])
    def fake_run(command, on_line, env):
        on_line('@@bunri {"event":"error","message":"モデルを取得できませんでした"}')
        return 1
    monkeypatch.setattr(job, "run_process", fake_run)
    with pytest.raises(RuntimeError, match="モデルを取得できませんでした"):
        modern_separate.separate(source, tmp_path / "outputs", "scnet", job)


def test_同じ曲を連続して分け直しても前の中間ファイルと衝突しない(tmp_path, monkeypatch):
    monkeypatch.setenv("BUNRI_DATA_DIR", str(tmp_path))
    source = tmp_path / "input.wav"
    source.touch()
    from pathlib import Path
    def fake_run(self, command, on_line, env):
        output = Path(command[command.index("--out") + 1])
        output.mkdir(parents=True, exist_ok=True)
        for stem in modern_separate.STEMS:
            with (output / f"{stem}.wav").open("xb") as stream:
                stream.write(b"new output")
        return 0
    monkeypatch.setattr(background_jobs.Job, "run_process", fake_run)
    for _ in range(2):
        paths = modern_separate.separate(source, tmp_path / "outputs", "scnet")
        assert all(path.read_bytes() == b"new output" for path in paths.values())


def test_キャンセルで子を止め取得途中と分離途中だけを消す(tmp_path, monkeypatch):
    monkeypatch.setenv("BUNRI_DATA_DIR", str(tmp_path))
    source = tmp_path / "input.wav"
    source.write_bytes(b"original")
    runner = tmp_path / "fake_runner.py"
    runner.write_text('''import argparse,time
from pathlib import Path
p=argparse.ArgumentParser()
p.add_argument('--input');p.add_argument('--out');p.add_argument('--model');p.add_argument('--weights')
a=p.parse_args()
out=Path(a.out);out.mkdir(parents=True)
(out/'vocals.wav').write_bytes(b'partial audio')
Path(a.weights+'.part').write_bytes(b'partial weights')
time.sleep(60)
''')
    monkeypatch.setattr(modern_separate, "RUNNER", runner)
    manager = background_jobs.JobManager()
    try:
        job = manager.submit("decompose", lambda job: modern_separate.separate(source, tmp_path / "out", "scnet", job),
                             stages=[("model", "準備"), ("separate", "分離")])
        partial = modern_models.partial_path("scnet")
        deadline = time.monotonic() + 5
        while not partial.exists() and time.monotonic() < deadline:
            time.sleep(0.01)
        assert partial.exists()
        manager.cancel(job.id)
        assert job.wait(5)
        assert job.snapshot()["state"] == "cancelled"
        assert not partial.exists()
        assert not (tmp_path / "out" / "scnet" / "input").exists()
        assert source.read_bytes() == b"original"
    finally:
        manager.shutdown(timeout=5)
