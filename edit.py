"""音声編集機能"""
import numpy as np
import soundfile as sf

from audio_utils import load_audio, sec_to_samples, save_tmp, to_stereo


def trim_audio(file_obj, start_sec, end_sec):
    """音声ファイルの指定範囲のみを残してトリムする。

    指定した開始・終了位置の区間を切り出し、それ以外を削除する。
    結果は一時 WAV ファイルとして保存される。

    Args:
        file_obj: 入力 WAV ファイルのパスまたはファイルオブジェクト。
        start_sec: トリム開始位置（秒）。0 以上の実数。
        end_sec: トリム終了位置（秒）。start_sec より大きい値。

    Returns:
        str: 保存された一時 WAV ファイルのパス。

    Raises:
        ValueError: start_sec >= end_sec の場合。

    Side Effects:
        results/edited/ にファイルを書き出す。
    """
    data, sr = load_audio(file_obj)
    s = sec_to_samples(start_sec, sr)
    e = sec_to_samples(end_sec, sr)
    if s >= e:
        raise ValueError("開始が終了以降になっています")
    return save_tmp(data[s:e], sr, "trim")


def cut_audio(file_obj, start_sec, end_sec):
    """音声ファイルの指定範囲を削除（カット）し、前後を結合して返す。

    start_sec から end_sec の区間を取り除き、それ以外の部分を連結した
    音声を一時 WAV ファイルとして保存する。

    Args:
        file_obj: 入力 WAV ファイルのパスまたはファイルオブジェクト。
        start_sec: 削除開始位置（秒）。0 以上の実数。
        end_sec: 削除終了位置（秒）。start_sec より大きい値。

    Returns:
        str: 保存された一時 WAV ファイルのパス。

    Raises:
        ValueError: start_sec >= end_sec の場合。

    Side Effects:
        results/edited/ にファイルを書き出す。
    """
    data, sr = load_audio(file_obj)
    s = sec_to_samples(start_sec, sr)
    e = sec_to_samples(end_sec, sr)
    if s >= e:
        raise ValueError("開始が終了以降になっています")
    return save_tmp(np.concatenate([data[:s], data[e:]]), sr, "cut")


def split_at(file_obj, split_sec):
    """指定位置で音声を前後 2 つのファイルに分割する。

    split_sec を境界として、前半と後半をそれぞれ別の一時 WAV ファイルに
    保存し、2 つのパスをタプルで返す。

    Args:
        file_obj: 入力 WAV ファイルのパスまたはファイルオブジェクト。
        split_sec: 分割位置（秒）。ファイル長の範囲内（0 より大きく
            ファイル末尾より小さい値）。

    Returns:
        tuple[str, str]: (前半ファイルパス, 後半ファイルパス) のタプル。

    Raises:
        ValueError: split_sec がファイル先頭（0 以下）または末尾以降の場合。

    Side Effects:
        results/edited/ に 2 つのファイルを書き出す。
    """
    data, sr = load_audio(file_obj)
    s = sec_to_samples(split_sec, sr)
    if s <= 0 or s >= len(data):
        raise ValueError("分割位置がファイルの範囲外です")
    return save_tmp(data[:s], sr, "split_A"), save_tmp(data[s:], sr, "split_B")


def copy_range(file_obj, start_sec, end_sec, insert_sec):
    """指定範囲をコピーして別の位置に挿入する。

    start_sec から end_sec の区間を複製し、insert_sec の位置に挿入した
    新しい音声を一時 WAV ファイルとして保存する。

    Args:
        file_obj: 入力 WAV ファイルのパスまたはファイルオブジェクト。
        start_sec: コピー開始位置（秒）。0 以上の実数。
        end_sec: コピー終了位置（秒）。start_sec より大きい値。
        insert_sec: コピーしたデータを挿入する位置（秒）。
            0 以上、ファイル長以下の実数。

    Returns:
        str: 保存された一時 WAV ファイルのパス。

    Raises:
        ValueError: start_sec >= end_sec の場合。

    Side Effects:
        results/edited/ にファイルを書き出す。
    """
    data, sr = load_audio(file_obj)
    s = sec_to_samples(start_sec, sr)
    e = sec_to_samples(end_sec, sr)
    ins = sec_to_samples(insert_sec, sr)
    if s >= e:
        raise ValueError("コピー範囲の開始が終了以降になっています")
    copied = data[s:e]
    return save_tmp(np.concatenate([data[:ins], copied, data[ins:]]), sr, "copy")


