"""music_theory モジュールのテスト（キー推定・コード検出・ディグリー変換）"""
import numpy as np
import pytest

import music_theory as mt


def _chroma_for(pitch_classes, strength=1.0, floor=0.05):
    """指定したピッチクラスだけが鳴っているクロマベクトルを作る"""
    vec = np.full(12, floor, dtype=float)
    for pc in pitch_classes:
        vec[pc % 12] = strength
    return vec


class TestEstimateKey:
    def test_c_major_scale(self):
        """Cメジャースケールのクロマからは C major が推定される"""
        result = mt.estimate_key(_chroma_for([0, 2, 4, 5, 7, 9, 11], strength=1.0))
        assert result["tonic"] == "C"
        assert result["mode"] == "major"
        assert result["confidence"] > 0

    def test_flat_chroma_yields_no_key(self):
        """全ての音が同程度に鳴っていればキーは推定しない（無調・ノイズ対策）"""
        result = mt.estimate_key(np.ones(12))
        assert result["tonic"] is None
        assert result["mode"] is None
        assert result["confidence"] == 0.0

    def test_weak_contrast_with_clear_profile_is_likely(self):
        """起伏は弱いがプロファイルとはっきり合うクロマ（倍音の多い矩形波の曲）では、
        キーを出すが「確実」とは言わない"""
        profile = np.roll(np.asarray(mt.KS_MINOR_PROFILE), 9)  # A マイナー
        chroma = 1.0 + 0.12 * (profile - profile.mean())
        flatness = float(np.std(chroma) / np.mean(chroma))
        assert mt._KEY_FLATNESS_MIN <= flatness < mt._KEY_FLATNESS_CLEAR
        result = mt.estimate_key(chroma)
        assert (result["tonic"], result["mode"]) == ("A", "minor")
        assert 0 < result["confidence"] <= mt._KEY_WEAK_MAX_CONFIDENCE

    def test_weak_contrast_without_clear_profile_yields_no_key(self):
        """起伏が弱く、プロファイルとも合わないクロマではキーを出さない"""
        rng = np.random.RandomState(3)
        chroma = 1.0 + 0.6 * rng.rand(12)
        flatness = float(np.std(chroma) / np.mean(chroma))
        assert mt._KEY_FLATNESS_MIN <= flatness < mt._KEY_FLATNESS_CLEAR
        corr = max(np.corrcoef(chroma, np.roll(prof, t))[0, 1]
                   for prof in (mt.KS_MAJOR_PROFILE, mt.KS_MINOR_PROFILE) for t in range(12))
        assert corr < mt._KEY_WEAK_MIN_CORR
        assert mt.estimate_key(chroma)["tonic"] is None

    def test_empty_chroma_yields_no_key(self):
        """クロマが全て0（無音）ならキーは推定しない"""
        result = mt.estimate_key(np.zeros(12))
        assert result["tonic"] is None
        assert result["confidence"] == 0.0

    def test_alternatives_are_returned(self):
        """次点候補が確信度つきで返る"""
        result = mt.estimate_key(_chroma_for([0, 2, 4, 5, 7, 9, 11]))
        assert len(result["alternatives"]) == 2
        for alt in result["alternatives"]:
            assert alt["tonic"] in mt.NOTE_NAMES
            assert alt["mode"] in ("major", "minor")

    def test_rejects_wrong_length(self):
        """長さが12でないベクトルは受け付けない"""
        with pytest.raises(ValueError):
            mt.estimate_key(np.ones(7))


