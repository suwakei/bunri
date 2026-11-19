"""依頼ごとのモデル選び（model_router）と、選べるモデルの決まり（llm_settings）のテスト

Claude は呼ばず、クライアントを差し替えて確かめる（再現ガイド・アシスタントのテストと同じやり方）。

- 選べるモデル: 表、受け取ったモデル ID の確かめ、``BUNRI_GUIDE_MODEL`` での固定、保存済みを探す順
- リクエストの形: Haiku 5.5、Structured Outputs、サーバ側のやり直しを付けない、区切りより前が毎回同じ
- 渡す文: 今回の依頼と、直前の会話の文だけ（ツールの引数・結果・思考は渡さない。1,500 文字まで）
- 結果: 段階 → モデル、理由を短く切る、固定・失敗のときの扱い
- 費用: 記録は ``feature: "router"``。費用には足し、回数には数えない。記録に中身とキーが入らない
"""
import inspect
import json
import re
from types import SimpleNamespace

import anthropic
import httpx2
import pytest

import guide_usage
import llm_settings
import model_router

USAGE = {"input_tokens": 120, "output_tokens": 40, "cache_read_input_tokens": 900,
         "cache_creation_input_tokens": 0, "thinking_tokens": None}


def _user(text):
    return {"role": "user", "content": [{"type": "text", "text": text}]}


class FakeClient:
    """差し替え用のクライアント。``calls`` が、Claude を呼んだ回数になる。

    ``payload`` を JSON の文にして返す（``text`` を渡せば、その文をそのまま返す）。``error`` は呼び出しの時点で出す。
    """

    def __init__(self, payload=None, text=None, stop_reason="end_turn", error=None):
        self.calls = []
        self._payload = payload if payload is not None else {"tier": "sonnet", "reason": "8 小節のベースを考えるので"}
        self._text = text
        self._stop_reason = stop_reason
        self._error = error
        self.beta = SimpleNamespace(messages=SimpleNamespace(create=self._create))

    def _create(self, **kwargs):
        self.calls.append(kwargs)
        if self._error is not None:
            raise self._error
        text = self._text if self._text is not None else json.dumps(self._payload, ensure_ascii=False)
        return SimpleNamespace(
            stop_reason=self._stop_reason,
            content=[SimpleNamespace(type="text", text=text)],
            model="claude-haiku-5-5",
            usage=SimpleNamespace(input_tokens=USAGE["input_tokens"], output_tokens=USAGE["output_tokens"],
                                  cache_read_input_tokens=USAGE["cache_read_input_tokens"],
                                  cache_creation_input_tokens=USAGE["cache_creation_input_tokens"],
                                  output_tokens_details=None),
        )


def _api_error(cls, status):
    request = httpx2.Request("POST", "https://api.anthropic.com/v1/messages")
    return cls("error", response=httpx2.Response(status, request=request), body=None)


@pytest.fixture(autouse=True)
def data_dir(monkeypatch, tmp_path):
    """保存先（使用量の記録・設定）を、テストごとの一時ディレクトリにする"""
    monkeypatch.setenv("BUNRI_DATA_DIR", str(tmp_path))
    monkeypatch.delenv("BUNRI_GUIDE_MODEL", raising=False)
    return tmp_path


