"""追加の分離モデル（stem_models）と、ドラムの細分化（separate）のテスト

本物のモデルも Demucs も動かさない。ダウンロードと Demucs の起動は差し替える。
"""
import hashlib
import subprocess

import numpy as np
import pytest
import soundfile as sf
from httpx import ASGITransport, AsyncClient

import separate
import stem_models

PAYLOAD = b"fake-model-bytes" * 64


@pytest.fixture
def data_dir(tmp_path, monkeypatch):
    """データ置き場を一時ディレクトリへ向ける"""
    monkeypatch.setenv("BUNRI_DATA_DIR", str(tmp_path))
    return tmp_path


@pytest.fixture
def fake_model(monkeypatch, data_dir):
    """小さな偽のモデルを 1 つ定義する（本物は 160 MB 在るので使わない）"""
    spec = {
        "file": "fake.safetensors",
        "sha256": hashlib.sha256(PAYLOAD).hexdigest(),
        "size": len(PAYLOAD),
        "stems": {"bombo": "drums_kick", "redoblante": "drums_snare", "toms": "drums_toms", "platillos": "drums_cymbals"},
    }
    monkeypatch.setitem(stem_models.ADDON_MODELS, "drumsep", spec)
    return spec


def _fetch_ok(url, dest):
    with open(dest, "wb") as f:
        f.write(PAYLOAD)


class TestEnsureModel:
    def test_無ければダウンロードして置く(self, fake_model, data_dir):
        calls = []

        def fetch(url, dest):
            calls.append(url)
            _fetch_ok(url, dest)

        path = stem_models.ensure_model("drumsep", fetch=fetch)
        assert path == data_dir / "models" / "fake.safetensors"
        assert path.read_bytes() == PAYLOAD
        assert calls == [stem_models.DEFAULT_BASE_URL + "/fake.safetensors"]
        assert not list(path.parent.glob("*.part"))

    def test_在ればダウンロードしない(self, fake_model):
        stem_models.ensure_model("drumsep", fetch=_fetch_ok)

        def fetch(url, dest):
            raise AssertionError("2 回目は取りに行かないはず")

        assert stem_models.ensure_model("drumsep", fetch=fetch).is_file()

    def test_ハッシュが合わなければ置かずに失敗する(self, fake_model):
        def fetch(url, dest):
            with open(dest, "wb") as f:
                f.write(b"x" * len(PAYLOAD))

        with pytest.raises(stem_models.ModelUnavailableError, match="一致しません"):
            stem_models.ensure_model("drumsep", fetch=fetch)
        path = stem_models.model_path("drumsep")
        assert not path.exists()
        assert not list(path.parent.glob("*.part"))

    def test_ダウンロードの失敗は利用者に見せられる文になる(self, fake_model):
        def fetch(url, dest):
            raise OSError("no route")

        with pytest.raises(stem_models.ModelUnavailableError, match="ダウンロードできません"):
            stem_models.ensure_model("drumsep", fetch=fetch)
        assert not stem_models.is_cached("drumsep")

    def test_途中で切れたファイルは在ることにしない(self, fake_model):
        path = stem_models.model_path("drumsep")
        path.write_bytes(PAYLOAD[:10])
        assert not stem_models.is_cached("drumsep")
        assert stem_models.model_status("drumsep") == {"model": "drumsep", "cached": False, "missing": 1}

    def test_配布元は環境変数で差し替えられる(self, fake_model, monkeypatch):
        monkeypatch.setenv("BUNRI_MODEL_BASE_URL", "http://127.0.0.1:9/m/")
        assert stem_models.model_url("drumsep") == "http://127.0.0.1:9/m/fake.safetensors"

    def test_知らない名前はKeyError(self, data_dir):
        with pytest.raises(KeyError):
            stem_models.ensure_model("nope")

    def test_本物の定義は形がそろっている(self):
        spec = stem_models.ADDON_MODELS["drumsep"]
        assert spec["file"].endswith(".safetensors")
        assert len(spec["sha256"]) == 64 and int(spec["sha256"], 16) >= 0
        assert spec["size"] > 0
        for key in spec["stems"].values():
            assert key in separate.STEM_LABELS


