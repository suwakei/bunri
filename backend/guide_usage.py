"""再現ガイドの使用量 — 呼び出しの記録、概算の費用、1 日の上限

Claude の API は呼ぶたびに費用がかかる。ここでは次の 3 つを持つ。差分コーチの説明（第3層。
``coach_explain``）も、同じ記録に残し、同じ 1 日の上限で数える（記録の ``feature`` で見分ける）。

- **記録**: 呼び出しごとに 1 行、``results/guide/usage.jsonl`` に追記する。残すのはトークン数
  （4 つの計器）・モデル・所要時間・対象・成否だけ。カルテの中身、ガイドの文、API キーは残さない
  （``_record`` が決まった項目だけを組み立てるので、ほかの値が紛れ込む経路が無い）
- **概算の費用**: 単価の表（``llm_pricing.json``。設定で上書きできる）から計算する。請求額そのもの
  ではないので、画面でも「概算」と示す
- **1 日の上限**: その日（この Mac の時刻で数える）の呼び出しの回数か概算の費用が上限に達していたら、
  API を呼ぶ前に止める

設定は ``results/guide/settings.json`` に持つ（無ければ既定値）。
"""
import json
import threading
from datetime import datetime, timezone
from pathlib import Path

import audio_utils

# 既定値。results/guide/settings.json で上書きできる
DEFAULT_SETTINGS = {
    # 1 日に API を呼べる回数。None なら回数では止めない
    "daily_limit_calls": 20,
    # 1 日の概算の費用の上限（USD）。None なら費用では止めない
    "daily_limit_usd": None,
    # 1 回に送る入力の上限（トークン）。超えるカルテは、対象をセクションに絞らせる。
    # 4 分・120 小節の曲で 8,000 前後なので、ふつうの曲は当たらない
    "max_input_tokens": 30000,
}

# 記録の 1 行が持つ項目。これ以外は書かない
_RECORD_FIELDS = (
    "ts", "feature", "ok", "error", "model", "requested_model", "effort", "cache_ttl", "focus", "chart", "version",
    "duration_sec", "input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens",
    "output_tokens", "thinking_tokens", "cost_usd",
)
_TOKEN_FIELDS = ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens")
# 記録を残す機能。"guide" は再現ガイド（第2層）、"coach" は差分コーチの説明（第3層）。
# ``feature`` の無い古い行は、再現ガイドのもの
FEATURES = ("guide", "coach")

_lock = threading.Lock()


def _dir():
    return audio_utils.results_dir("guide")


def log_path():
    """使用量の記録（JSON Lines）の場所を返す。"""
    return _dir() / "usage.jsonl"


def settings_path():
    """設定ファイルの場所を返す。"""
    return _dir() / "settings.json"


def _read_settings_file():
    try:
        data = json.loads(settings_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def settings():
    """いまの設定を返す（既定値に、設定ファイルの値を重ねたもの）。

    Returns:
        dict: ``{"daily_limit_calls", "daily_limit_usd", "max_input_tokens"}``。
    """
    stored = _read_settings_file()
    merged = dict(DEFAULT_SETTINGS)
    for key in DEFAULT_SETTINGS:
        if key in stored:
            merged[key] = stored[key]
    return merged


def _limit_value(name, value, integer):
    """上限の値を確かめる。None（上限なし）か、0 以上の数だけを通す。"""
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value < 0 or value != value:
        raise ValueError(f"{name} は 0 以上の数か、上限なし（null）で指定してください")
    if integer:
        if int(value) != value:
            raise ValueError(f"{name} は整数で指定してください")
        return int(value)
    return float(value)


def update_settings(changes):
    """設定を書き換える。指定した項目だけを変え、ほかはそのまま残す。

    Args:
        changes: ``DEFAULT_SETTINGS`` の項目のうち、変えるもの。

    Returns:
        dict: 書き換えたあとの設定（``settings()`` と同じ形）。

    Raises:
        ValueError: 知らない項目、または値が不正な場合。
    """
    if not isinstance(changes, dict):
        raise ValueError("設定の形式が正しくありません")
    cleaned = {}
    for key, value in changes.items():
        if key not in DEFAULT_SETTINGS:
            raise ValueError(f"知らない設定です: {key}")
        if key == "max_input_tokens" and (value is None or value == 0):
            raise ValueError("max_input_tokens は 1 以上の整数で指定してください")
        cleaned[key] = _limit_value(key, value, integer=key != "daily_limit_usd")
    with _lock:
        stored = _read_settings_file()
        stored.update(cleaned)
        path = settings_path()
        tmp = path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(stored, ensure_ascii=False, indent=2, sort_keys=True), encoding="utf-8")
        tmp.replace(path)
    return settings()


