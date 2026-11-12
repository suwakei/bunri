"""ジョブの仕組み（backend/background_jobs.py）のテスト

本物の重い処理は使わず、合図（threading.Event）で止めたり進めたりできる偽の処理で確かめる。

- 状態の移り変わり、ステージと進み具合の報告
- 途中でのキャンセル（Python の中の処理はステージの切れ目で、子プロセスは kill で止まる）
- 重い処理は同時に 1 つ（2 つ目は断る。頼まれたときだけ順番待ち）
- 失敗の伝わり方、書きかけの出力の片付け、記録の期限切れ
"""
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest

import background_jobs
from background_jobs import CANCELLED, DONE, ERROR, QUEUED, RUNNING, JobBusy, JobCancelled, JobError, JobManager

BACKEND_DIR = Path(__file__).resolve().parent.parent.parent / "backend"
STAGES = [("first", "1 つ目をしています"), ("second", "2 つ目をしています")]


def until(condition, timeout=5.0):
    """条件が成り立つまで待つ。成り立たなければ失敗させる"""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if condition():
            return
        time.sleep(0.005)
    raise AssertionError("時間内に条件が成り立たなかった")


class Gate:
    """偽の処理を、テストの側から 1 歩ずつ進めるための合図"""

    def __init__(self):
        self.entered = threading.Event()
        self.release = threading.Event()

    def pause(self):
        """処理の側: ここまで来たことを知らせ、進めてよいと言われるまで待つ"""
        self.entered.set()
        assert self.release.wait(10), "テストが処理を進めなかった"


@pytest.fixture
def manager():
    m = JobManager()
    yield m
    m.shutdown(timeout=5)


class FakeClock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


class TestStates:
    def test_始めると走り_終わると結果が入る(self, manager):
        gate = Gate()

        def work(job):
            gate.pause()
            return {"answer": 42}

        job = manager.submit("fake", work, title="偽の処理", filename="song.wav", stages=STAGES)
        assert gate.entered.wait(5)
        snap = job.snapshot()
        assert snap["state"] == RUNNING
        assert (snap["kind"], snap["title"], snap["filename"]) == ("fake", "偽の処理", "song.wav")
        assert snap["result"] is None and snap["error"] is None
        assert manager.active() is job

        gate.release.set()
        assert job.wait(5)
        snap = job.snapshot()
        assert snap["state"] == DONE
        assert snap["result"] == {"answer": 42}
        assert snap["cancel_requested"] is False
        assert manager.active() is None
        assert manager.get(job.id) is job

    def test_作られた直後は順番待ち(self):
        job = background_jobs.Job(kind="fake", stages=STAGES)
        snap = job.snapshot()
        assert snap["state"] == QUEUED
        assert snap["stage"] is None and snap["stage_index"] is None and snap["progress"] is None
        assert snap["stage_count"] == 2
        assert snap["elapsed_sec"] == 0.0

    def test_一覧用の状態には結果のキーが無い(self, manager):
        job = manager.submit("fake", lambda job: [1, 2, 3])
        assert job.wait(5)
        assert "result" not in job.snapshot(include_result=False)
        assert job.snapshot()["result"] == [1, 2, 3]

    def test_終わったら登録した関数が呼ばれる(self, manager):
        called = []
        gate = Gate()
        job = manager.submit("fake", lambda job: gate.pause())
        job.add_done_callback(lambda j: called.append(j.state))
        gate.release.set()
        assert job.wait(5)
        until(lambda: called == [DONE])
        # 終わったあとに登録しても、その場で呼ばれる
        job.add_done_callback(lambda j: called.append("late"))
        assert called == [DONE, "late"]

    def test_経過時間は走り始めてから数え_終わると止まる(self):
        clock = FakeClock()
        manager = JobManager(clock=clock)
        gate = Gate()
        job = manager.submit("fake", lambda job: gate.pause())
        assert gate.entered.wait(5)
        clock.now += 12.34
        assert job.snapshot()["elapsed_sec"] == 12.3
        gate.release.set()
        assert job.wait(5)
        clock.now += 100
        assert job.snapshot()["elapsed_sec"] == 12.3


