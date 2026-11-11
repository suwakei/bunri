"""音源合成（オーバーレイ）機能"""
import numpy as np
import soundfile as sf

from audio_utils import sec_to_samples, save_tmp, to_stereo


def overlay_audio(base_obj, overlay_obj, offset_sec, base_vol_db, overlay_vol_db):
    """ベース音源の上にオーバーレイ音源を重ねて合成する。

    ベース音源を基準に、オーバーレイ音源を指定したオフセット位置から
    加算合成する。サンプルレートが異なる場合はオーバーレイをベースに
    合わせて線形補間でリサンプルする。両音源はステレオに統一される。

    Args:
        base_obj: ベース（背景）音源のパスまたはファイルオブジェクト。None 不可。
        overlay_obj: オーバーレイ（前景）音源のパスまたはファイルオブジェクト。
            None 不可。
        offset_sec: オーバーレイを配置する開始位置（秒）。0 以上の実数。
            ベース音源の先頭からの時間オフセット。
        base_vol_db: ベース音源の音量調整量（dB）。
            0.0 で変化なし、正値で増幅、負値で減衰。
        overlay_vol_db: オーバーレイ音源の音量調整量（dB）。
            0.0 で変化なし、正値で増幅、負値で減衰。

    Returns:
        str: 保存された一時 WAV ファイルのパス。出力サンプルレートは
            ベース音源のサンプルレートに準拠する。ステレオ 2 チャンネル。

    Raises:
        ValueError: base_obj または overlay_obj が None の場合。

    Side Effects:
        results/edited/ にファイルを書き出す。
    """
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
