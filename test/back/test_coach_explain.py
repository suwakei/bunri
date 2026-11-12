"""差分コーチの言語化（第3層。coach_explain）のテスト

Claude は呼ばず、クライアントを差し替えて確かめる（再現ガイドのテストと同じやり方）。

- 事実の組み立て: 指摘の ID、件数の偏り、渡す件数の上限、カルテとの突き合わせ（秒で当てる）
- リクエストの形: 事実は user に在り、音符を返させない出力形式になっている
- 出力の検証: 事実に無い指摘・小節への参照を落とす、事実に無い音を書いた点を落とす
- 費用: 同じ事実なら API を呼ばない、違いが無い・少ないときは API を呼ばない、
  上限は再現ガイドと同じ 1 つの枠、使用量の記録に中身とキーが入らない
"""
import json
import threading
import time
from types import SimpleNamespace

import anthropic
import httpx2
import pytest
from httpx import ASGITransport, AsyncClient

import coach_diff
import coach_explain as ce
import guide_usage
import llm_settings
import reproduction_guide as rg


def n(note, octave, step, length=4):
    return {"note": note, "octave": octave, "step": step, "length": length}


# お手本: 2 小節のベース。1 小節目 C2 E2 G2 C3、2 小節目 G2 B2 D3 G3（4 分音符）
REFERENCE = [n("C", 2, 0), n("E", 2, 4), n("G", 2, 8), n("C", 3, 12),
             n("G", 2, 16), n("B", 2, 20), n("D", 3, 24), n("G", 3, 28)]
# 打ち込み。指摘は 10 件:
#   i1 位置のずれ C2（1 小節 1 拍）   i2 抜け E2      i3 余分 G2      i4 長さ G2      i5 抜け C3
#   i6 オクターブ G2→G3（2 小節 1 拍） i7 高さの違い B2→A#2  i8 抜け D3  i9 抜け G3  i10 余分 F4
ATTEMPT = [n("C", 2, 1), n("G", 2, 4), n("G", 2, 8, 2), n("G", 3, 16), n("A#", 2, 20), n("F", 4, 30)]


@pytest.fixture
def facts():
    return ce.build_facts(REFERENCE, ATTEMPT)


def _point(**overrides):
    point = {
        "title": "2 小節目の音の高さ",
        "observation": "2 小節目で、お手本の B2 に対して打ち込みは A#2、お手本の G2 に対して G3 になっています。",
        "cause": "半音だけ低い音は、聴き取りで隣の音と取り違えたのかもしれません。",
        "fix": "お手本を重ねて表示し、2 小節目の 1〜2 拍目の高さを見比べます。",
        "issue_ids": ["i7", "i6"],
        "bars": [2],
    }
    point.update(overrides)
    return point


def _raw(**overrides):
    """LLM が返す形の説明"""
    raw = {
        "summary": "お手本 8 音のうち合っているのは 25% で、抜けが 4 か所と最も多い状態です。",
        "points": [
            _point(),
            _point(title="抜けている音", observation="1 小節目と 2 小節目で、合わせて 4 音が抜けています。",
                   cause="この結果からは理由を言えません。", fix="お手本を重ねて表示し、1 小節目から順に見比べます。",
                   issue_ids=["i2", "i5"], bars=[1, 2]),
        ],
        "next_step": "まず 2 小節目を開いて、お手本と高さを見比べます。",
        "next_step_bar": 2,
    }
    raw.update(overrides)
    return raw


class FakeClient:
    """差し替え用のクライアント。``calls`` が、Claude を呼んだ回数（= 費用がかかった回数）になる

    再現ガイドのテストの ``FakeClient`` と同じ作り。``client.beta.messages.create`` と
    ``client.messages.count_tokens`` だけを持つ。
    """

    def __init__(self, payload=None, stop_reason="end_turn", error=None, text=None, delay=0.0, tokens=1000):
        self.calls = []
        self.count_calls = []
        self._payload = payload if payload is not None else _raw()
        self._stop_reason = stop_reason
        self._error = error
        self._text = text
        self._delay = delay
        self._tokens = tokens
        self.beta = SimpleNamespace(messages=SimpleNamespace(create=self._create))
        self.messages = SimpleNamespace(count_tokens=self._count_tokens)

    def _count_tokens(self, **kwargs):
        self.count_calls.append(kwargs)
        return SimpleNamespace(input_tokens=self._tokens)

    def _create(self, **kwargs):
        self.calls.append(kwargs)
        if self._delay:
            time.sleep(self._delay)
        if self._error is not None:
            raise self._error
        text = self._text if self._text is not None else json.dumps(self._payload, ensure_ascii=False)
        return SimpleNamespace(
            stop_reason=self._stop_reason,
            content=[SimpleNamespace(type="thinking", thinking=""), SimpleNamespace(type="text", text=text)],
            model="claude-opus-5-5",
            usage=SimpleNamespace(input_tokens=900, output_tokens=300,
                                  cache_read_input_tokens=2500, cache_creation_input_tokens=0,
                                  output_tokens_details=SimpleNamespace(thinking_tokens=120)),
        )


def _api_error(cls, status):
    """SDK の例外を作る"""
    request = httpx2.Request("POST", "https://api.anthropic.com/v1/messages")
    return cls("error", response=httpx2.Response(status, request=request), body=None)


def _sent_facts(call):
    """偽のクライアントが受け取ったリクエストから、事実の JSON を取り出す"""
    content = call["messages"][0]["content"]
    return json.loads(content[len("<facts>\n"):content.index("\n</facts>")])


def _rows(facts, *names):
    """指摘の表から、指定した列だけを取り出す"""
    at = [facts["issues"]["columns"].index(name) for name in names]
    return [[row[i] for i in at] for row in facts["issues"]["rows"]]


@pytest.fixture
def chart():
    """お手本と同じ曲のカルテ。1 拍目が 2.0 秒に在る（= カルテの 1 小節目は、ピアノロールの 2 小節目）

    120 BPM なら、ピアノロールの 1 小節は 2 秒、1 ステップは 0.125 秒。
    """
    def chord(bar, root, quality, symbol, degree, confidence):
        start = 2.0 + (bar - 1) * 2.0
        return {"beat_index": (bar - 1) * 4, "beat_count": 4, "bar": bar, "beat": 1, "start_sec": start,
                "end_sec": start + 2.0, "root": root, "quality": quality, "symbol": symbol, "degree": degree,
                "confidence": confidence}

    return {
        "version": 1,
        "source": {"filename": "ひみつの曲.wav", "duration_sec": 12.0},
        "grid": {"bpm": 120.0, "bpm_confidence": 0.9, "bpm_source": "auto", "downbeat_offset_sec": 2.0,
                 "time_signature": [4, 4], "beat_times_sec": [2.0 + i * 0.5 for i in range(20)],
                 "user_confirmed": False},
        "key": {"tonic": "C", "mode": "major", "confidence": 0.5, "alternatives": []},
        "sections": [
            {"id": "S1", "label": None, "suggested_label": "verse", "suggested_confidence": 0.6,
             "start_bar": 1, "end_bar": 2, "start_sec": 2.0, "end_sec": 6.0, "repeat_group": "A"},
            {"id": "S2", "label": "サビ", "suggested_label": "chorus", "suggested_confidence": 0.3,
             "start_bar": 3, "end_bar": 4, "start_sec": 6.0, "end_sec": 10.0, "repeat_group": "B"},
        ],
        "chords": [chord(1, "G", "7", "G7", "V7", 0.9), chord(2, "A", "min", "Am", "vi", 0.3)],
        "mix": {"loudness_lufs": -9.0},
        "unavailable": {},
    }


