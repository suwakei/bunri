"""再現ガイド（第2層）— 楽曲カルテを「こう作れば再現できる」という説明にする

原則: **DSP が事実を出し、LLM は言語化だけをする。LLM は音符を 1 つも出力しない。**

- LLM に渡すのは楽曲カルテ（第1層の解析結果）だけ。音声は渡さない
- LLM の出力は Structured Outputs で形を固定する。説明文と、カルテ上の場所への参照
  （セクション ID、小節・拍）だけを持ち、音符を入れる場所が無い
- 参照は受け取ったあとカルテと突き合わせ、カルテに無い場所を指すものは落とす
- 説明文に、カルテに無い音名・コード名が出てきたら「未確認の語」として返す
  （LLM が解析結果に無いことを言っていないかを、利用者が見分けられるように）
- カルテは長くて変わらないので、プロンプトキャッシュの対象にする。1 曲のカルテに対して
  何度も問い合わせる使われ方を想定している

費用を無駄にしないための仕組み（詳しくは docs/reproduction-guide-design.md の「費用」）:

- 作ったガイドは保存し、同じ条件（カルテ・対象・モデル・思考の深さ・指示文と出力の形の版）なら
  API を呼ばずに返す（``guide_for``、``guide_cache``）
- 同じカルテへの呼び出しは 1 つずつ通す。連打や二重送信で 2 回課金されないようにする
- 呼び出しごとに使用量を記録し、1 日の上限に達していたら API を呼ばない（``guide_usage``）
- 解析できた項目がほとんど無いカルテは、API を呼ばずに断る（``material_shortage``）
- 入力が上限を超える長いカルテは、黙って切らず、対象をセクションに絞らせる（``fit_request``）
"""
import hashlib
import json
import re
import time
from contextlib import contextmanager
from datetime import datetime, timezone

import llm_settings

# 1 回の応答の上限。途中で切れたときの歯止めで、節約の手段ではない（モデルからは見えず、
# 当たると応答が途中で切れて作り直しになる）。出力を短くするのは指示文で行う
MAX_TOKENS = 16000

# 指示文・出力の形・検証・カルテの渡し方の版。どれかを変えたら上げる。上げると、保存済みのガイドは
# 使われなくなる。指示文と出力の形は、上げ忘れても指紋（``request_fingerprint``）が変わるので、
# 古い保存分が使われることは無い
GUIDE_VERSION = 4

# 思考の深さ。Opus 5.5 の既定（medium）より 1 段浅い low に固定する。確信度をコードの側で 3 段階に
# 直して渡すようにしたうえで、low でも内容の誤りが出ないことを実測で確かめた（2026-11-11。短い曲・
# 長い曲・セクション指定の計 8 回。docs/reproduction-guide-design.md の「費用」）。medium より
# 1〜2 割安く、2 割ほど速い。モデルや指示文を変えたら、測り直してから決め直す。
# 呼び出しごとに変えると、プロンプトキャッシュが効かなくなることがある（モデル・出力の形も同じ）
EFFORT = "low"

# プロンプトキャッシュの保持時間。"5m"（既定。書き込みは入力の 1.25 倍）か "1h"（2 倍）。
# None ならキャッシュの区切りを打たない
CACHE_TTL = "5m"

# 説明の主題。カルテのどの部分の話かを表す
TOPICS = ("grid", "key", "chords", "sections", "mix", "general")

GUIDE_SCHEMA = {
    "type": "object",
    "properties": {
        "overview": {
            "type": "string",
            "description": "曲全体の作りを 2〜3 文で。カルテに在る事実だけを使う。",
        },
        "steps": {
            "type": "array",
            "description": "再現するための手順。上から順に進めれば曲の骨格が出来る並びにする。",
            "items": {
                "type": "object",
                "properties": {
                    "title": {"type": "string", "description": "手順の見出し。"},
                    "topic": {"type": "string", "enum": list(TOPICS)},
                    "body": {
                        "type": "string",
                        "description": "何をどう設定・打ち込みするかの説明。初心者に分かる言葉で。",
                    },
                    "refs": {
                        "type": "array",
                        "description": "この手順が指すカルテ上の場所。画面でハイライトされる。",
                        "items": {
                            "type": "object",
                            "properties": {
                                "section_id": {
                                    "anyOf": [{"type": "string"}, {"type": "null"}],
                                    "description": "カルテの sections[].id。セクション全体を指すとき。",
                                },
                                "bar": {
                                    "anyOf": [{"type": "integer"}, {"type": "null"}],
                                    "description": "小節番号（1 始まり）。特定の小節を指すとき。",
                                },
                                "beat": {
                                    "anyOf": [{"type": "integer"}, {"type": "null"}],
                                    "description": "拍（1 始まり）。小節の中の位置まで指すとき。",
                                },
                            },
                            "required": ["section_id", "bar", "beat"],
                            "additionalProperties": False,
                        },
                    },
                },
                "required": ["title", "topic", "body", "refs"],
                "additionalProperties": False,
            },
        },
        "cautions": {
            "type": "array",
            "description": "確信度が低い項目・検出できなかった項目についての注意書き。",
            "items": {"type": "string"},
        },
    },
    "required": ["overview", "steps", "cautions"],
    "additionalProperties": False,
}

