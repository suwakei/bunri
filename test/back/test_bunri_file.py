"""bunri_file モジュールのテスト（`.bunri` ドキュメントの読み書き）

依存は標準ライブラリの sqlite3 のみなので、音声解析なしで検証できる。
"""
import sqlite3

import pytest

import bunri_file
import song_chart


@pytest.fixture
def sample_chart():
    """検証用のカルテ辞書（解析を走らせずに済むよう手で組み立てる）"""
    return song_chart.normalize_chart({
        "version": 1,
        "source": {"filename": "demo.wav", "duration_sec": 12.5},
        "grid": {
            "bpm": 128.0, "bpm_confidence": 0.82, "bpm_source": "auto",
            "downbeat_offset_sec": 0.412, "time_signature": [4, 4],
            "beat_times_sec": [0.412, 0.881, 1.35, 1.819], "user_confirmed": False,
        },
        "key": {
            "tonic": "C", "mode": "major", "confidence": 0.71,
            "alternatives": [{"tonic": "A", "mode": "minor", "confidence": 0.68}],
        },
        "sections": [{
            "id": "S1", "label": None, "suggested_label": "intro",
            "suggested_confidence": 0.5, "start_bar": 1, "end_bar": 4,
            "start_sec": 0.412, "end_sec": 8.0, "repeat_group": "A",
            "features": {"rms_db": -12.3, "onset_density": 4.2},
        }],
        "chords": [{
            "beat_index": 0, "beat_count": 4, "bar": 1, "beat": 1,
            "start_sec": 0.412, "end_sec": 1.819, "root": "C", "quality": "maj",
            "symbol": "C", "degree": "I", "confidence": 0.88,
        }],
        "mix": {
            "loudness_lufs": -8.2, "peak_dbfs": -0.3, "dynamic_range_db": 6.1,
            "stereo_width": 0.62, "bass_mono": True, "reverb_tail_sec": 1.4,
            "spectrum_bands": [{"name": "low", "hz": [60, 250], "energy_db": -14.2}],
        },
        "unavailable": {"sections": "テスト用の理由"},
    })


@pytest.fixture
def audio_file(tmp_path):
    """内包テスト用のダミー音声ファイル"""
    path = tmp_path / "demo.wav"
    path.write_bytes(b"RIFF____WAVEfake-audio-bytes")
    return path


class TestRoundTrip:
    def test_chart_survives_round_trip_byte_identical(self, tmp_path, sample_chart):
        """書き込んだカルテが1バイトも変わらずに読み戻せる

        `.bunri` から読み出したカルテはそのままプロンプトキャッシュの
        プレフィックスになるため、往復でバイトが変わると全キャッシュが飛ぶ。
        """
        path = tmp_path / "demo.bunri"
        bunri_file.create(path, sample_chart)

        expected = song_chart.to_canonical_json(sample_chart)
        assert song_chart.to_canonical_json(bunri_file.read_chart(path)) == expected
        assert bunri_file.chart_json(path) == expected

    def test_none_values_survive(self, tmp_path, sample_chart):
        """None が偽の値に化けない"""
        sample_chart["key"]["tonic"] = None
        sample_chart["mix"]["bass_mono"] = None
        path = tmp_path / "demo.bunri"
        bunri_file.create(path, sample_chart)

        loaded = bunri_file.read_chart(path)
        assert loaded["key"]["tonic"] is None
        assert loaded["mix"]["bass_mono"] is None

    def test_unavailable_reasons_survive(self, tmp_path, sample_chart):
        """検出できなかった理由が保持される"""
        loaded_path = tmp_path / "demo.bunri"
        bunri_file.create(loaded_path, sample_chart)
        assert bunri_file.read_chart(loaded_path)["unavailable"]["sections"] == "テスト用の理由"

    def test_meta_is_written(self, tmp_path, sample_chart):
        """メタ情報が書き込まれる"""
        path = tmp_path / "demo.bunri"
        bunri_file.create(path, sample_chart, app_version="9.9.9")

        meta = bunri_file.read_meta(path)
        assert meta["format_version"] == bunri_file.FORMAT_VERSION
        assert meta["app_version"] == "9.9.9"
        assert meta["created_by"] == "bunri"

    def test_overwrites_existing_file(self, tmp_path, sample_chart):
        """既存ファイルは上書きされる（1ファイル1曲）"""
        path = tmp_path / "demo.bunri"
        bunri_file.create(path, sample_chart)
        sample_chart["grid"]["bpm"] = 90.0
        bunri_file.create(path, sample_chart)
        assert bunri_file.read_chart(path)["grid"]["bpm"] == 90.0


