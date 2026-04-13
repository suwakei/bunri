"""
bunri DAW — 音楽アシスタント（LLMベースのピアノロール提案機能）

ハイブリッド LLM 構成:
- ローカル: Ollama 経由の Gemma 3 (4B/12B) → 定番パターン向き・無料
- クラウド: Anthropic Claude → 創造的/曖昧なリクエスト向き

自然言語プロンプト → ピアノロール用ノートデータへの変換。
実際の音声はユーザーが選んだGM音源で再生されるため、
「AIが作曲した音声」ではなく「AIが提案したノートを配置」という設計。
"""
import os
import re
import json

# ---- 設定 ----
DEFAULT_LOCAL_URL = os.getenv("OLLAMA_URL", "http://localhost:11434")
DEFAULT_LOCAL_MODEL = os.getenv("OLLAMA_MODEL", "gemma3:4b")
DEFAULT_CLOUD_MODEL = os.getenv("CLAUDE_MODEL", "claude-haiku-4-5-20251001")
ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")

NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

# ---- プロンプト ----

SYSTEM_PROMPT = """You are a music composition assistant for a DAW.
Your task: convert natural language requests into piano roll note data as JSON.

OUTPUT FORMAT (strict JSON, no markdown):
{
  "notes": [
    {"note": "C", "octave": 4, "step": 0, "length": 4},
    {"note": "E", "octave": 4, "step": 0, "length": 4},
    {"note": "G", "octave": 4, "step": 0, "length": 4}
  ],
  "explanation": "Brief description in Japanese of what you generated."
}

RULES:
- "note" must be one of: C, C#, D, D#, E, F, F#, G, G#, A, A#, B
- "octave" is an integer from 2 to 6
- "step" is position in 16th notes (0 = first beat). 1 bar = 16 steps (4/4 time).
- "length" is duration in 16th notes (1=16th, 2=8th, 4=quarter, 8=half, 16=whole)
- For chords: use the same "step" for notes played simultaneously
- For melodies: use different "step" values in sequence
- Stay within the requested number of bars
- Use common music theory (functional harmony, scales)
- Output ONLY valid JSON, no markdown fences, no extra text

EXAMPLES:

User: 4小節のポップスコード進行 (C major)
Response:
{"notes":[
{"note":"C","octave":4,"step":0,"length":16},{"note":"E","octave":4,"step":0,"length":16},{"note":"G","octave":4,"step":0,"length":16},
{"note":"G","octave":3,"step":16,"length":16},{"note":"B","octave":3,"step":16,"length":16},{"note":"D","octave":4,"step":16,"length":16},
{"note":"A","octave":3,"step":32,"length":16},{"note":"C","octave":4,"step":32,"length":16},{"note":"E","octave":4,"step":32,"length":16},
{"note":"F","octave":3,"step":48,"length":16},{"note":"A","octave":3,"step":48,"length":16},{"note":"C","octave":4,"step":48,"length":16}
],"explanation":"C - G - Am - F のポップス定番進行を4小節で配置しました。"}

User: 2小節のシンプルなベースライン（Am）
Response:
{"notes":[
{"note":"A","octave":2,"step":0,"length":4},{"note":"A","octave":2,"step":4,"length":4},
{"note":"E","octave":2,"step":8,"length":4},{"note":"A","octave":2,"step":12,"length":4},
{"note":"A","octave":2,"step":16,"length":4},{"note":"C","octave":3,"step":20,"length":4},
{"note":"E","octave":2,"step":24,"length":4},{"note":"A","octave":2,"step":28,"length":4}
],"explanation":"Aマイナーの8分音符ベースライン。ルートと5度を中心に動かしました。"}
"""

# ---- 例外 ----

class AssistantError(Exception):
    """LLM呼び出しやパースのエラー"""
    pass


# ---- ルーティング ----

