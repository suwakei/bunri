"""小型SCNetのONNX推論。固定したaudiojs/neuralの前後処理と振幅を保つ。

前後処理の基準: audiojs/neural 6df9aedb25cc10e54e9acddad673aac587c079a9。
MIT Copyright (c) Dmitry Iv。利用条件は同梱のライセンス文書に記す。
"""
from pathlib import Path

STEMS = ("drums", "bass", "other", "vocals")
RATE = 44100
FFT = 4096
HOP = 1024
FRAMES = 476
SEGMENT = 485100


def reflect_indices(indices, length):
    """端のサンプルを繰り返さない反射。短い入力にも対応する。"""
    import numpy as np
    if length < 1:
        raise ValueError("空の音声は反射できません")
    indices = np.asarray(indices)
    if length == 1:
        return np.zeros_like(indices)
    folded = indices % (2 * (length - 1))
    return np.where(folded < length, folded, 2 * (length - 1) - folded)


def encode_segment(segment):
    """矩形窓・中心反射の正規化STFTをONNXの実部/虚部チャンネルへ並べる。"""
    import numpy as np
    padded = np.pad(segment.astype(np.float64), ((0, 0), (0, max(0, (FRAMES - 1) * HOP - segment.shape[-1]))))
    padded = np.pad(padded, ((0, 0), (FFT // 2, FFT // 2)), mode="reflect")
    frames = np.lib.stride_tricks.sliding_window_view(padded, FFT, axis=-1)[:, ::HOP, :][:, :FRAMES]
    spectrum = np.fft.rfft(frames, axis=-1).transpose(0, 2, 1) / (FFT ** 0.5)
    planes = np.stack((spectrum.real, spectrum.imag), axis=1)
    return planes.reshape(1, 4, FFT // 2 + 1, FRAMES).astype(np.float32)


def decode_segment(estimate):
    """ONNXの複素スペクトルを矩形窓の重複加算でステレオ音声へ戻す。"""
    import numpy as np
    expected = (1, 16, FFT // 2 + 1, FRAMES)
    if estimate.shape != expected or not np.isfinite(estimate).all():
        raise ValueError("SCNetの出力の形または値が不正です")
    planes = estimate.reshape(4, 2, 2, FFT // 2 + 1, FRAMES).astype(np.float64)
    spectrum = (planes[:, :, 0] + 1j * planes[:, :, 1]) * (FFT ** 0.5)
    frames = np.fft.irfft(spectrum.transpose(0, 1, 3, 2), n=FFT, axis=-1)
    output = np.zeros((4, 2, (FRAMES - 1) * HOP + FFT), dtype=np.float64)
    envelope = np.zeros(output.shape[-1], dtype=np.float64)
    for index in range(FRAMES):
        offset = index * HOP
        output[:, :, offset:offset + FFT] += frames[:, :, index]
        envelope[offset:offset + FFT] += 1
    output /= np.maximum(envelope, 1)
    return output[:, :, FFT // 2:FFT // 2 + SEGMENT].astype(np.float32)


def separate(audio, sample_rate, weights, output_dir, on_ready=None, on_progress=None):
    """4パートをfloat32 WAVに保存する。Nodeやネットワークには依存しない。"""
    import math
    import tempfile
    import numpy as np
    import onnxruntime as ort
    import soundfile as sf
    from scipy.signal import resample_poly

    if sample_rate != RATE:
        divisor = math.gcd(sample_rate, RATE)
        audio = resample_poly(audio, RATE // divisor, sample_rate // divisor, axis=0).astype(np.float32)
    if audio.ndim != 2 or audio.shape[1] != 2 or not len(audio) or not np.isfinite(audio).all():
        raise ValueError("SCNetの入力には空でない有限のステレオ音声が必要です")
    options = ort.SessionOptions()
    options.intra_op_num_threads = 4
    options.inter_op_num_threads = 1
    options.enable_cpu_mem_arena = False
    options.enable_mem_pattern = False
    session = ort.InferenceSession(str(weights), sess_options=options, providers=["CPUExecutionProvider"])
    if on_ready:
        on_ready("cpu")
    input_name = session.get_inputs()[0].name
    # 混合の直流成分は各パートへ重ねて足さない。倍率だけ最後に戻す。
    mono = audio.astype(np.float64).mean(axis=1)
    mean = float(mono.mean())
    std = float(np.sqrt(np.sum((mono - mean) ** 2) / max(1, len(mono) - 1)) + 1e-8)
    normalized = ((audio.astype(np.float64) - mean) / std).astype(np.float32).T
    step = int(SEGMENT * 0.25)
    border = SEGMENT - step
    wide = len(audio) > 2 * border
    if wide:
        normalized = normalized[:, reflect_indices(np.arange(-border, len(audio) + border), len(audio))]
    length = normalized.shape[-1]
    starts = []
    for start in range(0, length, step):
        starts.append(start)
        if start + SEGMENT >= length:
            break
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    # 全曲ぶんの4パートをRAMに抱えず、キャンセルで消される出力先の中に作業用写しを置く。
    with tempfile.TemporaryDirectory(prefix="scnet-work-", dir=output_dir) as temporary:
        accumulated = np.memmap(Path(temporary) / "parts.bin", dtype=np.float64, mode="w+", shape=(4, 2, length))
        accumulated[:] = 0
        envelope = np.memmap(Path(temporary) / "weights.bin", dtype=np.float64, mode="w+", shape=(length,))
        envelope[:] = 0
        if on_progress:
            on_progress(0, len(starts))
        for index, start in enumerate(starts):
            size = min(SEGMENT, length - start)
            segment = np.zeros((2, SEGMENT), dtype=np.float32)
            segment[:, :size] = normalized[:, start:start + size]
            if size < SEGMENT and size > SEGMENT / 2:
                segment[:, size:] = normalized[:, start + reflect_indices(np.arange(size, SEGMENT), size)]
            encoded = encode_segment(segment)
            estimate = session.run(None, {input_name: encoded})[0]
            decoded = decode_segment(estimate)
            weight = np.ones(SEGMENT, dtype=np.float64)
            fade = int(SEGMENT * 0.1)
            if index > 0:
                weight[:fade] = np.arange(fade) / (fade - 1)
            if index < len(starts) - 1:
                weight[-fade:] = np.minimum(weight[-fade:], np.arange(fade - 1, -1, -1) / (fade - 1))
            envelope[start:start + size] += weight[:size]
            accumulated[:, :, start:start + size] += decoded[:, :, :size] * weight[:size]
            if on_progress:
                on_progress(index + 1, len(starts))
        offset = border if wide else 0
        for index, stem in enumerate(STEMS):
            with sf.SoundFile(output_dir / f"{stem}.wav", mode="x", samplerate=RATE, channels=2, subtype="FLOAT") as writer:
                for position in range(0, len(audio), 65536):
                    end = min(position + 65536, len(audio))
                    start = offset + position
                    values = (accumulated[index, :, start:offset + end] / envelope[start:offset + end]).astype(np.float32)
                    values = (values.astype(np.float64) * std).astype(np.float32)
                    if not np.isfinite(values).all():
                        raise ValueError("SCNetの音声に有限値でないサンプルがあります")
                    writer.write(values.T)
        del accumulated, envelope
    return "cpu"
