"""API の鍵（トークン）と CORS のテスト

- トークン無しは 401、ヘッダまたはクエリで正しいトークンを付ければ通る
- 許可した origin だけに CORS ヘッダが付く。preflight はトークン無しで通る
- ``BUNRI_TOKEN`` が無いとき（ブラウザ版）は何も足されない
"""
import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

import access_control

TOKEN = "s3cret-token"
ORIGIN = "tauri://localhost"


def _make_app():
    """検証用の小さなアプリ"""
    app = FastAPI()

    @app.get("/api/ping")
    async def ping():
        return {"ok": True}

    @app.post("/api/echo")
    async def echo(body: dict):
        return body

    return app


def _client(app):
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


@pytest.fixture
def locked():
    """トークン検証と CORS を足したアプリ"""
    app = _make_app()
    access_control.install(app, TOKEN, [ORIGIN])
    return _client(app)


class TestToken:
    @pytest.mark.asyncio
    async def test_トークン無しは401(self, locked):
        resp = await locked.get("/api/ping")
        assert resp.status_code == 401

    @pytest.mark.asyncio
    @pytest.mark.parametrize("bad", ["", "wrong", TOKEN + "x", TOKEN[:-1], "日本語"])
    async def test_違うトークンは401(self, locked, bad):
        resp = await locked.get("/api/ping", headers={"X-Bunri-Token": bad.encode("utf-8")})
        assert resp.status_code == 401
        resp = await locked.get("/api/ping", params={"token": bad})
        assert resp.status_code == 401

    @pytest.mark.asyncio
    async def test_ヘッダのトークンで通る(self, locked):
        resp = await locked.get("/api/ping", headers={"X-Bunri-Token": TOKEN})
        assert resp.status_code == 200
        assert resp.json() == {"ok": True}

    @pytest.mark.asyncio
    async def test_クエリのトークンで通る(self, locked):
        """<audio src> や <a download> はヘッダを付けられないので、クエリでも受け付ける"""
        resp = await locked.get("/api/ping", params={"token": TOKEN})
        assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_POSTもトークンが要る(self, locked):
        resp = await locked.post("/api/echo", json={"a": 1})
        assert resp.status_code == 401
        resp = await locked.post("/api/echo", json={"a": 1}, headers={"X-Bunri-Token": TOKEN})
        assert resp.json() == {"a": 1}

    @pytest.mark.asyncio
    async def test_存在しないパスもトークン無しなら401(self, locked):
        """トークン無しの相手に、どのパスが在るかを教えない"""
        resp = await locked.get("/api/nothing")
        assert resp.status_code == 401

    def test_空のトークンでは作れない(self):
        with pytest.raises(ValueError):
            access_control.TokenAuthMiddleware(_make_app(), "")


class TestCors:
    @pytest.mark.asyncio
    async def test_許可したoriginにはCORSヘッダが付く(self, locked):
        resp = await locked.get("/api/ping", headers={"Origin": ORIGIN, "X-Bunri-Token": TOKEN})
        assert resp.headers["access-control-allow-origin"] == ORIGIN

    @pytest.mark.asyncio
    async def test_他のoriginにはCORSヘッダが付かない(self, locked):
        resp = await locked.get("/api/ping", headers={"Origin": "https://evil.example", "X-Bunri-Token": TOKEN})
        assert "access-control-allow-origin" not in resp.headers

    @pytest.mark.asyncio
    async def test_preflightはトークン無しで通る(self, locked):
        resp = await locked.options("/api/echo", headers={
            "Origin": ORIGIN,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type,x-bunri-token",
        })
        assert resp.status_code == 200
        assert resp.headers["access-control-allow-origin"] == ORIGIN
        assert "x-bunri-token" in resp.headers["access-control-allow-headers"].lower()

    @pytest.mark.asyncio
    async def test_他のoriginのpreflightは通らない(self, locked):
        resp = await locked.options("/api/echo", headers={
            "Origin": "https://evil.example",
            "Access-Control-Request-Method": "POST",
        })
        assert resp.status_code == 400
        assert "access-control-allow-origin" not in resp.headers

    @pytest.mark.asyncio
    async def test_401の応答にもCORSヘッダが付く(self, locked):
        """画面側が「通信できない」ではなく 401 として扱えるように"""
        resp = await locked.get("/api/ping", headers={"Origin": ORIGIN})
        assert resp.status_code == 401
        assert resp.headers["access-control-allow-origin"] == ORIGIN


class TestInstallFromEnv:
    @pytest.mark.asyncio
    async def test_トークンが無ければ何も足さない(self, monkeypatch):
        """ブラウザ版（python run_web.py）の挙動を変えない"""
        monkeypatch.delenv("BUNRI_TOKEN", raising=False)
        app = _make_app()
        assert access_control.install_from_env(app) is False
        client = _client(app)
        resp = await client.get("/api/ping", headers={"Origin": "http://127.0.0.1:8000"})
        assert resp.status_code == 200
        assert "access-control-allow-origin" not in resp.headers

    @pytest.mark.asyncio
    async def test_環境変数から設定される(self, monkeypatch):
        monkeypatch.setenv("BUNRI_TOKEN", TOKEN)
        monkeypatch.setenv("BUNRI_ALLOWED_ORIGINS", f"{ORIGIN}, http://localhost:3000")
        app = _make_app()
        assert access_control.install_from_env(app) is True
        client = _client(app)
        assert (await client.get("/api/ping")).status_code == 401
        for origin in (ORIGIN, "http://localhost:3000"):
            resp = await client.get("/api/ping", headers={"Origin": origin, "X-Bunri-Token": TOKEN})
            assert resp.status_code == 200
            assert resp.headers["access-control-allow-origin"] == origin

    @pytest.mark.asyncio
    async def test_本物のアプリは既定でトークン不要(self):
        """テスト実行時は BUNRI_TOKEN が無いので、web.api の app は鍵なしのはず"""
        from web.api import app

        resp = await _client(app).get("/api/gm-instruments")
        assert resp.status_code == 200
