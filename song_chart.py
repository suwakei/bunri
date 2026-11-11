"""
bunri DAW — 楽曲カルテの組み立てと正規化（第1層）

``structure`` / ``music_theory`` / ``mix_profile`` の解析結果を1つの
カルテ辞書にまとめる。カルテは第2層（再現ガイド）と第3層（差分コーチ）が
参照する唯一の正であり、画面表示はここからの派生ビューとして作る。

設計上の制約:
- 時間参照は全て小節・拍の絶対位置。LLM がハイライト先を一意に指せるようにする
- 出力はバイト安定にする（sort_keys + 固定桁の丸め）。プロンプトキャッシュの
  プレフィックスとしてそのまま使うため、1バイトでも揺れるとキャッシュが飛ぶ
- 解析日時・UUID・一時パスはカルテ本体に入れない（同上）
- 低確信度の項目は値を入れず ``unavailable`` に理由を書く。間違った値に
  「自信なし」と貼っても初心者は結局それを信じてしまうため
"""
import json

SCHEMA_VERSION = 1

# 確信度をこの3段階に丸めて画面に出す。生値はカルテに残して LLM へ渡す
TIER_CERTAIN = "certain"
TIER_LIKELY = "likely"
TIER_UNSURE = "unsure"

_TIER_CERTAIN_MIN = 0.7
_TIER_LIKELY_MIN = 0.4

# これ未満の確信度の項目は値を出さず unavailable に落とす
MIN_CONFIDENCE = 0.25

# 全ての浮動小数点をこの桁で丸める。バイト安定性のため桁数は固定
_FLOAT_PRECISION = 4


def confidence_tier(value):
    """確信度の生値を初心者向けの3段階に丸める。

    「キーはCメジャー（0.71）」と出されても初心者には判断材料にならないため、
    画面表示には段階を使う。生値はカルテに残り LLM へ渡される。

    Args:
        value (float | None): 確信度（0.0〜1.0）。None は最低段階として扱う。

    Returns:
        str: ``"certain"``（確実）、``"likely"``（たぶん）、
            ``"unsure"``（自信なし）のいずれか。
    """
    if value is None:
        return TIER_UNSURE
    if value >= _TIER_CERTAIN_MIN:
        return TIER_CERTAIN
    if value >= _TIER_LIKELY_MIN:
        return TIER_LIKELY
    return TIER_UNSURE


def build_chart(audio_path, filename=None, bpm=None, downbeat_offset=None, beats_per_bar=4):
    """音声ファイルから楽曲カルテを組み立てる。

    ステム分離は行わない（速報カルテ）。原曲ミックスのみを解析するため
    数秒〜十数秒で完了する。Demucs を使う詳細解析は第2弾の別経路。

    ``bpm`` / ``downbeat_offset`` / ``beats_per_bar`` を指定すると、その
    グリッドを前提に再解析する。グリッド補正UIからの再計算経路。

    Args:
        audio_path (str): 解析する音声ファイルのパス。
        filename (str | None, optional): カルテに記録する表示用ファイル名。
            None なら ``audio_path`` のファイル名部分を使う。
            一時ファイルのフルパスをカルテに残さないための引数。
        bpm (float | None, optional): BPM の上書き値。None なら自動検出。
        downbeat_offset (float | None, optional): 1拍目の位置（秒）の上書き値。
        beats_per_bar (int, optional): 1小節あたりの拍数。デフォルト 4。

    Returns:
        dict: 正規化済みのカルテ辞書。構造は ``docs/song-chart-design.md`` を参照。
            主要キーは ``version`` / ``source`` / ``grid`` / ``key`` /
            ``sections`` / ``chords`` / ``mix`` / ``unavailable``。

    Raises:
        FileNotFoundError: ``audio_path`` が存在しない場合。
        RuntimeError: 音声の読み込みに失敗した場合。

    Note:
        波形ピークはカルテに含めない。サイズが大きくバイト安定性も損なうため、
        API のレスポンスでカルテと並べて返す（``waveform_peaks`` を参照）。
    """
    from pathlib import Path
    import structure
    import music_theory
    import mix_profile

    path = Path(audio_path)
    if not path.exists():
        raise FileNotFoundError(f"音声ファイルが見つかりません: {audio_path}")

    unavailable = {}

    grid = structure.estimate_grid(
        str(path), bpm=bpm, downbeat_offset=downbeat_offset, beats_per_bar=beats_per_bar
    )
    beat_times = grid["beat_times_sec"]
    if len(beat_times) < 2:
        unavailable["grid"] = "ビートを検出できませんでした（音声が短すぎる可能性があります）"

    key = _analyze_key(str(path), unavailable)
    tonic = key.get("tonic")
    mode = key.get("mode")

    chords = music_theory.detect_chords(str(path), beat_times, tonic=tonic, mode=mode)
    chords = [c for c in chords if c["confidence"] >= MIN_CONFIDENCE]
    if not chords:
        unavailable["chords"] = "コードを検出できませんでした（打楽器のみ、または和音成分が薄い可能性があります）"
    else:
        _attach_bar_beat(chords, beat_times, beats_per_bar)

    sections = structure.detect_sections(str(path), beat_times, beats_per_bar=beats_per_bar)
    if not sections:
        unavailable["sections"] = "構成を検出できませんでした（曲が短い、または変化が乏しい可能性があります）"

    mix = mix_profile.analyze_mix(str(path))
    if mix.get("loudness_lufs") is None:
        unavailable["mix"] = "ミックス特性を解析できませんでした（無音に近い可能性があります）"

    chart = {
        "version": SCHEMA_VERSION,
        "source": {
            "filename": filename or path.name,
            "duration_sec": _duration_sec(str(path)),
        },
        "grid": grid,
        "key": key,
        "sections": sections,
        "chords": chords,
        "mix": mix,
        "unavailable": unavailable,
    }
    return normalize_chart(chart)