SYSTEM_PROMPT = """\
あなたは、DAW「bunri」に組み込まれた音楽制作のアシスタントです。利用者は、取り込んだ楽曲を\
教材にして、自分の手で再現できるようになりたい初心者です。

この会話には、楽曲を信号処理で解析した結果（楽曲カルテ）が <chart> タグの中に JSON で\
与えられます。あなたの仕事は、カルテの内容を「こう作れば再現できる」という手順の説明に\
言い換えることです。カルテの chords は表で、columns が列の名前、rows の 1 行が 1 つのコードです\
（length_beats は、そのコードが続く拍数）。

なぜ言い換えだけなのか: このアプリは「生成しないアシスタント」です。曲の事実は解析が出し、\
あなたはそれを読み上げて、初心者が次に何をすればよいか分かる形にします。あなたが自分の\
推測で事実を足すと、利用者はそれが解析結果なのか推測なのかを見分けられず、間違った内容を\
覚えてしまいます。

守ること:
- 事実はカルテに在るものだけを使う。キー、テンポ、コード、セクションの位置、ミックスの数値は、\
カルテの値をそのまま引く。カルテに無いコードや音名を挙げない。
- 音符は書かない。具体的な旋律・音高の並び・MIDI のデータは、あなたの担当ではない。\
「この小節は I → V → vi → IV の進行」のように、カルテのコードと度数を使って説明する。
- 確信度（confidence の付く項目）は、画面と同じ 3 段階（「確実」「たぶん」「自信なし」）で\
与えられる。その言い方のまま書く。「自信なし」の項目は断定せず、「解析では〜と出ているが\
自信なし」と伝えて、cautions に注意書きを入れる。値が null の項目や unavailable に理由が在る\
項目は、「検出できませんでした」と伝える。
- 数値は、利用者が設定や確認に使う桁まで丸める。テンポは整数（揺れが在るなら小数 1 桁）、\
秒は小数 1 桁、dB や LUFS は小数 1 桁。119.9993 のような解析の生の桁は書かない。
- 数値を並べるだけにしない。その値から、利用者が次に何をすればよいかを 1 つ言う。\
帯域のエネルギーなら、全部の値を読み上げるのではなく、どの帯域が中心かと、それを踏まえて \
音作りでどうするかを書く。
- grid.user_confirmed が false のときは、最初の手順でテンポ・拍子・1 拍目の位置を確認するよう促す。\
どれも解析が自動で決めた値で、テンポが倍や半分にずれていたり、拍子が違っていたりすると、\
コードもセクションも小節番号が全部ずれるため。
- 場所を指すときは refs を使う。セクション全体なら section_id、特定の小節なら bar（必要なら beat）。\
本文にも「サビ（17〜24 小節）」のように小節番号を書く。
- 手順は、テンポとキーの設定 → 曲の構成 → コード進行 → 音作りとミックス、の順を基本にする。\
focus が指定されたら、そのセクションの再現に絞る。
- 専門用語を使うときは、最初に一言で意味を添える。
- 曲そのものについての推測はしない。数値の傾向から、ジャンル・作られ方・楽器を\
言い当てようとしない（カルテに在る事実ではないため）。
- 日本語で書く。

書く量について: 利用者は、DAW の横の細いパネルでこれを読みながら手を動かします。長い説明は\
読まれず、作業の手も止まるので、次の量を目安にしてください。
- overview は 2〜3 文。
- 手順は、曲全体なら 5〜7 個、focus でセクションを絞ったときは 3〜5 個。1 つの手順の body は \
2〜4 文で、「何を設定・打ち込みするか」と「その根拠になるカルテの値」を書く。
- コード進行は、全部の小節を書き出さない。繰り返しのひとまとまり（たとえば 4 小節）で示し、\
そこから外れる小節だけを個別に挙げる。進行が同じセクションは、先に説明したセクションと同じだと書けば足りる。
- cautions は、利用者の作業が変わるものだけを、1 項目 1 文で。
- 解析できた項目が少ないカルテでは、在る項目についてだけ書く。検出できなかった項目は cautions に \
1 行ずつ挙げるだけにして、一般論で手順を埋めない（一般論を混ぜると、解析結果のように読めてしまうため）。\
手順が 1〜2 個になってもかまわない。

body の長さと書き方の例（内容は必ずカルテから取る。○○ はカルテの値）:
「テンポを ○○ BPM に設定し、メトロノームを鳴らして曲の頭と合うか確かめます。解析では 1 拍目が \
○○ 秒の位置に在ります（たぶん）。ずれて聞こえたら、カルテのグリッド補正で直してから次へ進みます。」
"""