def pricing():
    """モデルごとの単価（USD / 100 万トークン）を返す。

    同梱の ``llm_pricing.json`` に、設定ファイルの ``pricing``（モデル ID → 単価）を重ねる。

    Returns:
        dict: ``{モデル ID: {"input", "cache_write_5m", "cache_write_1h", "cache_read", "output"}}``。
    """
    try:
        table = json.loads((Path(__file__).resolve().parent / "llm_pricing.json").read_text(encoding="utf-8"))
        models = dict(table.get("models") or {})
    except (OSError, ValueError):
        models = {}
    override = _read_settings_file().get("pricing")
    if isinstance(override, dict):
        for model, rates in override.items():
            if isinstance(rates, dict):
                models[model] = {**models.get(model, {}), **rates}
    return models


def _rates_for(model):
    """モデルの単価を引く。日付つきの ID（``claude-…-20260101``）は、前方一致で引く。"""
    table = pricing()
    if model in table:
        return table[model]
    matches = [name for name in table if isinstance(model, str) and model.startswith(name)]
    return table[max(matches, key=len)] if matches else None


def estimate_cost(model, usage, cache_ttl="5m"):
    """1 回の呼び出しの概算の費用（USD）を返す。

    4 つの計器を、それぞれの単価で足す。キャッシュへの書き込みは、保持時間（5 分 / 1 時間）で
    単価が違う。

    Args:
        model: 応答したモデルの ID。
        usage: ``{"input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens",
            "output_tokens"}``。None の項目は 0 として扱う。
        cache_ttl: キャッシュの保持時間。``"5m"`` か ``"1h"``。

    Returns:
        float | None: 概算の費用。単価の表に無いモデルなら None。
    """
    rates = _rates_for(model)
    if not rates or not isinstance(usage, dict):
        return None
    write_rate = rates.get("cache_write_1h" if cache_ttl == "1h" else "cache_write_5m")
    parts = (
        (usage.get("input_tokens"), rates.get("input")),
        (usage.get("cache_creation_input_tokens"), write_rate),
        (usage.get("cache_read_input_tokens"), rates.get("cache_read")),
        (usage.get("output_tokens"), rates.get("output")),
    )
    total = 0.0
    for tokens, rate in parts:
        if not tokens:
            continue
        if rate is None:
            return None
        total += tokens * rate / 1_000_000
    return round(total, 6)


def _record(*, feature, ok, error, model, requested_model, effort, cache_ttl, focus, chart, version, duration_sec,
            usage):
    """記録の 1 行を組み立てる。決まった項目だけを持つ（中身やキーが入る場所が無い）。"""
    usage = usage if isinstance(usage, dict) else {}
    record = {
        "ts": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "feature": feature if feature in FEATURES else "guide",
        "ok": bool(ok),
        "error": error,
        "model": model,
        "requested_model": requested_model,
        "effort": effort,
        "cache_ttl": cache_ttl,
        "focus": focus,
        "chart": chart,
        "version": version,
        "duration_sec": round(duration_sec, 2) if isinstance(duration_sec, (int, float)) else None,
        "thinking_tokens": usage.get("thinking_tokens"),
        "cost_usd": estimate_cost(model, usage, cache_ttl) if usage else None,
    }
    for name in _TOKEN_FIELDS:
        record[name] = usage.get(name)
    return {name: record[name] for name in _RECORD_FIELDS}


def record_call(*, ok, model, requested_model, effort, focus, chart, duration_sec, usage,
                error=None, cache_ttl="5m", version=None, feature="guide"):
    """API の呼び出し 1 回を記録に追記する。

    Args:
        ok: ガイドが出来たか。
        model: 応答したモデル（失敗して分からなければ、頼んだモデル）。
        requested_model: 頼んだモデル。
        effort: 思考の深さの指定。
        focus: 対象のセクション ID。曲全体なら None。
        chart: カルテの指紋（ハッシュの先頭。同じカルテへの呼び出しの間隔を見るのに使う）。
            差分コーチでは、差分の事実の指紋。
        duration_sec: 所要時間（秒）。
        usage: 使用量（``reproduction_guide._usage`` の形）。応答が返らなかったときは None。
        error: 失敗の種類（``GuideError.code``）。
        cache_ttl: キャッシュの保持時間の指定。
        version: 指示文と出力の形の指紋（``reproduction_guide.request_fingerprint``）。
        feature: どの機能の呼び出しか。``"guide"``（再現ガイド）か ``"coach"``（差分コーチの説明）。

    Returns:
        dict: 追記した 1 行。
    """
    record = _record(feature=feature, ok=ok, error=error, model=model, requested_model=requested_model, effort=effort,
                     cache_ttl=cache_ttl, focus=focus, chart=chart, version=version,
                     duration_sec=duration_sec, usage=usage)
    line = json.dumps(record, ensure_ascii=False, separators=(",", ":"))
    with _lock:
        with open(log_path(), "a", encoding="utf-8") as f:
            f.write(line + "\n")
    return record


def read_records():
    """記録を全部読む（壊れた行は飛ばす）。

    Returns:
        list[dict]: 古い順。
    """
    try:
        lines = log_path().read_text(encoding="utf-8").splitlines()
    except OSError:
        return []
    records = []
    for line in lines:
        try:
            record = json.loads(line)
        except ValueError:
            continue
        if isinstance(record, dict):
            records.append(record)
    return records


