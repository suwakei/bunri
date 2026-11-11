"""
bunri DAW — 音楽理論解析（キー推定・コード検出・ディグリー変換・用語辞書）

楽曲カルテ（第1層）の中核。クロマ特徴量からキーとコード進行を推定し、
初心者にも意味の分かるディグリー表記を併記する。

設計方針:
- LLM は使わない。ここは純粋な DSP + 音楽理論
- 断定しない。全ての推定に確信度を持たせ、低確信度は呼び出し側が落とせるようにする
- 重いモジュール（numpy / librosa）は関数内で遅延インポートする
"""

NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

# Krumhansl-Schmuckler のキープロファイル（長調・短調それぞれ12音の重み）
# 出典: Krumhansl, "Cognitive Foundations of Musical Pitch" (1990)
KS_MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
KS_MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]

# コードテンプレート: 品質名 -> ルートからの半音インターバル
# v1 は三和音 + 7th まで。テンション・転回形は扱わない
CHORD_TEMPLATES = {
    "maj":   [0, 4, 7],
    "min":   [0, 3, 7],
    "dim":   [0, 3, 6],
    "aug":   [0, 4, 8],
    "sus4":  [0, 5, 7],
    "maj7":  [0, 4, 7, 11],
    "min7":  [0, 3, 7, 10],
    "7":     [0, 4, 7, 10],
    "m7b5":  [0, 3, 6, 10],
}

# コード品質 -> 表記サフィックス（ルート音名に続けて表示する文字列）
CHORD_SUFFIX = {
    "maj": "", "min": "m", "dim": "dim", "aug": "aug", "sus4": "sus4",
    "maj7": "maj7", "min7": "m7", "7": "7", "m7b5": "m7-5",
}

# 品質が短三和音系か（ディグリー表記の大文字/小文字を決める）
_MINOR_QUALITIES = {"min", "dim", "min7", "m7b5"}

# コントラスト値 -> 確信度への写像パラメータ。
#
# 較正の根拠: 正解時のコントラストは概ね 0.37〜0.42、無調・ノイズでは 0 付近。
# ただし**コントラストの大きさだけでは正誤を区別できない**。Am (A,C,E) と
# Fmaj7 (F,A,C,E) のように構成音を共有するコードは同程度のスコアを出すため。
# 区別に効くのは2位との差（margin）だけなので、margin の寄与を大きめに取り、
# 典型的な検出が「たぶん」段階に収まるようにしてある。コード検出を軒並み
# 「確実」と表示するのは、間違いに気づけない初心者に対して有害。
_CONTRAST_FLOOR = 0.12
_CONTRAST_SPAN = 0.40
_MARGIN_FULL = 0.04
_MARGIN_BASE_WEIGHT = 0.7

# ベース音とルートが一致するテンプレートに加点する量。正解候補同士の
# コントラスト差（0.01〜0.03）を上回り、かつ全く合わないコードを引き寄せない
# 程度の大きさに取る。
_BASS_ROOT_BONUS = 0.05

# ベース音を取り出す低域の範囲（オクターブ数）。C1 から2オクターブ＝C1〜C3。
_BASS_OCTAVES = 2

# キー判定に必要なクロマの起伏（変動係数 = 標準偏差 / 平均）。
# これを下回るとどの音も同程度に鳴っている＝調性が無いとみなす。
_KEY_FLATNESS_MIN = 0.25

# ディグリーのローマ数字。長調・短調それぞれ、主音からの半音数 -> 表記
_DEGREE_MAJOR = ["I", "bII", "II", "bIII", "III", "IV", "#IV", "V", "bVI", "VI", "bVII", "VII"]
_DEGREE_MINOR = ["I", "bII", "II", "III", "#III", "IV", "#IV", "V", "VI", "#VI", "VII", "#VII"]


def _note_to_pc(name):
    """音名を 0〜11 のピッチクラス番号に変換する。

    Args:
        name (str): 音名（``"C"``, ``"C#"``, … ``"B"``）。大文字小文字は区別しない。

    Returns:
        int: ピッチクラス番号（C=0, C#=1, … B=11）。

    Raises:
        ValueError: ``name`` が NOTE_NAMES に含まれない場合。
    """
    upper = name.strip().upper()
    if upper not in NOTE_NAMES:
        raise ValueError(f"不明な音名: {name}")
    return NOTE_NAMES.index(upper)


