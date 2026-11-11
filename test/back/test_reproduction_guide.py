"""再現ガイド（第2層）のテスト

Claude は呼ばず、クライアントを差し替えて確かめる。

- リクエストの形: カルテがキャッシュされる位置に在る、音符を返させない出力形式になっている
- 出力の検証: カルテに無い場所への参照を落とす、カルテに無い音名・コード名を見つける
- 失敗の扱い: API キーが無い・正しくない、応答を断られた、途中で切れた
- 費用: 保存済みなら API を呼ばない、版が変われば保存分を使わない、上限を超えたら API を呼ばない、
  使用量の記録に中身とキーが入らない
"""
import json
import threading
import time
from types import SimpleNamespace

import anthropic
import httpx2
import pytest
from httpx import ASGITransport, AsyncClient

import guide_cache
import guide_usage
import llm_settings
import reproduction_guide as rg


def _chord(beat_index, bar, root, quality, symbol, degree, confidence):
    """1 小節ぶんのコード（カルテの chords の 1 要素）"""
    return {
        "beat_index": beat_index, "beat_count": 4, "bar": bar, "beat": 1,
        "start_sec": beat_index * 0.5, "end_sec": (beat_index + 4) * 0.5,
        "root": root, "quality": quality, "symbol": symbol, "degree": degree, "confidence": confidence,
    }


@pytest.fixture
def chart():
    """小さな楽曲カルテ（8 小節、C メジャー、セクション 2 つ）"""
    return {
        "version": 1,
        "source": {"filename": "song.wav", "duration_sec": 16.0},
        "grid": {
            "bpm": 120.0, "bpm_confidence": 0.9, "bpm_source": "auto",
            "downbeat_offset_sec": 0.0, "time_signature": [4, 4],
            "beat_times_sec": [round(i * 0.5, 3) for i in range(32)],
            "user_confirmed": False,
        },
        "key": {"tonic": "C", "mode": "major", "confidence": 0.8,
                "alternatives": [{"tonic": "A", "mode": "minor", "confidence": 0.6}]},
        "sections": [
            {"id": "S1", "label": None, "suggested_label": "verse", "suggested_confidence": 0.6,
             "start_bar": 1, "end_bar": 4, "start_sec": 0.0, "end_sec": 8.0, "repeat_group": "A",
             "features": {"rms_db": -14.0, "onset_density": 3.0}},
            {"id": "S2", "label": None, "suggested_label": "chorus", "suggested_confidence": 0.7,
             "start_bar": 5, "end_bar": 8, "start_sec": 8.0, "end_sec": 16.0, "repeat_group": "B",
             "features": {"rms_db": -10.0, "onset_density": 5.0}},
        ],
        "chords": [
            _chord(0, 1, "C", "maj", "C", "I", 0.9),
            _chord(4, 2, "G", "7", "G7", "V7", 0.8),
            _chord(8, 3, "A", "min", "Am", "vi", 0.8),
            _chord(12, 4, "F", "maj", "F", "IV", 0.4),
        ],
        "mix": {"loudness_lufs": -9.0, "peak_dbfs": -0.5, "dynamic_range_db": 7.0,
                "stereo_width": 0.5, "bass_mono": True, "reverb_tail_sec": None, "spectrum_bands": []},
        "unavailable": {"mix.reverb_tail_sec": "残響を測れる無音区間がありませんでした"},
    }


def _guide(**overrides):
    """LLM が返す形のガイド"""
    guide = {
        "overview": "キーは C メジャー、テンポは 120 BPM の曲です。",
        "steps": [
            {"title": "テンポを合わせる", "topic": "grid", "body": "まず 120 BPM に設定します。",
             "refs": [{"section_id": None, "bar": 1, "beat": 1}]},
            {"title": "サビのコード", "topic": "chords", "body": "C → G7 → Am → F（I → V7 → vi → IV）の進行です。",
             "refs": [{"section_id": "S2", "bar": None, "beat": None}]},
        ],
        "cautions": ["4 小節目のコードは確信度が低めです。"],
    }
    guide.update(overrides)
    return guide


class FakeClient:
    """差し替え用のクライアント。``calls`` が、Claude を呼んだ回数（= 費用がかかった回数）になる

    ``client.beta.messages.create``（ガイドを作る）と ``client.messages.count_tokens``
    （トークン数を数える。費用はかからない）だけを持つ。
    """

    def __init__(self, guide=None, stop_reason="end_turn", error=None, text=None, delay=0.0, tokens=1000):
        self.calls = []
        self.count_calls = []
        self._guide = guide if guide is not None else _guide()
        self._stop_reason = stop_reason
        self._error = error
        self._text = text
        self._delay = delay
        self._tokens = tokens
        self.beta = SimpleNamespace(messages=SimpleNamespace(create=self._create))
        self.messages = SimpleNamespace(count_tokens=self._count_tokens)

    def _count_tokens(self, **kwargs):
        self.count_calls.append(kwargs)
        tokens = self._tokens(kwargs) if callable(self._tokens) else self._tokens
        return SimpleNamespace(input_tokens=tokens)

    def _create(self, **kwargs):
        self.calls.append(kwargs)
        if self._delay:
            time.sleep(self._delay)
        if self._error is not None:
            raise self._error
        text = self._text if self._text is not None else json.dumps(self._guide, ensure_ascii=False)
        return SimpleNamespace(
            stop_reason=self._stop_reason,
            content=[SimpleNamespace(type="thinking", thinking=""), SimpleNamespace(type="text", text=text)],
            model="claude-opus-5-5",
            usage=SimpleNamespace(input_tokens=12, output_tokens=300,
                                  cache_read_input_tokens=1500, cache_creation_input_tokens=0,
                                  output_tokens_details=SimpleNamespace(thinking_tokens=120)),
        )


def _api_error(cls, status):
    """SDK の例外を作る"""
    request = httpx2.Request("POST", "https://api.anthropic.com/v1/messages")
    return cls("error", response=httpx2.Response(status, request=request), body=None)


