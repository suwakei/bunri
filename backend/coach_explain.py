"""差分コーチの言語化（第3層）— 差分の事実を「どんな傾向で、なぜ起きたと考えられ、まず何を直すか」にする

原則: **DSP が事実を出し、LLM は言語化だけをする。LLM は音符を 1 つも出力しない。**

- 事実を出すのは ``coach_diff``（お手本と打ち込みの突き合わせ）と、ここの ``build_facts``
  （件数の偏り、小節ごとの件数、カルテが在ればキーとその場のコード）。どれも機械的に決まる計算で、
  LLM にはさせない（半音の差、コードの何度の音か、キーの音階に在るか、まで計算して渡す）
- LLM に渡すのは、その事実だけ。音声もファイル名も渡さない。差分は、利用者が送ってきた値を信じず、
  ノートからサーバの側で計算し直す
- LLM の出力は Structured Outputs で形を固定する。持てるのは説明文と、指摘の ID・小節番号だけ
- 受け取ったあと事実と突き合わせる（``validate_explanation``）:
    - 事実に無い指摘の ID・小節への参照は落とす
    - 事実に無い音（オクターブつきの音名）を書いた点は、点ごと落とす。全体の要約と「最初にやること」に
      書かれていたら、その欄を決まった文に差し替える。新しい音を提案させないための遮断
    - 参照が 1 つも残らない点も落とす。点が 1 つも残らなければ、失敗にする
    - そのほかの音名・コード名・小節番号で事実に無いものは、「未確認の語」として返す（第2層と同じ見張り）

費用を無駄にしないための仕組みは、第2層（再現ガイド）と共通（docs/reproduction-guide-design.md の「費用」）:

- 作った説明は保存し、同じ事実（= 同じノートと同じ条件）なら API を呼ばずに返す（``guide_cache``）
- 説明の呼び出しは 1 つずつ通す（連打・二重送信で 2 回課金されない）
- 使用量は第2層と同じ記録に残し、1 日の上限も同じ 1 つの枠で数える（``guide_usage``）
- 違いが無い・少ない、打ち込みが無い、お手本が少ないときは、API を呼ばずに決まった文を返す（``rule_response``）
- 渡す指摘は ``MAX_ISSUES`` 件まで。多いときは一部だけを渡し、全体は件数の集計で伝える

設計の決定と理由は docs/coach-diff-design.md の「言語化」。
"""
import hashlib
import json
import re
import time
from datetime import datetime, timezone

import coach_diff
import llm_settings
from reproduction_guide import GuideError, call_structured, confidence_label, count_input_tokens, request_chars, terms_outside

# 1 回の応答の上限。途中で切れたときの歯止めで、節約の手段ではない（第2層と同じ）
MAX_TOKENS = 16000

# 指示文・出力の形・検証・事実の渡し方の版。どれかを変えたら上げる（保存済みの説明は使われなくなる）。
# 事実の渡し方は、変えれば事実の指紋が変わるので、上げ忘れても古い保存分は使われない。
# 検証（``validate_explanation``）だけは指紋に入らないので、変えたら必ず上げる
COACH_VERSION = 1

# 思考の深さ。第2層と同じ low。第2層は実測で決めたが、こちらは本物の Claude でまだ測っていない（暫定）
EFFORT = "low"

# プロンプトキャッシュの保持時間。"5m" か "1h"、None なら区切りを打たない。
# 事実は呼び出しごとに変わるので、キャッシュされるのは指示文と出力の形だけ
CACHE_TTL = "5m"

# LLM に渡す指摘の上限。画面の一覧（40 件）と同じ。超えるぶんは、件数の集計だけで伝える
MAX_ISSUES = 40
# LLM に渡す「小節ごとの件数」の行の上限
MAX_BAR_ROWS = 60
# 説明に載せる点の上限
MAX_POINTS = 3
# お手本がこれより少ないと、傾向を言える量が無い（API を呼ばない）
MIN_REFERENCE_NOTES = 4
# 違いがこれより少ないと、一覧を読めば足りる（API を呼ばない）
MIN_ISSUES = 3

# 差分の種類の呼び名
KIND_LABEL = {
    "missing": "抜け", "pitch": "高さの違い", "octave": "オクターブ違い",
    "extra": "余分なノート", "timing": "位置のずれ", "length": "長さの違い",
}

COACH_SCHEMA = {
    "type": "object",
    "properties": {
        "summary": {
            "type": "string",
            "description": "お手本との違いに、全体としてどんな傾向が在るかを 2〜3 文で。facts に在る事実だけを使う。",
        },
        "points": {
            "type": "array",
            "description": "見直すとよい点。直す効果が大きい順に 1〜3 個。",
            "items": {
                "type": "object",
                "properties": {
                    "title": {"type": "string", "description": "この点の見出し。"},
                    "observation": {
                        "type": "string",
                        "description": "どんな傾向の違いが出ているか。facts の件数・小節・音名を引いて書く。",
                    },
                    "cause": {
                        "type": "string",
                        "description": "音楽的に、なぜそうなったと考えられるか。推測なので断定しない。",
                    },
                    "fix": {
                        "type": "string",
                        "description": "どこを、何と見比べて直すか。新しい音やフレーズは提案しない。",
                    },
                    "issue_ids": {
                        "type": "array",
                        "description": "根拠にした指摘の id（facts の issues の id 列の値）。",
                        "items": {"type": "string"},
                    },
                    "bars": {
                        "type": "array",
                        "description": "この点が当てはまる小節番号（facts の bars か issues に在る小節）。",
                        "items": {"type": "integer"},
                    },
                },
                "required": ["title", "observation", "cause", "fix", "issue_ids", "bars"],
                "additionalProperties": False,
            },
        },
        "next_step": {
            "type": "string",
            "description": "最初にやることを 1 つだけ、1 文で。小節番号つきで書く。",
        },
        "next_step_bar": {
            "anyOf": [{"type": "integer"}, {"type": "null"}],
            "description": "最初に見る小節番号（facts の bars か issues に在る小節）。",
        },
    },
    "required": ["summary", "points", "next_step", "next_step_bar"],
    "additionalProperties": False,
}

