"""SubRoformerとSCNetの固定した重みを、データ置き場へ安全に取得する。"""
import hashlib
import os

MODELS = {
    "subroformer": {
        "file": "subroformer-perceptual-c0ac06e4.safetensors",
        "size": 207349784,
        "sha256": "c0ac06e4a16ce7e765ea6622b7d58bfa58957a03cab0fc42b15387a399c6c177",
        "url": "https://huggingface.co/archimickey/SubRoformer/resolve/391ad82f0db325724fcefd40850d51ae27a9c115/checkpoints/subroformer_base_4stem_1400000_ema_perceptual_finetuned_200000_fp16.safetensors",
    },
    "scnet": {
        "file": "scnet-small-98228931.onnx",
        "size": 12900277,
        "sha256": "98228931494151762a1c4ab1ec7899a894b1f81fd4a509921a9d2f9bacc50845",
        "url": "https://huggingface.co/square-zero-labs/scnet/resolve/af9bf78fdf676109a67211b32a3b54a1069acd40/scnet.int8.onnx",
    },
}


class ModelUnavailableError(RuntimeError):
    """モデルを取得・検証できなかったときに、利用者へ伝える文を持つ。"""


def model_path(name):
    """モデルごとに固定した保存先を返す。"""
    from audio_utils import models_dir
    return models_dir() / MODELS[name]["file"]


def partial_path(name):
    """強制キャンセル時に親が削除するダウンロード途中の保存先。"""
    path = model_path(name)
    return path.with_name(path.name + ".part")


def is_cached(name):
    """軽い状態問い合わせではサイズだけを見る。使用前は必ずSHAを照合する。"""
    path = model_path(name)
    return path.is_file() and path.stat().st_size == MODELS[name]["size"]


def model_status(name):
    """既存のモデル状態APIと同じ形へ、初回取得量を加えて返す。"""
    cached = is_cached(name)
    return {"model": name, "cached": cached, "missing": 0 if cached else 1, "download_bytes": MODELS[name]["size"]}


def _sha256(path):
    """大きな重みをまとめてメモリへ置かずに検証する。"""
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def ensure_model(name, on_bytes=None, fetch=None):
    """子プロセス内で取得し、サイズとSHAが一致したときだけ原子的に配置する。

    通常のキャンセルでは親がこの子プロセスを止め、partial_pathを消す。
    完了済みの重みは、採譜や分離をキャンセルしても次回のために残す。
    """
    from stem_models import _http_fetch

    spec = MODELS[name]
    path = model_path(name)
    if is_cached(name) and _sha256(path) == spec["sha256"]:
        return path
    part = partial_path(name)

    def progress(done):
        if done > spec["size"]:
            raise ModelUnavailableError("分離モデルのサイズが想定より大きいため、取得を止めました。")
        if on_bytes is not None:
            on_bytes(done)

    try:
        if fetch is None:
            _http_fetch(spec["url"], part, on_bytes=progress)
        else:
            fetch(spec["url"], part, progress)
        if part.stat().st_size != spec["size"] or _sha256(part) != spec["sha256"]:
            raise ModelUnavailableError("取得した分離モデルが想定の内容と一致しません。通信を確かめて、もう一度実行してください。")
        os.replace(part, path)
    except BaseException as error:
        part.unlink(missing_ok=True)
        if isinstance(error, ModelUnavailableError) or not isinstance(error, Exception):
            raise
        raise ModelUnavailableError("分離モデルをダウンロードできませんでした。ネットワークの接続を確かめて、もう一度実行してください。") from error
    return path
