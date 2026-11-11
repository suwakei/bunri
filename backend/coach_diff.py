"""差分コーチ（第3層）の土台 — お手本のノートと、利用者の打ち込みの差分を事実として出す

第3層は「利用者の打ち込みと原曲の差分を指摘する」層。ここはそのうち **事実を出す部分** で、
LLM は使わない。お手本（原曲を採譜したノート）と打ち込みを突き合わせ、どの小節のどの音が
合っていて、どこが抜けていて、どこが違うかを、機械的に決まる形で返す。

言葉にする部分（なぜずれているか、次に何を直すとよいか）は、この結果を材料にして
あとから載せる。事実と言語化を分けておくのは、第1層・第2層と同じ理由による。

ノートの形はピアノロールと同じ: ``{"note": "C", "octave": 4, "step": 0, "length": 4}``。
``step`` と ``length`` は 16 分音符単位。
"""

NOTE_INDEX = {"C": 0, "C#": 1, "D": 2, "D#": 3, "E": 4, "F": 5, "F#": 6, "G": 7, "G#": 8, "A": 9, "A#": 10, "B": 11}

# 差分の種類。重い（まず直すべき）ものから並べてある
KINDS = ("missing", "pitch", "octave", "extra", "timing", "length")

# 一度に受け付けるノートの上限（突き合わせは件数の積に比例して重くなるため）
MAX_NOTES = 20000


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
        list[dict]: ``note`` ``octave`` ``step`` ``length`` ``pitch`` を持つ辞書のリスト（位置順）。

    Raises:
        DiffError: リストでない、件数が多すぎる、ノートの形が正しくない場合。
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
        valid = (
            name in NOTE_INDEX
            and isinstance(octave, int) and not isinstance(octave, bool) and -1 <= octave <= 9
            and isinstance(step, int) and not isinstance(step, bool) and step >= 0
            and isinstance(length, int) and not isinstance(length, bool) and length > 0
        )
        if not valid:
            raise DiffError(f"{label}のノートの形式が正しくありません")
        note = {"note": name, "octave": octave, "step": step, "length": length}
        note["pitch"] = _pitch(note)
        cleaned.append(note)
    cleaned.sort(key=lambda n: (n["step"], n["pitch"], n["length"]))
    return cleaned


def _public(note):
    """応答に載せる形にする（内部用の ``pitch`` を外す）。"""
    if note is None:
        return None
    return {"note": note["note"], "octave": note["octave"], "step": note["step"], "length": note["length"]}


def _pair(reference, attempt, used_ref, used_att, tolerance, accept):
    """条件に合うお手本と打ち込みの組を、近い順に作る。

    位置が ``tolerance`` ステップ以内のものだけを候補にする。両方とも位置順に並んでいるので、
    二分探索で範囲を絞る（全部の組み合わせを見ると、件数の積に比例して遅くなる）。

    Args:
        reference: お手本のノート列（位置順）。
        attempt: 打ち込みのノート列（位置順）。
        used_ref: すでに組になったお手本の添字の集合（更新される）。
        used_att: すでに組になった打ち込みの添字の集合（更新される）。
        tolerance: 候補にする位置のずれの上限（ステップ）。
        accept: ``(お手本, 打ち込み)`` を受け取り、組にしてよければ近さ（小さいほど近い）を、
            だめなら None を返す関数。

    Returns:
        list[tuple[int, int]]: 組になった ``(お手本の添字, 打ち込みの添字)`` のリスト。
    """
    from bisect import bisect_left, bisect_right

    steps = [a["step"] for a in attempt]
    candidates = []
    for i, ref in enumerate(reference):
        if i in used_ref:
            continue
        lo = bisect_left(steps, ref["step"] - tolerance)
        hi = bisect_right(steps, ref["step"] + tolerance)
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


