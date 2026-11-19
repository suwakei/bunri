"""固定した SubRoformer を別環境で比較するための CLI。通常のアプリからは呼ばない。"""
import argparse
import hashlib
import json
import resource
import subprocess
import sys
import time
from contextlib import ExitStack
from pathlib import Path

CODE_REVISION = "bf4e35aff7905c8cd43b8d7365ffd1bcc7d1df02"
MODEL_REVISION = "391ad82f0db325724fcefd40850d51ae27a9c115"
MODEL_REPO = "archimickey/SubRoformer"
WEIGHTS_FILE = "checkpoints/subroformer_base_4stem_1400000_ema_perceptual_finetuned_200000_fp16.safetensors"
WEIGHTS_SHA256 = "c0ac06e4a16ce7e765ea6622b7d58bfa58957a03cab0fc42b15387a399c6c177"
COREML_DIRECTORY = "coreml/base-4stem-perceptual-200k-fp16-v1"
# 固定した HF revision の Git blob / LFS SHA-256。取得した実体をロード前に照合する。
COREML_HASHES = {
    "config.yaml": ("git", "223418185dcca033ca72cefa3de6e972c73440bd"),
    "dsp.safetensors": ("sha256", "a9e5391dbb48895735b97a182209b3b1ec1f9bd42280530bbc5ad0fc91716f8e"),
    "mask.mlmodelc/analytics/coremldata.bin": ("sha256", "0631a70cd3b1281d89f621966189342436405735a7d5ae34b03203c42d9062a7"),
    "mask.mlmodelc/coremldata.bin": ("sha256", "392976e6ceecb1b34ed0fa4dcf359675820f53cab2f0980cf860941faee7cfb2"),
    "mask.mlmodelc/model.mil": ("git", "800df8e3c1189f2825776be6c4d5bca6ddc5992e"),
    "mask.mlmodelc/weights/weight.bin": ("sha256", "aa37ceccd43d1f0f6d4d6918e2a322b242824fb9c8809e03ea483ef55125343c"),
}
STEMS = ("vocals", "bass", "drums", "other")


def file_hash(path, algorithm="sha256"):
    """大きなモデルを一括でメモリへ読まずにハッシュを計算する。"""
    digest = hashlib.sha1() if algorithm == "git" else hashlib.sha256()
    if algorithm == "git":
        digest.update(f"blob {path.stat().st_size}\0".encode())
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def verify_file(path, expected, algorithm="sha256"):
    """重みや Core ML のファイルの実体を、推論の前に照合する。"""
    actual = file_hash(Path(path), algorithm)
    if actual != expected:
        raise ValueError("比較用モデルのハッシュが一致しません")
    return actual


def verify_source(source_dir):
    """外部コードを指定したコミットと、変更の無い作業ツリーに固定する。"""
    revision = subprocess.check_output(["git", "-C", str(source_dir), "rev-parse", "HEAD"], text=True).strip()
    if revision != CODE_REVISION:
        raise ValueError(f"SubRoformer のコードを {CODE_REVISION} に固定してください")
    subprocess.run(["git", "-C", str(source_dir), "diff", "--quiet", "HEAD", "--"], check=True)


def prepare_model(device, cache_dir=None):
    """固定されたファイルだけを取得し、モデルのパスを返す。"""
    from huggingface_hub import hf_hub_download

    options = {"repo_id": MODEL_REPO, "revision": MODEL_REVISION, "cache_dir": cache_dir}
    if device == "coreml":
        for relative, (algorithm, digest) in COREML_HASHES.items():
            path = Path(hf_hub_download(filename=f"{COREML_DIRECTORY}/{relative}", **options))
            verify_file(path, digest, algorithm)
        return path.parents[2]  # mask.mlmodelc/weights/weight.bin からモデルのディレクトリへ。
    path = Path(hf_hub_download(filename=WEIGHTS_FILE, **options))
    verify_file(path, WEIGHTS_SHA256)
    return path


