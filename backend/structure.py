"""
bunri DAW — 時間構造の解析（グリッド推定・セクション検出）

楽曲カルテ（第1層）の土台。BPM・ダウンビート・実測ビート列を求め、
そのうえで曲を区間に分割する。

グリッドが崩れるとカルテ全体（コード・セクション）が崩れるため、
このモジュールの精度がカルテ全体の信頼性を決める。

グリッド推定の考え方（``estimate_grid``）:

1. **テンポは候補を総当たりして選ぶ。** 60〜200 BPM の候補すべてでビートを追跡し、
   「その間隔で音が繰り返しているか」「強い音が拍に乗っているか」「小節ごとに同じ強弱が
   繰り返すか」で点を付ける。
   1 つの推定値を後から倍・半分に直すやり方では、2/3 倍や 5/4 倍の取り違えを直せないため
2. **小節頭は、コードの変わり目と低音で決める。** 音の大きさだけで決めると、
   スネア（2・4 拍）のほうが大きい曲で必ず外れるため
3. **決め手が無いときは確信度を下げる。** 倍・半分のどちらとも取れる曲、音の立ち上がりが
   まばらな曲では、値は出すが確信度を低くする

それでも外れる前提で、``estimate_grid`` は BPM とオフセットの上書きを受け付ける
（ユーザーがグリッド補正UIで直す経路）。

CPU環境前提。重いモジュールは関数内で遅延インポートする。
"""

# 解析時のサンプルレート。ビート検出には十分で、読み込みが軽い
ANALYSIS_SR = 22050
HOP_LENGTH = 512
N_FFT = 2048

# BPM の妥当範囲。候補はこの範囲からだけ選ぶ
BPM_MIN = 60.0
BPM_MAX = 200.0

# テンポの事前分布。倍/半分のどちらとも取れるときに、この中心に近い候補を優先する。
# 人が拍として感じやすいテンポは 120 BPM 前後に集まる（拍の知覚の共鳴モデル）。
# 幅は 1 オクターブ（librosa のテンポ推定の既定と同じ）。60 BPM と 240 BPM で約 0.6 倍になる
# ゆるい山なので、音がはっきり一方を示していれば、そちらが勝つ
_TEMPO_PRIOR_CENTER_BPM = 120.0
_TEMPO_PRIOR_OCTAVES = 1.0

# 拍と音の立ち上がりが「同じ位置」とみなす幅（フレーム数。1 フレーム = 約 23ms）
_BEAT_TOLERANCE_FRAMES = 2

# 確信度の物差し（暫定）。周期の強さがこれ以上なら「拍がはっきり繰り返している」、
# 次点の候補との点差（割合）がこれ以上なら「引き離している」とみなす。
# 合成音源と、正解の注釈が無い実曲 8 曲から決めた値で、実曲での合わせ込みは済んでいない
# （docs/grid-estimation.md の「実際の曲では確かめきれていない」）
_CLEAR_PERIODICITY = 0.4
_CLEAR_SEPARATION = 0.35

# 強さ（振幅の増え方）の山が、拍の位置より後ろに来てもよい幅（フレーム数）。
# 拍は音の立ち上がりの「始まり」に置かれるが、振幅がいちばん急に増えるのはその少し後。
# 立ち上がりの遅い音（パッド、弦）では 3〜4 フレーム（約 80ms）遅れる
_ACCENT_LAG_FRAMES = 4

# 確信度と採点で、拍と音の対応がこれ以上なら「十分」とみなす（これより上は区別しない）。
# 強い音の半分が拍に乗っていれば、拍として成り立つ。それ以上を求めると、8 分や 16 分の刻みまで
# 拾える「倍のテンポ」が必ず有利になってしまう（拍の間に細かい音が在るのは普通のこと）
_ENOUGH_RECALL = 0.5

# これ未満の山は、音の立ち上がりとして数えない（雑音）
_PEAK_FLOOR = 0.05

# 低音（キック・ベース）とみなす帯域の上限
_LOW_BAND_HZ = 200.0

# 小節頭を決める手がかりの重み。コードの変わり目 > 低音の立ち上がり > 全帯域の音の大きさ。
# 拍節の知覚の研究（Lerdahl & Jackendoff の拍節選好規則、Goto 2001、Davies & Plumbley 2006）で、
# 和声の変化と低音が小節頭のいちばん強い手がかりとされていることに沿う
_CUE_WEIGHTS = (("harmony", 1.0), ("low", 0.6), ("onset", 0.3))

# 手がかりで決まらないときにだけ効く弱い仮定:「曲は小節の頭から始まる」
_START_BONUS = 0.3

# 小節頭の候補の点差がこれ以上あれば、小節頭ははっきり決まったとみなす（暫定。上と同じ）
_DOWNBEAT_CLEAR_MARGIN = 0.8

# dB のオンセット強度は、実際の音の立ち上がりより約 1 フレーム遅れて山になる
# （合成音源での実測で 20〜30ms。位置がフレーム単位に切り上がる分と、窓が音に掛かり始めてから
# 値が伸びきるまでの分）。その分を戻す
_ONSET_LATENCY_SEC = HOP_LENGTH / ANALYSIS_SR

# グリッドを曲頭へ延ばすとき、これだけ 0 秒より前にはみ出しても「曲頭ちょうど」とみなす
_GRID_START_TOLERANCE_SEC = 0.05

# 無音とみなす音量（いちばん大きいフレームに対する比。-50 dB）
_SILENCE_RATIO = 10 ** (-50 / 20)


def estimate_grid(file_path, bpm=None, downbeat_offset=None, beats_per_bar=4):
    """音声ファイルからビートグリッド（BPM・ダウンビート・実測ビート列）を推定する。

    ``bpm`` と ``downbeat_offset`` を指定すると自動検出を行わず、その値で
    グリッドを構築する。ユーザーがグリッド補正UIで修正した値を反映する
    経路であり、``bpm_source`` が ``"user"`` になる。

    Args:
        file_path (str): 解析する音声ファイルのパス。
        bpm (float | None, optional): BPM の上書き値。None なら自動検出。
        downbeat_offset (float | None, optional): 1拍目の位置（秒）の上書き値。
            None なら自動推定。
        beats_per_bar (int, optional): 1小節あたりの拍数。デフォルト 4。
            拍子は自動検出せず、ユーザーの指定を信頼する。

    Returns:
        dict: 以下のキーを持つ辞書。

        .. code-block:: python

            {
                "bpm":                 float,
                "bpm_confidence":      float,       # 0.0〜1.0
                "bpm_source":          str,         # "auto" | "user"
                "downbeat_offset_sec": float,
                "time_signature":      [int, int],  # 例: [4, 4]
                "beat_times_sec":      list[float],
                "user_confirmed":      bool,
            }

        音声が空、またはビートを追跡できない（無音など）場合は、BPM 120・
        ビート列が空の既定グリッドを確信度 0.0 で返す。

    Note:
        ``beat_times_sec`` は実測のビート位置であり、固定 BPM から計算した
        等間隔の列ではない。テンポが揺れる生演奏でも秒↔小節・拍の変換が
        正確に保たれるようにするため。先頭の要素が 1 小節目の 1 拍目で、
        ``downbeat_offset_sec`` と一致する。``bpm`` はこの列の間隔と一致する。

        ``bpm_confidence`` は、テンポと小節頭の両方がどれだけはっきり決まったかを表す
        （どちらかが曖昧なら下がる）。
        numpy および librosa を関数内で遅延インポートする。
    """
    import librosa

    y, sr = librosa.load(file_path, sr=ANALYSIS_SR, mono=True)
    duration_sec = len(y) / sr if sr else 0.0
    per_bar = max(1, int(beats_per_bar))

    if bpm:
        # ユーザー指定の BPM。等間隔でビート列を組み立てる
        offset = float(downbeat_offset) if downbeat_offset is not None else 0.0
        beat_times = _build_uniform_beats(float(bpm), offset, duration_sec) if len(y) else []
        return _grid_dict(float(bpm) if len(y) else 120.0, 1.0 if len(y) else 0.0, "user",
                          offset if len(y) else 0.0, per_bar, beat_times)

    analysis = _analyze_grid(y, sr, per_bar) if len(y) else None
    if analysis is None:
        return _grid_dict(120.0, 0.0, "auto", 0.0, per_bar, [])

    beat_times = analysis["beat_times"]
    offset = analysis["downbeat_offset_sec"]
    if downbeat_offset is not None:
        offset = float(downbeat_offset)
        # ダウンビートより前のビートは切り捨てる（1拍目をグリッドの起点にする）
        beat_times = [t for t in beat_times if t >= offset - 1e-6]

    return _grid_dict(analysis["bpm"], analysis["confidence"], "auto", offset, per_bar, beat_times)