class TestModels:
    """選べるモデルの決まり（llm_settings）"""

    def test_既定はHaikuで_選べるのは3つ(self):
        assert llm_settings.DEFAULT_MODEL == "claude-haiku-5-5" == llm_settings.model()
        assert llm_settings.MODELS == {"haiku": "claude-haiku-5-5", "sonnet": "claude-sonnet-5-5",
                                       "opus": "claude-opus-5-5"}
        # どのモデルも、概算の費用を出せる
        for model in llm_settings.MODELS.values():
            assert guide_usage.estimate_cost(model, USAGE) > 0

    def test_受け取ったモデルIDを確かめる(self):
        for model in llm_settings.MODELS.values():
            assert llm_settings.validate_model(model) == model
        assert llm_settings.validate_model(None) is None and llm_settings.validate_model("") is None
        for bad in ("haiku", "claude-opus-4-8", "claude-haiku-5-5 ", 3, ["claude-haiku-5-5"], True):
            with pytest.raises(ValueError):
                llm_settings.validate_model(bad)

    def test_固定されていなければ_指定か既定(self):
        assert llm_settings.fixed_model() is None
        assert llm_settings.resolve_model(None) == "claude-haiku-5-5"
        assert llm_settings.resolve_model("claude-opus-5-5") == "claude-opus-5-5"
        with pytest.raises(ValueError):
            llm_settings.resolve_model("claude-opus-4-8")

    def test_固定されていれば_いつもそのモデル(self, monkeypatch):
        monkeypatch.setenv("BUNRI_GUIDE_MODEL", "claude-sonnet-5-5")
        assert llm_settings.fixed_model() == "claude-sonnet-5-5" == llm_settings.model()
        assert llm_settings.resolve_model("claude-opus-5-5") == "claude-sonnet-5-5"
        assert llm_settings.resolve_model(None) == "claude-sonnet-5-5"
        # 表に無いモデルで固定したときは、そのモデル ID も受け付ける（画面が送り返すため）
        monkeypatch.setenv("BUNRI_GUIDE_MODEL", "claude-opus-5")
        assert llm_settings.validate_model("claude-opus-5") == "claude-opus-5"
        assert llm_settings.tier_of("claude-opus-5") is None
        monkeypatch.setenv("BUNRI_GUIDE_MODEL", "  ")
        assert llm_settings.fixed_model() is None

    def test_保存済みを探す順は_強いモデルが先(self, monkeypatch):
        assert llm_settings.lookup_models() == ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]
        monkeypatch.setenv("BUNRI_GUIDE_MODEL", "claude-opus-5")
        assert llm_settings.lookup_models()[-1] == "claude-opus-5"
        monkeypatch.setenv("BUNRI_GUIDE_MODEL", "claude-sonnet-5-5")
        assert len(llm_settings.lookup_models()) == 3


class TestRequest:
    def test_Haikuに_決まった形で出させる(self):
        request = model_router.build_request([_user("テンポを 90 にして")])
        assert request["model"] == model_router.ROUTER_MODEL == "claude-haiku-5-5"
        assert request["output_config"] == {
            "effort": "low", "format": {"type": "json_schema", "schema": model_router.ROUTER_SCHEMA}}
        assert model_router.ROUTER_SCHEMA["properties"]["tier"]["enum"] == ["haiku", "sonnet", "opus"]
        assert model_router.ROUTER_SCHEMA["additionalProperties"] is False
        assert set(model_router.ROUTER_SCHEMA["required"]) == {"tier", "reason"}
        # Haiku にはサーバ側のやり直しが無いので付けない。思考とツールも指定しない
        for key in ("betas", "fallbacks", "thinking", "tools", "tool_choice"):
            assert key not in request

    def test_指示文の末尾に区切りを置き_区切りより前は毎回同じ(self):
        first = model_router.build_request([_user("テンポを 90 にして")])
        second = model_router.build_request([_user("サビのベースを 8 小節考えて"), {"role": "assistant", "content": "はい"},
                                             _user("お願い")])
        assert first["system"] == [{"type": "text", "text": model_router.ROUTER_PROMPT,
                                    "cache_control": {"type": "ephemeral"}}]

        def prefix(request):
            return json.dumps([request["model"], request["system"], request["output_config"]], ensure_ascii=False)

        assert prefix(first) == prefix(second)
        prompt = model_router.ROUTER_PROMPT
        assert not re.search(r"(19|20)\d\d", prompt) and not re.search(r"\d{1,2}:\d{2}", prompt)
        assert "{" not in prompt and "haiku" in prompt and "sonnet" in prompt and "opus" in prompt

    def test_リクエストの引数は_入っているSDKが受ける名前だけ(self):
        from anthropic.resources.beta.messages import Messages

        accepted = set(inspect.signature(Messages.create).parameters)
        assert set(model_router.build_request([_user("再生して")])) <= accepted

    def test_本物のSDKを通しても_同じ形で送られる(self):
        """通信の手前（差し替えた transport）で受ける。Claude は呼ばない"""
        seen = {}

        def handler(request):
            seen["beta"] = request.headers.get("anthropic-beta")
            seen["body"] = json.loads(request.content)
            return httpx2.Response(200, json={
                "id": "msg_01", "type": "message", "role": "assistant", "model": "claude-haiku-5-5",
                "stop_reason": "end_turn", "stop_sequence": None,
                "content": [{"type": "text", "text": json.dumps({"tier": "haiku", "reason": "アプリの操作だけなので"})}],
                "usage": {"input_tokens": 50, "output_tokens": 20, "cache_read_input_tokens": 0,
                          "cache_creation_input_tokens": 700},
            })

        client = anthropic.Anthropic(api_key="test-key-not-real", max_retries=0,
                                     http_client=httpx2.Client(transport=httpx2.MockTransport(handler)))
        route = model_router.choose([_user("再生して")], turn_id="turn-1", client=client)
        assert route["model"] == "claude-haiku-5-5" and route["reason"] == "アプリの操作だけなので"
        body = seen["body"]
        assert seen["beta"] is None and "fallbacks" not in body
        assert body["model"] == "claude-haiku-5-5"
        assert body["output_config"]["format"]["type"] == "json_schema"
        assert body["system"][0]["cache_control"] == {"type": "ephemeral"}
        assert "<request>\n再生して\n</request>" in body["messages"][0]["content"]


