"""API の鍵（アクセストークン）と CORS の設定

デスクトップアプリでは、画面（WebView）と API（この FastAPI）が別の origin になる。
API は 127.0.0.1 で待っていても、同じ PC のブラウザで開いた別サイトから叩けてしまうので、
アプリが起動ごとに作る乱数のトークンを知っている相手だけに応答する。

- トークンは環境変数 ``BUNRI_TOKEN`` で受け取る（引数だと ``ps`` で見えるため）
- 許可する origin は環境変数 ``BUNRI_ALLOWED_ORIGINS``（カンマ区切り）で受け取る
- ``BUNRI_TOKEN`` が無いとき（ブラウザ版 = ``python run_web.py``）は何も足さない。
  挙動は今までと同じ
"""
import hmac
import os
from urllib.parse import parse_qs

TOKEN_HEADER = "x-bunri-token"
TOKEN_QUERY = "token"


class TokenAuthMiddleware:
    """トークンが一致しないリクエストに 401 を返す ASGI ミドルウェア。

    トークンはヘッダ ``X-Bunri-Token`` で受け取る。``<audio src>`` や
    ``<a href download>`` のようにヘッダを付けられない経路のために、
    クエリ ``?token=`` でも受け付ける。

    preflight（OPTIONS）にはブラウザがヘッダを付けないので素通しする。
    preflight 自体は外側の CORSMiddleware が応答する。
    """

    def __init__(self, app, token):
        """
        Args:
            app: 内側の ASGI アプリ。
            token: 受け付けるトークン（空でない文字列）。
        """
        if not token:
            raise ValueError("token は空にできません")
        self.app = app
        self._token = token.encode("utf-8")

    def _presented(self, scope):
        """リクエストに付いているトークンを取り出す（無ければ None）。"""
        for name, value in scope.get("headers", []):
            if name == TOKEN_HEADER.encode("ascii"):
                return value
        values = parse_qs(scope.get("query_string", b"").decode("latin-1")).get(TOKEN_QUERY)
        if values:
            return values[0].encode("utf-8")
        return None

    async def __call__(self, scope, receive, send):
        if scope["type"] not in ("http", "websocket"):
            await self.app(scope, receive, send)
            return
        if scope["type"] == "http" and scope.get("method") == "OPTIONS":
            await self.app(scope, receive, send)
            return

        presented = self._presented(scope)
        if presented is not None and hmac.compare_digest(presented, self._token):
            await self.app(scope, receive, send)
            return

        if scope["type"] == "websocket":
            await send({"type": "websocket.close", "code": 1008})
            return
        body = b'{"detail":"unauthorized"}'
        await send({
            "type": "http.response.start",
            "status": 401,
            "headers": [
                (b"content-type", b"application/json"),
                (b"content-length", str(len(body)).encode("ascii")),
            ],
        })
        await send({"type": "http.response.body", "body": body})


def install(app, token, allowed_origins):
    """FastAPI アプリにトークン検証と CORS を足す。

    CORS を後から足す（= 一番外側に置く）。401 の応答にも CORS ヘッダが付き、
    画面側が「通信できない」ではなく「401」として扱えるようにするため。

    Args:
        app: ``fastapi.FastAPI`` のインスタンス。
        token: 受け付けるトークン。
        allowed_origins: 許可する origin のリスト（例: ``["tauri://localhost"]``）。
    """
    from fastapi.middleware.cors import CORSMiddleware

    app.add_middleware(TokenAuthMiddleware, token=token)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(allowed_origins),
        allow_methods=["*"],
        allow_headers=["*"],
        expose_headers=["Content-Disposition"],
    )


def install_from_env(app):
    """環境変数に従ってトークン検証と CORS を足す。

    ``BUNRI_TOKEN`` が無ければ何もしない（ブラウザ版の挙動を変えない）。

    Args:
        app: ``fastapi.FastAPI`` のインスタンス。

    Returns:
        bool: トークン検証を有効にしたら True。
    """
    token = os.environ.get("BUNRI_TOKEN", "")
    if not token:
        return False
    origins = [o.strip() for o in os.environ.get("BUNRI_ALLOWED_ORIGINS", "").split(",") if o.strip()]
    install(app, token, origins)
    return True