def estimate_key(chroma_mean):
    """クロマ平均ベクトルから楽曲のキー（調）を推定する。

    Krumhansl-Schmuckler アルゴリズムを用いる。12音のクロマ平均を長調・短調
    それぞれ12通りに回転させたプロファイルと相関を取り、最も相関の高い組を
    キーとして返す。

    確信度は「最良の相関」と「2番目に良い相関」の差を基に算出する。
    単純に相関値をそのまま使うと、無調の曲でも高い値が出てしまうため。

    Args:
        chroma_mean (numpy.ndarray): 長さ12のクロマ平均ベクトル。
            インデックスは C=0, C#=1, … B=11 に対応。

    Returns:
        dict: 以下のキーを持つ辞書。

        .. code-block:: python

            {
                "tonic":      str,    # 主音の音名（例: "C"）
                "mode":       str,    # "major" または "minor"
                "confidence": float,  # 確信度 0.0〜1.0
                "alternatives": [     # 次点の候補（最大2件）
                    {"tonic": str, "mode": str, "confidence": float},
                ],
            }

        全ての相関が計算不能（クロマが全て0など）の場合は ``tonic`` と
        ``mode`` が ``None``、``confidence`` が ``0.0`` の辞書を返す。

    Note:
        numpy を関数内で遅延インポートする。
    """
    import numpy as np

    chroma = np.asarray(chroma_mean, dtype=float)
    if chroma.shape[0] != 12:
        raise ValueError(f"クロマベクトルの長さは12である必要があります: {chroma.shape[0]}")

    total = float(np.sum(chroma))
    if total <= 0 or not np.isfinite(total):
        return {"tonic": None, "mode": None, "confidence": 0.0, "alternatives": []}

    chroma = chroma / total

    # クロマが平坦（＝どの音も同程度に鳴っている）ならキーは存在しない。
    # ホワイトノイズや打楽器のみの音源で、相関の僅かな揺らぎを拾って
    # もっともらしいキーを出してしまうのを防ぐ
    mean = float(np.mean(chroma))
    flatness = float(np.std(chroma)) / mean if mean > 0 else 0.0
    if flatness < _KEY_FLATNESS_MIN:
        return {"tonic": None, "mode": None, "confidence": 0.0, "alternatives": []}

    candidates = []
    for mode, profile in (("major", KS_MAJOR_PROFILE), ("minor", KS_MINOR_PROFILE)):
        prof = np.asarray(profile, dtype=float)
        prof = prof / np.sum(prof)
        for tonic_pc in range(12):
            rotated = np.roll(prof, tonic_pc)
            # ピアソン相関。分散が0なら相関は定義できないので0扱い
            if np.std(chroma) == 0 or np.std(rotated) == 0:
                corr = 0.0
            else:
                corr = float(np.corrcoef(chroma, rotated)[0, 1])
            if not np.isfinite(corr):
                corr = 0.0
            candidates.append({"tonic": NOTE_NAMES[tonic_pc], "mode": mode, "score": corr})

    candidates.sort(key=lambda c: c["score"], reverse=True)
    best = candidates[0]
    second = candidates[1]

    # 確信度: 1位と2位のスコア差を [0,1] に写す。差が0.15以上で確信度1.0とみなす
    margin = max(0.0, best["score"] - second["score"])
    confidence = min(1.0, margin / 0.15)
    # 相関自体が低い（無調・ノイズ）場合は確信度を引き下げる
    if best["score"] < 0.3:
        confidence *= max(0.0, best["score"] / 0.3)

    return {
        "tonic": best["tonic"],
        "mode": best["mode"],
        "confidence": confidence,
        "alternatives": [
            {"tonic": c["tonic"], "mode": c["mode"], "confidence": max(0.0, c["score"])}
            for c in candidates[1:3]
        ],
    }


