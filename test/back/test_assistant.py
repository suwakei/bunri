"""アプリの中のアシスタント（assistant）のテスト

Claude は呼ばず、クライアントを差し替えて確かめる（再現ガイド・差分コーチのテストと同じやり方）。

- リクエストの形: ツールは台帳の順で、Claude に渡さない項目を含まない。指示文とツールは毎回同じバイト列。
  キャッシュの区切り、思考の深さ、別のモデルへの回し方。会話は受け取ったまま渡す
- 応答の写し: 文・思考（署名つき）・ツールの呼び出しが、そのまま送り返せる dict になる
- 確かめ: 会話の形、依頼の識別子、何回目の呼び出しか、大きすぎる会話
- 費用: 上限で断るのは依頼の最初の呼び出しだけ。回数は依頼の数で数える。記録に中身とキーが入らない
- 台帳の健全性
"""
import copy
import gc
import inspect
import json
import re
from types import SimpleNamespace

import anthropic
import httpx2
import pytest
from httpx import ASGITransport, AsyncClient

import assistant
import guide_usage
import llm_settings
import reproduction_guide as rg

USAGE = {"input_tokens": 900, "output_tokens": 300, "cache_read_input_tokens": 2500,
         "cache_creation_input_tokens": 0, "thinking_tokens": 120}


def _user(text):
    return {"role": "user", "content": [{"type": "text", "text": text}]}


def _conversation():
    """ツールを 1 回使ったあとの会話（依頼 → 思考つきの応答 → ツールの結果）"""
    return [
        _user("ひみつのベースラインを 4 小節ぶん置いて"),
        {"role": "assistant", "content": [
            {"type": "thinking", "thinking": "", "signature": "c2lnbmF0dXJl"},
            {"type": "tool_use", "id": "toolu_01", "name": "get_project", "input": {}},
        ]},
        {"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": "toolu_01",
             "content": json.dumps({"ok": True, "summary": "プロジェクトの様子を読みました", "bpm": 120}, ensure_ascii=False)},
        ]},
    ]


def _tool_use_content():
    """ツールを呼ぶ応答の content（思考 → 文 → ツールの呼び出し。引数は入れ子）"""
    return [
        SimpleNamespace(type="thinking", thinking="", signature="c2lnLXRvb2w="),
        SimpleNamespace(type="text", text="ベースを置きます。", citations=None),
        SimpleNamespace(type="tool_use", id="toolu_02", name="add_notes", caller=None,
                        input={"track_id": 3, "notes": [{"pitch": "C2", "step": 0, "length": 4},
                                                        {"pitch": "G2", "step": 8, "length": 4, "velocity": 100}]}),
    ]


def _stream_events(content, stop_reason):
    """応答の content を、SDK のストリームが出すイベントの並びにする（使っている項目だけ）。

    SDK は、届いたままのイベント（``content_block_delta`` など）のほかに、まとめ直したイベント
    （文の差分の ``text``、思考の差分の ``thinking``、ツールの引数の ``input_json``）も出す。文は 2 つに分ける。
    """
    events = [SimpleNamespace(type="message_start")]
    for index, block in enumerate(content):
        events.append(SimpleNamespace(type="content_block_start", index=index, content_block=block))
        if block.type == "thinking":
            delta = SimpleNamespace(type="thinking_delta", thinking="ひみつの考え")
            events.append(SimpleNamespace(type="content_block_delta", index=index, delta=delta))
            events.append(SimpleNamespace(type="thinking", thinking="ひみつの考え", snapshot="ひみつの考え"))
        elif block.type == "text":
            half = len(block.text) // 2
            for part in (block.text[:half], block.text[half:]):
                delta = SimpleNamespace(type="text_delta", text=part)
                events.append(SimpleNamespace(type="content_block_delta", index=index, delta=delta))
                events.append(SimpleNamespace(type="text", text=part, snapshot=block.text))
        elif block.type == "tool_use":
            partial = json.dumps(block.input)
            delta = SimpleNamespace(type="input_json_delta", partial_json=partial)
            events.append(SimpleNamespace(type="content_block_delta", index=index, delta=delta))
            events.append(SimpleNamespace(type="input_json", partial_json=partial, snapshot=block.input))
        events.append(SimpleNamespace(type="content_block_stop", index=index, content_block=block))
    events.append(SimpleNamespace(type="message_delta", delta=SimpleNamespace(stop_reason=stop_reason)))
    events.append(SimpleNamespace(type="message_stop"))
    return events


class FakeStream:
    """差し替え用のストリーム（SDK の ``BetaMessageStream`` の、使っている部分だけ）。

    ``broken`` が ``(何番目のイベントの前か, 例外)`` なら、そこで例外を出す（途中の失敗）。
    """

    def __init__(self, events, message, broken=None):
        self._events = events
        self._message = message
        self._broken = broken
        self._started = False
        self.closed = 0

    def __iter__(self):
        for index, event in enumerate(self._events):
            if self._broken is not None and self._broken[0] == index:
                raise self._broken[1]
            self._started = True
            yield event
        if self._broken is not None and self._broken[0] >= len(self._events):
            raise self._broken[1]

    @property
    def current_message_snapshot(self):
        # SDK と同じく、最初のイベントが届く前は assert で落ちる
        assert self._started
        return self._message

    def get_final_message(self):
        assert self._started
        return self._message


class FakeClient:
    """差し替え用のクライアント。``calls`` が、Claude を呼んだ回数（= 費用がかかった回数）になる

    ``create``（まとめて返す）と ``stream``（少しずつ返す）の両方を持つ。``error`` は、どちらでも呼び出しの
    時点（ストリームでは、接続を開く ``__enter__``）で出す。``broken`` は、ストリームの途中で出す失敗。
    ``streams`` に、開いたストリームが入る（``closed`` が、閉じられた回数）。
    """

    def __init__(self, content=None, stop_reason="end_turn", error=None, response=None, broken=None):
        self.calls = []
        self.streams = []
        self._content = content if content is not None else [SimpleNamespace(type="text", text="置きました。")]
        self._stop_reason = stop_reason
        self._error = error
        self._response = response
        self._broken = broken
        self.beta = SimpleNamespace(messages=SimpleNamespace(create=self._create, stream=self._stream))

    def _stream(self, **kwargs):
        client = self

        class Manager:
            """``client.beta.messages.stream()`` が返すもの。``__enter__`` で、初めてリクエストを送る"""

            def __enter__(self):
                client.calls.append(kwargs)
                if client._error is not None:
                    raise client._error
                message = client._response if client._response is not None else client._message()
                self.stream = FakeStream(_stream_events(message.content, message.stop_reason), message, client._broken)
                client.streams.append(self.stream)
                return self.stream

            def __exit__(self, exc_type, exc, tb):
                self.stream.closed += 1

        return Manager()

    def _create(self, **kwargs):
        self.calls.append(kwargs)
        if self._error is not None:
            raise self._error
        if self._response is not None:
            return self._response
        return self._message()

    def _message(self):
        return SimpleNamespace(
            stop_reason=self._stop_reason,
            content=self._content,
            model="claude-opus-5-5",
            usage=SimpleNamespace(input_tokens=USAGE["input_tokens"], output_tokens=USAGE["output_tokens"],
                                  cache_read_input_tokens=USAGE["cache_read_input_tokens"],
                                  cache_creation_input_tokens=USAGE["cache_creation_input_tokens"],
                                  output_tokens_details=SimpleNamespace(thinking_tokens=USAGE["thinking_tokens"])),
        )


def _api_error(cls, status):
    """SDK の例外を作る"""
    request = httpx2.Request("POST", "https://api.anthropic.com/v1/messages")
    return cls("error", response=httpx2.Response(status, request=request), body=None)


def _sdk_message(content, stop_reason="tool_use", model="claude-opus-5-5"):
    """SDK の本物の型（pydantic）で応答を作る（API は呼ばない）"""
    from anthropic.types.beta import BetaMessage

    return BetaMessage.model_validate({
        "id": "msg_01", "type": "message", "role": "assistant", "model": model, "stop_reason": stop_reason,
        "stop_sequence": None, "content": content,
        "usage": {"input_tokens": 900, "output_tokens": 300, "cache_read_input_tokens": 2500,
                  "cache_creation_input_tokens": 0},
    })


@pytest.fixture(autouse=True)
def data_dir(monkeypatch, tmp_path):
    """保存先（使用量の記録・設定）を、テストごとの一時ディレクトリにする"""
    monkeypatch.setenv("BUNRI_DATA_DIR", str(tmp_path))
    monkeypatch.delenv("BUNRI_GUIDE_MODEL", raising=False)
    return tmp_path


