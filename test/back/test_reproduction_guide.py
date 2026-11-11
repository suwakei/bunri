"""再現ガイド（第2層）のテスト

Claude は呼ばず、クライアントを差し替えて確かめる。

- リクエストの形: カルテがキャッシュされる位置に在る、音符を返させない出力形式になっている
- 出力の検証: カルテに無い場所への参照を落とす、カルテに無い音名・コード名を見つける
- 失敗の扱い: API キーが無い・正しくない、応答を断られた、途中で切れた
"""
import json
from types import SimpleNamespace

import anthropic
import httpx2
import pytest
from httpx import ASGITransport, AsyncClient

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
    """``client.beta.messages.create`` だけを持つ、差し替え用のクライアント"""

    def __init__(self, guide=None, stop_reason="end_turn", error=None, text=None):
        self.calls = []
        self._guide = guide if guide is not None else _guide()
        self._stop_reason = stop_reason
        self._error = error
        self._text = text
        self.beta = SimpleNamespace(messages=SimpleNamespace(create=self._create))

    def _create(self, **kwargs):
        self.calls.append(kwargs)
        if self._error is not None:
            raise self._error
        text = self._text if self._text is not None else json.dumps(self._guide, ensure_ascii=False)
        return SimpleNamespace(
            stop_reason=self._stop_reason,
            content=[SimpleNamespace(type="thinking", thinking=""), SimpleNamespace(type="text", text=text)],
            model="claude-opus-5-5",
            usage=SimpleNamespace(input_tokens=12, output_tokens=300,
                                  cache_read_input_tokens=1500, cache_creation_input_tokens=0),
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
        assert len(slim["chords"]) == 4

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
        assert request["output_config"]["effort"] == "medium"
        assert request["fallbacks"] == "default"
        assert request["betas"] == ["server-side-fallback-2026-07-01"]
        # このモデルは thinking を無効にできず、サンプリングの指定も受け付けない
        for key in ("thinking", "temperature", "top_p", "top_k"):
            assert key not in request

    def test_モデルは環境変数で差し替えられる(self, chart, monkeypatch):
        monkeypatch.setenv("BUNRI_GUIDE_MODEL", "claude-sonnet-5-5")
        assert rg.build_request(chart)["model"] == "claude-sonnet-5-5"

    def test_カルテに無いセクションをfocusにできない(self, chart):
        with pytest.raises(rg.GuideError) as e:
            rg.build_request(chart, focus="S9")
        assert e.value.code == "invalid"


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


class TestLlmSettings:
    @pytest.fixture(autouse=True)
    def clean(self, monkeypatch):
        llm_settings.clear_api_key()
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
        monkeypatch.delenv("ANTHROPIC_AUTH_TOKEN", raising=False)
        yield
        llm_settings.clear_api_key()

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


class TestApi:
    @pytest.fixture(autouse=True)
    def clean(self, monkeypatch, tmp_path):
        llm_settings.clear_api_key()
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
        monkeypatch.delenv("ANTHROPIC_AUTH_TOKEN", raising=False)
        monkeypatch.setenv("BUNRI_DATA_DIR", str(tmp_path))
        yield
        llm_settings.clear_api_key()

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
        resp = await client.post(f"/api/chart/{saved_chart}/guide", data={"focus": "S9"})
        assert resp.status_code == 400
        assert resp.json()["detail"]["code"] == "invalid"
