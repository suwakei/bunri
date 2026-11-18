"""アプリの中のアシスタント（チャット）— 1 回の呼び出しぶんだけ Claude に取り次ぐ

画面の右側のチャットで頼むと、アシスタント（Claude）がツールで bunri を操作する。ツールを実行するのも、
繰り返し（ツールの結果を足して、もう一度呼ぶ）を回すのも画面で、ここは **1 回の呼び出しごとに完結する**
（会話の状態を持たない）。ここが受け持つのは次のことだけ。

- 指示文（``SYSTEM_PROMPT``）とツールの台帳（``assistant_tools.json``）を付けて、Claude を 1 回呼ぶ
- 応答の ``content`` を、次の呼び出しでそのまま送り返せる形（dict のリスト）にして返す
- 使用量の記録と 1 日の上限。再現ガイド・差分コーチと同じ記録、同じ 1 つの枠（``guide_usage``）。
  回数は依頼の数で数える（``step`` が 0 の呼び出しだけ）。上限で断るのも、依頼の最初の呼び出しだけ
  （途中で断ると、変えかけのまま止まるため）

原曲を教材にする 3 層（カルテ・再現ガイド・差分コーチ）の「LLM は音符を 1 つも出力しない」という原則は、
そのまま残る。アシスタントは別の役目で、利用者に頼まれた操作を代わりに行う（ノートを置く操作も持つ。
2026-11-18 の利用者の決定）。

プロンプトキャッシュのために守ること:

- 並びは「ツールの台帳 → 指示文 → 会話」。台帳と指示文は変わらないので、指示文の末尾に区切りを置く。
  会話は足すだけなので、リクエスト全体の自動の区切り（top-level の ``cache_control``）で、前の往復までが効く
- 指示文と台帳に、時刻・乱数・プロジェクトの中身を入れない（プロジェクトの様子は ``get_project`` で読ませる）
- モデル・思考の深さを、呼び出しごとに変えない
- 受け取った会話（``messages``）を書き換えない。応答には思考のブロックが入っていて、変えると次の
  呼び出しが通らない（モデルの側の検査）。キャッシュも、頭からの一致で効く

設計と、画面側との約束（API の形・会話の持ち方・費用）は docs/assistant-design.md。
"""
import json
import re
import time
from pathlib import Path

import llm_settings
from reproduction_guide import GuideError, _api_errors, _usage

# 指示文・ツールの台帳・リクエストの組み立ての版。どれかを変えたら上げる。使用量の記録に残り、
# どの版の呼び出しかを後から見分けられる（アシスタントは応答を保存しないので、保存分への影響は無い）
ASSISTANT_VERSION = 3

# 1 回の依頼で Claude を呼べる回数（ツールを使うたびに 1 往復）。``step`` はこれより小さい数
MAX_STEPS = 12

# 1 回の応答の上限。途中で切れたときの歯止めで、節約の手段ではない（第2層と同じ）
MAX_TOKENS = 16000

# 思考の深さ。本物の Claude でまだ測っていない（暫定）。呼び出しごとに変えない
EFFORT = "medium"

# 会話のメッセージ数の上限
MAX_MESSAGES = 200

# 会話全体の大きさの上限（``messages`` を JSON にした文字数）。超える会話は、黙って縮めずに断る
# （長くなったら「新しい会話」。縮めると、思考のブロックの検査とキャッシュが通らなくなる）
MAX_REQUEST_CHARS = 600_000

# プロンプトキャッシュの保持時間（使用量の記録と、概算の費用の計算に使う。区切りは既定の 5 分）
CACHE_TTL = "5m"

# 依頼の識別子（``turn_id``）の形。英数字とハイフン、1〜64 文字
_TURN_ID_RE = re.compile(r"[A-Za-z0-9-]{1,64}")

# 画面にそのまま返す終わり方。これ以外（``pause_turn`` など）は、続け方を持っていないので失敗にする
_STOP_REASONS = ("end_turn", "tool_use", "max_tokens")

