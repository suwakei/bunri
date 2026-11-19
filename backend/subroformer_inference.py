"""同梱したSubRoformerで分離する。モデルの取得や外部コードの実行はしない。"""
from pathlib import Path

STEMS = ("vocals", "bass", "drums", "other")


def separate(audio, sample_rate, weights, output_dir, on_ready=None, on_progress=None):
    """Macでは利用できるMPS、他はCPUを使い、振幅を保った4パートを保存する。"""
    import sys
    import math
    from contextlib import ExitStack
    import numpy as np
    import soundfile as sf
    import torch
    import librosa

    bundled = Path(__file__).parent / "_vendor" / "subroformer"
    sys.path.insert(0, str(bundled))
    from subroformer.inference.engine import load_separator, separate_audio, resolve_amp_dtype

    torch.set_num_threads(4)
    device = "mps" if torch.backends.mps.is_available() else "cpu"
    config_path = bundled / "subroformer" / "configs" / "sbroformer_base_4stem_silu.yaml"
    if not config_path.is_file() or not Path(weights).is_file():
        raise FileNotFoundError("SubRoformerの同梱設定または分離モデルが見つかりません")
    model, config = load_separator(config_path, weights, device=device, local_files_only=True)
    if on_ready:
        on_ready(device)
    rate = int(config.audio.sample_rate)
    audio = audio.T.astype(np.float32)
    if sample_rate != rate:
        audio = librosa.resample(audio, orig_sr=sample_rate, target_sr=rate, axis=-1)
    if audio.shape[0] != 2 or not audio.shape[1] or not np.isfinite(audio).all():
        raise ValueError("SubRoformerの入力には空でない有限のステレオ音声が必要です")
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    chunk = int(config.audio.chunk_size)
    total = 1 + math.ceil(max(audio.shape[-1] - chunk, 0) / (chunk // 4))
    completed = 0
    if on_progress:
        on_progress(0, total)
    with ExitStack() as stack:
        writers = {stem: stack.enter_context(sf.SoundFile(
            output_dir / f"{stem}.wav", mode="x", samplerate=rate, channels=2, subtype="FLOAT",
        )) for stem in STEMS}

        def write_chunk(start, chunks):
            nonlocal completed
            if set(chunks) != set(STEMS):
                raise ValueError("SubRoformerの出力パートが一致しません")
            for stem, values in chunks.items():
                if not np.isfinite(values).all():
                    raise ValueError("SubRoformerの音声に有限値でないサンプルがあります")
                writers[stem].write(values.T)
            completed += 1
            if on_progress:
                on_progress(completed, total)

        separate_audio(model, audio, config, hop_ratio=4, batch_size=1,
                       amp_dtype=resolve_amp_dtype(torch.device(device)), on_chunk=write_chunk, collect_output=False)
    if device == "mps":
        torch.mps.synchronize()
    return device
