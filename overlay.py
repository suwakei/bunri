"""音源合成（オーバーレイ）機能"""
import numpy as np
import soundfile as sf

from audio_utils import sec_to_samples, save_tmp, to_stereo


def overlay_audio(base_obj, overlay_obj, offset_sec, base_vol_db, overlay_vol_db):
    """ベース音源の上にオーバーレイ音源を重ねる"""
    if base_obj is None or overlay_obj is None:
        raise ValueError("ベースとオーバーレイの両方のファイルをアップロードしてください")

    base, sr_base = sf.read(base_obj)
    over, sr_over = sf.read(overlay_obj)

    # サンプルレートが違う場合、オーバーレイをベースに合わせてリサンプル（簡易線形補間）
    if sr_over != sr_base:
        orig_len = len(over)
        new_len = int(orig_len * sr_base / sr_over)
        x_old = np.linspace(0, 1, orig_len)
        x_new = np.linspace(0, 1, new_len)
        if over.ndim == 2:
            over = np.column_stack([
                np.interp(x_new, x_old, over[:, ch])
                for ch in range(over.shape[1])
            ])
        else:
            over = np.interp(x_new, x_old, over)

    # ステレオに統一
    base = to_stereo(base)
    over = to_stereo(over)

    # 音量調整
    base = base * (10 ** (base_vol_db / 20))
    over = over * (10 ** (overlay_vol_db / 20))

    # オフセット位置にオーバーレイを配置
    offset = sec_to_samples(offset_sec, sr_base)
    total_len = max(len(base), offset + len(over))

    mixed = np.zeros((total_len, 2))
    mixed[:len(base)] += base
    mixed[offset:offset + len(over)] += over

    return save_tmp(np.clip(mixed, -1.0, 1.0), sr_base, "overlay")
