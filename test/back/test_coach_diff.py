"""差分コーチの土台（coach_diff）のテスト

お手本と打ち込みの差分が、機械的に決まる形で出ることを確かめる。
"""
import pytest
from httpx import ASGITransport, AsyncClient

import coach_diff
from coach_diff import DiffError, diff_notes


def n(note, octave, step, length=4):
    return {"note": note, "octave": octave, "step": step, "length": length}


# お手本: 1 小節目に C4 E4 G4 を 4 分音符で、2 小節目の頭に C5
REFERENCE = [n("C", 4, 0), n("E", 4, 4), n("G", 4, 8), n("C", 5, 16)]


def kinds(result):
    return [(issue["kind"], issue["bar"], issue["beat"]) for bar in result["bars"] for issue in bar["issues"]]


class TestExact:
    def test_同じなら指摘なしで正確さは1(self):
        result = diff_notes(REFERENCE, [dict(x) for x in REFERENCE])
        assert result["bars"] == [] and result["worst_bars"] == []
        assert result["summary"]["exact"] == 4
        assert result["summary"]["accuracy"] == 1.0
        assert all(result["summary"][kind] == 0 for kind in coach_diff.KINDS)

    def test_順番が違っても結果は同じ(self):
        shuffled = [REFERENCE[2], REFERENCE[0], REFERENCE[3], REFERENCE[1]]
        assert diff_notes(REFERENCE, shuffled)["summary"]["exact"] == 4

    def test_入力を書き換えない(self):
        attempt = [n("C", 4, 0)]
        diff_notes(REFERENCE, attempt)
        assert attempt == [n("C", 4, 0)]
        assert "pitch" not in REFERENCE[0]


class TestKinds:
    def test_抜け(self):
        result = diff_notes(REFERENCE, [REFERENCE[0], REFERENCE[2], REFERENCE[3]])
        assert kinds(result) == [("missing", 1, 2)]
        issue = result["bars"][0]["issues"][0]
        assert issue["expected"] == n("E", 4, 4) and issue["actual"] is None
        assert result["summary"]["missing"] == 1
        assert result["summary"]["accuracy"] == 0.75

    def test_余分(self):
        result = diff_notes(REFERENCE, REFERENCE + [n("A", 3, 24)])
        assert kinds(result) == [("extra", 2, 3)]
        issue = result["bars"][0]["issues"][0]
        assert issue["expected"] is None and issue["actual"] == n("A", 3, 24)
        assert result["summary"]["accuracy"] == 1.0

    def test_オクターブ違い(self):
        attempt = [n("C", 4, 0), n("E", 3, 4), n("G", 4, 8), n("C", 5, 16)]
        result = diff_notes(REFERENCE, attempt)
        assert kinds(result) == [("octave", 1, 2)]
        issue = result["bars"][0]["issues"][0]
        assert issue["expected"]["octave"] == 4 and issue["actual"]["octave"] == 3
        assert result["summary"]["missing"] == 0 and result["summary"]["extra"] == 0

    def test_音の間違い(self):
        attempt = [n("C", 4, 0), n("F", 4, 4), n("G", 4, 8), n("C", 5, 16)]
        result = diff_notes(REFERENCE, attempt)
        assert kinds(result) == [("pitch", 1, 2)]
        assert result["bars"][0]["issues"][0]["actual"]["note"] == "F"

    def test_離れた高さは間違いではなく抜けと余分(self):
        attempt = [n("C", 4, 0), n("A", 4, 4), n("G", 4, 8), n("C", 5, 16)]
        assert sorted(k for k, _, _ in kinds(diff_notes(REFERENCE, attempt))) == ["extra", "missing"]

    def test_位置のずれ(self):
        attempt = [n("C", 4, 0), n("E", 4, 5), n("G", 4, 8), n("C", 5, 16)]
        result = diff_notes(REFERENCE, attempt)
        assert kinds(result) == [("timing", 1, 2)]
        assert result["bars"][0]["issues"][0]["offset_steps"] == 1
        # 位置の小さなずれは「合っている」側に数える
        assert result["summary"]["accuracy"] == 1.0
        assert result["summary"]["exact"] == 3

    def test_許容より大きくずれたら抜けと余分(self):
        attempt = [n("C", 4, 0), n("E", 4, 7), n("G", 4, 8), n("C", 5, 16)]
        assert sorted(k for k, _, _ in kinds(diff_notes(REFERENCE, attempt))) == ["extra", "missing"]
        assert kinds(diff_notes(REFERENCE, attempt, timing_tolerance=3)) == [("timing", 1, 2)]

    def test_長さの違い(self):
        attempt = [n("C", 4, 0, 2), n("E", 4, 4), n("G", 4, 8), n("C", 5, 16)]
        result = diff_notes(REFERENCE, attempt)
        assert kinds(result) == [("length", 1, 1)]
        assert result["bars"][0]["issues"][0]["length_diff"] == -2

    def test_位置も長さも違えば両方指摘する(self):
        attempt = [n("C", 4, 1, 8), n("E", 4, 4), n("G", 4, 8), n("C", 5, 16)]
        assert kinds(diff_notes(REFERENCE, attempt)) == [("timing", 1, 1), ("length", 1, 1)]


