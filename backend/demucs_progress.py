"""Demucs の子プロセスと、進み具合をやり取りする

Demucs は子プロセス（``_demucs_runner.py``）として動く。親（API サーバ）からは中が見えないので、
子の側で Demucs に 2 箇所だけ手を入れ、進み具合を標準出力に 1 行ずつ出してもらう。
行の頭に目印（``EVENT_PREFIX``）を付け、Demucs 自身の出力と見分ける。

このファイルは、そのやり取りの両側を持つ:

- 子の側: ``setup_child()``。``_demucs_runner.py`` が Demucs を起動する前に呼ぶ
- 親の側: ``run()``。子プロセスを起動し、届いた行をジョブ（``background_jobs.Job``）に伝える

子が出すイベント（JSON）:

- ``{"event": "ready", "hooks": bool}`` … 起動した。``hooks`` が False なら、進み具合は出せない
- ``{"event": "model_ready", "passes": N}`` … モデルの用意（初回はダウンロード）が終わった。
  ``passes`` は、1 曲を何回なめるか（束ねたモデルの数）
- ``{"event": "segments", "pass": k, "done": i, "total": n}`` … k 回目の、n 区間中 i 区間が済んだ

torch や demucs の import は重いので、子の側の関数の中でだけ行う。
"""
import json
import os
import sys
import threading

EVENT_PREFIX = "@@bunri "

# 親がこの環境変数を立てて起動したときだけ、子はイベントを出し、親の生死を見張る。
# コマンドラインから直接 _demucs_runner.py を動かしたときの挙動は変えない
ENV_FLAG = "BUNRI_DEMUCS_EVENTS"

# モデルが手元に無いときの、モデルを用意するステージの表示名
DOWNLOAD_LABEL = "モデルをダウンロードしています（初回のみ）"


# ---- 子プロセスの側 ----

def emit(event, **fields):
    """イベントを 1 行で標準出力に出す。

    Args:
        event: イベントの名前。
        **fields: イベントに付ける値（JSON にできるもの）。
    """
    print(EVENT_PREFIX + json.dumps({"event": event, **fields}), flush=True)


def report_segments(iterable, pass_index):
    """区間の並びを回しながら、済んだ数をイベントで出す。

    Args:
        iterable: Demucs が区間ごとに回す並び（長さが分かるもの、またはそれを包んだ tqdm）。
        pass_index: 何回目のなめ方か（0 始まり）。

    Yields:
        ``iterable`` の要素をそのまま。
    """
    total = len(iterable)
    emit("segments", **{"pass": pass_index, "done": 0, "total": total})
    for done, item in enumerate(iterable, start=1):
        yield item
        # ここに戻ってくるのは、呼び出し側がその区間を処理し終えたあと
        emit("segments", **{"pass": pass_index, "done": done, "total": total})


def wrap_separator(original):
    """Demucs の ``Separator`` を包み、モデルの用意が終わったことをイベントで出すようにする。

    Args:
        original: 元の ``Separator``（クラス）。

    Returns:
        同じ引数で呼べる関数。戻り値は元の ``Separator`` のインスタンス。
    """
    def create(*args, **kwargs):
        separator = original(*args, **kwargs)
        models = getattr(getattr(separator, "model", None), "models", None)
        emit("model_ready", passes=len(models) if models else 1)
        return separator

    return create


def install_hooks():
    """Demucs に手を入れて、進み具合のイベントを出すようにする。

    手を入れるのは 2 箇所。どちらも Demucs の内部の名前に頼っているので、版が変わって
    見つからなければ何もせず False を返す（分離そのものは動く。進み具合が出ないだけ）。

    - ``demucs.separate.Separator``: モデルの用意が終わったことを知る
    - ``demucs.apply.tqdm``: 区間ごとの進み具合を知る。元の進捗バー（標準エラー）はそのまま出す

    Returns:
        bool: 手を入れられたら True。
    """
    try:
        import types

        import demucs.apply as apply_module
        import demucs.separate as separate_module

        original_tqdm = apply_module.tqdm.tqdm
        original_separator = separate_module.Separator
    except Exception:
        return False

    passes = {"count": 0}

    def tqdm(iterable, *args, **kwargs):
        index = passes["count"]
        passes["count"] += 1
        return report_segments(original_tqdm(iterable, *args, **kwargs), index)

    # demucs.apply は tqdm.tqdm(...) の形でしか使わない
    apply_module.tqdm = types.SimpleNamespace(tqdm=tqdm)
    separate_module.Separator = wrap_separator(original_separator)
    return True


def watch_parent(fd=0):
    """親（API サーバ）が居なくなったら、自分で終わるための見張りを始める。

    親は、この子プロセスの標準入力をパイプで握ったままにする（``Job.run_process``）。
    親が強制終了されても OS がパイプを閉じるので、EOF になったら親が居なくなったと判断できる。
    ``run_web.watch_parent`` と同じ仕組み。

    ``sys.stdin`` ではなくファイル記述子を直接読む。``sys.stdin.buffer`` を別スレッドで
    読んだままにすると、処理が普通に終わるときに Python がそのロックを取れず、異常終了になる。

    Args:
        fd: 見張るファイル記述子。既定は標準入力（0）。

    Returns:
        threading.Thread: 見張りのスレッド（デーモン）。
    """
    def _watch():
        try:
            while os.read(fd, 4096):
                pass
        except OSError:
            pass
        os._exit(1)

    thread = threading.Thread(target=_watch, name="parent-watch", daemon=True)
    thread.start()
    return thread