def _grid_dict(bpm, confidence, source, offset, per_bar, beat_times):
    """``estimate_grid`` の返り値を組み立てる。

    Args:
        bpm (float): テンポ。
        confidence (float): 確信度（0.0〜1.0）。
        source (str): ``"auto"`` か ``"user"``。
        offset (float): 1拍目の位置（秒）。
        per_bar (int): 1小節あたりの拍数。
        beat_times (list[float]): ビート位置（秒）。

    Returns:
        dict: ``estimate_grid`` の Returns に書いた形の辞書。
    """
    return {
        "bpm": float(bpm),
        "bpm_confidence": float(confidence),
        "bpm_source": source,
        "downbeat_offset_sec": float(offset),
        "time_signature": [int(per_bar), 4],
        "beat_times_sec": [float(t) for t in beat_times],
        "user_confirmed": source == "user",
    }


def _analyze_grid(y, sr, per_bar):
    """波形からグリッドを自動推定する（テンポ → 小節頭 → 曲の端までの延長）。

    Args:
        y (numpy.ndarray): モノラル波形（空でないこと）。
        sr (int): サンプルレート（Hz）。
        per_bar (int): 1小節あたりの拍数。

    Returns:
        dict | None: ビートを追跡できなければ None。できれば以下の辞書。

        .. code-block:: python

            {
                "bpm":                  float,
                "confidence":           float,        # テンポと小節頭を合わせた確信度
                "tempo_confidence":     float,        # テンポだけの確信度
                "downbeat_confidence":  float,        # 小節頭だけの確信度
                "downbeat_offset_sec":  float,
                "beat_times":           list[float],  # 先頭が 1 小節目の 1 拍目
                "candidates":           list[dict],   # 点の高い順のテンポ候補（調査用）
            }
    """
    import numpy as np

    features = _analysis_features(y, sr)
    candidates = _score_tempo_candidates(features, sr, per_bar)
    if not candidates:
        return None

    best = candidates[0]
    tempo_confidence = _tempo_confidence(candidates)
    phase, downbeat_confidence = _estimate_downbeat_phase(best["beat_frames"], features, per_bar)

    beat_times = best["beat_frames"] * HOP_LENGTH / sr - _ONSET_LATENCY_SEC
    beat_times = [float(t) for t in np.maximum(beat_times, 0.0)]
    # 静かなイントロではビート検出が曲頭から始まらず、小節番号が丸ごと
    # ずれる。位相を保ったまま小節単位で先頭方向へ外挿して補う
    beat_times, offset = _extend_grid_backward(beat_times, phase, per_bar)
    beat_times = _extend_grid_forward(beat_times, features["sound_end_sec"], len(y) / sr)

    # 小節頭が曖昧なら、小節番号もコードの拍位置も当てにならない。全体の確信度に強く反映する
    # （拍子が 1 拍なら小節頭の曖昧さは無い）。手がかりが無く「曲は小節の頭から始まる」の
    # 仮定だけで決めた場合（downbeat_confidence が 0.4 弱）は、テンポが確実でも「たぶん」止まり、
    # 手がかりが割れている場合は「自信なし」になる
    confidence = tempo_confidence
    if per_bar > 1:
        confidence *= 0.1 + 0.9 * downbeat_confidence

    return {
        "bpm": best["bpm"],
        "confidence": float(max(0.0, min(1.0, confidence))),
        "tempo_confidence": tempo_confidence,
        "downbeat_confidence": downbeat_confidence,
        "downbeat_offset_sec": offset,
        "beat_times": beat_times,
        "candidates": [
            {k: c[k] for k in ("bpm", "score", "periodicity", "recall", "meter", "prior")}
            for c in candidates
        ],
    }


def _analysis_features(y, sr):
    """グリッド推定に使う特徴量を、1 回の短時間フーリエ変換からまとめて作る。

    Args:
        y (numpy.ndarray): モノラル波形。
        sr (int): サンプルレート（Hz）。

    Returns:
        dict: 以下のキーを持つ辞書（配列はすべてフレーム単位）。

        .. code-block:: python

            {
                "onset_env":      numpy.ndarray,  # dB のオンセット強度（ビート追跡に渡す）
                "accent_env":     numpy.ndarray,  # 音の立ち上がりの強さ（振幅の増え方）
                "accent_norm":    numpy.ndarray,  # 同、前後 8 秒の最大値を 1 とした相対値
                "low_norm":       numpy.ndarray,  # 同、低音域だけ
                "chroma":         numpy.ndarray,  # クロマ（12 × フレーム数）
                "peaks":          numpy.ndarray,  # 音の立ち上がり（accent_norm の山）のフレーム番号
                "peak_strengths": numpy.ndarray,  # 各山の強さ（accent_norm の値）
                "sound_start_frame": int,         # 音が鳴り始めるフレーム
                "sound_end_sec":  float,          # 音が鳴り終わる位置（秒）
            }
    """
    import numpy as np
    import librosa

    power = np.abs(librosa.stft(y, n_fft=N_FFT, hop_length=HOP_LENGTH)) ** 2
    mel = librosa.feature.melspectrogram(S=power, sr=sr, n_fft=N_FFT, hop_length=HOP_LENGTH)
    # 拍の位置を探すのには、librosa の既定どおり dB のオンセット強度を使う。
    # 小さな音の立ち上がりも拾い、立ち上がりの「始まり」に山が立つので、位置が正確
    onset_env = librosa.onset.onset_strength(S=librosa.power_to_db(mel), sr=sr, hop_length=HOP_LENGTH)

    # 一方、どの音が「強い」かは、dB ではなく振幅の増え方で測る。dB では小さなハイハットの
    # 刻みがキックやスネアと同じ強さに見え、刻みのほうを拍と取り違えやすい
    amplitude = np.sqrt(mel)
    accent_env = librosa.onset.onset_strength(S=amplitude, sr=sr, hop_length=HOP_LENGTH)
    mel_freqs = librosa.mel_frequencies(n_mels=mel.shape[0], fmax=sr / 2)
    low_bins = max(2, int(np.sum(mel_freqs < _LOW_BAND_HZ)))
    low_env = librosa.onset.onset_strength(S=amplitude[:low_bins], sr=sr, hop_length=HOP_LENGTH)

    # 調律の推定は省く（コードの「変わり目」を見るだけなので、半音未満のずれは影響しない）
    chroma = librosa.feature.chroma_stft(S=power, sr=sr, n_fft=N_FFT, hop_length=HOP_LENGTH, tuning=0.0)

    frame_rate = sr / HOP_LENGTH
    accent_norm = _local_normalize(accent_env, frame_rate)
    peaks, strengths = _pick_onset_peaks(accent_norm)

    frame_level = np.sqrt(np.mean(power, axis=0))
    sounding = np.flatnonzero(frame_level > float(np.max(frame_level)) * _SILENCE_RATIO)
    start_frame = int(sounding[0]) if len(sounding) else 0
    end_frame = int(sounding[-1]) + 1 if len(sounding) else len(frame_level)

    return {
        "onset_env": onset_env,
        "accent_env": accent_env,
        "accent_norm": accent_norm,
        "low_norm": _local_normalize(low_env, frame_rate),
        "chroma": chroma,
        "peaks": peaks,
        "peak_strengths": strengths,
        "sound_start_frame": start_frame,
        "sound_end_sec": float(end_frame * HOP_LENGTH / sr),
    }


