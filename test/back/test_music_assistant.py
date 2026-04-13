"""music_assistant モジュールのテスト"""
import json
import pytest
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT))


class TestRoute:
    def test_クラウドキーワードでクラウド選択(self):
        from music_assistant import _route
        assert _route("切ないメロディを作って") == "cloud"
        assert _route("エモい感じのAメロ") == "cloud"
        assert _route("ローファイっぽい雰囲気") == "cloud"

    def test_ローカルキーワードでローカル選択(self):
        from music_assistant import _route
        assert _route("4小節のコード進行") == "local"
        assert _route("シンプルなベースライン") == "local"
        assert _route("8ビートのドラムパターン") == "local"

    def test_空プロンプトはローカル(self):
        from music_assistant import _route
        assert _route("") == "local"

    def test_デフォルトはローカル(self):
        from music_assistant import _route
        assert _route("何か適当に") == "local"


class TestParseResponse:
    def test_純粋なJSONをパース(self):
        from music_assistant import _parse_response
        text = '{"notes":[{"note":"C","octave":4,"step":0,"length":4}],"explanation":"テスト"}'
        result = _parse_response(text)
        assert len(result["notes"]) == 1
        assert result["notes"][0]["note"] == "C"
        assert result["notes"][0]["octave"] == 4
        assert result["explanation"] == "テスト"

    def test_マークダウンコードフェンス付きJSONをパース(self):
        from music_assistant import _parse_response
        text = '```json\n{"notes":[{"note":"E","octave":4,"step":0,"length":4}],"explanation":""}\n```'
        result = _parse_response(text)
        assert result["notes"][0]["note"] == "E"

    def test_前後のテキストを無視してJSONを抽出(self):
        from music_assistant import _parse_response
        text = 'はい、提案します:\n{"notes":[{"note":"G","octave":3,"step":0,"length":8}],"explanation":"OK"}\n以上です。'
        result = _parse_response(text)
        assert result["notes"][0]["note"] == "G"
        assert result["notes"][0]["octave"] == 3

    def test_不正な音名は除外される(self):
        from music_assistant import _parse_response
        text = '{"notes":[{"note":"H","octave":4,"step":0,"length":4},{"note":"C","octave":4,"step":0,"length":4}],"explanation":""}'
        result = _parse_response(text)
        # Hは不正なので除外、Cだけ残る
        assert len(result["notes"]) == 1
        assert result["notes"][0]["note"] == "C"

    def test_不正な値は除外される(self):
        from music_assistant import _parse_response
        text = '{"notes":[{"note":"C","octave":15,"step":0,"length":4},{"note":"D","octave":4,"step":0,"length":4}],"explanation":""}'
        result = _parse_response(text)
        # octave 15 は範囲外なので除外
        assert len(result["notes"]) == 1
        assert result["notes"][0]["note"] == "D"

    def test_マイナスのstep_lengthは補正(self):
        from music_assistant import _parse_response
        text = '{"notes":[{"note":"C","octave":4,"step":-5,"length":-2}],"explanation":""}'
        result = _parse_response(text)
        assert result["notes"][0]["step"] == 0  # 負は0にクランプ
        assert result["notes"][0]["length"] == 1  # 負は1以上にクランプ

    def test_JSONが見つからない場合はエラー(self):
        from music_assistant import _parse_response, AssistantError
        with pytest.raises(AssistantError):
            _parse_response("JSONじゃない文字列")

    def test_壊れたJSONはエラー(self):
        from music_assistant import _parse_response, AssistantError
        with pytest.raises(AssistantError):
            _parse_response('{"notes": [broken]')


class TestSuggestNotes:
    def test_ローカルバックエンドをモックで呼ぶ(self):
        from music_assistant import suggest_notes

        def mock_local(_prompt):
            return json.dumps({
                "notes": [
                    {"note": "C", "octave": 4, "step": 0, "length": 16},
                    {"note": "E", "octave": 4, "step": 0, "length": 16},
                    {"note": "G", "octave": 4, "step": 0, "length": 16},
                ],
                "explanation": "Cメジャートライアド"
            })

        result = suggest_notes(
            "4小節のコード進行",
            mode="local",
            local_caller=mock_local,
        )
        assert result["backend"] == "local"
        assert len(result["notes"]) == 3
        assert result["notes"][0]["note"] == "C"

    def test_クラウドバックエンドをモックで呼ぶ(self):
        from music_assistant import suggest_notes

        def mock_cloud(_prompt):
            return json.dumps({
                "notes": [{"note": "A", "octave": 3, "step": 0, "length": 4}],
                "explanation": "切ないAメロ"
            })

        result = suggest_notes(
            "切ないメロディ",
            mode="cloud",
            cloud_caller=mock_cloud,
        )
        assert result["backend"] == "cloud"
        assert result["notes"][0]["note"] == "A"

    def test_autoモードでルーティング(self):
        from music_assistant import suggest_notes

        def mock_local(_prompt):
            return '{"notes":[{"note":"C","octave":4,"step":0,"length":4}],"explanation":""}'

        def mock_cloud(_prompt):
            return '{"notes":[{"note":"E","octave":4,"step":0,"length":4}],"explanation":""}'

        # "コード進行" はローカル向け
        result = suggest_notes(
            "4小節のコード進行",
            mode="auto",
            local_caller=mock_local,
            cloud_caller=mock_cloud,
        )
        assert result["backend"] == "local"
        assert result["notes"][0]["note"] == "C"

        # "切ない" はクラウド向け
        result = suggest_notes(
            "切ない感じで",
            mode="auto",
            local_caller=mock_local,
            cloud_caller=mock_cloud,
        )
        assert result["backend"] == "cloud"
        assert result["notes"][0]["note"] == "E"

    def test_空プロンプトでエラー(self):
        from music_assistant import suggest_notes, AssistantError
        with pytest.raises(AssistantError):
            suggest_notes("", mode="local")
        with pytest.raises(AssistantError):
            suggest_notes("   ", mode="local")

    def test_不明なmodeでエラー(self):
        from music_assistant import suggest_notes, AssistantError
        with pytest.raises(AssistantError):
            suggest_notes("test", mode="invalid", local_caller=lambda _p: "{}")

    def test_context_notesがプロンプトに含まれる(self):
        from music_assistant import suggest_notes

        received_prompt = {"value": ""}

        def mock_local(prompt):
            received_prompt["value"] = prompt
            return '{"notes":[],"explanation":""}'

        suggest_notes(
            "続きを作って",
            mode="local",
            local_caller=mock_local,
            context_notes=[{"note": "C", "octave": 4, "step": 0, "length": 4}],
        )
        assert "既存ノート" in received_prompt["value"]
        assert "C" in received_prompt["value"]


class TestCheckAvailability:
    def test_構造が正しい(self):
        from music_assistant import check_availability
        result = check_availability()
        assert "local" in result
        assert "cloud" in result
        assert "local_models" in result
        assert isinstance(result["local"], bool)
        assert isinstance(result["cloud"], bool)
        assert isinstance(result["local_models"], list)