class TestBuildFacts:
    def test_指摘のIDは_差分の結果を上から数えた番号(self, facts):
        """画面は /api/coach/diff の結果を同じ順に数えれば、同じ ID になる"""
        diff = coach_diff.diff_notes(REFERENCE, ATTEMPT)
        flat = [issue for bar in diff["bars"] for issue in bar["issues"]]
        assert [row[0] for row in facts["issues"]["rows"]] == [f"i{i + 1}" for i in range(len(flat))]
        for row, issue in zip(_rows(facts, "bar", "beat", "kind"), flat):
            assert row == [issue["bar"], issue["beat"], issue["kind"]]
        assert facts["issues"]["total"] == 10

    def test_音は名前で_半音の差は計算して渡す(self, facts):
        """半音を数えるのは機械的に決まる計算。LLM にさせない"""
        rows = {row[0]: row for row in _rows(facts, "id", "kind", "expected", "actual", "semitones",
                                             "offset_steps", "length_diff")}
        assert rows["i7"] == ["i7", "pitch", "B2", "A#2", -1, 0, 0]
        assert rows["i6"] == ["i6", "octave", "G2", "G3", 12, 0, 0]
        assert rows["i2"] == ["i2", "missing", "E2", None, None, None, None]
        assert rows["i10"] == ["i10", "extra", None, "F4", None, None, None]
        assert rows["i1"] == ["i1", "timing", "C2", "C2", None, 1, 0]
        assert rows["i4"] == ["i4", "length", "G2", "G2", None, 0, -2]

    def test_全体の件数と_割合は百分率で渡す(self, facts):
        assert facts["summary"] == {"reference_count": 8, "attempt_count": 6, "exact": 0, "missing": 4, "pitch": 1,
                                    "octave": 1, "extra": 2, "timing": 1, "length": 1, "accuracy_percent": 25}
        assert facts["worst_bars"] == [2, 1]
        assert facts["grid"] == {"steps_per_bar": 16, "steps_per_beat": 4, "timing_tolerance": 2, "bar_count": 2}

    def test_種類ごとの偏りを数える(self, facts):
        """遅れがちか、拍の頭で抜けているか、は数えれば決まる"""
        assert facts["tendencies"] == {
            "timing": {"late": 1, "early": 0, "mean_offset_steps": 1.0},
            "length": {"longer": 0, "shorter": 1},
            "pitch": {"higher": 0, "lower": 1, "by_semitones": {"-1": 1}},
            "octave": {"higher": 1, "lower": 0},
            "missing": {"on_beat": 4, "off_beat": 0, "by_beat": {"2": 1, "3": 1, "4": 2}},
            "extra": {"on_beat": 1, "off_beat": 1, "by_beat": {"2": 1, "4": 1}},
        }

    def test_小節ごとの件数の表(self, facts):
        assert facts["bars"] == {"columns": ["bar", "missing", "pitch", "octave", "extra", "timing", "length"],
                                 "rows": [[1, 2, 0, 0, 1, 1, 1], [2, 2, 1, 1, 1, 0, 0]], "total": 2}

    def test_同じノートからは_同じバイト列(self):
        """保存した説明の鍵になる。ノートの並びやキーの順が違っても変わらない"""
        shuffled = [dict(reversed(list(note.items()))) for note in reversed(ATTEMPT)]
        first = ce.prompt_facts(ce.build_facts(REFERENCE, ATTEMPT))
        assert first == ce.prompt_facts(ce.build_facts(list(reversed(REFERENCE)), shuffled))
        assert ce.facts_hash(ce.build_facts(REFERENCE, ATTEMPT)) == ce.facts_hash(ce.build_facts(REFERENCE, shuffled))
        assert first != ce.prompt_facts(ce.build_facts(REFERENCE, ATTEMPT[:-1]))

    def test_入力を書き換えない(self):
        reference, attempt = [dict(x) for x in REFERENCE], [dict(x) for x in ATTEMPT]
        ce.build_facts(reference, attempt)
        assert reference == REFERENCE and attempt == ATTEMPT

    def test_カルテが無ければ_キーもコードも付かない(self, facts):
        assert facts["chart_context"] == "none" and facts["key"] is None and facts["sections"] is None
        assert "chord" not in facts["issues"]["columns"] and "expected_role" not in facts["issues"]["columns"]

    @pytest.mark.parametrize("bad", [[], None, "x", [{"note": "H", "octave": 2, "step": 0, "length": 4}]])
    def test_不正な入力は_差分と同じ例外(self, bad):
        with pytest.raises(coach_diff.DiffError):
            ce.build_facts(bad, ATTEMPT)

    @pytest.mark.parametrize("bad", [0, -120, 5000, "120", True, float("nan")])
    def test_不正なテンポは受け付けない(self, bad, chart):
        with pytest.raises(coach_diff.DiffError):
            ce.build_facts(REFERENCE, ATTEMPT, chart=chart, bpm=bad)