def _local_normalize(env, frame_rate, window_sec=8.0):
    """音の立ち上がりの強さを、その前後の最大値で割って 0〜1 の相対値にする。

    静かな区間と大きい区間で同じ物差しを使えるようにするため。曲全体の最大値で割ると、
    静かなイントロの拍が「弱い音」として扱われてしまう。

    Args:
        env (numpy.ndarray): 音の立ち上がりの強さの時系列。
        frame_rate (float): 1 秒あたりのフレーム数。
        window_sec (float, optional): 最大値を取る窓の長さ（秒）。

    Returns:
        numpy.ndarray: 相対値（0〜1）。無音に近い区間を持ち上げないよう、
            窓の最大値は曲全体の最大値の 1 割を下限にする。
    """
    import numpy as np
    from scipy.ndimage import maximum_filter1d

    if len(env) == 0 or float(np.max(env)) <= 0:
        return np.zeros(len(env))
    size = max(3, int(round(frame_rate * window_sec)) | 1)
    local_max = maximum_filter1d(env, size=size, mode="nearest")
    return np.clip(env / np.maximum(local_max, 0.1 * float(np.max(env))), 0.0, 1.0)


def _pick_onset_peaks(accent_norm):
    """音の立ち上がり（強さの時系列の山）を拾う。

    Args:
        accent_norm (numpy.ndarray): 音の立ち上がりの強さの相対値（0〜1）。

    Returns:
        tuple[numpy.ndarray, numpy.ndarray]: ``(フレーム番号, 強さ)``。
            前後 ``_BEAT_TOLERANCE_FRAMES`` フレームの中で最大で、``_PEAK_FLOOR`` 以上のもの。
    """
    import numpy as np
    from scipy.ndimage import maximum_filter1d

    if len(accent_norm) == 0:
        return np.zeros(0, dtype=int), np.zeros(0)
    neighborhood = maximum_filter1d(accent_norm, size=2 * _BEAT_TOLERANCE_FRAMES + 1, mode="nearest")
    frames = np.flatnonzero((accent_norm >= neighborhood) & (accent_norm >= _PEAK_FLOOR))
    return frames, accent_norm[frames]


def _score_tempo_candidates(features, sr, per_bar):
    """範囲内のテンポ候補すべてでビートを追跡し、点の高い順に並べて返す。

    librosa のテンポ推定は 1 つの値しか返さず、8 分音符が続く曲で 2/3 倍（付点 4 分）を、
    音の立ち上がりがまばらな曲で 5/4 倍を返すことがある。そこで候補を総当たりし、
    追跡した拍の列そのものを評価して選ぶ（追跡は 1 回数ミリ秒なので、総当たりでも軽い）。

    点は 4 つの積:

    - **周期の強さ**（``periodicity``）: 音の立ち上がりの並びが、その拍の間隔と、その 2 倍・3 倍…
      （1 小節まで）の間隔で、どれだけ繰り返しているか（自己相関）。テンポ推定の標準的な
      手がかりで、伸ばした音や休符が多い実際の曲でも崩れにくい
    - **拍と音の対応**（``recall``）: 強い音の立ち上がりのうち、追跡した拍の位置に在るものの割合
      （偶然に重なる分を引いたもの）。遅すぎる候補や、拍が音からずれた候補で下がる。
      ``_ENOUGH_RECALL`` で頭打ちにする（半分が拍に乗っていれば十分。それ以上を点にすると、
      細かい刻みまで拾える倍のテンポが必ず有利になる）。
      逆の「拍のうち音が在るものの割合」は点に入れない。伸ばした音の上では、
      正しいテンポでも音の無い拍が普通に在るため
    - **小節の繰り返し**（``meter``）: 拍ごとの強弱が、小節内の位置でどれだけ説明できるか。
      コードが小節ごとに変わる曲で、付点 4 分のような「小節に収まらない拍」を落とす
    - **テンポの事前分布**（``prior``）: 120 BPM を頂点に、離れるほどゆるく割り引く。
      倍・半分のどちらとも取れるときの決め手

    Args:
        features (dict): ``_analysis_features`` の返り値。
        sr (int): サンプルレート（Hz）。
        per_bar (int): 1小節あたりの拍数。

    Returns:
        list[dict]: 候補のリスト（点の高い順。同じテンポに落ち着いた候補は 1 つにまとめる）。
            各要素は ``bpm`` / ``beat_frames`` / ``score`` / ``periodicity`` / ``recall`` /
            ``meter`` / ``prior`` を持つ。追跡できる候補が無ければ空。
    """
    import numpy as np
    import librosa

    onset_env = features["onset_env"]
    if len(onset_env) == 0 or not np.any(onset_env > 0):
        return []

    frame_rate = sr / HOP_LENGTH
    shortest = int(np.floor(frame_rate * 60.0 / BPM_MAX))
    longest = int(np.ceil(frame_rate * 60.0 / BPM_MIN))
    autocorrelation = _onset_autocorrelation(features["accent_env"], frame_rate)

    scored = []
    for period in range(max(2, shortest), longest + 1):
        _, beat_frames = librosa.beat.beat_track(
            onset_envelope=onset_env, sr=sr, hop_length=HOP_LENGTH, bpm=frame_rate * 60.0 / period
        )
        beat_frames = _repair_edge_beats(np.asarray(beat_frames, dtype=int))
        if len(beat_frames) < 4:
            continue
        # BPM は、実測ビート列の全体スパンから出す。個々の間隔はフレーム幅（約 23ms）に
        # 丸められて揺れるが、スパン全体で平均すれば丸めの誤差は打ち消える
        beat_period = float(beat_frames[-1] - beat_frames[0]) / (len(beat_frames) - 1)
        bpm = 60.0 * frame_rate / beat_period
        if not (BPM_MIN * 0.97 <= bpm <= BPM_MAX * 1.03):
            continue
        # 追跡は、渡した間隔から少し外れたテンポにも食らいつく。その結果、落ち着いた間隔が
        # 渡した間隔と食い違う候補は、隣のテンポを「合わない物差し」で追った写しで、
        # 音のまばらな区間（コードだけのイントロなど）で拍が物差しのほうへ流れてしまう。
        # 同じテンポは、合う物差しで追った候補が別に在るので、こちらは捨てる
        if abs(beat_period - period) > max(0.75, 0.03 * period):
            continue
        periodicity = _comb_periodicity(autocorrelation, beat_period, per_bar)
        recall = _beat_onset_recall(beat_frames, features, beat_period)
        meter = max(
            _phase_profile(values, per_bar)[1]
            for values in _beat_cues(beat_frames, features, per_bar).values()
        )
        prior = _tempo_prior(bpm)
        scored.append({
            "bpm": float(bpm), "beat_frames": beat_frames,
            "score": float(periodicity * min(1.0, recall / _ENOUGH_RECALL) * (1.0 + meter) / 2.0 * prior),
            "periodicity": float(periodicity), "recall": float(recall),
            "meter": float(meter), "prior": float(prior),
        })

    # 追跡は多少のテンポの違いを吸収するので、隣り合う候補は同じ拍の列に落ち着く。1 つにまとめる
    scored.sort(key=lambda c: c["score"], reverse=True)
    distinct = []
    for candidate in scored:
        if all(abs(candidate["bpm"] / kept["bpm"] - 1.0) > 0.04 for kept in distinct):
            distinct.append(candidate)
    return distinct


