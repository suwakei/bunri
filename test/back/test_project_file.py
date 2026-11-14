"""プロジェクトの保存（`.bunri` v2）のテスト

- 文書の往復（トラック・ノート・お手本・クリップ・グリッド・状態の節・学習の記録・カルテ）
- 音声: 整数 PCM は FLAC にしてサンプルがビット単位で一致する。同じ音声は 1 つしか持たない
- v1（カルテだけ）のファイルを v2 に上げて開ける。以前の形式（projects/*.json）も開ける
- 作業用の写し・預かった音声・置き場のファイル名の検証（置き場の外を指せない）
- データの整理が、消してはいけないものを消さない
"""
import io
import json
import os
import sqlite3
import time

import numpy as np
import pytest
import soundfile as sf
from httpx import ASGITransport, AsyncClient

import audio_utils
import bunri_file
import guide_cache
import project_store
import song_chart


@pytest.fixture
def data_dir(tmp_path, monkeypatch):
    """データ置き場を一時ディレクトリへ向ける"""
    monkeypatch.setenv("BUNRI_DATA_DIR", str(tmp_path / "data"))
    return tmp_path / "data"


@pytest.fixture
def sample_chart():
    return song_chart.normalize_chart({
        "version": 1,
        "source": {"filename": "demo.wav", "duration_sec": 4.0},
        "grid": {"bpm": 120.0, "bpm_confidence": 0.8, "bpm_source": "auto", "downbeat_offset_sec": 0.25,
                 "time_signature": [4, 4], "beat_times_sec": [0.25, 0.75, 1.25, 1.75], "user_confirmed": False},
        "key": {"tonic": "C", "mode": "major", "confidence": 0.7, "alternatives": []},
        "sections": [{"id": "S1", "label": None, "suggested_label": "intro", "suggested_confidence": 0.5,
                      "start_bar": 1, "end_bar": 2, "start_sec": 0.25, "end_sec": 4.0, "repeat_group": "A",
                      "features": {"rms_db": -12.0, "onset_density": 3.0}}],
        "chords": [],
        "mix": {"loudness_lufs": -9.0, "peak_dbfs": -0.5, "dynamic_range_db": 6.0, "stereo_width": 0.5,
                "bass_mono": True, "reverb_tail_sec": 1.0, "spectrum_bands": []},
        "unavailable": {},
    })


def wav_bytes(seconds=0.5, sr=22050, subtype="PCM_16", channels=2, freq=440.0, seed=0):
    """少しだけ雑音を混ぜたサイン波の WAV（subtype を変えられる）"""
    rng = np.random.default_rng(seed)
    t = np.arange(int(seconds * sr)) / sr
    x = 0.4 * np.sin(2 * np.pi * freq * t) + 0.01 * rng.standard_normal(t.size)
    data = np.stack([x] * channels, axis=1) if channels > 1 else x
    out = io.BytesIO()
    sf.write(out, data, sr, format="WAV", subtype=subtype)
    return out.getvalue()


def note(name, octave, step, length=4):
    return {"note": name, "octave": octave, "step": step, "length": length}


