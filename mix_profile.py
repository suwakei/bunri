"""
bunri DAW — 曲全体のミックス特性の解析

楽曲カルテ（第1層）のミックス項目。ステム分離を使わないため「ベースのパン」
のようなステム別の値は出せないが、代わりに曲全体の特性を出す。

初心者にとってはむしろこちらの価値が高い。「なぜ市販曲は自分のミックスより
良く聞こえるのか」に答えるのは、ステム別パンではなくラウドネス・ダイナミクス・
帯域バランスだから。

CPU環境前提。重いモジュールは関数内で遅延インポートする。
"""

# 解析時のサンプルレート。ITU-R BS.1770 の K特性フィルタ係数は 48kHz 前提
LOUDNESS_SR = 48000

# ITU-R BS.1770 K特性フィルタ係数（48kHz）
# 第1段: 高域シェルビング（頭部の音響効果を模擬）
_KW_STAGE1_B = [1.53512485958697, -2.69169618940638, 1.19839281085285]
_KW_STAGE1_A = [1.0, -1.69065929318241, 0.73248077421585]
# 第2段: RLB高域通過（低域の寄与を抑える）
_KW_STAGE2_B = [1.0, -2.0, 1.0]
_KW_STAGE2_A = [1.0, -1.99004745483398, 0.99007225036621]

# ラウドネス測定のブロック長と重なり（BS.1770 準拠）
_BLOCK_SEC = 0.400
_BLOCK_OVERLAP = 0.75

# 絶対ゲート（LUFS）。これ以下のブロックは無音として除外する
_ABSOLUTE_GATE = -70.0

# 帯域分割の定義。(表示名, 下限Hz, 上限Hz)
SPECTRUM_BANDS = [
    ("sub", 20, 60),
    ("low", 60, 250),
    ("low_mid", 250, 500),
    ("mid", 500, 2000),
    ("high_mid", 2000, 6000),
    ("high", 6000, 20000),
]

# 低音がモノラルとみなせる相関の閾値
_BASS_MONO_THRESHOLD = 0.9


def analyze_mix(file_path):
    """音声ファイルから曲全体のミックス特性を解析する。

    ステム分離を行わないため、ステム別の値（ベースのパン等）は算出しない。
    出すのは曲全体としての音の傾向のみ。

    Args:
        file_path (str): 解析する音声ファイルのパス。
            モノラル・ステレオどちらも可。

    Returns:
        dict: 以下のキーを持つ辞書。算出できない項目は None になる。

        .. code-block:: python

            {
                "loudness_lufs":     float|None,  # 体感音量（ゲート済み積分ラウドネス）
                "peak_dbfs":         float|None,  # 最大ピーク
                "dynamic_range_db":  float|None,  # 音量の幅（ラウドネスレンジ相当）
                "stereo_width":      float|None,  # 0.0(モノラル)〜1.0(左右に広い)
                "bass_mono":         bool|None,   # 低音が中央にまとまっているか
                "reverb_tail_sec":   float|None,  # 残響の長さ
                "spectrum_bands": [
                    {"name": str, "hz": [int, int], "energy_db": float},
                ],
            }

        モノラル音源では ``stereo_width`` と ``bass_mono`` が None になる
        （左右の差が定義できないため）。

    Note:
        numpy, scipy, librosa を関数内で遅延インポートする。
    """
    import numpy as np
    import librosa

    # ステレオのまま読み込む。librosa は (channels, samples) を返す
    y, sr = librosa.load(file_path, sr=LOUDNESS_SR, mono=False)
    y = np.atleast_2d(y)
    if y.shape[0] == 0 or y.shape[1] == 0:
        return _empty_mix()

    is_stereo = y.shape[0] >= 2
    mono = np.mean(y, axis=0)

    return {
        "loudness_lufs": _integrated_loudness(y, sr),
        "peak_dbfs": _peak_dbfs(file_path),
        "dynamic_range_db": _loudness_range(y, sr),
        "stereo_width": _stereo_width(y) if is_stereo else None,
        "bass_mono": _bass_mono(y, sr) if is_stereo else None,
        "reverb_tail_sec": _reverb_tail(mono, sr),
        "spectrum_bands": _spectrum_bands(mono, sr),
    }


