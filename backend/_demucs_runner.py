"""Demucs の WAV 保存を、振幅を保つ soundfile の経路へ差し替える。

4.0 の torchaudio 依存を回避し、4.1 の浮動小数点 WAV 保存時のクリップも防ぐ。
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
        **kwargs: ``encoding`` と ``bits_per_sample`` に従って保存する。
            ``PCM_F`` は浮動小数点 WAV、``PCM_S`` は整数 PCM。

    Side Effects:
        filepath に WAV ファイルを書き出す。
        src が GPU テンソルの場合は .cpu() で転送してから変換する。
    """
    data = src.detach().cpu().numpy().T
    encoding = kwargs.get("encoding")
    bits = kwargs.get("bits_per_sample")
    if encoding == "PCM_F":
        subtype = "DOUBLE" if bits == 64 else "FLOAT"
    elif encoding == "PCM_S" or bits is not None:
        subtype = {16: "PCM_16", 24: "PCM_24", 32: "PCM_32"}.get(bits, "PCM_16")
    else:
        subtype = None
    sf.write(str(filepath), data, sample_rate, subtype=subtype)


torchaudio.save = _soundfile_save


def _patch_wav_encoder():
    """Demucs 4.1 の浮動小数点 WAV エンコーダーだけを差し替える。

    4.1 は torchaudio を通らず、浮動小数点 WAV にも -1〜1 のクリップを行う。
    4.0 にはこの関数が無いため、その場合は上の torchaudio の差し替えだけを使う。
    整数 PCM の処理は Demucs の実装を保つ。
    """
    import demucs.audio

    original = getattr(demucs.audio, "encode_wav", None)
    if original is None:
        return

    def encode_wav(wav, path, samplerate, bits_per_sample=16, as_float=False):
        if as_float:
            return _soundfile_save(path, wav, samplerate, encoding="PCM_F", bits_per_sample=32)
        return original(wav, path, samplerate, bits_per_sample=bits_per_sample, as_float=False)

    demucs.audio.encode_wav = encode_wav


_patch_wav_encoder()

MODEL_FILE_FLAG = "--bunri-model-file"


def _take_model_file(argv):
    """引数から ``--bunri-model-file <パス>`` を抜き取る。

    Demucs の引数には無い、このラッパーだけの指定。Demucs が自分では取りに行けないモデル
    （ドラムの細分化など、bunri が別に配っているもの）を、手元の safetensors から読むために使う。

    Args:
        argv: コマンドライン引数のリスト（``sys.argv[1:]`` に当たるもの）。

    Returns:
        tuple[str | None, list[str]]: モデルのファイルのパス（指定が無ければ ``None``）と、
            その指定を取り除いた残りの引数。

    Raises:
        SystemExit: フラグだけが在ってパスが無いとき。
    """
    if MODEL_FILE_FLAG not in argv:
        return None, list(argv)
    i = argv.index(MODEL_FILE_FLAG)
    if i + 1 >= len(argv):
        raise SystemExit(f"{MODEL_FILE_FLAG} にはファイルのパスが要ります")
    return argv[i + 1], argv[:i] + argv[i + 2:]


def _use_model_file(path):
    """Demucs がモデルを取りに行く代わりに、手元の safetensors を読むよう差し替える。

    safetensors は重みと設定値だけを持つ形式で、読み込みでコードが実行されることが無い
    （pickle 形式の ``.th`` を Demucs の標準の読み方で開くと、中のコードが実行されうる）。

    Args:
        path: モデルのファイル（``demucs.hf.load_safetensors_model`` が読める形）。

    Side Effects:
        ``demucs.api.get_model`` を差し替える。
    """
    import demucs.api
    from demucs.hf import load_safetensors_model

    def _get_model(name=None, repo=None):
        model = load_safetensors_model(path)
        model.eval()
        return model

    demucs.api.get_model = _get_model


if __name__ == "__main__":
    import sys

    # API サーバから起動されたときだけ、進み具合を親に伝え、親が居なくなったら終わるようにする
    import demucs_progress

    demucs_progress.setup_child()

    _model_file, _rest = _take_model_file(sys.argv[1:])
    if _model_file:
        _use_model_file(_model_file)
    sys.argv = [sys.argv[0]] + _rest

    from demucs.separate import main

    main()