def sample_document(song_hash, part_hash, chart=None):
    return {
        "version": 1,
        "meta": {"name": "デモ曲", "createdAt": "2026-11-12T10:00:00+0900", "appVersion": "0.1.0"},
        "grid": {"bpm": 120.0, "beatsPerBar": 4, "gridOffset": 0.25},
        "tracks": [
            {"name": "原曲", "role": "song", "part": None, "practiceOf": None, "gain": 0, "pan": 0,
             "mute": False, "solo": False, "notes": [], "referenceNotes": None,
             "clips": [{"name": "demo.wav", "offset": 0, "duration": 0.5, "audio": song_hash}]},
            {"name": "ベース", "role": "part", "part": "bass", "practiceOf": None, "gain": -3.5, "pan": -0.25,
             "mute": True, "solo": False, "notes": [], "referenceNotes": [note("C", 2, 0), note("G", 2, 8)],
             "clips": [{"name": "ベース", "offset": 0, "duration": 0.5, "audio": part_hash}],
             "extra": {"future": 1}},
            {"name": "ベースの練習", "role": "practice", "part": "bass", "practiceOf": 1, "gain": 0, "pan": 0,
             "mute": False, "solo": True, "notes": [note("C", 2, 0)], "referenceNotes": [],
             # 同じ音声を 2 回指しても、ファイルには 1 つだけ入る
             "clips": [{"name": "同じ音声", "offset": 1.0, "duration": 0.5, "audio": song_hash}]},
        ],
        "chart": None if chart is None else {"chartId": "demo", "chart": chart, "audio": song_hash,
                                             "audioName": "demo.wav", "peaks": {"points": 2, "max": [0.1, 0.2]}},
        "state": {
            "learn": {"version": 1, "ghostChoice": "auto", "coachPair": {"reference": 1, "attempt": 2}},
            "practice": {"version": 3, "loop": {"startBar": 2, "endBar": 4}, "speed": 0.75},
        },
        "history": [
            {"recordedAt": "2026-11-12T10:01:00+0900", "referenceTrack": 1, "attemptTrack": 2, "part": "bass",
             "startBar": 1, "endBar": 1, "referenceCount": 2, "matched": 1, "matchRate": 0.5,
             "counts": {"missing": 1, "pitch": 0, "octave": 0, "extra": 0, "timing": 0, "length": 0},
             "explanationId": None},
            {"recordedAt": "2026-11-12T10:05:00+0900", "referenceTrack": 1, "attemptTrack": 2, "part": "bass",
             "startBar": 1, "endBar": 1, "referenceCount": 2, "matched": 2, "matchRate": 1.0,
             "counts": {"missing": 0, "pitch": 0, "octave": 0, "extra": 0, "timing": 1, "length": 0},
             "explanationId": "a" * 40},
        ],
    }


def write_with(path, doc, audio):
    """音声の辞書（ハッシュ → バイト列）から入れて書く"""
    def blobs(conn, hashes):
        for h in hashes:
            bunri_file.insert_audio(conn, audio[h], "x.wav", expected_hash=h)
    return bunri_file.write_project(path, doc, blobs)


class TestAudio:
    @pytest.mark.parametrize("subtype", ["PCM_16", "PCM_24"])
    def test_整数PCMはFLACにしてサンプルがビット単位で一致する(self, subtype):
        src = wav_bytes(subtype=subtype)
        blob = bunri_file.encode_audio(src, "a.wav")
        assert blob["codec"] == "flac"
        assert len(blob["data"]) < len(src)
        out, media, ext = bunri_file.decode_audio(blob["codec"], blob["data"], "a.wav", blob["subtype"])
        assert (media, ext) == ("audio/wav", ".wav")
        dtype = "int16" if subtype == "PCM_16" else "int32"
        a, sr_a = sf.read(io.BytesIO(src), dtype=dtype)
        b, sr_b = sf.read(io.BytesIO(out), dtype=dtype)
        assert sr_a == sr_b and np.array_equal(a, b)
        assert sf.info(io.BytesIO(out)).subtype == subtype

    def test_浮動小数やMP3は元のバイト列のまま持つ(self):
        src = wav_bytes(subtype="FLOAT")
        blob = bunri_file.encode_audio(src, "f.wav")
        assert blob["codec"] == "raw" and blob["data"] == src
        mp3ish = b"ID3\x04fake-mp3"
        blob = bunri_file.encode_audio(mp3ish, "song.mp3")
        assert blob["codec"] == "raw"
        assert bunri_file.decode_audio("raw", blob["data"], "song.mp3") == (mp3ish, "audio/mpeg", ".mp3")

    def test_ハッシュの形でない指定は断る(self):
        with pytest.raises(bunri_file.BunriFileError):
            bunri_file.document_audio_hashes({"tracks": [{"clips": [{"audio": "../../etc/passwd"}]}]})


