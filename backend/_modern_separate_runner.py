"""新しい分離モデルを専用プロセスで動かす。親が消えたときも終了する。"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading

_decoder = None
_decoder_lock = threading.RLock()


def cleanup_decoder():
    """親が消えた場合も、変換用の子プロセスを残さない。"""
    with _decoder_lock:
        process = _decoder
        if process is not None and process.poll() is None:
            process.kill()
            process.wait()


def load_input(input_path, output_dir):
    """WAV/MP3を読み、必要な形式だけ既存のffmpegでWAVへ変換する。"""
    import numpy as np
    from audio_utils import load_audio
    global _decoder

    try:
        data, rate = load_audio(input_path)
    except (RuntimeError, ValueError):
        with tempfile.TemporaryDirectory(prefix="decode-", dir=output_dir) as temporary:
            converted = Path(temporary) / "input.wav"
            try:
                with _decoder_lock:
                    _decoder = subprocess.Popen(
                        ["ffmpeg", "-v", "error", "-nostdin", "-i", str(input_path), "-c:a", "pcm_f32le", str(converted)],
                        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                    )
                returncode = _decoder.wait()
                if returncode:
                    raise subprocess.CalledProcessError(returncode, "ffmpeg")
            except (OSError, subprocess.CalledProcessError) as error:
                raise RuntimeError("音声を読み込めませんでした。WAVまたはMP3に変換して取り込み直してください") from error
            finally:
                cleanup_decoder()
                with _decoder_lock:
                    _decoder = None
            data, rate = load_audio(converted)
    data = np.asarray(data, dtype=np.float32)
    if data.ndim == 1:
        data = np.repeat(data[:, None], 2, axis=1)
    if data.ndim != 2 or data.shape[1] != 2 or not len(data) or not np.isfinite(data).all():
        raise ValueError("空でないモノラルまたはステレオの音声を取り込んでください")
    return data, rate


def run(input_path, output_dir, model, weights):
    """親の台帳に従ってモデルを用意し、4パートと実行基盤を返す。"""
    import demucs_progress
    import modern_models

    events = os.environ.get(demucs_progress.ENV_FLAG) == "1"
    if events:
        demucs_progress.watch_parent(on_exit=cleanup_decoder)
        demucs_progress.emit("ready", hooks=True)
    if Path(weights).resolve() != modern_models.model_path(model).resolve():
        raise ValueError("分離モデルの保存先がアプリの台帳と一致しません")
    weights = modern_models.ensure_model(
        model, on_bytes=(lambda done: demucs_progress.emit("model_download", done=done, total=modern_models.MODELS[model]["size"])) if events else None,
    )
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    data, rate = load_input(input_path, output_dir)

    def ready(device):
        if events:
            demucs_progress.emit("model_ready", passes=1, device=device)

    def progress(done, total):
        if events:
            demucs_progress.emit("segments", **{"pass": 0, "done": done, "total": total})

    if model == "scnet":
        from scnet_inference import separate
    elif model == "subroformer":
        from subroformer_inference import separate
    else:
        raise ValueError("対応していない分離モデルです")
    device = separate(data, rate, weights, output_dir, on_ready=ready, on_progress=progress)
    (output_dir / "runtime.json").write_text(json.dumps({"model": model, "device": device}) + "\n")


def main():
    import signal
    import traceback
    import sys
    import demucs_progress
    import modern_models

    def terminate(signum, frame):
        cleanup_decoder()
        raise SystemExit(1)

    signal.signal(signal.SIGTERM, terminate)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--model", choices=("scnet", "subroformer"), required=True)
    parser.add_argument("--weights", type=Path, required=True)
    args = parser.parse_args()
    try:
        run(args.input, args.out, args.model, args.weights)
    except Exception as error:
        if isinstance(error, modern_models.ModelUnavailableError):
            message = str(error)
        elif isinstance(error, ValueError):
            message = str(error)
        else:
            label = "SubRoformer" if args.model == "subroformer" else "SCNet"
            message = f"{label}で音声を分けられませんでした。ほかの処理を止めて再実行するか、分け方を変更してください"
        demucs_progress.emit("error", message=message)
        traceback.print_exc(file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