def _empty_mix():
    """解析不能だった場合の空のミックス特性辞書を返す。

    Returns:
        dict: 全項目が None（``spectrum_bands`` は空リスト）の辞書。
    """
    return {
        "loudness_lufs": None,
        "peak_dbfs": None,
        "dynamic_range_db": None,
        "stereo_width": None,
        "bass_mono": None,
        "reverb_tail_sec": None,
        "spectrum_bands": [],
    }


def _k_weight(channel, sr):
    """1チャンネルの波形に ITU-R BS.1770 の K特性フィルタを適用する。

    Args:
        channel (numpy.ndarray): モノラル波形。
        sr (int): サンプルレート（Hz）。48000 を想定。

    Returns:
        numpy.ndarray: フィルタ適用後の波形。

    Note:
        フィルタ係数は 48kHz 専用のため、呼び出し側で 48kHz に
        リサンプルしておくこと。scipy を関数内で遅延インポートする。
    """
    from scipy.signal import lfilter

    stage1 = lfilter(_KW_STAGE1_B, _KW_STAGE1_A, channel)
    return lfilter(_KW_STAGE2_B, _KW_STAGE2_A, stage1)


def _block_loudness(y, sr):
    """K特性フィルタ後の波形を 400ms ブロックに分割し、各ブロックのラウドネスを返す。

    Args:
        y (numpy.ndarray): shape=(channels, samples) の波形。
        sr (int): サンプルレート（Hz）。

    Returns:
        tuple[numpy.ndarray, numpy.ndarray]: ``(loudness, mean_square)``。
            ``loudness`` は各ブロックのラウドネス（LUFS）、
            ``mean_square`` は各ブロックのチャンネル合計平均二乗値。
            ブロックが1つも取れない場合は両方とも空配列。

    Note:
        numpy を関数内で遅延インポートする。
    """
    import numpy as np

    block = int(_BLOCK_SEC * sr)
    step = int(block * (1 - _BLOCK_OVERLAP))
    if block <= 0 or step <= 0 or y.shape[1] < block:
        return np.array([]), np.array([])

    weighted = np.vstack([_k_weight(y[ch], sr) for ch in range(y.shape[0])])

    starts = np.arange(0, weighted.shape[1] - block + 1, step)
    mean_square = np.empty(len(starts), dtype=float)
    for i, start in enumerate(starts):
        segment = weighted[:, start:start + block]
        # チャンネル重み: L/R はいずれも 1.0（サラウンドのみ異なる）
        mean_square[i] = float(np.sum(np.mean(segment ** 2, axis=1)))

    with np.errstate(divide="ignore"):
        loudness = -0.691 + 10 * np.log10(np.maximum(mean_square, 1e-12))
    return loudness, mean_square


def _integrated_loudness(y, sr):
    """ゲート処理済みの積分ラウドネス（LUFS）を算出する。

    BS.1770 に従い、絶対ゲート（-70 LUFS）と相対ゲート（ゲート後平均から
    -10 LU）の2段階でブロックを選別してから平均する。ゲートを掛けないと
    曲間の無音や静かなイントロが値を大きく引き下げてしまう。

    Args:
        y (numpy.ndarray): shape=(channels, samples) の波形。
        sr (int): サンプルレート（Hz）。

    Returns:
        float | None: 積分ラウドネス（LUFS）。有効なブロックが1つも無い
            （全編が無音に近い）場合は None。

    Note:
        numpy を関数内で遅延インポートする。
    """
    import numpy as np

    loudness, mean_square = _block_loudness(y, sr)
    if len(loudness) == 0:
        return None

    # 絶対ゲート
    mask = loudness > _ABSOLUTE_GATE
    if not np.any(mask):
        return None

    # 相対ゲート: 絶対ゲート通過分の平均から -10 LU
    gated_mean = float(np.mean(mean_square[mask]))
    relative_gate = -0.691 + 10 * np.log10(max(gated_mean, 1e-12)) - 10.0
    mask &= loudness > relative_gate
    if not np.any(mask):
        return None

    final_mean = float(np.mean(mean_square[mask]))
    return float(-0.691 + 10 * np.log10(max(final_mean, 1e-12)))


