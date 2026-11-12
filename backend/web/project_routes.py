"""プロジェクトの保存と読み込み（`.bunri` v2）と、データの整理の API。

中身は ``project_store``。ここは HTTP との橋渡しだけ。sidecar が読み書きするのはデータ置き場の中だけ
（利用者が選んだ場所へ写すのは、デスクトップ版では Rust。docs/desktop-architecture.md「プロジェクトのファイル」）。

保存はジョブの仕組み（``?async=1``）を使わない。重い処理は同時に 1 つなので、パート分離の最中に
保存できなくなるため。代わりに、FastAPI のスレッドで動かす（画面は待たずに操作できる）。
3 分の曲と 6 パートで 1〜2 秒（docs/song-chart-design.md「プロジェクトの保存」に測った値）。
"""
from fastapi import APIRouter, Body, HTTPException, Query, Request
from fastapi.responses import Response

import project_store

router = APIRouter()

# 1 つの音声として受け取る大きさの上限（2 GB。WAV で 3 時間ほど）。これを超えるものは保存しない
MAX_AUDIO_BYTES = 2 * 1024 * 1024 * 1024


def _http(e):
    return HTTPException(e.status, e.detail)


@router.post("/api/project/audio/missing")
def api_project_audio_missing(payload: dict = Body(...)):
    """保存に要る音声のうち、まだ受け取っていないものを返す（送るのはそれだけでよい）。

    Args:
        payload: ``{"base": いま開いている写しの名前か null, "hashes": [音声のハッシュ]}``。

    Returns:
        ``{"missing": [ハッシュ]}``。
    """
    try:
        return {"missing": project_store.missing_audio(payload.get("base"), payload.get("hashes") or [])}
    except project_store.ProjectError as e:
        raise _http(e)


@router.put("/api/project/audio/{hash_}")
async def api_project_audio_put(hash_: str, request: Request, name: str = Query("")):
    """音声を 1 つ受け取って、保存まで預かる。本文は音声の元のバイト列そのもの。

    Args:
        hash_: 元のバイト列の SHA-256（画面が計算する）。中身と合わなければ 400。
        request: 本文を読むためのリクエスト。
        name: 元のファイル名（取り出すときの拡張子に使う）。

    Returns:
        ``{"ok": True}``。
    """
    chunks, size = [], 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > MAX_AUDIO_BYTES:
            raise HTTPException(413, "音声が大きすぎて保存できません")
        chunks.append(chunk)
    try:
        project_store.stage_audio(hash_, b"".join(chunks), name or None)
    except project_store.ProjectError as e:
        raise _http(e)
    return {"ok": True}


@router.post("/api/project/document")
def api_project_document(payload: dict = Body(...)):
    """プロジェクトの文書を、新しい作業用の写し（``work/<token>.bunri``）に書く。

    Args:
        payload: ``{"base": いま開いている写しの名前か null, "document": プロジェクトの文書}``。

    Returns:
        ``{"token", "size_bytes", "audio_count", "duration_sec"}``。利用者の選んだ場所へ写すのは呼び出し側。
    """
    try:
        return project_store.save_document(payload.get("document"), base=payload.get("base"))
    except project_store.ProjectError as e:
        raise _http(e)


@router.post("/api/project/open/{token}")
def api_project_open(token: str):
    """作業用の写しを開いて、プロジェクトの文書を返す。カルテの解析も Claude の呼び出しもしない。

    Args:
        token: 写しの名前（Rust か ``/api/project/library/open`` が作ったもの）。

    Returns:
        プロジェクトの文書（``token`` ``audioBase`` ``restored`` 付き）。
    """
    try:
        return project_store.open_document(token)
    except project_store.ProjectError as e:
        raise _http(e)


@router.get("/api/project/{token}/audio/{hash_}")
def api_project_audio_get(token: str, hash_: str):
    """開いたプロジェクトの音声を 1 つ返す（FLAC で持っているものは WAV に戻す）。"""
    try:
        data, media, _ext = project_store.read_audio(token, hash_)
    except project_store.ProjectError as e:
        raise _http(e)
    return Response(content=data, media_type=media)


@router.get("/api/project/library")
def api_project_library():
    """データ置き場の ``projects/`` に在るプロジェクトと、以前の形式の一覧（開発用のブラウザ起動と、以前の形式を開くため）。

    Returns:
        ``{"projects": [{"file", "name", "kind", "modified", "size_bytes"}]}``。
    """
    return {"projects": project_store.library_list()}


@router.post("/api/project/library/save")
def api_project_library_save(payload: dict = Body(...)):
    """作業用の写しを ``projects/`` に置く（開発用のブラウザ起動の「保存」。デスクトップ版は Rust が写す）。

    Args:
        payload: ``{"token", "name"}``（新しく置く）か ``{"token", "file"}``（上書きする）。

    Returns:
        ``{"file", "name"}``。
    """
    try:
        return project_store.library_save(payload.get("token"), payload.get("name"), payload.get("file"))
    except project_store.ProjectError as e:
        raise _http(e)


@router.post("/api/project/library/open")
def api_project_library_open(payload: dict = Body(...)):
    """``projects/`` のプロジェクトを開く。`.bunri` なら ``{"token"}``、以前の形式なら ``{"document"}``。"""
    try:
        return project_store.library_open(payload.get("file"))
    except project_store.ProjectError as e:
        raise _http(e)


@router.get("/api/storage")
def api_storage():
    """データ置き場の使用量（分類ごと）。「データの整理」の画面が出す。"""
    return project_store.storage_usage()


@router.post("/api/storage/cleanup")
def api_storage_cleanup(payload: dict = Body(default={})):
    """作業用の一時ファイルを消す（何を消して何を残すかは ``project_store.cleanup``）。

    動いている処理（ジョブ）が在るときは断る（書いている途中のファイルを消さないため）。

    Args:
        payload: ``{"keep_tokens": [いま開いている写し], "keep_charts": [いまのカルテの ID]}``。

    Returns:
        ``{"removed_files", "freed_bytes", "usage": 整理した後の使用量}``。
    """
    import background_jobs

    if background_jobs.default_manager().active() is not None:
        raise HTTPException(409, "処理が動いているあいだは整理できません。終わってからもう一度押してください")
    result = project_store.cleanup(payload.get("keep_tokens") or [], payload.get("keep_charts") or [])
    return {**result, "usage": project_store.storage_usage()}
