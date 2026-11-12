"""ジョブの API（``/api/jobs…``）と、時間のかかる API をジョブとして動かすための共通処理

時間のかかる API（音源分離・分解・カルテ・採譜）は、どれも ``dispatch`` を通して動く。

- ``?async=1`` を付けて呼ぶと、ジョブを始めてすぐ 202 を返す。進み具合は ``GET /api/jobs/{id}`` で聞く
- 付けずに呼ぶと、今までどおり終わるまで待って結果を返す。中身は同じジョブなので、
  この呼び方でも ``/api/jobs`` から進み具合が見え、キャンセルもできる

重い処理は同時に 1 つだけ。``?async=1`` の開始は、ほかが動いていれば 409 で断る。
待つ呼び方（従来どおり）は断らず、順番を待ってから動く。詳しくは ``docs/jobs.md``。
"""
import asyncio
import json

from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse

import background_jobs

router = APIRouter()

BUSY_CODE = "job_busy"


def _busy_response(job):
    """ほかのジョブが動いていて始められないときの応答（409）を作る。

    ``detail`` は従来の失敗と同じく文字列にしてある（画面がそのまま出せる）。
    何が動いているかは ``job`` に入れる。

    Args:
        job: いま動いている（または順番待ちの先頭の）ジョブ。

    Returns:
        JSONResponse: ``{"detail": 文, "code": "job_busy", "job": ジョブの状態}``。
    """
    name = job.title or "ほかの処理"
    target = f"「{job.filename}」の" if job.filename else ""
    return JSONResponse(
        {
            "detail": f"{target}{name}を実行中です。終わるか、キャンセルしてから始めてください",
            "code": BUSY_CODE,
            "job": job.snapshot(include_result=False),
        },
        status_code=409,
    )


def _guard(task, job, prepare):
    """ジョブの中で ``prepare`` と ``task`` を動かし、``HTTPException`` をジョブの失敗に直す。

    Args:
        task: ``task(job, prepared)``。結果（JSON にできる値）を返す。
        job: 動かしているジョブ。
        prepare: ``prepare()``。``task`` に渡す値を返す。

    Returns:
        ``task`` の戻り値。

    Raises:
        background_jobs.JobError: ``HTTPException`` が送出された場合（状態コードと理由を引き継ぐ）。
        ValueError: 結果が JSON にできない場合（ジョブは 500 の失敗になる）。
        TypeError: 同上。
    """
    try:
        result = task(job, prepare())
    except HTTPException as e:
        raise background_jobs.JobError(e.status_code, e.detail) from e
    # JSON にできない結果（NaN など）は、ここで失敗にする。あとで状態を聞く API が壊れないように。
    # 応答を作るときと同じ条件で確かめる（従来も、この失敗は 500 と同じ理由の文で返っていた）
    json.dumps(result, allow_nan=False)
    return result


async def _wait(job):
    """イベントループを止めずに、ジョブが終わるのを待つ。

    Args:
        job: 待つジョブ。
    """
    loop = asyncio.get_running_loop()
    finished = loop.create_future()

    def _resolve():
        if not finished.done():
            finished.set_result(None)

    def _wake(_job):
        try:
            loop.call_soon_threadsafe(_resolve)
        except RuntimeError:
            pass  # 待っている側のループが先に閉じた

    job.add_done_callback(_wake)
    await finished