class TestPromptChart:
    def test_ビート列は渡さず_数だけ残す(self, chart):
        slim = json.loads(rg.prompt_chart(chart))
        assert "beat_times_sec" not in slim["grid"]
        assert slim["grid"]["beat_count"] == 32
        assert slim["key"]["tonic"] == "C"
        assert len(slim["chords"]["rows"]) == 4

    def test_コードは表の形で_言語化に使う項目だけ(self, chart):
        """長い曲では入力のほとんどがコードの一覧。項目名を繰り返さず、値は変えない"""
        table = json.loads(rg.prompt_chart(chart))["chords"]
        assert table["columns"] == ["bar", "beat", "length_beats", "symbol", "degree", "confidence"]
        assert table["rows"][1] == [2, 1, 4, "G7", "V7", "確実"]
        # 元のカルテの値と 1 件ずつ一致する（確信度を 3 段階にするほかは、事実を変えていない）
        for row, chord in zip(table["rows"], chart["chords"]):
            assert row[:5] == [chord["bar"], chord["beat"], chord["beat_count"], chord["symbol"], chord["degree"]]
        text = rg.prompt_chart(chart)
        for dropped in ("start_sec\":0.0,\"symbol", "beat_index", "quality", "root"):
            assert dropped not in text

    def test_確信度は_画面と同じ3段階にして渡す(self, chart):
        """数値をしきい値と比べるのは機械的に決まる計算。LLM にさせると言い間違えるので、コードで直す"""
        import song_chart

        chart["grid"]["bpm_confidence"] = 0.4436
        chart["sections"][0]["suggested_confidence"] = 0.39
        slim = json.loads(rg.prompt_chart(chart))
        assert slim["grid"]["bpm_confidence"] == "たぶん"
        assert slim["key"]["confidence"] == "確実"
        assert slim["key"]["alternatives"][0]["confidence"] == "たぶん"
        assert [s["suggested_confidence"] for s in slim["sections"]] == ["自信なし", "確実"]
        # コードの表も同じ。0.9 0.8 0.8 0.4
        assert [row[5] for row in slim["chords"]["rows"]] == ["確実", "確実", "確実", "たぶん"]
        # しきい値は、カルテの画面と同じ関数で決まる（境目の値も画面と一致する）
        for value, tier in ((0.7, "certain"), (0.6999, "likely"), (0.4, "likely"), (0.3999, "unsure"), (None, "unsure")):
            assert song_chart.confidence_tier(value) == tier
            assert rg._tier_label(value) == rg._TIER_LABEL[tier]
        # 生の数値は 1 つも渡らない。元のカルテは書き換えない
        assert "0.4436" not in rg.prompt_chart(chart) and "0.39" not in rg.prompt_chart(chart)
        assert chart["key"]["confidence"] == 0.8 and chart["chords"][0]["confidence"] == 0.9

    def test_確信度が無い項目は_自信なしとして渡す(self, chart):
        chart["key"] = {"tonic": None, "mode": None, "confidence": 0.0, "alternatives": []}
        chart["chords"][0]["confidence"] = None
        slim = json.loads(rg.prompt_chart(chart))
        assert slim["key"]["confidence"] == "自信なし"
        assert slim["chords"]["rows"][0][5] == "自信なし"

    def test_ファイル名は送らない(self, chart):
        """曲の事実ではなく、言語化に使わない。利用者のファイル名を外に出さない"""
        chart["source"]["filename"] = "わたしの曲 final2.wav"
        text = rg.prompt_chart(chart)
        assert "わたしの曲" not in text
        assert json.loads(text)["source"] == {"duration_sec": 16.0}

    def test_セクションに絞ると_そのセクションのコードだけになる(self, chart):
        table = json.loads(rg.prompt_chart(chart, only_section="S1"))["chords"]
        assert [row[0] for row in table["rows"]] == [1, 2, 3, 4]
        assert table["only_section"] == "S1"
        assert json.loads(rg.prompt_chart(chart, only_section="S2"))["chords"]["rows"] == []
        # セクションの一覧やキーは、絞っても全部渡す
        assert len(json.loads(rg.prompt_chart(chart, only_section="S2"))["sections"]) == 2

    def test_同じカルテからは同じバイト列(self, chart):
        """プロンプトキャッシュはプレフィックスのバイト一致が条件"""
        reordered = dict(reversed(list(chart.items())))
        assert rg.prompt_chart(chart) == rg.prompt_chart(reordered)
        assert rg.prompt_chart(chart) == rg.prompt_chart(json.loads(json.dumps(chart)))

    def test_元のカルテを書き換えない(self, chart):
        rg.prompt_chart(chart)
        assert len(chart["grid"]["beat_times_sec"]) == 32


class TestBuildRequest:
    def test_カルテはsystemの末尾に在り_キャッシュの区切りが付く(self, chart):
        request = rg.build_request(chart)
        system = request["system"]
        assert system[0]["text"] == rg.SYSTEM_PROMPT
        assert "cache_control" not in system[0]
        assert system[-1]["text"].startswith("<chart>\n")
        assert system[-1]["cache_control"] == {"type": "ephemeral"}

    def test_focusが変わってもキャッシュされる部分は変わらない(self, chart):
        """問い合わせごとに変わるものは、キャッシュの区切りより後ろに置く"""
        whole, focused = rg.build_request(chart), rg.build_request(chart, focus="S2")
        assert whole["system"] == focused["system"]
        assert whole["messages"] != focused["messages"]
        assert "S2" in focused["messages"][0]["content"]

    def test_出力の形に音符を入れる場所が無い(self, chart):
        """LLM は音符を 1 つも出力しない。形の上でも、説明文と場所への参照しか持てない"""
        schema = rg.build_request(chart)["output_config"]["format"]["schema"]
        step = schema["properties"]["steps"]["items"]
        assert set(step["properties"]) == {"title", "topic", "body", "refs"}
        assert set(step["properties"]["refs"]["items"]["properties"]) == {"section_id", "bar", "beat"}
        assert "notes" not in json.dumps(schema)

        def all_objects(node):
            if isinstance(node, dict):
                if node.get("type") == "object":
                    yield node
                for value in node.values():
                    yield from all_objects(value)
            elif isinstance(node, list):
                for value in node:
                    yield from all_objects(value)

        for obj in all_objects(schema):
            assert obj["additionalProperties"] is False
            assert set(obj["required"]) == set(obj["properties"])

    def test_モデルと各種の指定(self, chart, monkeypatch):
        monkeypatch.delenv("BUNRI_GUIDE_MODEL", raising=False)
        request = rg.build_request(chart)
        assert request["model"] == "claude-opus-5-5"
        assert request["output_config"]["effort"] == rg.EFFORT == "low"
        assert request["max_tokens"] == rg.MAX_TOKENS
        assert request["fallbacks"] == "default"
        assert request["betas"] == ["server-side-fallback-2026-07-01"]
        # このモデルは thinking を無効にできず、サンプリングの指定も受け付けない
        for key in ("thinking", "temperature", "top_p", "top_k"):
            assert key not in request

    def test_指示文は確信度を_与えられた3段階のまま言わせる(self):
        """段階はコードが決めて渡す。指示文にしきい値を書かない（LLM に数値を比べさせない）"""
        for word in ("確実", "たぶん", "自信なし"):
            assert word in rg.SYSTEM_PROMPT
        assert "その言い方のまま書く" in rg.SYSTEM_PROMPT
        assert "以上は" not in rg.SYSTEM_PROMPT
        assert "{" not in rg.SYSTEM_PROMPT and "}" not in rg.SYSTEM_PROMPT

    def test_モデルは環境変数で差し替えられる(self, chart, monkeypatch):
        monkeypatch.setenv("BUNRI_GUIDE_MODEL", "claude-sonnet-5-5")
        assert rg.build_request(chart)["model"] == "claude-sonnet-5-5"

    def test_カルテに無いセクションをfocusにできない(self, chart):
        with pytest.raises(rg.GuideError) as e:
            rg.build_request(chart, focus="S9")
        assert e.value.code == "invalid"

    def test_Haikuにはサーバ側のやり直しを付けない(self, chart):
        """Haiku にはサーバ側のフォールバックが無い"""
        request = rg.build_request(chart, model="claude-haiku-5-5")
        assert "fallbacks" not in request and "betas" not in request

    def test_キャッシュを壊す値が_区切りより前に入らない(self, chart, monkeypatch):
        """時刻・乱数・毎回変わる値が無いこと。何度組み立てても、時刻が変わっても、同じバイト列になる"""
        first = json.dumps(rg.build_request(chart), ensure_ascii=False, sort_keys=True)
        monkeypatch.setattr(time, "time", lambda: 9_999_999_999.0)
        again = json.dumps(rg.build_request(json.loads(json.dumps(chart))), ensure_ascii=False, sort_keys=True)
        assert first == again

    def test_キャッシュに関わる指定は_対象を変えても変わらない(self, chart):
        """モデル・思考の深さ・出力の形・thinking を呼び出しごとに変えると、キャッシュが効かなくなる"""
        whole, focused = rg.build_request(chart), rg.build_request(chart, focus="S1")
        for key in ("model", "max_tokens", "system", "output_config", "betas", "fallbacks"):
            assert whole[key] == focused[key]
        assert set(whole) == set(focused) == {"model", "max_tokens", "system", "messages", "output_config", "betas", "fallbacks"}

    def test_保持時間を1時間にすると区切りにttlが付く(self, chart, monkeypatch):
        monkeypatch.setattr(rg, "CACHE_TTL", "1h")
        assert rg.build_request(chart)["system"][-1]["cache_control"] == {"type": "ephemeral", "ttl": "1h"}
        monkeypatch.setattr(rg, "CACHE_TTL", None)
        assert "cache_control" not in rg.build_request(chart)["system"][-1]


