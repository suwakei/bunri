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

# 既定のモデル。環境変数 BUNRI_GUIDE_MODEL が在れば、すべての呼び出しがそのモデルに固定される
DEFAULT_MODEL = "claude-haiku-5-5"

# 選べるモデル（段階 → モデル ID）。依頼ごとに、ルーター（``model_router``）がこの中から選ぶ。
# 画面から受け取るモデル ID も、ここに在るもの（と固定のモデル）だけを通す
MODELS = {
    "haiku": "claude-haiku-5-5",
    "sonnet": "claude-sonnet-5-5",
    "opus": "claude-opus-5-5",
}

# 強い順。保存済みのガイドと説明をモデルを問わず探すとき、この順で優先する
STRENGTH_ORDER = ("opus", "sonnet", "haiku")

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


def fixed_model():
    """環境変数 ``BUNRI_GUIDE_MODEL`` で固定されたモデルの ID を返す（固定されていなければ None）。

    呼び出しのたびに読む（import 時に固めない）。固定されているときは、ルーターを呼ばず、
    画面がモデルを指定しても、このモデルを使う。

    Returns:
        str | None: 固定のモデル ID。
    """
    value = (os.environ.get("BUNRI_GUIDE_MODEL") or "").strip()
    return value or None


def model():
    """モデルを指定しない呼び出しに使うモデルの ID を返す。

    Returns:
        str: 環境変数 ``BUNRI_GUIDE_MODEL``、無ければ ``DEFAULT_MODEL``。
    """
    return fixed_model() or DEFAULT_MODEL


def tier_of(model_id):
    """モデル ID の段階（``"haiku"`` ``"sonnet"`` ``"opus"``）を返す（表に無ければ None）。"""
    for tier, known in MODELS.items():
        if model_id == known:
            return tier
    return None


def validate_model(model_id):
    """画面から受け取ったモデル ID を確かめる。

    通すのは ``MODELS`` のモデル ID と、``BUNRI_GUIDE_MODEL`` で固定されたモデルだけ。
    指定が無い（None か空の文字列）なら None を返す。

    Args:
        model_id: 受け取った値。

    Returns:
        str | None: 確かめたモデル ID。指定が無ければ None。

    Raises:
        ValueError: 知らないモデル、または文字列でない場合。
    """
    if model_id is None or model_id == "":
        return None
    if not isinstance(model_id, str) or (model_id not in MODELS.values() and model_id != fixed_model()):
        names = "、".join(MODELS.values())
        raise ValueError(f"model は {names} のどれかで指定してください")
    return model_id


def resolve_model(model_id=None):
    """呼び出しに使うモデルを決める。

    ``BUNRI_GUIDE_MODEL`` で固定されていれば、それ。そうでなければ、指定されたモデル（確かめてから）、
    指定が無ければ ``DEFAULT_MODEL``。

    Args:
        model_id: 画面から受け取ったモデル ID（None なら指定なし）。

    Returns:
        str: 使うモデル ID。

    Raises:
        ValueError: 知らないモデルを指定された場合（固定されていても、確かめは行う）。
    """
    requested = validate_model(model_id)
    return fixed_model() or requested or DEFAULT_MODEL


def lookup_models():
    """保存済みのガイドと説明を探すときのモデルの並び（強いものが先）を返す。

    ``MODELS`` を強い順に並べ、固定のモデルが表に無ければ最後に足す。

    Returns:
        list[str]: モデル ID のリスト。
    """
    order = [MODELS[tier] for tier in STRENGTH_ORDER]
    fixed = fixed_model()
    if fixed and fixed not in order:
        order.append(fixed)
    return order


def status():
    """設定の状態を返す（API の応答用。キーそのものは含めない）。

    Returns:
        dict: ``{"has_key": bool, "key_source": str, "model": str}``。``model`` は、モデルを指定しない
        呼び出しのモデル（固定されていれば固定のモデル）。依頼ごとのモデルは、ルーターが選ぶ。
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
