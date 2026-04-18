"""torchaudio.save が torchcodec/FFmpeg を要求する問題を回避するラッパー。
soundfile で WAV 保存するよう torchaudio.save をパッチしてから demucs を起動する。
"""
import soundfile as sf
import torchaudio


def _soundfile_save(filepath, src, sample_rate, **kwargs):
    """torchaudio.save の代替実装。soundfile を使って WAV に保存する。

    torchaudio.save は環境によって torchcodec や FFmpeg バックエンドを
    要求するが、それらが利用できない CPU 環境ではエラーになる。
    このパッチ関数は torch.Tensor を numpy 配列に変換し soundfile で
    直接 WAV 形式で書き出すことで問題を回避する。

    モジュールロード時に ``torchaudio.save = _soundfile_save`` で
    グローバルに置き換えられる。

    Args:
        filepath: 出力ファイルパス（str または Path）。WAV 形式で書き出す。
        src: 保存する音声データ（torch.Tensor）。
            shape=(channels, samples) を想定。CPU / GPU どちらも対応。
        sample_rate: サンプルレート（Hz）。正の整数。
        **kwargs: torchaudio.save との互換性のために受け取るが無視する。
            （format, encoding, bits_per_sample 等）

    Side Effects:
        filepath に WAV ファイルを書き出す。
        src が GPU テンソルの場合は .cpu() で転送してから変換する。
    """
    data = src.cpu().numpy().T
    sf.write(str(filepath), data, sample_rate)


torchaudio.save = _soundfile_save

from demucs.separate import main  # noqa: E402

main()