class TestValidateGuide:
    def test_実在する参照はそのまま残る(self, chart):
        result = rg.validate_guide(_guide(), chart)
        assert result["dropped_refs"] == 0
        assert result["steps"][0]["refs"] == [{"section_id": None, "bar": 1, "beat": 1}]
        assert result["steps"][1]["refs"] == [{"section_id": "S2", "bar": None, "beat": None}]

    def test_カルテに無い場所への参照は落とす(self, chart):
        guide = _guide(steps=[{
            "title": "t", "topic": "chords", "body": "b",
            "refs": [
                {"section_id": "S9", "bar": None, "beat": None},   # 無いセクション
                {"section_id": None, "bar": 99, "beat": 1},        # 曲より先の小節
                {"section_id": None, "bar": 0, "beat": None},      # 0 小節目
                {"section_id": None, "bar": None, "beat": None},   # どこも指していない
                {"section_id": "S1", "bar": 2, "beat": None},      # これは実在する
            ],
        }])
        result = rg.validate_guide(guide, chart)
        assert result["steps"][0]["refs"] == [{"section_id": "S1", "bar": 2, "beat": None}]
        assert result["dropped_refs"] == 4

    def test_拍が範囲外なら拍だけ外す(self, chart):
        guide = _guide(steps=[{"title": "t", "topic": "grid", "body": "b",
                               "refs": [{"section_id": None, "bar": 3, "beat": 7}]}])
        assert rg.validate_guide(guide, chart)["steps"][0]["refs"] == [{"section_id": None, "bar": 3, "beat": None}]

    def test_知らない主題はgeneralにする(self, chart):
        guide = _guide(steps=[{"title": "t", "topic": "melody", "body": "b", "refs": []}])
        assert rg.validate_guide(guide, chart)["steps"][0]["topic"] == "general"

    @pytest.mark.parametrize("bad", [None, [], {"overview": "x"}, {"steps": "x"}, {"steps": ["x"]}])
    def test_形が違えば失敗(self, chart, bad):
        with pytest.raises(rg.GuideError) as e:
            rg.validate_guide(bad, chart)
        assert e.value.code == "invalid"


class TestUnverifiedTerms:
    def test_カルテに在るコードと主音は問題なし(self, chart):
        text = "キーは C メジャー（平行調は A マイナー）。C → G7 → Am → F と進みます。ルートは G です。"
        assert rg.unverified_terms(text, chart) == []

    def test_カルテに無いコードや音名を見つける(self, chart):
        text = "サビは Dm7 から E7 へ進み、メロディは E4 G4 C5 と上がります。"
        assert rg.unverified_terms(text, chart) == ["Dm7", "E7", "E4", "G4", "C5"]

    def test_英単語やBPMは拾わない(self, chart):
        text = "BPM は 120。Chorus の前に EQ で低域を整え、DAW の Bus にまとめます。LUFS は -9。"
        assert rg.unverified_terms(text, chart) == []

    def test_Aメロや繰り返しグループ名は拾わない(self, chart):
        assert rg.unverified_terms("A メロは静かに、Bメロで盛り上げます。グループ B は A の繰り返しです。", chart) == []
        chart["key"]["alternatives"] = []
        chart["sections"][0]["repeat_group"] = None
        assert rg.unverified_terms("Aメロは静かに始まります。", chart) == []

    def test_全角のシャープとフラットも同じに扱う(self, chart):
        chart["chords"].append(_chord(16, 5, "F#", "min", "F#m", "#iv", 0.7))
        assert rg.unverified_terms("F♯m のあと B♭ に進みます。", chart) == ["Bb"]

    def test_検証結果に載る(self, chart):
        guide = _guide(overview="D メジャーの曲です。")
        assert rg.validate_guide(guide, chart)["unverified_terms"] == ["D"]


class TestGenerate:
    def test_ガイドとモデルと使用量を返す(self, chart):
        client = FakeClient()
        result = rg.generate(chart, client=client)
        assert result["guide"]["overview"].startswith("キーは C メジャー")
        assert len(result["guide"]["steps"]) == 2
        assert result["model"] == "claude-opus-5-5"
        assert result["usage"]["cache_read_input_tokens"] == 1500
        assert result["usage"]["thinking_tokens"] == 120
        assert len(client.calls) == 1
        assert client.calls[0]["system"][-1]["text"].startswith("<chart>")

    def test_応答を断られたら説明つきで失敗(self, chart):
        with pytest.raises(rg.GuideError) as e:
            rg.generate(chart, client=FakeClient(stop_reason="refusal"))
        assert e.value.code == "refused"

    def test_途中で切れたら失敗(self, chart):
        with pytest.raises(rg.GuideError) as e:
            rg.generate(chart, client=FakeClient(stop_reason="max_tokens", text='{"overview": "キー'))
        assert e.value.code == "truncated"
        # 応答は返ってきているので、費用はかかっている。使用量を持たせて記録できるようにする
        assert e.value.usage["output_tokens"] == 300

    def test_JSONでなければ失敗(self, chart):
        with pytest.raises(rg.GuideError) as e:
            rg.generate(chart, client=FakeClient(text="すみません、できません"))
        assert e.value.code == "invalid"

    @pytest.mark.parametrize("error, code", [
        (TypeError("Could not resolve authentication method. Expected one of api_key, auth_token"), "no_key"),
        (_api_error(anthropic.AuthenticationError, 401), "auth"),
        (_api_error(anthropic.PermissionDeniedError, 403), "auth"),
        (_api_error(anthropic.RateLimitError, 429), "rate_limit"),
        (_api_error(anthropic.InternalServerError, 500), "api"),
        (_api_error(anthropic.BadRequestError, 400), "api"),
        (anthropic.APIConnectionError(request=httpx2.Request("POST", "https://api.anthropic.com/v1/messages")), "network"),
    ])
    def test_APIの失敗は利用者向けの文に直す(self, chart, error, code):
        with pytest.raises(rg.GuideError) as e:
            rg.generate(chart, client=FakeClient(error=error))
        assert e.value.code == code
        assert str(e.value)

    def test_関係ないTypeErrorは握りつぶさない(self, chart):
        with pytest.raises(TypeError):
            rg.generate(chart, client=FakeClient(error=TypeError("unexpected keyword argument")))


