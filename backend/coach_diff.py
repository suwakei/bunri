"""差分コーチ（第3層）の土台 — お手本のノートと、利用者の打ち込みの差分を事実として出す

第3層は「利用者の打ち込みと原曲の差分を指摘する」層。ここはそのうち **事実を出す部分** で、
LLM は使わない。お手本（原曲を採譜したノート）と打ち込みを突き合わせ、どの小節のどの音が
合っていて、どこが抜けていて、どこが違うかを、機械的に決まる形で返す。

言葉にする部分（なぜずれているか、次に何を直すとよいか）は、この結果を材料にして
あとから載せる。事実と言語化を分けておくのは、第1層・第2層と同じ理由による。

ノートの形はピアノロールと同じ: ``{"note": "C", "octave": 4, "step": 0, "length": 4}``。
``step`` と ``length`` は 16 分音符単位で、小数も受け付ける（0.5 = 32 分音符、4/3 = 8 分の三連）。
値は 1/60 ステップの倍数に丸めてから比べ、整数になる値は整数のまま返す（``note_steps``）。整数だけの入力に
対する結果は、小数を許す前と同じ。``velocity``（強さ。1〜127）は在っても無くてもよい。

強さ（ベロシティ）の違いは、**お手本が MIDI ファイルから読み込んだもののときだけ** 出す
（``reference_source="midi"``）。音源から採譜したお手本の強さは当てにならないので、比べない
（docs/coach-diff-design.md の「強さの違い」）。強さは、位置・高さ・長さの指摘とは別の欄
（結果の ``velocity``）に出し、指摘の一覧（``bars``）と一致率（``summary.accuracy``）には入れない。

小節ごとの「お手本のノートの数」と「合っていた数」も、別の欄（結果の ``bar_stats``）に出す。画面が、曲のどこを
比べ終えたかを小節ごとに記録するのに使う（docs/coach-diff-design.md の「練習の地図」）。数え方は一致率と同じで、
言語化（``coach_explain``）に渡す事実には入れない。
"""

import note_steps

NOTE_INDEX = {"C": 0, "C#": 1, "D": 2, "D#": 3, "E": 4, "F": 5, "F#": 6, "G": 7, "G#": 8, "A": 9, "A#": 10, "B": 11}

# 差分の種類。重い（まず直すべき）ものから並べてある
KINDS = ("missing", "pitch", "octave", "extra", "timing", "length")

# 一度に受け付けるノートの上限（突き合わせは件数の積に比例して重くなるため）
MAX_NOTES = 20000

# ---- 比べ方（``diff_notes`` の ``mode``） ----

# ふつうの比べ方（高さ・位置・長さ）と、ドラムの比べ方（リズムだけ。docs/coach-diff-design.md の「ドラムの差分」）
MODE_NOTES = "notes"
MODE_DRUMS = "drums"
# 「同じ位置」とみなす、位置のずれの上限（ステップ = 16 分音符）。``timing_tolerance`` を渡さなければ、比べ方で決まる。
# ドラムは 16 分音符 1 個: 16 分で刻むハイハットの隣どうしを取り違えないため（2 個だと、1 つ飛ばして組になりうる）
TIMING_TOLERANCE = {MODE_NOTES: 2, MODE_DRUMS: 1}
# 「位置のずれ」「長さの違い」として指摘する、差の下限（ステップ）。組になったノートの差がこれより小さければ、
# 合っているものとして扱う（指摘しない）。整数どうしの差は 0 か 1 以上なので、整数だけの入力の結果は変わらない。
# 0.5 にしたのは、16 分と三連の隣どうし（1 と 4/3。差は 1/3）を「ずれ」にせず、8 分の裏と三連の裏
# （2 と 8/3。差は 2/3）は「ずれ」にするため。根拠は docs/coach-diff-design.md の「小数の位置と長さ」
MIN_TIMING_ISSUE_STEPS = 0.5
MIN_LENGTH_ISSUE_STEPS = 0.5

