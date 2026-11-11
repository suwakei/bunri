"""楽曲カルテ API のテスト（/api/chart, /api/chart/regrid, /api/chart/{id}）"""
import io
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT))

from httpx import AsyncClient, ASGITransport
from web.api import app


@pytest.fixture
def client():
    """ASGI 直結の非同期クライアント"""
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


@pytest.fixture
def song_upload(chord_song):
    """合成音源をアップロード用のバイト列にしたもの"""
    path, truth = chord_song
    return Path(path).read_bytes(), truth


@pytest.fixture(autouse=True)
def isolated_results(tmp_path, monkeypatch):
    """results/ を汚さないよう、カルテの保存先を一時ディレクトリへ向ける"""
    import audio_utils

    def fake_results_dir(*parts):
        target = tmp_path.joinpath("results", *parts)
        target.mkdir(parents=True, exist_ok=True)
        return target

    monkeypatch.setattr(audio_utils, "results_dir", fake_results_dir)
    return tmp_path


async def _post_chart(client, data, filename="api_song.wav", **form):
    """/api/chart にアップロードするヘルパ"""
    return await client.post(
        "/api/chart",
        files={"file": (filename, io.BytesIO(data), "audio/wav")},
        data={k: str(v) for k, v in form.items()},
    )


@pytest.mark.asyncio
async def test_カルテを生成できる(client, song_upload):
    """音声をアップロードするとカルテ・ピーク・用語辞書が返る"""
    data, truth = song_upload
    async with client:
        resp = await _post_chart(client, data)

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["chart_id"] == "api_song"
    for key in ("chart", "peaks", "glossary"):
        assert key in body

    chart = body["chart"]
    assert chart["key"]["tonic"] == truth["tonic"]
    assert chart["grid"]["bpm"] == pytest.approx(truth["bpm"], abs=3.0)
    assert chart["chords"]


@pytest.mark.asyncio
async def test_ピークはカルテ本体に含まれない(client, song_upload):
    """波形ピークはレスポンスには入るがカルテには入らない

    カルテはプロンプトキャッシュのプレフィックスになるため、
    サイズの大きいピーク配列を混ぜてはいけない。
    """
    data, _ = song_upload
    async with client:
        body = (await _post_chart(client, data)).json()

    assert "peaks" not in body["chart"]
    assert len(body["peaks"]["min"]) == len(body["peaks"]["max"]) > 0


@pytest.mark.asyncio
async def test_用語辞書が言語マップで返る(client, song_upload):
    """ツールチップ用の用語辞書が言語マップ構造で返る"""
    data, _ = song_upload
    async with client:
        glossary = (await _post_chart(client, data)).json()["glossary"]

    assert "bpm" in glossary
    assert "ja" in glossary["bpm"]


@pytest.mark.asyncio
async def test_グリッドを指定して生成できる(client, song_upload):
    """BPM・オフセット・拍子を指定するとその値が使われる"""
    data, _ = song_upload
    async with client:
        resp = await _post_chart(client, data, bpm=120, downbeat_offset=0.35, beats_per_bar=3)

    grid = resp.json()["chart"]["grid"]
    assert grid["bpm"] == 120.0
    assert grid["bpm_source"] == "user"
    assert grid["time_signature"] == [3, 4]


@pytest.mark.asyncio
async def test_カルテを読み戻せる(client, song_upload):
    """生成したカルテを chart_id で読み出せる（バイト一致）"""
    import song_chart

    data, _ = song_upload
    async with client:
        created = (await _post_chart(client, data)).json()
        loaded = await client.get(f"/api/chart/{created['chart_id']}")

    assert loaded.status_code == 200
    assert song_chart.to_canonical_json(loaded.json()["chart"]) == \
        song_chart.to_canonical_json(created["chart"])


@pytest.mark.asyncio
async def test_regridでグリッドを補正できる(client, song_upload):
    """再アップロードなしでグリッドを補正して再計算できる"""
    data, _ = song_upload
    async with client:
        chart_id = (await _post_chart(client, data)).json()["chart_id"]
        resp = await client.post("/api/chart/regrid", data={
            "chart_id": chart_id, "bpm": "100", "downbeat_offset": "0.5", "beats_per_bar": "4",
        })

    assert resp.status_code == 200, resp.text
    grid = resp.json()["chart"]["grid"]
    assert grid["bpm"] == 100.0
    assert grid["bpm_source"] == "user"
    assert grid["user_confirmed"] is True


@pytest.mark.asyncio
async def test_regridの結果が保存される(client, song_upload):
    """補正結果が `.bunri` に書き戻される"""
    data, _ = song_upload
    async with client:
        chart_id = (await _post_chart(client, data)).json()["chart_id"]
        await client.post("/api/chart/regrid", data={
            "chart_id": chart_id, "bpm": "100", "downbeat_offset": "0.5", "beats_per_bar": "4",
        })
        reloaded = await client.get(f"/api/chart/{chart_id}")

    assert reloaded.json()["chart"]["grid"]["bpm"] == 100.0


@pytest.mark.asyncio
async def test_存在しないカルテは404(client):
    """未知の chart_id は 404 を返す"""
    async with client:
        assert (await client.get("/api/chart/存在しないID")).status_code == 404
        resp = await client.post("/api/chart/regrid", data={
            "chart_id": "存在しないID", "bpm": "120", "downbeat_offset": "0", "beats_per_bar": "4",
        })
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_パストラバーサルを拒否する(client):
    """chart_id にパス区切りを混ぜても results/charts の外へ出られない

    405 を許容しているのは、``.`` が URL 正規化で ``/api/chart/`` になり
    POST 専用ルートに当たるため。ハンドラに到達しないので安全な拒否。
    """
    async with client:
        for bad in ("../../etc/passwd", "..%2F..%2Fsecret", ".", "..", "%2e%2e%2fsecret"):
            resp = await client.get(f"/api/chart/{bad}")
            assert resp.status_code != 200, f"{bad} が通ってしまった"
            assert resp.status_code in (400, 404, 405), f"{bad}: 想定外の {resp.status_code}"


@pytest.mark.asyncio
async def test_無音でもエラーにせずunavailableを返す(client, silent_wav):
    """解析できない音源でも 500 にせず、理由つきのカルテを返す"""
    data = Path(silent_wav).read_bytes()
    async with client:
        resp = await _post_chart(client, data, filename="silence.wav")

    assert resp.status_code == 200, resp.text
    chart = resp.json()["chart"]
    assert chart["key"]["tonic"] is None
    assert chart["unavailable"]