class TestInput:
    """渡すのは、今回の依頼の文と、直前の会話の文だけ"""

    def test_依頼の文と_直前の利用者とアシスタントの文(self):
        messages = [
            _user("ベースを置いて"),
            {"role": "assistant", "content": [
                {"type": "thinking", "thinking": "ひみつの考え", "signature": "c2ln"},
                {"type": "text", "text": "どのトラックにしますか？"},
                {"type": "tool_use", "id": "toolu_01", "name": "add_notes", "input": {"track_id": 3}},
            ]},
            {"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": "toolu_01", "content": "ひみつの結果"},
                {"type": "text", "text": "Bass に"},
            ]},
            {"role": "assistant", "content": "置きました。"},
            _user("じゃあ 8 小節に増やして"),
        ]
        request, context = model_router.router_input(messages)
        assert request == "じゃあ 8 小節に増やして"
        assert context == [("user", "ベースを置いて"), ("assistant", "どのトラックにしますか？"),
                           ("user", "Bass に"), ("assistant", "置きました。")]
        body = model_router.build_request(messages)["messages"][0]["content"]
        for hidden in ("ひみつ", "add_notes", "toolu_", "c2ln", "track_id"):
            assert hidden not in body
        assert body.index("<recent_conversation>") < body.index("<request>")

    def test_直前の会話は_新しいほうから_1500文字まで(self):
        old = [_user("あ" * 1000), {"role": "assistant", "content": "い" * 1000}]
        messages = old * 5 + [_user("う" * 800), {"role": "assistant", "content": "え" * 400}, _user("次は？")]
        request, context = model_router.router_input(messages)
        assert request == "次は？"
        assert sum(len(text) for _, text in context) <= model_router.CONTEXT_CHARS + 1
        # 新しいものは丸ごと、古いものは頭を切る
        assert context[-1] == ("assistant", "え" * 400) and context[-2] == ("user", "う" * 800)
        assert context[0][1].startswith("…")
        many = [_user(f"依頼 {i}") for i in range(20)] + [_user("最後")]
        assert len(model_router.router_input(many)[1]) == model_router.CONTEXT_MESSAGES

    def test_最初の依頼は_会話が空(self):
        assert model_router.router_input([_user("再生して")]) == ("再生して", [])
        assert model_router.router_input([{"role": "user", "content": "文字列の依頼"}]) == ("文字列の依頼", [])
        long = "か" * (model_router.REQUEST_CHARS + 100)
        assert len(model_router.router_input([_user(long)])[0]) == model_router.REQUEST_CHARS