class TestDocument:
    def test_文書が往復する(self, tmp_path, sample_chart):
        song, part = wav_bytes(seed=1), wav_bytes(seed=2, freq=110)
        hs, hp = bunri_file.audio_hash(song), bunri_file.audio_hash(part)
        doc = sample_document(hs, hp, sample_chart)
        path = write_with(tmp_path / "p.bunri", doc, {hs: song, hp: part})

        back = bunri_file.read_project(path)
        assert back["meta"]["name"] == "デモ曲"
        assert back["grid"] == {"bpm": 120.0, "beatsPerBar": 4, "gridOffset": 0.25}
        tracks = back["tracks"]
        assert [t["name"] for t in tracks] == ["原曲", "ベース", "ベースの練習"]
        assert tracks[0]["referenceNotes"] is None
        assert tracks[1]["referenceNotes"] == [note("C", 2, 0), note("G", 2, 8)]
        assert tracks[2]["referenceNotes"] == []  # 空のお手本と、お手本が無いことを区別する
        assert tracks[1]["gain"] == -3.5 and tracks[1]["pan"] == -0.25 and tracks[1]["mute"] is True
        assert tracks[1]["extra"] == {"future": 1}
        assert tracks[2]["practiceOf"] == 1 and tracks[2]["solo"] is True
        assert tracks[2]["notes"] == [note("C", 2, 0)]
        assert tracks[2]["clips"] == [{"name": "同じ音声", "offset": 1.0, "duration": 0.5, "audio": hs}]
        assert back["state"]["practice"] == {"version": 3, "loop": {"startBar": 2, "endBar": 4}, "speed": 0.75}
        assert back["state"]["learn"]["coachPair"] == {"reference": 1, "attempt": 2}
        assert [h["matchRate"] for h in back["history"]] == [0.5, 1.0]
        assert back["history"][1]["counts"]["timing"] == 1
        assert back["history"][1]["explanationId"] == "a" * 40
        assert back["chart"]["chartId"] == "demo"
        assert back["chart"]["audio"] == hs
        assert back["chart"]["peaks"] == {"points": 2, "max": [0.1, 0.2]}
        assert song_chart.to_canonical_json(back["chart"]["chart"]) == song_chart.to_canonical_json(sample_chart)

        # 同じ音声 (原曲・練習のクリップ・カルテ) は 1 つだけ
        conn = sqlite3.connect(str(path))
        assert conn.execute("SELECT COUNT(*) FROM audio_blobs").fetchone()[0] == 2
        assert conn.execute("SELECT value FROM bunri_meta WHERE key='format_version'").fetchone()[0] == "2.0"
        conn.close()
        assert bunri_file.read_audio(path, hs)[0][:4] == b"RIFF"
        # カルテの API が使う元音声の取り出しも、ハッシュから取れる
        extracted = bunri_file.extract_audio(path, tmp_path / "x")
        assert extracted.suffix == ".wav" and extracted.stat().st_size > 0

    def test_音声が揃わなければ書かない(self, tmp_path):
        h = bunri_file.audio_hash(b"nothing")
        doc = sample_document(h, h)
        with pytest.raises(bunri_file.BunriFileError, match="揃いませんでした"):
            bunri_file.write_project(tmp_path / "p.bunri", doc, lambda conn, hashes: None)
        assert not (tmp_path / "p.bunri").exists()

    def test_ノートの強さが往復する_持たないノートには項目を付けない(self, tmp_path):
        song, part = wav_bytes(seed=1), wav_bytes(seed=2, freq=110)
        hs, hp = bunri_file.audio_hash(song), bunri_file.audio_hash(part)
        doc = sample_document(hs, hp)
        # お手本と打ち込みの両方に、強さの在るノートと無いノートを混ぜる。範囲の外や形の違う値は、無いものとして扱う
        doc["tracks"][1]["referenceNotes"] = [{**note("C", 2, 0), "velocity": 90}, note("G", 2, 8)]
        doc["tracks"][2]["notes"] = [
            {**note("C", 2, 0), "velocity": 1}, {**note("D", 2, 4), "velocity": 127}, note("E", 2, 8),
            {**note("F", 2, 12), "velocity": 0}, {**note("G", 2, 16), "velocity": 300}, {**note("A", 2, 20), "velocity": "強く"},
            {**note("B", 2, 24), "velocity": True},
        ]
        path = write_with(tmp_path / "p.bunri", doc, {hs: song, hp: part})

        tracks = bunri_file.read_project(path)["tracks"]
        assert tracks[1]["referenceNotes"] == [{**note("C", 2, 0), "velocity": 90}, note("G", 2, 8)]
        assert tracks[2]["notes"] == [
            {**note("C", 2, 0), "velocity": 1}, {**note("D", 2, 4), "velocity": 127}, note("E", 2, 8),
            note("F", 2, 12), note("G", 2, 16), note("A", 2, 20), note("B", 2, 24),
        ]

    def test_強さの列が無い頃のファイルも開ける(self, tmp_path):
        song, part = wav_bytes(seed=1), wav_bytes(seed=2, freq=110)
        hs, hp = bunri_file.audio_hash(song), bunri_file.audio_hash(part)
        path = write_with(tmp_path / "old.bunri", sample_document(hs, hp), {hs: song, hp: part})
        # 強さの列を足す前に保存したファイルの形に戻す
        conn = sqlite3.connect(str(path))
        conn.execute("ALTER TABLE project_notes DROP COLUMN velocity")
        conn.commit()
        conn.close()

        tracks = bunri_file.read_project(path)["tracks"]
        assert tracks[1]["referenceNotes"] == [note("C", 2, 0), note("G", 2, 8)]
        assert tracks[2]["notes"] == [note("C", 2, 0)]

    def test_新しすぎる版は開かない(self, tmp_path):
        song = wav_bytes()
        h = bunri_file.audio_hash(song)
        path = write_with(tmp_path / "p.bunri", sample_document(h, h), {h: song})
        conn = sqlite3.connect(str(path))
        conn.execute("UPDATE bunri_meta SET value='3.0' WHERE key='format_version'")
        conn.commit()
        conn.close()
        with pytest.raises(bunri_file.BunriFileError, match="新しい形式"):
            bunri_file.read_project(path)


