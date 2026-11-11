"""
bunri DAW — 時間構造の解析（グリッド推定・セクション検出）

楽曲カルテ（第1層）の土台。BPM・ダウンビート・実測ビート列を求め、
そのうえで曲を区間に分割する。

グリッドが崩れるとカルテ全体（コード・セクション）が崩れるため、
このモジュールの精度がカルテ全体の信頼性を決める。特に BPM の倍/半分
エラーは頻出するので専用の検証を行い、それでも外れる前提でユーザーが
手で直せるよう ``estimate_grid`` は BPM とオフセットの上書きを受け付ける。

CPU環境前提。重いモジュールは関数内で遅延インポートする。
"""

# 解析時のサンプルレート。ビート検出には十分で、読み込みが軽い
ANALYSIS_SR = 22050
HOP_LENGTH = 512

# BPM の妥当範囲。これを外れる候補は倍/半分補正の対象になる
BPM_MIN = 60.0
BPM_MAX = 200.0

# 倍/半分補正で「自然」とみなす中心帯。曖昧なときはここに近い候補を選ぶ
BPM_TYPICAL_LOW = 85.0
BPM_TYPICAL_HIGH = 165.0


def estimate_grid(file_path, bpm=None, downbeat_offset=None, beats_per_bar=4):
    """音声ファイルからビートグリッド（BPM・ダウンビート・実測ビート列）を推定する。

    ``bpm`` と ``downbeat_offset`` を指定すると自動検出を行わず、その値で
    グリッドを構築する。ユーザーがグリッド補正UIで修正した値を反映する
    経路であり、``bpm_source`` が ``"user"`` になる。

    自動検出では BPM の倍/半分エラーを検証する（``_resolve_tempo_octave``）。
    これは 90 BPM の曲を 180 BPM と誤検出するような、実用上いちばん多い
    失敗を潰すため。

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

        音声が空の場合は BPM 120 の既定グリッドを確信度 0.0 で返す。

    Note:
        ``beat_times_sec`` は実測のビート位置であり、固定 BPM から計算した
        等間隔の列ではない。テンポが揺れる生演奏でも秒↔小節・拍の変換が
        正確に保たれるようにするため。
        numpy および librosa を関数内で遅延インポートする。
    """
    import numpy as np
    import librosa

    y, sr = librosa.load(file_path, sr=ANALYSIS_SR, mono=True)
    if len(y) == 0:
        return {
            "bpm": 120.0,
            "bpm_confidence": 0.0,
            "bpm_source": "user" if bpm else "auto",
            "downbeat_offset_sec": 0.0,
            "time_signature": [int(beats_per_bar), 4],
            "beat_times_sec": [],
            "user_confirmed": bool(bpm),
        }

    onset_env = librosa.onset.onset_strength(y=y, sr=sr, hop_length=HOP_LENGTH)

    if bpm:
        # ユーザー指定の BPM。等間隔でビート列を組み立てる
        resolved_bpm = float(bpm)
        confidence = 1.0
        source = "user"
        offset = float(downbeat_offset) if downbeat_offset is not None else 0.0
        beat_times = _build_uniform_beats(resolved_bpm, offset, len(y) / sr)
    else:
        detected, beat_times = _detect_beats(y, sr, onset_env)
        resolved_bpm, confidence, beat_times = _resolve_tempo_octave(
            detected, beat_times, onset_env, sr, len(y) / sr
        )
        source = "auto"
        offset = None

    if offset is None:
        phase = _estimate_downbeat_phase(beat_times, onset_env, sr, beats_per_bar)
        # 静かなイントロではビート検出が曲頭から始まらず、小節番号が丸ごと
        # ずれる。位相を保ったまま小節単位で先頭方向へ外挿して補う
        beat_times, offset = _extend_grid_backward(beat_times, phase, beats_per_bar)
    if downbeat_offset is not None:
        offset = float(downbeat_offset)
        # ダウンビートより前のビートは切り捨てる（1拍目をグリッドの起点にする）
        beat_times = [t for t in beat_times if t >= offset - 1e-6]

    return {
        "bpm": float(resolved_bpm),
        "bpm_confidence": float(confidence),
        "bpm_source": source,
        "downbeat_offset_sec": float(offset),
        "time_signature": [int(beats_per_bar), 4],
        "beat_times_sec": [float(t) for t in beat_times],
        "user_confirmed": source == "user",
    }


