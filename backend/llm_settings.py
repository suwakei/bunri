"""LLM（Claude）の接続設定

API キーの持ち方を一箇所で決める。

- キーは **呼び出しのたびに** 読む。import 時に固めると、起動後に設定したキーを拾えない
  （デスクトップアプリでは、利用者が設定画面でキーを入れる）
- キーは配布物に同梱しない。入手先は次の順:
  1. 設定画面から渡されたキー（このプロセスのメモリにだけ持つ。ファイルには書かない）
  2. 環境変数 ``ANTHROPIC_API_KEY``（開発時。配布物では、アプリが
     OS のキーチェーンから読んで起動時に渡す）
  3. Anthropic SDK の既定の解決（``ant auth login`` のプロファイルなど）
- キーをログや API の応答に出さない
"""
import os
import threading

# 既定のモデル。環境変数 BUNRI_GUIDE_MODEL で差し替えられる
DEFAULT_MODEL = "claude-opus-5-5"

_lock = threading.Lock()
_override_key = None


def set_api_key(key):
    """設定画面から渡された API キーを、このプロセスのメモリに持つ。

    Args:
        key: API キー。前後の空白は落とす。

    Raises:
        ValueError: キーが空、または改行などの制御文字を含む場合。
    """
    global _override_key
    if not isinstance(key, str):
        raise ValueError("API キーが不正です")
    key = key.strip()
    if not key or any(ord(ch) < 0x20 or ord(ch) == 0x7F for ch in key):
        raise ValueError("API キーが不正です")
    with _lock:
        _override_key = key


def clear_api_key():
    """設定画面から渡された API キーを忘れる（環境変数のキーには触れない）。"""
    global _override_key
    with _lock:
        _override_key = None


def api_key():
    """いま使う API キーを返す（無ければ None）。呼び出しのたびに解決する。

    Returns:
        str | None: 設定画面から渡されたキー、無ければ環境変数 ``ANTHROPIC_API_KEY``。
    """
    with _lock:
        if _override_key:
            return _override_key
    return os.environ.get("ANTHROPIC_API_KEY") or None


def key_source():
    """API キーの入手先を返す（キーそのものは返さない）。

    Returns:
        str: ``"settings"``（設定画面）、``"env"``（環境変数）、``"none"``（どちらも無い）。
        ``"none"`` でも、SDK の既定の解決（``ant auth login`` など）で通ることはある。
    """
    with _lock:
        if _override_key:
            return "settings"
    if os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"):
        return "env"
    return "none"


def model():
    """再現ガイドに使うモデルの ID を返す。

    Returns:
        str: 環境変数 ``BUNRI_GUIDE_MODEL``、無ければ ``DEFAULT_MODEL``。
    """
    return os.environ.get("BUNRI_GUIDE_MODEL") or DEFAULT_MODEL


def status():
    """設定の状態を返す（API の応答用。キーそのものは含めない）。

    Returns:
        dict: ``{"has_key": bool, "key_source": str, "model": str}``。
    """
    source = key_source()
    return {"has_key": source != "none", "key_source": source, "model": model()}


def make_client():
    """Anthropic のクライアントを作る。

    設定画面か環境変数のキーが在ればそれを使い、無ければ SDK の既定の解決に任せる。

    Returns:
        anthropic.Anthropic: クライアント。
    """
    import anthropic

    key = api_key()
    if key:
        return anthropic.Anthropic(api_key=key)
    return anthropic.Anthropic()