def make_v1_file(path, chart, audio_name, audio):
    """v1（カルテと元音声だけ。format_version 1.0）のファイルを、当時の表の形で作る"""
    v1_schema = bunri_file._SCHEMA.split("-- ---- v2")[0].replace(",\n    audio_hash    TEXT", "")
    conn = sqlite3.connect(str(path))
    conn.executescript(v1_schema)
    conn.executemany("INSERT INTO bunri_meta (key, value) VALUES (?, ?)",
                     [("format_version", "1.0"), ("app_version", "0.1.0"), ("created_by", "bunri")])
    conn.row_factory = sqlite3.Row
    bunri_file._write_chart(conn, chart)
    conn.execute("INSERT INTO chart_audio (chart_id, filename, embedded, external_path, data) VALUES (1,?,1,NULL,?)",
                 (audio_name, audio))
    conn.commit()
    conn.close()


class TestMigration:
    def test_v1のカルテだけのファイルを上げて開ける(self, tmp_path, sample_chart):
        audio = wav_bytes(seconds=1.0)
        path = tmp_path / "old.bunri"
        make_v1_file(path, sample_chart, "song.wav", audio)
        assert "audio_hash" not in {r[1] for r in sqlite3.connect(str(path)).execute("PRAGMA table_info(chart_audio)")}

        assert bunri_file.migrate(path) == "1.0"
        doc = bunri_file.read_project(path)
        assert doc["meta"]["name"] == "old"
        assert doc["grid"]["bpm"] == 120.0 and doc["grid"]["gridOffset"] == 0.25
        assert len(doc["tracks"]) == 1 and doc["tracks"][0]["role"] == "song"
        clip = doc["tracks"][0]["clips"][0]
        assert clip["audio"] == bunri_file.audio_hash(audio) and clip["duration"] == pytest.approx(1.0)
        out = bunri_file.read_audio(path, clip["audio"])[0]
        assert np.array_equal(sf.read(io.BytesIO(out), dtype="int16")[0], sf.read(io.BytesIO(audio), dtype="int16")[0])
        # 上げたあともカルテはそのまま読める
        assert song_chart.to_canonical_json(bunri_file.read_chart(path)) == song_chart.to_canonical_json(sample_chart)
        # 2 回上げても変わらない
        assert bunri_file.migrate(path) == "2.0"

    def test_カルテのAPIが作るファイルもプロジェクトとして開ける(self, tmp_path, sample_chart):
        audio = wav_bytes()
        src = tmp_path / "a.wav"
        src.write_bytes(audio)
        path = bunri_file.create(tmp_path / "c.bunri", sample_chart, audio_path=src)
        bunri_file.migrate(path)
        doc = bunri_file.read_project(path)
        assert doc["tracks"][0]["clips"][0]["audio"] == bunri_file.audio_hash(audio)