def _loudness_range(y, sr):
    """曲中のラウドネスの幅（ラウドネスレンジ相当）を dB で返す。

    ブロックラウドネスの 95 パーセンタイルと 10 パーセンタイルの差を取る。
    値が小さいほど「ずっと大きい音」で迫力は出るが抑揚が失われる。

    Args:
        y (numpy.ndarray): shape=(channels, samples) の波形。
        sr (int): サンプルレート（Hz）。

    Returns:
        float | None: ラウドネスレンジ（dB）。有効なブロックが不足する場合は None。

    Note:
        numpy を関数内で遅延インポートする。
    """
    import numpy as np

    loudness, _ = _block_loudness(y, sr)
    valid = loudness[loudness > _ABSOLUTE_GATE] if len(loudness) else loudness
    if len(valid) < 4:
        return None
    return float(np.percentile(valid, 95) - np.percentile(valid, 10))


def _peak_dbfs(file_path, block_size=1 << 20):
    """ファイルの最大絶対値（サンプルピーク）を dBFS で返す。

    ラウドネス測定用にリサンプルした波形ではなく、元のサンプルレートの
    ファイルから直接測る。リサンプルは鋭いピークを鈍らせるため、そちらで
    測ると「音が割れているか」の判断を誤らせる。

    長尺ファイルでメモリを食わないようブロック単位でストリーミングする。

    Args:
        file_path (str): 音声ファイルのパス。
        block_size (int, optional): 一度に読むフレーム数。デフォルト 1M。

    Returns:
        float | None: ピーク値（dBFS）。完全な無音、または読み込みに
            失敗した場合は None。

    Note:
        numpy と soundfile を関数内で遅延インポートする。
    """
    import numpy as np
    import soundfile as sf

    try:
        peak = 0.0
        for block in sf.blocks(str(file_path), blocksize=block_size, always_2d=True):
            if block.size:
                peak = max(peak, float(np.max(np.abs(block))))
    except Exception:
        return None

    if peak <= 0:
        return None
    return float(20 * np.log10(peak))


def _stereo_width(y):
    """Mid/Side のエネルギー比からステレオの広がりを 0.0〜1.0 で返す。

    0.0 は完全なモノラル（左右が同一）、1.0 は左右が完全に独立した状態。
    Side 成分が全体に占める割合として定義するため、直感的に「広がり」として
    読める値になる。

    Args:
        y (numpy.ndarray): shape=(channels, samples) の波形。2ch 以上を想定。

    Returns:
        float | None: ステレオ幅（0.0〜1.0）。無音の場合は None。

    Note:
        numpy を関数内で遅延インポートする。
    """
    import numpy as np

    left, right = y[0], y[1]
    mid = (left + right) / 2
    side = (left - right) / 2
    mid_rms = float(np.sqrt(np.mean(mid ** 2)))
    side_rms = float(np.sqrt(np.mean(side ** 2)))
    total = mid_rms + side_rms
    if total <= 0:
        return None
    return float(min(1.0, side_rms / total * 2))


