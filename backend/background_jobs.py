"""時間のかかる処理（ジョブ）を裏で動かし、進み具合を伝え、途中でやめられるようにする

音源分離や分解は CPU で数分かかる。1 回の HTTP リクエストで待たせると、画面はどこまで
進んだかを出せず、やめることもできない。そこで処理を「ジョブ」として専用のスレッドで動かし、
画面はジョブの状態を聞きに来る形にする。

決めていること:

- 重い処理は同時に 1 つだけ動かす（CPU 前提・低スペック PC 向け。``jobs=1`` と同じ考え方）。
  動かすスレッドは 1 本だけなので、2 つが同時に走ることは仕組みとして起きない
- 動いているものが在るときに新しく頼まれたら、既定では断る（``JobBusy``）。
  ``queue=True`` のときだけ順番待ちに入れる（従来の「終わるまで待つ」API のため）
- キャンセルは「頼む」もの。子プロセスは kill するのですぐ止まる。Python の中で動いている
  処理は止められないので、ステージの切れ目（``enter_stage`` / ``check_cancelled``）で止まる。
  実際に止まるまで状態は ``running`` のまま（``cancel_requested`` が立つ）
- 終わったジョブの記録はメモリに短時間だけ残し、古いものから捨てる

FastAPI には依存しない。HTTP との橋渡しは ``web/job_routes.py``。
"""
import atexit
import collections
import shutil
import subprocess
import sys
import threading
import time
import traceback
import uuid
from pathlib import Path

QUEUED = "queued"
RUNNING = "running"
DONE = "done"
ERROR = "error"
CANCELLED = "cancelled"
FINISHED_STATES = (DONE, ERROR, CANCELLED)

# 終わったジョブの記録を残す時間（秒）と件数の上限。結果（ノート列など）ごと持つので絞る
DEFAULT_TTL_SEC = 30 * 60
DEFAULT_MAX_FINISHED = 10

# キャンセルで子プロセスに終了を頼んでから、強制終了するまでの猶予（秒）
KILL_GRACE_SEC = 2.0


class JobCancelled(BaseException):
    """ジョブがキャンセルされたことを、処理の中から外へ伝える例外。

    ``Exception`` ではなく ``BaseException`` を継いでいる。解析のコードにある
    ``except Exception`` に飲み込まれて、キャンセルが無かったことになるのを避けるため
    （``asyncio.CancelledError`` と同じ理由）。
    """


class JobError(Exception):
    """ジョブの失敗を、HTTP の状態コードと理由の文で表す例外。

    ジョブの関数がこれを送出すると、その ``status`` と ``detail`` がそのまま記録される。
    ほかの例外は 500 と ``str(e)`` になる（従来の API の失敗の返し方と同じ）。
    """

    def __init__(self, status, detail):
        """
        Args:
            status: HTTP の状態コード（例: 400）。
            detail: 利用者に見せる理由（従来の API の ``detail`` と同じもの）。
        """
        super().__init__(detail)
        self.status = int(status)
        self.detail = detail


class JobBusy(Exception):
    """ほかのジョブが動いているので、新しいジョブを始められないことを表す例外。"""

    def __init__(self, job):
        """
        Args:
            job: いま動いている（または順番待ちの先頭の）ジョブ。
        """
        super().__init__("ほかの処理が実行中です")
        self.job = job


def _stop_process(proc, grace=None):
    """子プロセスに終了を頼み、猶予のあいだに終わらなければ強制終了する。

    Args:
        proc: ``subprocess.Popen``。
        grace: 強制終了までの猶予（秒）。None なら ``KILL_GRACE_SEC``。
    """
    if grace is None:
        grace = KILL_GRACE_SEC
    try:
        proc.terminate()
    except OSError:
        return

    def _kill():
        if proc.poll() is None:
            try:
                proc.kill()
            except OSError:
                pass

    timer = threading.Timer(grace, _kill)
    timer.daemon = True
    timer.start()


