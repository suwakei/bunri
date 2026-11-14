"""データ置き場の解決とファイル名検証のテスト

- ``BUNRI_DATA_DIR`` で uploads/ results/ projects/ soundfonts/ を差し替えられること
- ``../`` などで置き場の外を指すファイル名が、アップロードでもダウンロードでも拒否されること
"""
import io
from pathlib import Path

import numpy as np
import pytest
from httpx import ASGITransport, AsyncClient

import audio_utils
from web.api import app

REPO_ROOT = Path(__file__).resolve().parent.parent.parent

# 置き場の外を指す名前。どれも受け付けてはいけない
BAD_NAMES = ["../evil.wav", "..", ".", "", "a/b.wav", "..\\evil.wav", "/etc/passwd", "x\x00.wav"]


@pytest.fixture
def data_dir(tmp_path, monkeypatch):
    """データ置き場を一時ディレクトリへ向ける"""
    monkeypatch.setenv("BUNRI_DATA_DIR", str(tmp_path))
    return tmp_path


@pytest.fixture
def client():
    """同期 fixture で AsyncClient を返す（各テスト内でそのまま await する）"""
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


@pytest.fixture
def wav_bytes():
    """0.2 秒のサイン波の WAV バイト列"""
    import soundfile as sf

    sr = 44100
    t = np.linspace(0, 0.2, sr // 5, dtype=np.float32)
    buf = io.BytesIO()
    sf.write(buf, 0.3 * np.sin(2 * np.pi * 440 * t), sr, format="WAV")
    return buf.getvalue()


class TestDataDir:
    def test_無指定ならリポジトリ直下(self, monkeypatch):
        monkeypatch.delenv("BUNRI_DATA_DIR", raising=False)
        assert audio_utils.data_dir() == REPO_ROOT
        assert audio_utils.soundfonts_dir() == REPO_ROOT / "soundfonts"

    def test_環境変数で差し替えられる(self, data_dir):
        assert audio_utils.data_dir() == data_dir.resolve()
        assert audio_utils.uploads_dir() == data_dir.resolve() / "uploads"
        assert audio_utils.results_dir("charts") == data_dir.resolve() / "results" / "charts"
        assert audio_utils.projects_dir() == data_dir.resolve() / "projects"
        assert audio_utils.soundfonts_dir() == data_dir.resolve() / "soundfonts"
        assert audio_utils.models_dir() == data_dir.resolve() / "models"

    def test_書き込み先は作成され_soundfontsは作成されない(self, data_dir):
        assert audio_utils.uploads_dir().is_dir()
        assert audio_utils.results_dir("a", "b").is_dir()
        assert audio_utils.projects_dir().is_dir()
        assert not audio_utils.soundfonts_dir().exists()

    def test_save_tmpは差し替えた置き場に書く(self, data_dir, sample_audio_mono):
        data, sr = sample_audio_mono
        path = Path(audio_utils.save_tmp(data, sr, prefix="t"))
        assert path.is_file()
        assert path.parent == data_dir.resolve() / "results" / "edited"

    def test_soundfontのパスも置き場に従う(self, data_dir):
        import synth

        assert synth.soundfont_path() == data_dir.resolve() / "soundfonts" / synth.SOUNDFONT_NAME


class TestSafeJoin:
    def test_普通の名前は直下に解決される(self, tmp_path):
        assert audio_utils.safe_join(tmp_path, "曲 (1).wav") == tmp_path.resolve() / "曲 (1).wav"

    @pytest.mark.parametrize("name", BAD_NAMES + [None])
    def test_外を指す名前は拒否(self, tmp_path, name):
        with pytest.raises(ValueError):
            audio_utils.safe_join(tmp_path, name)

    def test_シンボリックリンク経由で外に出る名前は拒否(self, tmp_path):
        outside = tmp_path / "outside.txt"
        outside.write_text("secret")
        base = tmp_path / "base"
        base.mkdir()
        (base / "link.txt").symlink_to(outside)
        with pytest.raises(ValueError):
            audio_utils.safe_join(base, "link.txt")


class TestApiのファイル名検証:
    @pytest.mark.asyncio
    async def test_普通の名前のアップロードは置き場に保存される(self, client, data_dir, wav_bytes):
        resp = await client.post("/api/wav/info", files={"file": ("ok.wav", wav_bytes, "audio/wav")})
        assert resp.status_code == 200
        assert (data_dir / "uploads" / "ok.wav").is_file()

    @pytest.mark.asyncio
    @pytest.mark.parametrize("name", ["../evil.wav", "..", "a/b.wav", "..\\evil.wav", "/tmp/evil.wav"])
    async def test_外を指す名前のアップロードは拒否(self, client, data_dir, wav_bytes, name):
        resp = await client.post("/api/wav/info", files={"file": (name, wav_bytes, "audio/wav")})
        assert resp.status_code == 400
        # 置き場の中にも外にも、何も書かれていないこと
        assert not (data_dir / "evil.wav").exists()
        assert list((data_dir / "uploads").iterdir()) == []

    @pytest.mark.asyncio
    async def test_ダウンロードは置き場のファイルを返す(self, client, data_dir):
        (audio_utils.results_dir() / "out.wav").write_bytes(b"RIFFdata")
        resp = await client.get("/api/download/out.wav")
        assert resp.status_code == 200
        assert resp.content == b"RIFFdata"

    @pytest.mark.asyncio
    @pytest.mark.parametrize("name", ["..", "%2e%2e", "..%2Fsecret.txt", "..%5Csecret.txt", "edited"])
    async def test_外を指す名前のダウンロードは返さない(self, client, data_dir, name):
        (data_dir / "secret.txt").write_text("secret")
        audio_utils.results_dir("edited")
        resp = await client.get(f"/api/download/{name}")
        assert resp.status_code in (400, 404)
        assert b"secret" not in resp.content

    @pytest.mark.asyncio
    @pytest.mark.parametrize("name", ["..", "..%2Fsecret.json", "..%5Csecret.json"])
    async def test_外を指す名前のプロジェクトは読めない(self, client, data_dir, name):
        (data_dir / "secret.json").write_text('{"secret": true}')
        resp = await client.get(f"/api/project/load/{name}")
        assert resp.status_code in (400, 404)
        assert b"secret" not in resp.content

    @pytest.mark.asyncio
    async def test_プロジェクトの保存と読み込みは置き場を使う(self, client, data_dir):
        resp = await client.post("/api/project/save", data={"data": '{"bpm": 120}'})
        name = resp.json()["filename"]
        assert (data_dir / "projects" / name).is_file()
        resp = await client.get(f"/api/project/load/{name}")
        assert resp.json() == {"bpm": 120}