def change_volume(file_obj, db):
    """音量を dB 単位で増減する。

    指定した dB 値を線形ゲインに変換して波形に乗算する。
    クリッピングを防ぐため結果を [-1.0, 1.0] にクランプする。

    Args:
        file_obj: 入力 WAV ファイルのパスまたはファイルオブジェクト。
        db: 音量変化量（dB）。正の値で音量アップ、負の値で音量ダウン。
            例: +6.0 で約 2 倍、-6.0 で約 1/2 倍。

    Returns:
        str: 保存された一時 WAV ファイルのパス。

    Side Effects:
        results/edited/ にファイルを書き出す。
    """
    data, sr = load_audio(file_obj)
    gain = 10 ** (db / 20)
    return save_tmp(np.clip(data * gain, -1.0, 1.0), sr, "vol")


def fade_in(file_obj, duration_sec):
    """音声の先頭にフェードインを適用する。

    先頭から duration_sec の区間にわたって、振幅を 0 から 1 へ線形に
    増加させるフェードインエンベロープを適用する。

    Args:
        file_obj: 入力 WAV ファイルのパスまたはファイルオブジェクト。
        duration_sec: フェードイン時間（秒）。0 より大きい実数。
            ファイル長を超えた場合はファイル長に制限される。

    Returns:
        str: 保存された一時 WAV ファイルのパス。

    Side Effects:
        results/edited/ にファイルを書き出す。
    """
    data, sr = load_audio(file_obj)
    n = min(sec_to_samples(duration_sec, sr), len(data))
    fade = np.linspace(0.0, 1.0, n)
    if data.ndim == 2:
        fade = fade[:, np.newaxis]
    data[:n] = data[:n] * fade
    return save_tmp(data, sr, "fadein")


def fade_out(file_obj, duration_sec):
    """音声の末尾にフェードアウトを適用する。

    末尾から duration_sec の区間にわたって、振幅を 1 から 0 へ線形に
    減少させるフェードアウトエンベロープを適用する。

    Args:
        file_obj: 入力 WAV ファイルのパスまたはファイルオブジェクト。
        duration_sec: フェードアウト時間（秒）。0 より大きい実数。
            ファイル長を超えた場合はファイル長に制限される。

    Returns:
        str: 保存された一時 WAV ファイルのパス。

    Side Effects:
        results/edited/ にファイルを書き出す。
    """
    data, sr = load_audio(file_obj)
    n = min(sec_to_samples(duration_sec, sr), len(data))
    fade = np.linspace(1.0, 0.0, n)
    if data.ndim == 2:
        fade = fade[:, np.newaxis]
    data[-n:] = data[-n:] * fade
    return save_tmp(data, sr, "fadeout")


def insert_silence(file_obj, position_sec, length_sec):
    """指定位置に無音を挿入する。

    position_sec の位置に length_sec 分の無音（ゼロ値サンプル）を挿入し、
    前後の音声を繋げた新しい音声を生成する。

    Args:
        file_obj: 入力 WAV ファイルのパスまたはファイルオブジェクト。
        position_sec: 無音を挿入する位置（秒）。0 以上、ファイル長以下の実数。
        length_sec: 挿入する無音の長さ（秒）。0 より大きい実数。

    Returns:
        str: 保存された一時 WAV ファイルのパス。

    Side Effects:
        results/edited/ にファイルを書き出す。
    """
    data, sr = load_audio(file_obj)
    pos = sec_to_samples(position_sec, sr)
    silence_len = sec_to_samples(length_sec, sr)
    if data.ndim == 2:
        silence = np.zeros((silence_len, data.shape[1]))
    else:
        silence = np.zeros(silence_len)
    return save_tmp(np.concatenate([data[:pos], silence, data[pos:]]), sr, "silence")