def _chord_contrast(chroma_vec, root_pc, intervals):
    """クロマに対するコードテンプレートの「コントラスト」を算出する。

    コードトーンの平均エネルギーと非コードトーンの平均エネルギーの相対差を返す。

    コサイン類似度を使わないのは、テンプレートに含まれるのにクロマ上で
    鳴っていない音を十分に罰しないため。その結果4音テンプレートが3音を
    組織的に打ち負かし、G が Gmaj7 に、Am が Fmaj7（A/C/E を含む）に
    化ける。コントラスト方式なら鳴っていない構成音がコードトーン側の平均を
    下げるので、この偏りが消える。

    Args:
        chroma_vec (numpy.ndarray): 長さ12のクロマベクトル。正規化不要。
        root_pc (int): ルートのピッチクラス（0〜11）。
        intervals (list[int]): ルートからの半音インターバル。

    Returns:
        float: -1.0〜1.0 のコントラスト値。全ピッチクラスが均等（無調・
            ノイズ）なら 0 付近、コードトーンだけが鳴っていれば 1 に近づく。
    """
    import numpy as np

    chord_idx = [(root_pc + i) % 12 for i in intervals]
    other_idx = [i for i in range(12) if i not in chord_idx]
    chord_mean = float(np.mean(chroma_vec[chord_idx]))
    other_mean = float(np.mean(chroma_vec[other_idx]))
    denominator = chord_mean + other_mean
    if denominator <= 0:
        return 0.0
    return (chord_mean - other_mean) / denominator


def _match_chord(chroma_vec, bass_pc=None):
    """単一のクロマベクトルに最も合致するコードを1つ返す。

    CHORD_TEMPLATES の全品質 × 12ルートを総当たりし、``_chord_contrast``
    が最大となる組を選ぶ。

    ``bass_pc`` を渡すとルートが一致するテンプレートを優遇する。クロマだけでは
    Am (A,C,E) と Fmaj7 (F,A,C,E) のように包含関係にあるコードを原理的に
    区別できないため。低音がどの音かは実際に鳴っているルートを強く示唆する
    ので、この手がかりが誤検出をほぼ解消する。

    確信度はコントラスト値を実測に基づいて 0.0〜1.0 に写したもの。正解時の
    コントラストは概ね 0.37〜0.42 に収まるため、その帯が高確信度になるよう
    較正してある。2位との差（margin）はコード同士がもともと構成音を共有する
    以上どうしても小さくなるので、乗数ではなく微調整としてのみ効かせる。

    Args:
        chroma_vec (numpy.ndarray): 長さ12のクロマベクトル。
        bass_pc (int | None, optional): 低域から推定したベース音のピッチクラス
            （0〜11）。None なら手がかりとして使わない。

    Returns:
        tuple[int, str, float] | None: ``(root_pc, quality, confidence)`` のタプル。
            ``root_pc`` はルートのピッチクラス（0〜11）、``quality`` は
            CHORD_TEMPLATES のキー、``confidence`` は 0.0〜1.0。
            クロマが全て0の場合は ``None``。

    Note:
        numpy を関数内で遅延インポートする。
    """
    import numpy as np

    vec = np.asarray(chroma_vec, dtype=float)
    if vec.size != 12 or not np.all(np.isfinite(vec)) or float(np.sum(vec)) <= 0:
        return None

    best = None
    second_score = -1.0
    for quality, intervals in CHORD_TEMPLATES.items():
        for root_pc in range(12):
            score = _chord_contrast(vec, root_pc, intervals)
            if bass_pc is not None and root_pc == bass_pc:
                score += _BASS_ROOT_BONUS
            if best is None or score > best[2]:
                second_score = best[2] if best is not None else -1.0
                best = (root_pc, quality, score)
            elif score > second_score:
                second_score = score

    if best is None:
        return None

    root_pc, quality, score = best
    base = min(1.0, max(0.0, (score - _CONTRAST_FLOOR) / _CONTRAST_SPAN))
    margin = max(0.0, score - second_score)
    margin_factor = _MARGIN_BASE_WEIGHT + (1.0 - _MARGIN_BASE_WEIGHT) * min(1.0, margin / _MARGIN_FULL)
    return root_pc, quality, min(1.0, base * margin_factor)