class TestIssueCap:
    """渡す指摘は上限まで。多いときは一部だけを渡し、全体は件数の集計で伝える"""

    @pytest.fixture
    def many(self):
        """8 小節ぶんを丸ごと打ち込んでいない（抜け 128 件）うえに、ほかの小節に位置のずれが 6 件"""
        reference = [n("C", 2, step, 1) for step in range(0, 16 * 12)]
        attempt = [n("C", 2, step, 1) for step in range(16 * 8, 16 * 12)]
        for step in range(16 * 8 + 1, 16 * 8 + 16, 3):
            attempt[step - 16 * 8] = None
        attempt = [note for note in attempt if note]
        attempt += [n("D", 5, 16 * 9 + i * 2, 1) for i in range(6)]
        return ce.build_facts(reference, attempt)

    def test_上限までしか渡さず_全件の数を添える(self, many):
        assert many["issues"]["total"] > ce.MAX_ISSUES
        assert len(many["issues"]["rows"]) == ce.MAX_ISSUES == 40
        assert many["summary"]["missing"] >= 128

    def test_1種類で埋めず_どの種類も渡す(self, many):
        """重い小節から順に取るだけだと、抜けだけで埋まる"""
        kinds = {row[0] for row in _rows(many, "kind")}
        assert kinds == {kind for kind in coach_diff.KINDS if many["summary"][kind]}
        assert len(kinds) >= 2

    def test_渡す指摘は_元の順に並び_IDは全体での番号のまま(self, many):
        numbers = [int(row[0][1:]) for row in many["issues"]["rows"]]
        assert numbers == sorted(numbers) and len(set(numbers)) == 40
        assert max(numbers) > 40

    def test_偏りと小節ごとの件数は_全部の指摘から数える(self, many):
        assert sum(many["tendencies"]["missing"]["by_beat"].values()) == many["summary"]["missing"]
        assert sum(sum(row[1:]) for row in many["bars"]["rows"]) == many["issues"]["total"]

    def test_小節の表にも上限が在る(self):
        reference = [n("C", 2, bar * 16) for bar in range(100)]
        result = ce.build_facts(reference, [n("C", 2, 0)])
        assert result["bars"]["total"] == 99 and len(result["bars"]["rows"]) == ce.MAX_BAR_ROWS
        bars = [row[0] for row in result["bars"]["rows"]]
        assert bars == sorted(bars) and set(result["worst_bars"]) <= set(bars)


class TestChartContext:
    """カルテが在れば、キーとその場のコードを足す。場所は秒で突き合わせる"""

    def test_テンポが無ければ_キーだけを使う(self, chart):
        """ピアノロールのステップを秒に直せないので、コードは当てられない"""
        result = ce.build_facts(REFERENCE, ATTEMPT, chart=chart)
        assert result["chart_context"] == "key"
        assert result["key"] == {"tonic": "C", "mode": "major", "confidence": "たぶん"}
        assert result["sections"] is None and "chord" not in result["issues"]["columns"]
        roles = {row[0]: row[1:] for row in _rows(result, "id", "expected_role", "actual_role")}
        assert roles["i7"] == ["キー内", "キー外"]        # B はキーの音階に在り、A# は無い
        assert roles["i2"] == ["キー内", None]

    def test_コードは_カルテの小節番号ではなく_秒で当てる(self, chart):
        """カルテの 1 小節目（2.0 秒〜）は、ピアノロールでは 2 小節目。番号で当てると 1 小節ずれる"""
        result = ce.build_facts(REFERENCE, ATTEMPT, chart=chart, bpm=120)
        assert result["chart_context"] == "chords"
        rows = {row[0]: row[1:] for row in _rows(result, "id", "bar", "chord", "chord_confidence",
                                                 "expected_role", "actual_role")}
        # ピアノロールの 1 小節目（0〜2 秒）には、まだコードが無い
        assert rows["i2"] == [1, None, None, "キー内", None]
        # ピアノロールの 2 小節目（2〜4 秒）が、カルテの 1 小節目の G7
        assert rows["i6"] == [2, "G7", "確実", "ルート", "ルート"]
        assert rows["i7"] == [2, "G7", "確実", "3度", "コード外・キー外"]
        assert rows["i8"] == [2, "G7", "確実", "5度", None]
        assert rows["i10"] == [2, "G7", "確実", None, "7度"]

    def test_セクションは_ピアノロールの小節に直して渡す(self, chart):
        reference = REFERENCE + [n("A", 2, 16 * 3)]
        result = ce.build_facts(reference, ATTEMPT, chart=chart, bpm=120)
        assert result["sections"] == [
            {"name": "verse", "name_confidence": "たぶん", "first_bar": 2, "last_bar": 3},
            # 利用者が付けた名前には、確信度を付けない
            {"name": "サビ", "name_confidence": None, "first_bar": 4, "last_bar": 5},
        ]
        # 曲の範囲より後ろのセクションは渡さない
        assert [s["name"] for s in ce.build_facts(REFERENCE, ATTEMPT, chart=chart, bpm=120)["sections"]] == ["verse"]

    def test_確信度は3段階の言い方で渡し_生の数値は渡さない(self, chart):
        reference = REFERENCE + [n("A", 2, 32)]
        text = ce.prompt_facts(ce.build_facts(reference, ATTEMPT, chart=chart, bpm=120))
        assert '"Am","自信なし"' in text
        for raw in ("0.9", "0.3", "0.5", "0.6"):
            assert raw not in text

    def test_カルテのファイル名や小節番号は渡さない(self, chart):
        text = ce.prompt_facts(ce.build_facts(REFERENCE, ATTEMPT, chart=chart, bpm=120))
        for leaked in ("ひみつの曲", "filename", "beat_times_sec", "start_sec", "downbeat", "degree", "V7", "S1"):
            assert leaked not in text

    def test_キーが検出できていなければ_キーは付かない(self, chart):
        chart["key"] = {"tonic": None, "mode": None, "confidence": 0.0, "alternatives": []}
        result = ce.build_facts(REFERENCE, ATTEMPT, chart=chart)
        assert result["chart_context"] == "none" and result["key"] is None

    def test_カルテが違えば_事実も変わる(self, chart):
        """保存した説明は、カルテを付けたとき・外したときで別になる"""
        hashes = {ce.facts_hash(ce.build_facts(REFERENCE, ATTEMPT)),
                  ce.facts_hash(ce.build_facts(REFERENCE, ATTEMPT, chart=chart)),
                  ce.facts_hash(ce.build_facts(REFERENCE, ATTEMPT, chart=chart, bpm=120))}
        assert len(hashes) == 3