class GuideError(Exception):
    """再現ガイドを作れなかったときの例外。メッセージは利用者にそのまま見せられる。

    Attributes:
        code: 画面側が出し分けに使う種類。``"no_key"``（API キーが無い）、
            ``"auth"``（キーが正しくない）、``"rate_limit"``、``"network"``、
            ``"refused"``（モデルが応答を断った）、``"truncated"``、``"api"``、``"invalid"``、
            ``"daily_limit"``（1 日の上限に達した）、``"too_long"``（カルテが長すぎる）、
            ``"no_material"``（解析できた項目がほとんど無い）。
        usage: 応答が返ってきていた場合の使用量（断られた・途中で切れた、でも費用はかかる）。
            応答が返る前の失敗なら None。
        model: 応答したモデル（分かる場合）。
    """

    def __init__(self, message, code="api", usage=None, model=None):
        super().__init__(message)
        self.code = code
        self.usage = usage
        self.model = model


# LLM に渡すコードの表の列。カルテの chords[] から、言語化に使う項目だけを取り出す
_CHORD_COLUMNS = ("bar", "beat", "length_beats", "symbol", "degree", "confidence")
_CHORD_SOURCE_KEYS = ("bar", "beat", "beat_count", "symbol", "degree", "confidence")


# 確信度の 3 段階の言い方。画面（web-ui/src/lib/chart.ts）と同じ
_TIER_LABEL = {"certain": "確実", "likely": "たぶん", "unsure": "自信なし"}


def _tier_label(value):
    """確信度の生値を、画面と同じ 3 段階の言い方にする（しきい値は ``song_chart.confidence_tier``）。"""
    import song_chart

    return _TIER_LABEL[song_chart.confidence_tier(value)]


def confidence_label(value):
    """確信度の生値を、画面と同じ 3 段階の言い方（確実 / たぶん / 自信なし）にする。

    第3層（``coach_explain``）も同じ言い方で渡すので、外から呼べる名前を付けてある。
    """
    return _tier_label(value)


def _label_confidences(node):
    """辞書・リストをたどり、確信度の項目（名前が ``confidence`` で終わる）を 3 段階の言い方に置き換える。"""
    if isinstance(node, dict):
        for key, value in node.items():
            if key.endswith("confidence") and (value is None or isinstance(value, (int, float))) \
                    and not isinstance(value, bool):
                node[key] = _tier_label(value)
            else:
                _label_confidences(value)
    elif isinstance(node, list):
        for value in node:
            _label_confidences(value)


