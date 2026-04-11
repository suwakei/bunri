"""FastAPI API エンドポイントのテスト"""
import sys
from pathlib import Path
import pytest
import numpy as np

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT))

from httpx import AsyncClient, ASGITransport
from web.api import app


@pytest.fixture
def wav_bytes():
    """テスト用WAVバイト列を生成"""
    import soundfile as sf
    import io
    sr = 44100
    t = np.linspace(0, 0.5, sr // 2, dtype=np.float32)
    data = 0.3 * np.sin(2 * np.pi * 440 * t)
    buf = io.BytesIO()
    sf.write(buf, data, sr, format='WAV')
    buf.seek(0)
    return buf.read()


@pytest.fixture
def client():
    """同期 fixture で AsyncClient を返す（各テスト内で async with を使う）"""
    transport = ASGITransport(app=app)
    return AsyncClient(transport=transport, base_url="http://test")


@pytest.mark.asyncio
async def test_ルートページ(client):
    resp = await client.get("/")
    assert resp.status_code == 200


@pytest.mark.asyncio
async def test_gm_instruments(client):
    resp = await client.get("/api/gm-instruments")
    assert resp.status_code == 200
    data = resp.json()
    assert isinstance(data, list)
    assert len(data) > 0
    assert "program" in data[0]
    assert "name" in data[0]


@pytest.mark.asyncio
async def test_synth_note(client):
    resp = await client.post("/api/synth/note", data={
        "note": "A", "octave": "4", "duration": "0.3",
        "waveform": "sine", "volume": "0.5",
        "attack": "0.01", "decay": "0.1", "sustain": "0.6", "release": "0.2",
    })
    assert resp.status_code == 200
    assert resp.headers["content-type"] == "audio/wav"
    assert len(resp.content) > 44  # WAVヘッダ以上


@pytest.mark.asyncio
async def test_synth_drum(client):
    resp = await client.post("/api/synth/drum", data={
        "pattern": "8ビート", "bpm": "120", "bars": "1", "volume": "0.5",
    })
    assert resp.status_code == 200
    assert len(resp.content) > 44


@pytest.mark.asyncio
async def test_synth_sequence(client):
    import json
    notes = [{"note": "C", "octave": 4, "step": 0, "length": 4}]
    resp = await client.post("/api/synth/sequence", data={
        "notes_json": json.dumps(notes), "bpm": "120",
        "waveform": "sine", "volume": "0.5",
        "attack": "0.01", "decay": "0.1", "sustain": "0.6", "release": "0.2",
        "instrument": "", "gm_program": "",
    })
    assert resp.status_code == 200
    assert len(resp.content) > 44


@pytest.mark.asyncio
async def test_metronome(client):
    resp = await client.post("/api/metronome", data={
        "bpm": "120", "beats_per_bar": "4", "bars": "1", "volume": "0.5",
    })
    assert resp.status_code == 200
    assert len(resp.content) > 44


@pytest.mark.asyncio
async def test_edit_trim(client, wav_bytes):
    resp = await client.post("/api/edit/trim",
        files={"file": ("test.wav", wav_bytes, "audio/wav")},
        data={"params": '{"start": 0.0, "end": 0.3}'},
    )
    assert resp.status_code == 200
    assert len(resp.content) > 44


@pytest.mark.asyncio
async def test_effects_normalize(client, wav_bytes):
    resp = await client.post("/api/effects/normalize",
        files={"file": ("test.wav", wav_bytes, "audio/wav")},
        data={"params": "{}"},
    )
    assert resp.status_code == 200
    assert len(resp.content) > 44


@pytest.mark.asyncio
async def test_effects_eq(client, wav_bytes):
    resp = await client.post("/api/effects/eq",
        files={"file": ("test.wav", wav_bytes, "audio/wav")},
        data={"params": '{"low": 3, "mid": 0, "high": -2}'},
    )
    assert resp.status_code == 200


@pytest.mark.asyncio
async def test_effects_reverb(client, wav_bytes):
    resp = await client.post("/api/effects/reverb",
        files={"file": ("test.wav", wav_bytes, "audio/wav")},
        data={"params": '{"room_size": 0.5, "wet": 0.3}'},
    )
    assert resp.status_code == 200


@pytest.mark.asyncio
async def test_effects_unknown(client, wav_bytes):
    resp = await client.post("/api/effects/unknown_effect",
        files={"file": ("test.wav", wav_bytes, "audio/wav")},
        data={"params": "{}"},
    )
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_project_save_and_list(client):
    import json
    project = {"bpm": 120, "tracks": [], "automation": {}}
    resp = await client.post("/api/project/save", data={"data": json.dumps(project)})
    assert resp.status_code == 200
    result = resp.json()
    assert "filename" in result

    resp = await client.get("/api/project/list")
    assert resp.status_code == 200
    files = resp.json()
    assert isinstance(files, list)
    assert len(files) > 0


@pytest.mark.asyncio
async def test_download_not_found(client):
    resp = await client.get("/api/download/nonexistent_file.wav")
    assert resp.status_code == 404