class TestBuildRequest:
    def test_指示文にキャッシュの区切りが付き_事実はその後ろのuserに在る(self, facts):
        """事実は呼び出しごとに変わる。変わらない指示文だけを、区切りより前に置く"""
        request = ce.build_request(facts)
        assert request["system"] == [{"type": "text", "text": ce.SYSTEM_PROMPT, "cache_control": {"type": "ephemeral"}}]
        content = request["messages"][0]["content"]
        assert content.startswith("<facts>\n") and _sent_facts(request) == json.loads(ce.prompt_facts(facts))
        other = ce.build_request(ce.build_facts(REFERENCE, ATTEMPT[:-1]))
        assert other["system"] == request["system"] and other["messages"] != request["messages"]

    def test_出力の形に音符を入れる場所が無い(self, facts):
        """LLM は音符を 1 つも出力しない。持てるのは説明文と、指摘の ID・小節番号だけ"""
        schema = ce.build_request(facts)["output_config"]["format"]["schema"]
        assert set(schema["properties"]) == {"summary", "points", "next_step", "next_step_bar"}
        point = schema["properties"]["points"]["items"]
        assert set(point["properties"]) == {"title", "observation", "cause", "fix", "issue_ids", "bars"}
        assert point["properties"]["issue_ids"]["items"] == {"type": "string"}
        assert point["properties"]["bars"]["items"] == {"type": "integer"}
        for word in ("notes", "octave", "step", "length", "pitch"):
            assert f'"{word}"' not in json.dumps(schema)

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

    def test_モデルと各種の指定は_再現ガイドと同じ(self, facts, chart, monkeypatch):
        monkeypatch.delenv("BUNRI_GUIDE_MODEL", raising=False)
        request, guide = ce.build_request(facts), rg.build_request(chart)
        assert request["model"] == guide["model"] == "claude-opus-5-5"
        assert request["output_config"]["effort"] == ce.EFFORT == "low"
        assert request["max_tokens"] == ce.MAX_TOKENS
        assert request["fallbacks"] == guide["fallbacks"] and request["betas"] == guide["betas"]
        assert set(request) == set(guide)
        for key in ("thinking", "temperature", "top_p", "top_k"):
            assert key not in request

    def test_モデルは環境変数で差し替えられる(self, facts, monkeypatch):
        monkeypatch.setenv("BUNRI_GUIDE_MODEL", "claude-haiku-5-5")
        request = ce.build_request(facts)
        assert request["model"] == "claude-haiku-5-5"
        # Haiku にはサーバ側のやり直しが無い
        assert "fallbacks" not in request and "betas" not in request

    def test_何度組み立てても同じバイト列(self, facts, monkeypatch):
        first = json.dumps(ce.build_request(facts), ensure_ascii=False, sort_keys=True)
        monkeypatch.setattr(time, "time", lambda: 9_999_999_999.0)
        assert first == json.dumps(ce.build_request(ce.build_facts(REFERENCE, ATTEMPT)), ensure_ascii=False, sort_keys=True)

    def test_保持時間の指定(self, facts, monkeypatch):
        monkeypatch.setattr(ce, "CACHE_TTL", "1h")
        assert ce.build_request(facts)["system"][0]["cache_control"] == {"type": "ephemeral", "ttl": "1h"}
        monkeypatch.setattr(ce, "CACHE_TTL", None)
        assert "cache_control" not in ce.build_request(facts)["system"][0]

    def test_指示文は_お手本と呼ばせ_音の提案と励ましをさせない(self):
        prompt = ce.SYSTEM_PROMPT
        assert "「お手本」と呼び、「正解」「答え」「正しい音」とは書かない" in prompt
        assert "新しい音やフレーズを提案しない" in prompt
        assert "原曲どおりとは限らない" in prompt and "断定しない" in prompt
        assert "励ましやほめ言葉は書かない" in prompt
        assert "半音の数や度数を自分で数え直さない" in prompt
        # 禁じる語として挙げる 1 か所のほかに、「正解」を使っていない
        assert prompt.count("正解") == 1 and prompt.count("答え") == 1
        for label in ce.KIND_LABEL.values():
            assert f"「{label}」" in prompt

    def test_入力は小さい(self):
        """指摘を上限まで渡しても、指示文・事実・出力の形を合わせて 7,000 文字ほど（入力の上限は 30,000 トークン）"""
        reference = [n("C", 2, step, 1) for step in range(0, 16 * 60)]
        attempt = [n("D", 2, step, 2) for step in range(1, 16 * 60, 5)]
        big = ce.build_facts(reference, attempt)
        assert len(big["issues"]["rows"]) == ce.MAX_ISSUES and len(big["bars"]["rows"]) == ce.MAX_BAR_ROWS
        assert rg.request_chars(ce.build_request(big)) < 12000


class TestValidate:
    def test_実在する参照は_小節と拍つきで返す(self, facts):
        result = ce.validate_explanation(_raw(), facts)
        assert result["dropped_refs"] == 0 and result["dropped_points"] == 0 and result["replaced"] == []
        assert result["unverified_terms"] == []
        first, second = result["points"]
        # 指摘への参照は、事実の順（i6 → i7）。その小節は、小節だけの参照としては重ねない
        assert first["refs"] == [{"issue_id": "i6", "bar": 2, "beat": 1, "kind": "octave"},
                                 {"issue_id": "i7", "bar": 2, "beat": 2, "kind": "pitch"}]
        assert second["refs"] == [{"issue_id": "i2", "bar": 1, "beat": 2, "kind": "missing"},
                                  {"issue_id": "i5", "bar": 1, "beat": 4, "kind": "missing"},
                                  {"issue_id": None, "bar": 2, "beat": None, "kind": None}]
        assert set(first) == {"title", "observation", "cause", "fix", "refs"}
        assert result["next_step_bar"] == 2

    def test_事実に無い指摘や小節への参照は落とす(self, facts):
        raw = _raw(points=[_point(issue_ids=["i7", "i99", "x", "i7"], bars=[2, 7, 0, True, "2"])])
        result = ce.validate_explanation(raw, facts)
        assert result["points"][0]["refs"] == [{"issue_id": "i7", "bar": 2, "beat": 2, "kind": "pitch"}]
        assert result["dropped_refs"] == 6

    def test_事実に無い音を書いた点は_点ごと落とす(self, facts):
        """新しい音を提案させない。A2 はお手本にも打ち込みにも無い"""
        raw = _raw(points=[_point(), _point(fix="2 小節目の 2 拍目に A2 を入れると合います。", issue_ids=["i8"])])
        result = ce.validate_explanation(raw, facts)
        assert len(result["points"]) == 1 and result["dropped_points"] == 1
        assert "A2" not in json.dumps(result, ensure_ascii=False)
        assert ce.invented_notes("A2 と E2 と C#5", ce._vocabulary(facts)) == ["A2", "C#5"]

    def test_同じ音の別の書き方は_事実に在る音として扱う(self, facts):
        """A#2 を B♭2 と書いても、高さは同じ"""
        raw = _raw(points=[_point(observation="打ち込みは B♭2（Bb2）で、お手本の B2 より半音低くなっています。")])
        result = ce.validate_explanation(raw, facts)
        assert len(result["points"]) == 1 and result["unverified_terms"] == []

    def test_事実に在るコード名は_音名として数えない(self, chart):
        """G7 は「G のオクターブ 7」と同じ形。事実に在るコードなら通し、無いコードなら落とす"""
        with_chart = ce.build_facts(REFERENCE, ATTEMPT, chart=chart, bpm=120)
        raw = _raw(points=[_point(cause="この小節のコードは G7 で、お手本の B2 はその 3度に当たります。")])
        assert len(ce.validate_explanation(raw, with_chart)["points"]) == 1
        with pytest.raises(rg.GuideError):
            ce.validate_explanation(raw, ce.build_facts(REFERENCE, ATTEMPT))

    def test_参照が1つも残らない点は落とす(self, facts):
        raw = _raw(points=[_point(issue_ids=[], bars=[]), _point(issue_ids=["i99"], bars=[9]), _point()])
        result = ce.validate_explanation(raw, facts)
        assert len(result["points"]) == 1 and result["dropped_points"] == 2 and result["dropped_refs"] == 2

    def test_点は3つまで(self, facts):
        raw = _raw(points=[_point(title=f"点 {i}") for i in range(5)])
        result = ce.validate_explanation(raw, facts)
        assert [p["title"] for p in result["points"]] == ["点 0", "点 1", "点 2"] and result["dropped_points"] == 2

    def test_点が1つも残らなければ失敗(self, facts):
        for points in ([], [_point(issue_ids=["i99"], bars=[])], [_point(fix="F#3 に直します。")]):
            with pytest.raises(rg.GuideError) as e:
                ce.validate_explanation(_raw(points=points), facts)
            assert e.value.code == "invalid"

    def test_要約に事実に無い音が在れば_決まった文に差し替える(self, facts):
        result = ce.validate_explanation(_raw(summary="全体に D4 が多く使われています。"), facts)
        assert result["replaced"] == ["summary"]
        assert result["summary"] == ("お手本 8 ノートのうち、25% が高さと位置の合っているノートです。お手本との違いは 10 か所です"
                                     "（抜け 4、高さの違い 1、オクターブ違い 1、余分なノート 2、位置のずれ 1、長さの違い 1）。")

    def test_最初にやることに事実に無い音が在れば_決まった文に差し替える(self, facts):
        result = ce.validate_explanation(_raw(next_step="2 小節目に E3 を足します。", next_step_bar=1), facts)
        assert result["replaced"] == ["next_step"]
        assert result["next_step"] == "まず 2 小節目を開いて、お手本と見比べてください。" and result["next_step_bar"] == 2

    def test_最初に見る小節が事実に無ければ外す(self, facts):
        result = ce.validate_explanation(_raw(next_step_bar=12), facts)
        assert result["next_step_bar"] is None and result["dropped_refs"] == 1
        assert ce.validate_explanation(_raw(next_step_bar=None), facts)["dropped_refs"] == 0

    def test_事実に無いコード名や小節番号は_未確認の語として返す(self, facts):
        """誤検出がありうるので、捨てずに画面が示す（再現ガイドと同じ見張り）"""
        raw = _raw(summary="Dm7 の響きの上で、9 小節目と 1〜2 小節目に違いが在ります。長さは 2 小節ぶんです。")
        result = ce.validate_explanation(raw, facts)
        assert result["unverified_terms"] == ["Dm7", "9 小節"]
        assert result["replaced"] == [] and len(result["points"]) == 2

    @pytest.mark.parametrize("bad", [None, [], {"summary": "x"}, {"points": "x"}, {"points": ["x"]}])
    def test_形が違えば失敗(self, facts, bad):
        with pytest.raises(rg.GuideError) as e:
            ce.validate_explanation(bad, facts)
        assert e.value.code == "invalid"