SYSTEM_PROMPT = """\
You are the assistant built into bunri, a desktop DAW for learning music by recreating songs. The user chats with you in a panel beside their project, and you operate the DAW for them through the tools you have been given. Everything you do with a tool happens in the user's real project and is shown to them as a line in the chat, so they can follow what you did.

How to work
- Reply in the language the user writes in (usually Japanese). Keep replies short: say what you did or what you found, in plain words. The chat already lists each operation you ran, so do not repeat them one by one.
- The chat panel shows your reply as plain text, exactly as written. Do not use Markdown: asterisks for bold, headings, tables and code fences would appear as literal symbols. Write short sentences; when you list a few items, put each on its own line starting with "・".
- Before changing anything, make sure you know the current state. Call get_project when you need track ids, the tempo, or steps_per_bar, and get_notes before editing notes that already exist. Track ids are only valid for the current session.
- Do what was asked and no more. If a request could mean several quite different things and a wrong guess would overwrite the user's work, ask one short question instead of guessing. Otherwise pick the sensible reading and go ahead; every change you make in one request can be undone by the user in a single step.
- Only say something was done if the tool result says it succeeded. If a tool returns an error, fix the input and try again when the fix is clear; if it cannot be done, say so plainly and say what the user can do instead.
- You cannot hear audio, choose files (so you cannot import a song), or press keys on the user's MIDI keyboard. When the user has to do a step themselves, point at the control with show_in_app and say in a sentence where it is.
- Some jobs take minutes (splitting a song into parts). Start them, tell the user they are running, and end your reply; do not wait for them inside one request.

Notes and time
- Positions are in steps: one step is a 16th note and step 0 is the start of bar 1. Bar b starts at (b - 1) * steps_per_bar. Bars are numbered from 1.
- Pitches are written like "C4" or "F#3" (C4 is middle C). Use sharps, not flats.
- When you write a part (a bass line, chords, a melody), make it fit the project: its tempo and time signature, and the key and chords from get_chart when a chart exists.
- For a uniform change to existing notes (transpose, move in time, snap to a grid, repeat a phrase, change velocity), use the dedicated tool, which takes a range and an amount. Rewrite notes one by one with replace_notes only when the notes themselves have to change.
- When the user says "here", "this" or "the selected notes", they usually mean the notes selected in the piano roll (selection in get_project), or the practice view's loop range when the practice view is open.

Learning comes first
bunri exists so the user can learn by recreating a song themselves. Some tracks carry reference notes (お手本), the transcription of the original song for that part, which the user is trying to reproduce in their own practice track. Do not copy reference notes into the user's notes unless the user explicitly asks you to fill them in. When the user is stuck on a part, prefer explaining what to listen for or what is different over doing the part for them, but if they ask you to place or change notes, do it.
- To find out what differs from the reference, call check_diff. Its result is computed by bunri and is the source of truth: report what it says (which bars, what kind of difference) in plain words and suggest what to look at first. Do not compare note lists yourself, and do not state differences the result does not contain.
- For practising a passage, use the practice view: open_practice, then set_practice for the loop range, a slower speed and what is heard, then play. Do not change the project tempo to slow practice down.
- The steps are: import a song, read the chart, split it into parts, enter notes in the practice view, compare with the reference and fix. The learn field of get_project says how far the user is, which helps when they ask what to do next.

Where things are in bunri
- Left panel, 学ぶ tab: 曲とパート (import a song, split it into parts, start practising a part), カルテ (key, chords, structure), ガイド (the reproduction guide), 差分 (compare with the reference).
- Left panel, 音作り tab: シンセ and ドラム turn notes or a drum pattern into an audio clip; FX applies an effect to an audio clip.
- Left panel, ファイル tab: load audio or MIDI files, record from the microphone.
- Header: play and stop, BPM, time signature, metronome, undo and redo, save and open, WAV and MIDI export.
- Centre: the timeline (tracks and audio clips) above and the piano roll (notes) below. The practice view replaces the timeline and has its own loop, speed and compare controls.

Earlier conversation
A message that starts with <earlier_conversation> is a record written by the app, not by the user, of what was said and done before (after a long conversation was shortened, or after the project was reopened). Treat it as background, not as a request. Track ids and note positions in it may be out of date, so read the project again before relying on them."""