# ---- 強さ（ベロシティ）の比べ方。値はどれも暫定（根拠は docs/coach-diff-design.md の「強さの違い」） ----

# 強さを比べてよい、お手本の出どころ。MIDI ファイルから読み込んだお手本だけ。
# 採譜したお手本（"transcription"）と、出どころの分からないお手本（None など）は、強さに触れない
VELOCITY_SOURCES = ("midi",)
# 強さを持たないノート（マウスで置いたもの）の強さ。画面の ``DEFAULT_VELOCITY`` と同じ（この値で鳴る）
DEFAULT_VELOCITY = 96
# 許す幅。強さの差がこれ以内なら、同じ強さとみなす（強弱記号 1 段階ぶん）
VELOCITY_TOLERANCE = 16
# まとまりとして言うのに要るノートの数（1〜2 ノートだけの違いは、弾きむらと区別できないので言わない）
VELOCITY_MIN_NOTES = 3
# アクセントの指摘に要るノートの数（アクセントは数が少ないのがふつうなので、2 個から）
VELOCITY_MIN_ACCENTS = 2
# 「全体に弱い・強い」と言うのに要る割合（比べたノートのうち、許す幅を超えて同じ向きに違うもの）
VELOCITY_OVERALL_SHARE = 0.75


class DiffError(ValueError):
    """差分を出せない入力だったときの例外。メッセージは利用者にそのまま見せられる。"""


def _pitch(note):
    """ノートの高さを MIDI ノート番号にする（C4 = 60）。"""
    return (note["octave"] + 1) * 12 + NOTE_INDEX[note["note"]]


def _clean(notes, label):
    """入力のノート列を確かめ、突き合わせ用の形にそろえる。

    Args:
        notes: ノートのリスト。
        label: エラーメッセージに使う呼び名（「お手本」「打ち込み」）。

    Returns:
        list[dict]: ``note`` ``octave`` ``step`` ``length`` ``pitch`` ``velocity`` と、比べるための
        ``step_ticks`` ``length_ticks``（1/60 ステップ単位の整数）を持つ辞書のリスト（位置順）。
        ``step`` と ``length`` は 1/60 ステップの倍数に丸めた値（整数になる値は整数）。

    Raises:
        DiffError: リストでない、件数が多すぎる、ノートの形が正しくない場合
            （``step`` が負・数でない、``length`` が 0 以下・丸めると 0・数でない、NaN や無限、bool）。
    """
    if not isinstance(notes, list):
        raise DiffError(f"{label}のノートの形式が正しくありません")
    if len(notes) > MAX_NOTES:
        raise DiffError(f"{label}のノートが多すぎます（上限 {MAX_NOTES} 件）")
    cleaned = []
    for raw in notes:
        if not isinstance(raw, dict):
            raise DiffError(f"{label}のノートの形式が正しくありません")
        name, octave, step, length = raw.get("note"), raw.get("octave"), raw.get("step"), raw.get("length")
        # 位置と長さは、刻みの数（1/60 ステップ単位の整数）に直してから確かめる。数でない・bool・NaN・無限は None
        step_ticks, length_ticks = note_steps.to_ticks(step), note_steps.to_ticks(length)
        valid = (
            name in NOTE_INDEX
            and isinstance(octave, int) and not isinstance(octave, bool) and -1 <= octave <= 9
            and step_ticks is not None and step >= 0
            and length_ticks is not None and length_ticks > 0
        )
        if not valid:
            raise DiffError(f"{label}のノートの形式が正しくありません")
        note = {"note": name, "octave": octave,
                "step": note_steps.from_ticks(step_ticks), "length": note_steps.from_ticks(length_ticks)}
        note["pitch"] = _pitch(note)
        note["velocity"] = _velocity(raw.get("velocity"))
        note["step_ticks"], note["length_ticks"] = step_ticks, length_ticks
        cleaned.append(note)
    cleaned.sort(key=lambda n: (n["step_ticks"], n["pitch"], n["length_ticks"]))
    return cleaned