def _detect_beats(y, sr, onset_env):
    """librosa のビートトラッカーで BPM とビート位置を検出する。

    Args:
        y (numpy.ndarray): モノラル波形。
        sr (int): サンプルレート（Hz）。
        onset_env (numpy.ndarray): オンセット強度の時系列。

    Returns:
        tuple[float, list[float]]: ``(bpm, beat_times)``。
            ``beat_times`` はビート位置（秒）のリスト。

    Note:
        BPM は ``beat_track`` が返すテンポグラム推定値ではなく、実測ビート列の
        全体スパンから算出する。テンポグラム推定は数 BPM ずれることがあり
        （120 の曲で 117.5 など）、その誤差がカルテ全体に波及するため。
        ビート位置はホップ幅（約23ms）に量子化されているので個々の間隔は
        揺れるが、スパン全体で平均すれば量子化誤差は打ち消える。
    """
    import numpy as np
    import librosa

    tempo, beat_frames = librosa.beat.beat_track(
        onset_envelope=onset_env, sr=sr, hop_length=HOP_LENGTH
    )
    beat_times = [float(t) for t in librosa.frames_to_time(beat_frames, sr=sr, hop_length=HOP_LENGTH)]

    span = beat_times[-1] - beat_times[0] if len(beat_times) >= 2 else 0.0
    if span > 0:
        bpm = 60.0 * (len(beat_times) - 1) / span
    else:
        bpm = float(np.atleast_1d(tempo)[0])

    return bpm, beat_times


def _resolve_tempo_octave(bpm, beat_times, onset_env, sr, duration_sec):
    """BPM の倍/半分エラーを検証し、必要なら補正した BPM とビート列を返す。

    検出されたビート位置の中間点にもビートと同等のオンセットが立っていれば
    「本当は倍のテンポ」、逆に1つおきのビートが著しく弱ければ「本当は半分の
    テンポ」と判断する。単純に BPM の値域でクランプするだけでは、90 BPM の
    曲を 180 BPM と誤検出する典型的な失敗を防げないため。

    Args:
        bpm (float): 検出された BPM。
        beat_times (list[float]): 検出されたビート位置（秒）。
        onset_env (numpy.ndarray): オンセット強度の時系列。
        sr (int): サンプルレート（Hz）。
        duration_sec (float): 音声の長さ（秒）。

    Returns:
        tuple[float, float, list[float]]: ``(bpm, confidence, beat_times)``。
            ``confidence`` は補正判断の明確さを 0.0〜1.0 で表す。
            補正が必要なかった場合、``beat_times`` は入力をそのまま返す。
    """
    import numpy as np

    if not beat_times or len(beat_times) < 4 or bpm <= 0:
        return max(BPM_MIN, min(BPM_MAX, bpm or 120.0)), 0.0, beat_times

    beat_strength = _onset_strength_at(beat_times, onset_env, sr)

    # ビート間の中間点にどれだけオンセットが立っているか
    midpoints = [(beat_times[i] + beat_times[i + 1]) / 2 for i in range(len(beat_times) - 1)]
    mid_strength = _onset_strength_at(midpoints, onset_env, sr)

    # 1つおきのビートの強さの偏り（倍取りしていると強弱が交互になる）
    odd = _onset_strength_at(beat_times[0::2], onset_env, sr)
    even = _onset_strength_at(beat_times[1::2], onset_env, sr)
    weaker = min(odd, even)
    stronger = max(odd, even)
    alternation = 1.0 - (weaker / stronger) if stronger > 0 else 0.0

    candidate = bpm
    confidence = 0.6
    beats = beat_times

    if beat_strength > 0 and mid_strength / beat_strength > 0.85 and bpm * 2 <= BPM_MAX:
        # 中間点にも同等の音がある → 本当はこの倍のテンポ
        candidate = bpm * 2
        beats = _interleave_midpoints(beat_times)
        confidence = min(1.0, 0.5 + (mid_strength / beat_strength - 0.85) * 2)
    elif alternation > 0.45 and bpm / 2 >= BPM_MIN:
        # 1つおきに著しく弱い → 倍取りしている。半分にする
        candidate = bpm / 2
        beats = beat_times[0::2] if odd >= even else beat_times[1::2]
        confidence = min(1.0, 0.5 + (alternation - 0.45))
    else:
        # 補正不要。交互性が低いほど検出は安定していたとみなす
        confidence = max(0.3, 1.0 - alternation)

    # 値域外なら機械的に倍/半分して押し込む
    while candidate < BPM_MIN and candidate > 0:
        candidate *= 2
        beats = _interleave_midpoints(beats)
        confidence *= 0.7
    while candidate > BPM_MAX:
        candidate /= 2
        beats = beats[0::2]
        confidence *= 0.7

    # 典型帯から外れるほど確信度を下げる（外れていても値は採用する）
    if not (BPM_TYPICAL_LOW <= candidate <= BPM_TYPICAL_HIGH):
        confidence *= 0.8

    if len(beats) < 2:
        beats = _build_uniform_beats(candidate, beat_times[0] if beat_times else 0.0, duration_sec)

    return float(candidate), float(max(0.0, min(1.0, confidence))), [float(t) for t in beats]


