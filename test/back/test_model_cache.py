"""音源分離モデルのキャッシュ確認（model_cache）のテスト"""
import pytest
from httpx import ASGITransport, AsyncClient

import model_cache


@pytest.fixture
def remote(tmp_path):
    """demucs のモデル定義を模したディレクトリ"""
    remote = tmp_path / "remote"
    remote.mkdir()
    (remote / "files.txt").write_text(
        "# MDX Models\n0d19c1c6-0f06f20e.th\nhybrid_transformer/955717e8-8726e21a.th\n"
        "f7e0c4bc-ba3fe64a.th\nd12395a8-e57c48e6.th\n",
        encoding="utf-8",
    )
    (remote / "one.yaml").write_text("models: ['955717e8']\n", encoding="utf-8")
    (remote / "bag.yaml").write_text("models: ['f7e0c4bc', 'd12395a8']\nweights: [[1.0], [1.0]]\n", encoding="utf-8")
    (remote / "broken.yaml").write_text("models: ['ffffffff']\n", encoding="utf-8")
    return remote


@pytest.fixture
def hf_hub(tmp_path, monkeypatch):
    """HuggingFace hub のキャッシュ置き場を一時ディレクトリへ向ける（空）"""
    hub = tmp_path / "hf" / "hub"
    hub.mkdir(parents=True)
    monkeypatch.setenv("HF_HUB_CACHE", str(hub))
    return hub


@pytest.fixture
def torch_home(tmp_path, monkeypatch, hf_hub):
    """torch のキャッシュ置き場を一時ディレクトリへ向ける（HuggingFace 側は空）"""
    home = tmp_path / "torch"
    monkeypatch.setenv("TORCH_HOME", str(home))
    checkpoints = home / "hub" / "checkpoints"
    checkpoints.mkdir(parents=True)
    return checkpoints


class TestCheckpointsDir:
    def test_TORCH_HOMEに従う(self, torch_home):
        assert model_cache.checkpoints_dir() == torch_home

    def test_無指定ならホームのキャッシュ(self, monkeypatch):
        monkeypatch.delenv("TORCH_HOME", raising=False)
        monkeypatch.delenv("XDG_CACHE_HOME", raising=False)
        assert model_cache.checkpoints_dir().parts[-4:] == (".cache", "torch", "hub", "checkpoints")


class TestHfHubDir:
    def test_HF_HUB_CACHEに従う(self, hf_hub):
        assert model_cache.hf_hub_dir() == hf_hub

    def test_HF_HOMEの下のhub(self, monkeypatch, tmp_path):
        monkeypatch.delenv("HF_HUB_CACHE", raising=False)
        monkeypatch.setenv("HF_HOME", str(tmp_path / "hfhome"))
        assert model_cache.hf_hub_dir() == tmp_path / "hfhome" / "hub"

    def test_無指定ならホームのキャッシュ(self, monkeypatch):
        for key in ("HF_HUB_CACHE", "HF_HOME", "XDG_CACHE_HOME"):
            monkeypatch.delenv(key, raising=False)
        assert model_cache.hf_hub_dir().parts[-3:] == (".cache", "huggingface", "hub")


class TestModelFiles:
    def test_署名を読む(self, remote):
        assert model_cache.model_signatures("one", remote) == ["955717e8"]
        assert model_cache.model_signatures("bag", remote) == ["f7e0c4bc", "d12395a8"]

    def test_署名からファイル名を引く(self, remote):
        assert model_cache.model_files("one", remote) == ["955717e8-8726e21a.th"]

    def test_複数のモデルを束ねたものは全部のファイルが要る(self, remote):
        assert model_cache.model_files("bag", remote) == ["f7e0c4bc-ba3fe64a.th", "d12395a8-e57c48e6.th"]

    @pytest.mark.parametrize("name", ["unknown", "broken", "", "../one", "one.yaml", None])
    def test_知らない名前はKeyError(self, remote, name):
        with pytest.raises(KeyError):
            model_cache.model_files(name, remote)

    @pytest.mark.parametrize("name", ["unknown", "", "../one", "one.yaml", None])
    def test_知らない名前の状態もKeyError(self, remote, torch_home, name):
        with pytest.raises(KeyError):
            model_cache.model_status(name, remote)

    @pytest.mark.parametrize("name", model_cache.KNOWN_MODELS)
    def test_本物のdemucsの定義から引ける(self, name):
        files = model_cache.model_files(name)
        assert files and all(f.endswith(".th") for f in files)


class TestModelStatus:
    def test_ファイルが無ければ未キャッシュ(self, remote, torch_home):
        assert model_cache.model_status("bag", remote) == {"model": "bag", "cached": False, "missing": 2}

    def test_一部だけ在っても未キャッシュ(self, remote, torch_home):
        (torch_home / "f7e0c4bc-ba3fe64a.th").write_bytes(b"x")
        assert model_cache.model_status("bag", remote)["missing"] == 1

    def test_全部在ればキャッシュ済み(self, remote, torch_home):
        for name in ("f7e0c4bc-ba3fe64a.th", "d12395a8-e57c48e6.th"):
            (torch_home / name).write_bytes(b"x")
        assert model_cache.model_status("bag", remote) == {"model": "bag", "cached": True, "missing": 0}


    def _hf_snapshot(self, hf_hub, name, signatures):
        """HuggingFace hub のキャッシュに、モデルのスナップショットを模して置く"""
        snapshot = hf_hub / "models--someone--SomeRepo" / "snapshots" / "abc123"
        snapshot.mkdir(parents=True, exist_ok=True)
        (snapshot / f"{name}.yaml").write_text("models: []\n", encoding="utf-8")
        for sig in signatures:
            (snapshot / f"{sig}.safetensors").write_bytes(b"x")

    def test_HuggingFaceのキャッシュに揃っていればキャッシュ済み(self, remote, torch_home, hf_hub):
        """Demucs 4.1 はまず HuggingFace hub から取る。torch.hub 側に無くても揃っていればよい"""
        self._hf_snapshot(hf_hub, "bag", ["f7e0c4bc", "d12395a8"])
        assert model_cache.model_status("bag", remote) == {"model": "bag", "cached": True, "missing": 0}

    def test_HuggingFaceのキャッシュが一部だけなら未キャッシュ(self, remote, torch_home, hf_hub):
        self._hf_snapshot(hf_hub, "bag", ["f7e0c4bc"])
        assert model_cache.model_status("bag", remote) == {"model": "bag", "cached": False, "missing": 1}

    def test_別のモデルのスナップショットは数えない(self, remote, torch_home, hf_hub):
        self._hf_snapshot(hf_hub, "one", ["f7e0c4bc", "d12395a8"])
        assert model_cache.model_status("bag", remote)["cached"] is False


class TestApi:
    @pytest.fixture
    def client(self):
        from web.api import app

        return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")

    @pytest.mark.asyncio
    async def test_状態を返す(self, client, torch_home):
        resp = await client.get("/api/models/htdemucs/status")
        assert resp.status_code == 200
        assert resp.json() == {"model": "htdemucs", "cached": False, "missing": 1}

    @pytest.mark.asyncio
    async def test_知らないモデルは404(self, client):
        resp = await client.get("/api/models/nope/status")
        assert resp.status_code == 404