def prompt_chart(chart, only_section=None):
    """カルテから、LLM に渡すぶんを取り出して JSON 文字列にする。

    言語化に使わない項目を外し、数の多いコードは表の形に詰める。確信度のほかは、値を変えない。

    - 確信度（``confidence`` ``bpm_confidence`` ``suggested_confidence``）: 生値（0〜1）ではなく、
      画面と同じ 3 段階（確実 / たぶん / 自信なし）にして渡す。数値をしきい値と比べて段階に直すのは
      機械的に決まる計算で、LLM にさせると言い間違える（実測で、思考の浅い設定や小さいモデルほど
      間違えた）。コードで直せば、画面の表示とも必ず一致する。生値はカルテに残る

    - ``grid.beat_times_sec``: 実測ビート列。数百個の数値で、言語化には使わない
      （小節・拍の位置は sections と chords が持っている）。数（``beat_count``）だけ残す
    - ``source.filename``: 曲の事実ではない。指示文でも、ファイル名からの推測を禁じている。
      送らなければ、利用者のファイル名が外に出ない
    - ``chords[]`` の ``beat_index`` ``start_sec`` ``end_sec``: 小節・拍（``bar`` ``beat``）と
      長さ（``beat_count``）から決まる。ガイドは場所を小節で指す
    - ``chords[]`` の ``root`` ``quality``: コード名（``symbol``）に含まれている
    - ``chords[]`` は、1 件ごとに項目名を繰り返さず、列の名前（``columns``）と行（``rows``）に分ける。
      長い曲では、入力のほとんどをコードの一覧が占めるため

    プロンプトキャッシュが効くよう、同じカルテからは常に同じバイト列を返す
    （キー順と区切り文字を固定する）。

    Args:
        chart: 楽曲カルテ（``song_chart.build_chart`` の結果）。
        only_section: セクションの ID。指定すると、コードの一覧をそのセクションの小節だけにする
            （長すぎるカルテで、対象を絞ったときに使う。``chords.only_section`` に絞った旨を残す）。

    Returns:
        str: JSON 文字列。
    """
    import song_chart

    slim = json.loads(song_chart.to_canonical_json(chart))
    grid = slim.get("grid")
    if isinstance(grid, dict):
        beats = grid.pop("beat_times_sec", None)
        grid["beat_count"] = len(beats) if isinstance(beats, list) else None
    source = slim.get("source")
    if isinstance(source, dict):
        source.pop("filename", None)

    chords = [c for c in slim.get("chords") or [] if isinstance(c, dict)]
    table = {"columns": list(_CHORD_COLUMNS)}
    if only_section is not None:
        section = next((s for s in slim.get("sections") or []
                        if isinstance(s, dict) and s.get("id") == only_section), None)
        if section is not None:
            first, last = section.get("start_bar") or 0, section.get("end_bar") or 0
            chords = [c for c in chords if isinstance(c.get("bar"), int) and first <= c["bar"] <= last]
            table["only_section"] = only_section
    slim["chords"] = []
    _label_confidences(slim)
    confidence_at = _CHORD_SOURCE_KEYS.index("confidence")
    rows = [[c.get(key) for key in _CHORD_SOURCE_KEYS] for c in chords]
    for row in rows:
        row[confidence_at] = _tier_label(row[confidence_at])
    table["rows"] = rows
    slim["chords"] = table
    return json.dumps(slim, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def build_request(chart, focus=None, *, model=None, effort=None, trim_to_focus=False):
    """Claude に送るリクエストの引数を組み立てる。

    並びは「変わらないもの → 変わるもの」。指示文とカルテを system に置き、カルテの後ろに
    キャッシュの区切りを打つ。問い合わせごとに変わる focus は、その後ろの user に置く。

    キャッシュは、区切りより前のバイト列・モデル・思考の深さ・出力の形がすべて同じときだけ効く。
    ``model`` ``effort`` を呼び出しごとに変えると効かなくなる（製品の経路では変えない。
    比較用のスクリプトが使う）。

    Args:
        chart: 楽曲カルテ。
        focus: 絞り込むセクションの ID（``sections[].id``）。None なら曲全体。
        model: モデルの ID。None なら ``llm_settings.model()``。
        effort: 思考の深さ。None なら ``EFFORT``。
        trim_to_focus: True なら、コードの一覧を ``focus`` のセクションだけにする
            （カルテが長すぎるとき。区切りより前が対象ごとに変わるので、対象をまたいだ
            キャッシュは効かなくなる）。

    Returns:
        dict: ``client.beta.messages.create`` に渡すキーワード引数。

    Raises:
        GuideError: ``focus`` がカルテに無いセクションを指している場合。
    """
    sections = {s.get("id"): s for s in chart.get("sections") or [] if isinstance(s, dict)}
    if focus is not None and focus not in sections:
        raise GuideError("指定されたセクションがカルテに在りません", code="invalid")

    if focus is None:
        request = "この曲全体について、再現ガイドを作ってください。"
    else:
        request = f"focus: セクション {focus} の再現に絞って、再現ガイドを作ってください。"

    model = model or llm_settings.model()
    chart_block = {
        "type": "text",
        "text": "<chart>\n" + prompt_chart(chart, only_section=focus if trim_to_focus else None) + "\n</chart>",
    }
    if CACHE_TTL == "1h":
        chart_block["cache_control"] = {"type": "ephemeral", "ttl": "1h"}
    elif CACHE_TTL:
        chart_block["cache_control"] = {"type": "ephemeral"}

    body = {
        "model": model,
        "max_tokens": MAX_TOKENS,
        "system": [{"type": "text", "text": SYSTEM_PROMPT}, chart_block],
        "messages": [{"role": "user", "content": request}],
        "output_config": {
            "effort": effort or EFFORT,
            "format": {"type": "json_schema", "schema": GUIDE_SCHEMA},
        },
    }
    if not model.startswith("claude-haiku"):
        # 安全性の分類器が応答を断ったとき、Anthropic が勧める別のモデルで同じ依頼をやり直す。
        # Haiku にはサーバ側のやり直しが無いので付けない
        body["betas"] = ["server-side-fallback-2026-07-01"]
        body["fallbacks"] = "default"
    return body


def request_fingerprint():
    """指示文・出力の形・版の指紋を返す。保存したガイドの鍵に入れる。

    Returns:
        str: 16 桁の 16 進文字列。指示文か出力の形か ``GUIDE_VERSION`` が変わると変わる。
    """
    payload = json.dumps([GUIDE_VERSION, SYSTEM_PROMPT, GUIDE_SCHEMA], ensure_ascii=False, sort_keys=True)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]


def guide_key(chart, focus, model, effort):
    """保存したガイドの鍵を返す。

    カルテの正規化 JSON のハッシュ・対象・モデル・思考の深さ・指示文と出力の形の指紋から作る。
    どれか 1 つでも違えば別の鍵になり、保存分は使われない。

    Args:
        chart: 楽曲カルテ。
        focus: 対象のセクション ID。曲全体なら None。
        model: 頼むモデルの ID。
        effort: 思考の深さ。

    Returns:
        str: 40 桁の 16 進文字列（ファイル名に使える）。
    """
    import guide_cache

    parts = [guide_cache.chart_hash(chart), focus or "", model, effort, request_fingerprint()]
    return hashlib.sha256("\n".join(parts).encode("utf-8")).hexdigest()[:40]


def material_shortage(chart):
    """カルテに、ガイドを作る材料が足りないときの理由を返す（足りていれば None）。

    テンポ・キー・コード・構成・ミックスのうち、解析できたものが 1 つ以下なら、言い換える事実が
    ほとんど無い。Claude を呼んでも「検出できませんでした」を並べるだけになるので、呼ばずに断る
    （判断は機械的に決まるので、LLM にさせない）。

    Args:
        chart: 楽曲カルテ。

    Returns:
        str | None: 利用者にそのまま見せられる理由。
    """
    unavailable = chart.get("unavailable") or {}
    grid, key, mix = chart.get("grid") or {}, chart.get("key") or {}, chart.get("mix") or {}
    available = {
        "テンポ": "grid" not in unavailable and bool(grid.get("bpm")) and (grid.get("bpm_confidence") or 0) > 0,
        "キー": bool(key.get("tonic")),
        "コード": bool(chart.get("chords")),
        "構成": bool(chart.get("sections")),
        "ミックス": mix.get("loudness_lufs") is not None,
    }
    if sum(available.values()) > 1:
        return None
    missing = "・".join(name for name, ok in available.items() if not ok)
    return (f"この音声からは、ガイドの材料になる項目をほとんど解析できませんでした（{missing}が検出できていません）。"
            "無音に近い、短すぎる、または音程の無い音声かもしれません。別の音声で試してください")