@pytest.fixture
def data_dir(monkeypatch, tmp_path):
    """保存先（ガイドの保存・使用量の記録・設定）を、テストごとの一時ディレクトリにする"""
    monkeypatch.setenv("BUNRI_DATA_DIR", str(tmp_path))
    monkeypatch.delenv("BUNRI_GUIDE_MODEL", raising=False)
    return tmp_path


class TestSavedGuide:
    """作ったガイドを保存し、同じ条件なら Claude を呼ばない"""

    @pytest.fixture(autouse=True)
    def clean(self, data_dir):
        yield

    def test_同じカルテ同じ対象の2回目は_APIを呼ばない(self, chart):
        client = FakeClient()
        first = rg.guide_for(chart, client=client)
        second = rg.guide_for(chart, client=client)
        assert len(client.calls) == 1
        assert first["cached"] is False and second["cached"] is True
        assert second["guide"] == first["guide"]
        assert second["created_at"] == first["created_at"]
        # 開き直したとき（保存済みの確認）も呼ばない
        assert rg.saved_guide(chart)["guide"] == first["guide"]
        assert len(client.calls) == 1

    def test_キーの順が違うだけの同じカルテは_同じものとして扱う(self, chart):
        client = FakeClient()
        rg.guide_for(chart, client=client)
        rg.guide_for(dict(reversed(list(chart.items()))), client=client)
        assert len(client.calls) == 1

    def test_対象が違えば別に作る(self, chart):
        client = FakeClient()
        rg.guide_for(chart, client=client)
        assert rg.saved_guide(chart, focus="S2") is None
        rg.guide_for(chart, focus="S2", client=client)
        rg.guide_for(chart, focus="S2", client=client)
        assert len(client.calls) == 2

    def test_カルテが変われば保存分を使わない(self, chart):
        client = FakeClient()
        rg.guide_for(chart, client=client)
        chart["grid"]["bpm"] = 121.0
        assert rg.saved_guide(chart) is None
        rg.guide_for(chart, client=client)
        assert len(client.calls) == 2

    def test_モデルが変われば保存分を使わない(self, chart, monkeypatch):
        client = FakeClient()
        rg.guide_for(chart, client=client)
        monkeypatch.setenv("BUNRI_GUIDE_MODEL", "claude-sonnet-5-5")
        assert rg.saved_guide(chart) is None
        rg.guide_for(chart, client=client)
        assert len(client.calls) == 2

    def test_版を上げると保存分を使わない(self, chart, monkeypatch):
        client = FakeClient()
        rg.guide_for(chart, client=client)
        monkeypatch.setattr(rg, "GUIDE_VERSION", rg.GUIDE_VERSION + 1)
        assert rg.saved_guide(chart) is None
        assert rg.guide_for(chart, client=client)["cached"] is False
        assert len(client.calls) == 2

    def test_指示文を変えると_版を上げ忘れても保存分を使わない(self, chart, monkeypatch):
        client = FakeClient()
        rg.guide_for(chart, client=client)
        monkeypatch.setattr(rg, "SYSTEM_PROMPT", rg.SYSTEM_PROMPT + "\n- 手順は短く書く。")
        assert rg.saved_guide(chart) is None
        rg.guide_for(chart, client=client)
        assert len(client.calls) == 2

    def test_出力の形を変えると保存分を使わない(self, chart, monkeypatch):
        client = FakeClient()
        rg.guide_for(chart, client=client)
        schema = json.loads(json.dumps(rg.GUIDE_SCHEMA))
        schema["properties"]["overview"]["description"] = "曲全体の作りを 1 文で。"
        monkeypatch.setattr(rg, "GUIDE_SCHEMA", schema)
        assert rg.saved_guide(chart) is None
        rg.guide_for(chart, client=client)
        assert len(client.calls) == 2

    def test_思考の深さを変えると保存分を使わない(self, chart, monkeypatch):
        client = FakeClient()
        rg.guide_for(chart, client=client)
        monkeypatch.setattr(rg, "EFFORT", "medium")
        assert rg.saved_guide(chart) is None

    def test_作り直すと_明示したときだけAPIを呼び_保存分を置き換える(self, chart):
        client = FakeClient()
        rg.guide_for(chart, client=client)
        client._guide = _guide(overview="作り直した説明です。")
        again = rg.guide_for(chart, regenerate=True, client=client)
        assert len(client.calls) == 2
        assert again["cached"] is False and again["guide"]["overview"] == "作り直した説明です。"
        assert rg.guide_for(chart, client=client)["guide"]["overview"] == "作り直した説明です。"
        assert len(client.calls) == 2

    def test_失敗した呼び出しは保存しない(self, chart):
        with pytest.raises(rg.GuideError):
            rg.guide_for(chart, client=FakeClient(stop_reason="refusal"))
        assert rg.saved_guide(chart) is None

    def test_壊れた保存ファイルは無いものとして扱う(self, chart):
        client = FakeClient()
        rg.guide_for(chart, client=client)
        for path in (guide_usage.log_path().parent / "cache").glob("*.json"):
            path.write_text("{ 壊れている", encoding="utf-8")
        assert rg.saved_guide(chart) is None
        rg.guide_for(chart, client=client)
        assert len(client.calls) == 2

    def test_同時に来た同じ依頼は_1回しか呼ばない(self, chart):
        """連打や二重送信で 2 回課金されない。あとから来たほうは、先のが終わるのを待って保存分を受け取る"""
        client = FakeClient(delay=0.3)
        results = []
        threads = [threading.Thread(target=lambda: results.append(rg.guide_for(chart, client=client))) for _ in range(4)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        assert len(client.calls) == 1
        assert sorted(r["cached"] for r in results) == [False, True, True, True]

    def test_作り直しの連打も_1回しか呼ばない(self, chart):
        client = FakeClient()
        rg.guide_for(chart, client=client)
        client._delay = 0.3
        threads = [threading.Thread(target=lambda: rg.guide_for(chart, regenerate=True, client=client)) for _ in range(3)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        assert len(client.calls) == 2

    def test_同じカルテの別の対象は_同時に走らせず順に通す(self, chart):
        """同時に送ると、互いのプロンプトキャッシュを読めず、両方が書き込みの料金を払う"""
        running, overlap = [], []

        class Watching(FakeClient):
            def _create(self, **kwargs):
                overlap.append(bool(running))
                running.append(1)
                try:
                    return super()._create(**kwargs)
                finally:
                    running.pop()

        client = Watching(delay=0.2)
        threads = [threading.Thread(target=lambda f=f: rg.guide_for(chart, focus=f, client=client)) for f in (None, "S1", "S2")]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        assert len(client.calls) == 3 and overlap == [False, False, False]


class TestDailyLimit:
    """1 日の上限。超えたら Claude を呼ばずに、理由を出す"""

    @pytest.fixture(autouse=True)
    def clean(self, data_dir):
        yield

    def test_回数の上限に達したら_APIを呼ばずに理由を返す(self, chart):
        guide_usage.update_settings({"daily_limit_calls": 2})
        client = FakeClient()
        rg.guide_for(chart, client=client)
        rg.guide_for(chart, focus="S1", client=client)
        with pytest.raises(rg.GuideError) as e:
            rg.guide_for(chart, focus="S2", client=client)
        assert e.value.code == "daily_limit"
        assert "上限（2 回）" in str(e.value)
        assert len(client.calls) == 2
        assert client.count_calls == []

    def test_上限に達していても_保存済みは見られる(self, chart):
        client = FakeClient()
        rg.guide_for(chart, client=client)
        guide_usage.update_settings({"daily_limit_calls": 1})
        assert rg.guide_for(chart, client=client)["cached"] is True
        with pytest.raises(rg.GuideError) as e:
            rg.guide_for(chart, regenerate=True, client=client)
        assert e.value.code == "daily_limit"
        assert len(client.calls) == 1

    def test_費用の上限に達したら_APIを呼ばない(self, chart):
        client = FakeClient()
        rg.guide_for(chart, client=client)
        spent = guide_usage.today()["cost_usd"]
        assert spent > 0
        guide_usage.update_settings({"daily_limit_calls": None, "daily_limit_usd": spent})
        with pytest.raises(rg.GuideError) as e:
            rg.guide_for(chart, focus="S1", client=client)
        assert e.value.code == "daily_limit" and "概算" in str(e.value)
        assert len(client.calls) == 1

    def test_上限なしにできる(self, chart):
        guide_usage.update_settings({"daily_limit_calls": None, "daily_limit_usd": None})
        client = FakeClient()
        for focus in (None, "S1", "S2"):
            rg.guide_for(chart, focus=focus, client=client)
        assert guide_usage.today()["blocked"] is None and len(client.calls) == 3

    def test_昨日のぶんは数えない(self, chart):
        guide_usage.update_settings({"daily_limit_calls": 1})
        client = FakeClient()
        rg.guide_for(chart, client=client)
        lines = guide_usage.log_path().read_text(encoding="utf-8").splitlines()
        record = json.loads(lines[0])
        record["ts"] = "2020-01-01T00:00:00+00:00"
        guide_usage.log_path().write_text(json.dumps(record) + "\n", encoding="utf-8")
        assert guide_usage.today()["calls"] == 0
        rg.guide_for(chart, focus="S1", client=client)
        assert len(client.calls) == 2

    def test_応答が返らなかった失敗は_回数に数えない(self, chart):
        """API キーの誤りや通信の失敗には費用がかからない"""
        with pytest.raises(rg.GuideError):
            rg.guide_for(chart, client=FakeClient(error=_api_error(anthropic.AuthenticationError, 401)))
        assert guide_usage.today()["calls"] == 0
        # 断られた・途中で切れた、は応答が返っていて費用がかかるので数える
        with pytest.raises(rg.GuideError):
            rg.guide_for(chart, client=FakeClient(stop_reason="max_tokens", text="{"))
        assert guide_usage.today()["calls"] == 1

    @pytest.mark.parametrize("bad", [
        {"daily_limit_calls": -1}, {"daily_limit_calls": 1.5}, {"daily_limit_calls": "3"}, {"daily_limit_calls": True},
        {"daily_limit_usd": -0.1}, {"max_input_tokens": 0}, {"max_input_tokens": None}, {"unknown": 1}, [],
    ])
    def test_不正な設定は受け付けない(self, bad):
        with pytest.raises(ValueError):
            guide_usage.update_settings(bad)
        assert guide_usage.settings() == guide_usage.DEFAULT_SETTINGS

    def test_設定は変えた項目だけが変わる(self):
        guide_usage.update_settings({"daily_limit_usd": 1.5})
        guide_usage.update_settings({"daily_limit_calls": 5})
        assert guide_usage.settings() == {**guide_usage.DEFAULT_SETTINGS, "daily_limit_usd": 1.5, "daily_limit_calls": 5}


class TestUsageLog:
    """呼び出しごとの使用量の記録"""

    @pytest.fixture(autouse=True)
    def clean(self, data_dir):
        yield

    def test_呼び出しごとに_4つの計器とモデルと所要時間と対象と成否を残す(self, chart):
        rg.guide_for(chart, focus="S2", client=FakeClient())
        (record,) = guide_usage.read_records()
        assert record["ok"] is True and record["error"] is None
        assert (record["input_tokens"], record["cache_creation_input_tokens"],
                record["cache_read_input_tokens"], record["output_tokens"]) == (12, 0, 1500, 300)
        assert record["thinking_tokens"] == 120
        assert record["model"] == "claude-opus-5-5" and record["requested_model"] == "claude-opus-5-5"
        assert record["effort"] == rg.EFFORT and record["cache_ttl"] == "5m"
        assert record["focus"] == "S2"
        assert record["chart"] == guide_cache.chart_hash(chart)[:16]
        assert isinstance(record["duration_sec"], float)
        assert record["ts"].endswith("+00:00")

    def test_保存分を返したときは記録しない(self, chart):
        client = FakeClient()
        rg.guide_for(chart, client=client)
        rg.guide_for(chart, client=client)
        assert len(guide_usage.read_records()) == 1

    def test_失敗も記録する(self, chart):
        with pytest.raises(rg.GuideError):
            rg.guide_for(chart, client=FakeClient(error=_api_error(anthropic.RateLimitError, 429)))
        with pytest.raises(rg.GuideError):
            rg.guide_for(chart, client=FakeClient(stop_reason="refusal"))
        first, second = guide_usage.read_records()
        assert (first["ok"], first["error"], first["output_tokens"], first["cost_usd"]) == (False, "rate_limit", None, None)
        assert (second["ok"], second["error"], second["output_tokens"]) == (False, "refused", 300)

    def test_記録に_カルテの中身もガイドの文もキーも入らない(self, chart, monkeypatch):
        secret = "sk-ant-secret-key-value"
        monkeypatch.setenv("ANTHROPIC_API_KEY", secret)
        chart["source"]["filename"] = "ひみつの曲.wav"
        guide = _guide(overview="この説明文は記録に残してはいけません。")
        rg.guide_for(chart, focus="S2", client=FakeClient(guide=guide))
        with pytest.raises(rg.GuideError):
            rg.guide_for(chart, focus="S1", client=FakeClient(guide=guide, stop_reason="max_tokens"))
        text = guide_usage.log_path().read_text(encoding="utf-8")
        records = guide_usage.read_records()
        assert len(records) == 2
        # 持つ項目は決まっている。文字列の項目は、種類・ID・時刻・指紋だけ
        for record in records:
            assert set(record) == set(guide_usage._RECORD_FIELDS)
            strings = {k: v for k, v in record.items() if isinstance(v, str)}
            assert set(strings) <= {"ts", "error", "model", "requested_model", "effort", "cache_ttl", "focus", "chart", "version"}
            assert all(len(v) <= 40 for v in strings.values())
        for leaked in (secret, "sk-ant", "ひみつの曲", "記録に残してはいけません", "テンポを合わせる", "G7", "Am",
                       "V7", "verse", "chorus", "song", "LUFS", "残響"):
            assert leaked not in text

    def test_概算の費用は_4つの計器をそれぞれの単価で足す(self):
        usage = {"input_tokens": 1_000_000, "cache_creation_input_tokens": 1_000_000,
                 "cache_read_input_tokens": 1_000_000, "output_tokens": 1_000_000}
        rates = guide_usage.pricing()["claude-opus-5-5"]
        assert guide_usage.estimate_cost("claude-opus-5-5", usage) == pytest.approx(
            rates["input"] + rates["cache_write_5m"] + rates["cache_read"] + rates["output"])
        assert guide_usage.estimate_cost("claude-opus-5-5", usage, cache_ttl="1h") == pytest.approx(
            rates["input"] + rates["cache_write_1h"] + rates["cache_read"] + rates["output"])
        # 日付つきの ID は前方一致で引く。表に無いモデルは、当て推量をせず「分からない」にする
        assert guide_usage.estimate_cost("claude-opus-5-5-20270101", usage) is not None
        assert guide_usage.estimate_cost("some-other-model", usage) is None
        assert guide_usage.estimate_cost("claude-opus-5-5", {"output_tokens": 4000, "input_tokens": None}) == pytest.approx(4000 * rates["output"] / 1e6)

    def test_単価は設定で上書きできる(self):
        guide_usage.settings_path().write_text(
            json.dumps({"pricing": {"claude-opus-5-5": {"output": 100.0}, "new-model": {"input": 1.0, "output": 2.0}}}),
            encoding="utf-8")
        assert guide_usage.estimate_cost("claude-opus-5-5", {"output_tokens": 1_000_000}) == pytest.approx(100.0)
        assert guide_usage.estimate_cost("new-model", {"input_tokens": 1_000_000}) == pytest.approx(1.0)

    def test_間隔の分布と_保持時間ごとの入力の費用を出す(self):
        """キャッシュの保持時間（なし / 5 分 / 1 時間）を、実際の使われ方から決めるための材料"""
        def call(minute, chart="aaaa", prefix=1_000_000):
            return {"ts": f"2026-11-11T{minute // 60:02d}:{minute % 60:02d}:40+00:00", "duration_sec": 40.0,
                    "model": "claude-opus-5-5", "requested_model": "claude-opus-5-5", "effort": "medium",
                    "chart": chart, "version": "v", "cache_creation_input_tokens": prefix, "cache_read_input_tokens": 0,
                    "input_tokens": 20, "output_tokens": 4000}

        # 同じカルテに 0 分・3 分・23 分・123 分、別のカルテに 5 分。失敗（トークンなし）は数えない
        records = [call(0), call(3), call(23), call(123), call(5, chart="bbbb"),
                   {"ts": "2026-11-11T00:10:00+00:00", "model": "claude-opus-5-5", "chart": "aaaa"}]
        report = guide_usage.cache_report(records)
        assert report["calls"] == 5
        assert report["gaps"] == {"first": 2, "under_5m": 1, "5m_to_1h": 1, "over_1h": 1}
        rates = guide_usage.pricing()["claude-opus-5-5"]
        assert report["input_cost_usd"] == {
            "none": pytest.approx(5 * rates["input"]),
            # 5 分: 3 分後だけ読める。あとは書き直し
            "5m": pytest.approx(4 * rates["cache_write_5m"] + rates["cache_read"]),
            # 1 時間: 3 分後と 23 分後が読める
            "1h": pytest.approx(3 * rates["cache_write_1h"] + 2 * rates["cache_read"]),
        }
        assert guide_usage.cache_report([])["calls"] == 0

    def test_単価の表に_既定のモデルが載っている(self):
        """既定のモデルを変えたのに単価を足し忘れると、費用の概算も費用の上限も働かなくなる"""
        assert set(guide_usage.pricing()[llm_settings.DEFAULT_MODEL]) >= {
            "input", "cache_write_5m", "cache_write_1h", "cache_read", "output"}


class TestInputGate:
    """送る前に入力の量を確かめる。長すぎるカルテは、黙って切らずに知らせる"""

    @pytest.fixture(autouse=True)
    def clean(self, data_dir):
        yield

    @pytest.fixture
    def long_chart(self, chart):
        """コードが 1 拍ずつ並ぶ、長い曲のカルテ（200 小節、セクション 2 つ）"""
        chart["chords"] = [
            {**_chord(i, i // 4 + 1, "C", "maj", "C", "I", 0.9), "beat": i % 4 + 1, "beat_count": 1}
            for i in range(800)
        ]
        chart["sections"][0].update(start_bar=1, end_bar=100)
        chart["sections"][1].update(start_bar=101, end_bar=200)
        return chart

    def test_短いカルテは_数えずに送る(self, chart):
        client = FakeClient()
        rg.guide_for(chart, client=client)
        assert client.count_calls == [] and len(client.calls) == 1

    def test_上限を超える曲全体は_APIを呼ばずに_絞るよう知らせる(self, long_chart):
        guide_usage.update_settings({"max_input_tokens": 5000})
        client = FakeClient(tokens=9000)
        with pytest.raises(rg.GuideError) as e:
            rg.guide_for(long_chart, client=client)
        assert e.value.code == "too_long"
        assert "9,000" in str(e.value) and "5,000" in str(e.value) and "セクションを選んで" in str(e.value)
        assert client.calls == [] and len(client.count_calls) == 1
        assert guide_usage.read_records() == []

    def test_数えて収まるなら_そのまま送る(self, long_chart):
        guide_usage.update_settings({"max_input_tokens": 5000})
        client = FakeClient(tokens=4000)
        rg.guide_for(long_chart, client=client)
        assert len(client.calls) == 1
        assert len(json.loads(client.calls[0]["system"][-1]["text"][len("<chart>\n"):-len("\n</chart>")])["chords"]["rows"]) == 800

    def test_セクションに絞ると_そのセクションのコードだけを送る(self, long_chart):
        guide_usage.update_settings({"max_input_tokens": 5000})

        def tokens(kwargs):
            return 9000 if '"only_section"' not in kwargs["system"][-1]["text"] else 4500

        client = FakeClient(tokens=tokens)
        rg.guide_for(long_chart, focus="S2", client=client)
        sent = json.loads(client.calls[0]["system"][-1]["text"][len("<chart>\n"):-len("\n</chart>")])
        assert sent["chords"]["only_section"] == "S2"
        assert {row[0] for row in sent["chords"]["rows"]} == set(range(101, 201))
        assert "S2" in client.calls[0]["messages"][0]["content"]

    def test_絞っても超えるなら_APIを呼ばずに知らせる(self, long_chart):
        guide_usage.update_settings({"max_input_tokens": 3000})
        client = FakeClient(tokens=9000)
        with pytest.raises(rg.GuideError) as e:
            rg.guide_for(long_chart, focus="S2", client=client)
        assert e.value.code == "too_long" and "このセクションだけでも" in str(e.value)
        assert client.calls == []


class TestMaterialShortage:
    """解析できた項目がほとんど無いカルテでは、Claude を呼ばずに短く断る"""

    @pytest.fixture(autouse=True)
    def clean(self, data_dir):
        yield

    @pytest.fixture
    def empty_chart(self):
        """無音を解析したときのカルテ（どの項目も検出できていない）"""
        return {
            "version": 1, "source": {"filename": "silence.wav", "duration_sec": 6.0},
            "grid": {"bpm": 120.0, "bpm_confidence": 0.0, "bpm_source": "auto", "downbeat_offset_sec": 0.0,
                     "time_signature": [4, 4], "beat_times_sec": [], "user_confirmed": False},
            "key": {"tonic": None, "mode": None, "confidence": 0.0, "alternatives": []},
            "sections": [], "chords": [],
            "mix": {"loudness_lufs": None, "peak_dbfs": None, "dynamic_range_db": None, "stereo_width": None,
                    "bass_mono": None, "reverb_tail_sec": None, "spectrum_bands": []},
            "unavailable": {"grid": "ビートを検出できませんでした", "key": "キーを判定できませんでした",
                            "chords": "コードを検出できませんでした", "sections": "構成を検出できませんでした",
                            "mix": "ミックス特性を解析できませんでした"},
        }

    def test_材料が無ければ_APIを呼ばずに理由を返す(self, empty_chart):
        client = FakeClient()
        with pytest.raises(rg.GuideError) as e:
            rg.guide_for(empty_chart, client=client)
        assert e.value.code == "no_material"
        assert "ほとんど解析できませんでした" in str(e.value) and "コード" in str(e.value)
        assert client.calls == [] and guide_usage.read_records() == []

    def test_1項目だけでも足りない(self, empty_chart):
        empty_chart["mix"]["loudness_lufs"] = -12.0
        assert rg.material_shortage(empty_chart) is not None

    def test_テンポと構成が在れば作る(self, empty_chart):
        """打楽器だけの曲など。キーやコードが無くても、テンポと構成の手順は書ける"""
        empty_chart["grid"]["bpm_confidence"] = 0.8
        del empty_chart["unavailable"]["grid"]
        empty_chart["sections"] = [{"id": "S1", "start_bar": 1, "end_bar": 4}]
        assert rg.material_shortage(empty_chart) is None

    def test_ふつうのカルテは足りている(self, chart):
        assert rg.material_shortage(chart) is None


@pytest.fixture
def no_keys(monkeypatch, tmp_path):
    """API キーがどこにも無い状態にする（手元の .env や環境変数を読ませない）"""
    llm_settings.clear_api_key()
    for name in ("ANTHROPIC_API_KEY", "CLAUDE_API_KEY", "ANTHROPIC_AUTH_TOKEN"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(llm_settings, "_dotenv_path", lambda: tmp_path / "no-such.env")
    yield tmp_path
    llm_settings.clear_api_key()


class TestLlmSettings:
    @pytest.fixture(autouse=True)
    def clean(self, no_keys):
        yield

    def test_何も無ければnone(self):
        assert llm_settings.api_key() is None
        assert llm_settings.status() == {"has_key": False, "key_source": "none", "model": llm_settings.model()}

    def test_環境変数は呼び出しのたびに読む(self, monkeypatch):
        """import 時に固めない。起動後に設定されたキーを拾えること"""
        assert llm_settings.api_key() is None
        monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-env")
        assert llm_settings.api_key() == "sk-env"
        assert llm_settings.key_source() == "env"

    def test_設定画面のキーが環境変数より優先(self, monkeypatch):
        monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-env")
        llm_settings.set_api_key("  sk-settings \n")
        assert llm_settings.api_key() == "sk-settings"
        assert llm_settings.key_source() == "settings"
        llm_settings.clear_api_key()
        assert llm_settings.api_key() == "sk-env"

    @pytest.mark.parametrize("bad", ["", "   ", "sk\nx", "sk\x00x", None, 123])
    def test_不正なキーは受け付けない(self, bad):
        with pytest.raises(ValueError):
            llm_settings.set_api_key(bad)
        assert llm_settings.api_key() is None

    def test_状態にキーそのものは含めない(self):
        llm_settings.set_api_key("sk-secret-value")
        assert "sk-secret-value" not in json.dumps(llm_settings.status())

    def test_クライアントは設定されたキーで作る(self):
        llm_settings.set_api_key("sk-settings")
        assert llm_settings.make_client().api_key == "sk-settings"

    def test_CLAUDE_API_KEYという名前でも読む(self, monkeypatch):
        monkeypatch.setenv("CLAUDE_API_KEY", "sk-claude")
        assert llm_settings.api_key() == "sk-claude"
        assert llm_settings.key_source() == "env"
        # 両方在れば ANTHROPIC_API_KEY を使う
        monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-anthropic")
        assert llm_settings.api_key() == "sk-anthropic"


class TestDotenv:
    """開発時に、リポジトリ直下の .env から API キーを読む"""

    @pytest.fixture(autouse=True)
    def clean(self, no_keys):
        yield

    def _write(self, monkeypatch, tmp_path, text):
        path = tmp_path / ".env"
        path.write_text(text, encoding="utf-8")
        monkeypatch.setattr(llm_settings, "_dotenv_path", lambda: path)
        return path

    def test_envファイルのキーを読む(self, monkeypatch, tmp_path):
        self._write(monkeypatch, tmp_path, "CLAUDE_API_KEY=sk-from-file\n")
        assert llm_settings.api_key() == "sk-from-file"
        assert llm_settings.status()["key_source"] == "env"

    def test_引用符とexportとコメントを扱う(self, monkeypatch, tmp_path):
        self._write(monkeypatch, tmp_path, '# comment\n\nOTHER=x\nexport ANTHROPIC_API_KEY="sk-quoted"\n')
        assert llm_settings.api_key() == "sk-quoted"
        self._write(monkeypatch, tmp_path, "CLAUDE_API_KEY = 'sk-single'\n")
        assert llm_settings.api_key() == "sk-single"

    def test_両方の名前が在ればANTHROPIC_API_KEYを使う(self, monkeypatch, tmp_path):
        self._write(monkeypatch, tmp_path, "CLAUDE_API_KEY=sk-claude\nANTHROPIC_API_KEY=sk-anthropic\n")
        assert llm_settings.api_key() == "sk-anthropic"

    def test_環境変数と設定画面のキーが優先(self, monkeypatch, tmp_path):
        self._write(monkeypatch, tmp_path, "CLAUDE_API_KEY=sk-from-file\n")
        monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-env")
        assert llm_settings.api_key() == "sk-env"
        llm_settings.set_api_key("sk-settings")
        assert llm_settings.api_key() == "sk-settings"

    @pytest.mark.parametrize("text", ["", "CLAUDE_API_KEY=\n", "OTHER=sk-x\n", "not a dotenv line\n"])
    def test_キーが無ければNone(self, monkeypatch, tmp_path, text):
        self._write(monkeypatch, tmp_path, text)
        assert llm_settings.api_key() is None
        assert llm_settings.key_source() == "none"

    def test_ファイルが無くても失敗しない(self):
        assert llm_settings.api_key() is None

    def test_状態にキーそのものは含めない(self, monkeypatch, tmp_path):
        self._write(monkeypatch, tmp_path, "CLAUDE_API_KEY=sk-secret-in-file\n")
        assert "sk-secret-in-file" not in json.dumps(llm_settings.status())


class TestApi:
    @pytest.fixture(autouse=True)
    def clean(self, monkeypatch, tmp_path, no_keys):
        monkeypatch.setenv("BUNRI_DATA_DIR", str(tmp_path))
        yield

    @pytest.fixture
    def client(self):
        from web.api import app

        return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")

    @pytest.fixture
    def saved_chart(self, chart):
        """カルテを .bunri として保存しておく"""
        import audio_utils
        import bunri_file

        bunri_file.create(audio_utils.results_dir("charts") / "song.bunri", chart)
        return "song"

    @pytest.mark.asyncio
    async def test_キーの設定と削除(self, client):
        assert (await client.get("/api/settings/llm")).json()["key_source"] == "none"
        resp = await client.post("/api/settings/anthropic-key", data={"key": "sk-abc"})
        assert resp.status_code == 200
        assert resp.json()["key_source"] == "settings"
        assert "sk-abc" not in resp.text
        assert llm_settings.api_key() == "sk-abc"
        resp = await client.delete("/api/settings/anthropic-key")
        assert resp.json()["has_key"] is False

    @pytest.mark.asyncio
    async def test_不正なキーは400(self, client):
        resp = await client.post("/api/settings/anthropic-key", data={"key": "   "})
        assert resp.status_code == 400

    @pytest.mark.asyncio
    async def test_ガイドを作って返す(self, client, saved_chart, monkeypatch):
        fake = FakeClient()
        monkeypatch.setattr(llm_settings, "make_client", lambda: fake)
        resp = await client.post(f"/api/chart/{saved_chart}/guide", data={"focus": "S2"})
        assert resp.status_code == 200
        body = resp.json()
        assert body["chart_id"] == "song" and body["focus"] == "S2"
        assert body["guide"]["steps"][1]["refs"] == [{"section_id": "S2", "bar": None, "beat": None}]
        assert "S2" in fake.calls[0]["messages"][0]["content"]

    @pytest.mark.asyncio
    async def test_2回目に開いたとき_APIを呼ばずに保存済みを返す(self, client, saved_chart, monkeypatch):
        fake = FakeClient()
        monkeypatch.setattr(llm_settings, "make_client", lambda: fake)
        # まだ作っていない
        body = (await client.get(f"/api/chart/{saved_chart}/guide")).json()
        assert body["saved"] is False and "guide" not in body
        assert body["today"]["calls"] == 0
        # 作る
        made = (await client.post(f"/api/chart/{saved_chart}/guide")).json()
        assert made["cached"] is False and made["today"]["calls"] == 1
        assert made["cost_usd"] == pytest.approx(guide_usage.estimate_cost("claude-opus-5-5", made["usage"]))
        # 開き直す: 保存済みが返る。もう一度「作る」を押しても呼ばない
        body = (await client.get(f"/api/chart/{saved_chart}/guide")).json()
        assert body["saved"] is True and body["cached"] is True
        assert body["guide"] == made["guide"] and body["created_at"] == made["created_at"]
        again = (await client.post(f"/api/chart/{saved_chart}/guide")).json()
        assert again["cached"] is True and again["today"]["calls"] == 1
        assert len(fake.calls) == 1
        # 対象が違えば、まだ無い
        assert (await client.get(f"/api/chart/{saved_chart}/guide", params={"focus": "S2"})).json()["saved"] is False
        # 明示的に作り直したときだけ呼ぶ
        redo = (await client.post(f"/api/chart/{saved_chart}/guide", data={"regenerate": "true"})).json()
        assert redo["cached"] is False and len(fake.calls) == 2

    @pytest.mark.asyncio
    async def test_上限を超えたら_APIを呼ばずに429で理由を返す(self, client, saved_chart, monkeypatch):
        fake = FakeClient()
        monkeypatch.setattr(llm_settings, "make_client", lambda: fake)
        resp = await client.post("/api/settings/guide", json={"daily_limit_calls": 0})
        assert resp.status_code == 200 and resp.json()["settings"]["daily_limit_calls"] == 0
        resp = await client.post(f"/api/chart/{saved_chart}/guide")
        assert resp.status_code == 429
        assert resp.json()["detail"]["code"] == "daily_limit"
        assert "上限" in resp.json()["detail"]["message"]
        assert fake.calls == []
        assert (await client.get("/api/settings/guide")).json()["today"]["blocked"]

    @pytest.mark.asyncio
    async def test_設定の不正な値は400(self, client):
        assert (await client.post("/api/settings/guide", json={"daily_limit_calls": -3})).status_code == 400
        assert (await client.post("/api/settings/guide", json={"nope": 1})).status_code == 400
        body = (await client.get("/api/settings/guide")).json()
        assert body["settings"] == guide_usage.DEFAULT_SETTINGS

    @pytest.mark.asyncio
    async def test_キーが無ければ401で理由を返す(self, client, saved_chart, monkeypatch):
        error = TypeError("Could not resolve authentication method. Expected one of api_key, auth_token")
        monkeypatch.setattr(llm_settings, "make_client", lambda: FakeClient(error=error))
        resp = await client.post(f"/api/chart/{saved_chart}/guide")
        assert resp.status_code == 401
        assert resp.json()["detail"]["code"] == "no_key"

    @pytest.mark.asyncio
    async def test_無いカルテは404_無いセクションは400(self, client, saved_chart, monkeypatch):
        monkeypatch.setattr(llm_settings, "make_client", lambda: FakeClient())
        assert (await client.post("/api/chart/nope/guide")).status_code == 404
        assert (await client.get("/api/chart/nope/guide")).status_code == 404
        resp = await client.post(f"/api/chart/{saved_chart}/guide", data={"focus": "S9"})
        assert resp.status_code == 400
        assert resp.json()["detail"]["code"] == "invalid"
        assert (await client.get(f"/api/chart/{saved_chart}/guide", params={"focus": "S9"})).status_code == 400