def _velocity(value):
    """ノートの強さを 1〜127 の整数にする。数でなければ None（強さを持たないノート）。

    強さは、これまで見ていなかった項目なので、形がおかしくても断らない（持たないノートとして扱う）。
    """
    from math import floor, isfinite

    if isinstance(value, bool) or not isinstance(value, (int, float)) or not isfinite(value):
        return None
    return max(1, min(127, floor(value + 0.5)))


def _public(note):
    """応答に載せる形にする（内部用の ``pitch`` と、強さを外す）。"""
    if note is None:
        return None
    return {"note": note["note"], "octave": note["octave"], "step": note["step"], "length": note["length"]}


def _pair(reference, attempt, used_ref, used_att, tolerance, accept):
    """条件に合うお手本と打ち込みの組を、近い順に作る。

    位置が ``tolerance`` 以内のものだけを候補にする。両方とも位置順に並んでいるので、
    二分探索で範囲を絞る（全部の組み合わせを見ると、件数の積に比例して遅くなる）。
    位置は刻みの数（``step_ticks``。整数）で比べるので、小数の位置でも、境目で丸めの誤差が出ない。

    Args:
        reference: お手本のノート列（位置順）。
        attempt: 打ち込みのノート列（位置順）。
        used_ref: すでに組になったお手本の添字の集合（更新される）。
        used_att: すでに組になった打ち込みの添字の集合（更新される）。
        tolerance: 候補にする位置のずれの上限（刻みの数。1/60 ステップ単位）。
        accept: ``(お手本, 打ち込み)`` を受け取り、組にしてよければ近さ（小さいほど近い）を、
            だめなら None を返す関数。

    Returns:
        list[tuple[int, int]]: 組になった ``(お手本の添字, 打ち込みの添字)`` のリスト。
    """
    from bisect import bisect_left, bisect_right

    steps = [a["step_ticks"] for a in attempt]
    candidates = []
    for i, ref in enumerate(reference):
        if i in used_ref:
            continue
        lo = bisect_left(steps, ref["step_ticks"] - tolerance)
        hi = bisect_right(steps, ref["step_ticks"] + tolerance)
        for j in range(lo, hi):
            if j in used_att:
                continue
            cost = accept(ref, attempt[j])
            if cost is not None:
                candidates.append((cost, i, j))
    candidates.sort()
    pairs = []
    for _, i, j in candidates:
        if i in used_ref or j in used_att:
            continue
        used_ref.add(i)
        used_att.add(j)
        pairs.append((i, j))
    return pairs