class TestProgress:
    def test_ステージと進み具合が伝わる(self, manager):
        gate1, gate2, gate3 = Gate(), Gate(), Gate()

        def work(job):
            job.enter_stage("first")
            gate1.pause()
            job.set_progress(0.25)
            gate2.pause()
            job.enter_stage("second", label="2 つ目（特別）")
            job.set_label("2 つ目（1/3）")
            gate3.pause()

        job = manager.submit("fake", work, stages=STAGES)

        assert gate1.entered.wait(5)
        snap = job.snapshot()
        assert (snap["stage_key"], snap["stage"], snap["stage_index"], snap["stage_count"]) == (
            "first", "1 つ目をしています", 0, 2)
        assert snap["progress"] is None, "分からないうちは数字を出さない"

        gate1.release.set()
        assert gate2.entered.wait(5)
        assert job.snapshot()["progress"] == 0.25

        gate2.release.set()
        assert gate3.entered.wait(5)
        snap = job.snapshot()
        assert (snap["stage_key"], snap["stage"], snap["stage_index"]) == ("second", "2 つ目（1/3）", 1)
        assert snap["progress"] is None, "ステージが変わったら進み具合は「分からない」に戻る"
        gate3.release.set()
        assert job.wait(5)

    def test_進み具合は0から1に丸める(self):
        job = background_jobs.detached()
        job.set_progress(1.7)
        assert job.snapshot()["progress"] == 1.0
        job.set_progress(-3)
        assert job.snapshot()["progress"] == 0.0
        job.set_progress(None)
        assert job.snapshot()["progress"] is None

    def test_並びに無いステージでも落ちない(self):
        job = background_jobs.Job(stages=STAGES)
        job.enter_stage("second")
        job.enter_stage("unknown")
        snap = job.snapshot()
        assert (snap["stage_key"], snap["stage"], snap["stage_index"]) == ("unknown", "unknown", 1)

    def test_誰も見ていないジョブは報告を受け流す(self, tmp_path):
        job = background_jobs.detached()
        job.enter_stage("anything")
        job.set_progress(0.5)
        job.check_cancelled()
        job.remove_on_abort(tmp_path / "x")
        assert job.state == RUNNING

    def test_読みながら書いても壊れない(self, manager):
        stop = threading.Event()

        def work(job):
            for i in range(2000):
                job.enter_stage("first" if i % 2 else "second")
                job.set_progress(i / 2000)

        job = manager.submit("fake", work, stages=STAGES)
        seen = []

        def read():
            while not stop.is_set():
                snap = job.snapshot()
                seen.append(snap)
                assert snap["stage_index"] in (None, 0, 1)

        readers = [threading.Thread(target=read) for _ in range(4)]
        for r in readers:
            r.start()
        assert job.wait(10)
        stop.set()
        for r in readers:
            r.join(5)
        assert job.state == DONE and seen