class TestMatchChord:
    def test_major_triad(self):
        """C/E/G が鳴っていれば C メジャーと判定される"""
        root, quality, confidence = mt._match_chord(_chroma_for([0, 4, 7]))
        assert mt.NOTE_NAMES[root] == "C"
        assert quality == "maj"
        assert confidence > 0.5

    def test_minor_triad(self):
        """A/C/E が鳴っていれば A マイナーと判定される"""
        root, quality, _ = mt._match_chord(_chroma_for([9, 0, 4]))
        assert mt.NOTE_NAMES[root] == "A"
        assert quality == "min"

    def test_bass_hint_disambiguates_am_from_fmaj7(self):
        """ベース音の手がかりが Am と Fmaj7 の取り違えを解消する

        A/C/E は Am の全構成音であると同時に Fmaj7 (F,A,C,E) の一部でもあり、
        クロマだけでは区別できない。低音がどれかが決め手になる。
        """
        # F がわずかに混じった曖昧なクロマ（どちらとも読める領域）
        vec = _chroma_for([9, 0, 4], strength=1.0, floor=0.05)
        vec[5] = 0.25  # F
        assert mt.NOTE_NAMES[mt._match_chord(vec, bass_pc=9)[0]] == "A"
        assert mt.NOTE_NAMES[mt._match_chord(vec, bass_pc=5)[0]] == "F"

    def test_bass_hint_does_not_override_strong_evidence(self):
        """ベース音はタイブレーカーであって、強い証拠を覆さない

        これが崩れると、経過音やオンコード（C/E など）で根音を取り違える。
        """
        # F がはっきり鳴っていれば Fmaj7 が正しい読み。A ベースでも覆らない
        vec = _chroma_for([9, 0, 4], strength=1.0, floor=0.05)
        vec[5] = 1.0  # F
        assert mt.NOTE_NAMES[mt._match_chord(vec, bass_pc=9)[0]] == "F"

    def test_empty_chroma_returns_none(self):
        """クロマが全て0なら判定不能として None を返す"""
        assert mt._match_chord(np.zeros(12)) is None

    def test_confidence_is_bounded(self):
        """確信度は 0.0〜1.0 に収まる"""
        for pcs in ([0, 4, 7], [0, 3, 7], [0, 4, 7, 11], [0, 1, 2, 3, 4, 5]):
            result = mt._match_chord(_chroma_for(pcs))
            if result is not None:
                assert 0.0 <= result[2] <= 1.0

    def test_pure_sus4_is_still_detected(self):
        """構成音（G・C・D）だけが鳴っていれば、減点があっても sus4 になる"""
        root, quality, _ = mt._match_chord(_chroma_for([7, 0, 2], strength=1.0))
        assert (mt.NOTE_NAMES[root], quality) == ("G", "sus4")

    def test_major_with_fifth_harmonics_is_not_sus4(self):
        """長三和音に倍音（5 度上の音）が薄く乗っても、sus4 に化けない

        C の和音（C・E・G）では、G の第 3 倍音の D が混ざる。3 度（E）が弱めだと、
        クロマは {C, D, G}（= Gsus4 / Csus2）に寄る。
        """
        chroma = np.zeros(12)
        chroma[[0, 7]] = 1.0   # C, G
        chroma[4] = 0.55       # E（3 度）がやや弱い
        chroma[2] = 0.6        # D（G の倍音）
        root, quality, _ = mt._match_chord(chroma, bass_pc=0)
        assert (mt.NOTE_NAMES[root], quality) == ("C", "maj")


class TestChordContrast:
    def test_flat_chroma_gives_zero(self):
        """全ピッチクラスが均等ならコントラストは0（＝どのコードでもない）"""
        assert mt._chord_contrast(np.ones(12), 0, [0, 4, 7]) == pytest.approx(0.0)

    def test_matching_template_scores_higher_than_mismatch(self):
        """構成音が鳴っているテンプレートのほうが高いスコアになる"""
        vec = _chroma_for([0, 4, 7])
        assert mt._chord_contrast(vec, 0, [0, 4, 7]) > mt._chord_contrast(vec, 1, [0, 4, 7])

    def test_absent_template_note_lowers_score(self):
        """テンプレートにあるのに鳴っていない音があるとスコアが下がる

        コサイン類似度を使わない理由そのもの。これが効かないと4音テンプレートが
        3音を組織的に打ち負かし、G が Gmaj7 に化ける。
        """
        vec = _chroma_for([0, 4, 7])  # C/E/G のみ。B は鳴っていない
        triad = mt._chord_contrast(vec, 0, [0, 4, 7])
        seventh = mt._chord_contrast(vec, 0, [0, 4, 7, 11])  # Cmaj7
        assert triad > seventh


class TestToDegree:
    @pytest.mark.parametrize("root,quality,tonic,mode,expected", [
        ("C", "maj", "C", "major", "I"),
        ("G", "maj", "C", "major", "V"),
        ("A", "min", "C", "major", "vim"),
        ("F", "maj", "C", "major", "IV"),
        ("G", "7", "C", "major", "V7"),
        ("B", "maj", "C", "major", "VII"),
        ("A", "min", "A", "minor", "im"),
        ("C", "maj", "A", "minor", "III"),
        ("G", "maj", "A", "minor", "VII"),
    ])
    def test_degrees(self, root, quality, tonic, mode, expected):
        """主要なディグリー表記が正しく求まる"""
        assert mt.to_degree(root, quality, tonic, mode) == expected

    def test_minor_quality_is_lowercase(self):
        """短三和音系のディグリーは小文字になる"""
        assert mt.to_degree("D", "min", "C", "major").startswith("ii")

    def test_none_key_returns_none(self):
        """キーが不明ならディグリーは付けられない"""
        assert mt.to_degree("C", "maj", None, None) is None
        assert mt.to_degree("C", "maj", "C", None) is None

    def test_invalid_root_returns_none(self):
        """不正な音名では例外を投げずに None を返す"""
        assert mt.to_degree("H", "maj", "C", "major") is None