# クラウド向けキーワード（創造的/曖昧な表現）
_CLOUD_KEYWORDS = [
    'エモ', '切な', '懐かし', '壮大', 'ドラマ', 'メランコリ',
    '不穏', '幻想', '儚', '神秘', 'スピリチュアル',
    'シューゲイザ', 'ドリームポップ', 'ローファイ', 'アンビエント',
    'ような雰囲気', 'っぽい感じ', 'みたいな', 'イメージで',
]

# ローカル向けキーワード（定型パターン）
_LOCAL_KEYWORDS = [
    'コード進行', 'ベースライン', 'ドラム', 'リズム',
    '4つ打ち', '8ビート', 'メロディ',
    'Cメジャー', 'Aマイナー', 'キー',
    'アルペジオ', 'ウォーキング', 'ブルース',
]


def _route(prompt: str) -> str:
    """
    プロンプトの性質でローカル/クラウドを判定。
    自動選択の判断基準:
    - クラウド向けキーワードがあれば 'cloud'
    - ローカル向けキーワードがあれば 'local'
    - それ以外は 'local'（無料を優先）
    """
    if not prompt:
        return 'local'

    lower = prompt
    if any(kw in lower for kw in _CLOUD_KEYWORDS):
        return 'cloud'
    if any(kw in lower for kw in _LOCAL_KEYWORDS):
        return 'local'
    return 'local'


# ---- ノートパース ----

def _parse_response(text: str) -> dict:
    """
    LLM の応答から JSON を抽出してバリデーション。
    マークダウンコードフェンス等を含んでも robust にパース。
    """
    # マークダウンフェンスを除去
    text = text.strip()
    text = re.sub(r'^```(?:json)?\s*', '', text)
    text = re.sub(r'\s*```$', '', text)

    # 最初の { から最後の } までを抽出
    start = text.find('{')
    end = text.rfind('}')
    if start == -1 or end == -1:
        raise AssistantError(f"JSONが見つかりません: {text[:200]}")

    json_str = text[start:end + 1]

    try:
        data = json.loads(json_str)
    except json.JSONDecodeError as e:
        raise AssistantError(f"JSONパースエラー: {e}") from e

    if not isinstance(data, dict) or 'notes' not in data:
        raise AssistantError("応答に 'notes' フィールドがありません")

    # ノートの正規化とバリデーション
    notes = []
    for n in data.get('notes', []):
        try:
            note = str(n['note']).upper()
            if note not in NOTE_NAMES:
                continue
            octave = int(n['octave'])
            if not 0 <= octave <= 8:
                continue
            step = max(0, int(n['step']))
            length = max(1, int(n['length']))
            notes.append({
                'note': note,
                'octave': octave,
                'step': step,
                'length': length,
            })
        except (KeyError, TypeError, ValueError):
            continue

    return {
        'notes': notes,
        'explanation': str(data.get('explanation', '')),
    }


# ---- バックエンド呼び出し ----

def _call_local(user_message: str, model: str = DEFAULT_LOCAL_MODEL,
                url: str = DEFAULT_LOCAL_URL, timeout: float = 60.0) -> str:
    """
    Ollama HTTP API を呼び出す。
    事前に `ollama pull <model>` 済みである必要がある。
    """
    import httpx

    try:
        resp = httpx.post(
            f"{url}/api/chat",
            json={
                "model": model,
                "messages": [
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user", "content": user_message},
                ],
                "stream": False,
                "format": "json",  # Ollama の JSON モード
                "options": {"temperature": 0.7},
            },
            timeout=timeout,
        )
        resp.raise_for_status()
        data = resp.json()
        return data.get("message", {}).get("content", "")
    except httpx.ConnectError as e:
        raise AssistantError(
            f"Ollama に接続できません ({url})。"
            f"'ollama serve' が起動しているか確認してください。"
        ) from e
    except httpx.HTTPStatusError as e:
        raise AssistantError(f"Ollama エラー: {e.response.status_code}") from e