class TestCancel:
    def test_ステージの切れ目で止まり_書きかけの出力が消える(self, manager, tmp_path):
        gate = Gate()
        partial_file = tmp_path / "partial.wav"
        partial_dir = tmp_path / "partial_dir"
        reached_second = []

        def work(job):
            job.enter_stage("first")
            job.remove_on_abort(partial_file)
            partial_file.write_bytes(b"half")
            job.remove_on_abort(partial_dir)
            partial_dir.mkdir()
            (partial_dir / "stem.wav").write_bytes(b"half")
            gate.pause()                  # ここは途中で止められない処理のつもり
            job.enter_stage("second")     # 切れ目。キャンセルされていれば、ここで止まる
            reached_second.append(True)
            return "never"

        job = manager.submit("fake", work, stages=STAGES)
        assert gate.entered.wait(5)

        assert manager.cancel(job.id) is job
        snap = job.snapshot()
        assert snap["state"] == RUNNING, "実際に止まるまでは running のまま"
        assert snap["cancel_requested"] is True
        assert manager.active() is job, "止まるまでは、重い処理の枠を空けない"

        gate.release.set()
        assert job.wait(5)
        snap = job.snapshot()
        assert snap["state"] == CANCELLED
        assert snap["result"] is None and snap["error"] is None
        assert reached_second == []
        assert not partial_file.exists() and not partial_dir.exists()

    def test_キャンセルを頼んだあとに終わった処理も_cancelledになる(self, manager, tmp_path):
        """止められない処理が最後まで走り切っても、結果は捨てる（頼んだ側から見て結果が 1 通りになるように）"""
        gate = Gate()
        output = tmp_path / "out.wav"

        def work(job):
            job.remove_on_abort(output)
            gate.pause()
            output.write_bytes(b"done")
            return "finished anyway"

        job = manager.submit("fake", work)
        assert gate.entered.wait(5)
        manager.cancel(job.id)
        gate.release.set()
        assert job.wait(5)
        assert job.snapshot()["state"] == CANCELLED
        assert job.snapshot()["result"] is None
        assert not output.exists()

    def test_キャンセルを頼んだあとの失敗も_cancelledになる(self, manager):
        gate = Gate()

        def work(job):
            gate.pause()
            raise RuntimeError("kill されたので失敗した")

        job = manager.submit("fake", work)
        assert gate.entered.wait(5)
        manager.cancel(job.id)
        gate.release.set()
        assert job.wait(5)
        assert job.snapshot()["state"] == CANCELLED
        assert job.snapshot()["error"] is None

    def test_キャンセルは_except_Exception_に飲み込まれない(self, manager):
        swallowed = []

        def work(job):
            manager.cancel(job.id)
            try:
                job.check_cancelled()
            except Exception:
                swallowed.append(True)
            return "not cancelled"

        job = manager.submit("fake", work)
        assert job.wait(5)
        assert job.state == CANCELLED and swallowed == []
        assert not issubclass(JobCancelled, Exception)

    def test_終わったジョブのキャンセルは何もしない(self, manager):
        job = manager.submit("fake", lambda job: "ok")
        assert job.wait(5)
        assert manager.cancel(job.id) is job
        snap = job.snapshot()
        assert snap["state"] == DONE and snap["result"] == "ok" and snap["cancel_requested"] is False

    def test_無いジョブのキャンセルはNone(self, manager):
        assert manager.cancel("no-such-id") is None

    def test_正常に終わったら出力は消さない(self, manager, tmp_path):
        output = tmp_path / "out.wav"

        def work(job):
            job.remove_on_abort(output)
            output.write_bytes(b"ok")

        job = manager.submit("fake", work)
        assert job.wait(5)
        assert job.state == DONE and output.exists()


def _alive(pid):
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


SLEEPER = [sys.executable, "-c", "import time; print('started', flush=True); time.sleep(600)"]


class TestProcess:
    def test_子プロセスの出力を1行ずつ受け取り_終了コードを返す(self):
        lines = []
        job = background_jobs.detached()
        code = job.run_process(
            [sys.executable, "-c", "import sys; print('a'); print('b'); sys.exit(3)"], on_line=lines.append)
        assert code == 3
        assert lines == ["a", "b"]

    def test_キャンセルすると子プロセスが数秒以内に止まる(self, manager):
        pids = []

        def work(job):
            def on_line(line):
                pids.append(job._process.pid)
            job.run_process(SLEEPER, on_line=on_line)
            return "never"

        job = manager.submit("fake", work)
        until(lambda: pids)
        assert _alive(pids[0])

        started = time.monotonic()
        manager.cancel(job.id)
        assert job.wait(5), "キャンセルしても処理が終わらない"
        assert time.monotonic() - started < 3
        assert job.state == CANCELLED
        until(lambda: not _alive(pids[0]))

    @pytest.mark.skipif(sys.platform == "win32", reason="シグナルを無視する子プロセスは POSIX 前提")
    def test_終了を頼んでも止まらない子プロセスは_強制終了する(self, manager, monkeypatch):
        monkeypatch.setattr(background_jobs, "KILL_GRACE_SEC", 0.2)
        stubborn = [sys.executable, "-c",
                    "import signal, time; signal.signal(signal.SIGTERM, signal.SIG_IGN);"
                    "print('started', flush=True); time.sleep(600)"]
        started = threading.Event()

        def work(job):
            job.run_process(stubborn, on_line=lambda line: started.set())

        job = manager.submit("fake", work)
        assert started.wait(10)
        manager.cancel(job.id)
        assert job.wait(5)
        assert job.state == CANCELLED

    def test_始まる前にキャンセルされていたら子プロセスを起動しない(self):
        job = background_jobs.detached()
        job.request_cancel()
        with pytest.raises(JobCancelled):
            job.run_process(SLEEPER)

    def test_出力の処理が失敗しても子プロセスを残さない(self):
        pids = []
        job = background_jobs.detached()

        def on_line(line):
            pids.append(job._process.pid)
            raise ValueError("読めない行")

        with pytest.raises(ValueError):
            job.run_process(SLEEPER, on_line=on_line)
        until(lambda: not _alive(pids[0]))