class TestDespikeLabels:
    def test_single_beat_spike_is_removed(self):
        """前後が同じコードなら1拍だけの別コードは均される"""
        c, g = (0, "maj", 0.9), (7, "maj", 0.8)
        result = mt._despike_labels([c, g, c])
        assert result[1][0] == 0 and result[1][1] == "maj"

    def test_two_beat_change_is_preserved(self):
        """2拍以上続くコードチェンジは残す（1小節2コードを潰さない）"""
        c, g = (0, "maj", 0.9), (7, "maj", 0.8)
        result = mt._despike_labels([c, g, g, c])
        assert result[1][0] == 7 and result[2][0] == 7

    def test_short_input_is_untouched(self):
        """3要素未満はそのまま返す"""
        assert mt._despike_labels([(0, "maj", 0.9)]) == [(0, "maj", 0.9)]


class TestGlossary:
    def test_every_chord_quality_has_an_entry(self):
        """全てのコード品質に用語解説がある（ツールチップ義務化のため）"""
        for quality in mt.CHORD_TEMPLATES:
            assert mt.glossary_entry(quality), f"{quality} の解説が無い"

    def test_entries_use_language_map(self):
        """辞書は言語マップ構造になっている（多言語対応の器）"""
        for term, entry in mt.GLOSSARY.items():
            assert isinstance(entry, dict), f"{term} が言語マップでない"
            assert "ja" in entry, f"{term} に日本語が無い"

    def test_unknown_term_returns_none(self):
        """未知の用語では None を返す"""
        assert mt.glossary_entry("存在しない用語") is None

    def test_falls_back_to_japanese(self):
        """未対応言語を指定しても日本語にフォールバックする"""
        assert mt.glossary_entry("bpm", lang="fr") == mt.GLOSSARY["bpm"]["ja"]


class TestDetectChords:
    def test_detects_progression(self, chord_song):
        """合成音源から C→G→Am→F の進行を小節単位で検出できる"""
        path, truth = chord_song
        import structure

        grid = structure.estimate_grid(path)
        chords = mt.detect_chords(
            path, grid["beat_times_sec"], tonic=truth["tonic"], mode=truth["mode"]
        )
        assert chords

        # 小節ごとに最も長いコードを取り、真値と突き合わせる
        per_bar = {}
        for chord in chords:
            bar = chord["beat_index"] // 4 + 1
            if bar not in per_bar or chord["beat_count"] > per_bar[bar]["beat_count"]:
                per_bar[bar] = chord

        matched = 0
        for bar, chord in per_bar.items():
            expected = truth["progression"][(bar - 1) % 4]
            expected_root = expected.rstrip("m")
            is_minor_expected = expected.endswith("m")
            if chord["root"] == expected_root and is_minor_expected == (chord["quality"] in ("min", "min7")):
                matched += 1
        assert matched >= len(per_bar) * 0.8, f"コード正解率が低い: {matched}/{len(per_bar)}"

    def test_degree_is_attached_when_key_known(self, chord_song):
        """キーが分かっていればディグリー表記が付く"""
        path, truth = chord_song
        import structure

        grid = structure.estimate_grid(path)
        chords = mt.detect_chords(path, grid["beat_times_sec"], tonic="C", mode="major")
        assert all(c["degree"] for c in chords)

    def test_degree_is_none_without_key(self, chord_song):
        """キーが不明ならディグリーは付かない"""
        path, _ = chord_song
        import structure

        grid = structure.estimate_grid(path)
        chords = mt.detect_chords(path, grid["beat_times_sec"])
        assert all(c["degree"] is None for c in chords)

    def test_empty_beats_returns_empty(self, chord_song):
        """ビート列が空ならコードは検出しない"""
        path, _ = chord_song
        assert mt.detect_chords(path, []) == []
        assert mt.detect_chords(path, [1.0]) == []

    def test_audio_length_where_chroma_frame_counts_differ(self, tmp_path):
        """全帯域と低域でクロマのフレーム数が食い違う長さの音声でも、例外を投げない

        CQT は帯域の低さに応じて音声を間引いてから解析するので、長さによっては
        低域のクロマのほうが 1 フレーム長くなる（10.1 秒、17.6 秒、25.1 秒、32.6 秒…）。
        以前はここで IndexError になり、その長さの曲はカルテを作れなかった。
        """
        import soundfile as sf

        sr = 22050
        t = np.arange(int(sr * 10.1)) / sr
        chord = sum(np.sin(2 * np.pi * hz * t) for hz in (261.63, 329.63, 392.0))
        path = tmp_path / "length.wav"
        sf.write(str(path), (0.2 * chord).astype(np.float32), sr)

        events = mt.detect_chords(str(path), [i * 0.5 for i in range(20)])
        assert events
        assert events[0]["symbol"] == "C"
