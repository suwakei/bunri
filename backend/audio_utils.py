"""音声ファイルの読み書きとデータ置き場の解決に関する共通ユーティリティ"""
import os
from pathlib import Path

import numpy as np
import soundfile as sf


def load_audio(file_obj):
    """音声ファイルを読み込み、波形データとサンプルレートを返す。

    soundfile を使って WAV などの音声ファイルを読み込む。
    None が渡された場合は ValueError を送出する。

    Args:
        file_obj: 入力音声ファイルのパス（str / Path）またはファイルオブジェクト。
            None は不可。soundfile が対応する形式（WAV, FLAC 等）のみ。

    Returns:
        tuple[numpy.ndarray, int]: (data, sr) のタプル。
            data は float64 の波形配列。モノラルなら shape=(N,)、
            ステレオなら shape=(N, 2)。sr はサンプルレート（Hz）。

    Raises:
        ValueError: file_obj が None の場合。
        RuntimeError: soundfile が読み込めない形式や破損ファイルの場合。
    """
    if file_obj is None:
        raise ValueError("ファイルをアップロードしてください")
    data, sr = sf.read(file_obj)
    return data, sr


def data_dir():
    """利用者のデータ (uploads/ results/ projects/ soundfonts/) を置く親ディレクトリを返す。

    データ置き場を一箇所で決めるための関数。環境変数 ``BUNRI_DATA_DIR`` が
    設定されていればそこを使い、無ければリポジトリ直下 (``backend/`` の親) を使う。
    デスクトップアプリでは実行ファイルの隣に書き込めないため、起動側が
    ``BUNRI_DATA_DIR`` に OS のアプリデータディレクトリを渡す想定。

    環境変数は import 時ではなく呼び出しのたびに読む (起動後の差し替えとテストのため)。

    Returns:
        pathlib.Path: データ置き場の絶対パス。存在の保証はしない。
    """
    env = os.environ.get("BUNRI_DATA_DIR")
    if env:
        return Path(env).expanduser().resolve()
    return Path(__file__).resolve().parent.parent


def _data_subdir(name, *parts, create=True):
    """``data_dir()`` 以下のサブディレクトリを解決する (内部用)。

    Args:
        name: 直下のディレクトリ名 (``"results"`` など)。
        *parts: さらに下のサブディレクトリ名。可変長。
        create: True なら存在しない場合に親ごと作成する。

    Returns:
        pathlib.Path: 解決済みの絶対パス。
    """
    path = data_dir().joinpath(name, *parts)
    if create:
        path.mkdir(parents=True, exist_ok=True)
    return path


def results_dir(*parts):
    """結果ファイルの出力先ディレクトリを解決し、存在しなければ作成して返す。

    新規モジュールはパスを直書きせず、必ずこの関数を経由すること。
    置き場そのものは ``data_dir()`` が決める。

    Args:
        *parts: ``results/`` 以下のサブディレクトリ名。可変長。
            例: ``results_dir("charts")`` → ``<データ置き場>/results/charts``。
            省略した場合は ``results/`` 自体を返す。

    Returns:
        pathlib.Path: 解決済みの絶対パス。呼び出し時点で存在が保証される。

    Side Effects:
        該当ディレクトリが存在しない場合、親ディレクトリごと作成する。
    """
    return _data_subdir("results", *parts)


def uploads_dir():
    """アップロードされたファイルの保存先 ``uploads/`` を返す (無ければ作成する)。

    Returns:
        pathlib.Path: 解決済みの絶対パス。
    """
    return _data_subdir("uploads")


def projects_dir():
    """プロジェクト JSON の保存先 ``projects/`` を返す (無ければ作成する)。

    Returns:
        pathlib.Path: 解決済みの絶対パス。
    """
    return _data_subdir("projects")


def soundfonts_dir():
    """SoundFont の置き場 ``soundfonts/`` を返す。

    読み取り専用の置き場なので、存在しなくても作成しない。

    Returns:
        pathlib.Path: 解決済みの絶対パス。存在の保証はしない。
    """
    return _data_subdir("soundfonts", create=False)


def safe_join(base, name):
    """外から受け取ったファイル名を ``base`` 直下のパスに解決する。外に出る名前は拒否する。

    アップロード名やダウンロード名をそのままパスに繋ぐと、``../`` で
    データ置き場の外を読み書きできてしまう。それを防ぐための関数。
    ディレクトリ成分を含む名前は、``base`` の内側に収まる場合でも受け付けない
    (保存先は常に ``base`` の直下 1 階層)。

    Args:
        base: 親ディレクトリ (str または pathlib.Path)。
        name: 外部から受け取ったファイル名。

    Returns:
        pathlib.Path: ``base`` 直下の絶対パス。

    Raises:
        ValueError: 名前が空・``.``・``..``、パス区切りや NUL を含む、
            または解決後のパスが ``base`` の外に出る場合。
    """
    if not isinstance(name, str) or not name or name in (".", ".."):
        raise ValueError("ファイル名が不正です")
    if "/" in name or "\\" in name or "\x00" in name:
        raise ValueError("ファイル名にパス区切り文字は使えません")
    base_path = Path(base).resolve()
    path = (base_path / name).resolve()
    if path.parent != base_path:
        raise ValueError("ファイル名が保存先の外を指しています")
    return path


def sec_to_samples(sec, sr):
    """秒をサンプル数に変換する。

    Args:
        sec: 時間（秒）。0以上の実数。
        sr: サンプルレート（Hz）。正の整数。

    Returns:
        int: サンプル数。小数点以下は切り捨て。
    """
    return int(sec * sr)


def save_tmp(data, sr, prefix="edited"):
    """編集結果を results/edited/ 以下の一時 WAV ファイルに保存し、パスを返す。

    出力ディレクトリ results/edited/ が存在しない場合は自動的に作成する。
    ファイル名は ``{prefix}_{4桁乱数}.wav`` の形式となる。

    Args:
        data: 保存する波形データ（numpy.ndarray）。
            モノラル shape=(N,) またはステレオ shape=(N, 2)。
        sr: サンプルレート（Hz）。正の整数。
        prefix: 出力ファイル名のプレフィックス（str）。デフォルトは "edited"。

    Returns:
        str: 保存された WAV ファイルの絶対パス。

    Side Effects:
        results/edited/{prefix}_{乱数}.wav をディスクに書き出す。
        results/edited/ ディレクトリが存在しない場合は作成する。
    """
    out_dir = results_dir("edited")
    out_path = out_dir / f"{prefix}_{np.random.randint(10000):04d}.wav"
    sf.write(str(out_path), data, sr)
    return str(out_path)


def to_stereo(data):
    """モノラル音声データをステレオに変換する。

    1 次元配列（モノラル）の場合、左右チャンネルを同一波形で複製して
    shape=(N, 2) のステレオ配列を返す。
    すでにステレオ（2 次元）であればそのまま返す。

    Args:
        data: 波形データ（numpy.ndarray）。
            モノラル shape=(N,) またはステレオ shape=(N, 2)。

    Returns:
        numpy.ndarray: shape=(N, 2) のステレオ配列。
            入力がすでにステレオの場合は入力をそのまま返す（コピーなし）。
    """
    if data.ndim == 1:
        return np.column_stack([data, data])
    return data