class TestLedger:
    """ツールの台帳（assistant_tools.json）の健全性"""

    def test_名前が重ならず_Claudeが受ける形の名前になっている(self):
        names = [tool["name"] for tool in assistant.load_ledger()]
        assert len(names) == len(set(names)) and len(names) >= 10
        assert all(re.fullmatch(r"[a-zA-Z0-9_-]{1,64}", name) for name in names)

    def test_読むか変えるかと_画面に出す名前と_説明を持つ(self):
        ledger = assistant.load_ledger()
        for tool in ledger:
            assert set(tool) == {"name", "access", "label", "description", "input_schema"}, tool["name"]
            assert tool["access"] in ("read", "write"), tool["name"]
            assert isinstance(tool["label"], str) and tool["label"].strip(), tool["name"]
            assert isinstance(tool["description"], str) and tool["description"].strip(), tool["name"]
        assert {tool["access"] for tool in ledger} == {"read", "write"}

    def test_引数の形は_余分な項目を受けないオブジェクト(self):
        def check(schema, where):
            """オブジェクトの形を、入れ子まで確かめる"""
            if schema.get("type") == "object":
                assert schema.get("additionalProperties") is False, where
                assert isinstance(schema.get("properties"), dict), where
                assert set(schema.get("required", [])) <= set(schema["properties"]), where
                for name, child in schema["properties"].items():
                    check(child, f"{where}.{name}")
            if schema.get("type") == "array":
                check(schema["items"], f"{where}[]")

        for tool in assistant.load_ledger():
            assert tool["input_schema"]["type"] == "object", tool["name"]
            check(tool["input_schema"], tool["name"])

    def test_ノートの位置と長さと範囲は_小数を受ける(self):
        """ステップは 16 分音符の単位のまま、小数を受ける（32 分音符・三連・スウィング）"""
        tools = {tool["name"]: tool for tool in assistant.load_ledger()}
        for name in ("add_notes", "replace_notes"):
            item = tools[name]["input_schema"]["properties"]["notes"]["items"]["properties"]
            assert item["step"]["type"] == item["length"]["type"] == "number", name
            assert "0.5" in item["step"]["description"] and "triplet" in item["step"]["description"], name
        ranged = ("remove_notes", "replace_notes", "transpose_notes", "shift_notes", "quantize_notes", "repeat_notes",
                  "set_velocity")
        for name in ranged:
            properties = tools[name]["input_schema"]["properties"]
            assert properties["start_step"]["type"] == properties["end_step"]["type"] == "number", name
        assert tools["shift_notes"]["input_schema"]["properties"]["steps"]["type"] == "number"
        assert tools["repeat_notes"]["input_schema"]["properties"]["to_step"]["type"] == "number"
        # 数える項目（回数・半音・強さ・小節）は、整数のまま
        assert tools["repeat_notes"]["input_schema"]["properties"]["times"]["type"] == "integer"
        assert tools["transpose_notes"]["input_schema"]["properties"]["semitones"]["type"] == "integer"
        assert tools["get_notes"]["input_schema"]["properties"]["start_bar"]["type"] == "integer"

    def test_そろえる間隔に_16分と32分と三連が在る(self):
        quantize = next(tool for tool in assistant.load_ledger() if tool["name"] == "quantize_notes")
        grid = quantize["input_schema"]["properties"]["grid_steps"]
        # 三連の間隔（4/3、2/3）は整数で書けないので、決まった値の並び（enum）にはせず、説明に書く。確かめるのは画面側
        assert grid["type"] == "number" and "enum" not in grid
        for word in ("32nd", "16th", "triplet", "1.3333", "0.6667"):
            assert word in grid["description"], word
            assert word in quantize["description"], word
        assert "no 16th grid" not in quantize["description"]

    def test_指示文に_小数のステップの説明が在る(self):
        prompt = assistant.SYSTEM_PROMPT
        assert "one step is a 16th note" in prompt
        for word in ("decimals", "32nd", "triplet", "1.3333", "1/60"):
            assert word in prompt, word


class TestBuildRequest:
    def test_ツールは台帳の順で_Claudeに渡さない項目を含まない(self):
        request = assistant.build_request(_conversation())
        ledger = assistant.load_ledger()
        assert [tool["name"] for tool in request["tools"]] == [tool["name"] for tool in ledger]
        for tool, source in zip(request["tools"], ledger):
            assert list(tool) == ["name", "description", "input_schema"]
            assert tool["description"] == source["description"] and tool["input_schema"] == source["input_schema"]
        sent = json.dumps(request["tools"], ensure_ascii=False)
        for hidden in ('"access"', '"label"', '"_comment"', '"strict"', "プロジェクトの様子を見る"):
            assert hidden not in sent

    def test_指示文の末尾と_リクエスト全体に_キャッシュの区切りを置く(self):
        request = assistant.build_request(_conversation())
        assert request["system"] == [{"type": "text", "text": assistant.SYSTEM_PROMPT,
                                      "cache_control": {"type": "ephemeral"}}]
        assert request["cache_control"] == {"type": "ephemeral"}

    def test_モデルと思考の深さと_応答の上限(self):
        request = assistant.build_request(_conversation())
        assert request["model"] == "claude-opus-5-5" == llm_settings.model()
        assert request["max_tokens"] == assistant.MAX_TOKENS == 16000
        assert request["output_config"] == {"effort": "medium"}

    def test_思考の指定も_ツールの強制も_引数を縛る指定も付けない(self):
        request = assistant.build_request(_conversation())
        assert "thinking" not in request and "tool_choice" not in request
        assert all("strict" not in tool for tool in request["tools"])
        assert "format" not in request["output_config"]

    def test_断られたら別のモデルに回す指定を付ける_Haikuには付けない(self, monkeypatch):
        request = assistant.build_request(_conversation())
        assert request["betas"] == ["server-side-fallback-2026-07-01"] and request["fallbacks"] == "default"
        monkeypatch.setenv("BUNRI_GUIDE_MODEL", "claude-haiku-5-5")
        haiku = assistant.build_request(_conversation())
        assert haiku["model"] == "claude-haiku-5-5" and "betas" not in haiku and "fallbacks" not in haiku

    def test_会話は_受け取ったまま渡す(self):
        messages = _conversation()
        before = copy.deepcopy(messages)
        request = assistant.build_request(messages)
        assert request["messages"] is messages and messages == before
        # 思考のブロックは、署名ごとそのまま（区切りを書き足したりしない）
        assert request["messages"][1]["content"][0] == {"type": "thinking", "thinking": "", "signature": "c2lnbmF0dXJl"}
        assert "cache_control" not in json.dumps(request["messages"])

    def test_ツールと指示文は_毎回同じバイト列になる(self):
        first = assistant.build_request(_conversation())
        second = assistant.build_request([_user("テンポを 90 にして")])

        def prefix(request):
            return json.dumps([request["tools"], request["system"]], ensure_ascii=False).encode("utf-8")

        assert prefix(first) == prefix(second)
        assert json.dumps(assistant.load_tools()).encode() == json.dumps(assistant.load_tools()).encode()

    def test_指示文に_日付や時刻らしきものが無い(self):
        prompt = assistant.SYSTEM_PROMPT
        assert not re.search(r"(19|20)\d\d", prompt)
        assert not re.search(r"\d{1,2}:\d{2}", prompt)
        assert not re.search(r"\d+\s*[年月日]", prompt)
        assert prompt.startswith("You are the assistant built into bunri") and prompt.endswith("before relying on them.")
        assert "{" not in prompt

    def test_リクエストの引数は_入っているSDKが受ける名前だけ(self):
        """引数の名前を推測で書いていないことを、SDK の署名で確かめる（API は呼ばない）"""
        from anthropic.resources.beta.messages import Messages

        accepted = set(inspect.signature(Messages.create).parameters)
        assert set(assistant.build_request(_conversation())) <= accepted
        assert {"cache_control", "fallbacks", "betas", "output_config", "tools"} <= accepted

    def test_本物のSDKを通しても_同じ形で送られ_応答を写せる(self):
        """SDK が組み立てる本文を、通信の手前（差し替えた transport）で受けて確かめる。Claude は呼ばない"""
        seen = {}

        def handler(request):
            seen["beta"] = request.headers.get("anthropic-beta")
            seen["body"] = json.loads(request.content)
            return httpx2.Response(200, json={
                "id": "msg_01", "type": "message", "role": "assistant", "model": "claude-opus-5-5",
                "stop_reason": "tool_use", "stop_sequence": None,
                "content": [{"type": "thinking", "thinking": "", "signature": "c2lnLXNkaw=="},
                            {"type": "tool_use", "id": "toolu_09", "name": "get_project", "input": {},
                             "caller": {"type": "direct"}}],
                "usage": {"input_tokens": 10, "output_tokens": 5, "cache_read_input_tokens": 0,
                          "cache_creation_input_tokens": 3000, "output_tokens_details": {"thinking_tokens": 2}},
            })

        client = anthropic.Anthropic(api_key="test-key-not-real", max_retries=0,
                                     http_client=httpx2.Client(transport=httpx2.MockTransport(handler)))
        messages = _conversation()
        result = assistant.step(messages, "turn-1", 1, client=client)

        body = seen["body"]
        assert seen["beta"] == "server-side-fallback-2026-07-01"
        assert body["cache_control"] == {"type": "ephemeral"} and body["fallbacks"] == "default"
        assert body["system"] == [{"type": "text", "text": assistant.SYSTEM_PROMPT, "cache_control": {"type": "ephemeral"}}]
        assert body["tools"] == assistant.load_tools() and body["messages"] == messages
        assert body["output_config"] == {"effort": "medium"} and body["max_tokens"] == 16000
        assert "thinking" not in body and "tool_choice" not in body and "betas" not in body
        assert result["content"][0] == {"type": "thinking", "thinking": "", "signature": "c2lnLXNkaw=="}
        assert {key: result["content"][1][key] for key in ("type", "id", "name", "input")} == {
            "type": "tool_use", "id": "toolu_09", "name": "get_project", "input": {}}
        assert result["usage"] == {"input_tokens": 10, "output_tokens": 5, "cache_read_input_tokens": 0,
                                   "cache_creation_input_tokens": 3000, "thinking_tokens": 2}