def _write_wav(path, level):
    """0.2 秒の WAV を書く。level が 0 なら無音"""
    path.parent.mkdir(parents=True, exist_ok=True)
    t = np.linspace(0, 0.2, 4410, dtype=np.float32)
    sf.write(str(path), level * np.sin(2 * np.pi * 220 * t), 22050)
    return path


class TestSeparateDrums:
    def test_モデルのステム名をbunriの名前に直して返す(self, fake_model, tmp_path, monkeypatch):
        drums = _write_wav(tmp_path / "in" / "drums.wav", 0.5)
        out = tmp_path / "out"
        monkeypatch.setattr(stem_models, "ensure_model", lambda name, fetch=None: tmp_path / "m.safetensors")
        seen = {}

        def fake_run(cmd, **kwargs):
            seen["cmd"] = cmd
            for stem in ("bombo", "redoblante", "toms"):
                _write_wav(out / "drumsep" / "drums" / f"{stem}.wav", 0.3)
            return subprocess.CompletedProcess(cmd, 0)

        monkeypatch.setattr(separate.subprocess, "run", fake_run)
        paths = separate.separate_drums(str(drums), output_dir=str(out))
        # platillos は書かれなかったので、結果に入らない
        assert set(paths) == {"drums_kick", "drums_snare", "drums_toms"}
        assert paths["drums_kick"].name == "bombo.wav"
        cmd = seen["cmd"]
        assert cmd[cmd.index("--bunri-model-file") + 1] == str(tmp_path / "m.safetensors")
        assert cmd[cmd.index("-n") + 1] == "drumsep"
        assert cmd[-1] == str(drums)

    def test_Demucsが失敗したらRuntimeError(self, fake_model, tmp_path, monkeypatch):
        drums = _write_wav(tmp_path / "drums.wav", 0.5)
        monkeypatch.setattr(stem_models, "ensure_model", lambda name, fetch=None: tmp_path / "m.safetensors")
        monkeypatch.setattr(separate.subprocess, "run", lambda cmd, **kw: subprocess.CompletedProcess(cmd, 1))
        with pytest.raises(RuntimeError):
            separate.separate_drums(str(drums), output_dir=str(tmp_path / "out"))

    def test_入力が無ければFileNotFoundError(self, fake_model, tmp_path):
        with pytest.raises(FileNotFoundError):
            separate.separate_drums(str(tmp_path / "none.wav"))


class TestDeepSeparateWithDrums:
    @pytest.fixture
    def stage1(self, tmp_path, monkeypatch):
        """第1段（htdemucs_6s）を差し替える。other は無音にして、再分離が走らないようにする"""
        def fake_separate_audio(input_path, output_dir, model, **kwargs):
            base = tmp_path / "s1"
            return {
                "vocals": _write_wav(base / "vocals.wav", 0.5),
                "drums": _write_wav(base / "drums.wav", 0.5),
                "bass": _write_wav(base / "bass.wav", 0.5),
                "other": _write_wav(base / "other.wav", 0.0),
            }

        monkeypatch.setattr(separate, "separate_audio", fake_separate_audio)

    def test_ドラムの部位がdrumsの直後に並び無音の部位は落ちる(self, stage1, tmp_path, monkeypatch):
        monkeypatch.setattr(stem_models, "ensure_model", lambda name, fetch=None: tmp_path / "m.safetensors")

        def fake_separate_drums(drums_path, output_dir, **kwargs):
            base = tmp_path / "s2"
            return {
                "drums_kick": _write_wav(base / "bombo.wav", 0.5),
                "drums_snare": _write_wav(base / "redoblante.wav", 0.5),
                "drums_toms": _write_wav(base / "toms.wav", 0.0),
                "drums_cymbals": _write_wav(base / "platillos.wav", 0.5),
            }

        monkeypatch.setattr(separate, "separate_drums", fake_separate_drums)
        result = separate.deep_separate("song.wav", output_dir=str(tmp_path / "out"), split_drums=True)
        assert list(result) == ["vocals", "drums", "drums_kick", "drums_snare", "drums_cymbals", "bass"]

    def test_既定ではドラムを分けずモデルも取りに行かない(self, stage1, tmp_path, monkeypatch):
        def boom(*args, **kwargs):
            raise AssertionError("呼ばれないはず")

        monkeypatch.setattr(stem_models, "ensure_model", boom)
        monkeypatch.setattr(separate, "separate_drums", boom)
        result = separate.deep_separate("song.wav", output_dir=str(tmp_path / "out"))
        assert list(result) == ["vocals", "drums", "bass"]

    def test_モデルを用意できなければ分離を始める前に失敗する(self, tmp_path, monkeypatch):
        def no_model(name, fetch=None):
            raise stem_models.ModelUnavailableError("だめ")

        def boom(*args, **kwargs):
            raise AssertionError("第1段は走らないはず")

        monkeypatch.setattr(stem_models, "ensure_model", no_model)
        monkeypatch.setattr(separate, "separate_audio", boom)
        with pytest.raises(stem_models.ModelUnavailableError):
            separate.deep_separate("song.wav", output_dir=str(tmp_path / "out"), split_drums=True)