class TestGenerate:
    def test_説明とモデルと使用量を返す(self, facts):
        client = FakeClient()
        result = ce.generate(facts, client=client)
        assert len(result["explanation"]["points"]) == 2
        assert result["model"] == "claude-opus-5-5" and result["usage"]["output_tokens"] == 300
        assert len(client.calls) == 1 and client.calls[0]["system"][0]["text"] == ce.SYSTEM_PROMPT

    def test_検証で失敗しても_使用量は持たせる(self, facts):
        """応答は返ってきているので、費用はかかっている"""
        with pytest.raises(rg.GuideError) as e:
            ce.generate(facts, client=FakeClient(payload=_raw(points=[])))
        assert e.value.code == "invalid" and e.value.usage["output_tokens"] == 300

    @pytest.mark.parametrize("kwargs, code", [
        ({"stop_reason": "refusal"}, "refused"),
        ({"stop_reason": "max_tokens", "text": '{"summary": "お手'}, "truncated"),
        ({"text": "すみません、できません"}, "invalid"),
        ({"error": TypeError("Could not resolve authentication method. Expected one of api_key, auth_token")}, "no_key"),
        ({"error": _api_error(anthropic.AuthenticationError, 401)}, "auth"),
        ({"error": _api_error(anthropic.RateLimitError, 429)}, "rate_limit"),
        ({"error": _api_error(anthropic.InternalServerError, 500)}, "api"),
        ({"error": anthropic.APIConnectionError(request=httpx2.Request("POST", "https://api.anthropic.com/v1/messages"))},
         "network"),
    ])
    def test_失敗は_再現ガイドと同じ種類に直す(self, facts, kwargs, code):
        with pytest.raises(rg.GuideError) as e:
            ce.generate(facts, client=FakeClient(**kwargs))
        assert e.value.code == code and str(e.value)
        if code == "truncated":
            assert "説明が長くなりすぎて" in str(e.value)


@pytest.fixture
def data_dir(monkeypatch, tmp_path):
    """保存先（説明の保存・使用量の記録・設定）を、テストごとの一時ディレクトリにする"""
    monkeypatch.setenv("BUNRI_DATA_DIR", str(tmp_path))
    monkeypatch.delenv("BUNRI_GUIDE_MODEL", raising=False)
    return tmp_path