class TestMatching:
    def test_同じ高さが続くとき_近いほうどうしを組にする(self):
        reference = [n("C", 4, 0, 2), n("C", 4, 2, 2), n("C", 4, 4, 2)]
        attempt = [n("C", 4, 0, 2), n("C", 4, 4, 2)]
        result = diff_notes(reference, attempt)
        assert kinds(result) == [("missing", 1, 1)]
        assert result["bars"][0]["issues"][0]["expected"]["step"] == 2

    def test_和音の一部だけ違うとき_合っている音は巻き込まない(self):
        reference = [n("C", 4, 0), n("E", 4, 0), n("G", 4, 0)]
        attempt = [n("C", 4, 0), n("D#", 4, 0), n("G", 4, 0)]
        result = diff_notes(reference, attempt)
        assert kinds(result) == [("pitch", 1, 1)]
        assert result["summary"]["exact"] == 2

    def test_何も打ち込んでいなければ全部抜け(self):
        result = diff_notes(REFERENCE, [])
        assert result["summary"]["missing"] == 4 and result["summary"]["accuracy"] == 0.0
        assert [bar["bar"] for bar in result["bars"]] == [1, 2]


class TestBars:
    def test_小節と拍は1始まりで_拍子に従う(self):
        result = diff_notes([n("C", 4, 30)], [], steps_per_bar=12, steps_per_beat=4)
        assert kinds(result) == [("missing", 3, 2)]

    def test_指摘の重い小節から並ぶ(self):
        reference = [n("C", 4, s) for s in (0, 4, 8, 12)] + [n("D", 4, s) for s in (16, 20)] + [n("E", 4, 32)]
        attempt = [n("C", 4, 0), n("D", 4, 16), n("D", 4, 21), n("E", 4, 32)]   # 1 小節目で 3 つ抜け、2 小節目は位置ずれ
        result = diff_notes(reference, attempt)
        assert result["worst_bars"] == [1, 2]
        assert [bar["bar"] for bar in result["bars"]] == [1, 2]

    def test_最大5小節まで(self):
        reference = [n("C", 4, bar * 16) for bar in range(8)]
        assert len(diff_notes(reference, [])["worst_bars"]) == 5


class TestValidation:
    def test_お手本が空なら比べられない(self):
        with pytest.raises(DiffError, match="お手本のノートがありません"):
            diff_notes([], [n("C", 4, 0)])

    @pytest.mark.parametrize("bad", [
        None, "x", [None], [{"note": "H", "octave": 4, "step": 0, "length": 4}],
        [{"note": "C", "octave": 4.5, "step": 0, "length": 4}],
        [{"note": "C", "octave": 4, "step": -1, "length": 4}],
        [{"note": "C", "octave": 4, "step": 0, "length": 0}],
        [{"note": "C", "octave": 4, "step": True, "length": 4}],
        [{"note": "C", "octave": 4, "step": 0}],
    ])
    def test_形の違うノートは受け付けない(self, bad):
        with pytest.raises(DiffError):
            diff_notes(REFERENCE, bad)
        with pytest.raises(DiffError):
            diff_notes(bad, REFERENCE)

    def test_多すぎるノートは受け付けない(self):
        with pytest.raises(DiffError, match="多すぎます"):
            diff_notes(REFERENCE, [n("C", 4, 0)] * (coach_diff.MAX_NOTES + 1))

    @pytest.mark.parametrize("kwargs", [{"steps_per_bar": 0}, {"steps_per_beat": -1}, {"timing_tolerance": -1}, {"steps_per_bar": 1.5}])
    def test_設定が不正なら失敗(self, kwargs):
        with pytest.raises(DiffError):
            diff_notes(REFERENCE, REFERENCE, **kwargs)