class TestOneAtATime:
    def test_動いている間の2つ目は断られ_何が動いているかが分かる(self, manager):
        gate = Gate()
        first = manager.submit("decompose", lambda job: gate.pause(), title="音源の分解", filename="a.wav")
        assert gate.entered.wait(5)

        with pytest.raises(JobBusy) as info:
            manager.submit("separate", lambda job: "x")
        assert info.value.job is first
        assert len(manager.jobs()) == 1, "断ったジョブは記録に残さない"

        gate.release.set()
        assert first.wait(5)
        second = manager.submit("separate", lambda job: "x")
        assert second.wait(5) and second.snapshot()["result"] == "x"

    def test_キャンセルを頼んだだけでは_次は始められない(self, manager):
        gate = Gate()
        first = manager.submit("fake", lambda job: gate.pause())
        assert gate.entered.wait(5)
        manager.cancel(first.id)
        with pytest.raises(JobBusy):
            manager.submit("fake", lambda job: "x")
        gate.release.set()
        assert first.wait(5)
        assert manager.submit("fake", lambda job: "x").wait(5)

    def test_順番待ちを頼めば_1つずつ順に動く(self, manager):
        gate = Gate()
        running = []
        most = []
        order = []

        def work(name):
            def run(job):
                running.append(name)
                most.append(len(running))
                if name == "a":
                    gate.pause()
                order.append(name)
                running.remove(name)
            return run

        a = manager.submit("fake", work("a"), queue=True)
        assert gate.entered.wait(5)
        b = manager.submit("fake", work("b"), queue=True)
        c = manager.submit("fake", work("c"), queue=True)
        assert b.state == QUEUED and c.state == QUEUED
        assert manager.active() is a

        gate.release.set()
        assert a.wait(5) and b.wait(5) and c.wait(5)
        assert order == ["a", "b", "c"]
        assert max(most) == 1, "2 つが同時に動いた"

    def test_順番待ちのジョブはキャンセルするとその場で終わり_実行されない(self, manager):
        gate = Gate()
        ran = []
        first = manager.submit("fake", lambda job: gate.pause(), queue=True)
        assert gate.entered.wait(5)
        waiting = manager.submit("fake", lambda job: ran.append(True), queue=True)

        manager.cancel(waiting.id)
        assert waiting.state == CANCELLED
        gate.release.set()
        assert first.wait(5)
        last = manager.submit("fake", lambda job: "ok")
        assert last.wait(5)
        assert ran == []


class TestErrors:
    def test_例外は500と理由の文になる(self, manager, tmp_path):
        partial = tmp_path / "partial.wav"

        def work(job):
            job.enter_stage("first")
            job.remove_on_abort(partial)
            partial.write_bytes(b"half")
            raise RuntimeError("Demucs の実行に失敗しました。")

        job = manager.submit("fake", work, stages=STAGES)
        assert job.wait(5)
        snap = job.snapshot()
        assert snap["state"] == ERROR
        assert snap["error"] == {"status": 500, "detail": "Demucs の実行に失敗しました。"}
        assert snap["result"] is None
        assert snap["stage_key"] == "first", "どのステージで失敗したかが残る"
        assert not partial.exists()

    def test_JobErrorは状態コードと理由を引き継ぐ(self, manager):
        def work(job):
            raise JobError(400, "ファイル名が不正です")

        job = manager.submit("fake", work)
        assert job.wait(5)
        assert job.snapshot()["error"] == {"status": 400, "detail": "ファイル名が不正です"}

    def test_失敗のあとも次のジョブが動く(self, manager):
        def boom(job):
            raise SystemExit(1)

        failed = manager.submit("fake", boom)
        assert failed.wait(5) and failed.state == ERROR
        ok = manager.submit("fake", lambda job: "ok")
        assert ok.wait(5) and ok.state == DONE


