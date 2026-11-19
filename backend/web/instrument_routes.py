"""楽器の素材の準備。取得は利用者が頼んだときだけジョブとして始める。"""
from fastapi import APIRouter, HTTPException, Query

import instruments
from web.job_routes import dispatch

router = APIRouter()


@router.get("/api/instruments/piano")
async def piano_status():
    """ピアノの準備状況と容量・出典を返す。取得は行わない。"""
    return instruments.piano_status()


@router.post("/api/instruments/piano/install")
async def install_piano(run_async: bool = Query(False, alias="async")):
    """ピアノの素材を取得する。進み具合と中止は既存のジョブ API を使う。"""
    def task(job, _prepared):
        try:
            return instruments.install_piano(job=job)
        except instruments.InstrumentUnavailableError as error:
            raise HTTPException(503, str(error)) from error

    return await dispatch(
        "instrument_install", title="ピアノ音源の準備", filename="グランドピアノ",
        stages=[("download", "ピアノ音源をダウンロードしています"),
                ("verify", "音源のファイルを確かめています"),
                ("extract", "音源を展開しています")],
        prepare=lambda: None, task=task, run_async=run_async,
    )