class TestResponseContent:
    def test_文_思考_ツールの呼び出しが_送り返せるdictになる(self):
        response = SimpleNamespace(content=_tool_use_content())
        content = assistant.response_content(response)
        assert content == [
            {"type": "thinking", "thinking": "", "signature": "c2lnLXRvb2w="},
            {"type": "text", "text": "ベースを置きます。"},
            {"type": "tool_use", "id": "toolu_02", "name": "add_notes",
             "input": {"track_id": 3, "notes": [{"pitch": "C2", "step": 0, "length": 4},
                                                {"pitch": "G2", "step": 8, "length": 4, "velocity": 100}]}},
        ]
        assert json.loads(json.dumps(content)) == content

    def test_SDKの型でも_同じ形になる(self):
        raw = [
            {"type": "thinking", "thinking": "", "signature": "c2lnLXNkaw=="},
            {"type": "redacted_thinking", "data": "b3BhcXVl"},
            {"type": "text", "text": "置きます。", "citations": None},
            # ツールの引数の中の null は、落とさない（引数は Claude が書いたまま返す）
            {"type": "tool_use", "id": "toolu_03", "name": "set_track_mix",
             "input": {"track_id": 2, "mute": True, "pan": None, "nested": {"a": [1, {"b": None}]}}},
        ]
        content = assistant.response_content(_sdk_message(raw))
        assert content[0] == raw[0] and content[1] == raw[1]
        assert content[2] == {"type": "text", "text": "置きます。"}
        assert content[3]["input"] == raw[3]["input"]
        assert {key: content[3][key] for key in ("type", "id", "name")} == {
            "type": "tool_use", "id": "toolu_03", "name": "set_track_mix"}
        assert json.loads(json.dumps(content)) == content

    def test_写した応答は_そのまま次の会話に足して送れる(self):
        client = FakeClient(content=_tool_use_content(), stop_reason="tool_use")
        messages = [_user("ベースを置いて")]
        result = assistant.step(messages, "turn-1", 0, client=client)
        messages.append({"role": "assistant", "content": result["content"]})
        messages.append({"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": "toolu_02", "content": '{"ok": true, "summary": "ノートを 2 個置きました"}'}]})
        assistant.step(messages, "turn-1", 1, client=client)
        sent = client.calls[1]["messages"]
        assert sent[1]["content"][0] == {"type": "thinking", "thinking": "", "signature": "c2lnLXRvb2w="}
        assert sent[1]["content"][2]["input"]["notes"][1] == {"pitch": "G2", "step": 8, "length": 4, "velocity": 100}

    def test_別のモデルに回された応答は_境目より前の思考とツールの呼び出しを落とす(self):
        fallback = {"type": "fallback", "from": {"model": "claude-opus-5-5"}, "to": {"model": "claude-opus-4-8"},
                    "trigger": {"type": "refusal"}}
        raw = [
            {"type": "thinking", "thinking": "", "signature": "YmVmb3Jl"},
            {"type": "text", "text": "途中まで。"},
            {"type": "tool_use", "id": "toolu_old", "name": "get_project", "input": {}},
            fallback,
            {"type": "thinking", "thinking": "", "signature": "YWZ0ZXI="},
            {"type": "text", "text": "続きです。"},
            {"type": "tool_use", "id": "toolu_new", "name": "get_notes", "input": {"track_id": 1}},
        ]
        content = assistant.response_content(_sdk_message(raw, model="claude-opus-4-8"))
        assert [block["type"] for block in content] == ["text", "fallback", "thinking", "text", "tool_use"]
        # 境目のブロックは、API での名前（from）のまま、元の位置に残す
        assert content[1]["type"] == "fallback" and content[1]["from"] == {"model": "claude-opus-5-5"}
        assert content[1]["to"] == {"model": "claude-opus-4-8"} and "from_" not in content[1]
        assert content[2]["signature"] == "YWZ0ZXI=" and content[4]["id"] == "toolu_new"
        assert "toolu_old" not in json.dumps(content)

    def test_応答の頭で回された場合は_境目のブロックを先頭に残すだけ(self):
        raw = [
            {"type": "fallback", "from": {"model": "claude-opus-5-5"}, "to": {"model": "claude-opus-4-8"},
             "trigger": {"type": "refusal"}},
            {"type": "thinking", "thinking": "", "signature": "YWZ0ZXI="},
            {"type": "text", "text": "置きました。"},
        ]
        content = assistant.response_content(_sdk_message(raw, stop_reason="end_turn"))
        assert [block["type"] for block in content] == ["fallback", "thinking", "text"]

    @pytest.mark.parametrize("stop_reason", ["end_turn", "tool_use", "max_tokens"])
    def test_ふつうの終わり方は_そのまま返す(self, stop_reason):
        client = FakeClient(content=_tool_use_content(), stop_reason=stop_reason)
        result = assistant.step([_user("ベースを置いて")], "turn-1", 0, client=client)
        assert set(result) == {"content", "stop_reason", "model", "usage", "cost_usd"}
        assert result["stop_reason"] == stop_reason and result["model"] == "claude-opus-5-5"
        assert result["usage"] == USAGE
        assert result["cost_usd"] == pytest.approx(guide_usage.estimate_cost("claude-opus-5-5", USAGE))
        assert [block["type"] for block in result["content"]] == ["thinking", "text", "tool_use"]

    def test_断られた応答は_失敗にする(self):
        with pytest.raises(rg.GuideError) as e:
            assistant.step([_user("ベースを置いて")], "turn-1", 0, client=FakeClient(stop_reason="refusal"))
        assert e.value.code == "refused" and str(e.value) and e.value.usage == USAGE

    @pytest.mark.parametrize("stop_reason", ["pause_turn", "stop_sequence", "model_context_window_exceeded", None])
    def test_想定していない終わり方は_失敗にする(self, stop_reason):
        with pytest.raises(rg.GuideError) as e:
            assistant.step([_user("ベースを置いて")], "turn-1", 0, client=FakeClient(stop_reason=stop_reason))
        assert e.value.code == "api" and e.value.usage == USAGE


class TestValidate:
    def test_ふつうの会話は通り_中身を変えない(self):
        messages = _conversation()
        before = copy.deepcopy(messages)
        assert assistant.validate_messages(messages) is None
        assert messages == before
        # content は、文字列でもよい
        assistant.validate_messages([{"role": "user", "content": "テンポを 90 にして"}])
        # 同じ役が続くのは止めない（失敗した依頼のあとの言い直し）
        assistant.validate_messages([_user("ベースを置いて"), _user("やっぱりドラムを置いて")])

    @pytest.mark.parametrize("messages", [
        None, "ベースを置いて", {}, [],
        ["ベースを置いて"],
        [{"role": "user"}],
        [{"content": "ベースを置いて"}],
        [{"role": "system", "content": "ベースを置いて"}],
        [{"role": "user", "content": ""}],
        [{"role": "user", "content": "   "}],
        [{"role": "user", "content": []}],
        [{"role": "user", "content": ["ベースを置いて"]}],
        [{"role": "user", "content": [{"text": "type が無い"}]}],
        [{"role": "user", "content": {"type": "text", "text": "リストでない"}}],
        # 最初と最後は user
        [{"role": "assistant", "content": "はい"}, {"role": "user", "content": "ベースを置いて"}],
        [{"role": "user", "content": "ベースを置いて"}, {"role": "assistant", "content": "はい"}],
    ])
    def test_形の正しくない会話は断る(self, messages):
        with pytest.raises(rg.GuideError) as e:
            assistant.validate_messages(messages)
        assert e.value.code == "invalid" and str(e.value)

    def test_件数は200まで(self):
        assistant.validate_messages([_user("a")] * assistant.MAX_MESSAGES)
        with pytest.raises(rg.GuideError) as e:
            assistant.validate_messages([_user("a")] * (assistant.MAX_MESSAGES + 1))
        assert e.value.code == "invalid" and "新しい会話" in str(e.value)
        assert assistant.MAX_MESSAGES == 200

    def test_大きすぎる会話は_Claudeを呼ばずに断る(self):
        client = FakeClient()
        messages = [_user("あ" * assistant.MAX_REQUEST_CHARS)]
        with pytest.raises(rg.GuideError) as e:
            assistant.step(messages, "turn-1", 0, client=client)
        assert e.value.code == "too_long" and "新しい会話" in str(e.value)
        assert client.calls == [] and guide_usage.read_records() == []
        assert assistant.MAX_REQUEST_CHARS == 600_000

    @pytest.mark.parametrize("turn_id", [None, "", 12, "a b", "ターン", "turn_1", "a/b", "x" * 65, ["turn-1"]])
    def test_依頼の識別子は_英数字とハイフンで64文字まで(self, turn_id):
        client = FakeClient()
        with pytest.raises(rg.GuideError) as e:
            assistant.step([_user("ベースを置いて")], turn_id, 0, client=client)
        assert e.value.code == "invalid" and client.calls == []

    def test_依頼の識別子の通る形(self):
        client = FakeClient()
        for turn_id in ("a", "turn-1", "0f8fad5b-d9cb-469f-a165-70867728950e", "X" * 64):
            assistant.step([_user("ベースを置いて")], turn_id, 0, client=client)
        assert len(client.calls) == 4

    @pytest.mark.parametrize("step", [None, -1, 12, 13, 1.0, "0", True, False])
    def test_何回目かは_0以上12未満の整数(self, step):
        client = FakeClient()
        with pytest.raises(rg.GuideError) as e:
            assistant.step([_user("ベースを置いて")], "turn-1", step, client=client)
        assert e.value.code == "invalid" and client.calls == [] and guide_usage.read_records() == []

    def test_最後の回までは呼べる(self):
        client = FakeClient()
        assistant.step([_user("ベースを置いて")], "turn-1", assistant.MAX_STEPS - 1, client=client)
        assert len(client.calls) == 1 and assistant.MAX_STEPS == 12


def _write(feature="guide", **overrides):
    """使用量の記録を 1 行書く（応答が返ってきた呼び出し）"""
    values = {"ok": True, "model": "claude-opus-5-5", "requested_model": "claude-opus-5-5", "effort": "low",
              "focus": None, "chart": None, "duration_sec": 1.0, "usage": USAGE, "feature": feature}
    values.update(overrides)
    return guide_usage.record_call(**values)