def normalize_audio(file_obj):
    """音声の音量をピーク値に基づいて正規化（ノーマライズ）する。

    波形全体のピーク絶対値が 1.0 となるようにゲインを適用する。
    完全な無音ファイルは正規化できないため ValueError を送出する。

    Args:
        file_obj: 入力 WAV ファイルのパスまたはファイルオブジェクト。

    Returns:
        str: 保存された一時 WAV ファイルのパス。

    Raises:
        ValueError: ファイルが完全な無音（ピーク値が 0）の場合。

    Side Effects:
        results/edited/ にファイルを書き出す。
    """
    data, sr = load_audio(file_obj)
    peak = np.max(np.abs(data))
    if peak == 0:
        raise ValueError("無音のファイルです")
    return save_tmp(data / peak, sr, "norm")


def reverse_audio(file_obj):
    """音声を逆再生（時間軸を反転）する。

    波形配列を時間軸方向に反転し、末尾から先頭へ再生されるような
    音声を生成する。

    Args:
        file_obj: 入力 WAV ファイルのパスまたはファイルオブジェクト。

    Returns:
        str: 保存された一時 WAV ファイルのパス。

    Side Effects:
        results/edited/ にファイルを書き出す。
    """
    data, sr = load_audio(file_obj)
    return save_tmp(data[::-1].copy(), sr, "reverse")


def loop_range(file_obj, start_sec, end_sec, count):
    """指定範囲を N 回繰り返してループ音声を生成する。

    start_sec から end_sec の区間を count 回繰り返したセグメントを
    元のその位置に配置し、前後の音声と結合する。

    Args:
        file_obj: 入力 WAV ファイルのパスまたはファイルオブジェクト。
        start_sec: ループ開始位置（秒）。0 以上の実数。
        end_sec: ループ終了位置（秒）。start_sec より大きい値。
        count: 繰り返し回数。2 以上の整数。

    Returns:
        str: 保存された一時 WAV ファイルのパス。

    Raises:
        ValueError: start_sec >= end_sec の場合、または count < 2 の場合。

    Side Effects:
        results/edited/ にファイルを書き出す。
    """
    data, sr = load_audio(file_obj)
    s = sec_to_samples(start_sec, sr)
    e = sec_to_samples(end_sec, sr)
    if s >= e:
        raise ValueError("開始が終了以降になっています")
    count = int(count)
    if count < 2:
        raise ValueError("繰り返し回数は2以上にしてください")
    segment = data[s:e]
    looped = np.tile(segment, (count,) + (1,) * (segment.ndim - 1))
    result = np.concatenate([data[:s], looped, data[e:]])
    return save_tmp(result, sr, "loop")


def pan_audio(file_obj, pan):
    """左右バランス（パン）を等パワーパンニングで調整する。

    モノラルの場合は先にステレオに変換してからパンを適用する。
    等パワーパンニング（cos/sin カーブ）を使用するため、中央でも
    各チャンネルの音量が下がらない。

    Args:
        file_obj: 入力 WAV ファイルのパスまたはファイルオブジェクト。
        pan: パン位置。-1.0（完全左）〜 0.0（中央）〜 1.0（完全右）の実数。

    Returns:
        str: 保存された一時 WAV ファイルのパス。

    Side Effects:
        results/edited/ にファイルを書き出す。
    """
    data, sr = load_audio(file_obj)
    data = to_stereo(data)
    # 等パワーパンニング
    angle = (pan + 1) / 2 * (np.pi / 2)
    gain_l = np.cos(angle)
    gain_r = np.sin(angle)
    data[:, 0] = data[:, 0] * gain_l
    data[:, 1] = data[:, 1] * gain_r
    return save_tmp(data, sr, "pan")


def change_speed(file_obj, speed):
    """再生速度を変更する（ピッチも同時に変わる簡易版）。

    線形補間によりサンプル数を変更して速度を調整する。
    speed > 1.0 で高速化（音程も上がる）、speed < 1.0 で低速化（音程も下がる）。
    音程を維持したい場合は pitch_time.py の time_stretch を使用すること。

    Args:
        file_obj: 入力 WAV ファイルのパスまたはファイルオブジェクト。
        speed: 再生速度倍率。0 より大きい実数。
            1.0 = 等速、2.0 = 倍速、0.5 = 半速。

    Returns:
        str: 保存された一時 WAV ファイルのパス。

    Raises:
        ValueError: speed が 0 以下の場合。

    Side Effects:
        results/edited/ にファイルを書き出す。
    """
    data, sr = load_audio(file_obj)
    if speed <= 0:
        raise ValueError("速度は0より大きくしてください")
    orig_len = len(data)
    new_len = int(orig_len / speed)
    x_old = np.linspace(0, 1, orig_len)
    x_new = np.linspace(0, 1, new_len)
    if data.ndim == 2:
        result = np.column_stack([
            np.interp(x_new, x_old, data[:, ch])
            for ch in range(data.shape[1])
        ])
    else:
        result = np.interp(x_new, x_old, data)
    return save_tmp(result, sr, "speed")