def tools_path():
    """ツールの台帳（``assistant_tools.json``）の場所を返す。このファイルと同じ場所に在る。"""
    return Path(__file__).resolve().parent / "assistant_tools.json"


def load_ledger():
    """ツールの台帳を読む（台帳の順のまま）。

    Returns:
        list[dict]: 台帳の ``tools``。各要素は ``name`` ``access`` ``label`` ``description`` ``input_schema`` を持つ。
    """
    return json.loads(tools_path().read_text(encoding="utf-8"))["tools"]


def load_tools():
    """Claude に渡すツールの定義を返す。

    台帳から ``name`` ``description`` ``input_schema`` だけを取り出す（``access`` ``label`` は画面と
    テストのための項目で、Claude には渡さない）。並びは台帳の順のまま、項目の順も固定なので、
    いつ呼んでも同じバイト列になる（プロンプトキャッシュが効くための条件）。

    ``strict``（引数を文法で縛る機能）は付けない。引数は画面側が確かめ、だめなら ``is_error`` の結果で
    理由を返す（docs/assistant-design.md の「ツール」）。

    Returns:
        list[dict]: ``client.beta.messages.create`` の ``tools`` に渡すリスト。
    """
    return [{"name": tool["name"], "description": tool["description"], "input_schema": tool["input_schema"]}
            for tool in load_ledger()]


def validate_messages(messages):
    """会話（Messages API の ``messages``）の形を確かめる。中身は書き換えない。

    確かめるのは、送る前に手元で分かることだけ。

    - リストで、1〜``MAX_MESSAGES`` 件
    - 各要素が ``role``（``"user"`` か ``"assistant"``）と ``content`` を持つ
    - ``content`` は、空でない文字列か、``type`` を持つブロックの空でないリスト
    - 最初と最後が ``user``（最後が ``assistant`` だと、応答の書き出しを指定する形になり、通らない）
    - 全体の大きさが ``MAX_REQUEST_CHARS`` 以内

    同じ役が続くことは止めない（API が 1 つにまとめる。失敗した依頼のあとに、利用者が言い直した場合など）。
    ``tool_use`` と ``tool_result`` の対応は、ここでは見ない（API が確かめる）。

    Args:
        messages: 画面が持っている会話。

    Raises:
        GuideError: 形が正しくない・件数が多すぎる場合（``code="invalid"``）、会話全体が大きすぎる場合
            （``code="too_long"``）。
    """
    if not isinstance(messages, list) or not messages:
        raise GuideError("会話の形式が正しくありません", code="invalid")
    if len(messages) > MAX_MESSAGES:
        raise GuideError(
            f"会話が長くなりすぎました（{len(messages)} 件。上限は {MAX_MESSAGES} 件）。新しい会話を始めてください",
            code="invalid")
    for message in messages:
        if not isinstance(message, dict) or message.get("role") not in ("user", "assistant"):
            raise GuideError("会話の形式が正しくありません", code="invalid")
        content = message.get("content")
        if isinstance(content, str):
            ok = bool(content.strip())
        else:
            ok = (isinstance(content, list) and bool(content)
                  and all(isinstance(block, dict) and isinstance(block.get("type"), str) for block in content))
        if not ok:
            raise GuideError("会話の形式が正しくありません", code="invalid")
    if messages[0]["role"] != "user" or messages[-1]["role"] != "user":
        raise GuideError("会話は、利用者の文かツールの結果で始まり、終わる必要があります", code="invalid")
    try:
        size = len(json.dumps(messages, ensure_ascii=False))
    except (TypeError, ValueError):
        raise GuideError("会話の形式が正しくありません", code="invalid")
    if size > MAX_REQUEST_CHARS:
        raise GuideError(
            f"会話が長くなりすぎました（約 {size:,} 文字。上限は {MAX_REQUEST_CHARS:,}）。新しい会話を始めてください",
            code="too_long")