class Job:
    """1 つのジョブ。状態の記録と、処理の中から使う報告・キャンセルの窓口を兼ねる。

    処理の関数は、このオブジェクトを引数で受け取って次のものを使う:

    - ``enter_stage(key)``: 次のステージに入ったことを伝える（キャンセルの確認も兼ねる）
    - ``set_progress(fraction)``: いまのステージの中での進み具合（0〜1）。分からないなら呼ばない
    - ``set_label(label)``: いまのステージの表示名を差し替える（「3/7」のような途中経過）
    - ``check_cancelled()``: キャンセルされていたら ``JobCancelled`` を送出する
    - ``run_process(cmd)``: 子プロセスを動かす。キャンセルされたら kill する
    - ``remove_on_abort(path)``: 失敗・キャンセルのときに消す出力を登録する

    状態は複数のスレッド（処理のスレッドと、HTTP に応えるスレッド）から触られるので、
    読み書きはすべて ``_lock`` の中で行う。
    """

    def __init__(self, kind="", title="", filename=None, stages=(), clock=time.monotonic):
        """
        Args:
            kind: 処理の種類（例: ``"decompose"``）。画面が見分けるための識別子。
            title: 処理の名前（例: ``"パート分離と採譜"``）。利用者に見せる。
            filename: 対象のファイル名（無ければ None）。
            stages: ステージの並び。``(キー, 表示名)`` のリスト。
            clock: 経過時間を測る時計（単調増加する秒を返す関数）。テストで差し替える。
        """
        self.id = uuid.uuid4().hex
        self.kind = kind
        self.title = title
        self.filename = filename
        self._stages = [(str(key), str(label)) for key, label in stages]
        self._clock = clock
        self._lock = threading.RLock()
        self._cancel = threading.Event()
        self._done = threading.Event()
        self._state = QUEUED
        self._stage_key = None
        self._stage_label = None
        self._stage_index = None
        self._progress = None
        self._started_at = None
        self._finished_at = None
        self._result = None
        self._error = None
        self._process = None
        self._abort_paths = []
        self._callbacks = []

    # ---- 状態を読む ----

    @property
    def state(self):
        """いまの状態（``queued`` / ``running`` / ``done`` / ``error`` / ``cancelled``）。"""
        with self._lock:
            return self._state

    @property
    def finished(self):
        """終わっているか（成功・失敗・キャンセルのどれか）。"""
        return self.state in FINISHED_STATES

    @property
    def cancel_requested(self):
        """キャンセルを頼まれているか。"""
        return self._cancel.is_set()

    @property
    def finished_at(self):
        """終わった時刻（``clock`` の値）。終わっていなければ None。"""
        with self._lock:
            return self._finished_at

    def snapshot(self, include_result=True):
        """いまの状態を、JSON にできる辞書で返す（API がそのまま返す形）。

        Args:
            include_result: False なら ``result`` のキーを入れない（一覧用。結果は大きいことがある）。

        Returns:
            dict: ``id`` ``kind`` ``title`` ``filename`` ``state`` ``cancel_requested``
            ``stage`` ``stage_key`` ``stage_index`` ``stage_count`` ``progress``
            ``elapsed_sec`` ``error``、および ``include_result`` が True なら ``result``。
            ``progress`` は分からないとき None。``result`` は ``done`` のときだけ値が入る。
        """
        with self._lock:
            if self._started_at is None:
                elapsed = 0.0
            else:
                elapsed = (self._finished_at if self._finished_at is not None else self._clock()) - self._started_at
            data = {
                "id": self.id,
                "kind": self.kind,
                "title": self.title,
                "filename": self.filename,
                "state": self._state,
                "cancel_requested": self._cancel.is_set(),
                "stage": self._stage_label,
                "stage_key": self._stage_key,
                "stage_index": self._stage_index,
                "stage_count": len(self._stages),
                "progress": None if self._progress is None else round(self._progress, 3),
                "elapsed_sec": round(max(0.0, elapsed), 1),
                "error": dict(self._error) if self._error else None,
            }
            if include_result:
                data["result"] = self._result if self._state == DONE else None
            return data

    def wait(self, timeout=None):
        """ジョブが終わるまで待つ。

        Args:
            timeout: 待つ秒数の上限。None なら終わるまで待つ。

        Returns:
            bool: 終わっていれば True。
        """
        return self._done.wait(timeout)

    def add_done_callback(self, callback):
        """ジョブが終わったときに呼ぶ関数を登録する（すでに終わっていれば、その場で呼ぶ）。

        Args:
            callback: ``callback(job)``。処理のスレッドから呼ばれる。
        """
        with self._lock:
            if self._state not in FINISHED_STATES:
                self._callbacks.append(callback)
                return
        callback(self)

    # ---- 処理の中から使う ----

    def enter_stage(self, key, label=None):
        """次のステージに入ったことを伝える。キャンセルされていたら、ここで止める。

        進み具合（``progress``）は「分からない」に戻る。

        Args:
            key: ステージのキー。ジョブを作るときに渡した並びの中のもの。
                並びに無いキーなら、番号は変えずに表示名だけを変える。
            label: 表示名。None なら並びで決めた表示名。

        Raises:
            JobCancelled: キャンセルを頼まれていた場合。
        """
        self.check_cancelled()
        with self._lock:
            index = next((i for i, (k, _) in enumerate(self._stages) if k == key), None)
            self._stage_key = key
            if index is not None:
                self._stage_index = index
                self._stage_label = label or self._stages[index][1]
            else:
                self._stage_label = label or key
            self._progress = None

    def set_progress(self, fraction):
        """いまのステージの中での進み具合を伝える。

        Args:
            fraction: 0〜1。範囲の外は丸める。None なら「分からない」に戻す。
        """
        with self._lock:
            if fraction is None:
                self._progress = None
            else:
                self._progress = min(1.0, max(0.0, float(fraction)))

    def set_label(self, label):
        """いまのステージの表示名を差し替える。

        Args:
            label: 新しい表示名。
        """
        with self._lock:
            self._stage_label = label

    def check_cancelled(self):
        """キャンセルを頼まれていたら、処理を止める。

        Raises:
            JobCancelled: キャンセルを頼まれていた場合。
        """
        if self._cancel.is_set():
            raise JobCancelled()

    def remove_on_abort(self, path):
        """ジョブが失敗またはキャンセルで終わったときに消すファイル・ディレクトリを登録する。

        書きかけの出力を残さないためのもの。書き始める直前に登録する。

        Args:
            path: ファイルまたはディレクトリのパス。
        """
        with self._lock:
            self._abort_paths.append(Path(path))

    def run_process(self, cmd, on_line=None, env=None):
        """子プロセスを起動して、終わるまで待つ。キャンセルされたら kill する。

        子プロセスの標準入力にはパイプを渡し、こちらが握ったままにする。子の側は、それが
        EOF になったら親が居なくなったと判断できる（``demucs_progress.watch_parent``）。

        Args:
            cmd: 実行するコマンド（リスト）。
            on_line: 子プロセスが標準出力に出した行を受け取る関数（改行は除いてある）。
                None なら標準出力はそのまま引き継ぐ。
            env: 子プロセスの環境変数。None なら引き継ぐ。

        Returns:
            int: 子プロセスの終了コード。

        Raises:
            JobCancelled: 起動の前、または実行の途中でキャンセルされた場合。
        """
        self.check_cancelled()
        proc = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE if on_line else None,
            env=env,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        # 登録とキャンセルの確認を同じロックの中で行う。起動と同時に来たキャンセルを取りこぼさないため
        with self._lock:
            self._process = proc
            cancelled = self._cancel.is_set()
        try:
            if cancelled:
                _stop_process(proc)
            if on_line:
                for line in proc.stdout:
                    on_line(line.rstrip("\r\n"))
            proc.wait()
        finally:
            with self._lock:
                self._process = None
            if proc.poll() is None:
                # on_line が例外を出したとき。子プロセスを残さない
                proc.kill()
                proc.wait()
            for stream in (proc.stdin, proc.stdout):
                if stream is not None:
                    try:
                        stream.close()
                    except OSError:
                        pass
        self.check_cancelled()
        return proc.returncode

    # ---- 管理する側（JobManager）から使う ----

    def request_cancel(self):
        """キャンセルを頼む。動いている子プロセスが在れば止める。

        Returns:
            bool: 頼めたら True。すでに終わっていたら False。
        """
        with self._lock:
            if self._state in FINISHED_STATES:
                return False
            self._cancel.set()
            proc = self._process
        if proc is not None:
            _stop_process(proc)
        return True

    def _begin(self):
        """実行を始める（``queued`` → ``running``）。すでに終わっていたら False を返す。"""
        with self._lock:
            if self._state != QUEUED:
                return False
            self._state = RUNNING
            self._started_at = self._clock()
            return True

    def _finish(self, state, result=None, error=None):
        """終わりを記録する。失敗・キャンセルなら、登録された出力を消す。

        Args:
            state: ``done`` / ``error`` / ``cancelled``。
            result: 成功したときの結果（JSON にできる値）。
            error: 失敗したときの ``{"status": int, "detail": 理由}``。
        """
        with self._lock:
            if self._state in FINISHED_STATES:
                return
            paths = self._abort_paths if state != DONE else []
            self._abort_paths = []
        # 消すのは状態を変える前。「cancelled になった時点で、書きかけは残っていない」を守る
        for path in paths:
            try:
                if path.is_dir():
                    shutil.rmtree(path, ignore_errors=True)
                else:
                    path.unlink(missing_ok=True)
            except OSError:
                pass
        with self._lock:
            self._state = state
            self._result = result if state == DONE else None
            self._error = error if state == ERROR else None
            self._finished_at = self._clock()
            if self._started_at is None:
                self._started_at = self._finished_at
            self._progress = None if state != DONE else self._progress
            callbacks, self._callbacks = self._callbacks, []
        self._done.set()
        for callback in callbacks:
            try:
                callback(self)
            except Exception:
                traceback.print_exc()