def detect_chords(file_path, beat_times, tonic=None, mode=None, min_confidence=0.35):
    """音声ファイルからビート単位でコードを検出し、同一コードを結合して返す。

    各ビート区間のクロマを平均し、コードテンプレートとのコサイン類似度で
    品質とルートを決める。隣接するビートが同じコードなら1つのイベントに
    結合するため、1小節に複数コードがある楽曲にも対応する。

    Args:
        file_path (str): 解析する音声ファイルのパス。
        beat_times (list[float]): 実測ビート位置（秒）の昇順リスト。
            ``structure.estimate_grid`` が返す ``beat_times_sec`` を渡す想定。
        tonic (str | None, optional): キーの主音（例: ``"C"``）。
            指定するとディグリー表記を付与する。None の場合 ``degree`` は None。
        mode (str | None, optional): ``"major"`` または ``"minor"``。
            ``tonic`` と併せて指定する。
        min_confidence (float, optional): この値未満の確信度のコードは捨てる。
            デフォルト 0.35。

    Returns:
        list[dict]: コードイベントのリスト。各要素は以下のキーを持つ。

        .. code-block:: python

            {
                "beat_index": int,    # 開始ビートの通し番号（0始まり）
                "beat_count": int,    # 継続するビート数
                "start_sec":  float,  # 開始位置（秒）
                "end_sec":    float,  # 終了位置（秒）
                "root":       str,    # ルート音名（例: "C"）
                "quality":    str,    # 品質（CHORD_TEMPLATES のキー）
                "symbol":     str,    # 表示用コード名（例: "Cmaj7"）
                "degree":     str|None,  # ディグリー表記（例: "I"）
                "confidence": float,  # 確信度 0.0〜1.0
            }

        ビートが2点未満の場合、または全ビートが低確信度の場合は空リストを返す。

    Note:
        小節・拍への変換は行わない。呼び出し側（``song_chart``）が
        グリッド情報と突き合わせて ``bar`` / ``beat`` を付与する。
        numpy および librosa を関数内で遅延インポートする。
    """
    import numpy as np
    import librosa

    if beat_times is None or len(beat_times) < 2:
        return []

    y, sr = librosa.load(file_path, sr=22050, mono=True)
    if len(y) == 0:
        return []

    # CQT ベースのクロマ。和音認識では STFT クロマより低音の分解能が高い
    chroma = librosa.feature.chroma_cqt(y=y, sr=sr, hop_length=512)
    # 低域だけのクロマ。ベース音＝ルートの手がかりとして使う
    bass_chroma = librosa.feature.chroma_cqt(
        y=y, sr=sr, hop_length=512,
        fmin=librosa.note_to_hz("C1"), n_octaves=_BASS_OCTAVES,
    )
    frame_times = librosa.frames_to_time(np.arange(chroma.shape[1]), sr=sr, hop_length=512)

    # ビートごとにクロマとベース音を平均する
    beat_chroma = []
    beat_bass = []
    for i in range(len(beat_times) - 1):
        start, end = beat_times[i], beat_times[i + 1]
        mask = (frame_times >= start) & (frame_times < end)
        if not np.any(mask):
            beat_chroma.append(None)
            beat_bass.append(None)
            continue
        beat_chroma.append(np.mean(chroma[:, mask], axis=1))
        low = np.mean(bass_chroma[:, mask[:bass_chroma.shape[1]]], axis=1)
        beat_bass.append(int(np.argmax(low)) if float(np.sum(low)) > 0 else None)

    # 音が減衰しきった拍は和音成分が乏しく、幽霊コードの発生源になる。
    # 全体のエネルギー中央値を基準に、極端に弱い拍は判定対象から外す
    energies = [float(np.sum(c)) for c in beat_chroma if c is not None]
    energy_floor = (np.median(energies) * 0.35) if energies else 0.0

    # 隣接する拍とクロマを混ぜて平滑化する。1拍だけの揺らぎを抑えつつ、
    # 2拍単位のコードチェンジ（1小節2コード）は残る重み付けにしてある
    smoothed = _smooth_beat_chroma(beat_chroma)

    per_beat = []
    for i, vec in enumerate(smoothed):
        if vec is None or beat_chroma[i] is None or float(np.sum(beat_chroma[i])) < energy_floor:
            per_beat.append(None)
            continue
        matched = _match_chord(vec, bass_pc=beat_bass[i])
        per_beat.append(matched if matched and matched[2] >= min_confidence else None)

    per_beat = _despike_labels(per_beat)

    # 同一コードが続くビートを1イベントに結合する
    events = []
    run_start = None
    for i, current in enumerate(per_beat + [None]):
        prev = per_beat[run_start] if run_start is not None else None
        same = (
            run_start is not None
            and current is not None
            and current[0] == prev[0]
            and current[1] == prev[1]
        )
        if same:
            continue
        if run_start is not None:
            events.append(_build_chord_event(per_beat, beat_times, run_start, i, tonic, mode))
        run_start = i if current is not None else None

    return [e for e in events if e is not None]