def diff_notes(reference, attempt, steps_per_bar=16, steps_per_beat=4, timing_tolerance=None, reference_source=None,
               mode=None):
    """お手本と打ち込みを突き合わせ、差分を返す。

    突き合わせは 3 段階。先の段階で組になったノートは、後の段階では使わない。

    1. 同じ高さで、位置のずれが ``timing_tolerance`` ステップ以内 → 同じ音とみなす。
       位置が ``MIN_TIMING_ISSUE_STEPS``（0.5 ステップ）以上ずれていれば ``timing``、長さが
       ``MIN_LENGTH_ISSUE_STEPS``（0.5 ステップ）以上違えば ``length`` の指摘になる。それより小さい差
       （16 分と三連の隣どうしの 1/3 ステップなど）は、合っているものとして扱う。整数どうしの差は
       0 か 1 以上なので、整数だけの入力では「少しでも違えば指摘」のまま
    2. 位置が近く、高さがちょうどオクターブ単位で違う → ``octave``（オクターブ違い）
    3. 位置が近く、高さが 2 半音以内で違う → ``pitch``（音の間違い）

    どれとも組にならなかったお手本は ``missing``（抜け）、打ち込みは ``extra``（余分）。

    ドラムの比べ方（``mode="drums"``）は、リズムだけを比べる。ドラムのノートの高さは音の高さではなく
    種類（キック・スネアなど。画面が種類ごとに決まった高さへ置く）なので、1. だけを行う: 同じ高さ
    （= 同じ種類）どうしを組にし、位置がずれていれば ``timing``。**長さは比べない**（打音に長さは無い）。
    2. と 3. は行わないので、種類を間違えた打音は、お手本の ``missing`` と打ち込みの ``extra`` として出る
    （``pitch`` ``octave`` ``length`` は、いつも 0 件）。一致率・``bar_stats``・結果の形は、ふつうの比べ方と同じ。

    Args:
        reference: お手本のノート列（原曲を採譜したもの）。
        attempt: 利用者の打ち込みのノート列。
        steps_per_bar: 1 小節のステップ数（4/4 なら 16）。
        steps_per_beat: 1 拍のステップ数（16 分音符単位なら 4）。
        timing_tolerance: 「同じ位置」とみなす、位置のずれの上限（ステップ）。None なら、比べ方で決まる
            （``TIMING_TOLERANCE``。ふつうは 2、ドラムは 1）。
        reference_source: お手本の出どころ。``"midi"``（MIDI ファイルから読み込んだ）のときだけ、
            強さを比べる。``"transcription"``（採譜）や None（分からない）、そのほかの値では比べない。
        mode: 比べ方。``"drums"`` でドラムの比べ方。None と ``"notes"`` は、ふつうの比べ方。

    Returns:
        dict: ``{"summary", "bars", "worst_bars", "velocity", "bar_stats"}``。

        - ``summary``: 件数。``reference_count`` ``attempt_count`` ``exact``（位置も長さも一致。指摘の下限より
          小さい差は、一致に数える）、差分の種類ごとの件数、``accuracy``（お手本のうち、高さと位置が
          合っていた割合。0〜1）
        - ``bars``: 指摘の在る小節ごとの一覧。各指摘は ``kind`` ``bar`` ``beat`` ``expected``
          ``actual`` ``offset_steps`` ``length_diff`` を持つ。``bar`` と ``beat`` は、位置が小数でも整数
          （そのノートが始まる小節と拍）。``expected`` ``actual`` の ``step`` ``length`` と、``offset_steps``
          ``length_diff`` は、1/60 ステップの倍数（整数になる値は整数）。``offset_steps`` と ``length_diff`` は
          実際の差で、指摘の下限より小さい差もそのまま載る
        - ``worst_bars``: 指摘が重い順の小節番号（最大 5 つ）
        - ``velocity``: 強さの違い（``velocity_diff`` の結果）。強さを比べないお手本では None。
          ``summary`` ``bars`` ``worst_bars`` は、強さを比べても比べなくても同じ
        - ``bar_stats``: 小節ごとの一致（``_bar_stats`` の結果）。お手本のノートが在る小節だけを、小節順に持つ。
          各要素は ``bar`` ``reference_count``（その小節で始まるお手本のノートの数）``matched``（そのうち、
          高さと位置が合っていた数。``summary.accuracy`` と同じ数え方）。全部足すと、``reference_count`` は
          ``summary.reference_count``、``matched`` は一致率の分子（``accuracy × reference_count``）になる

    Raises:
        DiffError: 入力の形が正しくない、または比べるお手本が空の場合。
    """
    for name, value in (("steps_per_bar", steps_per_bar), ("steps_per_beat", steps_per_beat)):
        if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
            raise DiffError(f"{name} が正しくありません")
    if mode is None:
        mode = MODE_NOTES
    if not isinstance(mode, str) or mode not in TIMING_TOLERANCE:
        raise DiffError("mode が正しくありません")
    drums = mode == MODE_DRUMS
    if timing_tolerance is None:
        timing_tolerance = TIMING_TOLERANCE[mode]
    if not isinstance(timing_tolerance, int) or isinstance(timing_tolerance, bool) or timing_tolerance < 0:
        raise DiffError("timing_tolerance が正しくありません")
    ref = _clean(reference, "お手本")
    att = _clean(attempt, "打ち込み")
    if not ref:
        raise DiffError("お手本のノートがありません")

    used_ref, used_att = set(), set()
    issues = []
    exact = 0
    # 位置と長さは、刻みの数（1/60 ステップ単位の整数）で比べる
    tolerance = timing_tolerance * note_steps.STEP_DIVISIONS
    min_timing = MIN_TIMING_ISSUE_STEPS * note_steps.STEP_DIVISIONS
    min_length = MIN_LENGTH_ISSUE_STEPS * note_steps.STEP_DIVISIONS

    def distance(r, a):
        return abs(r["step_ticks"] - a["step_ticks"])

    # 1. 同じ高さ
    same = _pair(ref, att, used_ref, used_att, tolerance,
                 lambda r, a: distance(r, a) if r["pitch"] == a["pitch"] else None)
    for i, j in same:
        r, a = ref[i], att[j]
        # ドラムは長さを比べない（位置が同じなら、ぴったり）
        moved = abs(a["step_ticks"] - r["step_ticks"]) >= min_timing
        resized = not drums and abs(a["length_ticks"] - r["length_ticks"]) >= min_length
        if not moved and not resized:
            exact += 1
            continue
        if moved:
            issues.append(_issue("timing", r, a, steps_per_bar, steps_per_beat))
        if resized:
            issues.append(_issue("length", r, a, steps_per_bar, steps_per_beat))

    # ドラムは、ここまで。高さは種類なので、「近い高さ」「オクターブ違い」に意味が無い
    # （種類を間違えた打音は、下で抜けと余分になる）
    if not drums:
        # 2. オクターブ違い
        for i, j in _pair(ref, att, used_ref, used_att, tolerance,
                          lambda r, a: distance(r, a) if (r["pitch"] - a["pitch"]) % 12 == 0 else None):
            issues.append(_issue("octave", ref[i], att[j], steps_per_bar, steps_per_beat))

        # 3. 近い高さの間違い
        for i, j in _pair(ref, att, used_ref, used_att, tolerance,
                          lambda r, a: (abs(r["pitch"] - a["pitch"]), distance(r, a))
                          if 0 < abs(r["pitch"] - a["pitch"]) <= 2 else None):
            issues.append(_issue("pitch", ref[i], att[j], steps_per_bar, steps_per_beat))

    for i, r in enumerate(ref):
        if i not in used_ref:
            issues.append(_issue("missing", r, None, steps_per_bar, steps_per_beat))
    for j, a in enumerate(att):
        if j not in used_att:
            issues.append(_issue("extra", None, a, steps_per_bar, steps_per_beat))

    counts = {kind: sum(1 for issue in issues if issue["kind"] == kind) for kind in KINDS}
    by_bar = {}
    for issue in sorted(issues, key=lambda x: (x["bar"], x["step"], KINDS.index(x["kind"]))):
        by_bar.setdefault(issue["bar"], []).append(issue)

    # 重さ: 抜け・音の間違いを重く、位置や長さのずれを軽く数える
    weight = {"missing": 3, "pitch": 3, "octave": 2, "extra": 2, "timing": 1, "length": 1}
    worst = sorted(by_bar, key=lambda bar: (-sum(weight[x["kind"]] for x in by_bar[bar]), bar))[:5]

    return {
        "summary": {
            "reference_count": len(ref),
            "attempt_count": len(att),
            "exact": exact,
            **counts,
            # 高さと位置（許容内）が合っていた割合。長さの違いと位置の小さなずれは、合っている側に数える
            "accuracy": round(len(same) / len(ref), 4),
        },
        "bars": [{"bar": bar, "issues": [_strip(issue) for issue in by_bar[bar]]} for bar in sorted(by_bar)],
        "worst_bars": worst,
        # 強さを比べるのは、位置と高さが合った組（一致率に数えた組）だけ
        "velocity": (velocity_diff([(ref[i], att[j]) for i, j in same], steps_per_bar, steps_per_beat)
                     if reference_source in VELOCITY_SOURCES else None),
        "bar_stats": _bar_stats(ref, {i for i, _ in same}, steps_per_bar),
    }