async def dispatch(kind, *, title, filename, stages, prepare, task, run_async):
    """時間のかかる処理をジョブとして動かし、呼び方に合った応答を返す。

    ``prepare`` は、アップロードの保存や入力の確認のように、処理の前に済ませること。
    ``run_async`` のときは応答を返す前に（アップロードが閉じられる前に）ここで実行し、
    失敗はそのまま HTTP の失敗として返す。待つ呼び方のときは、順番が来てからジョブの中で実行する
    （前のジョブが読んでいる最中のファイルを、上書きしないため）。

    Args:
        kind: 処理の種類（``Job.kind``）。
        title: 処理の名前（利用者に見せる）。
        filename: 対象のファイル名。
        stages: ステージの並び。``(キー, 表示名)`` のリスト。
        prepare: ``prepare()``。``task`` に渡す値を返す。``HTTPException`` を送出してよい。
        task: ``task(job, prepared)``。結果（JSON にできる値）を返す。
            ``HTTPException`` を送出してよい。ほかの例外は 500 になる。
        run_async: True なら、始めてすぐ返す（202）。False なら、終わるまで待って結果を返す。

    Returns:
        JSONResponse: ``run_async`` なら 202 とジョブの状態、または 409（ほかが実行中）。
        そうでなければ、処理の結果。

    Raises:
        HTTPException: 待つ呼び方で、処理が失敗した場合（ジョブの失敗と同じ状態コードと理由）、
            または途中でキャンセルされた場合（409）。
    """
    manager = background_jobs.default_manager()
    options = {"title": title, "filename": filename, "stages": stages}

    if run_async:
        busy = manager.active()
        if busy is not None:
            return _busy_response(busy)
        prepared = prepare()
        try:
            job = manager.submit(kind, lambda job: _guard(task, job, lambda: prepared), **options)
        except background_jobs.JobBusy as e:
            return _busy_response(e.job)
        return JSONResponse(job.snapshot(), status_code=202)

    job = manager.submit(kind, lambda job: _guard(task, job, prepare), queue=True, **options)
    await _wait(job)
    state = job.snapshot()
    if state["state"] == background_jobs.DONE:
        return JSONResponse(state["result"])
    if state["state"] == background_jobs.ERROR:
        raise HTTPException(state["error"]["status"], state["error"]["detail"])
    raise HTTPException(409, "処理はキャンセルされました")


def _job_or_404(job):
    """ジョブが無ければ 404 にする。

    Args:
        job: ``JobManager.get`` などの戻り値。

    Returns:
        background_jobs.Job: ジョブ。

    Raises:
        HTTPException: None の場合（HTTP 404）。
    """
    if job is None:
        raise HTTPException(404, "ジョブが見つかりません（終わってから時間が経つと記録は消えます）")
    return job


@router.get("/api/jobs")
async def api_jobs():
    """ジョブの一覧を返す。画面を開き直したときに、動いているジョブを見つけるための API。

    Returns:
        ``{"active": 動いているジョブ（無ければ null）, "jobs": 記録に在るジョブ（新しい順）}``。
        どちらも結果（``result``）は入れない。結果は ``GET /api/jobs/{id}`` で取る。
    """
    manager = background_jobs.default_manager()
    active = manager.active()
    return {
        "active": active.snapshot(include_result=False) if active else None,
        "jobs": [job.snapshot(include_result=False) for job in manager.jobs()],
    }


@router.get("/api/jobs/{job_id}")
async def api_job(job_id: str):
    """ジョブの状態を返す。終わっていれば結果（または失敗の理由）も入る。

    Args:
        job_id: ジョブの ID（開始の応答の ``id``）。

    Returns:
        ジョブの状態（``background_jobs.Job.snapshot``）。

    Raises:
        HTTPException: ジョブが無い、または記録の期限が切れた場合（HTTP 404）。
    """
    return _job_or_404(background_jobs.default_manager().get(job_id)).snapshot()


@router.post("/api/jobs/{job_id}/cancel")
async def api_job_cancel(job_id: str):
    """ジョブのキャンセルを頼む。何度呼んでもよい。

    すぐ止まるとは限らない。応答の ``state`` が ``running`` で ``cancel_requested`` が true なら、
    止まるのを待っているところ。実際に止まると ``cancelled`` になる。
    すでに終わっているジョブには何もせず、その状態を返す。

    Args:
        job_id: ジョブの ID。

    Returns:
        ジョブの状態（結果は入れない）。

    Raises:
        HTTPException: ジョブが無い場合（HTTP 404）。
    """
    return _job_or_404(background_jobs.default_manager().cancel(job_id)).snapshot(include_result=False)