def _local_day(ts):
    """記録の時刻（UTC の ISO 形式）を、この Mac の時刻での日付にする。"""
    try:
        return datetime.fromisoformat(ts).astimezone().date()
    except (TypeError, ValueError):
        return None


def today():
    """今日の使用量と、上限までの残りを返す。

    回数に数えるのは、応答が返ってきた呼び出し（トークンを使ったもの）。API キーの誤りや通信の失敗の
    ように、応答が返らなかったものは費用がかからないので数えない。再現ガイドと差分コーチの説明を、
    分けずに合わせて数える（上限は 1 つの枠）。

    Returns:
        dict: ``{"date", "calls", "cost_usd", "limit_calls", "limit_usd", "blocked"}``。
        ``blocked`` は、上限に達していて呼べないときの理由（呼べるなら None）。
    """
    now = datetime.now().astimezone().date()
    calls, cost = 0, 0.0
    for record in read_records():
        if _local_day(record.get("ts")) != now:
            continue
        if not any(record.get(name) for name in _TOKEN_FIELDS):
            continue
        calls += 1
        cost += record.get("cost_usd") or 0.0
    current = settings()
    limit_calls, limit_usd = current["daily_limit_calls"], current["daily_limit_usd"]
    blocked = None
    if limit_calls is not None and calls >= limit_calls:
        blocked = (f"今日は再現ガイドを {calls} 回作りました。1 日の上限（{limit_calls} 回）に達したので、"
                   "Claude を呼びません。明日になるとまた作れます。上限は設定で変えられます")
    elif limit_usd is not None and cost >= limit_usd:
        blocked = (f"今日の再現ガイドの費用が概算で ${cost:.2f} になりました。1 日の上限（${limit_usd:.2f}）に"
                   "達したので、Claude を呼びません。明日になるとまた作れます。上限は設定で変えられます")
    return {
        "date": now.isoformat(),
        "calls": calls,
        "cost_usd": round(cost, 4),
        "limit_calls": limit_calls,
        "limit_usd": limit_usd,
        "blocked": blocked,
    }


# キャッシュの保持時間（秒）。None はキャッシュを使わない場合
_TTL_SECONDS = {"none": None, "5m": 300, "1h": 3600}


def cache_report(records=None):
    """記録から、プロンプトキャッシュの保持時間を決める材料を出す。

    キャッシュが効くのは、同じカルテ（と同じモデル・思考の深さ・指示文）への呼び出しが、前の呼び出しの
    開始から保持時間のうちに始まったときだけ。そこで、同じカルテへの呼び出しの間隔（開始から開始まで）
    の分布と、保持時間ごと（なし / 5 分 / 1 時間）に入力の費用がいくらになっていたかを計算する。

    1 時間の保持は書き込みが割高（入力の 2 倍。5 分は 1.25 倍）なので、5 分〜1 時間の間隔で来る
    呼び出しが少なければ、かえって高くつく。

    Args:
        records: 記録（``read_records()`` の形）。None なら記録ファイルを読む。

    Returns:
        dict: ``{"calls": 対象にした呼び出しの数, "gaps": {"first", "under_5m", "5m_to_1h", "over_1h"},
        "input_cost_usd": {"none", "5m", "1h"}}``。費用は概算。
    """
    groups = {}
    for record in records if records is not None else read_records():
        if record.get("feature", "guide") != "guide":
            # 差分コーチの呼び出しは、カルテをキャッシュに載せない（事実が毎回変わる）ので、対象にしない
            continue
        prefix = (record.get("cache_creation_input_tokens") or 0) + (record.get("cache_read_input_tokens") or 0)
        try:
            ended = datetime.fromisoformat(record.get("ts")).timestamp()
        except (TypeError, ValueError):
            continue
        if not prefix or not _rates_for(record.get("model")):
            continue
        started = ended - (record.get("duration_sec") or 0)
        key = (record.get("chart"), record.get("requested_model"), record.get("effort"), record.get("version"))
        groups.setdefault(key, []).append((started, prefix, record.get("model")))

    gaps = {"first": 0, "under_5m": 0, "5m_to_1h": 0, "over_1h": 0}
    cost = {name: 0.0 for name in _TTL_SECONDS}
    calls = 0
    for group in groups.values():
        group.sort()
        previous = None
        for started, prefix, model in group:
            calls += 1
            gap = None if previous is None else started - previous
            if gap is None:
                gaps["first"] += 1
            elif gap <= 300:
                gaps["under_5m"] += 1
            elif gap <= 3600:
                gaps["5m_to_1h"] += 1
            else:
                gaps["over_1h"] += 1
            rates = _rates_for(model)
            for name, ttl in _TTL_SECONDS.items():
                if ttl is None:
                    rate = rates["input"]
                elif gap is not None and gap <= ttl:
                    rate = rates["cache_read"]
                else:
                    rate = rates["cache_write_1h" if name == "1h" else "cache_write_5m"]
                cost[name] += prefix * rate / 1_000_000
            previous = started
    return {"calls": calls, "gaps": gaps, "input_cost_usd": {name: round(value, 4) for name, value in cost.items()}}