def v(note, octave, step, velocity=None, length=4):
    """強さつきのノート（``velocity`` が None なら、強さを持たないノート）"""
    out = n(note, octave, step, length)
    if velocity is not None:
        out["velocity"] = velocity
    return out


def line(velocities, note="C", octave=3):
    """4 分音符を並べたノート列（1 小節に 4 ノート）。強さは ``velocities`` の順"""
    return [v(note, octave, i * 4, velocity) for i, velocity in enumerate(velocities)]


def findings(result):
    return [(f["kind"], f["direction"], f["start_bar"], f["end_bar"]) for f in result["velocity"]["findings"]]


class TestVelocity:
    """強さ（ベロシティ）の違い。お手本が MIDI ファイルから読み込んだもののときだけ比べる"""

    # お手本: 2 小節。強さは 80 でそろっている
    EVEN = line([80] * 8)

    def test_MIDIのお手本で_強さが同じなら_指摘は無い(self):
        result = diff_notes(self.EVEN, line([80] * 8), reference_source="midi")
        velocity = result["velocity"]
        assert velocity["compared"] == 8 and velocity["weaker"] == 0 and velocity["stronger"] == 0
        assert velocity["findings"] == [] and velocity["notes"] == []
        assert velocity["median_diff"] == 0
        assert velocity["reference"] == velocity["attempt"] == {"min": 80, "max": 80, "median": 80}
        assert velocity["tolerance"] == coach_diff.VELOCITY_TOLERANCE == 16

    @pytest.mark.parametrize("diff, flagged", [(16, 0), (17, 8), (-16, 0), (-17, 8)])
    def test_許す幅の境目(self, diff, flagged):
        """差が 16 までは同じ強さ。17 からが違い"""
        velocity = diff_notes(self.EVEN, line([80 + diff] * 8), reference_source="midi")["velocity"]
        assert velocity["weaker"] + velocity["stronger"] == flagged == len(velocity["notes"])
        assert velocity["weaker"] == (flagged if diff < 0 else 0)
        assert bool(velocity["findings"]) == bool(flagged)

    @pytest.mark.parametrize("source", [None, "transcription", "audio", "", "MIDI", 1, True, ["midi"]])
    def test_採譜のお手本と_出どころの分からないお手本では_強さに触れない(self, source):
        result = diff_notes(self.EVEN, line([20] * 8), reference_source=source)
        assert result["velocity"] is None
        assert result["bars"] == [] and result["summary"]["exact"] == 8

    def test_出どころを渡さなければ_強さに触れない(self):
        assert diff_notes(self.EVEN, line([20] * 8))["velocity"] is None

    @pytest.mark.parametrize("attempt", [
        line([20] * 8),                                                   # 強さだけが違う
        line([127] * 6),                                                  # 抜けも在る
        [v("C", 3, 1, 30), v("D", 3, 4, 30), v("C", 4, 8, 30), v("C", 3, 12, 30, length=2), v("G", 5, 20, 30)],
        [],
    ])
    def test_強さを比べても_一致率も指摘も変わらない(self, attempt):
        plain = diff_notes(self.EVEN, attempt)
        with_velocity = diff_notes(self.EVEN, attempt, reference_source="midi")
        for key in ("summary", "bars", "worst_bars"):
            assert with_velocity[key] == plain[key]
        # 強さを消したノートで比べても同じ（強さは、位置・高さ・長さの突き合わせに入らない）
        stripped = diff_notes([n(x["note"], x["octave"], x["step"], x["length"]) for x in self.EVEN],
                              [n(x["note"], x["octave"], x["step"], x["length"]) for x in attempt])
        assert stripped == plain
        # 指摘のノートに、強さは載せない
        for bar in with_velocity["bars"]:
            for issue in bar["issues"]:
                assert "velocity" not in (issue["expected"] or {}) and "velocity" not in (issue["actual"] or {})

    def test_比べるのは_位置と高さが合った組だけ(self):
        # C3 の 3 つは合う（1 つは位置が 1 ステップずれ）。D3 は高さの違い、5 つ目以降は抜け
        attempt = [v("C", 3, 0, 20), v("C", 3, 5, 20), v("C", 3, 8, 20), v("D", 3, 12, 20)]
        result = diff_notes(self.EVEN, attempt, reference_source="midi")
        assert result["summary"]["pitch"] == 1 and result["summary"]["missing"] == 4
        assert result["velocity"]["compared"] == 3 and result["velocity"]["weaker"] == 3

    def test_強さを持たないノートは_96として比べる(self):
        velocity = diff_notes(line([96] * 4 + [60] * 4), line([None] * 8), reference_source="midi")["velocity"]
        assert velocity["attempt_unset"] == 8 and velocity["default_velocity"] == 96
        assert velocity["attempt"] == {"min": 96, "max": 96, "median": 96}
        assert velocity["stronger"] == 4 and velocity["weaker"] == 0
        assert velocity["notes"][0] == {
            "bar": 2, "beat": 1, "diff": 36,
            "expected": {"note": "C", "octave": 3, "step": 16, "length": 4, "velocity": 60},
            "actual": {"note": "C", "octave": 3, "step": 16, "length": 4, "velocity": 96},
        }

    @pytest.mark.parametrize("value, expected", [("強い", 96), (None, 96), (True, 96), (float("nan"), 96),
                                                 (200, 127), (0, 1), (-5, 1), (63.5, 64), (63.4, 63)])
    def test_強さの形がおかしくても断らない(self, value, expected):
        attempt = [{**note, "velocity": value} for note in line([80] * 8)]
        velocity = diff_notes(self.EVEN, attempt, reference_source="midi")["velocity"]
        assert velocity["attempt"]["max"] == expected
        # 強さを比べないときも、これまでどおり受け付ける
        assert diff_notes(self.EVEN, attempt)["summary"]["exact"] == 8

    def test_全体に弱い(self):
        result = diff_notes(line([100] * 8), line([60] * 8), reference_source="midi")
        assert findings(result) == [("overall", "weaker", 1, 2)]
        finding = result["velocity"]["findings"][0]
        assert (finding["count"], finding["compared"], finding["median_diff"]) == (8, 8, -40)
        assert finding["notes"] == list(range(8))

    def test_全体に強い_は4分の3から(self):
        # 8 ノートのうち 6 ノート（4 分の 3）が強い → 全体に強い。同じ向きの小節の範囲は言い直さない
        result = diff_notes(line([60] * 8), line([100] * 6 + [60] * 2), reference_source="midi")
        assert findings(result) == [("overall", "stronger", 1, 2)]
        # 5 ノートなら全体とは言わず、小節の範囲で言う（1 小節目は 4 ノートとも強い。2 小節目は 4 ノート中 1 つ）
        result = diff_notes(line([60] * 8), line([100] * 5 + [60] * 3), reference_source="midi")
        assert findings(result) == [("section", "stronger", 1, 1)]

    def test_小節の範囲が弱い(self):
        # 4 小節。3〜4 小節だけ弱い
        result = diff_notes(line([90] * 16), line([90] * 8 + [50] * 8), reference_source="midi")
        assert findings(result) == [("section", "weaker", 3, 4)]
        finding = result["velocity"]["findings"][0]
        assert (finding["count"], finding["compared"], finding["median_diff"]) == (8, 8, -40)
        assert [result["velocity"]["notes"][i]["bar"] for i in finding["notes"]] == [3] * 4 + [4] * 4

    def test_離れた小節は_別々の範囲にする(self):
        attempt = line([50] * 4 + [90] * 4 + [50] * 4 + [90] * 4)
        result = diff_notes(line([90] * 16), attempt, reference_source="midi")
        assert findings(result) == [("section", "weaker", 1, 1), ("section", "weaker", 3, 3)]

    def test_1から2ノートだけの違いは_まとまりとして言わない(self):
        result = diff_notes(line([90] * 8), line([90, 40, 90, 90, 90, 90, 127, 90]), reference_source="midi")
        velocity = result["velocity"]
        assert velocity["findings"] == []
        # 数には入る（どのノートかも分かる）
        assert (velocity["weaker"], velocity["stronger"]) == (1, 1)
        assert [(note["bar"], note["beat"], note["diff"]) for note in velocity["notes"]] == [(1, 2, -50), (2, 3, 37)]

    def test_強弱が付いていない(self):
        # お手本は 1 拍目が強く、3 拍目が弱い。打ち込みはマウスで置いた（全部 96）
        reference = line([120, 96, 60, 96] * 2)
        result = diff_notes(reference, line([None] * 8), reference_source="midi")
        assert findings(result) == [("flat", None, 1, 2)]
        finding = result["velocity"]["findings"][0]
        # 違うのは、強いノート 2 つと弱いノート 2 つ
        assert (finding["count"], finding["compared"]) == (4, 8)
        assert result["velocity"]["reference"] == {"min": 60, "max": 120, "median": 96}

    def test_お手本の強さの幅が小さければ_強弱が付いていないとは言わない(self):
        # お手本の幅は 30（許す幅の 2 倍以内）。打ち込みは一定
        result = diff_notes(line([110, 80] * 4), line([96] * 8), reference_source="midi")
        assert result["velocity"]["findings"] == [] and result["velocity"]["notes"] == []

    def test_アクセントが付いていない(self):
        # お手本は各小節の 1 拍目が強い。打ち込みは強弱が在るが、1 拍目が強くない
        reference = line([120, 80, 80, 80] * 4)
        attempt = line([90, 70, 95, 80] * 4)
        result = diff_notes(reference, attempt, reference_source="midi")
        assert findings(result) == [("accent", "weaker", 1, 4)]
        finding = result["velocity"]["findings"][0]
        assert (finding["count"], finding["compared"], finding["median_diff"]) == (4, 4, -30)
        assert [result["velocity"]["notes"][i]["beat"] for i in finding["notes"]] == [1, 1, 1, 1]

    def test_アクセントが1つだけなら言わない(self):
        reference = line([120, 80, 80, 80, 80, 80, 80, 80])
        attempt = line([90, 70, 95, 80, 90, 70, 95, 80])
        result = diff_notes(reference, attempt, reference_source="midi")
        assert result["velocity"]["findings"] == [] and result["velocity"]["weaker"] == 1

    def test_アクセントが付いていれば言わない(self):
        reference = line([120, 80, 80, 80] * 4)
        attempt = line([110, 70, 95, 80] * 4)
        assert diff_notes(reference, attempt, reference_source="midi")["velocity"]["findings"] == []

    def test_全体に弱いときは_アクセントを言い直さない(self):
        reference = line([120, 80, 80, 80] * 4)
        result = diff_notes(reference, line([70, 40, 55, 40] * 4), reference_source="midi")
        assert findings(result) == [("overall", "weaker", 1, 4)]

    def test_合ったノートが無ければ_比べるものが無い(self):
        velocity = diff_notes(self.EVEN, [], reference_source="midi")["velocity"]
        assert velocity["compared"] == 0 and velocity["findings"] == [] and velocity["notes"] == []
        assert velocity["median_diff"] is None and velocity["reference"] is None and velocity["attempt"] is None

    def test_入力を書き換えない(self):
        reference, attempt = line([100] * 4), line([None] * 4)
        diff_notes(reference, attempt, reference_source="midi")
        assert reference == line([100] * 4) and attempt == line([None] * 4)