class TestChoose:
    def test_段階をモデルにして_理由と費用を返す(self):
        client = FakeClient()
        route = model_router.choose([_user("サビのベースを 8 小節考えて")], turn_id="turn-1", client=client)
        assert route == {"model": "claude-sonnet-5-5", "tier": "sonnet", "reason": "8 小節のベースを考えるので",
                         "cost_usd": pytest.approx(guide_usage.estimate_cost("claude-haiku-5-5", USAGE))}
        assert len(client.calls) == 1 and route["cost_usd"] > 0

    @pytest.mark.parametrize("tier, model", [("haiku", "claude-haiku-5-5"), ("opus", "claude-opus-5-5")])
    def test_どの段階でも_表のモデルになる(self, tier, model):
        route = model_router.choose([_user("編曲して")], client=FakeClient(payload={"tier": tier, "reason": "x"}))
        assert (route["model"], route["tier"]) == (model, tier)

    def test_理由は短く切り_空なら決まった文(self):
        long = model_router.choose([_user("x")], client=FakeClient(payload={"tier": "haiku", "reason": "長い\n" * 30}))
        assert len(long["reason"]) == model_router.REASON_CHARS and "\n" not in long["reason"]
        empty = model_router.choose([_user("x")], client=FakeClient(payload={"tier": "opus", "reason": " "}))
        assert empty["reason"] == "Opus を選びました"

    def test_固定されていれば_Claudeを呼ばない(self, monkeypatch):
        monkeypatch.setenv("BUNRI_GUIDE_MODEL", "claude-opus-5-5")
        client = FakeClient()
        route = model_router.choose([_user("再生して")], turn_id="turn-1", client=client)
        assert route == {"model": "claude-opus-5-5", "tier": "opus", "reason": "設定で固定", "cost_usd": 0.0}
        assert client.calls == [] and guide_usage.read_records() == []

    @pytest.mark.parametrize("client, code, with_usage", [
        (FakeClient(error=_api_error(anthropic.AuthenticationError, 401)), "auth", False),
        (FakeClient(error=_api_error(anthropic.RateLimitError, 429)), "rate_limit", False),
        (FakeClient(error=anthropic.APIConnectionError(
            request=httpx2.Request("POST", "https://api.anthropic.com/v1/messages"))), "network", False),
        (FakeClient(error=TypeError("Could not resolve authentication method")), "no_key", False),
        (FakeClient(error=RuntimeError("別の誤り")), "api", False),
        (FakeClient(stop_reason="refusal"), "refused", True),
        (FakeClient(stop_reason="max_tokens", text='{"tier": "so'), "truncated", True),
        (FakeClient(text="sonnet がよいと思います"), "invalid", True),
        (FakeClient(payload={"tier": "gpt", "reason": "x"}), "invalid", True),
        (FakeClient(payload=["sonnet"]), "invalid", True),
    ])
    def test_失敗したら_Haikuにして続ける(self, client, code, with_usage):
        route = model_router.choose([_user("ベースを置いて")], turn_id="turn-1", client=client)
        assert (route["model"], route["tier"], route["reason"]) == ("claude-haiku-5-5", "haiku", "判断できなかったので Haiku")
        (record,) = guide_usage.read_records()
        assert (record["feature"], record["ok"], record["error"], record["turn"]) == ("router", False, code, "turn-1")
        # 応答が返ってきた失敗は、費用がかかっている
        if with_usage:
            assert record["input_tokens"] == 120 and route["cost_usd"] == record["cost_usd"] > 0
        else:
            assert record["input_tokens"] is None and route["cost_usd"] == 0.0

    def test_クライアントを渡さなければ_設定から作る(self, monkeypatch):
        fake = FakeClient()
        monkeypatch.setattr(llm_settings, "make_client", lambda: fake)
        assert model_router.choose([_user("x")])["tier"] == "sonnet" and len(fake.calls) == 1


class TestUsage:
    def test_記録は_routerとして残し_依頼の識別子と版を持つ(self):
        model_router.choose([_user("ベースを置いて")], turn_id="turn-abc", client=FakeClient())
        (record,) = guide_usage.read_records()
        assert (record["feature"], record["ok"], record["turn"], record["step"]) == ("router", True, "turn-abc", None)
        assert record["model"] == record["requested_model"] == "claude-haiku-5-5"
        assert record["effort"] == "low" and record["version"] == model_router.ROUTER_VERSION
        assert record["focus"] is None and record["chart"] is None

    def test_費用には足し_回数には数えない(self):
        for _ in range(3):
            model_router.choose([_user("ベースを置いて")], turn_id="turn-1", client=FakeClient())
        today = guide_usage.today()
        one = guide_usage.estimate_cost("claude-haiku-5-5", USAGE)
        assert today["calls"] == 0 and today["cost_usd"] == pytest.approx(one * 3, abs=1e-4)
        # 回数の上限が 0 でも、ルーターの行だけでは上限に達しない
        guide_usage.update_settings({"daily_limit_calls": 1})
        assert guide_usage.today()["blocked"] is None

    def test_記録に_依頼の文もキーも入らない(self, monkeypatch):
        secret = "sk-ant-secret-key-value"
        monkeypatch.setenv("ANTHROPIC_API_KEY", secret)
        model_router.choose([_user("ひみつのベースラインを置いて")], turn_id="turn-1",
                            client=FakeClient(payload={"tier": "sonnet", "reason": "ひみつの理由"}))
        text = guide_usage.log_path().read_text(encoding="utf-8")
        (record,) = guide_usage.read_records()
        assert set(record) == set(guide_usage._RECORD_FIELDS)
        for leaked in (secret, "sk-ant", "ひみつ", "ベース"):
            assert leaked not in text
