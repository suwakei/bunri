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
"""
import json
import re

import llm_settings

# 1 回の応答の上限。ガイドは数千トークンに収まる
MAX_TOKENS = 16000

# 説明の主題。カルテのどの部分の話かを表す
TOPICS = ("grid", "key", "chords", "sections", "mix", "general")

GUIDE_SCHEMA = {
    "type": "object",
    "properties": {
        "overview": {
            "type": "string",
            "description": "曲全体の作りを 2〜4 文で。カルテに在る事実だけを使う。",
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
言い換えることです。

なぜ言い換えだけなのか: このアプリは「生成しないアシスタント」です。曲の事実は解析が出し、\
あなたはそれを読み上げて、初心者が次に何をすればよいか分かる形にします。あなたが自分の\
推測で事実を足すと、利用者はそれが解析結果なのか推測なのかを見分けられず、間違った内容を\
覚えてしまいます。

守ること:
- 事実はカルテに在るものだけを使う。キー、テンポ、コード、セクションの位置、ミックスの数値は、\
カルテの値をそのまま引く。カルテに無いコードや音名を挙げない。
- 音符は書かない。具体的な旋律・音高の並び・MIDI のデータは、あなたの担当ではない。\
「この小節は I → V → vi → IV の進行」のように、カルテのコードと度数を使って説明する。
- 確信度（confidence）が 0.5 未満の項目は断定しない。「解析では〜と出ているが確信度は低い」と\
伝え、cautions に注意書きを入れる。値が null の項目や unavailable に理由が在る項目は、\
「検出できませんでした」と伝える。
- grid.user_confirmed が false のときは、最初の手順でテンポと 1 拍目の位置を確認するよう促す。\
テンポが倍や半分にずれていると、コードもセクションも全部ずれるため。
- 場所を指すときは refs を使う。セクション全体なら section_id、特定の小節なら bar（必要なら beat）。\
本文にも「サビ（17〜24 小節）」のように小節番号を書く。
- 手順は、テンポとキーの設定 → 曲の構成 → コード進行 → 音作りとミックス、の順を基本にする。\
focus が指定されたら、そのセクションの再現に絞る。
- 専門用語を使うときは、最初に一言で意味を添える。
- 日本語で書く。
"""


class GuideError(Exception):
    """再現ガイドを作れなかったときの例外。メッセージは利用者にそのまま見せられる。

    Attributes:
        code: 画面側が出し分けに使う種類。``"no_key"``（API キーが無い）、
            ``"auth"``（キーが正しくない）、``"rate_limit"``、``"network"``、
            ``"refused"``（モデルが応答を断った）、``"truncated"``、``"api"``、``"invalid"``。
    """

    def __init__(self, message, code="api"):
        super().__init__(message)
        self.code = code


def prompt_chart(chart):
    """カルテから、LLM に渡すぶんを取り出して JSON 文字列にする。

    実測ビート列 ``grid.beat_times_sec`` は数百個の数値で、言語化には使わないので外す
    （小節・拍の位置は sections と chords が持っている）。それ以外はそのまま渡す。

    プロンプトキャッシュが効くよう、同じカルテからは常に同じバイト列を返す
    （キー順と区切り文字を固定する）。

    Args:
        chart: 楽曲カルテ（``song_chart.build_chart`` の結果）。

    Returns:
        str: JSON 文字列。
    """
    import song_chart

    slim = json.loads(song_chart.to_canonical_json(chart))
    grid = slim.get("grid")
    if isinstance(grid, dict):
        beats = grid.pop("beat_times_sec", None)
        grid["beat_count"] = len(beats) if isinstance(beats, list) else None
    return json.dumps(slim, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def build_request(chart, focus=None):
    """Claude に送るリクエストの引数を組み立てる。

    並びは「変わらないもの → 変わるもの」。指示文とカルテを system に置き、カルテの後ろに
    キャッシュの区切りを打つ。問い合わせごとに変わる focus は、その後ろの user に置く。

    Args:
        chart: 楽曲カルテ。
        focus: 絞り込むセクションの ID（``sections[].id``）。None なら曲全体。

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

    return {
        "model": llm_settings.model(),
        "max_tokens": MAX_TOKENS,
        "system": [
            {"type": "text", "text": SYSTEM_PROMPT},
            {
                "type": "text",
                "text": "<chart>\n" + prompt_chart(chart) + "\n</chart>",
                "cache_control": {"type": "ephemeral"},
            },
        ],
        "messages": [{"role": "user", "content": request}],
        # このモデルは既定が medium。説明文の作成には十分なので、明示して固定する
        "output_config": {
            "effort": "medium",
            "format": {"type": "json_schema", "schema": GUIDE_SCHEMA},
        },
        # 安全性の分類器が応答を断ったとき、Anthropic が勧める別のモデルで同じ依頼をやり直す
        "betas": ["server-side-fallback-2026-07-01"],
        "fallbacks": "default",
    }


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
    allowed = chart_vocabulary(chart)
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
    """応答の使用量を、画面とログ用の辞書にする（キャッシュが効いたかの確認に使う）。"""
    usage = getattr(response, "usage", None)
    return {
        "input_tokens": getattr(usage, "input_tokens", None),
        "output_tokens": getattr(usage, "output_tokens", None),
        "cache_read_input_tokens": getattr(usage, "cache_read_input_tokens", None),
        "cache_creation_input_tokens": getattr(usage, "cache_creation_input_tokens", None),
    }


def generate(chart, focus=None, client=None):
    """楽曲カルテから再現ガイドを作る。

    Args:
        chart: 楽曲カルテ。
        focus: 絞り込むセクションの ID。None なら曲全体。
        client: Anthropic のクライアント。None なら ``llm_settings.make_client()`` で作る
            （テストでは差し替える）。

    Returns:
        dict: ``{"guide": 検証済みのガイド, "model": 応答したモデル, "usage": 使用量}``。

    Raises:
        GuideError: API キーが無い・正しくない、通信できない、モデルが応答を断った、
            出力が途中で切れた、などの場合。メッセージは利用者にそのまま見せられる。
    """
    import anthropic

    request = build_request(chart, focus)
    if client is None:
        client = llm_settings.make_client()

    try:
        response = client.beta.messages.create(**request)
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

    if response.stop_reason == "refusal":
        raise GuideError("この内容については、モデルが応答を返しませんでした", code="refused")
    if response.stop_reason == "max_tokens":
        raise GuideError("ガイドが長くなりすぎて途中で切れました。セクションを絞って試してください", code="truncated")

    text = next((block.text for block in response.content if block.type == "text"), None)
    if not text:
        raise GuideError("モデルから説明文が返りませんでした", code="invalid")
    try:
        raw = json.loads(text)
    except json.JSONDecodeError:
        raise GuideError("モデルの応答を読み取れませんでした", code="invalid")

    return {
        "guide": validate_guide(raw, chart),
        "model": getattr(response, "model", request["model"]),
        "usage": _usage(response),
    }
