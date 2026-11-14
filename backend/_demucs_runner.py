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