def _despike_labels(per_beat):
    """前後に同じコードが挟まれた1拍だけの別コードを、その前後のコードで置き換える。

    コード境界や打楽器のアタックで1拍だけ別のコードに化けることがあり、
    そのまま結合すると「C / 一瞬 Csus4 / C」のような無意味なイベントが
    大量に並ぶ。前後が一致しているときだけ潰すので、2拍以上続く本物の
    コードチェンジ（1小節2コード）は残る。

    Args:
        per_beat (list[tuple | None]): 拍ごとの ``(root_pc, quality, confidence)``
            または None のリスト。

    Returns:
        list[tuple | None]: 単発の揺らぎを均したリスト。長さは入力と同じ。
    """
    if len(per_beat) < 3:
        return list(per_beat)

    result = list(per_beat)
    for i in range(1, len(per_beat) - 1):
        prev_beat, current, next_beat = per_beat[i - 1], per_beat[i], per_beat[i + 1]
        if prev_beat is None or next_beat is None:
            continue
        if prev_beat[0] != next_beat[0] or prev_beat[1] != next_beat[1]:
            continue
        if current is not None and current[0] == prev_beat[0] and current[1] == prev_beat[1]:
            continue
        # 前後が同じコードで真ん中だけ違う（または欠落）→ 前後に合わせる
        result[i] = (prev_beat[0], prev_beat[1], min(prev_beat[2], next_beat[2]))
    return result


def _smooth_beat_chroma(beat_chroma, center_weight=0.5):
    """拍ごとのクロマを隣接拍と混ぜて平滑化する。

    単発の揺らぎ（音が減衰した拍、打楽器のみの拍）が幽霊コードを生むのを
    抑える。重みを中央に寄せてあるため、2拍単位のコードチェンジ（1小節に
    2コード）は潰れずに残る。

    Args:
        beat_chroma (list[numpy.ndarray | None]): 拍ごとのクロマベクトル。
            該当フレームが無かった拍は None。
        center_weight (float, optional): 中央の拍に与える重み。デフォルト 0.5。
            残りを前後の拍で等分する。

    Returns:
        list[numpy.ndarray | None]: 平滑化後のクロマ。入力が None の位置は None。
    """
    import numpy as np

    side_weight = (1.0 - center_weight) / 2
    result = []
    for i, center in enumerate(beat_chroma):
        if center is None:
            result.append(None)
            continue
        total = center * center_weight
        weight_sum = center_weight
        for offset in (-1, 1):
            j = i + offset
            if 0 <= j < len(beat_chroma) and beat_chroma[j] is not None:
                total = total + beat_chroma[j] * side_weight
                weight_sum += side_weight
        result.append(total / weight_sum if weight_sum > 0 else center)
    return result