def concat_audio(file_obj_1, file_obj_2):
    """2 つの WAV ファイルを時間軸方向に連結する。

    サンプルレートが異なる場合は file_obj_2 を file_obj_1 のサンプルレートに
    合わせて線形補間でリサンプルする。チャンネル数が異なる場合はどちらも
    ステレオに変換してから結合する。

    Args:
        file_obj_1: 前半の WAV ファイルのパスまたはファイルオブジェクト。None 不可。
        file_obj_2: 後半の WAV ファイルのパスまたはファイルオブジェクト。None 不可。

    Returns:
        str: 保存された一時 WAV ファイルのパス。出力のサンプルレートは
            file_obj_1 のサンプルレートに準拠する。

    Raises:
        ValueError: file_obj_1 または file_obj_2 が None の場合。

    Side Effects:
        results/edited/ にファイルを書き出す。
    """
    if file_obj_1 is None or file_obj_2 is None:
        raise ValueError("2つのファイルをアップロードしてください")
    d1, sr1 = sf.read(file_obj_1)
    d2, sr2 = sf.read(file_obj_2)
    # サンプルレートが違う場合、2番目を1番目に合わせる
    if sr2 != sr1:
        orig_len = len(d2)
        new_len = int(orig_len * sr1 / sr2)
        x_old = np.linspace(0, 1, orig_len)
        x_new = np.linspace(0, 1, new_len)
        if d2.ndim == 2:
            d2 = np.column_stack([
                np.interp(x_new, x_old, d2[:, ch])
                for ch in range(d2.shape[1])
            ])
        else:
            d2 = np.interp(x_new, x_old, d2)
    # チャンネル数を揃える
    d1 = to_stereo(d1)
    d2 = to_stereo(d2)
    return save_tmp(np.concatenate([d1, d2]), sr1, "concat")


def export_mp3(file_obj, bitrate):
    """WAV を MP3 形式でエクスポートする。

    lame または ffmpeg を使って MP3 に変換する。どちらも見つからない場合は
    soundfile で FLAC として書き出す（代替フォールバック）。

    Args:
        file_obj: 入力 WAV ファイルのパスまたはファイルオブジェクト。
        bitrate: MP3 ビットレート（kbps）。例: 128、192、320。

    Returns:
        str: 変換後ファイルのパス。MP3 変換成功時は .mp3 拡張子、
            エンコーダが存在しない場合は .flac 拡張子。

    Side Effects:
        results/edited/ に一時 WAV ファイルおよび MP3（または FLAC）を書き出す。
        lame / ffmpeg を外部プロセスとして呼び出す。
    """
    from pathlib import Path
    import subprocess
    import sys
    data, sr = load_audio(file_obj)
    out_dir = Path("results") / "edited"
    out_dir.mkdir(parents=True, exist_ok=True)
    wav_path = save_tmp(data, sr, "tmp_export")
    mp3_path = wav_path.replace(".wav", ".mp3")
    # lame または ffmpeg で変換を試みる
    for encoder_cmd in [
        ["lame", "-b", str(int(bitrate)), wav_path, mp3_path],
        [sys.executable, "-m", "pydub.utils"],  # placeholder
        ["ffmpeg", "-i", wav_path, "-b:a", f"{int(bitrate)}k", "-y", mp3_path],
    ]:
        if encoder_cmd[0] in ("lame", "ffmpeg"):
            try:
                subprocess.run(encoder_cmd, capture_output=True, check=True)
                return mp3_path
            except (FileNotFoundError, subprocess.CalledProcessError):
                continue
    # エンコーダが見つからない場合、FLAC で代替
    flac_path = wav_path.replace(".wav", ".flac")
    sf.write(flac_path, data, sr, format="FLAC")
    return flac_path