class TestUpdateChart:
    def test_replaces_chart(self, tmp_path, sample_chart):
        """グリッド補正後のカルテで差し替えられる"""
        path = tmp_path / "demo.bunri"
        bunri_file.create(path, sample_chart)

        updated = dict(sample_chart)
        updated["grid"] = dict(sample_chart["grid"], bpm=64.0, bpm_source="user", user_confirmed=True)
        bunri_file.update_chart(path, updated)

        grid = bunri_file.read_chart(path)["grid"]
        assert grid["bpm"] == 64.0
        assert grid["bpm_source"] == "user"
        assert grid["user_confirmed"] is True

    def test_does_not_leave_stale_rows(self, tmp_path, sample_chart):
        """差し替え時に古い行が残らない"""
        path = tmp_path / "demo.bunri"
        bunri_file.create(path, sample_chart)

        updated = dict(sample_chart)
        updated["chords"] = []
        updated["sections"] = []
        bunri_file.update_chart(path, updated)

        loaded = bunri_file.read_chart(path)
        assert loaded["chords"] == []
        assert loaded["sections"] == []

    def test_preserves_audio(self, tmp_path, sample_chart, audio_file):
        """カルテ差し替えで音声は消えない"""
        path = tmp_path / "demo.bunri"
        bunri_file.create(path, sample_chart, audio_path=audio_file)
        bunri_file.update_chart(path, sample_chart)
        assert bunri_file.extract_audio(path, tmp_path / "out") is not None

    def test_missing_file_raises(self, tmp_path, sample_chart):
        """存在しないファイルの更新は BunriFileError を投げる"""
        with pytest.raises(bunri_file.BunriFileError):
            bunri_file.update_chart(tmp_path / "無い.bunri", sample_chart)


class TestAudio:
    def test_embedded_audio_round_trip(self, tmp_path, sample_chart, audio_file):
        """内包した音声をバイト単位で取り出せる"""
        path = tmp_path / "demo.bunri"
        bunri_file.create(path, sample_chart, audio_path=audio_file, embed_audio=True)

        extracted = bunri_file.extract_audio(path, tmp_path / "out")
        assert extracted is not None
        assert extracted.read_bytes() == audio_file.read_bytes()

    def test_external_reference(self, tmp_path, sample_chart, audio_file):
        """外部参照モードでは元ファイルのパスを返す"""
        path = tmp_path / "demo.bunri"
        bunri_file.create(path, sample_chart, audio_path=audio_file, embed_audio=False)

        assert bunri_file.extract_audio(path, tmp_path / "out") == audio_file.resolve()

    def test_external_reference_returns_none_when_gone(self, tmp_path, sample_chart, audio_file):
        """外部参照先が消えていれば None を返す（リンク切れ）"""
        path = tmp_path / "demo.bunri"
        bunri_file.create(path, sample_chart, audio_path=audio_file, embed_audio=False)
        audio_file.unlink()
        assert bunri_file.extract_audio(path, tmp_path / "out") is None

    def test_no_audio_returns_none(self, tmp_path, sample_chart):
        """音声を保存していなければ None を返す"""
        path = tmp_path / "demo.bunri"
        bunri_file.create(path, sample_chart)
        assert bunri_file.extract_audio(path, tmp_path / "out") is None

    def test_embedding_missing_file_raises(self, tmp_path, sample_chart):
        """内包しようとした音声が無ければ FileNotFoundError を投げる"""
        with pytest.raises(FileNotFoundError):
            bunri_file.create(tmp_path / "d.bunri", sample_chart, audio_path=tmp_path / "無い.wav")


class TestVersioning:
    def test_forward_compatible_with_unknown_tables_and_columns(self, tmp_path, sample_chart):
        """新しい bunri が書いたファイルを古い bunri が開ける

        未知のテーブル・列は明示的に SELECT しないので自然に無視される。
        """
        path = tmp_path / "demo.bunri"
        bunri_file.create(path, sample_chart)
        expected = song_chart.to_canonical_json(sample_chart)

        conn = sqlite3.connect(str(path))
        conn.execute("CREATE TABLE future_feature (id INTEGER, blah TEXT)")
        conn.execute("ALTER TABLE charts ADD COLUMN future_col TEXT")
        conn.execute("UPDATE bunri_meta SET value = '1.7' WHERE key = 'format_version'")
        conn.commit()
        conn.close()

        assert song_chart.to_canonical_json(bunri_file.read_chart(path)) == expected

    def test_rejects_newer_major_version(self, tmp_path, sample_chart):
        """メジャーバージョンが上のファイルは拒否する（いまは 2.0 なので 3.0）"""
        path = tmp_path / "demo.bunri"
        bunri_file.create(path, sample_chart)

        conn = sqlite3.connect(str(path))
        conn.execute("UPDATE bunri_meta SET value = '3.0' WHERE key = 'format_version'")
        conn.commit()
        conn.close()

        with pytest.raises(bunri_file.BunriFileError, match="新しい形式"):
            bunri_file.read_chart(path)

    def test_rejects_non_bunri_sqlite(self, tmp_path):
        """bunri 形式でない SQLite ファイルは拒否する"""
        path = tmp_path / "other.bunri"
        conn = sqlite3.connect(str(path))
        conn.execute("CREATE TABLE unrelated (id INTEGER)")
        conn.commit()
        conn.close()

        with pytest.raises(bunri_file.BunriFileError):
            bunri_file.read_chart(path)

    def test_missing_file_raises(self, tmp_path):
        """存在しないファイルは BunriFileError を投げる"""
        with pytest.raises(bunri_file.BunriFileError):
            bunri_file.read_chart(tmp_path / "無い.bunri")

    def test_chart_absent_raises(self, tmp_path, sample_chart, audio_file):
        """カルテが保存されていないファイルは明示的にエラーにする"""
        path = tmp_path / "demo.bunri"
        bunri_file.create(path, sample_chart)

        conn = sqlite3.connect(str(path))
        conn.execute("DELETE FROM charts")
        conn.commit()
        conn.close()

        with pytest.raises(bunri_file.BunriFileError, match="カルテ"):
            bunri_file.read_chart(path)