def _call_cloud(user_message: str, model: str = DEFAULT_CLOUD_MODEL,
                api_key: str = "", timeout: float = 60.0) -> str:
    """
    Anthropic Claude API を呼び出す。
    環境変数 ANTHROPIC_API_KEY が必要。
    """
    import httpx

    key = api_key or ANTHROPIC_API_KEY
    if not key:
        raise AssistantError(
            "ANTHROPIC_API_KEY が設定されていません。"
            "環境変数を設定するかローカルモード（Ollama）を使ってください。"
        )

    try:
        resp = httpx.post(
            "https://api.anthropic.com/v1/messages",
            headers={
                "x-api-key": key,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
            json={
                "model": model,
                "max_tokens": 2048,
                "system": SYSTEM_PROMPT,
                "messages": [{"role": "user", "content": user_message}],
            },
            timeout=timeout,
        )
        resp.raise_for_status()
        data = resp.json()
        # Claude API の応答形式: content: [{type: "text", text: "..."}]
        content = data.get("content", [])
        if not content:
            raise AssistantError("Claude の応答が空です")
        return content[0].get("text", "")
    except httpx.ConnectError as e:
        raise AssistantError(f"Claude API に接続できません: {e}") from e
    except httpx.HTTPStatusError as e:
        raise AssistantError(f"Claude API エラー: {e.response.status_code} {e.response.text}") from e


# ---- 公開関数 ----

def suggest_notes(
    prompt: str,
    bpm: int = 120,
    bars: int = 4,
    mode: str = "auto",
    context_notes: list = None,
    local_caller=None,
    cloud_caller=None,
) -> dict:
    """
    自然言語プロンプトからピアノロール用ノートデータを生成する。

    Args:
        prompt: ユーザーの自然言語リクエスト
        bpm: 現在のBPM（文脈としてプロンプトに含める）
        bars: 生成したい小節数
        mode: "auto" | "local" | "cloud"
        context_notes: 既存のノートデータ（継続性のため）
        local_caller: ローカルバックエンド呼び出し関数（テスト時のモック用）
        cloud_caller: クラウドバックエンド呼び出し関数（テスト時のモック用）

    Returns:
        {
            "notes": [{"note", "octave", "step", "length"}, ...],
            "explanation": str,
            "backend": "local" | "cloud",
        }
    """
    if not prompt or not prompt.strip():
        raise AssistantError("プロンプトが空です")

    # バックエンド選択
    if mode == "auto":
        backend = _route(prompt)
    elif mode in ("local", "cloud"):
        backend = mode
    else:
        raise AssistantError(f"不明なmode: {mode}")

    # プロンプト組み立て
    context_str = ""
    if context_notes:
        context_str = f"\n既存ノート（参考）: {json.dumps(context_notes[:16], ensure_ascii=False)}\n"

    full_prompt = (
        f"BPM: {bpm}, 小節数: {bars}（1小節=16ステップ）\n"
        f"{context_str}"
        f"リクエスト: {prompt}"
    )

    # LLM 呼び出し
    if backend == "local":
        caller = local_caller or _call_local
    else:
        caller = cloud_caller or _call_cloud

    raw = caller(full_prompt)
    parsed = _parse_response(raw)

    return {
        "notes": parsed["notes"],
        "explanation": parsed["explanation"],
        "backend": backend,
    }


def check_availability() -> dict:
    """
    ローカル/クラウドの利用可否を返す。
    UI で「使えるバックエンド」を表示するため。
    """
    result = {"local": False, "cloud": False, "local_models": []}

    # Ollama の確認
    try:
        import httpx
        resp = httpx.get(f"{DEFAULT_LOCAL_URL}/api/tags", timeout=2.0)
        if resp.status_code == 200:
            result["local"] = True
            tags = resp.json().get("models", [])
            result["local_models"] = [m.get("name", "") for m in tags]
    except Exception:
        pass

    # Claude API キーの確認（接続テストはしない）
    result["cloud"] = bool(ANTHROPIC_API_KEY)

    return result