class TestBudget:
    """1 日の上限。回数は依頼の数で数え、断るのは依頼の最初の呼び出しだけ"""

    def test_上限に達していたら_依頼の最初の呼び出しは_呼ばずに断る(self):
        guide_usage.update_settings({"daily_limit_calls": 1})
        client = FakeClient(content=_tool_use_content(), stop_reason="tool_use")
        assistant.step([_user("ベースを置いて")], "turn-1", 0, client=client)
        with pytest.raises(rg.GuideError) as e:
            assistant.step([_user("ドラムも置いて")], "turn-2", 0, client=client)
        assert e.value.code == "daily_limit"
        assert "1 日の上限（1 回）に達したので" in str(e.value) and "アシスタント" in str(e.value)
        # 断った呼び出しは、Claude を呼ばず、記録にも残さない
        assert len(client.calls) == 1 and len(guide_usage.read_records()) == 1

    def test_上限に達していても_依頼の続きの呼び出しは通す(self):
        """ツールで変えかけたまま止まらないように"""
        guide_usage.update_settings({"daily_limit_calls": 1})
        client = FakeClient(content=_tool_use_content(), stop_reason="tool_use")
        assistant.step([_user("ベースを置いて")], "turn-1", 0, client=client)
        assert guide_usage.today()["blocked"]
        for step in (1, 2, 3):
            assistant.step(_conversation(), "turn-1", step, client=client)
        assert len(client.calls) == 4

    def test_費用の上限でも_依頼の最初の呼び出しだけ断る(self):
        client = FakeClient()
        assistant.step([_user("ベースを置いて")], "turn-1", 0, client=client)
        spent = guide_usage.today()["cost_usd"]
        assert spent > 0
        guide_usage.update_settings({"daily_limit_calls": None, "daily_limit_usd": spent})
        with pytest.raises(rg.GuideError) as e:
            assistant.step([_user("ドラムも置いて")], "turn-2", 0, client=client)
        assert e.value.code == "daily_limit" and "概算" in str(e.value) and "アシスタント" in str(e.value)
        assistant.step(_conversation(), "turn-1", 1, client=client)
        assert len(client.calls) == 2

    def test_回数は_依頼の数で数える_費用は全部の行を足す(self):
        for step in (0, 1, 2):
            _write("assistant", turn="turn-1", step=step, effort="medium")
        today = guide_usage.today()
        one = guide_usage.estimate_cost("claude-opus-5-5", USAGE)
        assert today["calls"] == 1
        assert today["cost_usd"] == pytest.approx(one * 3, abs=1e-4)
        _write("assistant", turn="turn-2", step=0, effort="medium")
        assert guide_usage.today()["calls"] == 2

    def test_ツールを何回も使う依頼でも_1回と数える(self):
        guide_usage.update_settings({"daily_limit_calls": 2})
        client = FakeClient(content=_tool_use_content(), stop_reason="tool_use")
        assistant.step([_user("ベースを置いて")], "turn-1", 0, client=client)
        for step in range(1, 6):
            assistant.step(_conversation(), "turn-1", step, client=client)
        assert guide_usage.today()["calls"] == 1 and guide_usage.today()["blocked"] is None
        # 2 つ目の依頼は、まだ始められる。3 つ目は断る
        assistant.step([_user("ドラムも置いて")], "turn-2", 0, client=client)
        with pytest.raises(rg.GuideError):
            assistant.step([_user("ピアノも置いて")], "turn-3", 0, client=client)
        assert len(client.calls) == 7

    def test_再現ガイドと差分コーチの数え方は変わらない(self):
        """呼び出し 1 回が 1 回。step や turn を持たない行、feature の無い古い行も、そのまま数える"""
        _write("guide")
        _write("guide", focus="S1")
        _write("coach")
        # 応答が返らなかった失敗は数えない
        _write("coach", ok=False, error="auth", usage=None)
        # feature の無い古い行（再現ガイドのもの）
        with open(guide_usage.log_path(), "a", encoding="utf-8") as f:
            old = {key: value for key, value in _write("guide").items() if key not in ("feature", "turn", "step")}
            f.write(json.dumps(old) + "\n")
        today = guide_usage.today()
        one = guide_usage.estimate_cost("claude-opus-5-5", USAGE)
        assert today["calls"] == 5 and today["cost_usd"] == pytest.approx(one * 5, abs=1e-4)
        # 同じ枠で数える: 再現ガイド・差分コーチの 5 回に、アシスタントの依頼 1 つ（3 回呼んだ）で 6 回
        for step in (0, 1, 2):
            _write("assistant", turn="turn-1", step=step)
        assert guide_usage.today()["calls"] == 6
        # step を持つ行でも、アシスタント以外は呼び出しの数で数える
        _write("guide", step=3)
        assert guide_usage.today()["calls"] == 7

    def test_アシスタント以外の記録は_turnとstepが空(self):
        record = _write("coach")
        assert record["turn"] is None and record["step"] is None and record["feature"] == "coach"
        assert set(record) == set(guide_usage._RECORD_FIELDS)

    def test_キャッシュの保持時間の集計には_アシスタントの呼び出しを入れない(self):
        assistant.step([_user("ベースを置いて")], "turn-1", 0, client=FakeClient())
        assert guide_usage.cache_report()["calls"] == 0


class TestUsageRecord:
    def test_依頼の識別子と何回目かと版を残す(self):
        client = FakeClient(content=_tool_use_content(), stop_reason="tool_use")
        assistant.step([_user("ベースを置いて")], "turn-abc", 0, client=client)
        assistant.step(_conversation(), "turn-abc", 1, client=client)
        first, second = guide_usage.read_records()
        assert (first["feature"], first["turn"], first["step"]) == ("assistant", "turn-abc", 0)
        assert (second["feature"], second["turn"], second["step"]) == ("assistant", "turn-abc", 1)
        assert first["version"] == assistant.ASSISTANT_VERSION == 4
        assert first["ok"] is True and first["error"] is None
        assert first["focus"] is None and first["chart"] is None
        assert first["effort"] == "medium" and first["cache_ttl"] == "5m"
        assert first["model"] == first["requested_model"] == "claude-opus-5-5"
        assert (first["input_tokens"], first["cache_read_input_tokens"], first["output_tokens"],
                first["thinking_tokens"]) == (900, 2500, 300, 120)
        assert first["cost_usd"] == pytest.approx(guide_usage.estimate_cost("claude-opus-5-5", USAGE))

    def test_記録に_会話もツールの引数もキーも入らない(self, monkeypatch):
        secret = "sk-ant-secret-key-value"
        monkeypatch.setenv("ANTHROPIC_API_KEY", secret)
        client = FakeClient(content=_tool_use_content(), stop_reason="tool_use")
        assistant.step(_conversation(), "turn-1", 1, client=client)
        text = guide_usage.log_path().read_text(encoding="utf-8")
        (record,) = guide_usage.read_records()
        assert set(record) == set(guide_usage._RECORD_FIELDS)
        strings = {key: value for key, value in record.items() if isinstance(value, str)}
        assert set(strings) == {"ts", "feature", "model", "requested_model", "effort", "cache_ttl", "turn"}
        assert all(len(value) <= 64 for value in strings.values())
        for leaked in (secret, "sk-ant", "ひみつ", "ベース", "add_notes", "toolu_", "C2", "c2ln", "プロジェクト"):
            assert leaked not in text

    def test_形の合わない識別子は_記録に書かない(self):
        """記録の側でも、決まった形の値だけを通す（文が紛れ込まないように）"""
        record = _write("assistant", turn="ひみつの文 そのまま", step="3")
        assert record["turn"] is None and record["step"] is None
        assert _write("assistant", turn="x" * 65, step=True)["turn"] is None
        assert _write("assistant", turn="turn-1", step=-1)["step"] is None

    def test_応答が返ってきた失敗も記録する(self):
        with pytest.raises(rg.GuideError):
            assistant.step([_user("ベースを置いて")], "turn-1", 0, client=FakeClient(stop_reason="refusal"))
        with pytest.raises(rg.GuideError):
            assistant.step([_user("ベースを置いて")], "turn-1", 1, client=FakeClient(stop_reason="pause_turn"))
        refused, paused = guide_usage.read_records()
        assert (refused["ok"], refused["error"], refused["turn"], refused["step"]) == (False, "refused", "turn-1", 0)
        assert (paused["ok"], paused["error"], paused["step"]) == (False, "api", 1)
        # 応答が返ってきているので、費用がかかっている。回数にも数える（依頼の最初の呼び出しのぶん）
        assert refused["input_tokens"] == 900 and refused["cost_usd"] > 0
        assert guide_usage.today()["calls"] == 1

    def test_応答が返らなかった失敗も記録するが_回数には数えない(self):
        error = _api_error(anthropic.AuthenticationError, 401)
        with pytest.raises(rg.GuideError):
            assistant.step([_user("ベースを置いて")], "turn-1", 0, client=FakeClient(error=error))
        (record,) = guide_usage.read_records()
        assert (record["feature"], record["ok"], record["error"], record["turn"]) == ("assistant", False, "auth", "turn-1")
        assert record["input_tokens"] is None and record["cost_usd"] is None
        assert guide_usage.today()["calls"] == 0


class TestErrors:
    """SDK の例外を、利用者に見せられる失敗に直す（再現ガイドと同じ変換）"""

    @pytest.mark.parametrize("error, code", [
        (_api_error(anthropic.AuthenticationError, 401), "auth"),
        (_api_error(anthropic.PermissionDeniedError, 403), "auth"),
        (_api_error(anthropic.RateLimitError, 429), "rate_limit"),
        (_api_error(anthropic.BadRequestError, 400), "api"),
        (_api_error(anthropic.InternalServerError, 500), "api"),
        (anthropic.APIConnectionError(request=httpx2.Request("POST", "https://api.anthropic.com/v1/messages")), "network"),
        (TypeError("Could not resolve authentication method. Expected one of api_key, auth_token"), "no_key"),
    ])
    def test_例外の変換(self, error, code):
        client = FakeClient(error=error)
        with pytest.raises(rg.GuideError) as e:
            assistant.step([_user("ベースを置いて")], "turn-1", 0, client=client)
        assert e.value.code == code and str(e.value) and len(client.calls) == 1
        assert "sk-" not in str(e.value)

    def test_関係のない例外は_そのまま上げる(self):
        with pytest.raises(TypeError):
            assistant.step([_user("ベースを置いて")], "turn-1", 0, client=FakeClient(error=TypeError("別の誤り")))

    def test_クライアントを渡さなければ_設定から作る(self, monkeypatch):
        fake = FakeClient()
        monkeypatch.setattr(llm_settings, "make_client", lambda: fake)
        assistant.step([_user("ベースを置いて")], "turn-1", 0)
        assert len(fake.calls) == 1


def _sse(events):
    """イベントの並びを、Anthropic の SSE の本文にする（偽の Claude サーバ fake-anthropic.mjs と同じ形）"""
    return "".join(f"event: {event['type']}\ndata: {json.dumps(event)}\n\n" for event in events).encode("utf-8")