class TestStore:
    def test_保存と開くの往復_音声は1回だけ送る(self, data_dir, sample_chart):
        song, part = wav_bytes(seed=1), wav_bytes(seed=2)
        hs, hp = bunri_file.audio_hash(song), bunri_file.audio_hash(part)
        doc = sample_document(hs, hp, sample_chart)
        assert project_store.missing_audio(None, [hs, hp, hs]) == [hs, hp]
        project_store.stage_audio(hs, song, "demo.wav")
        project_store.stage_audio(hp, part, "bass.wav")
        assert project_store.missing_audio(None, [hs, hp]) == []
        first = project_store.save_document(doc)
        assert first["audio_count"] == 2
        # 預かった音声は、写しに入ったら消える
        assert list((data_dir / "work" / "staged").iterdir()) == []

        # 保存し直すときは、前の写しに在る音声を送らなくてよい
        assert project_store.missing_audio(first["token"], [hs, hp]) == []
        doc["tracks"][2]["notes"].append(note("E", 2, 4))
        second = project_store.save_document(doc, base=first["token"])
        assert second["token"] != first["token"]

        opened = project_store.open_document(second["token"])
        assert len(opened["tracks"][2]["notes"]) == 2
        assert opened["audioBase"] == f"/api/project/{second['token']}/audio/"
        # カルテを、カルテの API が使う置き場へ置き直している (解析はしない)
        restored = audio_utils.results_dir("charts") / "demo.bunri"
        assert restored.exists()
        assert song_chart.to_canonical_json(bunri_file.read_chart(restored)) == song_chart.to_canonical_json(sample_chart)
        assert project_store.read_audio(second["token"], hp)[1] == "audio/wav"

    def test_ガイドと説明の写しを持ち運び_開くと戻す(self, data_dir, sample_chart, monkeypatch):
        import reproduction_guide

        song = wav_bytes()
        hs = bunri_file.audio_hash(song)
        project_store.stage_audio(hs, song, "demo.wav")
        guide_key = reproduction_guide.cache_keys_for(sample_chart)[0]
        guide_cache.save(guide_key, {"guide": {"overview": "保存したガイド"}})
        coach_key = "b" * 40
        guide_cache.save(coach_key, {"explanation": {"summary": "保存した説明"}}, kind="coach")
        doc = sample_document(hs, hs, sample_chart)
        doc["explanations"] = {"coach": [coach_key, "../../evil"]}
        saved = project_store.save_document(doc)

        # 別の PC で開いた (保存の置き場が空) のと同じにする
        for p in list((data_dir / "results" / "guide" / "cache").iterdir()) + list((data_dir / "results" / "coach" / "cache").iterdir()):
            p.unlink()
        opened = project_store.open_document(saved["token"])
        assert opened["restored"] == {"guide": 1, "coach": 1}
        assert guide_cache.load(guide_key)["guide"]["overview"] == "保存したガイド"
        assert guide_cache.load(coach_key, kind="coach")["explanation"]["summary"] == "保存した説明"

    def test_預かる音声は中身とハッシュが合わなければ断る(self, data_dir):
        with pytest.raises(project_store.ProjectError):
            project_store.stage_audio("0" * 64, b"different", "a.wav")
        with pytest.raises(project_store.ProjectError):
            project_store.stage_audio("../" + "0" * 61, b"x", "a.wav")

    @pytest.mark.parametrize("token", ["../x", "", "ABC", "0" * 23, "0" * 24 + "/../a", None])
    def test_写しの名前は決まった形だけ(self, data_dir, token):
        with pytest.raises(project_store.ProjectError):
            project_store.work_path(token)

    def test_置き場への保存と一覧と開く(self, data_dir):
        song = wav_bytes()
        hs = bunri_file.audio_hash(song)
        project_store.stage_audio(hs, song, "demo.wav")
        saved = project_store.save_document(sample_document(hs, hs))
        a = project_store.library_save(saved["token"], "曲/名:前")
        assert a == {"file": "曲_名_前.bunri", "name": "曲_名_前"}
        b = project_store.library_save(saved["token"], "曲/名:前")
        assert b["file"] == "曲_名_前 (2).bunri"
        # 上書きは、在る .bunri だけ
        assert project_store.library_save(saved["token"], None, file=a["file"]) == a
        with pytest.raises(project_store.ProjectError):
            project_store.library_save(saved["token"], None, file="../escape.bunri")
        (data_dir / "projects" / "project_1.json").write_text(json.dumps({"bpm": 90}), encoding="utf-8")
        items = project_store.library_list()
        assert {i["kind"] for i in items} == {"bunri", "legacy"}
        opened = project_store.library_open(a["file"])
        assert project_store.open_document(opened["token"])["meta"]["name"] == "デモ曲"
        for bad in ["../x.bunri", "/etc/passwd", "a/b.bunri", ""]:
            with pytest.raises(project_store.ProjectError):
                project_store.library_open(bad)

    def test_以前の形式は音声の無いクリップとして開く(self, data_dir):
        legacy = {
            "bpm": 96, "beatsPerBar": 3, "gridOffset": 0.5,
            "tracks": [
                {"name": "Lead", "gain": -2, "pan": 0.5, "mute": True, "pianoNotes": [note("C", 4, 0)],
                 "clips": [{"name": "take.wav", "offset": 1.5, "duration": 3.0}], "role": "part", "part": "bass"},
                {"name": "Lead の練習", "role": "practice", "practiceOfIndex": 0, "pianoNotes": []},
            ],
            "automation": {"1_volume": []},
        }
        (data_dir / "projects").mkdir(parents=True, exist_ok=True)
        (data_dir / "projects" / "project_1700000000.json").write_text(json.dumps(legacy), encoding="utf-8")
        doc = project_store.library_open("project_1700000000.json")["document"]
        assert doc["source"] == {"kind": "legacy", "file": "project_1700000000.json"}
        assert doc["grid"] == {"bpm": 96.0, "beatsPerBar": 3, "gridOffset": 0.5}
        assert doc["tracks"][0]["clips"] == [{"name": "take.wav", "offset": 1.5, "duration": 3.0, "audio": None}]
        assert doc["tracks"][1]["practiceOf"] == 0
        assert "automation" not in json.dumps(doc)
        # 以前の形式のファイルは消さない
        assert (data_dir / "projects" / "project_1700000000.json").exists()


