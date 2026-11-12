"""ブラウザを自動操作するテスト専用の API（わざと遅いジョブ）

進み具合のカード・キャンセル・2 つ目を断る（409）・画面を開き直したときのつなぎ直しを、
数分かかる本物の処理（音源分離など）を使わずに確かめるためのもの。

環境変数 ``BUNRI_E2E_HOOKS=1`` のときだけ ``web.api`` が読み込む（``web-ui/playwright.config.ts`` が付ける）。
既定では読み込まないので、デスクトップアプリの sidecar にも、開発用の起動にもこの API は無い。
"""
import time

from fastapi import APIRouter, HTTPException, Query

from web import job_routes

router = APIRouter()

# 数字（割合）を出すステージ。本物と同じく、ほかのステージは割合を出さない（docs/jobs.md）
_WITH_PROGRESS = {"separate", "separate_other", "transcribe"}


def _kinds():
    """種類ごとの、本物と同じ名前とステージを返す（画面の見た目を本物と同じ文で確かめられるように）。

    ``model`` のステージは、初回のダウンロードのときの表示名にする（その文の見え方を確かめるため）。
    """
    from demucs_progress import DOWNLOAD_LABEL
    from decompose import decompose_stages
    from separate import DEEP_SEPARATE_STAGES, SEPARATE_STAGES
    from song_chart import CHART_STAGES

    def first_run(stages):
        return [(key, DOWNLOAD_LABEL if key == "model" else label) for key, label in stages]

    chart = list(CHART_STAGES) + [("save", "カルテを保存しています")]
    return {
        "chart": ("楽曲カルテの作成", chart),
        "chart_regrid": ("カルテの再計算", chart),
        "decompose": ("パート分離と採譜", first_run(decompose_stages(detect_bpm=False))),
        "separate": ("パート分離", first_run(SEPARATE_STAGES)),
        "deep_separate": ("パート分離（6 パート）", first_run(DEEP_SEPARATE_STAGES)),
        "analyze": ("採譜", [("transcribe", "ノートを読み取っています")]),
    }


@router.post("/api/e2e/slow-job")
async def slow_job(
    kind: str = Query("chart"),
    seconds: float = Query(30.0, gt=0, le=600),
    filename: str = Query("e2e.wav"),
    fail: bool = Query(False),
):
    """わざと遅いジョブを始める（``?async=1`` と同じく、すぐに 202 を返す）。

    ステージを等分した時間で順に進み、``separate`` と ``transcribe`` では割合も出す。
    0.1 秒ごとにキャンセルを確かめるので、キャンセルするとすぐに止まる。

    Args:
        kind: ジョブの種類（本物と同じ名前・ステージになる）。
        seconds: 全体でかかる秒数。
        filename: 対象のファイル名（画面に出る）。
        fail: True なら、最後に失敗で終わる。

    Returns:
        ジョブの状態（202）。ほかのジョブが動いていれば 409（本物と同じ形）。

    Raises:
        HTTPException: 知らない種類の場合（HTTP 400）。
    """
    kinds = _kinds()
    if kind not in kinds:
        raise HTTPException(400, f"知らない種類です: {kind}")
    title, stages = kinds[kind]

    def task(job, _prepared):
        per_stage = seconds / len(stages)
        for key, _label in stages:
            job.enter_stage(key)
            ticks = max(1, int(per_stage / 0.1))
            for i in range(ticks):
                job.check_cancelled()
                if key in _WITH_PROGRESS:
                    job.set_progress(i / ticks)
                time.sleep(per_stage / ticks)
        if fail:
            raise HTTPException(500, "テスト用のジョブが失敗しました")
        return {"ok": True, "kind": kind, "filename": filename}

    return await job_routes.dispatch(
        kind, title=title, filename=filename, stages=stages,
        prepare=lambda: None, task=task, run_async=True,
    )