def run(input_path, output_dir, source_dir, device="cpu", cache_dir=None, threads=4):
    """4パートを無加工の float32 WAV として保存し、時間と来歴を記録する。"""
    verify_source(source_dir)
    if not input_path.is_file():
        raise FileNotFoundError("比較対象の WAV が見つかりません")
    output_dir.mkdir(parents=True, exist_ok=True)
    if any((output_dir / f"{stem}.wav").exists() for stem in STEMS) or (output_dir / "metadata.json").exists():
        raise FileExistsError("比較結果が既にあるため、新しい出力先を指定してください")
    sys.path.insert(0, str(source_dir))
    started = time.perf_counter()
    import numpy as np
    import soundfile as sf
    import torch
    from subroformer.inference.engine import load_audio, load_separator, separate_audio, resolve_amp_dtype

    torch.set_num_threads(threads)
    import_seconds = time.perf_counter() - started
    started = time.perf_counter()
    model_path = prepare_model(device, cache_dir)
    acquisition_seconds = time.perf_counter() - started
    started = time.perf_counter()
    if device == "coreml":
        from subroformer.inference.coreml import load_local_coreml_separator
        model, config = load_local_coreml_separator(model_path, dsp_device="cpu")
        amp_dtype = None
    else:
        config_path = source_dir / "subroformer/configs/sbroformer_base_4stem_silu.yaml"
        model, config = load_separator(config_path, model_path, device=device, local_files_only=True)
        amp_dtype = resolve_amp_dtype(torch.device(device))
    load_seconds = time.perf_counter() - started
    sample_rate = int(config.audio.sample_rate)
    audio = load_audio(input_path, sample_rate)
    if audio.shape[0] == 1:
        audio = np.repeat(audio, 2, axis=0)
    if audio.shape[0] != 2 or audio.shape[1] == 0 or not np.isfinite(audio).all():
        raise ValueError("比較音声は空でない有限値のモノラルかステレオが必要です")
    started = time.perf_counter()
    with ExitStack() as stack:
        writers = {stem: stack.enter_context(sf.SoundFile(
            output_dir / f"{stem}.wav", mode="x", samplerate=sample_rate, channels=2, subtype="FLOAT",
        )) for stem in STEMS}

        def write_chunk(start, chunks):
            if set(chunks) != set(STEMS):
                raise ValueError("想定した4パートとモデルの出力が一致しません")
            for stem, chunk in chunks.items():
                if not np.isfinite(chunk).all():
                    raise ValueError("モデルの出力に有限値でないサンプルがあります")
                writers[stem].write(chunk.T)

        separate_audio(model, audio, config, hop_ratio=4, batch_size=1, amp_dtype=amp_dtype,
                       on_chunk=write_chunk, collect_output=False)
        if device == "mps":
            torch.mps.synchronize()
    separation_seconds = time.perf_counter() - started
    # macOS は byte、Linux は KiB。GPU メモリを含む値ではない。
    peak_rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    metadata = {
        "model": "subroformer-perceptual-200k", "code_revision": CODE_REVISION,
        "model_revision": MODEL_REVISION, "weights_sha256": WEIGHTS_SHA256,
        "artifact": COREML_DIRECTORY if device == "coreml" else WEIGHTS_FILE,
        "artifact_hashes": COREML_HASHES if device == "coreml" else {WEIGHTS_FILE: ("sha256", WEIGHTS_SHA256)},
        "config_sha256": file_hash(model_path / "config.yaml" if device == "coreml" else config_path),
        "device": device, "precision": "fp16-coreml" if device == "coreml" else ("fp16-autocast" if device == "mps" else "fp32"),
        "sample_rate": sample_rate, "frames": audio.shape[1], "channels": 2,
        "hop_ratio": 4, "batch_size": 1, "torch_threads": threads,
        "torch_version": torch.__version__, "import_seconds": import_seconds,
        "acquisition_seconds": acquisition_seconds, "load_seconds": load_seconds,
        "separation_seconds": separation_seconds,
        "peak_rss_bytes": peak_rss if sys.platform == "darwin" else peak_rss * 1024,
        "input_sha256": file_hash(input_path),
        "source_repository": "https://github.com/ArchiMickey/SubRoformer",
    }
    (output_dir / "metadata.json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(metadata, ensure_ascii=False))
    return metadata


def main():
    parser = argparse.ArgumentParser(description="SubRoformer の固定した重みとコードで比較する")
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--source-dir", type=Path, required=True)
    parser.add_argument("--device", choices=["cpu", "mps", "coreml"], default="cpu")
    parser.add_argument("--cache-dir", type=Path)
    parser.add_argument("--threads", type=int, default=4)
    args = parser.parse_args()
    if args.threads < 1:
        parser.error("--threads は1以上が必要です")
    run(args.input.resolve(), args.output_dir.resolve(), args.source_dir.resolve(), args.device, args.cache_dir, args.threads)


if __name__ == "__main__":
    main()
