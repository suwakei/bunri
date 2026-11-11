"""音源分離モデル（Demucs）が手元に在るかを調べる

Demucs のモデルは、初めて使うときにネットワークから落ちてくる（1 モデルあたり数十〜数百 MB）。
その間は処理が止まって見えるので、画面が「初回はダウンロードが入る」と伝えられるよう、
モデルのファイルがキャッシュ済みかどうかを返す。

Demucs 4.1 はモデルをまず HuggingFace hub から取り（``<署名>.safetensors``）、取れなければ
従来の置き場から取る（torch.hub のキャッシュに ``<署名>-<ハッシュ>.th``）。どちらかに
揃っていれば「手元に在る」と判断する。

torch や demucs を import すると数秒かかるため、ここではファイルを見るだけにしている。
"""
import os
import re
from pathlib import Path

# 画面から選べるモデル（separate.py / deep_separate.py が使うもの）
KNOWN_MODELS = ("htdemucs", "htdemucs_ft", "htdemucs_6s")


def checkpoints_dir():
    """torch がモデルを保存するディレクトリを返す。

    torch.hub と同じ決め方: ``$TORCH_HOME/hub/checkpoints``。``TORCH_HOME`` が無ければ
    ``$XDG_CACHE_HOME/torch``、それも無ければ ``~/.cache/torch`` を使う。

    Returns:
        pathlib.Path: チェックポイントの保存先。存在の保証はしない。
    """
    torch_home = os.environ.get("TORCH_HOME")
    if not torch_home:
        cache_home = os.environ.get("XDG_CACHE_HOME") or os.path.join("~", ".cache")
        torch_home = os.path.join(cache_home, "torch")
    return Path(torch_home).expanduser() / "hub" / "checkpoints"


def hf_hub_dir():
    """HuggingFace hub のキャッシュのディレクトリを返す。

    huggingface_hub と同じ決め方: ``$HF_HUB_CACHE``、無ければ ``$HF_HOME/hub``、
    それも無ければ ``$XDG_CACHE_HOME/huggingface/hub``（既定は ``~/.cache/huggingface/hub``）。

    Returns:
        pathlib.Path: キャッシュの置き場。存在の保証はしない。
    """
    hub_cache = os.environ.get("HF_HUB_CACHE")
    if hub_cache:
        return Path(hub_cache).expanduser()
    hf_home = os.environ.get("HF_HOME")
    if not hf_home:
        cache_home = os.environ.get("XDG_CACHE_HOME") or os.path.join("~", ".cache")
        hf_home = os.path.join(cache_home, "huggingface")
    return Path(hf_home).expanduser() / "hub"


def _remote_dir():
    """demucs パッケージが持つモデル定義のディレクトリを返す（import はしない）。"""
    import importlib.util

    spec = importlib.util.find_spec("demucs")
    if spec is None or not spec.submodule_search_locations:
        return None
    return Path(list(spec.submodule_search_locations)[0]) / "remote"


def model_signatures(name, remote_dir=None):
    """モデルを構成する署名（8 桁の 16 進数）を返す。

    demucs は ``remote/<モデル名>.yaml`` の ``models:`` に署名を並べている。
    1 つのモデル名が複数の署名を束ねていることがある（``htdemucs_ft`` は 4 つ）。

    Args:
        name: モデル名（例: ``"htdemucs"``）。
        remote_dir: モデル定義のディレクトリ。None なら demucs パッケージから探す。

    Returns:
        list[str]: 署名のリスト（例: ``["955717e8"]``）。

    Raises:
        KeyError: 知らないモデル名、または定義が見つからない場合。
    """
    if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9_]+", name):
        raise KeyError(name)
    remote_dir = Path(remote_dir) if remote_dir is not None else _remote_dir()
    if remote_dir is None:
        raise KeyError(name)
    yaml_path = remote_dir / f"{name}.yaml"
    if not yaml_path.is_file():
        raise KeyError(name)
    models_line = next(
        (line for line in yaml_path.read_text(encoding="utf-8").splitlines() if line.strip().startswith("models:")),
        "",
    )
    signatures = re.findall(r"[0-9a-f]{8}", models_line)
    if not signatures:
        raise KeyError(name)
    return signatures


def model_files(name, remote_dir=None):
    """従来の置き場から取る場合の、チェックポイントのファイル名を返す。

    ``remote/files.txt`` に署名ごとのファイル名（``<署名>-<ハッシュ>.th``）が載っている。

    Args:
        name: モデル名。
        remote_dir: モデル定義のディレクトリ。None なら demucs パッケージから探す。

    Returns:
        list[str]: ファイル名のリスト（例: ``["955717e8-8726e21a.th"]``）。

    Raises:
        KeyError: 知らないモデル名、または署名に対応するファイル名が無い場合。
    """
    signatures = model_signatures(name, remote_dir)
    remote_dir = Path(remote_dir) if remote_dir is not None else _remote_dir()
    files_path = remote_dir / "files.txt"
    if not files_path.is_file():
        raise KeyError(name)
    by_signature = {}
    for line in files_path.read_text(encoding="utf-8").splitlines():
        filename = line.strip().rsplit("/", 1)[-1]
        if filename.endswith(".th"):
            by_signature[filename.split("-", 1)[0]] = filename
    if any(sig not in by_signature for sig in signatures):
        raise KeyError(name)
    return [by_signature[sig] for sig in signatures]


def _missing_in_hf(name, signatures):
    """HuggingFace hub のキャッシュに足りない署名の数を返す。

    リポジトリ名は demucs の版で変わりうるので決め打ちせず、キャッシュの中から
    ``<モデル名>.yaml`` を持つスナップショットを探し、その隣の ``<署名>.safetensors`` を数える。
    """
    best = len(signatures)
    hub = hf_hub_dir()
    if not hub.is_dir():
        return best
    for definition in hub.glob(f"models--*/snapshots/*/{name}.yaml"):
        missing = sum(1 for sig in signatures if not (definition.parent / f"{sig}.safetensors").is_file())
        best = min(best, missing)
    return best


def model_status(name, remote_dir=None):
    """モデルが手元に揃っているかを返す。

    Args:
        name: モデル名。
        remote_dir: モデル定義のディレクトリ（テスト用）。

    Returns:
        dict: ``{"model": 名前, "cached": 全部が在るか, "missing": 足りない数}``。
        ``missing`` は、2 つの置き場のうち足りない数が少ないほうの値。

    Raises:
        KeyError: 知らないモデル名の場合。
    """
    signatures = model_signatures(name, remote_dir)
    missing = _missing_in_hf(name, signatures)
    if missing:
        try:
            directory = checkpoints_dir()
            legacy = sum(1 for f in model_files(name, remote_dir) if not (directory / f).is_file())
            missing = min(missing, legacy)
        except KeyError:
            pass
    return {"model": name, "cached": missing == 0, "missing": missing}