def _build_chord_event(per_beat, beat_times, start_index, end_index, tonic, mode):
    """結合済みのビート範囲から1つのコードイベント辞書を組み立てる。

    Args:
        per_beat (list): ビートごとの ``(root_pc, quality, confidence)`` または None のリスト。
        beat_times (list[float]): 実測ビート位置（秒）。
        start_index (int): 範囲の開始ビートインデックス（含む）。
        end_index (int): 範囲の終了ビートインデックス（含まない）。
        tonic (str | None): キーの主音。ディグリー表記に使う。
        mode (str | None): ``"major"`` または ``"minor"``。

    Returns:
        dict | None: ``detect_chords`` が返す形式のコードイベント。
            開始ビートが None（コード未検出）の場合は None。
    """
    entry = per_beat[start_index]
    if entry is None:
        return None

    root_pc, quality, _ = entry
    confidences = [per_beat[i][2] for i in range(start_index, end_index) if per_beat[i] is not None]
    confidence = sum(confidences) / len(confidences) if confidences else 0.0

    root_name = NOTE_NAMES[root_pc]
    end_sec = beat_times[end_index] if end_index < len(beat_times) else beat_times[-1]

    return {
        "beat_index": start_index,
        "beat_count": end_index - start_index,
        "start_sec": float(beat_times[start_index]),
        "end_sec": float(end_sec),
        "root": root_name,
        "quality": quality,
        "symbol": root_name + CHORD_SUFFIX[quality],
        "degree": to_degree(root_name, quality, tonic, mode),
        "confidence": confidence,
    }


def to_degree(root, quality, tonic, mode):
    """コードのルートと品質を、キーに対するディグリー（度数）表記に変換する。

    初心者に「Am7」と言っても意味が伝わらないが、「キーはCで、これは VIm7
    ＝悲しい響きを担当するコード」と言えれば教育になる。ディグリー表記は
    LLM が「なぜこう聞こえるか」を語るための足場でもある。

    長調は主音を I とする通常のローマ数字、短調は自然短音階を基準とする
    （Am キーにおいて Am = i、C = III、F = iv、G = VII）。
    短三和音系の品質は小文字、長三和音系は大文字で表記する。

    Args:
        root (str): コードのルート音名（例: ``"A"``）。
        quality (str): コード品質。CHORD_TEMPLATES のキー。
        tonic (str | None): キーの主音（例: ``"C"``）。None なら None を返す。
        mode (str | None): ``"major"`` または ``"minor"``。None なら None を返す。

    Returns:
        str | None: ディグリー表記（例: ``"vi"``, ``"V7"``, ``"bVII"``）。
            ``tonic`` または ``mode`` が None の場合、あるいは音名が
            不正な場合は None。

    Examples:
        >>> to_degree("A", "min7", "C", "major")
        'vim7'
        >>> to_degree("G", "7", "C", "major")
        'V7'
    """
    if not tonic or not mode:
        return None
    try:
        interval = (_note_to_pc(root) - _note_to_pc(tonic)) % 12
    except ValueError:
        return None

    table = _DEGREE_MAJOR if mode == "major" else _DEGREE_MINOR
    numeral = table[interval]

    if quality in _MINOR_QUALITIES:
        # 変化記号（b / #）は残したままローマ数字部分だけ小文字にする
        numeral = "".join(c.lower() if c.isalpha() else c for c in numeral)

    return numeral + CHORD_SUFFIX[quality]


# ---- 用語辞書 ----
#
# 初心者向けツールチップの供給元。カルテの各要素が用語キーを持ち、
# フロントはこの辞書を引いて解説を表示する。
# LLM（第2層）にも同じ辞書を渡すことで、画面の説明とAIの説明が食い違わない。
#
# 多言語対応の器として {"ja": ..., "en": ...} の構造にしてある。
# v1 では日本語のみ埋める。