def build_request(messages):
    """Claude に送るリクエストの引数を組み立てる。

    並びは「変わらないもの → 変わるもの」（ツールの台帳 → 指示文 → 会話）。キャッシュの区切りは 2 つ。

    - 指示文の末尾: 台帳と指示文まで。どの会話でも同じなので、会話をまたいで効く
    - リクエスト全体（top-level の ``cache_control``）: 最後のブロックに自動で区切りが付く。会話は
      足すだけなので、同じ依頼の次の呼び出し・次の依頼で、前の往復までがキャッシュから読まれる

    指定しないもの: ``thinking``（Opus 5.5 は常に適応。無効にする指定は 400）、``tool_choice``
    （既定の auto。強制は、思考と一緒には使えず 400）、ツールの ``strict``（``load_tools``）。

    Args:
        messages: 会話。そのまま渡す（書き換えない・写しも作らない）。

    Returns:
        dict: ``client.beta.messages.create`` に渡すキーワード引数。
    """
    model = llm_settings.model()
    body = {
        "model": model,
        "max_tokens": MAX_TOKENS,
        "system": [{"type": "text", "text": SYSTEM_PROMPT, "cache_control": {"type": "ephemeral"}}],
        "tools": load_tools(),
        "messages": messages,
        "output_config": {"effort": EFFORT},
        "cache_control": {"type": "ephemeral"},
    }
    if not model.startswith("claude-haiku"):
        # 安全性の分類器が応答を断ったとき、サーバ側で別のモデルに回す（第2層・第3層と同じ。Haiku には無い）
        body["betas"] = ["server-side-fallback-2026-07-01"]
        body["fallbacks"] = "default"
    return body


