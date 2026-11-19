"""別環境の BS-RoFormer-SW / MLX を、音量を変えずに比較する実験用入口。

アプリからは呼ばない。許諾未確認の重みは比較実験のみに使い、配布物に含めない。
依存と重みは事前に別環境へ用意する。この入口からダウンロードや pickle 読込は行わない。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time


CODE_REVISION = "2f55dca7441cf8b243f4937d28dfe3dc4d60a8d3"
WEIGHTS_REVISION = "679ec88c16a262170d617b02ee7f25da6dd137eb"
ARTIFACTS = {
    "model.safetensors": "f95907cd5bfdbc783c1cb32f6aafc49b8b6a598477a9d4a48b4f9191c5167707",
    "config.json": "386a86c2061536d2dca349943f1027f3ac5472ccb22b0e18bd528519b90f8931",
}
DEFAULT_ROOT = Path("/tmp/bunri-model-bench/roformer")


def verify_artifact(path: Path, expected_sha: str) -> None:
    """読み込む前にファイル全体のハッシュを照合する。"""
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while block := stream.read(1024 * 1024):
            digest.update(block)
    if digest.hexdigest() != expected_sha:
        raise ValueError(f"モデルファイルの SHA-256 が一致しません: {path.name}")


def chunk_starts(samples: int, chunk_size: int, hop: int) -> list[int]:
    """末尾まで覆う区間を作る。短い入力ではゼロ埋めして一度だけ推論する。"""
    if samples <= 0 or chunk_size <= 0 or not 0 < hop <= chunk_size:
        raise ValueError("音声長・チャンク長・刻みを正の対応する値で指定してください")
    last = max(0, samples - chunk_size)
    starts = list(range(0, last + 1, hop))
    if starts[-1] != last:
        starts.append(last)
    return starts


def run(input_path: Path, output_dir: Path, device: str, source_dir: Path, model_dir: Path) -> dict:
    """固定したコードと重みで分離し、float32 WAV と計測条件を残す。"""
    for name, digest in ARTIFACTS.items():
        verify_artifact(model_dir / name, digest)
    revision = subprocess.check_output(["git", "-C", str(source_dir), "rev-parse", "HEAD"], text=True).strip()
    if revision != CODE_REVISION:
        raise ValueError("比較用のコード revision が一致しません")
    if subprocess.run(["git", "-C", str(source_dir), "diff", "--quiet", "HEAD", "--"], check=False).returncode:
        raise ValueError("比較用のコードに未記録の変更があります")
    if output_dir.exists() and (any(output_dir.glob("*.wav")) or (output_dir / "metadata.json").exists()):
        raise FileExistsError("比較結果を上書きしないよう、空の出力先を指定してください")

    # 入力全体や出力のピークによる正規化をせず、モデルの振幅を直接評価する。
    os.environ["MLX_ENABLE_AMP"] = "0"
    os.environ["MLX_ENABLE_COMPILE"] = "0"
    os.environ["MLX_USE_FAST_SDP"] = "0" if device == "cpu" else "1"
    sys.path.insert(0, str(source_dir))
    import mlx.core as mx
    from importlib.metadata import version
    from mlx.utils import tree_flatten
    import numpy as np
    import soundfile as sf
    from scipy.signal import resample_poly
    from math import gcd
    from mlx_audio_separator.separator.models.roformer.loader import create_bs_roformer_mlx, convert_torch_to_mlx_weights

    mx.set_default_device(mx.cpu if device == "cpu" else mx.gpu)
    config = json.loads((model_dir / "config.json").read_text())
    stems = config["training"]["instruments"]
    sample_rate = int(config["audio"]["sample_rate"])
    audio, source_rate = sf.read(input_path, dtype="float32", always_2d=True)
    if not audio.size or not np.isfinite(audio).all() or audio.shape[1] not in (1, 2):
        raise ValueError("空でない有限のモノラルかステレオ音声を指定してください")
    if source_rate != sample_rate:
        divisor = gcd(source_rate, sample_rate)
        audio = resample_poly(audio, sample_rate // divisor, source_rate // divisor, axis=0).astype(np.float32)
    if audio.shape[1] == 1:
        audio = np.repeat(audio, 2, axis=1)
    load_start = time.perf_counter()
    model = create_bs_roformer_mlx(config)
    # 配布 safetensors は PyTorch の名前を持つ。数値は安全な配列のまま、公式の対応表で変換する。
    weights = convert_torch_to_mlx_weights(mx.load(str(model_dir / "model.safetensors")))
    expected = dict(tree_flatten(model.parameters()))
    if set(expected) != set(weights) or any(expected[key].shape != weights[key].shape for key in expected):
        raise ValueError("変換後の重みがモデルの全パラメータと一致しません")
    model.load_weights(list(weights.items()), strict=True)
    model.eval()
    mx.eval(model.parameters())
    load_seconds = time.perf_counter() - load_start

    chunk_size = int(config["audio"]["chunk_size"])
    overlap = int(config["inference"]["num_overlap"])
    hop = chunk_size // overlap
    starts = chunk_starts(len(audio), chunk_size, hop)
    window = np.hamming(chunk_size).astype(np.float32)
    result = np.zeros((len(stems), 2, len(audio)), dtype=np.float32)
    counter = np.zeros(len(audio), dtype=np.float32)
    infer_start = time.perf_counter()
    for start in starts:
        size = min(chunk_size, len(audio) - start)
        chunk = np.zeros((1, 2, chunk_size), dtype=np.float32)
        chunk[0, :, :size] = audio[start:start + size].T
        estimate = model(mx.array(chunk))
        mx.eval(estimate)
        values = np.asarray(estimate, dtype=np.float32)[0]
        if values.shape != (len(stems), 2, chunk_size) or not np.isfinite(values).all():
            raise ValueError("推論結果の形または値が不正です")
        result[:, :, start:start + size] += values[:, :, :size] * window[:size]
        counter[start:start + size] += window[:size]
    result /= counter[None, None, :]
    separation_seconds = time.perf_counter() - infer_start
    output_dir.mkdir(parents=True, exist_ok=True)
    for stem, values in zip(stems, result):
        sf.write(output_dir / f"{stem}.wav", values.T, sample_rate, subtype="FLOAT")
    metadata = {
        "model": "BS-RoFormer-SW", "runtime": "MLX", "device": "cpu" if device == "cpu" else "mlx",
        "runtime_version": version("mlx"), "code_repository": "https://github.com/ssmall256/mlx-audio-separator",
        "weights_repository": "https://huggingface.co/ssmall256/mlx-audio-separator",
        "code_revision": revision, "weights_revision": WEIGHTS_REVISION,
        "weights_sha256": ARTIFACTS["model.safetensors"], "config_sha256": ARTIFACTS["config.json"],
        "weights_license": "unknown; 実験のみ、アプリ配布対象外",
        "load_seconds": load_seconds, "separation_seconds": separation_seconds,
        "sample_rate": sample_rate, "stems": stems, "chunk_size": chunk_size,
        "num_overlap": overlap, "batch_size": 1, "normalization": "none", "dtype": "float32",
        "note": "6パート。4パート比較時は other+guitar+piano を合算する。",
    }
    (output_dir / "metadata.json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n")
    return metadata


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--device", choices=("cpu", "mlx"), default="mlx")
    parser.add_argument("--source-dir", type=Path, default=DEFAULT_ROOT / "source")
    parser.add_argument("--model-dir", type=Path, default=DEFAULT_ROOT / "models" / "bs-roformer-sw")
    args = parser.parse_args()
    metadata = run(args.input, args.output_dir, args.device, args.source_dir, args.model_dir)
    print(json.dumps(metadata, ensure_ascii=False))


if __name__ == "__main__":
    main()