class TestRuleResponse:
    """違いが無い・少ない、打ち込みが無い、お手本が少ないときは、Claude を呼ばずに決まった文を返す"""

    @pytest.fixture(autouse=True)
    def clean(self, data_dir):
        yield

    def _ask(self, reference, attempt):
        client = FakeClient()
        facts = ce.build_facts(reference, attempt)
        result = ce.explain_for(facts, client=client)
        assert client.calls == [] and client.count_calls == [] and guide_usage.read_records() == []
        assert result["source"] == "rule" and result["model"] is None and result["usage"] == {}
        assert result["cost_usd"] == 0.0 and result["cached"] is False
        assert result["explanation"]["points"] == []
        # 開き直したとき（費用のかからない問い合わせ）も、同じものが返る
        assert ce.saved_explanation(facts) == result
        # 作り直しを頼んでも、呼ばない
        assert ce.explain_for(facts, regenerate=True, client=client) == result and client.calls == []
        return result

    def test_違いが無ければ_呼ばない(self):
        result = self._ask(REFERENCE, [dict(x) for x in REFERENCE])
        assert result["reason"] == "no_diff"
        assert result["explanation"]["summary"] == "お手本 8 ノートと、高さ・位置・長さがすべて合っています。"
        assert "自動採譜" in result["explanation"]["next_step"]
        assert result["explanation"]["next_step_bar"] is None
        assert result["input"] == {"issues": 0, "issues_sent": 0, "chart_context": "none"}

    def test_打ち込みが無ければ_呼ばない(self):
        result = self._ask(REFERENCE, [])
        assert result["reason"] == "no_attempt"
        assert "打ち込みがまだありません（お手本は 8 ノート）" in result["explanation"]["summary"]
        assert result["explanation"]["next_step_bar"] == 1

    def test_お手本が少なければ_呼ばない(self):
        result = self._ask(REFERENCE[:3], [n("D", 2, 0), n("F", 2, 4), n("A", 2, 8)])
        assert result["reason"] == "few_notes"
        assert "お手本が 3 ノートだけ" in result["explanation"]["summary"]

    def test_違いがごく少なければ_呼ばない(self):
        result = self._ask(REFERENCE, [dict(x) for x in REFERENCE[:-2]])
        assert result["reason"] == "few_issues"
        assert "違いは 2 か所だけです" in result["explanation"]["next_step"]
        assert result["explanation"]["next_step_bar"] == 2

    def test_違いが3か所からは_Claudeに頼む(self):
        facts = ce.build_facts(REFERENCE, [dict(x) for x in REFERENCE[:-3]])
        assert facts["issues"]["total"] == ce.MIN_ISSUES and ce.rule_response(facts) is None

    def test_決まった文は_正解と言わず_お手本と呼ぶ(self):
        for attempt in ([dict(x) for x in REFERENCE], [], [dict(x) for x in REFERENCE[:-2]]):
            _, explanation = ce.rule_response(ce.build_facts(REFERENCE, attempt))
            text = explanation["summary"] + explanation["next_step"]
            assert "お手本" in text and "正解" not in text and "答え" not in text and "間違" not in text