def _chart_bounds(chart):
    """カルテに在るセクション ID の集合と、小節・拍の上限を返す。"""
    sections = [s for s in chart.get("sections") or [] if isinstance(s, dict)]
    ids = {s.get("id") for s in sections if s.get("id")}
    last_bar = max([s.get("end_bar") or 0 for s in sections] + [c.get("bar") or 0 for c in chart.get("chords") or []] + [0])
    signature = (chart.get("grid") or {}).get("time_signature") or [4, 4]
    beats_per_bar = signature[0] if signature and isinstance(signature[0], int) else 4
    return ids, last_bar, beats_per_bar


def validate_guide(guide, chart):
    """LLM の出力をカルテと突き合わせ、カルテに無い場所への参照を落とす。

    Structured Outputs で形は保証されているが、中身（その小節が実在するか）までは
    保証されない。画面は参照をそのままハイライトに使うので、ここで実在するものだけに絞る。

    Args:
        guide: LLM が返した辞書（``GUIDE_SCHEMA`` の形）。
        chart: 楽曲カルテ。

    Returns:
        dict: ``{"overview", "steps", "cautions", "dropped_refs", "unverified_terms"}``。
        ``dropped_refs`` は落とした参照の数、``unverified_terms`` は説明文に出てきたが
        カルテに無い音名・コード名。

    Raises:
        GuideError: 出力の形が想定と違う場合。
    """
    if not isinstance(guide, dict) or not isinstance(guide.get("steps"), list):
        raise GuideError("ガイドの形式が正しくありません", code="invalid")

    section_ids, last_bar, beats_per_bar = _chart_bounds(chart)
    dropped = 0
    steps = []
    for step in guide["steps"]:
        if not isinstance(step, dict):
            raise GuideError("ガイドの形式が正しくありません", code="invalid")
        refs = []
        for ref in step.get("refs") or []:
            if not isinstance(ref, dict):
                dropped += 1
                continue
            section_id, bar, beat = ref.get("section_id"), ref.get("bar"), ref.get("beat")
            if section_id is not None and section_id not in section_ids:
                dropped += 1
                continue
            if bar is not None and not (isinstance(bar, int) and 1 <= bar <= last_bar):
                dropped += 1
                continue
            if beat is not None and not (bar is not None and isinstance(beat, int) and 1 <= beat <= beats_per_bar):
                beat = None
            if section_id is None and bar is None:
                dropped += 1
                continue
            refs.append({"section_id": section_id, "bar": bar, "beat": beat})
        topic = step.get("topic") if step.get("topic") in TOPICS else "general"
        steps.append({
            "title": str(step.get("title") or ""),
            "topic": topic,
            "body": str(step.get("body") or ""),
            "refs": refs,
        })

    cautions = [str(c) for c in guide.get("cautions") or [] if c]
    overview = str(guide.get("overview") or "")
    text = "\n".join([overview] + [s["title"] + "\n" + s["body"] for s in steps] + cautions)
    return {
        "overview": overview,
        "steps": steps,
        "cautions": cautions,
        "dropped_refs": dropped,
        "unverified_terms": unverified_terms(text, chart),
    }


# 音名・コード名らしい語。C / F# / Bb / Am7 / G7 / Csus4 / D/F# / C4（オクターブつきの音名）など。
# 前後が英字のもの（"Chorus" の C、"BPM" の B）は拾わない
_TERM_RE = re.compile(
    r"(?<![A-Za-z0-9#♯♭])"
    r"([A-G](?:#|b|♯|♭)?"
    r"(?:maj7|maj9|maj|min7|min|m7b5|m7|m9|m6|m|dim7|dim|aug|sus2|sus4|add9|7sus4|13|11|9|7|6|5|[0-8])?"
    r"(?:/[A-G](?:#|b|♯|♭)?)?)"
    r"(?![A-Za-z0-9#♯♭])"
)


def _normalize_term(term):
    return term.replace("♯", "#").replace("♭", "b")


def chart_vocabulary(chart):
    """カルテに在る音名・コード名・区分名の集合を返す。

    説明文に出てきてよい語の範囲。コード記号とそのルート、キーの主音（代替候補も）、
    セクションの繰り返しグループ名（"A" "B" など。コード名と紛らわしいので含める）。

    Args:
        chart: 楽曲カルテ。

    Returns:
        set[str]: 語の集合。
    """
    words = set()
    for chord in chart.get("chords") or []:
        if not isinstance(chord, dict):
            continue
        for key in ("symbol", "root"):
            if chord.get(key):
                words.add(_normalize_term(str(chord[key])))
        symbol = str(chord.get("symbol") or "")
        if "/" in symbol:
            words.update(_normalize_term(part) for part in symbol.split("/") if part)
    key = chart.get("key") or {}
    if key.get("tonic"):
        words.add(_normalize_term(str(key["tonic"])))
    for alt in key.get("alternatives") or []:
        if isinstance(alt, dict) and alt.get("tonic"):
            words.add(_normalize_term(str(alt["tonic"])))
    for section in chart.get("sections") or []:
        if isinstance(section, dict) and section.get("repeat_group"):
            words.add(str(section["repeat_group"]))
    return words