def setup_child():
    """子プロセスの側の準備をする。親が頼んだとき（``ENV_FLAG``）だけ動く。

    Returns:
        bool: 準備をしたら True。頼まれていなければ False。
    """
    if os.environ.get(ENV_FLAG) != "1":
        return False
    watch_parent()
    emit("ready", hooks=install_hooks())
    return True


# ---- 親の側 ----

def parse_event(line):
    """子プロセスの出力 1 行から、イベントを取り出す。

    Args:
        line: 標準出力の 1 行（改行なし）。

    Returns:
        dict | None: イベント。目印が無い行、または JSON として読めない行なら None。
    """
    if not line.startswith(EVENT_PREFIX):
        return None
    try:
        event = json.loads(line[len(EVENT_PREFIX):])
    except ValueError:
        return None
    return event if isinstance(event, dict) and "event" in event else None


def needs_download(model):
    """モデルが手元に無く、ダウンロードが要るかを返す。

    Args:
        model: Demucs のモデル名。

    Returns:
        bool: ダウンロードが要るなら True。分からないとき（知らない名前など）は False。
    """
    import model_cache

    try:
        return not model_cache.model_status(model)["cached"]
    except Exception:
        return False


class Tracker:
    """子プロセスから届いた行を読み、ジョブのステージと進み具合に直す。"""

    def __init__(self, job, model, stage="separate", model_stage="model"):
        """
        Args:
            job: 伝える先のジョブ（``background_jobs.Job``）。
            model: Demucs のモデル名（ダウンロードが要るかの判定に使う）。
            stage: 分離そのもののステージのキー。
            model_stage: モデルを用意するステージのキー。None なら、そのステージを設けず、
                最初から ``stage`` に入る（同じジョブの中で 2 回目に分離するとき）。
        """
        self._job = job
        self._model = model
        self._stage = stage
        self._model_stage = model_stage
        self._separating = False
        self._passes = 1

    def start(self):
        """子プロセスを起動する直前に呼ぶ。最初のステージに入る。"""
        if self._model_stage is None:
            self._enter_separation()
        elif needs_download(self._model):
            self._job.enter_stage(self._model_stage, label=DOWNLOAD_LABEL)
        else:
            self._job.enter_stage(self._model_stage)

    def on_line(self, line):
        """子プロセスの標準出力 1 行を処理する。イベントでない行は、そのままログに流す。

        Args:
            line: 標準出力の 1 行（改行なし）。
        """
        event = parse_event(line)
        if event is None:
            try:
                print(line, flush=True)
            except OSError:
                pass  # ログの出力先が閉じていても、分離は止めない
            return
        name = event["event"]
        if name == "ready":
            if not event.get("hooks"):
                # 進み具合が取れない。モデルの用意と分離の境目も分からないので、分離のステージにまとめる
                self._enter_separation()
        elif name == "model_ready":
            self._passes = max(1, int(event.get("passes") or 1))
            self._enter_separation()
        elif name == "segments":
            self._enter_separation()
            total = int(event.get("total") or 0)
            if total > 0:
                index = int(event.get("pass") or 0)
                passes = max(self._passes, index + 1)
                self._job.set_progress((index + int(event.get("done") or 0) / total) / passes)

    def _enter_separation(self):
        """分離のステージに入る（すでに入っていれば何もしない）。"""
        if not self._separating:
            self._separating = True
            self._job.enter_stage(self._stage)


def run(cmd, model, job=None, stage="separate", model_stage="model"):
    """Demucs の子プロセスを動かし、進み具合をジョブに伝える。

    Args:
        cmd: ``_demucs_runner.py`` を起動するコマンド（リスト）。
        model: Demucs のモデル名。
        job: 伝える先のジョブ。None なら伝えない（進捗バーは今までどおり標準エラーに出る）。
        stage: 分離そのもののステージのキー。
        model_stage: モデルを用意するステージのキー（``Tracker`` を参照）。

    Returns:
        int: 子プロセスの終了コード。

    Raises:
        background_jobs.JobCancelled: ジョブがキャンセルされた場合（子プロセスは kill 済み）。
    """
    import background_jobs

    if job is None:
        job = background_jobs.detached()
    tracker = Tracker(job, model, stage=stage, model_stage=model_stage)
    tracker.start()
    # 子の出力がパイプ越しになるので、溜め込まずに 1 行ずつ出させる
    env = dict(os.environ, **{ENV_FLAG: "1", "PYTHONUNBUFFERED": "1"})
    return job.run_process(cmd, on_line=tracker.on_line, env=env)