class TestExpiry:
    def test_終わった記録は期限が来ると消える(self):
        clock = FakeClock()
        manager = JobManager(ttl_sec=60, clock=clock)
        job = manager.submit("fake", lambda job: "ok")
        assert job.wait(5)

        clock.now += 59
        assert manager.get(job.id) is job
        clock.now += 2
        assert manager.get(job.id) is None
        assert manager.jobs() == []

    def test_動いているジョブは期限で消えない(self):
        clock = FakeClock()
        manager = JobManager(ttl_sec=60, clock=clock)
        gate = Gate()
        job = manager.submit("fake", lambda job: gate.pause())
        assert gate.entered.wait(5)
        clock.now += 10_000
        assert manager.get(job.id) is job
        gate.release.set()
        assert job.wait(5)
        assert manager.get(job.id) is job, "期限は終わった時刻から数える"

    def test_終わった記録は件数の上限を超えると古いものから消える(self):
        manager = JobManager(max_finished=3)
        jobs = []
        for i in range(6):
            job = manager.submit("fake", lambda job, i=i: i)
            assert job.wait(5)
            jobs.append(job)
        until(lambda: len(manager.jobs()) == 3)
        assert [j.id for j in manager.jobs()] == [j.id for j in reversed(jobs[3:])]
        assert manager.get(jobs[0].id) is None


class TestShutdown:
    def test_動いているジョブも順番待ちも止め_子プロセスを残さない(self):
        manager = JobManager()
        pids = []

        def work(job):
            job.run_process(SLEEPER, on_line=lambda line: pids.append(job._process.pid))

        running = manager.submit("fake", work, queue=True)
        waiting = manager.submit("fake", lambda job: "x", queue=True)
        until(lambda: pids)

        manager.shutdown(timeout=5)
        assert running.state == CANCELLED and waiting.state == CANCELLED
        until(lambda: not _alive(pids[0]))

    def test_共有の管理が無ければ何もしない(self, monkeypatch):
        monkeypatch.setattr(background_jobs, "_default_manager", None)
        background_jobs.shutdown()
        assert background_jobs._default_manager is None

    def test_共有の管理は1つだけ作られる(self, monkeypatch):
        monkeypatch.setattr(background_jobs, "_default_manager", None)
        first = background_jobs.default_manager()
        assert background_jobs.default_manager() is first
        gate = Gate()
        job = first.submit("fake", lambda job: gate.pause())
        assert gate.entered.wait(5)
        background_jobs.shutdown(timeout=0.1)   # 止められない処理は待ち切らずに戻る
        assert job.cancel_requested
        gate.release.set()
        assert job.wait(5) and job.state == CANCELLED

    def test_プロセスが普通に終わるときも_ジョブを止めて片付ける(self, tmp_path):
        """開発用の起動を Ctrl+C で止めたときなど。子プロセスも書きかけの出力も残さない"""
        partial = tmp_path / "partial.wav"
        code = (
            "import sys, time\n"
            f"sys.path.insert(0, {str(BACKEND_DIR)!r})\n"
            "import background_jobs\n"
            "def work(job):\n"
            f"    job.remove_on_abort({str(partial)!r})\n"
            f"    open({str(partial)!r}, 'wb').write(b'half')\n"
            "    sleeper = [sys.executable, '-c', \"import time; print('up', flush=True); time.sleep(600)\"]\n"
            "    job.run_process(sleeper, on_line=lambda line: print(job._process.pid, flush=True))\n"
            "background_jobs.default_manager().submit('fake', work)\n"
            "sys.stdin.readline()\n"   # 合図が来たら、メインのスレッドが終わる
        )
        proc = subprocess.Popen([sys.executable, "-c", code], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
        try:
            child_pid = int(proc.stdout.readline())
            assert _alive(child_pid) and partial.exists()
            proc.stdin.write(b"bye\n")
            proc.stdin.flush()
            assert proc.wait(timeout=10) == 0
            until(lambda: not _alive(child_pid))
            assert not partial.exists()
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.wait(timeout=10)
            proc.stdout.close()
            proc.stdin.close()
