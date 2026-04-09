"""torchaudio.save が torchcodec/FFmpeg を要求する問題を回避するラッパー。
soundfile で WAV 保存するよう torchaudio.save をパッチしてから demucs を起動する。
"""
import soundfile as sf
import torchaudio


def _soundfile_save(filepath, src, sample_rate, **kwargs):
    """torchaudio.save の代替: soundfile で保存"""
    data = src.cpu().numpy().T
    sf.write(str(filepath), data, sample_rate)


torchaudio.save = _soundfile_save

from demucs.separate import main  # noqa: E402

main()