SYSTEM_PROMPT = """\
あなたは、DAW「bunri」に組み込まれた音楽制作のコーチです。利用者は、取り込んだ楽曲を教材にして、\
自分の手で再現できるようになりたい初心者です。

この会話には、お手本（原曲を自動で採譜したノート）と、利用者の打ち込みを機械的に突き合わせた結果が \
<facts> タグの中に JSON で与えられます。あなたの仕事は、その結果を読んで、お手本との違いにどんな\
傾向が在るか、音楽的になぜそうなったと考えられるか、最初にどこを見直すとよいかを、短い言葉にすることです。

なぜ言葉にするだけなのか: このアプリは「生成しないアシスタント」です。どの音が違うかは突き合わせが\
出し、あなたはそれを読み解いて伝えます。あなたが新しい音やフレーズを足すと、利用者は自分で聴いて\
直す機会を失い、それが突き合わせの結果なのかあなたの推測なのかも見分けられません。

facts の読み方:
- issues は指摘の表で、columns が列の名前、rows の 1 行が 1 件の指摘です。kind は種類で、\
missing は「抜け」（お手本に在るノートが打ち込みに無い）、extra は「余分なノート」（お手本に無いノートが打ち込みに在る）、\
pitch は「高さの違い」（近い位置に、高さが 2 半音以内で違うノートが在る）、octave は「オクターブ違い」、\
timing は「位置のずれ」（高さは合っている）、length は「長さの違い」。本文では、この日本語の呼び名を使います。
- expected はお手本の音、actual は打ち込みの音。semitones は、打ち込みがお手本より何半音高いか\
（負なら低い）。offset_steps は位置のずれ（正なら遅い）、length_diff は長さの違い（正なら長い）。\
単位はステップで、1 拍が grid.steps_per_beat 個（4 なら 16 分音符）。
- issues に載っているのは、指摘の一部のことが在ります（issues.total が全件の数）。全体の傾向は、\
summary（全体の件数）、bars（小節ごとの件数）、tendencies（種類ごとの偏り。遅れと早まりの数、\
拍の頭と裏の数など）から読みます。worst_bars は、指摘が重い順の小節です。
- key と sections、issues の chord・expected_role・actual_role は、楽曲カルテ（別の解析）から来た\
情報で、在るときだけ付きます。role は、その音がその場のコードの何の音に当たるか（ルート・3度・5度など）。\
コードの音でなければ「コード外」で、キーの音階に在るかどうか（キー内・キー外）が続きます。
- 確信度は「確実」「たぶん」「自信なし」の 3 段階で与えられます。その言い方のまま書きます。

守ること:
- 事実は facts に在るものだけを使う。件数、小節番号、音名、コード名は、facts の値をそのまま引く。\
facts に無い音名・コード名・小節を挙げない。半音の数や度数を自分で数え直さない（facts の値を使う）。
- 新しい音やフレーズを提案しない。「お手本は E2、打ち込みは G2」のように facts に在る音を挙げるのは\
よいが、音を自分で選んで「ここに入れる」「代わりに弾く」と勧めない。直し方は、「お手本を重ねて表示して、\
3 小節目の 2 拍目の高さを見比べる」のように、どこを・何と見比べるかで書く。
- お手本は自動採譜の結果で、原曲どおりとは限らない。「お手本」と呼び、「正解」「答え」「正しい音」とは\
書かない。打ち込みを「間違い」と決めつけず、「お手本と違っています」と書く。お手本の音のほうが\
不自然に見えるとき（role が「キー外」など）は、採譜の誤りかもしれないと一言添える。
- cause は推測なので、「〜かもしれません」「〜と考えられます」と書き、断定しない。facts に手がかりが\
無ければ、理由を作らず「この結果からは理由を言えません」と書く。「自信なし」のキーやコードを\
根拠にするときは、そのことを添える。
- 場所は小節番号で指す。本文には「3 小節目」のように書き、issue_ids に根拠にした指摘の id を、\
bars に当てはまる小節を入れる。どの点にも、issue_ids か bars のどちらかを 1 つ以上入れる。
- 励ましやほめ言葉は書かない。事実と、次にやることだけを書く。
- 専門用語を使うときは、最初に一言で意味を添える。
- 日本語で書く。

書く量について: 利用者は、DAW の横の細いパネルでこれを読みながら手を動かします。長い説明は読まれません。
- summary は 2〜3 文。いちばん目立つ傾向を書く。件数を全部読み上げない。
- points は 1〜3 個。直す効果が大きい順に並べる（基本は、抜けと高さの違い → オクターブ違いと余分なノート → \
位置のずれと長さの違い。件数の偏りが大きければ、多いものを先にする）。原因が同じ指摘は 1 つの点に\
まとめる。指摘を 1 件ずつ読み上げない（一覧は画面に別に出ている）。
- observation・cause・fix は、それぞれ 1〜2 文。
- next_step は 1 文。最初に手を付ける場所を 1 つだけ、小節番号つきで書き、next_step_bar にその小節を入れる。
"""

# コードの構成音の呼び名（ルートからの半音 → 呼び名）
_TONE_NAME = {0: "ルート", 3: "3度", 4: "3度", 5: "4度", 6: "5度", 7: "5度", 8: "5度", 10: "7度", 11: "7度"}
# キーの音階（主音からの半音）。マイナーは自然的短音階
_SCALE = {"major": (0, 2, 4, 5, 7, 9, 11), "minor": (0, 2, 3, 5, 7, 8, 10)}
# 同じ高さの、フラットでの書き方（事実はシャープで持っている）
_FLAT_NAME = {"C#": "Db", "D#": "Eb", "F#": "Gb", "G#": "Ab", "A#": "Bb"}