def _sse_tool_use():
    """思考 → 文（差分 3 つ）→ ツールの呼び出し（引数は 2 つに分けて届く）で終わる応答の、SSE のイベント"""
    return [
        {"type": "message_start", "message": {
            "id": "msg_01", "type": "message", "role": "assistant", "model": "claude-opus-5-5", "content": [],
            "stop_reason": None, "stop_sequence": None,
            "usage": {"input_tokens": 10, "output_tokens": 1, "cache_read_input_tokens": 2500,
                      "cache_creation_input_tokens": 0}}},
        {"type": "ping"},
        {"type": "content_block_start", "index": 0,
         "content_block": {"type": "thinking", "thinking": "", "signature": ""}},
        {"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": "ひみつの考え"}},
        {"type": "content_block_delta", "index": 0, "delta": {"type": "signature_delta", "signature": "c2lnLXNzZQ=="}},
        {"type": "content_block_stop", "index": 0},
        {"type": "content_block_start", "index": 1, "content_block": {"type": "text", "text": ""}},
        {"type": "content_block_delta", "index": 1, "delta": {"type": "text_delta", "text": "ベース"}},
        {"type": "content_block_delta", "index": 1, "delta": {"type": "text_delta", "text": "を置き"}},
        {"type": "content_block_delta", "index": 1, "delta": {"type": "text_delta", "text": "ます。"}},
        {"type": "content_block_stop", "index": 1},
        {"type": "content_block_start", "index": 2,
         "content_block": {"type": "tool_use", "id": "toolu_09", "name": "add_notes", "input": {}}},
        {"type": "content_block_delta", "index": 2,
         "delta": {"type": "input_json_delta", "partial_json": '{"track_id": 3, "notes": [{"pitch": "C2",'}},
        {"type": "content_block_delta", "index": 2,
         "delta": {"type": "input_json_delta", "partial_json": ' "step": 0, "length": 4}]}'}},
        {"type": "content_block_stop", "index": 2},
        {"type": "message_delta", "delta": {"stop_reason": "tool_use", "stop_sequence": None},
         "usage": {"output_tokens": 300, "output_tokens_details": {"thinking_tokens": 120}}},
        {"type": "message_stop"},
    ]


def _sdk_client(handler):
    """本物の SDK のクライアント。通信の手前（差し替えた transport）で受けるので、Claude は呼ばない"""
    return anthropic.Anthropic(api_key="test-key-not-real", max_retries=0,
                               http_client=httpx2.Client(transport=httpx2.MockTransport(handler)))


def _sse_response(events):
    return httpx2.Response(200, headers={"content-type": "text/event-stream"}, content=_sse(events))


class TestStream:
    """応答を少しずつ返す経路（stream_step）。確かめ・上限・記録は step と同じで、返し方だけが違う"""

    def test_文の差分_ツールの始まり_最後の行の順に出す(self):
        client = FakeClient(content=_tool_use_content(), stop_reason="tool_use")
        events = list(assistant.stream_step([_user("ベースを置いて")], "turn-1", 0, client=client))
        assert [event["type"] for event in events] == ["text", "text", "tool", "done"]
        assert events[0] == {"type": "text", "text": "ベースを"} and events[1] == {"type": "text", "text": "置きます。"}
        assert events[2] == {"type": "tool", "name": "add_notes"}
        assert set(events[3]) == {"type", "content", "stop_reason", "model", "usage", "cost_usd"}
        # 思考の差分は流さない（最後の行の content には、署名ごと残る）
        assert "ひみつの考え" not in json.dumps(events[:3], ensure_ascii=False)
        assert events[3]["content"][0] == {"type": "thinking", "thinking": "", "signature": "c2lnLXRvb2w="}
        # 読み終えたら、ストリームを閉じている
        assert [stream.closed for stream in client.streams] == [1]

    def test_最後の行の中身は_まとめて返す経路と同じ(self):
        plain = assistant.step([_user("ベースを置いて")], "turn-1", 0,
                               client=FakeClient(content=_tool_use_content(), stop_reason="tool_use"))
        *_, done = assistant.stream_step([_user("ベースを置いて")], "turn-2", 0,
                                         client=FakeClient(content=_tool_use_content(), stop_reason="tool_use"))
        assert done == {"type": "done", **plain}
        assert done["usage"] == USAGE and done["stop_reason"] == "tool_use" and done["model"] == "claude-opus-5-5"
        assert done["cost_usd"] == pytest.approx(guide_usage.estimate_cost("claude-opus-5-5", USAGE))
        assert json.loads(json.dumps(done)) == done
        # 使用量の記録も、依頼の識別子のほかは同じ項目・同じ値
        first, second = guide_usage.read_records()
        ignore = ("ts", "turn", "duration_sec")
        assert {k: v for k, v in first.items() if k not in ignore} == {k: v for k, v in second.items() if k not in ignore}
        assert (second["feature"], second["turn"], second["step"], second["ok"]) == ("assistant", "turn-2", 0, True)

    def test_リクエストは_まとめて返す経路と同じ(self):
        """ツール定義に eager_input_streaming を付けない。thinking も指定しない"""
        client = FakeClient()
        messages = _conversation()
        list(assistant.stream_step(messages, "turn-1", 1, client=client))
        assert client.calls == [assistant.build_request(messages)]
        sent = client.calls[0]
        assert sent["messages"] is messages
        assert "thinking" not in sent and "stream" not in sent
        assert "eager_input_streaming" not in json.dumps(sent["tools"])

    def test_リクエストの引数は_入っているSDKのstreamが受ける名前だけ(self):
        from anthropic.resources.beta.messages import Messages

        accepted = set(inspect.signature(Messages.stream).parameters)
        assert set(assistant.build_request(_conversation())) <= accepted
        assert {"cache_control", "fallbacks", "betas", "output_config", "tools"} <= accepted

    def test_文だけの応答は_ツールの行を出さずに終わる(self):
        client = FakeClient()
        events = list(assistant.stream_step([_user("ベースを置いて")], "turn-1", 0, client=client))
        assert [event["type"] for event in events] == ["text", "text", "done"]
        assert "".join(event["text"] for event in events[:2]) == "置きました。"
        assert events[2]["stop_reason"] == "end_turn" and events[2]["content"] == [{"type": "text", "text": "置きました。"}]

    @pytest.mark.parametrize("turn_id, step, messages", [
        ("turn 1", 0, [_user("ベースを置いて")]),
        ("turn-1", assistant.MAX_STEPS, [_user("ベースを置いて")]),
        ("turn-1", 0, []),
    ])
    def test_呼び出しの前に分かる失敗は_返す前に例外で出す(self, turn_id, step, messages):
        """ジェネレータを回し始めるのを待たずに、stream_step そのものが失敗する（HTTP エラーにできる）"""
        client = FakeClient()
        with pytest.raises(rg.GuideError) as e:
            assistant.stream_step(messages, turn_id, step, client=client)
        assert e.value.code == "invalid" and client.calls == [] and guide_usage.read_records() == []

    def test_上限で断るのは_依頼の最初の呼び出しだけ(self):
        guide_usage.update_settings({"daily_limit_calls": 1})
        client = FakeClient(content=_tool_use_content(), stop_reason="tool_use")
        list(assistant.stream_step([_user("ベースを置いて")], "turn-1", 0, client=client))
        with pytest.raises(rg.GuideError) as e:
            assistant.stream_step([_user("ドラムも置いて")], "turn-2", 0, client=client)
        assert e.value.code == "daily_limit" and "アシスタント" in str(e.value)
        assert len(client.calls) == 1 and len(guide_usage.read_records()) == 1
        # 続きの呼び出しは通す（ツールで変えかけたまま止まらないように）
        events = list(assistant.stream_step(_conversation(), "turn-1", 1, client=client))
        assert events[-1]["type"] == "done" and len(client.calls) == 2
        assert guide_usage.today()["calls"] == 1

    @pytest.mark.parametrize("error, code", [
        (_api_error(anthropic.AuthenticationError, 401), "auth"),
        (_api_error(anthropic.RateLimitError, 429), "rate_limit"),
        (_api_error(anthropic.InternalServerError, 500), "api"),
        (anthropic.APIConnectionError(request=httpx2.Request("POST", "https://api.anthropic.com/v1/messages")), "network"),
        (TypeError("Could not resolve authentication method. Expected one of api_key, auth_token"), "no_key"),
    ])
    def test_接続を開いた時点の失敗は_返す前に例外で出す(self, error, code):
        client = FakeClient(error=error)
        with pytest.raises(rg.GuideError) as e:
            assistant.stream_step([_user("ベースを置いて")], "turn-1", 0, client=client)
        assert e.value.code == code and str(e.value) and "sk-" not in str(e.value)
        # 呼び出しは 1 回。応答が返らなかった失敗として記録する（回数には数えない）
        assert len(client.calls) == 1 and client.streams == []
        (record,) = guide_usage.read_records()
        assert (record["feature"], record["ok"], record["error"], record["turn"], record["step"]) == (
            "assistant", False, code, "turn-1", 0)
        assert record["input_tokens"] is None and record["cost_usd"] is None
        assert guide_usage.today()["calls"] == 0

    def test_開く時点の関係のない例外は_そのまま上げる(self):
        with pytest.raises(TypeError):
            assistant.stream_step([_user("ベースを置いて")], "turn-1", 0, client=FakeClient(error=TypeError("別の誤り")))

    @pytest.mark.parametrize("error, code, phrase", [
        (_api_error(anthropic.APIStatusError, 529), "api", "529"),
        (_api_error(anthropic.RateLimitError, 429), "rate_limit", "利用制限"),
        (httpx2.ReadError("connection reset"), "network", "途中で途切れました"),
        (httpx2.ReadTimeout("timed out"), "network", "途中で途切れました"),
        (ValueError("Unable to parse tool parameter JSON from model."), "api", "応答を読み取れませんでした。もう一度試してください"),
    ])
    def test_途中の失敗は_例外にせず_最後のerrorの行にする(self, error, code, phrase):
        # 文の差分を 1 つ出した後（8 番目のイベントの前）で失敗する
        client = FakeClient(content=_tool_use_content(), stop_reason="tool_use", broken=(8, error))
        events = list(assistant.stream_step([_user("ベースを置いて")], "turn-1", 0, client=client))
        assert [event["type"] for event in events] == ["text", "error"]
        assert set(events[1]) == {"type", "detail"} and set(events[1]["detail"]) == {"message", "code"}
        assert events[1]["detail"]["code"] == code and phrase in events[1]["detail"]["message"]
        assert "sk-" not in events[1]["detail"]["message"] and "connection reset" not in events[1]["detail"]["message"]
        assert client.streams[0].closed == 1
        # 記録は 1 行。ここまでに分かっている使用量を入れる（費用はかかっている）
        (record,) = guide_usage.read_records()
        assert (record["ok"], record["error"], record["turn"], record["step"]) == (False, code, "turn-1", 0)
        assert record["input_tokens"] == 900 and record["model"] == "claude-opus-5-5"
        assert guide_usage.today()["calls"] == 1

    def test_1つも届かないうちの失敗は_応答が返らなかった失敗として記録する(self):
        client = FakeClient(broken=(0, httpx2.ReadError("connection reset")))
        events = list(assistant.stream_step([_user("ベースを置いて")], "turn-1", 0, client=client))
        assert [event["type"] for event in events] == ["error"] and events[0]["detail"]["code"] == "network"
        (record,) = guide_usage.read_records()
        assert (record["ok"], record["error"]) == (False, "network")
        assert record["input_tokens"] is None and record["cost_usd"] is None
        assert guide_usage.today()["calls"] == 0 and client.streams[0].closed == 1

    @pytest.mark.parametrize("stop_reason, code", [
        ("refusal", "refused"), ("pause_turn", "api"), ("model_context_window_exceeded", "api"), (None, "api"),
    ])
    def test_断られた応答と_想定していない終わり方は_errorの行にする(self, stop_reason, code):
        """終わり方の扱いは、まとめて返す経路と同じ"""
        client = FakeClient(stop_reason=stop_reason)
        events = list(assistant.stream_step([_user("ベースを置いて")], "turn-1", 0, client=client))
        assert [event["type"] for event in events] == ["text", "text", "error"]
        with pytest.raises(rg.GuideError) as plain:
            assistant.step([_user("ベースを置いて")], "turn-2", 0, client=FakeClient(stop_reason=stop_reason))
        assert events[2]["detail"] == {"message": str(plain.value), "code": code}
        streamed, stepped = guide_usage.read_records()
        assert (streamed["ok"], streamed["error"], streamed["input_tokens"]) == (False, code, 900)
        assert (streamed["error"], streamed["cost_usd"]) == (stepped["error"], stepped["cost_usd"])
        assert client.streams[0].closed == 1

    def test_途中で閉じられたら_ストリームを閉じて_cancelledで記録する(self):
        client = FakeClient(content=_tool_use_content(), stop_reason="tool_use")
        events = assistant.stream_step([_user("ベースを置いて")], "turn-1", 0, client=client)
        assert next(events) == {"type": "text", "text": "ベースを"}
        assert client.streams[0].closed == 0 and guide_usage.read_records() == []
        events.close()
        assert client.streams[0].closed == 1
        (record,) = guide_usage.read_records()
        assert (record["feature"], record["ok"], record["error"], record["turn"], record["step"]) == (
            "assistant", False, "cancelled", "turn-1", 0)
        # ここまでの使用量が取れているので、費用にも回数にも入る
        assert record["input_tokens"] == 900 and record["cost_usd"] > 0 and record["model"] == "claude-opus-5-5"
        assert guide_usage.today()["calls"] == 1
        # 閉じた後は、何も出さない。記録も増えない
        assert list(events) == []
        events.close()
        assert len(guide_usage.read_records()) == 1 and client.streams[0].closed == 1

    def test_1行も読まれずに閉じられても_ストリームを閉じて記録する(self):
        """画面が、応答の本文を読み始める前に切った場合"""
        client = FakeClient(content=_tool_use_content(), stop_reason="tool_use")
        events = assistant.stream_step([_user("ベースを置いて")], "turn-1", 0, client=client)
        events.close()
        assert client.streams[0].closed == 1
        (record,) = guide_usage.read_records()
        assert (record["ok"], record["error"]) == (False, "cancelled")
        # まだ何も届いていないので、使用量は分からない
        assert record["input_tokens"] is None and guide_usage.today()["calls"] == 0

    def test_閉じずに捨てられても_ストリームを閉じて記録する(self):
        """StreamingResponse は、途中で切られたジェネレータを close() せずに手放す"""
        client = FakeClient(content=_tool_use_content(), stop_reason="tool_use")
        events = assistant.stream_step([_user("ベースを置いて")], "turn-1", 0, client=client)
        next(events)
        del events
        gc.collect()
        assert client.streams[0].closed == 1
        assert [record["error"] for record in guide_usage.read_records()] == ["cancelled"]

    def test_最後の行の後で閉じても_記録は成功の1行だけ(self):
        client = FakeClient()
        events = assistant.stream_step([_user("ベースを置いて")], "turn-1", 0, client=client)
        assert [event["type"] for event in (next(events), next(events), next(events))] == ["text", "text", "done"]
        events.close()
        (record,) = guide_usage.read_records()
        assert (record["ok"], record["error"]) == (True, None) and client.streams[0].closed == 1

    def test_想定していない例外は_そのまま上げるが_ストリームは閉じて記録する(self):
        client = FakeClient(content=_tool_use_content(), stop_reason="tool_use", broken=(8, RuntimeError("別の誤り")))
        events = assistant.stream_step([_user("ベースを置いて")], "turn-1", 0, client=client)
        assert next(events)["type"] == "text"
        with pytest.raises(RuntimeError):
            next(events)
        assert client.streams[0].closed == 1
        (record,) = guide_usage.read_records()
        assert (record["ok"], record["error"], record["input_tokens"]) == (False, "api", 900)

    def test_記録に_会話もツールの引数もキーも入らない(self, monkeypatch):
        secret = "sk-ant-secret-key-value"
        monkeypatch.setenv("ANTHROPIC_API_KEY", secret)
        client = FakeClient(content=_tool_use_content(), stop_reason="tool_use")
        list(assistant.stream_step(_conversation(), "turn-1", 1, client=client))
        events = assistant.stream_step(_conversation(), "turn-1", 2, client=client)
        next(events)
        events.close()
        text = guide_usage.log_path().read_text(encoding="utf-8")
        assert [set(record) for record in guide_usage.read_records()] == [set(guide_usage._RECORD_FIELDS)] * 2
        for leaked in (secret, "sk-ant", "ひみつ", "ベース", "add_notes", "toolu_", "C2", "c2ln", "プロジェクト"):
            assert leaked not in text

    def test_クライアントを渡さなければ_設定から作る(self, monkeypatch):
        fake = FakeClient()
        monkeypatch.setattr(llm_settings, "make_client", lambda: fake)
        assert [event["type"] for event in assistant.stream_step([_user("ベースを置いて")], "turn-1", 0)][-1] == "done"
        assert len(fake.calls) == 1