def _onset_autocorrelation(accent_env, frame_rate, window_sec=12.0):
    """音の立ち上がりの強さの自己相関を、ずらし幅（フレーム数）ごとに返す。

    曲を 12 秒ずつの窓に区切って窓ごとに自己相関を取り、平均する。曲全体で 1 回だけ取ると、
    テンポが少しずつ揺れる曲で、長いずらし幅の山がぼやけるため。

    Args:
        accent_env (numpy.ndarray): 音の立ち上がりの強さの時系列。
        frame_rate (float): 1 秒あたりのフレーム数。
        window_sec (float, optional): 窓の長さ（秒）。

    Returns:
        numpy.ndarray: ずらし幅 0 を 1 とした自己相関（長さは窓の半分まで）。
            平均を引いてから取るので、繰り返しの無いずらし幅では 0 付近になる。
    """
    import numpy as np
    import librosa

    window = int(min(len(accent_env), round(frame_rate * window_sec)))
    if window < 8:
        return np.zeros(1)
    taper = np.hanning(window)
    total = np.zeros(window // 2)
    count = 0
    for start in range(0, max(1, len(accent_env) - window + 1), max(1, window // 4)):
        segment = accent_env[start:start + window]
        segment = (segment - segment.mean()) * taper
        correlation = librosa.autocorrelate(segment, max_size=window // 2)
        if correlation[0] > 0:
            total += correlation / correlation[0]
            count += 1
    return total / count if count else total


def _comb_periodicity(autocorrelation, beat_period, per_bar):
    """拍の間隔と、その整数倍（1 小節まで）での自己相関の平均を返す。

    拍の間隔だけでなく 2 拍・3 拍…1 小節の間隔でも繰り返している候補を高く評価する。
    音の立ち上がりが 1 小節に 1 回しか無い曲（伸ばしたコードだけ、など）では、拍の間隔そのものには
    繰り返しが現れないので、1 小節の間隔まで見ないと候補を区別できない。

    Args:
        autocorrelation (numpy.ndarray): ``_onset_autocorrelation`` の返り値。
        beat_period (float): 拍の間隔（フレーム数）。
        per_bar (int): 1小節あたりの拍数。

    Returns:
        float: 0.0〜1.0。各ずらし幅では前後 1 フレームの最大を取り（丸めの揺れを吸収）、
            負の相関は 0 として数える。自己相関の長さを越える倍数は平均から除く。
    """
    values = []
    for multiple in range(1, max(1, per_bar) + 1):
        lag = int(round(multiple * beat_period))
        if lag + 1 >= len(autocorrelation):
            break
        values.append(max(0.0, float(max(autocorrelation[lag - 1:lag + 2]))))
    return sum(values) / len(values) if values else 0.0


def _repair_edge_beats(beat_frames):
    """追跡した拍の列の、最初と最後の 1 拍を、隣の拍の間隔に合わせて置き直す。

    ビートの追跡は「前の拍からちょうど 1 拍ぶん後ろ」を手がかりに次の拍を置くので、
    前の拍が無い最初の 1 拍（と、後ろの拍が無い最後の 1 拍）は支えが弱く、音の立ち上がりから
    数フレーム外れることがある。曲が小節頭から始まる場合、最初の 1 拍がそのまま
    「1 拍目の位置」になるので、ここがずれるとグリッド全体の起点がずれる。

    Args:
        beat_frames (numpy.ndarray): 拍の位置（フレーム番号、昇順）。

    Returns:
        numpy.ndarray: 端の拍を置き直した列。端の間隔が隣の数拍の平均から
            ``_BEAT_TOLERANCE_FRAMES`` を超えて外れているときだけ直す。6 拍未満ならそのまま返す。
    """
    import numpy as np

    beats = np.array(beat_frames, dtype=int)
    if len(beats) < 6:
        return beats
    head = (beats[5] - beats[1]) / 4.0
    if abs((beats[1] - beats[0]) - head) > _BEAT_TOLERANCE_FRAMES:
        beats[0] = max(0, int(round(beats[1] - head)))
    tail = (beats[-2] - beats[-6]) / 4.0
    if abs((beats[-1] - beats[-2]) - tail) > _BEAT_TOLERANCE_FRAMES:
        beats[-1] = int(round(beats[-2] + tail))
    return beats


def _tempo_prior(bpm):
    """テンポの事前分布。``_TEMPO_PRIOR_CENTER_BPM`` を頂点とする対数正規の山。

    倍と半分の両方が音に合うとき、中心に近いほうを選ぶための重み。
    85 BPM 前後より遅い曲は倍に、170 BPM 前後より速い曲は半分に、わずかに寄りやすくなる。

    Args:
        bpm (float): テンポ。

    Returns:
        float: 0.0〜1.0 の重み。
    """
    import math

    if bpm <= 0:
        return 0.0
    octaves = math.log2(bpm / _TEMPO_PRIOR_CENTER_BPM)
    return math.exp(-0.5 * (octaves / _TEMPO_PRIOR_OCTAVES) ** 2)


def _tempo_confidence(candidates):
    """テンポの確信度を、選んだ候補の質と、次点との差から出す。

    拍がはっきり繰り返していて（``periodicity``）、強い音が拍に乗っていて（``recall``）、
    ほかのテンポの候補を引き離しているほど高い。音の立ち上がりがまばらな曲や、
    倍・半分のどちらとも取れる曲（次点が僅差）では低くなる。

    次点との差は、テンポの事前分布を弱めた点（事前分布の平方根を掛けた点）で比べる。
    「120 BPM 前後が自然」という好みだけで勝った候補を、確実とは言わないため。
    たとえば 8 分の刻みが在る 70 BPM の曲は 140 BPM とも取れ、事前分布は 140 を選ぶが、
    音そのものは 70 を同じくらい支持している。このとき確信度は低くなる。

    Args:
        candidates (list[dict]): ``_score_tempo_candidates`` の返り値（点の高い順）。

    Returns:
        float: 0.0〜1.0。
    """
    if not candidates:
        return 0.0

    def cautious(candidate):
        return candidate["score"] / candidate["prior"] ** 0.5 if candidate["prior"] > 0 else 0.0

    best = candidates[0]
    if cautious(best) <= 0:
        return 0.0
    rival = max((cautious(c) for c in candidates[1:]), default=0.0) / cautious(best)
    # 次点が ``1 - _CLEAR_SEPARATION`` 倍以下の点なら、取り違えの心配は無いとみなす
    separation = max(0.0, min(1.0, (1.0 - rival) / _CLEAR_SEPARATION))
    quality = min(1.0, best["periodicity"] / _CLEAR_PERIODICITY) * min(1.0, best["recall"] / _ENOUGH_RECALL)
    return float(max(0.0, min(1.0, quality * separation)))


def _values_near(values, frames):
    """各フレームの近く（手前 ``_BEAT_TOLERANCE_FRAMES``、後ろ ``_ACCENT_LAG_FRAMES``）の最大値を返す。

    拍の位置での「音の強さ」を読むのに使う。後ろを広く取るのは、強さの山が拍より遅れて
    来るため（``_ACCENT_LAG_FRAMES`` の説明を参照）。

    Args:
        values (numpy.ndarray): フレーム単位の時系列。
        frames (numpy.ndarray): 評価するフレーム番号。

    Returns:
        numpy.ndarray: ``frames`` と同じ長さの配列。
    """
    import numpy as np
    from scipy.ndimage import maximum_filter1d

    if len(values) == 0 or len(frames) == 0:
        return np.zeros(len(frames))
    size = _BEAT_TOLERANCE_FRAMES + _ACCENT_LAG_FRAMES + 1
    # 窓の中心を後ろへずらして、[拍 - 手前の幅, 拍 + 後ろの幅] の最大を取る
    shift = (_ACCENT_LAG_FRAMES - _BEAT_TOLERANCE_FRAMES) // 2
    widened = maximum_filter1d(values, size=size, origin=-shift, mode="nearest")
    return widened[np.clip(frames, 0, len(values) - 1)]


def _beat_onset_recall(beat_frames, features, beat_period):
    """強い音の立ち上がりのうち、拍の位置に在るものの割合を返す（偶然の分を引いたもの）。

    Args:
        beat_frames (numpy.ndarray): 拍の位置（フレーム番号、昇順）。
        features (dict): ``_analysis_features`` の返り値。
        beat_period (float): 拍の間隔（フレーム数）。

    Returns:
        float: 0.0〜1.0。音の立ち上がり（強さで重み付け）のうち、拍の近く（手前
            ``_BEAT_TOLERANCE_FRAMES``、後ろ ``_ACCENT_LAG_FRAMES`` フレーム）に在るものの割合から、でたらめに拍を置いても
            重なる割合（拍が細かいほど大きい）を引いて、0〜1 に伸ばし直した値。
            拍を細かくするだけで点が上がるのを防ぐ。
    """
    import numpy as np

    peaks, strengths = features["peaks"], features["peak_strengths"]
    if len(peaks) == 0 or float(np.sum(strengths)) <= 0:
        return 0.0
    right = np.clip(np.searchsorted(beat_frames, peaks), 0, len(beat_frames) - 1)
    left = np.clip(right - 1, 0, len(beat_frames) - 1)
    after_beat = peaks - beat_frames[left]      # 手前の拍から何フレーム後ろか
    before_beat = beat_frames[right] - peaks    # 次の拍の何フレーム手前か
    near = ((after_beat >= 0) & (after_beat <= _ACCENT_LAG_FRAMES)) | (
        (before_beat >= 0) & (before_beat <= _BEAT_TOLERANCE_FRAMES))
    on_beat = float(np.sum(strengths[near]) / np.sum(strengths))
    chance = min(0.9, (_BEAT_TOLERANCE_FRAMES + _ACCENT_LAG_FRAMES + 1) / max(1.0, beat_period))
    return float(max(0.0, (on_beat - chance) / (1.0 - chance)))


def _beat_cues(beat_frames, features, per_bar):
    """拍ごとの「強さ」の手がかりを 3 種類出す。小節頭の推定と、テンポ候補の採点に使う。

    Args:
        beat_frames (numpy.ndarray): 拍の位置（フレーム番号、昇順）。
        features (dict): ``_analysis_features`` の返り値。
        per_bar (int): 1小節あたりの拍数。

    Returns:
        dict[str, numpy.ndarray]: 各値は拍の数と同じ長さの配列。

        - ``"harmony"``: その拍を境に和音がどれだけ変わったか（0〜1）
        - ``"low"``: その拍での低音（キック・ベース）の立ち上がりの強さ（0〜1）
        - ``"onset"``: その拍での全帯域の音の立ち上がりの強さ（0〜1）
    """
    return {
        "harmony": _harmonic_change(features["chroma"], beat_frames, max(1, (per_bar + 1) // 2)),
        "low": _values_near(features["low_norm"], beat_frames),
        "onset": _values_near(features["accent_norm"], beat_frames),
    }


def _harmonic_change(chroma, beat_frames, span_beats):
    """各拍を境に、和音がどれだけ変わったかを出す。

    その拍から後ろ ``span_beats`` 拍ぶんのクロマの平均と、手前 ``span_beats`` 拍ぶんの
    平均とのコサイン距離を取る。コードは小節頭で変わることが多いので、これが大きい拍は
    小節頭の有力な候補になる。

    拍 1 つずつではなく半小節の幅で比べるのは、伴奏の動きを均すため。
    裏拍のコード弾きなどは拍ごとにクロマを変えるので、隣の拍と比べると
    「毎拍コードが変わっている」ように見え、小節頭が埋もれる。

    限界: ルート・3 度・5 度・6 度と動き続けるベース（ウォーキングベース、ブギーの型）が
    前に出ている曲では、小節の中の音の動きのほうが小節の境目での変化より大きくなり、
    この手がかりは小節の真ん中（3 拍目）を指すことがある。

    Args:
        chroma (numpy.ndarray): クロマ（12 × フレーム数）。
        beat_frames (numpy.ndarray): 拍の位置（フレーム番号、昇順）。
        span_beats (int): 前後に見る幅（拍数）。

    Returns:
        numpy.ndarray: 拍ごとの変化量（0〜1）。手前か後ろの区間が無い、または無音に近いときは 0
            （鳴り始めは「変化」に数えない）。
    """
    import numpy as np

    n_frames = chroma.shape[1]
    n_beats = len(beat_frames)
    change = np.zeros(n_beats)
    if n_beats < 2 or n_frames == 0:
        return change

    period = int(round(float(np.median(np.diff(beat_frames)))))
    # 最後の拍の後ろにも区切りを 1 つ置く（最後の拍の区間を閉じるため）
    edges = np.clip(np.concatenate([beat_frames, [beat_frames[-1] + period]]), 0, n_frames)
    cumulative = np.concatenate([np.zeros((chroma.shape[0], 1)), np.cumsum(chroma, axis=1)], axis=1)

    def window_mean(start_beat, stop_beat):
        start, stop = edges[max(0, start_beat)], edges[min(n_beats, stop_beat)]
        if stop <= start:
            return np.zeros(chroma.shape[0])
        return (cumulative[:, stop] - cumulative[:, start]) / (stop - start)

    before = np.array([window_mean(k - span_beats, k) for k in range(n_beats)])
    after = np.array([window_mean(k, k + span_beats) for k in range(n_beats)])
    norm_before = np.linalg.norm(before, axis=1)
    norm_after = np.linalg.norm(after, axis=1)
    level = float(np.median(norm_after[norm_after > 0])) if np.any(norm_after > 0) else 0.0
    sounding = (norm_before > 0.05 * level) & (norm_after > 0.05 * level)
    similarity = np.sum(before * after, axis=1) / np.maximum(norm_before * norm_after, 1e-12)
    change[sounding] = np.clip(1.0 - similarity[sounding], 0.0, 1.0)
    return change


def _phase_profile(values, per_bar):
    """拍ごとの値が、小節内の位置（何拍目か）でどれだけ決まっているかを調べる。

    Args:
        values (numpy.ndarray): 拍ごとの値。
        per_bar (int): 1小節あたりの拍数。

    Returns:
        tuple[numpy.ndarray, float]: ``(effects, explained)``。

        - ``effects``: 長さ ``per_bar``。小節内の各位置の平均が、全体の平均から
          標準偏差いくつ分だけ高いか（効果量）
        - ``explained``: 値のばらつきのうち、小節内の位置で説明できる割合（0〜1。
          拍数が少ないときの偶然の一致を差し引いた、自由度調整済みの相関比）。
          小節ごとに同じ強弱が繰り返していれば 1 に近い
    """
    import numpy as np

    values = np.asarray(values, dtype=float)
    n = len(values)
    effects = np.zeros(per_bar)
    if per_bar < 2 or n <= per_bar:
        return effects, 0.0
    total = float(np.sum((values - values.mean()) ** 2))
    if total <= 1e-12:
        return effects, 0.0

    phases = np.arange(n) % per_bar
    between = 0.0
    std = float(values.std())
    for phase in range(per_bar):
        group = values[phases == phase]
        effects[phase] = (group.mean() - values.mean()) / std
        between += len(group) * float(group.mean() - values.mean()) ** 2
    explained = 1.0 - (1.0 - between / total) * (n - 1) / (n - per_bar)
    return effects, float(max(0.0, min(1.0, explained)))


def _estimate_downbeat_phase(beat_frames, features, per_bar):
    """ビート列のうちどの拍が小節頭かを推定し、そのインデックスと確信度を返す。

    手がかりは 3 つ（重みは ``_CUE_WEIGHTS``）:
    コードの変わり目、低音の立ち上がり、全帯域の音の大きさ。それぞれ、小節内の位置ごとの
    平均が全体よりどれだけ高いか（効果量）を出し、その手がかりが小節の繰り返しを
    どれだけ示しているか（``_phase_profile`` の ``explained``）を掛けて足す。
    繰り返しを示さない手がかり（和音の無いドラムだけの曲でのコードの変化など）は、
    雑音として効かなくなる。

    音の大きさだけで決めないのは、スネア（2・4 拍）がキックより大きい曲が多く、
    それだと必ず 2 拍目か 4 拍目を選んでしまうため。

    Args:
        beat_frames (numpy.ndarray): 拍の位置（フレーム番号、昇順）。
        features (dict): ``_analysis_features`` の返り値。
        per_bar (int): 1小節あたりの拍数。

    Returns:
        tuple[int, float]: ``(phase, confidence)``。
            ``phase`` は小節頭に当たるビートのインデックス（0 〜 ``per_bar - 1``）。
            ``confidence`` は 0.0〜1.0 で、次点の位置との点差が小さいほど低い。
            ビート列が空、または拍子が1拍の場合は ``(0, 1.0)``。
    """
    import numpy as np

    n_beats = len(beat_frames)
    if n_beats == 0 or per_bar <= 1:
        return 0, 1.0
    if n_beats <= per_bar:
        return 0, 0.0

    totals = np.zeros(per_bar)
    weights = dict(_CUE_WEIGHTS)
    for name, values in _beat_cues(beat_frames, features, per_bar).items():
        effects, explained = _phase_profile(values, per_bar)
        totals += weights[name] * explained * effects

    # 「曲は小節の頭から始まる」という弱い仮定。追跡は曲頭の拍を落とすことがあるので、
    # 最初の拍ではなく、音が鳴り始めた位置までグリッドを遡って、その拍を小節頭の候補にする
    period = float(np.mean(np.diff(beat_frames[: min(n_beats, 2 * per_bar + 1)])))
    beats_before = int(round(max(0.0, beat_frames[0] - features["sound_start_frame"]) / period))
    totals[(-beats_before) % per_bar] += _START_BONUS

    order = np.argsort(totals)[::-1]
    margin = float(totals[order[0]] - totals[order[1]])
    return int(order[0]), float(max(0.0, min(1.0, margin / _DOWNBEAT_CLEAR_MARGIN)))


def _build_uniform_beats(bpm, offset, duration_sec):
    """BPM とオフセットから等間隔のビート列を構築する。

    ユーザーが BPM を手入力した場合に使う。自動検出時の実測ビート列とは
    異なり、テンポ揺れは表現できない。

    Args:
        bpm (float): テンポ（BPM）。正の値。
        offset (float): 1拍目の位置（秒）。
        duration_sec (float): 音声の長さ（秒）。

    Returns:
        list[float]: ビート位置（秒）の昇順リスト。``bpm`` が 0 以下なら空リスト。
    """
    if bpm <= 0:
        return []
    interval = 60.0 / bpm
    beats = []
    t = float(offset)
    while t <= duration_sec:
        beats.append(t)
        t += interval
    return beats


def _edge_interval(beat_times, from_start, count=8):
    """ビート列の端の近くでの、拍の間隔の平均を返す。

    グリッドを端の外へ延ばすときの間隔に使う。個々の間隔はフレーム幅に丸められて
    揺れるので、中央値ではなく数拍分のスパンから出す（中央値だと 120 BPM の間隔が
    0.5108 秒のように丸めの幅だけ長く出て、延ばした先で 1 小節ぶん食い違う）。
    曲全体ではなく端の近くだけを使うのは、テンポが揺れる曲で端のテンポに合わせるため。

    Args:
        beat_times (list[float]): ビート位置（秒）の昇順リスト。2 つ以上。
        from_start (bool): True なら先頭側、False なら末尾側。
        count (int, optional): 平均を取る間隔の数の上限。

    Returns:
        float: 間隔（秒）。
    """
    n = min(count, len(beat_times) - 1)
    if from_start:
        return (beat_times[n] - beat_times[0]) / n
    return (beat_times[-1] - beat_times[-1 - n]) / n


def _extend_grid_backward(beat_times, phase, beats_per_bar):
    """ダウンビートより前を小節単位で埋め直し、グリッドを曲頭まで伸ばす。

    静かなイントロやフェードインではビートトラッカーが曲頭を拾えず、検出
    された最初の拍が実際には2小節目だったりする。そのままだと小節番号も
    コードの割り当ても丸ごとずれる。

    小節単位（拍単位ではなく）で伸ばすのは拍子の位相を保つため。1拍ずつ
    伸ばすと小節頭がどこか分からなくなる。

    ダウンビートより前の実測拍は捨てて等間隔の外挿で置き換える。実測値を
    残そうとすると「1小節あたりちょうど beats_per_bar 拍」という前提が
    崩れ、小節番号がずれるため。

    Args:
        beat_times (list[float]): 検出されたビート位置（秒）の昇順リスト。
        phase (int): ダウンビートに当たるビートのインデックス
            （0 〜 ``beats_per_bar - 1``）。
        beats_per_bar (int): 1小節あたりの拍数。

    Returns:
        tuple[list[float], float]: ``(beat_times, offset)``。
            曲頭まで伸ばしたビート列と、1拍目の位置（秒）。
            伸ばす余地が無い場合はダウンビート以降のビート列を返す。

    Note:
        遡った先が 0 秒よりわずかに前（``_GRID_START_TOLERANCE_SEC`` 以内）になる場合は、
        曲頭ちょうどから始まる小節とみなして 0 秒に置く。拍の位置にはフレーム幅の
        丸めが乗るので、0 秒ちょうどで始まる曲でも計算上は数十ミリ秒はみ出しうる。
    """
    per_bar = int(beats_per_bar)
    if len(beat_times) < 2 or per_bar < 1:
        return list(beat_times), float(beat_times[0]) if beat_times else 0.0

    phase = max(0, min(int(phase), len(beat_times) - 1))
    downbeat = float(beat_times[phase])

    interval = _edge_interval(beat_times, from_start=True)
    if interval <= 0:
        return list(beat_times[phase:]), downbeat

    bar_duration = interval * per_bar
    bars_back = int((downbeat + _GRID_START_TOLERANCE_SEC) // bar_duration)
    if bars_back < 1:
        return list(beat_times[phase:]), downbeat

    count = bars_back * per_bar
    prefix = [downbeat - (count - i) * interval for i in range(count)]
    prefix[0] = max(0.0, prefix[0])
    return prefix + list(beat_times[phase:]), prefix[0]


def _extend_grid_forward(beat_times, sound_end_sec, duration_sec):
    """グリッドを、音が鳴り終わる位置まで後ろへ伸ばす。

    ビートトラッカーは曲の終わりの弱い拍を落とす。そのままだと最後の小節が
    グリッドから外れ、そこのコードが検出されない。最後の拍の区間を閉じる拍
    （音が鳴り終わった直後の拍）まで、等間隔の外挿で足す。

    Args:
        beat_times (list[float]): ビート位置（秒）の昇順リスト。
        sound_end_sec (float): 音が鳴り終わる位置（秒）。
        duration_sec (float): 音声の長さ（秒）。これを越える拍は足さない。

    Returns:
        list[float]: 後ろへ伸ばしたビート列。伸ばす必要が無ければ入力のまま。
    """
    beats = list(beat_times)
    if len(beats) < 2:
        return beats
    interval = _edge_interval(beats, from_start=False)
    if interval <= 0:
        return beats
    while beats[-1] < sound_end_sec - _GRID_START_TOLERANCE_SEC and beats[-1] + interval <= duration_sec:
        beats.append(beats[-1] + interval)
    return beats


def detect_sections(file_path, beat_times, beats_per_bar=4):
    """楽曲を構成上のまとまり（セクション）に分割する。

    MFCC とクロマをビート単位に集約し、凝集型クラスタリングで境界を求める。
    区間の音響的特徴が似ているものには同じ ``repeat_group`` を割り当てる。

    **ラベルは断定しない。**「イントロ」「サビ」といったラベルの自動推定は
    洋楽・インスト・非定型な楽曲で簡単に崩れるため、``suggested_label`` に
    提案として置き、``label`` はユーザーが確定するまで None のままにする。

    Args:
        file_path (str): 解析する音声ファイルのパス。
        beat_times (list[float]): 実測ビート位置（秒）。
            ``estimate_grid`` の ``beat_times_sec`` を渡す想定。
        beats_per_bar (int, optional): 1小節あたりの拍数。デフォルト 4。

    Returns:
        list[dict]: セクションのリスト。各要素は以下のキーを持つ。

        .. code-block:: python

            {
                "id":                   str,        # "S1", "S2", ...
                "label":                None,       # ユーザーが確定するまで None
                "suggested_label":      str|None,   # "intro"|"chorus"|"outro"|None
                "suggested_confidence": float,
                "start_bar":            int,        # 1始まり
                "end_bar":              int,        # 含む
                "start_sec":            float,
                "end_sec":              float,
                "repeat_group":         str,        # "A", "B", ...
                "features": {"rms_db": float, "onset_density": float},
            }

        ビートが十分に無い（8拍未満）場合は空リストを返す。

    Note:
        numpy および librosa を関数内で遅延インポートする。
    """
    import numpy as np
    import librosa

    if beat_times is None or len(beat_times) < 8:
        return []

    y, sr = librosa.load(file_path, sr=ANALYSIS_SR, mono=True)
    if len(y) == 0:
        return []

    beat_times = _drop_closing_beat(beat_times, y, sr)
    beat_frames = librosa.time_to_frames(beat_times, sr=sr, hop_length=HOP_LENGTH)
    beat_frames = np.unique(np.clip(beat_frames, 0, None))

    mfcc = librosa.feature.mfcc(y=y, sr=sr, hop_length=HOP_LENGTH, n_mfcc=13)
    chroma = librosa.feature.chroma_cqt(y=y, sr=sr, hop_length=HOP_LENGTH)
    features = np.vstack([mfcc, chroma])

    beat_frames = beat_frames[beat_frames < features.shape[1]]
    if len(beat_frames) < 8:
        return []
    synced = librosa.util.sync(features, beat_frames, aggregate=np.mean)

    # 区間数は曲の長さから決める。おおよそ10秒に1区間、3〜16の範囲。
    # 粗く切りすぎるとAメロとサビが同じ区間に潰れるため、細かめに切ってから
    # 短すぎる区間を _merge_short_boundaries で吸収する方針にしている
    duration = len(y) / sr
    n_segments = int(max(3, min(16, round(duration / 10.0))))
    n_segments = min(n_segments, synced.shape[1] - 1)
    if n_segments < 2:
        return []

    boundaries = librosa.segment.agglomerative(synced, n_segments)
    boundaries = sorted(set(int(b) for b in boundaries) | {0, synced.shape[1]})
    boundaries = _merge_short_boundaries(boundaries, int(beats_per_bar) * 2)

    onset_env = librosa.onset.onset_strength(y=y, sr=sr, hop_length=HOP_LENGTH)
    sections = []
    segment_vectors = []

    for i in range(len(boundaries) - 1):
        start_beat, end_beat = boundaries[i], boundaries[i + 1]
        if end_beat <= start_beat:
            continue
        start_sec = float(beat_times[min(start_beat, len(beat_times) - 1)])
        end_sec = float(beat_times[min(end_beat, len(beat_times) - 1)])
        if end_sec <= start_sec:
            continue

        segment_vectors.append(np.mean(synced[:, start_beat:end_beat], axis=1))
        sections.append({
            "id": f"S{len(sections) + 1}",
            "label": None,
            "suggested_label": None,
            "suggested_confidence": 0.0,
            "start_bar": start_beat // int(beats_per_bar) + 1,
            "end_bar": max(start_beat // int(beats_per_bar) + 1, (end_beat - 1) // int(beats_per_bar) + 1),
            "start_sec": start_sec,
            "end_sec": end_sec,
            "repeat_group": "A",
            "features": {
                "rms_db": _segment_rms_db(y, sr, start_sec, end_sec),
                "onset_density": _segment_onset_density(onset_env, sr, start_sec, end_sec),
            },
        })

    if not sections:
        return []

    _assign_repeat_groups(sections, segment_vectors)
    _suggest_labels(sections)
    return sections


def _drop_closing_beat(beat_times, y, sr):
    """最後の拍の後ろに音が無ければ、その拍を除いたビート列を返す。

    ``estimate_grid`` は、音が鳴り終わる位置までグリッドを伸ばす。曲が小節の境目で終わる場合、
    最後の拍は「最後の小節を閉じる線」であって、新しい小節の始まりではない。
    これを 1 拍と数えると、16 小節の曲の最後の区間が「17 小節まで」と出てしまう。

    Args:
        beat_times (list[float]): ビート位置（秒）の昇順リスト。
        y (numpy.ndarray): モノラル波形。
        sr (int): サンプルレート（Hz）。

    Returns:
        list[float]: 最後の拍の後ろが無音（曲のいちばん大きい振幅に対して ``_SILENCE_RATIO`` 未満）なら、
            最後の拍を除いた列。そうでなければ入力のまま。
    """
    import numpy as np

    if len(beat_times) < 2:
        return list(beat_times)
    tail = y[int(beat_times[-1] * sr):]
    peak = float(np.max(np.abs(y)))
    if len(tail) == 0 or float(np.sqrt(np.mean(tail ** 2))) < peak * _SILENCE_RATIO:
        return list(beat_times[:-1])
    return list(beat_times)


def _merge_short_boundaries(boundaries, min_beats):
    """短すぎる区間を隣へ吸収し、意味のある長さの区間境界だけを残す。

    クラスタリングは1〜2拍しかない区間を作ることがあり、そのまま出すと
    「1小節目から1小節目まで」のような区間がカルテに並んで役に立たない。

    Args:
        boundaries (list[int]): 昇順の境界インデックス（ビート単位）。
            先頭は 0、末尾は総ビート数であることを前提とする。
        min_beats (int): 1区間として認める最小のビート数。

    Returns:
        list[int]: 短い区間を吸収した後の境界リスト。
            区間が1つも残らない場合は先頭と末尾のみの2要素を返す。
    """
    if len(boundaries) <= 2 or min_beats <= 1:
        return boundaries

    merged = [boundaries[0]]
    for boundary in boundaries[1:-1]:
        if boundary - merged[-1] >= min_beats:
            merged.append(boundary)
    merged.append(boundaries[-1])

    # 最後の区間が短くなりすぎたら、直前の境界を落として吸収させる
    while len(merged) > 2 and merged[-1] - merged[-2] < min_beats:
        merged.pop(-2)

    return merged


def _segment_rms_db(y, sr, start_sec, end_sec):
    """区間の平均音量を dBFS で返す。

    Args:
        y (numpy.ndarray): モノラル波形。
        sr (int): サンプルレート（Hz）。
        start_sec (float): 区間の開始位置（秒）。
        end_sec (float): 区間の終了位置（秒）。

    Returns:
        float: 平均音量（dBFS）。無音区間は -120.0 を返す。
    """
    import numpy as np

    start, end = int(start_sec * sr), int(end_sec * sr)
    segment = y[max(0, start):min(len(y), end)]
    if len(segment) == 0:
        return -120.0
    rms = float(np.sqrt(np.mean(segment ** 2)))
    return float(20 * np.log10(max(rms, 1e-6)))


def _segment_onset_density(onset_env, sr, start_sec, end_sec):
    """区間の音の詰まり具合（1秒あたりのオンセット数の目安）を返す。

    Args:
        onset_env (numpy.ndarray): オンセット強度の時系列。
        sr (int): サンプルレート（Hz）。
        start_sec (float): 区間の開始位置（秒）。
        end_sec (float): 区間の終了位置（秒）。

    Returns:
        float: オンセット密度。区間が空の場合は 0.0。
    """
    import numpy as np

    start = int(start_sec * sr / HOP_LENGTH)
    end = int(end_sec * sr / HOP_LENGTH)
    segment = onset_env[max(0, start):min(len(onset_env), end)]
    if len(segment) == 0 or end_sec <= start_sec:
        return 0.0
    threshold = float(np.mean(onset_env)) if len(onset_env) else 0.0
    hits = int(np.sum(segment > threshold))
    return float(hits / (end_sec - start_sec))


def _assign_repeat_groups(sections, vectors):
    """音響的に似たセクションに同じ ``repeat_group`` を割り当てる。

    セクションの特徴ベクトル同士のコサイン類似度が閾値を超えたものを
    同一グループとみなし、A, B, C… の記号を振る。

    Args:
        sections (list[dict]): ``detect_sections`` が組み立て中のセクションリスト。
            この関数が ``repeat_group`` を破壊的に書き換える。
        vectors (list[numpy.ndarray]): 各セクションの特徴ベクトル。

    Side Effects:
        ``sections`` の各要素の ``repeat_group`` を更新する。
    """
    import numpy as np

    labels = [None] * len(sections)
    next_group = 0
    for i in range(len(sections)):
        if labels[i] is not None:
            continue
        labels[i] = next_group
        vi = vectors[i]
        norm_i = np.linalg.norm(vi)
        for j in range(i + 1, len(sections)):
            if labels[j] is not None:
                continue
            vj = vectors[j]
            norm_j = np.linalg.norm(vj)
            if norm_i <= 0 or norm_j <= 0:
                continue
            if float(np.dot(vi, vj) / (norm_i * norm_j)) > 0.9:
                labels[j] = next_group
        next_group += 1

    for section, group in zip(sections, labels):
        section["repeat_group"] = chr(ord("A") + (group % 26))


def _suggest_labels(sections):
    """セクションに構成ラベルの「提案」を付ける。確定はしない。

    最初の区間を intro、最後の区間を outro、最も音量が大きく複数回
    繰り返される区間を chorus の候補とする。いずれもヒューリスティックで
    外れるため、``suggested_confidence`` は低めに置き、``label`` には
    書き込まない。

    Args:
        sections (list[dict]): セクションのリスト。破壊的に更新される。

    Side Effects:
        各要素の ``suggested_label`` と ``suggested_confidence`` を更新する。
    """
    if not sections:
        return

    group_counts = {}
    for section in sections:
        group_counts[section["repeat_group"]] = group_counts.get(section["repeat_group"], 0) + 1

    # 繰り返しがあり、かつ最も音量の大きいグループをサビ候補とみなす
    repeated = [s for s in sections if group_counts[s["repeat_group"]] >= 2]
    chorus_group = None
    if repeated:
        loudest = max(repeated, key=lambda s: s["features"]["rms_db"])
        chorus_group = loudest["repeat_group"]

    for i, section in enumerate(sections):
        if i == 0:
            section["suggested_label"] = "intro"
            section["suggested_confidence"] = 0.5
        elif i == len(sections) - 1:
            section["suggested_label"] = "outro"
            section["suggested_confidence"] = 0.5
        elif chorus_group and section["repeat_group"] == chorus_group:
            section["suggested_label"] = "chorus"
            section["suggested_confidence"] = 0.45
        else:
            section["suggested_label"] = None
            section["suggested_confidence"] = 0.0
