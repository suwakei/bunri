"""LLM（Claude）の接続設定

API キーの持ち方を一箇所で決める。

- キーは **呼び出しのたびに** 読む。import 時に固めると、起動後に設定したキーを拾えない
  （デスクトップアプリでは、利用者が設定画面でキーを入れる）
- キーは配布物に同梱しない。入手先は次の順:
  1. 設定画面から渡されたキー（このプロセスのメモリにだけ持つ。ファイルには書かない）
  2. 環境変数 ``ANTHROPIC_API_KEY``、無ければ ``CLAUDE_API_KEY``（開発時。配布物では、アプリが
     OS のキーチェーンから読んで起動時に渡す）
  3. リポジトリ直下の ``.env``（開発時だけ。同じ 2 つの名前を読む。配布物には ``.env`` が無い）
  4. Anthropic SDK の既定の解決（``ant auth login`` のプロファイルなど）
- キーをログや API の応答に出さない
"""
import os
import threading
from pathlib import Path

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


# API キーとして読む名前（先に在るものを使う）
_KEY_NAMES = ("ANTHROPIC_API_KEY", "CLAUDE_API_KEY")


def _dotenv_path():
    """開発時に読む ``.env`` の場所（リポジトリ直下）を返す。"""
    return Path(__file__).resolve().parent.parent / ".env"


def _read_dotenv(path=None):
    """``.env`` から API キーを読む（無ければ None）。

    読むのは ``_KEY_NAMES`` の行だけ。``KEY=値`` の形で、値を囲む引用符と ``export`` は外す。
    ファイルが無い・読めないときは None（開発時の便宜なので、失敗を表に出さない）。

    Args:
        path: ``.env`` のパス。None ならリポジトリ直下。

    Returns:
        str | None: 見つかったキー。
    """
    path = Path(path) if path is not None else _dotenv_path()
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return None
    found = {}
    for line in lines:
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, _, value = line.partition("=")
        name = name.strip()
        if name.startswith("export "):
            name = name[len("export "):].strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        if name in _KEY_NAMES and value:
            found.setdefault(name, value)
    for name in _KEY_NAMES:
        if name in found:
            return found[name]
    return None


def _env_key():
    """環境変数から API キーを読む（無ければ None）。"""
    for name in _KEY_NAMES:
        value = os.environ.get(name)
        if value:
            return value
    return None


def api_key():
    """いま使う API キーを返す（無ければ None）。呼び出しのたびに解決する。

    Returns:
        str | None: 設定画面から渡されたキー、無ければ環境変数、それも無ければ ``.env``。
    """
    with _lock:
        if _override_key:
            return _override_key
    return _env_key() or _read_dotenv()


def key_source():
    """API キーの入手先を返す（キーそのものは返さない）。

    Returns:
        str: ``"settings"``（設定画面）、``"env"``（環境変数か ``.env``）、``"none"``（どれも無い）。
        ``"none"`` でも、SDK の既定の解決（``ant auth login`` など）で通ることはある。
    """
    with _lock:
        if _override_key:
            return "settings"
    if _env_key() or os.environ.get("ANTHROPIC_AUTH_TOKEN") or _read_dotenv():
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