_ISSUE_COLUMNS = ("id", "bar", "beat", "kind", "expected", "actual", "semitones", "offset_steps", "length_diff")


def _note_name(note):
    """ノートを「E4」の形にする（無ければ None）。"""
    return f'{note["note"]}{note["octave"]}' if note else None


def _pitch(note):
    """ノートの高さを MIDI ノート番号にする（C4 = 60）。"""
    return (note["octave"] + 1) * 12 + coach_diff.NOTE_INDEX[note["note"]]


def _anchor_step(issue):
    """指摘の位置（ステップ）。お手本が在ればお手本の位置、無ければ打ち込みの位置（``coach_diff`` と同じ）。"""
    return (issue["expected"] or issue["actual"])["step"]


def _tendencies(issues, steps_per_beat):
    """種類ごとの偏りを数える。全部の指摘が対象（LLM に渡す件数の上限とは関係なく数える）。

    「遅れがちか」「拍の裏で抜けやすいか」のような傾向は、数えれば決まる。LLM に数えさせない。
    """
    by_kind = {}
    for issue in issues:
        by_kind.setdefault(issue["kind"], []).append(issue)
    result = {}

    offsets = [issue["offset_steps"] for issue in by_kind.get("timing", [])]
    if offsets:
        result["timing"] = {
            "late": sum(1 for o in offsets if o > 0),
            "early": sum(1 for o in offsets if o < 0),
            "mean_offset_steps": round(sum(offsets) / len(offsets), 2),
        }
    lengths = [issue["length_diff"] for issue in by_kind.get("length", [])]
    if lengths:
        result["length"] = {"longer": sum(1 for d in lengths if d > 0), "shorter": sum(1 for d in lengths if d < 0)}
    for kind in ("pitch", "octave"):
        diffs = [_pitch(issue["actual"]) - _pitch(issue["expected"]) for issue in by_kind.get(kind, [])]
        if not diffs:
            continue
        result[kind] = {"higher": sum(1 for d in diffs if d > 0), "lower": sum(1 for d in diffs if d < 0)}
        if kind == "pitch":
            result[kind]["by_semitones"] = {f"{d:+d}": diffs.count(d) for d in sorted(set(diffs))}
    for kind in ("missing", "extra"):
        steps = [_anchor_step(issue) for issue in by_kind.get(kind, [])]
        if not steps:
            continue
        beats = [issue["beat"] for issue in by_kind[kind]]
        result[kind] = {
            # 拍の頭（オンビート）に在る音か、拍の途中（裏）に在る音か
            "on_beat": sum(1 for s in steps if s % steps_per_beat == 0),
            "off_beat": sum(1 for s in steps if s % steps_per_beat != 0),
            "by_beat": {str(beat): beats.count(beat) for beat in sorted(set(beats))},
        }
    return result