def detached():
    """誰も見ていないジョブを返す。報告は捨てられ、キャンセルされることも無い。

    ジョブとしてではなく直接呼ばれたとき（コマンドラインやテスト）に、処理の側が
    ``job`` の有無で分岐せずに済むようにするためのもの。

    Returns:
        Job: 状態が ``running`` のジョブ。
    """
    job = Job(kind="detached")
    job._begin()
    return job


class JobManager:
    """ジョブを 1 つずつ動かし、終わったものの記録を短時間だけ持つ。

    動かすスレッドは 1 本。順番待ちの列から 1 つ取り出しては実行する。
    記録の読み書きは ``_cond``（ロック）の中で行う。ロックを取る順は常に
    「この管理のロック → 各ジョブのロック」。
    """

    def __init__(self, ttl_sec=DEFAULT_TTL_SEC, max_finished=DEFAULT_MAX_FINISHED, clock=time.monotonic):
        """
        Args:
            ttl_sec: 終わったジョブの記録を残す時間（秒）。
            max_finished: 終わったジョブの記録を残す件数の上限。
            clock: 時計（単調増加する秒を返す関数）。テストで差し替える。
        """
        self._ttl = ttl_sec
        self._max_finished = max_finished
        self._clock = clock
        self._cond = threading.Condition(threading.RLock())
        self._jobs = collections.OrderedDict()  # id -> Job（作られた順）
        self._funcs = {}                        # id -> 実行する関数（始まるまで持つ）
        self._queue = collections.deque()
        self._running = None
        self._worker = None

    def submit(self, kind, func, title="", filename=None, stages=(), queue=False):
        """ジョブを作って、実行を頼む。

        Args:
            kind: 処理の種類（``Job.kind``）。
            func: 実行する関数。``func(job)`` の戻り値（JSON にできる値）が結果になる。
            title: 処理の名前（利用者に見せる）。
            filename: 対象のファイル名。
            stages: ステージの並び。``(キー, 表示名)`` のリスト。
            queue: True なら、ほかのジョブが動いていても順番待ちに入れる。

        Returns:
            Job: 作ったジョブ。

        Raises:
            JobBusy: ``queue`` が False で、ほかのジョブが動いている（または待っている）場合。
        """
        with self._cond:
            self._prune()
            if not queue:
                busy = self._active()
                if busy is not None:
                    raise JobBusy(busy)
            job = Job(kind=kind, title=title, filename=filename, stages=stages, clock=self._clock)
            self._jobs[job.id] = job
            self._funcs[job.id] = func
            self._queue.append(job)
            if self._worker is None or not self._worker.is_alive():
                self._worker = threading.Thread(target=self._work, name="bunri-jobs", daemon=True)
                self._worker.start()
            self._cond.notify_all()
            return job

    def get(self, job_id):
        """ID からジョブを引く。

        Args:
            job_id: ジョブの ID。

        Returns:
            Job | None: 無い（または期限が切れて捨てた）なら None。
        """
        with self._cond:
            self._prune()
            return self._jobs.get(job_id)

    def jobs(self):
        """記録に在るジョブを、新しい順に返す。

        Returns:
            list[Job]: ジョブのリスト。
        """
        with self._cond:
            self._prune()
            return list(reversed(self._jobs.values()))

    def active(self):
        """いま動いているジョブ（無ければ順番待ちの先頭）を返す。

        Returns:
            Job | None: どちらも無ければ None。
        """
        with self._cond:
            return self._active()

    def cancel(self, job_id):
        """ジョブのキャンセルを頼む。

        順番待ちのジョブは、その場で ``cancelled`` になる。動いているジョブは、
        実際に止まった時点で ``cancelled`` になる。終わっているジョブには何もしない。

        Args:
            job_id: ジョブの ID。

        Returns:
            Job | None: 対象のジョブ。無ければ None。
        """
        with self._cond:
            job = self._jobs.get(job_id)
            if job is None:
                return None
            waiting = job in self._queue
            if waiting:
                self._queue.remove(job)
                self._funcs.pop(job.id, None)
        job.request_cancel()
        if waiting:
            job._finish(CANCELLED)
        return job

    def shutdown(self, timeout=KILL_GRACE_SEC):
        """動いているジョブと順番待ちのジョブをすべて止める（サーバが終わるとき用）。

        子プロセスを止め、書きかけの出力が片付くのを ``timeout`` 秒まで待つ。

        Args:
            timeout: 待つ秒数の上限。
        """
        with self._cond:
            pending = [job for job in self._jobs.values() if not job.finished]
        for job in pending:
            self.cancel(job.id)
        deadline = time.monotonic() + timeout
        for job in pending:
            job.wait(max(0.0, deadline - time.monotonic()))

    def _active(self):
        """動いているジョブ、無ければ順番待ちの先頭（ロックの中から呼ぶ）。"""
        if self._running is not None:
            return self._running
        return self._queue[0] if self._queue else None

    def _prune(self):
        """期限の切れた記録と、上限を超えた古い記録を捨てる（ロックの中から呼ぶ）。"""
        now = self._clock()
        finished = [job for job in self._jobs.values() if job.finished]
        expired = [job for job in finished if now - (job.finished_at or now) > self._ttl]
        kept = [job for job in finished if job not in expired]
        overflow = kept[:max(0, len(kept) - self._max_finished)]
        for job in expired + overflow:
            self._jobs.pop(job.id, None)

    def _work(self):
        """順番待ちの列からジョブを 1 つずつ取り出して実行する（専用スレッドの本体）。"""
        while True:
            with self._cond:
                while not self._queue:
                    self._cond.wait()
                job = self._queue.popleft()
                func = self._funcs.pop(job.id, None)
                self._running = job
            try:
                self._run(job, func)
            finally:
                with self._cond:
                    self._running = None
                    self._prune()

    def _run(self, job, func):
        """ジョブを 1 つ実行して、終わりを記録する。

        キャンセルを頼まれたあとに終わったものは、成功していても失敗していても
        ``cancelled`` にする（頼んだ側から見て、結果が 1 通りに決まるように）。
        """
        if func is None or not job._begin():
            return
        state, result, error = DONE, None, None
        try:
            job.check_cancelled()
            result = func(job)
        except JobCancelled:
            state = CANCELLED
        except JobError as e:
            state, error = ERROR, {"status": e.status, "detail": e.detail}
        except BaseException as e:  # noqa: BLE001 - スレッドを落とさない。落ちると以後のジョブが動かない
            traceback.print_exc(file=sys.stderr)
            state, error = ERROR, {"status": 500, "detail": str(e)}
        if job.cancel_requested:
            state, result, error = CANCELLED, None, None
        job._finish(state, result=result, error=error)


_default_lock = threading.Lock()
_default_manager = None


def default_manager():
    """アプリ全体で 1 つだけ使うジョブの管理を返す（無ければ作る）。

    Returns:
        JobManager: 共有の管理。
    """
    global _default_manager
    with _default_lock:
        if _default_manager is None:
            _default_manager = JobManager()
        return _default_manager


def shutdown(timeout=KILL_GRACE_SEC):
    """共有の管理が持つジョブをすべて止める。まだ作られていなければ何もしない。

    プロセスが終わるときに呼ぶ。通常の終了では ``atexit`` から、sidecar が親を失って
    終わるときは ``run_web`` から呼ばれる。

    Args:
        timeout: 片付けを待つ秒数の上限。
    """
    with _default_lock:
        manager = _default_manager
    if manager is not None:
        manager.shutdown(timeout)


atexit.register(shutdown)
