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
    """LLM呼び出しやパース処理で発生するエラーを表す例外クラス。

    Ollama/Claude API への接続失敗、HTTPエラー、JSON パースエラー、
    バリデーション失敗など、アシスタント機能に関するあらゆる異常系で送出される。
    """
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
    """プロンプトの内容を分析してローカル/クラウドのどちらを使うか決定する。

    クラウド向けキーワード（情緒的・曖昧な表現）が含まれる場合は Claude を、
    ローカル向けキーワード（定型的な音楽理論用語）が含まれる場合は Ollama を選ぶ。
    どちらにも該当しない場合はコスト優先でローカルを返す。

    Args:
        prompt: ユーザーが入力した自然言語リクエスト文字列。

    Returns:
        使用するバックエンドを示す文字列。``"local"`` または ``"cloud"`` のいずれか。

    Note:
        空文字列や ``None`` が渡された場合は常に ``"local"`` を返す。
        キーワードマッチは大文字小文字を区別しない（日本語のため実質区別なし）。
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
    """LLM の生テキスト応答から JSON を抽出し、ノートデータをバリデーションして返す。

    マークダウンのコードフェンス（```json ... ```）が含まれていても除去したうえで
    最初の ``{`` から最後の ``}`` までを JSON としてパースする。
    ノートオブジェクトごとに音名・オクターブ・ステップ・長さを検証し、
    不正なエントリは無視して有効なものだけを返す。

    Args:
        text: LLM から返された生テキスト。JSON を含む文字列。

    Returns:
        以下のキーを持つ辞書::

            {
                "notes": [
                    {"note": str, "octave": int, "step": int, "length": int},
                    ...
                ],
                "explanation": str,
            }

        ``notes`` の各要素は NOTE_NAMES に含まれる音名、オクターブ 0〜8、
        ステップ 0 以上、長さ 1 以上に正規化される。

    Raises:
        AssistantError: テキスト内に JSON が見つからない場合。
        AssistantError: JSON のパースに失敗した場合。
        AssistantError: パースされた JSON に ``"notes"`` キーが存在しない場合。
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
    """Ollama の HTTP Chat API を呼び出してモデルの応答テキストを返す。

    ``/api/chat`` エンドポイントに POST し、JSON モードで応答を受け取る。
    システムプロンプト（SYSTEM_PROMPT）は常に付与される。

    Args:
        user_message: ユーザーのリクエスト文字列（BPM・小節数情報を含む）。
        model: 使用する Ollama モデル名（例: ``"gemma3:4b"``）。
            デフォルトは環境変数 ``OLLAMA_MODEL`` の値。
        url: Ollama サーバーのベース URL。
            デフォルトは環境変数 ``OLLAMA_URL`` の値（``http://localhost:11434``）。
        timeout: HTTP リクエストのタイムアウト秒数。

    Returns:
        モデルが生成したテキスト（JSON 文字列を含む）。

    Raises:
        AssistantError: Ollama サーバーへの接続に失敗した場合。
            ``ollama serve`` が起動していない可能性がある。
        AssistantError: Ollama サーバーが HTTP エラーを返した場合。

    Note:
        事前に ``ollama pull <model>`` でモデルを取得しておく必要がある。
        temperature=0.7 で呼び出すため、同じプロンプトでも応答が変わることがある。
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
    """Anthropic Claude Messages API を呼び出してモデルの応答テキストを返す。

    ``https://api.anthropic.com/v1/messages`` に POST し、
    レスポンスの ``content[0].text`` を返す。
    システムプロンプト（SYSTEM_PROMPT）は常に付与される。

    Args:
        user_message: ユーザーのリクエスト文字列（BPM・小節数情報を含む）。
        model: 使用する Claude モデル ID（例: ``"claude-haiku-4-5-20251001"``）。
            デフォルトは環境変数 ``CLAUDE_MODEL`` の値。
        api_key: Anthropic API キー。空文字の場合は環境変数
            ``ANTHROPIC_API_KEY`` を参照する。
        timeout: HTTP リクエストのタイムアウト秒数。

    Returns:
        Claude が生成したテキスト（JSON 文字列を含む）。

    Raises:
        AssistantError: API キーが設定されていない場合。
        AssistantError: Claude API サーバーへの接続に失敗した場合。
        AssistantError: Claude API が HTTP エラーを返した場合。
        AssistantError: 応答の ``content`` が空の場合。

    Note:
        max_tokens=2048 で呼び出すため、非常に長いノートシーケンスは
        途中で切断される可能性がある。
        API 呼び出しはネットワーク料金が発生する。
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
    """自然言語プロンプトからピアノロール用ノートデータを生成する。

    ``mode`` に応じてローカル（Ollama）またはクラウド（Claude）の LLM を選択し、
    BPM・小節数・既存ノートを文脈としてプロンプトに付加してノートを生成する。
    生成されたテキストは ``_parse_response`` でパース・バリデーションされる。

    Args:
        prompt: ユーザーの自然言語リクエスト（例: ``"4小節のポップスコード進行"``）。
            空文字列や空白のみの文字列は不可。
        bpm: 現在のプロジェクト BPM。プロンプトの文脈として LLM に渡す。
        bars: 生成したい小節数。1小節=16ステップとして LLM に伝える。
        mode: バックエンド選択モード。以下のいずれか:

            - ``"auto"``: ``_route`` でプロンプトを分析して自動選択。
            - ``"local"``: Ollama を強制使用。
            - ``"cloud"``: Claude を強制使用。

        context_notes: 既存のピアノロールノートリスト（継続性のため LLM に参照させる）。
            最初の 16 ノートのみ使用される。``None`` の場合は省略。
        local_caller: ローカルバックエンドの呼び出し関数。
            ``None`` の場合は ``_call_local`` を使用。テスト時のモック差し替えに使う。
        cloud_caller: クラウドバックエンドの呼び出し関数。
            ``None`` の場合は ``_call_cloud`` を使用。テスト時のモック差し替えに使う。

    Returns:
        以下のキーを持つ辞書::

            {
                "notes": [
                    {"note": str, "octave": int, "step": int, "length": int},
                    ...
                ],
                "explanation": str,   # LLM による日本語での生成説明
                "backend": str,       # 実際に使用したバックエンド ("local" | "cloud")
            }

    Raises:
        AssistantError: ``prompt`` が空または空白のみの場合。
        AssistantError: ``mode`` が ``"auto"`` / ``"local"`` / ``"cloud"`` 以外の場合。
        AssistantError: LLM への接続や応答のパースに失敗した場合
            （``_call_local`` / ``_call_cloud`` / ``_parse_response`` から伝播）。

    Note:
        ``local_caller`` / ``cloud_caller`` は依存性注入のためのパラメータであり、
        本番コードでは省略して ``None`` のままにすること。
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
    """ローカル（Ollama）およびクラウド（Claude）バックエンドの利用可否を確認する。

    Ollama に対しては実際に HTTP GET リクエストを送信して応答を確認する。
    Claude については API キーが環境変数に設定されているかだけを確認する
    （実際の API 接続テストは行わない）。

    Returns:
        以下のキーを持つ辞書::

            {
                "local": bool,           # Ollama サーバーが応答可能かどうか
                "cloud": bool,           # ANTHROPIC_API_KEY が設定されているかどうか
                "local_models": list[str], # Ollama に登録されているモデル名のリスト
            }

    Note:
        Ollama への接続タイムアウトは 2.0 秒。サーバーが起動していない場合や
        ネットワークエラーの場合は例外をキャッチして ``local=False`` を返す。
        ``cloud`` フラグは API キーの存在のみを確認するため、
        キーが無効であっても ``True`` を返す場合がある。
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