def _select_issues(issues, worst_bars, limit):
    """LLM に渡す指摘を選ぶ（``limit`` 件まで）。

    並びは画面の一覧と同じ（重い小節が先、あとは小節順）。そのまま上から取ると、1 種類の指摘だけで
    埋まることが在るので（ある区間を丸ごと打ち込んでいない、など）、種類ごとに枠を分けて取り、
    余った枠を上から埋める。選んだあとは、元の順に戻す。
    """
    if len(issues) <= limit:
        return list(issues)
    rank = {bar: i for i, bar in enumerate(worst_bars)}
    ordered = sorted(issues, key=lambda issue: (rank.get(issue["bar"], len(rank)), issue["index"]))
    kinds = {issue["kind"] for issue in issues}
    quota = -(-limit // len(kinds))
    taken, counts = set(), {}
    for issue in ordered:
        if len(taken) >= limit:
            break
        if counts.get(issue["kind"], 0) < quota:
            counts[issue["kind"]] = counts.get(issue["kind"], 0) + 1
            taken.add(issue["index"])
    for issue in ordered:
        if len(taken) >= limit:
            break
        taken.add(issue["index"])
    return [issue for issue in issues if issue["index"] in taken]


def _bar_rows(diff, limit):
    """小節ごとの種類別の件数の表を作る。多いときは、重い小節と件数の多い小節を残す。"""
    counts = {
        entry["bar"]: [sum(1 for issue in entry["issues"] if issue["kind"] == kind) for kind in coach_diff.KINDS]
        for entry in diff["bars"]
    }
    bars = sorted(counts)
    if len(bars) > limit:
        worst = [bar for bar in diff["worst_bars"] if bar in counts]
        rest = sorted((bar for bar in bars if bar not in worst), key=lambda bar: (-sum(counts[bar]), bar))
        bars = sorted((worst + rest)[:limit])
    return [[bar, *counts[bar]] for bar in bars]


def _bpm_value(bpm):
    """ピアノロールのテンポを確かめる（None はそのまま返す）。"""
    if bpm is None:
        return None
    if isinstance(bpm, bool) or not isinstance(bpm, (int, float)) or not 20 <= bpm <= 400:
        raise coach_diff.DiffError("bpm が正しくありません")
    return float(bpm)


def _chart_context(chart, bpm, steps_per_bar, steps_per_beat, bar_count):
    """カルテから、言語化に使う事実（キー、その場のコード、セクション）を引く準備をする。

    カルテの小節番号は使わない。カルテのグリッド（実測のビートと 1 拍目の位置）と、ピアノロールの
    グリッド（0 秒から、``bpm`` の等間隔）は別物で、同じ番号が同じ場所を指すとは限らない。
    そこで、ピアノロールのステップを秒に直し、カルテのコード・セクションの秒の範囲と突き合わせる。
    ``bpm`` が無ければ秒に直せないので、キーだけを使う。

    Returns:
        tuple: ``(level, key, scale, chord_at, sections)``。``level`` は ``"none"`` ``"key"`` ``"chords"``。
        ``chord_at`` は、ステップを受け取り、その場のコード（カルテの chords の 1 要素）か None を返す関数。
    """
    if not isinstance(chart, dict):
        return "none", None, None, None, None

    key_facts, scale = None, None
    key = chart.get("key") or {}
    if key.get("tonic") in coach_diff.NOTE_INDEX and key.get("mode") in _SCALE:
        key_facts = {"tonic": key["tonic"], "mode": key["mode"], "confidence": confidence_label(key.get("confidence"))}
        tonic = coach_diff.NOTE_INDEX[key["tonic"]]
        scale = {(tonic + interval) % 12 for interval in _SCALE[key["mode"]]}

    def timed(items):
        return sorted(
            (item for item in items or [] if isinstance(item, dict)
             and isinstance(item.get("start_sec"), (int, float)) and isinstance(item.get("end_sec"), (int, float))),
            key=lambda item: item["start_sec"])

    chords = timed(chart.get("chords")) if bpm else []
    if not chords:
        return ("key" if key_facts else "none"), key_facts, scale, None, None

    from bisect import bisect_right

    step_sec = 60.0 / bpm / steps_per_beat
    starts = [chord["start_sec"] for chord in chords]

    def chord_at(step):
        # ステップの真ん中の時刻で引く。採譜はノートの頭をステップに丸めているので、コードの変わり目に
        # 在る音が、丸めで手前のコードに入るのを避ける
        at = (step + 0.5) * step_sec
        index = bisect_right(starts, at) - 1
        if index < 0 or at >= chords[index]["end_sec"]:
            return None
        return chords[index]

    bar_sec = step_sec * steps_per_bar
    sections = []
    for section in timed(chart.get("sections")):
        name = section.get("label") or section.get("suggested_label")
        first_bar = int(round(section["start_sec"] / bar_sec)) + 1
        if not name or first_bar > bar_count:
            continue
        sections.append({
            "name": str(name),
            # 利用者が付けた名前には確信度が無い。解析が付けた名前だけ、3 段階の言い方を添える
            "name_confidence": None if section.get("label") else confidence_label(section.get("suggested_confidence")),
            "first_bar": first_bar,
            "last_bar": max(first_bar, int(round(section["end_sec"] / bar_sec))),
        })
    return "chords", key_facts, scale, chord_at, sections


def _role(note, chord, scale):
    """その音が、その場のコードの何の音に当たるか、キーの音階に在るかを言葉にする（分からなければ None）。"""
    if note is None:
        return None
    pitch_class = coach_diff.NOTE_INDEX[note["note"]]
    in_key = None if scale is None else pitch_class in scale
    if chord is not None:
        from music_theory import CHORD_TEMPLATES

        intervals = CHORD_TEMPLATES.get(chord.get("quality"))
        if intervals and chord.get("root") in coach_diff.NOTE_INDEX:
            interval = (pitch_class - coach_diff.NOTE_INDEX[chord["root"]]) % 12
            if interval in intervals:
                return _TONE_NAME.get(interval, "コードの音")
            if in_key is None:
                return "コード外"
            return "コード外・キー内" if in_key else "コード外・キー外"
    if in_key is None:
        return None
    return "キー内" if in_key else "キー外"


def build_facts(reference, attempt, steps_per_bar=16, steps_per_beat=4, timing_tolerance=2, chart=None, bpm=None):
    """お手本と打ち込みを突き合わせ、LLM に渡す事実を組み立てる。LLM は使わない。

    差分そのものは ``coach_diff.diff_notes`` が出す。ここでは、それに次を足す。

    - 指摘の ID。``coach_diff.diff_notes`` の ``bars[].issues[]`` を上から数えた番号で、``"i1"`` ``"i2"`` …
      （``POST /api/coach/diff`` の結果を同じ順に数えれば、画面の側でも同じ ID になる）
    - 種類ごとの偏り（``tendencies``）と、小節ごとの件数（``bars``）。全部の指摘から数える
    - 指摘の表（``issues``）。``MAX_ISSUES`` 件まで。多いときは一部だけで、``total`` が全件の数
    - カルテが在れば、キー、セクション、その場のコードと、音がコードの何の音に当たるか

    同じ入力からは、いつも同じ事実になる（保存した説明の鍵に使う）。

    Args:
        reference: お手本のノート列。
        attempt: 利用者の打ち込みのノート列。
        steps_per_bar: 1 小節のステップ数。
        steps_per_beat: 1 拍のステップ数。
        timing_tolerance: 「同じ位置」とみなすずれの上限（ステップ）。
        chart: 楽曲カルテ。お手本と同じ曲のものを渡す。None なら使わない。
        bpm: ピアノロールのテンポ（お手本を採譜したときのテンポ）。カルテのコード・セクションを
            ピアノロールの小節に当てるのに使う。None なら、カルテからはキーだけを使う。

    Returns:
        dict: ``{"grid", "summary", "worst_bars", "tendencies", "bars", "issues", "chart_context",
        "key", "sections"}``。

    Raises:
        coach_diff.DiffError: 入力の形が正しくない、お手本が空、``bpm`` が不正な場合。
    """
    bpm = _bpm_value(bpm)
    diff = coach_diff.diff_notes(reference, attempt, steps_per_bar=steps_per_bar, steps_per_beat=steps_per_beat,
                                 timing_tolerance=timing_tolerance)

    issues = []
    for entry in diff["bars"]:
        for issue in entry["issues"]:
            issues.append({**issue, "index": len(issues) + 1})
    bar_count = max(note["step"] for note in [*reference, *attempt]) // steps_per_bar + 1

    level, key, scale, chord_at, sections = _chart_context(chart, bpm, steps_per_bar, steps_per_beat, bar_count)
    columns = list(_ISSUE_COLUMNS)
    if level == "chords":
        columns += ["chord", "chord_confidence"]
    if level != "none":
        columns += ["expected_role", "actual_role"]

    rows = []
    for issue in _select_issues(issues, diff["worst_bars"], MAX_ISSUES):
        expected, actual = issue["expected"], issue["actual"]
        semitones = _pitch(actual) - _pitch(expected) if issue["kind"] in ("pitch", "octave") else None
        row = [f'i{issue["index"]}', issue["bar"], issue["beat"], issue["kind"], _note_name(expected),
               _note_name(actual), semitones, issue["offset_steps"], issue["length_diff"]]
        chord = chord_at(_anchor_step(issue)) if chord_at else None
        if level == "chords":
            row += [chord.get("symbol") if chord else None,
                    confidence_label(chord.get("confidence")) if chord else None]
        if level != "none":
            row += [_role(expected, chord, scale), _role(actual, chord, scale)]
        rows.append(row)

    summary = {key_: value for key_, value in diff["summary"].items() if key_ != "accuracy"}
    # 割合は、画面と同じ「何 %」に直して渡す（LLM に丸めさせない）
    summary["accuracy_percent"] = round(diff["summary"]["accuracy"] * 100)
    return {
        "grid": {"steps_per_bar": steps_per_bar, "steps_per_beat": steps_per_beat,
                 "timing_tolerance": timing_tolerance, "bar_count": bar_count},
        "summary": summary,
        "worst_bars": list(diff["worst_bars"]),
        "tendencies": _tendencies(issues, steps_per_beat),
        "bars": {"columns": ["bar", *coach_diff.KINDS], "rows": _bar_rows(diff, MAX_BAR_ROWS),
                 "total": len(diff["bars"])},
        "issues": {"columns": columns, "rows": rows, "total": len(issues)},
        "chart_context": level,
        "key": key,
        "sections": sections,
    }


def prompt_facts(facts):
    """事実を、LLM に渡す JSON 文字列にする。同じ事実からは、常に同じバイト列を返す。"""
    return json.dumps(facts, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def facts_hash(facts):
    """事実の指紋（JSON の SHA-256）を返す。事実の中身が同じなら同じ値になる。"""
    return hashlib.sha256(prompt_facts(facts).encode("utf-8")).hexdigest()


def build_request(facts, *, model=None, effort=None):
    """Claude に送るリクエストの引数を組み立てる。

    並びは「変わらないもの → 変わるもの」。指示文を system に置いて、その後ろにキャッシュの区切りを打つ。
    事実は呼び出しごとに変わるので、区切りより後ろの user に置く（直して比べ直す、を続けて行うと、
    指示文と出力の形のぶんがキャッシュから読まれる）。

    Args:
        facts: ``build_facts`` の結果。
        model: モデルの ID。None なら ``llm_settings.model()``（第2層と同じ）。
        effort: 思考の深さ。None なら ``EFFORT``。

    Returns:
        dict: ``client.beta.messages.create`` に渡すキーワード引数。
    """
    model = model or llm_settings.model()
    system = {"type": "text", "text": SYSTEM_PROMPT}
    if CACHE_TTL == "1h":
        system["cache_control"] = {"type": "ephemeral", "ttl": "1h"}
    elif CACHE_TTL:
        system["cache_control"] = {"type": "ephemeral"}

    body = {
        "model": model,
        "max_tokens": MAX_TOKENS,
        "system": [system],
        "messages": [{
            "role": "user",
            "content": "<facts>\n" + prompt_facts(facts) + "\n</facts>\n\nこの結果について、説明を作ってください。",
        }],
        "output_config": {
            "effort": effort or EFFORT,
            "format": {"type": "json_schema", "schema": COACH_SCHEMA},
        },
    }
    if not model.startswith("claude-haiku"):
        # 安全性の分類器が応答を断ったとき、サーバ側で別のモデルに回す（第2層と同じ。Haiku には無い）
        body["betas"] = ["server-side-fallback-2026-07-01"]
        body["fallbacks"] = "default"
    return body


def request_fingerprint():
    """指示文・出力の形・版の指紋を返す。保存した説明の鍵に入れる。"""
    payload = json.dumps([COACH_VERSION, SYSTEM_PROMPT, COACH_SCHEMA], ensure_ascii=False, sort_keys=True)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]


def explanation_key(facts, model, effort):
    """保存した説明の鍵を返す（事実の指紋 + モデル + 思考の深さ + 指示文と出力の形の指紋）。"""
    parts = [facts_hash(facts), model, effort, request_fingerprint()]
    return hashlib.sha256("\n".join(parts).encode("utf-8")).hexdigest()[:40]


def _plain_summary(facts):
    """件数から、決まった型の要約文を作る（LLM ではない）。"""
    summary = facts["summary"]
    counts = "、".join(f"{KIND_LABEL[kind]} {summary[kind]}" for kind in coach_diff.KINDS if summary[kind])
    text = (f"お手本 {summary['reference_count']} ノートのうち、{summary['accuracy_percent']}% が"
            "高さと位置の合っているノートです。")
    return text + (f"お手本との違いは {facts['issues']['total']} か所です（{counts}）。" if counts else "")


def _explanation(summary, next_step, next_step_bar=None, points=()):
    """説明の形にそろえる（検証の結果も、LLM を使わない説明も、同じ形で返す）。"""
    return {
        "summary": summary, "points": list(points), "next_step": next_step, "next_step_bar": next_step_bar,
        "dropped_refs": 0, "dropped_points": 0, "unverified_terms": [], "replaced": [],
    }


def rule_response(facts):
    """LLM に頼むまでもないときの、決まった文の説明を返す（頼むべきときは None）。

    違いが無い、打ち込みが無い、お手本が少ない、違いがごく少ない、のどれか。傾向と言えるものが無く、
    Claude を呼んでも一覧を言い直すだけになる。判断は機械的に決まるので、LLM にさせない。

    Returns:
        tuple[str, dict] | None: ``(理由, 説明)``。理由は ``"no_diff"`` ``"no_attempt"``
        ``"few_notes"`` ``"few_issues"``。
    """
    summary, total = facts["summary"], facts["issues"]["total"]
    first_bar = facts["worst_bars"][0] if facts["worst_bars"] else None
    if total == 0:
        return "no_diff", _explanation(
            f"お手本 {summary['reference_count']} ノートと、高さ・位置・長さがすべて合っています。",
            "お手本と違う箇所はありません。お手本は自動採譜の結果なので、原曲と聴き比べて、"
            "お手本そのものが曲と合っているかを確かめてください。")
    if summary["attempt_count"] == 0:
        return "no_attempt", _explanation(
            f"打ち込みがまだありません（お手本は {summary['reference_count']} ノート）。",
            "ピアノロールでお手本を重ねて表示し、お手本のノートが在る最初の小節から打ち込んでください。",
            facts["bars"]["rows"][0][0] if facts["bars"]["rows"] else None)
    if summary["reference_count"] < MIN_REFERENCE_NOTES:
        return "few_notes", _explanation(
            f"お手本が {summary['reference_count']} ノートだけなので、傾向を言える量がありません。" + _plain_summary(facts),
            "指摘の一覧を 1 件ずつ開いて、お手本と見比べてください。", first_bar)
    if total < MIN_ISSUES:
        return "few_issues", _explanation(
            _plain_summary(facts),
            f"違いは {total} か所だけです。指摘の一覧から {first_bar} 小節目を開いて、お手本と見比べてください。",
            first_bar)
    return None


# オクターブつきの音名（E2、F#3、Bb-1）。コード名の G7 や C6 も同じ形になるので、
# 事実に在るコード名と一致するものは、呼び出し側で除く
_OCTAVE_NOTE_RE = re.compile(r"(?<![A-Za-z0-9#♯♭])([A-G])(#|b|♯|♭)?(-1|[0-9])(?![A-Za-z0-9#♯♭])")
# 本文の小節番号（「3 小節目」「9〜12 小節」「1、3 小節目」）。長さの言い方（「2 小節ぶん」）は拾わない
_BAR_TEXT_RE = re.compile(r"(\d+(?:\s*[、,・〜~\-–]\s*\d+)*)\s*小節(?!ぶん|分|ごと|単位|間)")


def _vocabulary(facts):
    """事実に在る音・コード・小節を、検証用に取り出す。

    Returns:
        dict: ``issues``（ID → ``{"bar", "beat", "kind"}``）、``bars``（指摘の在る小節）、
        ``pitches``（事実に在る音の高さ。MIDI ノート番号）、``chords``（事実に在るコード名）、
        ``words``（説明文に出てきてよい音名・コード名）。
    """
    columns = facts["issues"]["columns"]
    at = {name: columns.index(name) for name in columns}
    issues, pitches, chords, words = {}, set(), set(), set()
    for row in facts["issues"]["rows"]:
        issues[row[at["id"]]] = {"bar": row[at["bar"]], "beat": row[at["beat"]], "kind": row[at["kind"]]}
        for name in (row[at["expected"]], row[at["actual"]]):
            if not name:
                continue
            match = _OCTAVE_NOTE_RE.fullmatch(name)
            letter, octave = match.group(1) + (match.group(2) or ""), match.group(3)
            pitches.add((int(octave) + 1) * 12 + coach_diff.NOTE_INDEX[letter])
            words.update({name, letter})
            if letter in _FLAT_NAME:
                words.update({_FLAT_NAME[letter] + octave, _FLAT_NAME[letter]})
        symbol = row[at["chord"]] if "chord" in at else None
        if symbol:
            chords.add(symbol)
            words.add(symbol)
            words.update(part for part in symbol.split("/") if part)
            root = re.match(r"[A-G][#b]?", symbol)
            if root:
                words.add(root.group(0))
    if facts.get("key"):
        tonic = facts["key"]["tonic"]
        words.update({tonic, _FLAT_NAME.get(tonic, tonic)})
    bars = {row[0] for row in facts["bars"]["rows"]} | {issue["bar"] for issue in issues.values()}
    return {"issues": issues, "bars": bars, "pitches": pitches, "chords": chords, "words": words}


def invented_notes(text, vocabulary):
    """説明文に出てきたオクターブつきの音名のうち、事実に無いものを返す。

    「E2」のような書き方は、ほかの意味に読める場面がほとんど無いので、事実に無ければ LLM が音を
    足したとみなす。高さで比べるので、同じ音の別の書き方（C#4 と Db4）は同じに扱う。
    事実に在るコード名（G7 など）は、音名ではないので除く。

    Args:
        text: 説明文。
        vocabulary: ``_vocabulary`` の結果。

    Returns:
        list[str]: 事実に無い音名（出てきた順、重複なし）。
    """
    found = []
    for match in _OCTAVE_NOTE_RE.finditer(text or ""):
        term = match.group(0).replace("♯", "#").replace("♭", "b")
        if term in vocabulary["chords"] or term in found:
            continue
        accidental = {"#": 1, "b": -1}.get(term[1:2], 0)
        pitch = (int(match.group(3)) + 1) * 12 + coach_diff.NOTE_INDEX[match.group(1)] + accidental
        if pitch not in vocabulary["pitches"]:
            found.append(term)
    return found


def _unknown_bars(text, bar_count):
    """説明文に出てきた小節番号のうち、曲の範囲（1〜``bar_count``）に無いものを返す。"""
    found = []
    for match in _BAR_TEXT_RE.finditer(text or ""):
        for number in re.findall(r"\d+", match.group(1)):
            label = f"{int(number)} 小節"
            if not 1 <= int(number) <= bar_count and label not in found:
                found.append(label)
    return found


def validate_explanation(raw, facts):
    """LLM の出力を事実と突き合わせ、事実に無いものを落とす。

    Structured Outputs で形は保証されているが、中身（その指摘・その小節・その音が実在するか）までは
    保証されない。ここで、実在するものだけに絞る。

    - 参照（``issue_ids`` ``bars`` ``next_step_bar``）: 事実に無いものは落とす
    - 点: 事実に無い音（オクターブつきの音名）を書いたもの、参照が 1 つも残らないもの、
      ``MAX_POINTS`` 個を超えたぶんは、点ごと落とす
    - ``summary`` ``next_step``: 事実に無い音を書いていたら、決まった文に差し替える
    - そのほかの音名・コード名・小節番号で事実に無いものは、``unverified_terms`` に入れて返す
      （誤検出がありうるので、捨てずに画面が示す。第2層と同じ）

    Args:
        raw: LLM が返した辞書（``COACH_SCHEMA`` の形）。
        facts: ``build_facts`` の結果。

    Returns:
        dict: ``{"summary", "points", "next_step", "next_step_bar", "dropped_refs", "dropped_points",
        "unverified_terms", "replaced"}``。``points[].refs`` は ``{"issue_id", "bar", "beat", "kind"}``
        （指摘を指すものが先、あとに小節だけを指すもの）。``replaced`` は差し替えた欄の名前。

    Raises:
        GuideError: 出力の形が想定と違う、または点が 1 つも残らなかった場合（``code="invalid"``）。
    """
    if not isinstance(raw, dict) or not isinstance(raw.get("points"), list):
        raise GuideError("説明の形式が正しくありません", code="invalid")

    vocabulary = _vocabulary(facts)
    order = {issue_id: i for i, issue_id in enumerate(vocabulary["issues"])}
    dropped_refs = dropped_points = 0
    points = []
    for point in raw["points"]:
        if not isinstance(point, dict):
            raise GuideError("説明の形式が正しくありません", code="invalid")
        texts = {name: str(point.get(name) or "") for name in ("title", "observation", "cause", "fix")}
        ids, bars = [], []
        for issue_id in point.get("issue_ids") or []:
            if issue_id in vocabulary["issues"]:
                if issue_id not in ids:
                    ids.append(issue_id)
            else:
                dropped_refs += 1
        for bar in point.get("bars") or []:
            if isinstance(bar, int) and not isinstance(bar, bool) and bar in vocabulary["bars"]:
                if bar not in bars:
                    bars.append(bar)
            else:
                dropped_refs += 1
        if invented_notes("\n".join(texts.values()), vocabulary) or not (ids or bars) or len(points) >= MAX_POINTS:
            dropped_points += 1
            continue
        refs = [{"issue_id": issue_id, **vocabulary["issues"][issue_id]} for issue_id in sorted(ids, key=order.get)]
        covered = {ref["bar"] for ref in refs}
        refs += [{"issue_id": None, "bar": bar, "beat": None, "kind": None} for bar in sorted(bars) if bar not in covered]
        points.append({**texts, "refs": refs})
    if not points:
        raise GuideError("説明の内容を、差分の結果と結び付けられませんでした。もう一度試してください", code="invalid")

    replaced = []
    summary = str(raw.get("summary") or "")
    if not summary or invented_notes(summary, vocabulary):
        summary = _plain_summary(facts)
        replaced.append("summary")

    next_bar = raw.get("next_step_bar")
    if next_bar is not None and not (isinstance(next_bar, int) and not isinstance(next_bar, bool)
                                     and next_bar in vocabulary["bars"]):
        dropped_refs += 1
        next_bar = None
    next_step = str(raw.get("next_step") or "")
    if not next_step or invented_notes(next_step, vocabulary):
        next_bar = points[0]["refs"][0]["bar"]
        next_step = f"まず {next_bar} 小節目を開いて、お手本と見比べてください。"
        replaced.append("next_step")

    text = "\n".join([summary, next_step] + ["\n".join(point[name] for name in ("title", "observation", "cause", "fix"))
                                             for point in points])
    return {
        "summary": summary,
        "points": points,
        "next_step": next_step,
        "next_step_bar": next_bar,
        "dropped_refs": dropped_refs,
        "dropped_points": dropped_points,
        "unverified_terms": terms_outside(text, vocabulary["words"]) + _unknown_bars(text, facts["grid"]["bar_count"]),
        "replaced": replaced,
    }


def generate(facts, client=None, request=None):
    """事実から説明を作る（Claude を 1 回呼ぶ）。

    保存分の再利用・上限の確認・記録は行わない。それらは ``explain_for`` が受け持つ。

    Args:
        facts: ``build_facts`` の結果。
        client: Anthropic のクライアント。None なら ``llm_settings.make_client()`` で作る
            （テストでは差し替える）。
        request: 送るリクエスト。None なら ``build_request(facts)``。

    Returns:
        dict: ``{"explanation": 検証済みの説明, "model": 応答したモデル, "usage": 使用量}``。

    Raises:
        GuideError: API キーが無い・正しくない、通信できない、モデルが応答を断った、出力が途中で切れた、
            事実と結び付けられなかった、などの場合。応答が返ってきていた失敗では、``usage`` に使用量が入る。
    """
    if request is None:
        request = build_request(facts)
    if client is None:
        client = llm_settings.make_client()
    raw, model, usage = call_structured(
        request, client, truncated_message="説明が長くなりすぎて途中で切れました。もう一度試してください")
    try:
        explanation = validate_explanation(raw, facts)
    except GuideError as e:
        raise GuideError(str(e), code=e.code, usage=usage, model=model)
    return {"explanation": explanation, "model": model, "usage": usage}


def _input_summary(facts):
    """何を材料にしたかの要約（画面が「指摘 120 件のうち 40 件を渡した」と示すのに使う）。"""
    return {"issues": facts["issues"]["total"], "issues_sent": len(facts["issues"]["rows"]),
            "chart_context": facts["chart_context"]}


def _public(entry, cached, facts):
    """保存した説明の 1 件を、API の応答に載せる形にする。"""
    return {
        "explanation": entry["explanation"],
        "source": "claude",
        "reason": None,
        "model": entry.get("model"),
        "usage": entry.get("usage") or {},
        "cost_usd": entry.get("cost_usd"),
        "duration_sec": entry.get("duration_sec"),
        "created_at": entry.get("created_at"),
        "cached": cached,
        "input": _input_summary(facts),
    }


def _public_rule(reason, explanation, facts):
    """LLM を使わない説明を、API の応答に載せる形にする（費用は 0）。"""
    return {
        "explanation": explanation,
        "source": "rule",
        "reason": reason,
        "model": None,
        "usage": {},
        "cost_usd": 0.0,
        "duration_sec": None,
        "created_at": None,
        "cached": False,
        "input": _input_summary(facts),
    }


def _blocked_message(today):
    """1 日の上限に達しているときの理由を返す（達していなければ None）。上限は第2層と同じ 1 つの枠。"""
    if not today["blocked"]:
        return None
    calls, limit_calls = today["calls"], today["limit_calls"]
    if limit_calls is not None and calls >= limit_calls:
        return (f"今日は Claude を {calls} 回呼びました（再現ガイドと差分コーチの合計）。"
                f"1 日の上限（{limit_calls} 回）に達したので、Claude を呼びません。"
                "明日になるとまた使えます。上限は設定で変えられます")
    return (f"今日の Claude の費用が概算で ${today['cost_usd']:.2f} になりました（再現ガイドと差分コーチの合計）。"
            f"1 日の上限（${today['limit_usd']:.2f}）に達したので、Claude を呼びません。"
            "明日になるとまた使えます。上限は設定で変えられます")


def saved_explanation(facts):
    """API を呼ばずに返せる説明を返す（無ければ None）。

    LLM に頼むまでもない場合の決まった文か、保存済みの説明。

    Args:
        facts: ``build_facts`` の結果。

    Returns:
        dict | None: ``explain_for`` と同じ形。
    """
    import guide_cache

    rule = rule_response(facts)
    if rule:
        return _public_rule(*rule, facts)
    request = build_request(facts)
    entry = guide_cache.load(explanation_key(facts, request["model"], request["output_config"]["effort"]), kind="coach")
    return _public(entry, cached=True, facts=facts) if entry else None


def explain_for(facts, regenerate=False, client=None):
    """差分の説明を返す。API を呼ばずに済むならそうし、要るときだけ Claude を呼ぶ。

    順番（第2層の ``guide_for`` と同じ）:

    1. LLM に頼むまでもない場合（違いが無い・少ない、打ち込みが無い、お手本が少ない）は、決まった文を返す
    2. 保存済みが在れば、API を呼ばずに返す（``regenerate`` が True なら飛ばす）
    3. 説明の呼び出しを 1 つずつ通す。待っている間に同じ条件の説明が出来ていたら、それを返す
       （錠は 1 つ。事実ごとに分けると、ノートを直すたびに錠が増えていくため）
    4. 1 日の上限に達しているとき、入力が長すぎるときは、API を呼ばずに断る
    5. Claude を呼び、使用量を記録し、説明を保存する

    Args:
        facts: ``build_facts`` の結果。
        regenerate: True なら、保存済みが在っても作り直す（費用がかかる）。
        client: Anthropic のクライアント（テストでは差し替える）。

    Returns:
        dict: ``{"explanation", "source", "reason", "model", "usage", "cost_usd", "duration_sec",
        "created_at", "cached", "input"}``。``source`` は ``"claude"`` か ``"rule"``（LLM を使わない決まった文）。

    Raises:
        GuideError: 作れなかった場合。メッセージは利用者にそのまま見せられる。
    """
    import guide_cache
    import guide_usage

    rule = rule_response(facts)
    if rule:
        return _public_rule(*rule, facts)

    request = build_request(facts)
    model, effort = request["model"], request["output_config"]["effort"]
    key = explanation_key(facts, model, effort)
    if not regenerate:
        entry = guide_cache.load(key, kind="coach")
        if entry:
            return _public(entry, cached=True, facts=facts)

    facts_id = facts_hash(facts)
    asked_at = time.time()
    with guide_cache.lock_for("coach"):
        entry = guide_cache.load(key, kind="coach")
        if entry and (not regenerate or (entry.get("created_ts") or 0) >= asked_at):
            return _public(entry, cached=True, facts=facts)

        blocked = _blocked_message(guide_usage.today())
        if blocked:
            raise GuideError(blocked, code="daily_limit")

        if client is None:
            client = llm_settings.make_client()
        # 渡す指摘の数に上限が在るので、ふつうは当たらない。設定で入力の上限を下げているときの歯止め
        max_input_tokens = guide_usage.settings()["max_input_tokens"]
        if request_chars(request) > max_input_tokens:
            tokens = count_input_tokens(request, client)
            if tokens > max_input_tokens:
                raise GuideError(
                    f"Claude に送る量が上限を超えます（約 {tokens:,} トークン。上限は {max_input_tokens:,}）。"
                    "設定で入力の上限を上げてください", code="too_long")

        log = {"feature": "coach", "requested_model": model, "effort": effort, "focus": None,
               "chart": facts_id[:16], "cache_ttl": CACHE_TTL or "none", "version": request_fingerprint()}
        started = time.monotonic()
        try:
            result = generate(facts, client=client, request=request)
        except GuideError as e:
            guide_usage.record_call(ok=False, error=e.code, model=e.model or model, usage=e.usage,
                                    duration_sec=time.monotonic() - started, **log)
            raise
        record = guide_usage.record_call(ok=True, model=result["model"], usage=result["usage"],
                                         duration_sec=time.monotonic() - started, **log)
        entry = {
            "explanation": result["explanation"],
            "model": result["model"],
            "usage": result["usage"],
            "cost_usd": record["cost_usd"],
            "duration_sec": record["duration_sec"],
            "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "created_ts": time.time(),
            "requested_model": model,
            "effort": effort,
            "facts": facts_id,
            "fingerprint": request_fingerprint(),
        }
        guide_cache.save(key, entry, kind="coach")
        return _public(entry, cached=False, facts=facts)