class TestCleanup:
    def test_消してよいものだけを消す(self, data_dir):
        old = time.time() - 3600
        def put(rel, data=b"x" * 10, age=old):
            p = data_dir / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(data)
            os.utime(p, (age, age))
            return p
        removable = [put("uploads/a.wav"), put("results/sep_bass_a.wav"), put("results/edited/e.wav"),
                     put("results/charts/old.bunri"), put("work/" + "1" * 24 + ".bunri"), put("work/staged/" + "f" * 64)]
        kept = [put("results/charts/current.bunri"), put("work/" + "2" * 24 + ".bunri"),
                put("results/guide/cache/" + "a" * 40 + ".json"), put("results/coach/cache/" + "b" * 40 + ".json"),
                put("results/guide/usage.jsonl"), put("projects/mine.bunri"), put("projects/project_1.json"),
                put("uploads/new.wav", age=time.time())]
        outside = put("../outside.bunri")
        usage = project_store.storage_usage()
        assert {c["key"] for c in usage["categories"]} == {"uploads", "results", "charts", "work", "claude", "projects"}

        result = project_store.cleanup(keep_tokens=["2" * 24], keep_charts=["current"])
        assert result["removed_files"] == len(removable)
        assert all(not p.exists() for p in removable)
        assert all(p.exists() for p in kept)
        assert outside.exists()


class TestApi:
    @pytest.fixture
    def client(self):
        from web.api import app
        return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")

    @pytest.mark.asyncio
    async def test_保存から開くまで(self, client, data_dir, sample_chart):
        song = wav_bytes()
        hs = bunri_file.audio_hash(song)
        doc = sample_document(hs, hs, sample_chart)
        r = await client.post("/api/project/audio/missing", json={"base": None, "hashes": [hs]})
        assert r.json() == {"missing": [hs]}
        r = await client.put(f"/api/project/audio/{hs}?name=demo.wav", content=song)
        assert r.status_code == 200
        r = await client.put(f"/api/project/audio/{'0' * 64}", content=b"wrong")
        assert r.status_code == 400
        r = await client.post("/api/project/document", json={"base": None, "document": doc})
        assert r.status_code == 200, r.text
        token = r.json()["token"]
        r = await client.post("/api/project/library/save", json={"token": token, "name": "デモ"})
        assert r.json()["file"] == "デモ.bunri"
        r = await client.get("/api/project/library")
        assert r.json()["projects"][0]["name"] == "デモ"
        r = await client.post("/api/project/library/open", json={"file": "デモ.bunri"})
        token2 = r.json()["token"]
        r = await client.post(f"/api/project/open/{token2}")
        assert r.status_code == 200
        assert r.json()["tracks"][1]["name"] == "ベース"
        r = await client.get(f"/api/project/{token2}/audio/{hs}")
        assert r.status_code == 200 and r.headers["content-type"] == "audio/wav"
        r = await client.get(f"/api/project/{token2}/audio/{'1' * 64}")
        assert r.status_code == 404
        r = await client.post("/api/project/open/..%2F..%2Fetc")
        assert r.status_code in (400, 404)
        r = await client.get("/api/storage")
        assert r.status_code == 200 and r.json()["total_bytes"] > 0
        r = await client.post("/api/storage/cleanup", json={"keep_tokens": [token2]})
        assert r.status_code == 200