class TestRunnerArgs:
    def test_モデルのファイルの指定を抜き取る(self):
        import _demucs_runner as runner

        path, rest = runner._take_model_file(["--out", "o", "--bunri-model-file", "/m.safetensors", "-n", "drumsep", "a.wav"])
        assert path == "/m.safetensors"
        assert rest == ["--out", "o", "-n", "drumsep", "a.wav"]

    def test_指定が無ければそのまま(self):
        import _demucs_runner as runner

        assert runner._take_model_file(["-n", "htdemucs", "a.wav"]) == (None, ["-n", "htdemucs", "a.wav"])

    def test_パスが無ければ止まる(self):
        import _demucs_runner as runner

        with pytest.raises(SystemExit):
            runner._take_model_file(["a.wav", "--bunri-model-file"])


class TestApi:
    @pytest.fixture
    def client(self):
        from web.api import app

        return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")

    @pytest.mark.asyncio
    async def test_追加のモデルの状態を返す(self, fake_model, client):
        async with client:
            resp = await client.get("/api/models/drumsep/status")
            assert resp.status_code == 200
            assert resp.json() == {"model": "drumsep", "cached": False, "missing": 1}
            stem_models.ensure_model("drumsep", fetch=_fetch_ok)
            resp = await client.get("/api/models/drumsep/status")
            assert resp.json()["cached"] is True

    @pytest.mark.asyncio
    async def test_深層分離はsplit_drumsを渡しラベルを付けて返す(self, data_dir, tmp_path, client, monkeypatch):
        seen = {}

        def fake_deep(input_path, **kwargs):
            seen.update(kwargs)
            return {"drums": _write_wav(tmp_path / "d.wav", 0.5), "drums_kick": _write_wav(tmp_path / "k.wav", 0.5)}

        monkeypatch.setattr(separate, "deep_separate", fake_deep)
        wav = _write_wav(tmp_path / "song.wav", 0.5).read_bytes()
        async with client:
            resp = await client.post(
                "/api/deep-separate",
                files={"file": ("song.wav", wav, "audio/wav")},
                data={"depth": "1", "split_drums": "true"},
            )
        assert resp.status_code == 200
        assert seen["split_drums"] is True
        assert resp.json()["drums_kick"]["label"] == "ドラム → キック"

    @pytest.mark.asyncio
    async def test_モデルを用意できなければ503と理由を返す(self, data_dir, tmp_path, client, monkeypatch):
        def fake_deep(input_path, **kwargs):
            raise stem_models.ModelUnavailableError("追加モデルをダウンロードできませんでした")

        monkeypatch.setattr(separate, "deep_separate", fake_deep)
        wav = _write_wav(tmp_path / "song.wav", 0.5).read_bytes()
        async with client:
            resp = await client.post("/api/deep-separate", files={"file": ("song.wav", wav, "audio/wav")}, data={"split_drums": "true"})
        assert resp.status_code == 503
        assert "ダウンロードできません" in resp.json()["detail"]