class TestStreamSdk:
    """本物の SDK に、SSE の本文を読ませる（通信の手前で差し替える。Claude は呼ばない）"""

    def test_SSEを読んで_行にする_本文にはstreamが付く(self):
        seen = {}

        def handler(request):
            seen["beta"] = request.headers.get("anthropic-beta")
            seen["body"] = json.loads(request.content)
            return _sse_response(_sse_tool_use())

        messages = _conversation()
        events = list(assistant.stream_step(messages, "turn-1", 1, client=_sdk_client(handler)))

        body = seen["body"]
        # 送る中身は、まとめて返す経路と同じ。SDK が stream: true を足すだけ
        assert body["stream"] is True and seen["beta"] == "server-side-fallback-2026-07-01"
        assert body["cache_control"] == {"type": "ephemeral"} and body["fallbacks"] == "default"
        assert body["system"] == [{"type": "text", "text": assistant.SYSTEM_PROMPT, "cache_control": {"type": "ephemeral"}}]
        assert body["tools"] == assistant.load_tools() and body["messages"] == messages
        assert body["output_config"] == {"effort": "medium"} and body["max_tokens"] == 16000
        assert "thinking" not in body and "tool_choice" not in body and "betas" not in body
        assert "eager_input_streaming" not in json.dumps(body["tools"])

        assert events[:4] == [
            {"type": "text", "text": "ベース"}, {"type": "text", "text": "を置き"}, {"type": "text", "text": "ます。"},
            {"type": "tool", "name": "add_notes"},
        ]
        assert len(events) == 5
        done = events[4]
        assert set(done) == {"type", "content", "stop_reason", "model", "usage", "cost_usd"}
        assert done["stop_reason"] == "tool_use" and done["model"] == "claude-opus-5-5"
        # 思考のブロックは、署名ごと残る。文は差分をつないだもの。ツールの引数は、分かれて届いた JSON を組み立てたもの
        assert done["content"][0] == {"type": "thinking", "thinking": "ひみつの考え", "signature": "c2lnLXNzZQ=="}
        assert done["content"][1] == {"type": "text", "text": "ベースを置きます。"}
        assert {key: done["content"][2][key] for key in ("type", "id", "name", "input")} == {
            "type": "tool_use", "id": "toolu_09", "name": "add_notes",
            "input": {"track_id": 3, "notes": [{"pitch": "C2", "step": 0, "length": 4}]}}
        # 入力のぶんは最初のイベント、出力のぶんは最後のイベントから
        assert done["usage"] == {"input_tokens": 10, "output_tokens": 300, "cache_read_input_tokens": 2500,
                                 "cache_creation_input_tokens": 0, "thinking_tokens": 120}
        assert json.loads(json.dumps(done)) == done
        (record,) = guide_usage.read_records()
        assert (record["ok"], record["step"], record["output_tokens"], record["thinking_tokens"]) == (True, 1, 300, 120)

    @pytest.mark.parametrize("status, code", [(401, "auth"), (429, "rate_limit"), (500, "api")])
    def test_開く時点のHTTPエラーは_返す前に例外で出す(self, status, code):
        def handler(request):
            return httpx2.Response(status, json={"type": "error", "error": {"type": "x", "message": "だめ"}})

        with pytest.raises(rg.GuideError) as e:
            assistant.stream_step([_user("ベースを置いて")], "turn-1", 0, client=_sdk_client(handler))
        assert e.value.code == code
        assert [record["error"] for record in guide_usage.read_records()] == [code]

    def test_接続できなければ_返す前に例外で出す(self):
        def handler(request):
            raise httpx2.ConnectError("connection refused", request=request)

        with pytest.raises(rg.GuideError) as e:
            assistant.stream_step([_user("ベースを置いて")], "turn-1", 0, client=_sdk_client(handler))
        assert e.value.code == "network"

    def test_途中でerrorのイベントが来たら_errorの行にする(self):
        broken = _sse_tool_use()[:8] + [
            {"type": "error", "error": {"type": "overloaded_error", "message": "Overloaded"}}]
        events = list(assistant.stream_step([_user("ベースを置いて")], "turn-1", 0,
                                            client=_sdk_client(lambda request: _sse_response(broken))))
        assert [event["type"] for event in events] == ["text", "error"]
        # HTTP の番号は、開いたときの 200 のまま。文には出さない
        assert events[1]["detail"]["code"] == "api" and "応答の途中でエラーを返しました" in events[1]["detail"]["message"]
        assert "200" not in events[1]["detail"]["message"] and "Overloaded" not in events[1]["detail"]["message"]
        (record,) = guide_usage.read_records()
        # 最初のイベントまでは届いているので、入力のぶんの使用量が残る
        assert (record["ok"], record["error"], record["input_tokens"], record["cache_read_input_tokens"]) == (
            False, "api", 10, 2500)

    def test_ツールの引数が読めないJSONなら_errorの行にする(self):
        """SDK は ValueError を出す"""
        broken = _sse_tool_use()
        broken[12] = {"type": "content_block_delta", "index": 2,
                      "delta": {"type": "input_json_delta", "partial_json": '{"track_id": }'}}
        events = list(assistant.stream_step([_user("ベースを置いて")], "turn-1", 0,
                                            client=_sdk_client(lambda request: _sse_response(broken))))
        assert [event["type"] for event in events] == ["text", "text", "text", "tool", "error"]
        assert events[4]["detail"] == {"message": "応答を読み取れませんでした。もう一度試してください", "code": "api"}
        assert [record["error"] for record in guide_usage.read_records()] == ["api"]

    def test_イベントの本文が読めないJSONなら_errorの行にする(self):
        body = _sse(_sse_tool_use()[:8]) + b"event: content_block_delta\ndata: {not json\n\n"
        handler = lambda request: httpx2.Response(200, headers={"content-type": "text/event-stream"}, content=body)  # noqa: E731
        events = list(assistant.stream_step([_user("ベースを置いて")], "turn-1", 0, client=_sdk_client(handler)))
        assert [event["type"] for event in events] == ["text", "error"]
        assert events[1]["detail"] == {"message": "応答を読み取れませんでした。もう一度試してください", "code": "api"}

    def test_終わりのイベントが来ないまま切れたら_errorの行にする(self):
        """接続が静かに閉じられた場合。終わり方（stop_reason）が無いので、想定していない終わり方として扱う"""
        cut = _sse_tool_use()[:9]
        events = list(assistant.stream_step([_user("ベースを置いて")], "turn-1", 0,
                                            client=_sdk_client(lambda request: _sse_response(cut))))
        assert [event["type"] for event in events] == ["text", "text", "error"]
        assert events[2]["detail"]["code"] == "api"
        (record,) = guide_usage.read_records()
        assert (record["ok"], record["error"], record["input_tokens"]) == (False, "api", 10)

    def test_何も届かないまま終わったら_errorの行にする(self):
        handler = lambda request: httpx2.Response(200, headers={"content-type": "text/event-stream"}, content=b"")  # noqa: E731
        events = list(assistant.stream_step([_user("ベースを置いて")], "turn-1", 0, client=_sdk_client(handler)))
        assert [event["type"] for event in events] == ["error"]
        assert events[0]["detail"] == {"message": "応答を読み取れませんでした。もう一度試してください", "code": "api"}
        (record,) = guide_usage.read_records()
        assert (record["ok"], record["error"], record["input_tokens"]) == (False, "api", None)

    def test_途中で通信が切れたら_errorの行にする(self):
        """応答の途中の通信の失敗は、SDK の例外に包まれずに出てくる"""
        head = _sse(_sse_tool_use()[:8])

        class Cut(httpx2.SyncByteStream):
            def __iter__(self):
                yield head
                raise httpx2.ReadError("connection reset")

        handler = lambda request: httpx2.Response(200, headers={"content-type": "text/event-stream"}, stream=Cut())  # noqa: E731
        events = list(assistant.stream_step([_user("ベースを置いて")], "turn-1", 0, client=_sdk_client(handler)))
        assert [event["type"] for event in events] == ["text", "error"]
        assert events[1]["detail"]["code"] == "network" and "途中で途切れました" in events[1]["detail"]["message"]
        (record,) = guide_usage.read_records()
        assert (record["ok"], record["error"], record["input_tokens"]) == (False, "network", 10)

    def test_途中で閉じたら_SDKのストリームも閉じて_ここまでの使用量を記録する(self):
        closed = []

        class Body(httpx2.SyncByteStream):
            def __iter__(self):
                yield _sse(_sse_tool_use())

            def close(self):
                closed.append(True)

        handler = lambda request: httpx2.Response(200, headers={"content-type": "text/event-stream"}, stream=Body())  # noqa: E731
        events = assistant.stream_step([_user("ベースを置いて")], "turn-1", 0, client=_sdk_client(handler))
        assert next(events) == {"type": "text", "text": "ベース"}
        events.close()
        assert closed
        (record,) = guide_usage.read_records()
        assert (record["ok"], record["error"], record["input_tokens"], record["cache_read_input_tokens"]) == (
            False, "cancelled", 10, 2500)


