import math

import torch
from torch import Tensor


_PHASE_CHUNK_ELEMENTS = 1 << 20


def fix_length(x: Tensor, start: int, length: int) -> Tensor:
    end = start + length
    return x[..., start : end]


def _phase_steps(x: Tensor, f: Tensor, sr: int) -> Tensor:
    phase_scale = 1 << 32
    phase_half = phase_scale >> 1
    phase_dtype = torch.float64 if x.dtype in (torch.float64, torch.complex128) else torch.float32
    frequencies = f.to(device=x.device, dtype=phase_dtype)
    scaled_frequencies = frequencies.abs().mul(phase_scale).round().to(torch.int64)
    steps = torch.div(scaled_frequencies + sr // 2, sr, rounding_mode="floor")
    steps.mul_(frequencies.sign().to(torch.int64))
    return steps.add_(phase_half).bitwise_and_(phase_scale - 1).sub_(phase_half)


def _shift_frequency_reference(x: Tensor, f: Tensor, sr: int, n: int = 1) -> Tensor:
    r"""Shift frequency to -ω0.

    X(j(ω-ω0)) = e^{j(ω0)n}X(jω)

    k: n_bands
    l: audio_samples

    Args:
        x: (any, k, l)
        f: (k,)

    Returns:
        out: (any, k, l)

    Frequencies are fixed, non-learnable values quantized to sr / 2**32 Hz.
    Integer phase wraps before conversion to radians, so float32 phase
    evaluation stays within [-pi, pi) regardless of signal length. Phase
    workspace is tiled; float32/complex64 inputs require no float64 tensors.
    """
    phase_scale = 1 << 32
    phase_half = phase_scale >> 1
    phase_mask = phase_scale - 1
    phase_dtype = torch.float64 if x.dtype in (torch.float64, torch.complex128) else torch.float32
    oscillator_dtype = torch.complex128 if phase_dtype == torch.float64 else torch.complex64
    phase_steps = _phase_steps(x, f, sr)

    length = x.shape[-1]
    oscillator = torch.empty((f.numel(), length), dtype=oscillator_dtype, device=x.device)
    chunk_length = max(1, _PHASE_CHUNK_ELEMENTS // max(1, f.numel()))
    for start in range(0, length, chunk_length):
        end = min(start + chunk_length, length)
        sample_indices = torch.arange(start, end, dtype=torch.int64, device=x.device)
        sample_indices.mul_(n).bitwise_and_(phase_mask)
        phase_words = phase_steps[:, None] * sample_indices[None, :]
        phase_words.add_(phase_half).bitwise_and_(phase_mask).sub_(phase_half)
        phase = phase_words.to(phase_dtype).mul_(2 * math.pi / phase_scale)
        torch.polar(torch.ones_like(phase), phase, out=oscillator[:, start:end])
        del sample_indices, phase_words, phase

    return x * oscillator


def shift_frequency(x: Tensor, f: Tensor, sr: int, n: int = 1) -> Tensor:
    """同梱版は上流の純PyTorch経路を使い、実行時のコンパイルを不要にする。"""
    return _shift_frequency_reference(x, f, sr, n)