def unverified_terms(text, chart):
    """説明文に出てきた音名・コード名のうち、カルテに無いものを返す。

    LLM がカルテに無い事実（コードや音符）を足していないかの見張り。誤検出もありうるので
    （例: 「A メロ」の A）、出力を捨てはせず、画面が「解析結果に無い語」として示す材料にする。
    日本語のセクション名「A メロ」「B メロ」は、よく使う言い方なので拾わない。

    Args:
        text: 説明文。
        chart: 楽曲カルテ。

    Returns:
        list[str]: カルテに無い語（出てきた順、重複なし）。
    """
    return terms_outside(text, chart_vocabulary(chart))


def terms_outside(text, allowed):
    """説明文に出てきた音名・コード名のうち、``allowed`` に無いものを返す。

    ``unverified_terms`` の中身。語の範囲を呼び出し側が決められるよう分けてある
    （第3層は、カルテではなく差分の事実から範囲を作る）。

    Args:
        text: 説明文。
        allowed: 出てきてよい語の集合（``#`` ``b`` で書いたもの）。

    Returns:
        list[str]: ``allowed`` に無い語（出てきた順、重複なし）。
    """
    found = []
    for match in _TERM_RE.finditer(text or ""):
        term = _normalize_term(match.group(1))
        rest = text[match.end():match.end() + 3]
        if len(term) == 1 and rest.lstrip(" 　").startswith("メロ"):
            continue
        if term in allowed or term in found:
            continue
        found.append(term)
    return found


def _usage(response):
    """応答の使用量を、記録と画面用の辞書にする。

    課金の単位になる 4 つの計器と、出力のうち思考に使われたぶん（分かる場合）。
    """
    usage = getattr(response, "usage", None)
    details = getattr(usage, "output_tokens_details", None)
    return {
        "input_tokens": getattr(usage, "input_tokens", None),
        "output_tokens": getattr(usage, "output_tokens", None),
        "cache_read_input_tokens": getattr(usage, "cache_read_input_tokens", None),
        "cache_creation_input_tokens": getattr(usage, "cache_creation_input_tokens", None),
        "thinking_tokens": getattr(details, "thinking_tokens", None),
    }


@contextmanager
def _api_errors():
    """Anthropic SDK の例外を、利用者にそのまま見せられる ``GuideError`` に直す。"""
    import anthropic

    try:
        yield
    except TypeError as e:
        # SDK は、使える認証情報が 1 つも無いとき TypeError を出す
        if "authentication" in str(e).lower():
            raise GuideError("Claude の API キーが設定されていません。設定してからもう一度試してください", code="no_key")
        raise
    except anthropic.AuthenticationError:
        raise GuideError("Claude の API キーが正しくありません。設定し直してください", code="auth")
    except anthropic.PermissionDeniedError:
        raise GuideError("この API キーでは、このモデルを使う権限がありません", code="auth")
    except anthropic.RateLimitError:
        raise GuideError("Claude の利用制限に達しました。少し待ってからもう一度試してください", code="rate_limit")
    except anthropic.APIConnectionError:
        raise GuideError("Claude に接続できませんでした。ネットワークを確認してください", code="network")
    except anthropic.APIStatusError as e:
        raise GuideError(f"Claude の API がエラーを返しました（{e.status_code}）", code="api")


def request_chars(request):
    """リクエストに含まれる文字数を返す（指示文・カルテ・依頼・出力の形）。

    トークン数は文字数を超えないので（1 トークンは 1 文字以上）、これが上限より小さければ、
    トークン数を数えるまでもなく上限に収まる。
    """
    total = sum(len(block.get("text") or "") for block in request["system"])
    total += sum(len(m["content"]) for m in request["messages"] if isinstance(m.get("content"), str))
    total += len(json.dumps(request["output_config"]["format"], ensure_ascii=False))
    return total


def count_input_tokens(request, client):
    """リクエストの入力のトークン数を、API に数えさせる（推論はしない。費用はかからない）。

    Args:
        request: ``build_request`` の結果。
        client: Anthropic のクライアント。

    Returns:
        int: 入力のトークン数（指示文・カルテ・依頼。出力の形のぶんは含まない）。

    Raises:
        GuideError: API キーが無い・正しくない、通信できない、などの場合。
    """
    system = [{"type": "text", "text": block["text"]} for block in request["system"]]
    with _api_errors():
        result = client.messages.count_tokens(model=request["model"], system=system, messages=request["messages"])
    return result.input_tokens