def diff_notes(reference, attempt, steps_per_bar=16, steps_per_beat=4, timing_tolerance=2):
    """お手本と打ち込みを突き合わせ、差分を返す。

    突き合わせは 3 段階。先の段階で組になったノートは、後の段階では使わない。

    1. 同じ高さで、位置のずれが ``timing_tolerance`` ステップ以内 → 同じ音とみなす。
       位置がずれていれば ``timing``、長さが違えば ``length`` の指摘になる
    2. 位置が近く、高さがちょうどオクターブ単位で違う → ``octave``（オクターブ違い）
    3. 位置が近く、高さが 2 半音以内で違う → ``pitch``（音の間違い）

    どれとも組にならなかったお手本は ``missing``（抜け）、打ち込みは ``extra``（余分）。

    Args:
        reference: お手本のノート列（原曲を採譜したもの）。
        attempt: 利用者の打ち込みのノート列。
        steps_per_bar: 1 小節のステップ数（4/4 なら 16）。
        steps_per_beat: 1 拍のステップ数（16 分音符単位なら 4）。
        timing_tolerance: 「同じ位置」とみなす、位置のずれの上限（ステップ）。

    Returns:
        dict: ``{"summary", "bars", "worst_bars"}``。

        - ``summary``: 件数。``reference_count`` ``attempt_count`` ``exact``（位置も長さも一致）、
          差分の種類ごとの件数、``accuracy``（お手本のうち、高さと位置が合っていた割合。0〜1）
        - ``bars``: 指摘の在る小節ごとの一覧。各指摘は ``kind`` ``bar`` ``beat`` ``expected``
          ``actual`` ``offset_steps`` ``length_diff`` を持つ
        - ``worst_bars``: 指摘が重い順の小節番号（最大 5 つ）

    Raises:
        DiffError: 入力の形が正しくない、または比べるお手本が空の場合。
    """
    for name, value in (("steps_per_bar", steps_per_bar), ("steps_per_beat", steps_per_beat)):
        if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
            raise DiffError(f"{name} が正しくありません")
    if not isinstance(timing_tolerance, int) or isinstance(timing_tolerance, bool) or timing_tolerance < 0:
        raise DiffError("timing_tolerance が正しくありません")
    ref = _clean(reference, "お手本")
    att = _clean(attempt, "打ち込み")
    if not ref:
        raise DiffError("お手本のノートがありません")

    used_ref, used_att = set(), set()
    issues = []
    exact = 0

    def distance(r, a):
        return abs(r["step"] - a["step"])

    # 1. 同じ高さ
    same = _pair(ref, att, used_ref, used_att, timing_tolerance,
                 lambda r, a: distance(r, a) if r["pitch"] == a["pitch"] else None)
    for i, j in same:
        r, a = ref[i], att[j]
        offset, length_diff = a["step"] - r["step"], a["length"] - r["length"]
        if offset == 0 and length_diff == 0:
            exact += 1
            continue
        if offset != 0:
            issues.append(_issue("timing", r, a, steps_per_bar, steps_per_beat))
        if length_diff != 0:
            issues.append(_issue("length", r, a, steps_per_bar, steps_per_beat))

    # 2. オクターブ違い
    for i, j in _pair(ref, att, used_ref, used_att, timing_tolerance,
                      lambda r, a: distance(r, a) if (r["pitch"] - a["pitch"]) % 12 == 0 else None):
        issues.append(_issue("octave", ref[i], att[j], steps_per_bar, steps_per_beat))

    # 3. 近い高さの間違い
    for i, j in _pair(ref, att, used_ref, used_att, timing_tolerance,
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
    }


def _issue(kind, ref, att, steps_per_bar, steps_per_beat):
    """指摘 1 件を組み立てる。位置は、お手本が在ればお手本の位置、無ければ打ち込みの位置。"""
    anchor = ref if ref is not None else att
    step = anchor["step"]
    return {
        "kind": kind,
        "step": step,
        "bar": step // steps_per_bar + 1,
        "beat": (step % steps_per_bar) // steps_per_beat + 1,
        "expected": _public(ref),
        "actual": _public(att),
        "offset_steps": (att["step"] - ref["step"]) if ref is not None and att is not None else None,
        "length_diff": (att["length"] - ref["length"]) if ref is not None and att is not None else None,
    }


def _strip(issue):
    """応答に載せる形にする（並べ替え用の ``step`` を外す）。"""
    return {key: value for key, value in issue.items() if key != "step"}