def _bar_of(step, steps_per_bar):
    """ステップが何小節目か（1 始まり）。ステップが小数でも、小節は整数で返す。"""
    return int(step // steps_per_bar) + 1


def _bar_stats(ref, matched, steps_per_bar):
    """小節ごとに、お手本のノートの数と、合っていた数を数える。

    小節は、お手本のノートが始まる位置で決める（指摘の ``bar`` と同じ）。「合っていた」は一致率と同じで、
    同じ高さの打ち込みと、位置のずれが許容以内で組になったお手本（長さの違いと許容内のずれも、合っている側）。

    Args:
        ref: お手本のノート列（``_clean`` の形）。
        matched: 同じ高さで組になったお手本の添字の集合。
        steps_per_bar: 1 小節のステップ数。

    Returns:
        list[dict]: ``{"bar", "reference_count", "matched"}`` のリスト（小節順。お手本のノートが在る小節だけ）。
    """
    stats = {}
    for i, note in enumerate(ref):
        entry = stats.setdefault(_bar_of(note["step"], steps_per_bar), [0, 0])
        entry[0] += 1
        if i in matched:
            entry[1] += 1
    return [{"bar": bar, "reference_count": count, "matched": hit} for bar, (count, hit) in sorted(stats.items())]


def _bar_beat(step_ticks, steps_per_bar, steps_per_beat):
    """刻みの数で表した位置が、何小節目の何拍目か（どちらも 1 始まりの整数）。

    位置が小数でも、小節と拍は整数（そのノートが始まる小節と拍。拍の途中で始まるノートは、その拍に数える）。
    """
    bar_ticks = steps_per_bar * note_steps.STEP_DIVISIONS
    beat_ticks = steps_per_beat * note_steps.STEP_DIVISIONS
    return step_ticks // bar_ticks + 1, (step_ticks % bar_ticks) // beat_ticks + 1


def _issue(kind, ref, att, steps_per_bar, steps_per_beat):
    """指摘 1 件を組み立てる。位置は、お手本が在ればお手本の位置、無ければ打ち込みの位置。

    ``step`` は並べ替え用（刻みの数）。応答には載せない（``_strip``）。
    """
    anchor = ref if ref is not None else att
    bar, beat = _bar_beat(anchor["step_ticks"], steps_per_bar, steps_per_beat)
    paired = ref is not None and att is not None
    return {
        "kind": kind,
        "step": anchor["step_ticks"],
        "bar": bar,
        "beat": beat,
        "expected": _public(ref),
        "actual": _public(att),
        "offset_steps": note_steps.from_ticks(att["step_ticks"] - ref["step_ticks"]) if paired else None,
        "length_diff": note_steps.from_ticks(att["length_ticks"] - ref["length_ticks"]) if paired else None,
    }


def _strip(issue):
    """応答に載せる形にする（並べ替え用の ``step`` を外す）。"""
    return {key: value for key, value in issue.items() if key != "step"}


def _number(value):
    """中央値などを、応答に載せる数にする（整数になる値は整数、そうでなければ小数 1 桁）。"""
    value = round(float(value), 1)
    return int(value) if value == int(value) else value


def _with_velocity(note):
    """応答に載せる形に、比べた強さを付ける（強さを持たないノートは ``DEFAULT_VELOCITY``）。"""
    return {**_public(note), "velocity": note["velocity"] if note["velocity"] is not None else DEFAULT_VELOCITY}


def velocity_diff(pairs, steps_per_bar=16, steps_per_beat=4):
    """位置と高さが合った組どうしで強さを比べ、まとまりで言える違いを返す。LLM は使わない。

    1 ノートごとの数値の差を並べても、初心者には読めない（マウスで置いたノートは全部 96 なので、
    強弱の付いたお手本と比べると、ほとんどのノートが「違う」になる）。そこで、差が許す幅
    （``VELOCITY_TOLERANCE``）を超えたノートを数え、次の 4 つの形にまとめる。

    - ``overall``: 全体に弱い・強い（比べたノートの ``VELOCITY_OVERALL_SHARE`` 以上が、同じ向きに違う）
    - ``flat``: 強弱が付いていない（打ち込みの強さの幅が許す幅以内で、お手本の幅は許す幅の 2 倍を超え、
      許す幅を超えたノートが 1 つは在る）
    - ``section``: その小節の範囲が弱い・強い（小節の過半数が同じ向きに違う小節の、ひと続き）。
      ``flat`` のときと、``overall`` と同じ向きのものは出さない（同じことの言い直しになる）
    - ``accent``: アクセントが付いていない（お手本で周りより強いノートが、お手本より弱い）。
      ``flat`` のとき、全体に弱いとき、どれも弱い範囲（``section``）の中に在るときは出さない

    強さを持たないノートは ``DEFAULT_VELOCITY`` として比べる（その強さで鳴るため）。

    Args:
        pairs: ``(お手本のノート, 打ち込みのノート)`` のリスト。ノートは ``_clean`` の形。
        steps_per_bar: 1 小節のステップ数。
        steps_per_beat: 1 拍のステップ数。

    Returns:
        dict: 次の項目を持つ。

        - ``tolerance`` ``default_velocity``: 許す幅と、強さを持たないノートに使った強さ
        - ``compared``: 比べた組の数。``weaker`` ``stronger``: 許す幅を超えて、打ち込みが弱い・強い組の数
        - ``attempt_unset``: 比べた打ち込みのうち、強さを持たないノートの数
        - ``median_diff``: 強さの差（打ち込み − お手本）の中央値。組が無ければ None
        - ``reference`` ``attempt``: 比べたノートの強さの ``{"min", "max", "median"}``。組が無ければ None
        - ``findings``: まとまりで言える違い。各要素は ``kind`` ``direction``（``"weaker"`` ``"stronger"``、
          ``flat`` では None）``start_bar`` ``end_bar`` ``count``（違うノートの数）``compared``（その範囲で
          比べたノートの数。``accent`` ではお手本のアクセントの数）``median_diff`` ``notes``（``notes`` の番号）
        - ``notes``: 許す幅を超えた組（位置順）。``bar`` ``beat`` ``expected`` ``actual``（どちらも強さつき）
          ``diff``（打ち込み − お手本）
    """
    from statistics import median

    entries = []
    for ref, att in pairs:
        expected, actual = _with_velocity(ref), _with_velocity(att)
        # 小節と拍は、位置が小数でも整数（指摘の ``bar`` ``beat`` と同じ数え方）
        bar, beat = _bar_beat(ref["step_ticks"], steps_per_bar, steps_per_beat)
        entries.append({
            "step": ref["step_ticks"], "pitch": ref["pitch"],
            "bar": bar,
            "beat": beat,
            "expected": expected, "actual": actual,
            "diff": actual["velocity"] - expected["velocity"],
            "unset": att["velocity"] is None,
        })
    entries.sort(key=lambda e: (e["step"], e["pitch"]))

    def direction_of(entry):
        if entry["diff"] < -VELOCITY_TOLERANCE:
            return "weaker"
        return "stronger" if entry["diff"] > VELOCITY_TOLERANCE else None

    # 許す幅を超えた組に、応答の ``notes`` の中での番号を振る
    flagged = [entry for entry in entries if direction_of(entry)]
    for index, entry in enumerate(flagged):
        entry["index"] = index
    weaker = [entry for entry in flagged if direction_of(entry) == "weaker"]
    stronger = [entry for entry in flagged if direction_of(entry) == "stronger"]

    result = {
        "tolerance": VELOCITY_TOLERANCE,
        "default_velocity": DEFAULT_VELOCITY,
        "compared": len(entries),
        "weaker": len(weaker),
        "stronger": len(stronger),
        "attempt_unset": sum(1 for entry in entries if entry["unset"]),
        "median_diff": None,
        "reference": None,
        "attempt": None,
        "findings": [],
        "notes": [{key: entry[key] for key in ("bar", "beat", "expected", "actual", "diff")} for entry in flagged],
    }
    if not entries:
        return result

    def stats(side):
        values = [entry[side]["velocity"] for entry in entries]
        return {"min": min(values), "max": max(values), "median": _number(median(values))}

    result["median_diff"] = _number(median(entry["diff"] for entry in entries))
    result["reference"], result["attempt"] = stats("expected"), stats("actual")

    def finding(kind, direction, members, compared, where=None):
        where = where or members
        return {
            "kind": kind, "direction": direction,
            "start_bar": where[0]["bar"], "end_bar": where[-1]["bar"],
            "count": len(members), "compared": compared,
            "median_diff": _number(median(entry["diff"] for entry in where)),
            "notes": [entry["index"] for entry in members],
        }

    findings = []
    enough = len(entries) >= VELOCITY_MIN_NOTES

    # 全体に弱い・強い
    overall = None
    for direction, members in (("weaker", weaker), ("stronger", stronger)):
        if enough and len(members) >= VELOCITY_OVERALL_SHARE * len(entries):
            overall = direction
            findings.append(finding("overall", direction, members, len(entries), where=entries))

    # 強弱が付いていない
    reference, attempt = result["reference"], result["attempt"]
    flat = (enough and bool(flagged) and attempt["max"] - attempt["min"] <= VELOCITY_TOLERANCE
            and reference["max"] - reference["min"] > 2 * VELOCITY_TOLERANCE)
    if flat:
        findings.append(finding("flat", None, flagged, len(entries), where=entries))

    # その小節の範囲が弱い・強い（小節の過半数が同じ向きに違う小節の、ひと続き）
    sections = []
    if not flat:
        by_bar = {}
        for entry in entries:
            by_bar.setdefault(entry["bar"], []).append(entry)

        def bar_direction(bar):
            members = by_bar[bar]
            for direction in ("weaker", "stronger"):
                if 2 * sum(1 for entry in members if direction_of(entry) == direction) > len(members):
                    return direction
            return None

        runs = []
        for bar in sorted(by_bar):
            direction = bar_direction(bar)
            if runs and runs[-1]["direction"] == direction and runs[-1]["bars"][-1] == bar - 1:
                runs[-1]["bars"].append(bar)
            else:
                runs.append({"direction": direction, "bars": [bar]})
        for run in runs:
            if run["direction"] is None or run["direction"] == overall:
                continue
            inside = [entry for bar in run["bars"] for entry in by_bar[bar]]
            members = [entry for entry in inside if direction_of(entry) == run["direction"]]
            if len(members) >= VELOCITY_MIN_NOTES:
                sections.append(finding("section", run["direction"], members, len(inside), where=inside))
        findings.extend(sections)

    # アクセントが付いていない（お手本で周りより強いノートが、お手本より弱い）
    if not flat and overall != "weaker":
        accents = [entry for entry in entries
                   if entry["expected"]["velocity"] - reference["median"] > VELOCITY_TOLERANCE]
        missed = [entry for entry in accents if direction_of(entry) == "weaker"]
        weak_bars = {bar for section in sections if section["direction"] == "weaker"
                     for bar in range(section["start_bar"], section["end_bar"] + 1)}
        if (len(missed) >= VELOCITY_MIN_ACCENTS and 2 * len(missed) >= len(accents)
                and any(entry["bar"] not in weak_bars for entry in missed)):
            findings.append(finding("accent", "weaker", missed, len(accents)))

    result["findings"] = findings
    return result
