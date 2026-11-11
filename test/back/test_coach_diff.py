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