def _bass_mono(y, sr, cutoff_hz=120):
    """低音域が左右中央にまとまっているかを判定する。

    市販曲は低音をモノラルにするのが定石で、そのほうが低音が力強く聞こえる。
    低域通過フィルタを掛けた L/R の相関が閾値を超えればモノラルとみなす。

    Args:
        y (numpy.ndarray): shape=(channels, samples) の波形。2ch 以上を想定。
        sr (int): サンプルレート（Hz）。
        cutoff_hz (int, optional): 低音とみなす上限周波数。デフォルト 120。

    Returns:
        bool | None: 低音がモノラルなら True。低域にエネルギーが無く
            判定できない場合は None。

    Note:
        numpy と scipy を関数内で遅延インポートする。
    """
    import numpy as np
    from scipy.signal import butter, sosfilt

    sos = butter(4, cutoff_hz, btype="low", fs=sr, output="sos")
    left = sosfilt(sos, y[0])
    right = sosfilt(sos, y[1])

    if np.std(left) == 0 or np.std(right) == 0:
        return None
    corr = float(np.corrcoef(left, right)[0, 1])
    if not np.isfinite(corr):
        return None
    return bool(corr > _BASS_MONO_THRESHOLD)


def _reverb_tail(mono, sr, max_events=40):
    """強いオンセットの後の減衰時間から残響の長さを推定する。

    各オンセット直後のエネルギー包絡が局所ピークから 20dB 落ちるまでの時間
    （T20）を測り、RT60 相当に外挿（3倍）して中央値を返す。曲末尾の減衰だけを
    見る方式と違い、曲中のフェードアウトや無音に影響されにくい。

    Args:
        mono (numpy.ndarray): モノラル波形。
        sr (int): サンプルレート（Hz）。
        max_events (int, optional): 評価するオンセットの最大数。デフォルト 40。

    Returns:
        float | None: 推定残響時間（秒）。オンセットが検出できない、または
            有効な減衰が1つも測れない場合は None。

    Note:
        numpy と librosa を関数内で遅延インポートする。
    """
    import numpy as np
    import librosa

    hop = 512
    onsets = librosa.onset.onset_detect(y=mono, sr=sr, hop_length=hop, units="frames")
    if len(onsets) == 0:
        return None

    envelope = librosa.feature.rms(y=mono, hop_length=hop)[0]
    if len(envelope) == 0:
        return None
    with np.errstate(divide="ignore"):
        env_db = 20 * np.log10(np.maximum(envelope, 1e-8))

    frame_sec = hop / sr
    decays = []
    # オンセットが多い曲では等間隔に間引いて評価する
    step = max(1, len(onsets) // max_events)
    for frame in onsets[::step]:
        peak_db = env_db[frame]
        # 次のオンセットまで、最長1.5秒を見る
        limit = min(len(env_db), frame + int(1.5 / frame_sec))
        target = peak_db - 20.0
        for i in range(frame + 1, limit):
            if env_db[i] <= target:
                decays.append((i - frame) * frame_sec * 3.0)  # T20 -> RT60
                break

    if not decays:
        return None
    return float(np.median(decays))


def _spectrum_bands(mono, sr):
    """帯域ごとのエネルギー配分を dB で返す。

    低音が厚いのか高音がきらびやかなのか、曲全体の音の傾向を示す。

    Args:
        mono (numpy.ndarray): モノラル波形。
        sr (int): サンプルレート（Hz）。

    Returns:
        list[dict]: 各要素は ``{"name": str, "hz": [int, int], "energy_db": float}``。
            SPECTRUM_BANDS の定義順で返す。エネルギーが無い帯域は -120.0。

    Note:
        numpy を関数内で遅延インポートする。
    """
    import numpy as np

    spectrum = np.abs(np.fft.rfft(mono))
    freqs = np.fft.rfftfreq(len(mono), 1 / sr)
    if len(spectrum) == 0:
        return []

    bands = []
    for name, low, high in SPECTRUM_BANDS:
        mask = (freqs >= low) & (freqs < min(high, sr / 2))
        if not np.any(mask):
            energy_db = -120.0
        else:
            energy = float(np.sqrt(np.mean(spectrum[mask] ** 2)))
            energy_db = float(20 * np.log10(max(energy, 1e-6)))
        bands.append({"name": name, "hz": [int(low), int(high)], "energy_db": energy_db})

    return bands
