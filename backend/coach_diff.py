"""差分コーチ（第3層）の土台 — お手本のノートと、利用者の打ち込みの差分を事実として出す

第3層は「利用者の打ち込みと原曲の差分を指摘する」層。ここはそのうち **事実を出す部分** で、
LLM は使わない。お手本（原曲を採譜したノート）と打ち込みを突き合わせ、どの小節のどの音が
合っていて、どこが抜けていて、どこが違うかを、機械的に決まる形で返す。

言葉にする部分（なぜずれているか、次に何を直すとよいか）は、この結果を材料にして
あとから載せる。事実と言語化を分けておくのは、第1層・第2層と同じ理由による。

ノートの形はピアノロールと同じ: ``{"note": "C", "octave": 4, "step": 0, "length": 4}``。
``step`` と ``length`` は 16 分音符単位。``velocity``（強さ。1〜127）は在っても無くてもよい。

強さ（ベロシティ）の違いは、**お手本が MIDI ファイルから読み込んだもののときだけ** 出す
（``reference_source="midi"``）。音源から採譜したお手本の強さは当てにならないので、比べない
（docs/coach-diff-design.md の「強さの違い」）。強さは、位置・高さ・長さの指摘とは別の欄
（結果の ``velocity``）に出し、指摘の一覧（``bars``）と一致率（``summary.accuracy``）には入れない。
"""

NOTE_INDEX = {"C": 0, "C#": 1, "D": 2, "D#": 3, "E": 4, "F": 5, "F#": 6, "G": 7, "G#": 8, "A": 9, "A#": 10, "B": 11}

# 差分の種類。重い（まず直すべき）ものから並べてある
KINDS = ("missing", "pitch", "octave", "extra", "timing", "length")

# 一度に受け付けるノートの上限（突き合わせは件数の積に比例して重くなるため）
MAX_NOTES = 20000

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
        note["velocity"] = _velocity(raw.get("velocity"))
        cleaned.append(note)
    cleaned.sort(key=lambda n: (n["step"], n["pitch"], n["length"]))
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


def diff_notes(reference, attempt, steps_per_bar=16, steps_per_beat=4, timing_tolerance=2, reference_source=None):
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
        reference_source: お手本の出どころ。``"midi"``（MIDI ファイルから読み込んだ）のときだけ、
            強さを比べる。``"transcription"``（採譜）や None（分からない）、そのほかの値では比べない。

    Returns:
        dict: ``{"summary", "bars", "worst_bars", "velocity"}``。

        - ``summary``: 件数。``reference_count`` ``attempt_count`` ``exact``（位置も長さも一致）、
          差分の種類ごとの件数、``accuracy``（お手本のうち、高さと位置が合っていた割合。0〜1）
        - ``bars``: 指摘の在る小節ごとの一覧。各指摘は ``kind`` ``bar`` ``beat`` ``expected``
          ``actual`` ``offset_steps`` ``length_diff`` を持つ
        - ``worst_bars``: 指摘が重い順の小節番号（最大 5 つ）
        - ``velocity``: 強さの違い（``velocity_diff`` の結果）。強さを比べないお手本では None。
          ``summary`` ``bars`` ``worst_bars`` は、強さを比べても比べなくても同じ

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
        # 強さを比べるのは、位置と高さが合った組（一致率に数えた組）だけ
        "velocity": (velocity_diff([(ref[i], att[j]) for i, j in same], steps_per_bar, steps_per_beat)
                     if reference_source in VELOCITY_SOURCES else None),
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
        entries.append({
            "step": ref["step"], "pitch": ref["pitch"],
            "bar": ref["step"] // steps_per_bar + 1,
            "beat": (ref["step"] % steps_per_bar) // steps_per_beat + 1,
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