def _analyze_key(audio_path, unavailable):
    """音声からキーを推定し、低確信度なら値を落として理由を記録する。

    Args:
        audio_path (str): 解析する音声ファイルのパス。
        unavailable (dict): 検出できなかった項目の理由を書き込む辞書。
            破壊的に更新される。

    Returns:
        dict: ``music_theory.estimate_key`` と同じ形式の辞書。
            確信度が MIN_CONFIDENCE 未満の場合、``tonic`` と ``mode`` は None。

    Side Effects:
        キーを判定できなかった場合、``unavailable["key"]`` に理由を書き込む。
    """
    import numpy as np
    import librosa
    import music_theory

    y, sr = librosa.load(audio_path, sr=structure_sr(), mono=True)
    if len(y) == 0:
        unavailable["key"] = "キーを判定できませんでした（音声が空です）"
        return {"tonic": None, "mode": None, "confidence": 0.0, "alternatives": []}

    chroma = librosa.feature.chroma_cqt(y=y, sr=sr)
    key = music_theory.estimate_key(np.mean(chroma, axis=1))

    if key["confidence"] < MIN_CONFIDENCE or not key["tonic"]:
        unavailable["key"] = "キーを判定できませんでした（無調、または打楽器のみの可能性があります）"
        key["tonic"] = None
        key["mode"] = None

    return key


def structure_sr():
    """解析に用いるサンプルレートを返す。

    ``structure`` モジュールと値を揃えるための薄いアクセサ。

    Returns:
        int: 解析用サンプルレート（Hz）。
    """
    import structure
    return structure.ANALYSIS_SR


def _attach_bar_beat(chords, beat_times, beats_per_bar):
    """コードイベントに小節・拍の絶対位置を付与する。

    LLM がハイライト先を一意に指せるよう、時間参照は全て小節・拍で表す。
    ビート列はダウンビートを起点に切り詰められているため、ビート番号 0 が
    1小節目の1拍目に対応する。

    Args:
        chords (list[dict]): ``music_theory.detect_chords`` が返したコードイベント。
            破壊的に ``bar`` と ``beat`` が追加される。
        beat_times (list[float]): 実測ビート位置（秒）。
        beats_per_bar (int): 1小節あたりの拍数。

    Side Effects:
        ``chords`` の各要素に ``bar``（1始まり）と ``beat``（1始まり）を追加する。
    """
    per_bar = max(1, int(beats_per_bar))
    for chord in chords:
        index = chord["beat_index"]
        chord["bar"] = index // per_bar + 1
        chord["beat"] = index % per_bar + 1