GLOSSARY = {
    # --- キー・調 ---
    "key": {"ja": "曲全体の中心となる音（主音）と、その周りの音の組み合わせ。「キーがC」なら、ドを中心にした音で曲ができている。"},
    "major": {"ja": "長調。明るい・晴れやかな響きになる音の並び。"},
    "minor": {"ja": "短調。暗い・切ない響きになる音の並び。"},
    "tonic": {"ja": "主音。曲が「帰ってきた」と感じる中心の音。"},

    # --- コード ---
    "chord": {"ja": "複数の音を同時に鳴らした和音。曲の雰囲気の土台になる。"},
    "degree": {"ja": "ディグリー。キーの主音から数えて何番目の音がルートかを表す記号。キーが変わっても同じ進行だと同じ番号になるので、進行のパターンを覚えるのに便利。"},
    "maj": {"ja": "メジャーコード。明るく安定した響き。"},
    "min": {"ja": "マイナーコード。暗く切ない響き。"},
    "dim": {"ja": "ディミニッシュ。不安定で緊張感のある響き。次のコードへ進みたくなる。"},
    "aug": {"ja": "オーギュメント。浮遊感のある不思議な響き。"},
    "sus4": {"ja": "サスフォー。宙ぶらりんな響きで、解決を期待させる。"},
    "maj7": {"ja": "メジャーセブンス。おしゃれで柔らかい響き。"},
    "min7": {"ja": "マイナーセブンス。切なさが少し和らいだ、落ち着いた響き。"},
    "7": {"ja": "セブンス（ドミナントセブンス）。次のコードへ強く進みたがる響き。"},
    "m7b5": {"ja": "ハーフディミニッシュ。マイナーキーでよく使われる、不安定で切ない響き。"},

    # --- グリッド ---
    "bpm": {"ja": "テンポ。1分間に刻まれる拍の数。数字が大きいほど速い曲。"},
    "downbeat_offset": {"ja": "曲の1拍目が始まる位置（秒）。ここがずれると小節線が全部ずれる。"},
    "time_signature": {"ja": "拍子。1小節に何拍入るか。ほとんどの曲は4/4（1小節4拍）。"},
    "beat": {"ja": "拍。曲に合わせて足で刻むリズムの単位。"},
    "bar": {"ja": "小節。拍をまとめた単位。4/4拍子なら4拍で1小節。"},

    # --- セクション ---
    "section": {"ja": "曲の構成上のまとまり。イントロ・Aメロ・サビなど。"},
    "repeat_group": {"ja": "似た内容で繰り返されている区間のグループ。同じ記号の区間は音の作りが似ている。"},
    "onset_density": {"ja": "音の詰まり具合。1秒あたりに何回音が鳴り始めるか。数字が大きいほど賑やかな区間。"},

    # --- ミックス ---
    "loudness_lufs": {"ja": "体感的な音の大きさ。市販曲はおおむね -14〜-8 LUFS。数字が0に近いほど大きい。"},
    "peak_dbfs": {"ja": "波形の最大値。0を超えると音が割れる。市販曲は -1〜-0.1 付近。"},
    "dynamic_range_db": {"ja": "曲中の音量の幅。小さいほど「ずっと大きい音」で迫力が出るが、抑揚は失われる。"},
    "stereo_width": {"ja": "音の左右の広がり。0に近いとモノラル（中央に固まる）、1に近いと左右に大きく広がる。"},
    "bass_mono": {"ja": "低音が左右中央にまとまっているか。市販曲は低音をモノラルにするのが定石で、そのほうが低音が力強く聞こえる。"},
    "reverb_tail_sec": {"ja": "残響の長さ。音が鳴り止んでから消えるまでの時間。長いほど広い空間で鳴っている感じになる。"},
    "spectrum_bands": {"ja": "帯域ごとの音のエネルギー配分。低音が厚いのか高音がきらびやかなのか、曲の音の傾向が分かる。"},

    # --- 確信度 ---
    "confidence": {"ja": "解析結果の確からしさ。「自信なし」と出ている項目は、耳で確認したほうがよい。"},
}


def glossary_entry(term, lang="ja"):
    """用語辞書から解説文を1件取得する。

    Args:
        term (str): 用語キー（GLOSSARY のキー）。コード品質名やスキーマの
            フィールド名をそのまま渡せる。
        lang (str, optional): 言語コード。デフォルト ``"ja"``。
            該当言語の訳が無い場合は日本語にフォールバックする。

    Returns:
        str | None: 解説文。用語が辞書に無い場合は None。
    """
    entry = GLOSSARY.get(term)
    if not entry:
        return None
    return entry.get(lang) or entry.get("ja")