def fit_request(chart, focus, client, max_input_tokens, *, model=None, effort=None):
    """入力が上限に収まるリクエストを返す。収まらなければ、黙って切らずに理由を出す。

    長い曲ではコードの一覧が長くなる。カルテ全体が上限を超えるときは、

    - 対象が曲全体なら、対象をセクションに絞るよう知らせる
    - 対象がセクションなら、コードの一覧をそのセクションだけにして送る（それでも超えるなら知らせる）

    文字数が上限より小さければ、数えずに通す（``request_chars``）。

    Args:
        chart: 楽曲カルテ。
        focus: 対象のセクション ID。曲全体なら None。
        client: Anthropic のクライアント（トークン数を数えるのに使う）。
        max_input_tokens: 入力の上限（トークン）。
        model: モデルの ID。None なら ``llm_settings.model()``。
        effort: 思考の深さ。None なら ``EFFORT``。

    Returns:
        dict: ``build_request`` の形のリクエスト。

    Raises:
        GuideError: 上限に収まらない場合（``code="too_long"``）。
    """
    request = build_request(chart, focus, model=model, effort=effort)
    if request_chars(request) <= max_input_tokens:
        return request
    tokens = count_input_tokens(request, client)
    if tokens <= max_input_tokens:
        return request
    if focus is None:
        raise GuideError(
            f"この曲はカルテが長く、Claude に送る量が上限を超えます（約 {tokens:,} トークン。上限は {max_input_tokens:,}）。"
            "「対象」でセクションを選んで、絞って作ってください", code="too_long")
    trimmed = build_request(chart, focus, model=model, effort=effort, trim_to_focus=True)
    if request_chars(trimmed) > max_input_tokens:
        tokens = count_input_tokens(trimmed, client)
        if tokens > max_input_tokens:
            raise GuideError(
                f"このセクションだけでも、Claude に送る量が上限を超えます（約 {tokens:,} トークン。上限は {max_input_tokens:,}）。"
                "設定で入力の上限を上げてください", code="too_long")
    return trimmed


def call_structured(request, client,
                    truncated_message="ガイドが長くなりすぎて途中で切れました。セクションを絞って試してください"):
    """Claude を 1 回呼び、Structured Outputs の JSON を辞書にして返す。

    呼び出しと、応答の読み取り（断られた・途中で切れた・JSON でない、の見分け）だけを受け持つ。
    中身の検証は呼び出し側が行う。第2層（``generate``）と第3層（``coach_explain.generate``）が使う。

    Args:
        request: ``client.beta.messages.create`` に渡すキーワード引数。
        client: Anthropic のクライアント。
        truncated_message: 出力が途中で切れたときに、利用者に見せる文。

    Returns:
        tuple[dict, str, dict]: ``(モデルが返した JSON, 応答したモデル, 使用量)``。

    Raises:
        GuideError: API キーが無い・正しくない、通信できない、モデルが応答を断った、出力が途中で
            切れた、JSON として読めない、などの場合。応答が返ってきていた失敗では、``usage`` に
            使用量が入る。
    """
    with _api_errors():
        response = client.beta.messages.create(**request)

    usage = _usage(response)
    model = getattr(response, "model", request["model"])

    def fail(message, code):
        return GuideError(message, code=code, usage=usage, model=model)

    if response.stop_reason == "refusal":
        raise fail("この内容については、モデルが応答を返しませんでした", "refused")
    if response.stop_reason == "max_tokens":
        raise fail(truncated_message, "truncated")

    text = next((block.text for block in response.content if block.type == "text"), None)
    if not text:
        raise fail("モデルから説明文が返りませんでした", "invalid")
    try:
        raw = json.loads(text)
    except json.JSONDecodeError:
        raise fail("モデルの応答を読み取れませんでした", "invalid")
    return raw, model, usage


def generate(chart, focus=None, client=None, request=None):
    """楽曲カルテから再現ガイドを作る（Claude を 1 回呼ぶ）。

    保存分の再利用・上限の確認・記録は行わない。それらは ``guide_for`` が受け持つ。

    Args:
        chart: 楽曲カルテ。
        focus: 絞り込むセクションの ID。None なら曲全体。
        client: Anthropic のクライアント。None なら ``llm_settings.make_client()`` で作る
            （テストでは差し替える）。
        request: 送るリクエスト。None なら ``build_request(chart, focus)``。

    Returns:
        dict: ``{"guide": 検証済みのガイド, "model": 応答したモデル, "usage": 使用量}``。

    Raises:
        GuideError: API キーが無い・正しくない、通信できない、モデルが応答を断った、
            出力が途中で切れた、などの場合。メッセージは利用者にそのまま見せられる。
            応答が返ってきていた失敗では、``usage`` に使用量が入る。
    """
    if request is None:
        request = build_request(chart, focus)
    if client is None:
        client = llm_settings.make_client()

    raw, model, usage = call_structured(request, client)
    try:
        guide = validate_guide(raw, chart)
    except GuideError as e:
        raise GuideError(str(e), code=e.code, usage=usage, model=model)

    return {"guide": guide, "model": model, "usage": usage}


