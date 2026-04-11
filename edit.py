"""音声編集機能"""
import numpy as np
import soundfile as sf

from audio_utils import load_audio, sec_to_samples, save_tmp, to_stereo


def trim_audio(file_obj, start_sec, end_sec):
    """指定範囲を切り出し（トリム）"""
    data, sr = load_audio(file_obj)
    s = sec_to_samples(start_sec, sr)
    e = sec_to_samples(end_sec, sr)
    if s >= e:
        raise ValueError("開始が終了以降になっています")
    return save_tmp(data[s:e], sr, "trim")


def cut_audio(file_obj, start_sec, end_sec):
    """指定範囲を削除（カット）— 範囲外を結合"""
    data, sr = load_audio(file_obj)
    s = sec_to_samples(start_sec, sr)
    e = sec_to_samples(end_sec, sr)
    if s >= e:
        raise ValueError("開始が終了以降になっています")
    return save_tmp(np.concatenate([data[:s], data[e:]]), sr, "cut")


def split_at(file_obj, split_sec):
    """指定位置で前後2つに分割"""
    data, sr = load_audio(file_obj)
    s = sec_to_samples(split_sec, sr)
    if s <= 0 or s >= len(data):
        raise ValueError("分割位置がファイルの範囲外です")
    return save_tmp(data[:s], sr, "split_A"), save_tmp(data[s:], sr, "split_B")


def copy_range(file_obj, start_sec, end_sec, insert_sec):
    """指定範囲をコピーして別の位置に挿入"""
    data, sr = load_audio(file_obj)
    s = sec_to_samples(start_sec, sr)
    e = sec_to_samples(end_sec, sr)
    ins = sec_to_samples(insert_sec, sr)
    if s >= e:
        raise ValueError("コピー範囲の開始が終了以降になっています")
    copied = data[s:e]
    return save_tmp(np.concatenate([data[:ins], copied, data[ins:]]), sr, "copy")


def change_volume(file_obj, db):
    """音量をdB単位で変更"""
    data, sr = load_audio(file_obj)
    gain = 10 ** (db / 20)
    return save_tmp(np.clip(data * gain, -1.0, 1.0), sr, "vol")


def fade_in(file_obj, duration_sec):
    """先頭からフェードイン"""
    data, sr = load_audio(file_obj)
    n = min(sec_to_samples(duration_sec, sr), len(data))
    fade = np.linspace(0.0, 1.0, n)
    if data.ndim == 2:
        fade = fade[:, np.newaxis]
    data[:n] = data[:n] * fade
    return save_tmp(data, sr, "fadein")


def fade_out(file_obj, duration_sec):
    """末尾にフェードアウト"""
    data, sr = load_audio(file_obj)
    n = min(sec_to_samples(duration_sec, sr), len(data))
    fade = np.linspace(1.0, 0.0, n)
    if data.ndim == 2:
        fade = fade[:, np.newaxis]
    data[-n:] = data[-n:] * fade
    return save_tmp(data, sr, "fadeout")


def insert_silence(file_obj, position_sec, length_sec):
    """指定位置に無音を挿入"""
    data, sr = load_audio(file_obj)
    pos = sec_to_samples(position_sec, sr)
    silence_len = sec_to_samples(length_sec, sr)
    if data.ndim == 2:
        silence = np.zeros((silence_len, data.shape[1]))
    else:
        silence = np.zeros(silence_len)
    return save_tmp(np.concatenate([data[:pos], silence, data[pos:]]), sr, "silence")


def normalize_audio(file_obj):
    """音量を最大まで正規化（ノーマライズ）"""
    data, sr = load_audio(file_obj)
    peak = np.max(np.abs(data))
    if peak == 0:
        raise ValueError("無音のファイルです")
    return save_tmp(data / peak, sr, "norm")


def reverse_audio(file_obj):
    """音声を逆再生"""
    data, sr = load_audio(file_obj)
    return save_tmp(data[::-1].copy(), sr, "reverse")


def loop_range(file_obj, start_sec, end_sec, count):
    """指定範囲をN回繰り返す"""
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
    """左右バランス（パン）を調整。-1.0=左, 0=中央, 1.0=右"""
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
    """再生速度を変更（ピッチも変わる簡易版）"""
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
    """2つのWAVファイルを結合"""
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
    """WAVをMP3に書き出し（lameが必要、なければsoundfileでFLAC代替）"""
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