def _plain(value):
    """SDK のオブジェクトを、JSON にできる値（dict・list・文字列・数）にする。

    - pydantic のモデル（SDK のブロック）は ``model_dump``。値の無い項目（None）は落とし、API での名前
      （``from_`` ではなく ``from``）で出す
    - dict は、そのまま（ツールの引数など。None の値も落とさない）
    - そのほかの属性を持つオブジェクト（テストの ``SimpleNamespace``）は、属性を dict にする（None は落とす）
    """
    if hasattr(value, "model_dump"):
        return value.model_dump(mode="json", exclude_none=True, by_alias=True)
    if isinstance(value, dict):
        return {str(key): _plain(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_plain(item) for item in value]
    if hasattr(value, "__dict__"):
        return {key: _plain(item) for key, item in vars(value).items() if item is not None}
    return value


def _echoable(blocks):
    """別のモデルに回された応答（``fallback`` のブロックを含むもの）を、送り返せる形にする。

    ふつうの応答は、そのまま返す。``fallback`` のブロックは、断ったモデルの出力と、代わりのモデルの出力の
    境目に置かれる。送り返すときの決まり（Anthropic の手引き）:

    - 最後の ``fallback`` のブロックより前に在る、思考のブロックと ``tool_use`` は送らない
      （断ったモデルのもの。ここでは、文と ``fallback`` のブロックだけを残す）
    - ``fallback`` のブロックは、元の位置に残す（API が、前後の思考のブロックの検査に位置を使う）
    - 最後の ``fallback`` のブロックより後ろは、そのまま

    落とした ``tool_use`` は画面に届かないので、実行もされず、結果も送られない。
    """
    last = max((i for i, block in enumerate(blocks) if block.get("type") == "fallback"), default=None)
    if last is None:
        return blocks
    return [block for i, block in enumerate(blocks) if i >= last or block.get("type") in ("text", "fallback")]


def response_content(response):
    """応答の ``content`` を、次のリクエストにそのまま送り返せる dict のリストにする。

    思考のブロックは ``signature`` ごと残す（落とすと、次の呼び出しが通らない）。``tool_use`` の
    ``input`` は、入れ子のまま残す。

    Args:
        response: ``client.beta.messages.create`` の応答。

    Returns:
        list[dict]: ブロックのリスト。画面は、変えずに assistant のメッセージとして会話に足す。
    """
    blocks = [_plain(block) for block in getattr(response, "content", None) or []]
    return _echoable([block for block in blocks if isinstance(block, dict)])


def _blocked_message(today):
    """1 日の上限に達しているときの理由を返す（達していなければ None）。上限は第2層・第3層と同じ 1 つの枠。"""
    if not today["blocked"]:
        return None
    calls, limit_calls = today["calls"], today["limit_calls"]
    if limit_calls is not None and calls >= limit_calls:
        return (f"今日は Claude を {calls} 回使いました（再現ガイド・差分コーチ・アシスタントの合計。"
                f"アシスタントは、依頼 1 つを 1 回と数えます）。1 日の上限（{limit_calls} 回）に達したので、"
                "アシスタントは Claude を呼びません。明日になるとまた使えます。上限は設定で変えられます")
    return (f"今日の Claude の費用が概算で ${today['cost_usd']:.2f} になりました"
            f"（再現ガイド・差分コーチ・アシスタントの合計）。1 日の上限（${today['limit_usd']:.2f}）に達したので、"
            "アシスタントは Claude を呼びません。明日になるとまた使えます。上限は設定で変えられます")


def _result(response, request):
    """Claude の応答（メッセージ 1 つ）を、画面に返す形にする。``_call`` と ``_stream`` の共通部分。

    Args:
        response: ``create`` の応答、または ``stream`` が最後まで組み立てたメッセージ。
        request: 送ったリクエスト（応答にモデルが無いときの代わりに使う）。

    Returns:
        dict: ``{"content", "stop_reason", "model", "usage"}``。

    Raises:
        GuideError: モデルが応答を断った（``refused``）、想定していない終わり方をした（``api``）。
            どちらも、``usage`` に使用量が入る（応答は返ってきているので、費用はかかっている）。
    """
    usage = _usage(response)
    model = getattr(response, "model", None) or request["model"]
    stop_reason = getattr(response, "stop_reason", None)
    if stop_reason == "refusal":
        raise GuideError("この依頼には、モデルが応答を返しませんでした。言い方を変えて、もう一度試してください",
                         code="refused", usage=usage, model=model)
    if stop_reason not in _STOP_REASONS:
        raise GuideError(f"Claude が、想定していない形で応答を終えました（{stop_reason}）。もう一度試してください",
                         code="api", usage=usage, model=model)
    return {"content": response_content(response), "stop_reason": stop_reason, "model": model, "usage": usage}


def _call(request, client):
    """Claude を 1 回呼び、応答を画面に返す形にする（上限の確かめ・記録はしない）。

    Raises:
        GuideError: API キーが無い・正しくない、通信できない、モデルが応答を断った、想定していない
            終わり方をした、などの場合。応答が返ってきていた失敗では、``usage`` に使用量が入る。
    """
    with _api_errors():
        if client is None:
            client = llm_settings.make_client()
        response = client.beta.messages.create(**request)
    return _result(response, request)


def _prepare(messages, turn_id, step):
    """呼び出しの前の確かめと、リクエスト・記録の項目の組み立て。``step`` と ``stream_step`` の共通部分。

    順番は、引数と会話の形 → 1 日の上限（依頼の最初の呼び出しだけ）→ リクエストの組み立て。
    ここまでは Claude を呼ばないので、ここで断ったものは使用量の記録に残さない。

    Returns:
        tuple[dict, dict]: リクエスト（``build_request`` の形）と、使用量の記録に毎回入れる項目。

    Raises:
        GuideError: 引数・会話の形が正しくない（``invalid``）、会話が大きすぎる（``too_long``）、
            1 日の上限（``daily_limit``）。
    """
    import guide_usage

    if not isinstance(turn_id, str) or not _TURN_ID_RE.fullmatch(turn_id):
        raise GuideError("turn_id は、英数字とハイフンで 1〜64 文字にしてください", code="invalid")
    if isinstance(step, bool) or not isinstance(step, int) or step < 0:
        raise GuideError("step は 0 以上の整数で指定してください", code="invalid")
    if step >= MAX_STEPS:
        raise GuideError(
            f"1 回の依頼で Claude を呼べるのは {MAX_STEPS} 回までです。ここまでの結果を確かめて、続きを頼み直してください",
            code="invalid")
    validate_messages(messages)

    if step == 0:
        blocked = _blocked_message(guide_usage.today())
        if blocked:
            raise GuideError(blocked, code="daily_limit")

    request = build_request(messages)
    log = {"feature": "assistant", "requested_model": request["model"], "effort": EFFORT, "focus": None,
           "chart": None, "cache_ttl": CACHE_TTL, "version": ASSISTANT_VERSION, "turn": turn_id, "step": step}
    return request, log


def _record_failure(log, started, code, model, usage):
    """失敗した呼び出しを、使用量の記録に 1 行残す（``usage`` は、応答が返らなかった失敗なら None）。"""
    import guide_usage

    guide_usage.record_call(ok=False, error=code, model=model, usage=usage,
                            duration_sec=time.monotonic() - started, **log)


def _record_success(log, started, result):
    """成功した呼び出しを、使用量の記録に 1 行残し、概算の費用を足した結果を返す。"""
    import guide_usage

    record = guide_usage.record_call(ok=True, model=result["model"], usage=result["usage"],
                                     duration_sec=time.monotonic() - started, **log)
    return {**result, "cost_usd": record["cost_usd"]}


def step(messages, turn_id, step, client=None):
    """会話を Claude に 1 回だけ送り、応答を返す。会話の状態は持たない。

    画面が、応答の ``stop_reason`` を見て続きを決める。``tool_use`` なら、画面がツールを実行し、結果を
    ``tool_result`` にして会話に足し、``step`` を 1 つ進めてもう一度呼ぶ。``end_turn`` なら終わり。

    順番（第3層の ``coach_explain.explain_for`` と同じ）:

    1. 引数と会話の形を確かめる
    2. 依頼の最初の呼び出し（``step`` が 0）のときだけ、1 日の上限に達していたら断る。
       続きの呼び出しでは断らない（ツールで変えかけたまま止まらないように）
    3. Claude を呼び、使用量を記録する（応答が返ってきた失敗・返らなかった失敗も記録する）

    ジョブ（``?async=1``）にはしない。1 回の呼び出しは短く、繰り返しを回すのは画面なので。

    Args:
        messages: 会話（Messages API の ``messages`` そのまま）。書き換えない。
        turn_id: この依頼の識別子（英数字とハイフン、1〜64 文字）。使用量の記録で、同じ依頼の呼び出しを束ねる。
        step: この依頼の何回目の呼び出しか（0 から。``MAX_STEPS`` 未満）。
        client: Anthropic のクライアント。None なら ``llm_settings.make_client()`` で作る（テストでは差し替える）。

    Returns:
        dict: ``{"content", "stop_reason", "model", "usage", "cost_usd"}``。``content`` は、そのまま
        assistant のメッセージとして会話に足せるブロックのリスト。``stop_reason`` は ``"end_turn"``
        ``"tool_use"`` ``"max_tokens"``。``cost_usd`` は概算（単価の表に無いモデルなら None）。

    Raises:
        GuideError: 引数・会話の形が正しくない（``invalid``）、会話が大きすぎる（``too_long``）、1 日の上限
            （``daily_limit``）、API キーが無い・正しくない（``no_key`` ``auth``）、利用制限（``rate_limit``）、
            通信できない（``network``）、モデルが応答を断った（``refused``）、そのほかの失敗（``api``）。
            メッセージは利用者にそのまま見せられる。
    """
    request, log = _prepare(messages, turn_id, step)
    started = time.monotonic()
    try:
        result = _call(request, client)
    except GuideError as e:
        _record_failure(log, started, e.code, e.model or request["model"], e.usage)
        raise
    return _record_success(log, started, result)


def _snapshot(stream):
    """ストリームがここまでに組み立てたメッセージを返す（まだ何も届いていなければ None）。"""
    try:
        return stream.current_message_snapshot
    except Exception:
        # SDK は、最初のイベント（message_start）が届く前だと assert で落ちる
        return None


def _so_far(stream, request):
    """途中で終わった呼び出しの、ここまでの使用量とモデルを返す（使用量の記録に使う）。

    入力のぶん（最初のイベントに載る）は分かる。出力のぶんは最後のイベントで確定するので、途中までだと
    実際より少ない。まだ何も届いていなければ、使用量は None（応答が返らなかった失敗と同じ扱い）。

    Returns:
        tuple[dict | None, str]: 使用量と、モデル。
    """
    snapshot = _snapshot(stream)
    if snapshot is None:
        return None, request["model"]
    return _usage(snapshot), getattr(snapshot, "model", None) or request["model"]


def _stream(messages, turn_id, step, client):
    """``stream_step`` の中身（ジェネレータ）。最初に None を 1 つ出してから、イベントを出す。

    最初の None は「Claude への接続を開いた」の合図で、``stream_step`` が受け取って捨てる。ここまでの失敗
    （引数・上限・キー・接続）は、その ``next()`` から例外として出る。合図を出した後は ``try`` の中に居るので、
    1 行も読まれずに捨てられても（画面がすぐ切った）、ストリームを閉じて記録を残せる。
    """
    import anthropic
    # anthropic の SDK が通信に使っている層。応答の途中の通信の失敗は、SDK の例外に包まれずにそのまま出てくる。
    # SDK の間接の依存なので（pyproject.toml には書いていない）、SDK の版で名前が違っても動くようにする
    try:
        import httpx2 as transport
    except ImportError:
        import httpx as transport

    request, log = _prepare(messages, turn_id, step)
    started = time.monotonic()
    try:
        with _api_errors():
            if client is None:
                client = llm_settings.make_client()
            manager = client.beta.messages.stream(**request)
            # ここでリクエストが送られ、応答のヘッダまでが届く（キーの誤り・利用制限・接続の失敗は、ここで分かる）
            stream = manager.__enter__()
    except GuideError as e:
        _record_failure(log, started, e.code, e.model or request["model"], e.usage)
        raise

    recorded = False
    try:
        yield None
        try:
            with _api_errors():
                try:
                    for event in stream:
                        kind = getattr(event, "type", None)
                        if kind == "text":
                            yield {"type": "text", "text": event.text}
                        elif kind == "content_block_start" and getattr(event.content_block, "type", None) == "tool_use":
                            yield {"type": "tool", "name": event.content_block.name}
                    message = stream.get_final_message()
                except anthropic.APIStatusError as e:
                    if e.status_code >= 400:
                        raise
                    # 流れている途中で届いたエラー（混雑など）。HTTP の番号は、開いたときの 200 のままなので、文に出さない
                    raise GuideError("Claude が、応答の途中でエラーを返しました。少し待ってから、もう一度試してください",
                                     code="api")
                except transport.TransportError:
                    raise GuideError("Claude からの応答が途中で途切れました。ネットワークを確認して、もう一度試してください",
                                     code="network")
                except (ValueError, AssertionError):
                    # SDK は、解釈できない JSON（イベントの本文・ツールの引数）で ValueError を出す。
                    # 1 つもイベントが届かないまま終わった応答では、最後のメッセージが無く assert で落ちる
                    raise GuideError("応答を読み取れませんでした。もう一度試してください", code="api")
            result = _result(message, request)
        except GuideError as e:
            usage, model = (e.usage, e.model) if e.usage is not None else _so_far(stream, request)
            recorded = True
            _record_failure(log, started, e.code, model or request["model"], usage)
            yield {"type": "error", "detail": {"message": str(e), "code": e.code}}
            return
        recorded = True
        yield {"type": "done", **_record_success(log, started, result)}
    except GeneratorExit:
        # 画面が途中で切った（中止）。ここまでのぶんも費用はかかっているので、分かる範囲で残す
        if not recorded:
            usage, model = _so_far(stream, request)
            _record_failure(log, started, "cancelled", model, usage)
        raise
    except BaseException:
        # 想定していない失敗は、そのまま上げる（``step`` と同じ）。呼び出しは済んでいるので、記録は残す
        if not recorded:
            usage, model = _so_far(stream, request)
            _record_failure(log, started, "api", model, usage)
        raise
    finally:
        manager.__exit__(None, None, None)


def stream_step(messages, turn_id, step, client=None):
    """会話を Claude に 1 回だけ送り、応答を少しずつ返す（``step`` のストリーミング版）。

    確かめ・上限・使用量の記録の順番と中身は ``step`` と同じ。違いは、返し方だけ。

    - 呼び出しの前に分かる失敗（引数・会話の形・1 日の上限）と、Claude への接続を開いた時点で分かる失敗
      （キーが無い・正しくない、利用制限、接続できない）は、``step`` と同じく、この関数から例外として出す
      （画面には HTTP エラーとして返せる）。そのために、返す前にストリームを開く
    - 開いた後は、戻り値のイテレータがイベントを出す。途中の失敗は例外にせず、最後の ``error`` のイベントにする
    - 使用量の記録は、成功・失敗・中止のどれでも、1 回の呼び出しにつき 1 行。イテレータが途中で閉じられた
      （``close()``。画面が切った）ときは、ストリームを閉じて ``error="cancelled"`` で残す

    リクエストは ``step`` と同じ（``build_request``）。思考のブロックの差分は出さない。
    ツール定義に ``eager_input_streaming`` は付けない（引数の差分は画面に出さないので得が無く、付けると引数の JSON をサーバ側で検証しなくなる）。

    Args:
        messages: 会話（``step`` と同じ）。
        turn_id: この依頼の識別子（``step`` と同じ）。
        step: この依頼の何回目の呼び出しか（``step`` と同じ）。
        client: Anthropic のクライアント。None なら ``llm_settings.make_client()`` で作る。

    Returns:
        Iterator[dict]: イベントを、届いた順に出すジェネレータ。読み終えるか ``close()`` すると、ストリームを閉じる。

        - ``{"type": "text", "text": 差分}`` — 見える文（text ブロック）の差分
        - ``{"type": "tool", "name": ツール名}`` — ``tool_use`` のブロックが始まった（1 ブロックにつき 1 回）
        - ``{"type": "done", "content", "stop_reason", "model", "usage", "cost_usd"}`` — 最後。``step`` の戻り値と同じ項目
        - ``{"type": "error", "detail": {"message", "code"}}`` — 開いた後の失敗（最後）。``code`` は ``refused``
          ``network`` ``api`` など（``GuideError.code``）

    Raises:
        GuideError: 開く前・開いた時点の失敗（``invalid`` ``too_long`` ``daily_limit`` ``no_key`` ``auth``
            ``rate_limit`` ``network`` ``api``）。
    """
    events = _stream(messages, turn_id, step, client)
    next(events)
    return events