@pytest.fixture
def no_keys(monkeypatch, tmp_path):
    """API キーがどこにも無い状態にする（手元の .env や環境変数を読ませない）"""
    llm_settings.clear_api_key()
    for name in ("ANTHROPIC_API_KEY", "CLAUDE_API_KEY", "ANTHROPIC_AUTH_TOKEN"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(llm_settings, "_dotenv_path", lambda: tmp_path / "no-such.env")
    yield tmp_path
    llm_settings.clear_api_key()


class TestApi:
    """ルート経由（POST /api/assistant/step）"""

    @pytest.fixture(autouse=True)
    def clean(self, no_keys):
        yield

    @pytest.fixture
    def client(self):
        from web.api import app

        return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")

    @pytest.fixture
    def fake(self, monkeypatch):
        fake = FakeClient(content=_tool_use_content(), stop_reason="tool_use")
        monkeypatch.setattr(llm_settings, "make_client", lambda: fake)
        return fake

    @staticmethod
    def body(**overrides):
        body = {"messages": [_user("ベースを置いて")], "turn_id": "turn-1", "step": 0}
        body.update(overrides)
        return body

    @pytest.mark.asyncio
    async def test_応答と今日の使用量を返す(self, client, fake):
        resp = await client.post("/api/assistant/step", json=self.body())
        assert resp.status_code == 200
        body = resp.json()
        assert set(body) == {"content", "stop_reason", "model", "usage", "cost_usd", "today"}
        assert body["stop_reason"] == "tool_use" and body["model"] == "claude-opus-5-5"
        assert body["content"][0] == {"type": "thinking", "thinking": "", "signature": "c2lnLXRvb2w="}
        assert body["content"][2] == {
            "type": "tool_use", "id": "toolu_02", "name": "add_notes",
            "input": {"track_id": 3, "notes": [{"pitch": "C2", "step": 0, "length": 4},
                                               {"pitch": "G2", "step": 8, "length": 4, "velocity": 100}]}}
        assert body["usage"] == USAGE
        assert body["cost_usd"] == pytest.approx(guide_usage.estimate_cost("claude-opus-5-5", USAGE))
        assert body["today"]["calls"] == 1 and body["today"]["blocked"] is None
        # Claude には、受け取った会話とツールの台帳を渡している
        assert fake.calls[0]["messages"] == [_user("ベースを置いて")]
        assert [tool["name"] for tool in fake.calls[0]["tools"]][:3] == ["get_project", "get_notes", "get_chart"]

    @pytest.mark.asyncio
    async def test_続きの呼び出しは_今日の回数を増やさない(self, client, fake):
        await client.post("/api/assistant/step", json=self.body())
        resp = await client.post("/api/assistant/step", json=self.body(messages=_conversation(), step=1))
        assert resp.status_code == 200 and resp.json()["today"]["calls"] == 1 and len(fake.calls) == 2
        assert fake.calls[1]["messages"] == _conversation()

    @pytest.mark.asyncio
    async def test_キーが無ければ401_キーが正しくなければ401(self, client, monkeypatch):
        error = TypeError("Could not resolve authentication method. Expected one of api_key, auth_token")
        monkeypatch.setattr(llm_settings, "make_client", lambda: FakeClient(error=error))
        resp = await client.post("/api/assistant/step", json=self.body())
        assert resp.status_code == 401 and resp.json()["detail"]["code"] == "no_key"
        assert resp.json()["detail"]["message"]
        monkeypatch.setattr(llm_settings, "make_client",
                            lambda: FakeClient(error=_api_error(anthropic.AuthenticationError, 401)))
        resp = await client.post("/api/assistant/step", json=self.body())
        assert resp.status_code == 401 and resp.json()["detail"]["code"] == "auth"

    @pytest.mark.asyncio
    async def test_上限に達していたら_呼ばずに429_続きの呼び出しは通る(self, client, fake):
        await client.post("/api/settings/guide", json={"daily_limit_calls": 0})
        resp = await client.post("/api/assistant/step", json=self.body())
        assert resp.status_code == 429
        assert resp.json()["detail"]["code"] == "daily_limit" and "上限" in resp.json()["detail"]["message"]
        assert fake.calls == []
        resp = await client.post("/api/assistant/step", json=self.body(messages=_conversation(), step=1))
        assert resp.status_code == 200 and len(fake.calls) == 1

    @pytest.mark.asyncio
    async def test_利用制限は429_断られた応答と通信の失敗は502(self, client, monkeypatch):
        monkeypatch.setattr(llm_settings, "make_client",
                            lambda: FakeClient(error=_api_error(anthropic.RateLimitError, 429)))
        resp = await client.post("/api/assistant/step", json=self.body())
        assert resp.status_code == 429 and resp.json()["detail"]["code"] == "rate_limit"
        monkeypatch.setattr(llm_settings, "make_client", lambda: FakeClient(stop_reason="refusal"))
        resp = await client.post("/api/assistant/step", json=self.body())
        assert resp.status_code == 502 and resp.json()["detail"]["code"] == "refused"
        connection = anthropic.APIConnectionError(request=httpx2.Request("POST", "https://api.anthropic.com/v1/messages"))
        monkeypatch.setattr(llm_settings, "make_client", lambda: FakeClient(error=connection))
        resp = await client.post("/api/assistant/step", json=self.body())
        assert resp.status_code == 502 and resp.json()["detail"]["code"] == "network"

    @pytest.mark.asyncio
    async def test_形の正しくない依頼は400_大きすぎる会話は413(self, client, fake):
        bad = [
            {},
            {"messages": [_user("ベースを置いて")]},
            self.body(messages=[]),
            self.body(messages="ベースを置いて"),
            self.body(messages=[{"role": "assistant", "content": "はい"}]),
            self.body(turn_id="turn 1"),
            self.body(turn_id=None),
            self.body(step=assistant.MAX_STEPS),
            self.body(step=-1),
            self.body(step="0"),
        ]
        for payload in bad:
            resp = await client.post("/api/assistant/step", json=payload)
            assert resp.status_code == 400, payload
            assert resp.json()["detail"]["code"] == "invalid" and resp.json()["detail"]["message"]
        resp = await client.post("/api/assistant/step",
                                 json=self.body(messages=[_user("あ" * assistant.MAX_REQUEST_CHARS)]))
        assert resp.status_code == 413 and resp.json()["detail"]["code"] == "too_long"
        assert fake.calls == [] and guide_usage.read_records() == []

    @staticmethod
    def lines(resp):
        """少しずつ返す応答の本文（1 行に JSON 1 つ）を読む。どの行も改行で終わっている"""
        assert resp.text.endswith("\n")
        return [json.loads(line) for line in resp.text.splitlines()]

    @pytest.mark.asyncio
    async def test_streamが在れば_1行ずつのJSONで返す(self, client, fake):
        resp = await client.post("/api/assistant/step", json=self.body(stream=True))
        assert resp.status_code == 200
        assert resp.headers["content-type"] == "application/x-ndjson"
        assert resp.headers["cache-control"] == "no-store" and resp.headers["x-accel-buffering"] == "no"
        lines = self.lines(resp)
        assert lines[:3] == [{"type": "text", "text": "ベースを"}, {"type": "text", "text": "置きます。"},
                             {"type": "tool", "name": "add_notes"}]
        assert len(lines) == 4 and "ひみつの考え" not in resp.text
        done = lines[3]
        assert set(done) == {"type", "content", "stop_reason", "model", "usage", "cost_usd", "today"}
        assert done["today"]["calls"] == 1 and done["today"]["blocked"] is None
        assert fake.streams[0].closed == 1 and len(fake.calls) == 1

        # stream が無い呼び出しの応答と、同じ項目・同じ中身（今日の費用だけ、2 回ぶんに増える）
        plain = (await client.post("/api/assistant/step", json=self.body(messages=_conversation(), step=1))).json()
        assert {**done, "today": None} == {"type": "done", **plain, "today": None}
        assert plain["today"]["calls"] == 1 and plain["today"]["cost_usd"] == pytest.approx(done["today"]["cost_usd"] * 2)

    @pytest.mark.asyncio
    @pytest.mark.parametrize("stream", [None, False, "true", 1])
    async def test_streamがtrueでなければ_今までどおりJSON1つで返す(self, client, fake, stream):
        payload = self.body() if stream is None else self.body(stream=stream)
        resp = await client.post("/api/assistant/step", json=payload)
        assert resp.status_code == 200 and resp.headers["content-type"] == "application/json"
        assert set(resp.json()) == {"content", "stop_reason", "model", "usage", "cost_usd", "today"}
        assert fake.streams == [] and len(fake.calls) == 1

    @pytest.mark.asyncio
    async def test_streamが在っても_開く時点までの失敗はHTTPエラーで返す(self, client, monkeypatch):
        def use(fake):
            monkeypatch.setattr(llm_settings, "make_client", lambda: fake)
            return fake

        async def post(**overrides):
            return await client.post("/api/assistant/step", json=self.body(stream=True, **overrides))

        fake = use(FakeClient())
        # 引数・会話の形
        for overrides in ({"turn_id": "turn 1"}, {"step": assistant.MAX_STEPS}, {"messages": []}):
            resp = await post(**overrides)
            assert resp.status_code == 400 and resp.json()["detail"]["code"] == "invalid", overrides
        resp = await post(messages=[_user("あ" * assistant.MAX_REQUEST_CHARS)])
        assert resp.status_code == 413 and resp.json()["detail"]["code"] == "too_long"
        assert fake.calls == [] and guide_usage.read_records() == []
        # キーが無い・正しくない、利用制限、接続できない
        connection = anthropic.APIConnectionError(request=httpx2.Request("POST", "https://api.anthropic.com/v1/messages"))
        for error, status, code in [
            (TypeError("Could not resolve authentication method. Expected one of api_key, auth_token"), 401, "no_key"),
            (_api_error(anthropic.AuthenticationError, 401), 401, "auth"),
            (_api_error(anthropic.RateLimitError, 429), 429, "rate_limit"),
            (connection, 502, "network"),
        ]:
            use(FakeClient(error=error))
            resp = await post()
            assert resp.status_code == status and resp.headers["content-type"] == "application/json", code
            assert resp.json()["detail"]["code"] == code and resp.json()["detail"]["message"]
        # 1 日の上限（依頼の最初の呼び出しだけ）
        fake = use(FakeClient())
        await client.post("/api/settings/guide", json={"daily_limit_calls": 0})
        resp = await post()
        assert resp.status_code == 429 and resp.json()["detail"]["code"] == "daily_limit" and fake.calls == []
        resp = await post(messages=_conversation(), step=1)
        assert resp.status_code == 200 and self.lines(resp)[-1]["type"] == "done" and len(fake.calls) == 1

    @pytest.mark.asyncio
    async def test_流し始めた後の失敗は_200のまま_最後のerrorの行で返す(self, client, monkeypatch):
        monkeypatch.setattr(llm_settings, "make_client", lambda: FakeClient(stop_reason="refusal"))
        resp = await client.post("/api/assistant/step", json=self.body(stream=True))
        assert resp.status_code == 200 and resp.headers["content-type"] == "application/x-ndjson"
        lines = self.lines(resp)
        assert [line["type"] for line in lines] == ["text", "text", "error"]
        assert set(lines[2]) == {"type", "detail", "today"}
        # detail は、HTTP エラーの detail と同じ形・同じ文
        plain = await client.post("/api/assistant/step", json=self.body(turn_id="turn-2"))
        assert plain.status_code == 502 and lines[2]["detail"] == plain.json()["detail"]
        assert lines[2]["detail"]["code"] == "refused"
        # 応答は返ってきているので、今日の回数に入っている
        assert lines[2]["today"]["calls"] == 1

        broken = FakeClient(content=_tool_use_content(), broken=(8, httpx2.ReadError("connection reset")))
        monkeypatch.setattr(llm_settings, "make_client", lambda: broken)
        resp = await client.post("/api/assistant/step", json=self.body(stream=True, turn_id="turn-3"))
        lines = self.lines(resp)
        assert resp.status_code == 200 and [line["type"] for line in lines] == ["text", "error"]
        assert lines[1]["detail"]["code"] == "network" and broken.streams[0].closed == 1

    @pytest.mark.asyncio
    async def test_画面が途中で切ったら_ストリームを閉じて_cancelledで記録する(self, fake):
        """本文を流している途中で、接続が切れた場合（中止）。

        テスト用のクライアントは本文を最後まで溜めてから返すので、アプリを ASGI のまま直に呼び、
        最初の行を受け取ったところで切断を伝える（サーバは起動しない）。
        """
        import asyncio

        from web.api import app

        payload = json.dumps(self.body(stream=True)).encode("utf-8")
        scope = {
            "type": "http", "asgi": {"version": "3.0", "spec_version": "2.3"}, "http_version": "1.1",
            "method": "POST", "scheme": "http", "path": "/api/assistant/step", "raw_path": b"/api/assistant/step",
            "query_string": b"", "root_path": "", "client": ("127.0.0.1", 50000), "server": ("test", 80),
            "headers": [(b"host", b"test"), (b"content-type", b"application/json"),
                        (b"content-length", str(len(payload)).encode("ascii"))],
        }
        gone = asyncio.Event()
        requests = [{"type": "http.request", "body": payload, "more_body": False}]
        sent = []

        async def receive():
            if requests:
                return requests.pop()
            await gone.wait()
            return {"type": "http.disconnect"}

        async def send(message):
            sent.append(message)
            if message["type"] == "http.response.body" and message.get("body"):
                gone.set()

        await asyncio.wait_for(app(scope, receive, send), timeout=10)
        gc.collect()

        assert sent[0]["type"] == "http.response.start" and sent[0]["status"] == 200
        assert dict(sent[0]["headers"])[b"content-type"] == b"application/x-ndjson"
        bodies = [message["body"] for message in sent[1:] if message.get("body")]
        assert bodies == [b'{"type":"text","text":"\xe3\x83\x99\xe3\x83\xbc\xe3\x82\xb9\xe3\x82\x92"}\n']
        assert fake.streams[0].closed == 1
        (record,) = guide_usage.read_records()
        assert (record["feature"], record["ok"], record["error"], record["turn"], record["step"]) == (
            "assistant", False, "cancelled", "turn-1", 0)
        assert record["input_tokens"] == 900