class TestApi:
    @pytest.fixture
    def client(self):
        from web.api import app

        return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")

    @pytest.mark.asyncio
    async def test_差分を返す(self, client):
        resp = await client.post("/api/coach/diff", json={"reference": REFERENCE, "attempt": REFERENCE[:3]})
        assert resp.status_code == 200
        body = resp.json()
        assert body["summary"]["missing"] == 1
        assert body["bars"][0]["bar"] == 2

    @pytest.mark.asyncio
    async def test_不正な入力は400で理由を返す(self, client):
        resp = await client.post("/api/coach/diff", json={"reference": [], "attempt": []})
        assert resp.status_code == 400
        assert "お手本" in resp.json()["detail"]
        resp = await client.post("/api/coach/diff", json={"reference": REFERENCE, "attempt": [{"note": "H"}]})
        assert resp.status_code == 400

    @pytest.mark.asyncio
    async def test_MIDIのお手本と伝えたときだけ_強さを比べる(self, client):
        reference = line([100] * 8)
        attempt = line([60] * 8)
        body = {"reference": reference, "attempt": attempt}
        plain = (await client.post("/api/coach/diff", json=body)).json()
        assert plain["velocity"] is None
        for source in ("transcription", "", None, 3, ["midi"]):
            resp = await client.post("/api/coach/diff", json={**body, "reference_source": source})
            assert resp.status_code == 200 and resp.json() == plain
        midi = (await client.post("/api/coach/diff", json={**body, "reference_source": "midi"})).json()
        assert midi["velocity"]["findings"][0]["kind"] == "overall"
        assert {key: midi[key] for key in ("summary", "bars", "worst_bars")} == \
            {key: plain[key] for key in ("summary", "bars", "worst_bars")}