def _public(entry, cached, key=None):
    """保存したガイドの 1 件を、API の応答に載せる形にする。

    ``key`` は保存の鍵。プロジェクトの保存（``project_store``）が、この曲のガイドの写しを
    `.bunri` に入れるときの識別子になる。
    """
    return {
        "key": key,
        "guide": entry["guide"],
        "model": entry.get("model"),
        "usage": entry.get("usage") or {},
        "cost_usd": entry.get("cost_usd"),
        "duration_sec": entry.get("duration_sec"),
        "created_at": entry.get("created_at"),
        "cached": cached,
    }


def cache_keys_for(chart):
    """このカルテのガイドの保存の鍵を、曲全体と各セクションのぶん返す（いまのモデルと設定で）。

    プロジェクトを保存するとき、保存済みのガイドの写しを `.bunri` に入れるのに使う
    （開き直したときに Claude を呼ばずに出すため。``project_store``）。

    Args:
        chart: 楽曲カルテ。

    Returns:
        list[str]: 鍵のリスト（曲全体が先頭）。
    """
    keys = []
    focuses = [None] + [s.get("id") for s in chart.get("sections") or [] if isinstance(s, dict) and s.get("id")]
    for focus in focuses:
        try:
            request = build_request(chart, focus)
        except GuideError:
            continue
        keys.append(guide_key(chart, focus, request["model"], request["output_config"]["effort"]))
    return keys


def saved_guide(chart, focus=None):
    """保存済みのガイドを返す（無ければ None）。API は呼ばない。

    Args:
        chart: 楽曲カルテ。
        focus: 対象のセクション ID。曲全体なら None。

    Returns:
        dict | None: ``guide_for`` と同じ形（``cached`` は True）。

    Raises:
        GuideError: ``focus`` がカルテに無いセクションを指している場合。
    """
    import guide_cache

    request = build_request(chart, focus)
    key = guide_key(chart, focus, request["model"], request["output_config"]["effort"])
    entry = guide_cache.load(key)
    return _public(entry, cached=True, key=key) if entry else None


def guide_for(chart, focus=None, regenerate=False, client=None):
    """再現ガイドを返す。保存済みが在ればそれを返し、無いときだけ Claude を呼ぶ。

    順番:

    1. 保存済みが在れば、API を呼ばずに返す（``regenerate`` が True なら飛ばす）
    2. 同じカルテへの呼び出しを 1 つずつ通す。待っている間に、同じ条件のガイドが出来ていたら
       それを返す（連打・二重送信で 2 回呼ばない。作り直しの連打も同じ）
    3. 材料が足りないカルテ、1 日の上限に達しているとき、入力が長すぎるときは、API を呼ばずに断る
    4. Claude を呼び、使用量を記録し、ガイドを保存する

    Args:
        chart: 楽曲カルテ。
        focus: 対象のセクション ID。曲全体なら None。
        regenerate: True なら、保存済みが在っても作り直す（費用がかかる）。
        client: Anthropic のクライアント（テストでは差し替える）。

    Returns:
        dict: ``{"guide", "model", "usage", "cost_usd", "duration_sec", "created_at", "cached"}``。
        ``cached`` は、保存済みを返したとき True。

    Raises:
        GuideError: 作れなかった場合。メッセージは利用者にそのまま見せられる。
    """
    import guide_cache
    import guide_usage

    request = build_request(chart, focus)
    model, effort = request["model"], request["output_config"]["effort"]
    key = guide_key(chart, focus, model, effort)
    if not regenerate:
        entry = guide_cache.load(key)
        if entry:
            return _public(entry, cached=True, key=key)

    chart_id = guide_cache.chart_hash(chart)
    asked_at = time.time()
    with guide_cache.lock_for(chart_id):
        entry = guide_cache.load(key)
        if entry and (not regenerate or (entry.get("created_ts") or 0) >= asked_at):
            return _public(entry, cached=True, key=key)

        shortage = material_shortage(chart)
        if shortage:
            raise GuideError(shortage, code="no_material")
        blocked = guide_usage.today()["blocked"]
        if blocked:
            raise GuideError(blocked, code="daily_limit")

        if client is None:
            client = llm_settings.make_client()
        request = fit_request(chart, focus, client, guide_usage.settings()["max_input_tokens"])

        log = {"requested_model": model, "effort": effort, "focus": focus, "chart": chart_id[:16],
               "cache_ttl": CACHE_TTL or "none", "version": request_fingerprint()}
        started = time.monotonic()
        try:
            result = generate(chart, focus, client=client, request=request)
        except GuideError as e:
            guide_usage.record_call(ok=False, error=e.code, model=e.model or model, usage=e.usage,
                                    duration_sec=time.monotonic() - started, **log)
            raise
        duration = time.monotonic() - started
        record = guide_usage.record_call(ok=True, model=result["model"], usage=result["usage"],
                                         duration_sec=duration, **log)
        entry = {
            "guide": result["guide"],
            "model": result["model"],
            "usage": result["usage"],
            "cost_usd": record["cost_usd"],
            "duration_sec": record["duration_sec"],
            "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "created_ts": time.time(),
            "requested_model": model,
            "effort": effort,
            "focus": focus,
            "chart": chart_id,
            "fingerprint": request_fingerprint(),
        }
        guide_cache.save(key, entry)
        return _public(entry, cached=False, key=key)