def _onset_strength_at(times, onset_env, sr):
    """指定した時刻群におけるオンセット強度の平均を返す。

    Args:
        times (list[float]): 評価する時刻（秒）のリスト。
        onset_env (numpy.ndarray): オンセット強度の時系列。
        sr (int): サンプルレート（Hz）。

    Returns:
        float: オンセット強度の平均。``times`` が空、または全て範囲外の場合は 0.0。
    """
    import numpy as np

    if not len(times):
        return 0.0
    frames = np.round(np.asarray(times) * sr / HOP_LENGTH).astype(int)
    frames = frames[(frames >= 0) & (frames < len(onset_env))]
    if len(frames) == 0:
        return 0.0
    return float(np.mean(onset_env[frames]))


def _interleave_midpoints(beat_times):
    """ビート列の各区間に中間点を挿入し、倍密度のビート列を返す。

    Args:
        beat_times (list[float]): 元のビート位置（秒）。

    Returns:
        list[float]: 中間点を挿入した昇順のビート列。
            入力が2点未満の場合はそのまま返す。
    """
    if len(beat_times) < 2:
        return list(beat_times)
    result = []
    for i in range(len(beat_times) - 1):
        result.append(beat_times[i])
        result.append((beat_times[i] + beat_times[i + 1]) / 2)
    result.append(beat_times[-1])
    return result


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


def _estimate_downbeat_phase(beat_times, onset_env, sr, beats_per_bar):
    """ビート列のうちどの拍が小節頭かを推定し、そのインデックスを返す。

    小節頭は他の拍よりオンセットが強い傾向があるため、``beats_per_bar``
    通りの位相それぞれについて該当拍のオンセット強度を平均し、最大の位相を
    小節頭とみなす。

    Args:
        beat_times (list[float]): ビート位置（秒）。
        onset_env (numpy.ndarray): オンセット強度の時系列。
        sr (int): サンプルレート（Hz）。
        beats_per_bar (int): 1小節あたりの拍数。

    Returns:
        int: 小節頭に当たるビートのインデックス（0 〜 ``beats_per_bar - 1``）。
            ビート列が空、または拍子が1拍の場合は 0。
    """
    if not beat_times or beats_per_bar <= 1:
        return 0

    best_phase, best_strength = 0, -1.0
    for phase in range(min(int(beats_per_bar), len(beat_times))):
        strength = _onset_strength_at(beat_times[phase::int(beats_per_bar)], onset_env, sr)
        if strength > best_strength:
            best_phase, best_strength = phase, strength

    return best_phase


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
    """
    import numpy as np

    per_bar = int(beats_per_bar)
    if len(beat_times) < 2 or per_bar < 1:
        return list(beat_times), float(beat_times[0]) if beat_times else 0.0

    phase = max(0, min(int(phase), len(beat_times) - 1))
    downbeat = float(beat_times[phase])

    interval = float(np.median(np.diff(beat_times)))
    if interval <= 0:
        return list(beat_times[phase:]), downbeat

    bar_duration = interval * per_bar
    bars_back = int(downbeat // bar_duration)
    if bars_back < 1:
        return list(beat_times[phase:]), downbeat

    start = downbeat - bars_back * bar_duration
    prefix = [start + i * interval for i in range(bars_back * per_bar)]
    return prefix + list(beat_times[phase:]), start


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