def _duration_sec(audio_path):
    """音声ファイルの長さを秒で返す。

    Args:
        audio_path (str): 音声ファイルのパス。

    Returns:
        float: 長さ（秒）。取得に失敗した場合は 0.0。
    """
    import librosa
    try:
        return float(librosa.get_duration(path=audio_path))
    except Exception:
        return 0.0


def normalize_chart(chart):
    """カルテを正規化し、バイト安定な形に整える。

    numpy のスカラ型を Python の組み込み型へ落とし、全ての浮動小数点を
    固定桁で丸める。これを怠ると ``0.30000000000000004`` のような揺れが
    そのまま JSON に出て、プロンプトキャッシュが毎回ミスする。

    Args:
        chart (dict): 正規化前のカルテ辞書。

    Returns:
        dict: 正規化済みのカルテ辞書。入力は変更しない。
    """
    return _normalize_value(chart)


def _normalize_value(value):
    """値を再帰的に走査し、numpy 型の除去と浮動小数点の丸めを行う。

    Args:
        value: 任意の値（dict / list / tuple / 数値 / 文字列 / None）。

    Returns:
        正規化された値。dict はキー順で並べ替えられる。
    """
    if isinstance(value, dict):
        return {k: _normalize_value(value[k]) for k in sorted(value)}
    if isinstance(value, (list, tuple)):
        return [_normalize_value(v) for v in value]
    if isinstance(value, bool):
        return value
    if isinstance(value, int):
        return int(value)
    if isinstance(value, float):
        return round(float(value), _FLOAT_PRECISION)
    # numpy スカラなど .item() を持つ型を Python 型に落とす
    if hasattr(value, "item"):
        try:
            return _normalize_value(value.item())
        except (ValueError, AttributeError):
            return value
    return value


def to_canonical_json(chart):
    """カルテをバイト安定な JSON 文字列に直列化する。

    プロンプトキャッシュのプレフィックスとしてそのまま使える形。
    同じカルテからは常に同じバイト列が得られる。

    Args:
        chart (dict): 正規化済みのカルテ辞書。

    Returns:
        str: キー順が固定され、区切り文字も固定された JSON 文字列。
    """
    return json.dumps(
        normalize_chart(chart),
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )


def waveform_peaks(audio_path, points=2000):
    """波形描画用のピーク配列を生成する。

    グリッド補正UIで波形とビートグリッドを重ねて表示するためのデータ。
    フロントで数十MBの音声をデコードさせず、バックエンドで間引いて返す。
    低スペックPCを前提とする本プロジェクトでは、ブラウザに 63MB 以上の
    AudioBuffer を保持させないことが重要。

    **カルテには含めない。**サイズが大きく、バイト安定性も損なうため。

    Args:
        audio_path (str): 音声ファイルのパス。
        points (int, optional): 出力するバケット数。デフォルト 2000。

    Returns:
        dict: 以下のキーを持つ辞書。

        .. code-block:: python

            {
                "points":       int,          # 実際のバケット数
                "duration_sec": float,
                "min":          list[float],  # 各バケットの最小値（-1.0〜0.0）
                "max":          list[float],  # 各バケットの最大値（0.0〜1.0）
            }

        音声が空の場合は ``points`` が 0 で ``min`` / ``max`` が空リスト。

    Note:
        numpy と librosa を関数内で遅延インポートする。
    """
    import numpy as np
    import librosa

    y, sr = librosa.load(audio_path, sr=None, mono=True)
    if len(y) == 0:
        return {"points": 0, "duration_sec": 0.0, "min": [], "max": []}

    bucket_count = int(max(1, min(points, len(y))))
    edges = np.linspace(0, len(y), bucket_count + 1, dtype=int)

    mins, maxs = [], []
    for i in range(bucket_count):
        segment = y[edges[i]:edges[i + 1]]
        if len(segment) == 0:
            mins.append(0.0)
            maxs.append(0.0)
            continue
        mins.append(round(float(np.min(segment)), 4))
        maxs.append(round(float(np.max(segment)), 4))

    return {
        "points": bucket_count,
        "duration_sec": round(float(len(y) / sr), 4),
        "min": mins,
        "max": maxs,
    }