class TestSavedExplanation:
    """作った説明を保存し、同じ事実なら Claude を呼ばない"""

    @pytest.fixture(autouse=True)
    def clean(self, data_dir):
        yield

    def test_同じノートの2回目は_APIを呼ばない(self, facts):
        client = FakeClient()
        assert ce.saved_explanation(facts) is None
        first = ce.explain_for(facts, client=client)
        second = ce.explain_for(ce.build_facts(list(reversed(REFERENCE)), list(reversed(ATTEMPT))), client=client)
        assert len(client.calls) == 1
        assert first["cached"] is False and second["cached"] is True
        assert first["source"] == second["source"] == "claude" and first["reason"] is None
        assert second["explanation"] == first["explanation"] and second["created_at"] == first["created_at"]
        assert first["input"] == {"issues": 10, "issues_sent": 10, "chart_context": "none"}
        assert ce.saved_explanation(facts)["explanation"] == first["explanation"]
        assert len(client.calls) == 1

    def test_保存先は_データ置き場のcoachの下(self, facts, data_dir):
        ce.explain_for(facts, client=FakeClient())
        files = list((data_dir / "results" / "coach" / "cache").glob("*.json"))
        assert len(files) == 1
        entry = json.loads(files[0].read_text(encoding="utf-8"))
        assert entry["facts"] == ce.facts_hash(facts) and isinstance(entry["explanation"], dict)
        # 再現ガイドの保存先には混ざらない
        assert not list((data_dir / "results" / "guide" / "cache").glob("*.json"))

    def test_ノートを直したら_作り直す(self, facts):
        client = FakeClient()
        ce.explain_for(facts, client=client)
        fixed = ce.build_facts(REFERENCE, ATTEMPT + [n("E", 2, 4)])
        assert ce.saved_explanation(fixed) is None
        ce.explain_for(fixed, client=client)
        assert len(client.calls) == 2

    def test_カルテを付けると_別の説明として作る(self, facts, chart):
        client = FakeClient()
        ce.explain_for(facts, client=client)
        ce.explain_for(ce.build_facts(REFERENCE, ATTEMPT, chart=chart, bpm=120), client=client)
        assert len(client.calls) == 2
        assert "chord" in _sent_facts(client.calls[1])["issues"]["columns"]

    @pytest.mark.parametrize("change", ["version", "prompt", "schema", "effort", "model"])
    def test_条件が変われば保存分を使わない(self, facts, monkeypatch, change):
        client = FakeClient()
        ce.explain_for(facts, client=client)
        if change == "version":
            monkeypatch.setattr(ce, "COACH_VERSION", ce.COACH_VERSION + 1)
        elif change == "prompt":
            monkeypatch.setattr(ce, "SYSTEM_PROMPT", ce.SYSTEM_PROMPT + "\n- 短く書く。")
        elif change == "schema":
            schema = json.loads(json.dumps(ce.COACH_SCHEMA))
            schema["properties"]["summary"]["description"] = "全体の傾向を 1 文で。"
            monkeypatch.setattr(ce, "COACH_SCHEMA", schema)
        elif change == "effort":
            monkeypatch.setattr(ce, "EFFORT", "medium")
        else:
            monkeypatch.setenv("BUNRI_GUIDE_MODEL", "claude-sonnet-5-5")
        assert ce.saved_explanation(facts) is None
        assert ce.explain_for(facts, client=client)["cached"] is False
        assert len(client.calls) == 2

    def test_作り直すと_明示したときだけAPIを呼び_保存分を置き換える(self, facts):
        client = FakeClient()
        ce.explain_for(facts, client=client)
        client._payload = _raw(summary="作り直した説明です。")
        again = ce.explain_for(facts, regenerate=True, client=client)
        assert len(client.calls) == 2 and again["cached"] is False
        assert ce.explain_for(facts, client=client)["explanation"]["summary"] == "作り直した説明です。"
        assert len(client.calls) == 2

    def test_失敗した呼び出しは保存しない(self, facts):
        with pytest.raises(rg.GuideError):
            ce.explain_for(facts, client=FakeClient(payload=_raw(points=[])))
        with pytest.raises(rg.GuideError):
            ce.explain_for(facts, client=FakeClient(stop_reason="refusal"))
        assert ce.saved_explanation(facts) is None

    def test_壊れた保存ファイルは無いものとして扱う(self, facts, data_dir):
        client = FakeClient()
        ce.explain_for(facts, client=client)
        for path in (data_dir / "results" / "coach" / "cache").glob("*.json"):
            path.write_text("{ 壊れている", encoding="utf-8")
        assert ce.saved_explanation(facts) is None
        ce.explain_for(facts, client=client)
        assert len(client.calls) == 2

    def test_同時に来た同じ依頼は_1回しか呼ばない(self, facts):
        """連打や二重送信で 2 回課金されない"""
        client = FakeClient(delay=0.3)
        results = []
        threads = [threading.Thread(target=lambda: results.append(ce.explain_for(facts, client=client))) for _ in range(4)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        assert len(client.calls) == 1
        assert sorted(r["cached"] for r in results) == [False, True, True, True]


class TestSharedBudget:
    """1 日の上限と使用量の記録は、再現ガイドと共通"""

    GUIDE = {"overview": "テスト用のガイドです。", "steps": [], "cautions": []}

    @pytest.fixture(autouse=True)
    def clean(self, data_dir):
        yield

    def test_上限に達したら_APIを呼ばずに理由を返す(self, facts):
        guide_usage.update_settings({"daily_limit_calls": 1})
        client = FakeClient()
        ce.explain_for(facts, client=client)
        with pytest.raises(rg.GuideError) as e:
            ce.explain_for(ce.build_facts(REFERENCE, ATTEMPT[:-1]), client=client)
        assert e.value.code == "daily_limit"
        assert "1 日の上限（1 回）に達したので、Claude を呼びません" in str(e.value)
        assert "再現ガイドと差分コーチの合計" in str(e.value)
        assert len(client.calls) == 1 and client.count_calls == []
        # 上限に達していても、保存済みは見られる。作り直しはできない
        assert ce.explain_for(facts, client=client)["cached"] is True
        with pytest.raises(rg.GuideError):
            ce.explain_for(facts, regenerate=True, client=client)
        assert len(client.calls) == 1

    def test_再現ガイドの呼び出しも_差分コーチの呼び出しも_同じ枠で数える(self, facts, chart):
        guide_usage.update_settings({"daily_limit_calls": 2})
        rg.guide_for(chart, client=FakeClient(payload=self.GUIDE))
        coach = FakeClient()
        ce.explain_for(facts, client=coach)
        assert guide_usage.today()["calls"] == 2
        # 再現ガイド 1 回 + 差分コーチ 1 回で上限。どちらも、もう呼べない
        with pytest.raises(rg.GuideError) as e:
            ce.explain_for(ce.build_facts(REFERENCE, ATTEMPT[:-1]), client=coach)
        assert e.value.code == "daily_limit" and "Claude を 2 回呼びました" in str(e.value)
        blocked = FakeClient(payload=self.GUIDE)
        with pytest.raises(rg.GuideError) as e:
            rg.guide_for(chart, focus="S1", client=blocked)
        assert e.value.code == "daily_limit" and blocked.calls == [] and len(coach.calls) == 1

    def test_費用の上限も共通(self, facts):
        client = FakeClient()
        ce.explain_for(facts, client=client)
        spent = guide_usage.today()["cost_usd"]
        assert spent > 0
        guide_usage.update_settings({"daily_limit_calls": None, "daily_limit_usd": spent})
        with pytest.raises(rg.GuideError) as e:
            ce.explain_for(ce.build_facts(REFERENCE, ATTEMPT[:-1]), client=client)
        assert e.value.code == "daily_limit" and "概算" in str(e.value) and len(client.calls) == 1

    def test_応答が返らなかった失敗は_回数に数えない(self, facts):
        with pytest.raises(rg.GuideError):
            ce.explain_for(facts, client=FakeClient(error=_api_error(anthropic.AuthenticationError, 401)))
        assert guide_usage.today()["calls"] == 0
        # 事実と結び付けられなかった応答は、返ってきていて費用がかかるので数える
        with pytest.raises(rg.GuideError):
            ce.explain_for(facts, client=FakeClient(payload=_raw(points=[])))
        assert guide_usage.today()["calls"] == 1

    def test_同じ記録に_機能の名前つきで残す(self, facts, chart):
        rg.guide_for(chart, client=FakeClient(payload=self.GUIDE))
        ce.explain_for(facts, client=FakeClient())
        with pytest.raises(rg.GuideError):
            ce.explain_for(ce.build_facts(REFERENCE, ATTEMPT[:-1]), client=FakeClient(stop_reason="refusal"))
        guide, coach, failed = guide_usage.read_records()
        assert guide["feature"] == "guide" and coach["feature"] == "coach"
        assert coach["ok"] is True and coach["error"] is None and coach["focus"] is None
        assert (coach["input_tokens"], coach["cache_read_input_tokens"], coach["output_tokens"]) == (900, 2500, 300)
        assert coach["chart"] == ce.facts_hash(facts)[:16] and coach["version"] == ce.request_fingerprint()
        assert coach["effort"] == ce.EFFORT and coach["cache_ttl"] == "5m"
        assert coach["cost_usd"] == pytest.approx(guide_usage.estimate_cost("claude-opus-5-5", {
            "input_tokens": 900, "cache_read_input_tokens": 2500, "output_tokens": 300}))
        assert (failed["feature"], failed["ok"], failed["error"]) == ("coach", False, "refused")
        # 保存分を返したとき・決まった文を返したときは記録しない
        ce.explain_for(facts, client=FakeClient())
        ce.explain_for(ce.build_facts(REFERENCE, REFERENCE), client=FakeClient())
        assert len(guide_usage.read_records()) == 3

    def test_記録に_ノートも説明文もキーも入らない(self, facts, monkeypatch):
        secret = "sk-ant-secret-key-value"
        monkeypatch.setenv("ANTHROPIC_API_KEY", secret)
        ce.explain_for(facts, client=FakeClient())
        text = guide_usage.log_path().read_text(encoding="utf-8")
        (record,) = guide_usage.read_records()
        assert set(record) == set(guide_usage._RECORD_FIELDS)
        strings = {k: v for k, v in record.items() if isinstance(v, str)}
        assert set(strings) <= {"ts", "feature", "model", "requested_model", "effort", "cache_ttl", "chart", "version"}
        assert all(len(v) <= 40 for v in strings.values())
        for leaked in (secret, "sk-ant", "A#2", "B2", "お手本", "小節", "見比べ", "missing", "octave"):
            assert leaked not in text

    def test_キャッシュの保持時間の集計には_差分コーチの呼び出しを入れない(self, facts):
        """その集計は、カルテをキャッシュに載せる再現ガイドのためのもの"""
        ce.explain_for(facts, client=FakeClient())
        assert guide_usage.cache_report()["calls"] == 0

    def test_入力の上限を下げているときは_数えてから断る(self, facts):
        guide_usage.update_settings({"max_input_tokens": 500})
        client = FakeClient(tokens=3000)
        with pytest.raises(rg.GuideError) as e:
            ce.explain_for(facts, client=client)
        assert e.value.code == "too_long" and "3,000" in str(e.value)
        assert client.calls == [] and len(client.count_calls) == 1 and guide_usage.read_records() == []
        # 数えて収まるなら送る
        ok = FakeClient(tokens=400)
        ce.explain_for(facts, client=ok)
        assert len(ok.calls) == 1


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
    BODY = {"reference": REFERENCE, "attempt": ATTEMPT, "steps_per_bar": 16}

    @pytest.fixture(autouse=True)
    def clean(self, data_dir, no_keys):
        yield

    @pytest.fixture
    def client(self):
        from web.api import app

        return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")

    @pytest.fixture
    def fake(self, monkeypatch):
        fake = FakeClient()
        monkeypatch.setattr(llm_settings, "make_client", lambda: fake)
        return fake

    @pytest.fixture
    def saved_chart(self, chart):
        """カルテを .bunri として保存しておく"""
        import audio_utils
        import bunri_file

        bunri_file.create(audio_utils.results_dir("charts") / "song.bunri", chart)
        return "song"

    @pytest.mark.asyncio
    async def test_説明を作って返す(self, client, fake):
        resp = await client.post("/api/coach/explain", json=self.BODY)
        assert resp.status_code == 200
        body = resp.json()
        assert set(body) == {"explanation", "source", "reason", "model", "usage", "cost_usd", "duration_sec",
                             "created_at", "cached", "input", "today"}
        assert body["source"] == "claude" and body["cached"] is False and body["model"] == "claude-opus-5-5"
        assert set(body["explanation"]) == {"summary", "points", "next_step", "next_step_bar", "dropped_refs",
                                            "dropped_points", "unverified_terms", "replaced"}
        assert body["explanation"]["points"][0]["refs"][0] == {"issue_id": "i6", "bar": 2, "beat": 1, "kind": "octave"}
        assert body["cost_usd"] == pytest.approx(guide_usage.estimate_cost("claude-opus-5-5", body["usage"]))
        assert body["today"]["calls"] == 1
        # Claude に渡したのは、サーバが計算した事実
        assert _sent_facts(fake.calls[0])["summary"]["missing"] == 4

    @pytest.mark.asyncio
    async def test_2回目は_APIを呼ばずに保存済みを返す(self, client, fake):
        body = (await client.post("/api/coach/explain/saved", json=self.BODY)).json()
        assert body == {"saved": False, "today": body["today"]} and body["today"]["calls"] == 0
        made = (await client.post("/api/coach/explain", json=self.BODY)).json()
        saved = (await client.post("/api/coach/explain/saved", json=self.BODY)).json()
        assert saved["saved"] is True and saved["cached"] is True
        assert saved["explanation"] == made["explanation"] and saved["created_at"] == made["created_at"]
        again = (await client.post("/api/coach/explain", json=self.BODY)).json()
        assert again["cached"] is True and again["today"]["calls"] == 1 and len(fake.calls) == 1
        # 明示的に作り直したときだけ呼ぶ（真偽値の true だけを見る）
        await client.post("/api/coach/explain", json={**self.BODY, "regenerate": "false"})
        assert len(fake.calls) == 1
        redo = (await client.post("/api/coach/explain", json={**self.BODY, "regenerate": True})).json()
        assert redo["cached"] is False and len(fake.calls) == 2

    @pytest.mark.asyncio
    async def test_違いが無ければ_APIを呼ばずに決まった文を返す(self, client, fake):
        body = {"reference": REFERENCE, "attempt": REFERENCE}
        resp = await client.post("/api/coach/explain", json=body)
        assert resp.status_code == 200
        assert (resp.json()["source"], resp.json()["reason"]) == ("rule", "no_diff")
        assert resp.json()["today"]["calls"] == 0 and fake.calls == []
        saved = (await client.post("/api/coach/explain/saved", json=body)).json()
        assert saved["saved"] is True and saved["source"] == "rule"

    @pytest.mark.asyncio
    async def test_カルテとテンポを付けると_キーとコードを事実に足す(self, client, fake, saved_chart):
        resp = await client.post("/api/coach/explain", json={**self.BODY, "chart_id": saved_chart, "bpm": 120})
        assert resp.status_code == 200 and resp.json()["input"]["chart_context"] == "chords"
        sent = _sent_facts(fake.calls[0])
        assert sent["key"]["tonic"] == "C" and "chord" in sent["issues"]["columns"]
        # テンポが無ければキーだけ
        resp = await client.post("/api/coach/explain", json={**self.BODY, "chart_id": saved_chart})
        assert resp.json()["input"]["chart_context"] == "key" and len(fake.calls) == 2

    @pytest.mark.asyncio
    async def test_上限を超えたら_APIを呼ばずに429で理由を返す(self, client, fake):
        await client.post("/api/settings/guide", json={"daily_limit_calls": 0})
        resp = await client.post("/api/coach/explain", json=self.BODY)
        assert resp.status_code == 429
        assert resp.json()["detail"]["code"] == "daily_limit" and "上限" in resp.json()["detail"]["message"]
        assert fake.calls == []
        # 費用のかからない問い合わせは、上限に達していても通る
        assert (await client.post("/api/coach/explain/saved", json=self.BODY)).status_code == 200

    @pytest.mark.asyncio
    async def test_キーが無ければ401で理由を返す(self, client, monkeypatch):
        error = TypeError("Could not resolve authentication method. Expected one of api_key, auth_token")
        monkeypatch.setattr(llm_settings, "make_client", lambda: FakeClient(error=error))
        resp = await client.post("/api/coach/explain", json=self.BODY)
        assert resp.status_code == 401 and resp.json()["detail"]["code"] == "no_key"

    @pytest.mark.asyncio
    async def test_事実と結び付けられない応答は400_Claude側の失敗は502(self, client, monkeypatch):
        monkeypatch.setattr(llm_settings, "make_client", lambda: FakeClient(payload=_raw(points=[])))
        resp = await client.post("/api/coach/explain", json=self.BODY)
        assert resp.status_code == 400 and resp.json()["detail"]["code"] == "invalid"
        monkeypatch.setattr(llm_settings, "make_client", lambda: FakeClient(stop_reason="refusal"))
        resp = await client.post("/api/coach/explain", json=self.BODY)
        assert resp.status_code == 502 and resp.json()["detail"]["code"] == "refused"
        monkeypatch.setattr(llm_settings, "make_client",
                            lambda: FakeClient(error=_api_error(anthropic.RateLimitError, 429)))
        resp = await client.post("/api/coach/explain", json=self.BODY)
        assert resp.status_code == 429 and resp.json()["detail"]["code"] == "rate_limit"

    @pytest.mark.asyncio
    async def test_不正な入力は400_無いカルテは404(self, client, fake):
        for path in ("/api/coach/explain", "/api/coach/explain/saved"):
            resp = await client.post(path, json={"reference": [], "attempt": ATTEMPT})
            assert resp.status_code == 400
            assert resp.json()["detail"] == {"message": "お手本のノートがありません", "code": "invalid"}
            assert (await client.post(path, json={"attempt": ATTEMPT})).status_code == 400
            assert (await client.post(path, json={**self.BODY, "steps_per_bar": 0})).status_code == 400
            assert (await client.post(path, json={**self.BODY, "bpm": "速め"})).status_code == 400
            assert (await client.post(path, json={**self.BODY, "chart_id": "nope"})).status_code == 404
        assert fake.calls == []
