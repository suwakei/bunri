#!/usr/bin/env python
"""再現ガイドの API 呼び出しを、実際に送って確かめる（開発用）

指示文やリクエストの組み立てを変えたら、コードを読んで判断せず、これで確かめる。
プロンプトキャッシュが効かなくなっても、エラーは出ない。請求が増えるだけなので、使用量の数字を
見るしか気づく方法が無い。

使い方（リポジトリ直下で）::

    uv run python scripts/guide_probe.py count                   # 入力のトークン数を数える（無料）
    uv run python scripts/guide_probe.py cache --yes             # キャッシュが効いているかを確かめる
    uv run python scripts/guide_probe.py compare --configs claude-opus-5-5:medium,claude-opus-5-5:low --yes
    uv run python scripts/guide_probe.py usage                   # 記録から、今日の使用量と呼び出しの間隔を見る

``cache`` と ``compare`` は Claude を実際に呼ぶので **費用がかかる**。``--yes`` を付けないと、
何を何回送るかと費用の目安を出すだけで、送らない。

- ``cache``: 同じリクエストを 2 回送り、4 つの計器（input_tokens / cache_creation_input_tokens /
  cache_read_input_tokens / output_tokens）を出す。2 回目に cache_read が立たなければ、終了コード 1 で終わる。
  既定では、応答の最初のイベント（入力の使用量が載っている）を受け取ったところで接続を閉じるので、
  かかるのはほぼ入力のぶんだけ。``--full`` を付けると、最後まで作らせる
- ``compare``: モデルと思考の深さの組み合わせごとにガイドを 1 つ作り、トークン数・所要時間・概算の費用・
  内容の目安（手順の数、文字数、落とした参照、カルテに無い語）を並べる。ガイドは ``--out`` に保存する

API キーは、アプリと同じ順で解決する（環境変数 → リポジトリ直下の .env）。キーは表示しない。
ここからの呼び出しは、アプリの使用量の記録（1 日の上限の勘定）には入れない。
"""
import argparse
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))

import guide_usage  # noqa: E402
import llm_settings  # noqa: E402
import reproduction_guide as rg  # noqa: E402

DEFAULT_CHART = ROOT / "test" / "fixtures" / "charts" / "short16.chart.json"

# プロンプトキャッシュが効く最小の長さ（トークン）。これより短いと、区切りを打っても黙ってキャッシュされない。
# 出典: https://platform.claude.com/docs/en/build-with-claude/prompt-caching （2026-11-11 に取得）
MIN_CACHEABLE = {
    "claude-opus-5-5": 512, "claude-sonnet-5-5": 512, "claude-haiku-5-5": 512, "claude-opus-5": 512,
    "claude-opus-4-8": 1024, "claude-sonnet-5": 1024, "claude-sonnet-4-6": 1024,
    "claude-opus-4-7": 2048,
    "claude-opus-4-6": 4096, "claude-opus-4-5": 4096, "claude-haiku-4-5": 4096,
}

METERS = ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens")

# 費用の目安に使う、1 回の出力の見込み（トークン）。実測は 2,000〜4,500
ASSUMED_OUTPUT_TOKENS = 5000


def load_chart(path):
    """カルテを読む。``.bunri`` か、カルテの JSON。"""
    path = Path(path)
    if path.suffix == ".bunri":
        import bunri_file

        return bunri_file.read_chart(path)
    return json.loads(path.read_text(encoding="utf-8"))


def usage_dict(usage):
    """SDK の usage を、4 つの計器（と思考のトークン数）の辞書にする。"""
    details = getattr(usage, "output_tokens_details", None)
    result = {name: getattr(usage, name, None) for name in METERS}
    result["thinking_tokens"] = getattr(details, "thinking_tokens", None)
    return result


def meters_line(usage):
    return "  ".join(f"{name}={usage.get(name)}" for name in METERS)


def cost_line(model, usage):
    cost = guide_usage.estimate_cost(model, usage, rg.CACHE_TTL or "5m")
    return f"概算 ${cost:.4f}" if cost is not None else "概算の費用は不明（単価の表に無いモデル）"


def upper_cost(request, calls, output_tokens=ASSUMED_OUTPUT_TOKENS):
    """送る前に出す、費用の目安の上限（トークン数は文字数を超えないので、文字数で見積もる）。"""
    usage = {"cache_creation_input_tokens": rg.request_chars(request), "output_tokens": output_tokens}
    one = guide_usage.estimate_cost(request["model"], usage, rg.CACHE_TTL or "5m")
    return None if one is None else one * calls


def cmd_count(args):
    chart = load_chart(args.chart)
    client = llm_settings.make_client()
    request = rg.build_request(chart, args.focus, model=args.model, effort=args.effort)
    total = rg.count_input_tokens(request, client)
    bare = dict(request, system=[{"type": "text", "text": "x"}])
    prefix = total - rg.count_input_tokens(bare, client) + 1
    model = request["model"]
    minimum = MIN_CACHEABLE.get(model)
    print(f"モデル: {model}")
    print(f"入力: {total:,} トークン（うち、キャッシュの区切りより前の指示文とカルテ: 約 {prefix:,}）")
    print(f"文字数: {rg.request_chars(request):,}（トークン数は文字数を超えない）")
    print("※ 出力の形（JSON Schema）のぶん（実測で約 1,700 トークン。これも区切りより前に入る）は、ここには含まれない")
    if minimum is None:
        print("キャッシュできる最小の長さ: このモデルの値は表に無い。cache で実際に確かめること")
    elif prefix < minimum:
        print(f"!! キャッシュできる最小の長さ（{minimum:,}）を下回る。区切りを打ってもキャッシュされない")
        return 1
    else:
        print(f"キャッシュできる最小の長さ（{minimum:,}）は超えている")
    return 0


def send_once(client, request, full):
    """リクエストを 1 回送り、``(使用量, 所要時間)`` を返す。"""
    started = time.monotonic()
    if full:
        response = client.beta.messages.create(**request)
        return usage_dict(response.usage), time.monotonic() - started
    with client.beta.messages.stream(**request) as stream:
        for event in stream:
            if event.type == "message_start":
                # 入力の使用量（キャッシュの読み書きを含む）は、最初のイベントに載っている。
                # ここで接続を閉じれば、出力はほとんど作られない
                return usage_dict(event.message.usage), time.monotonic() - started
    raise RuntimeError("応答に message_start が在りませんでした")


def cmd_cache(args):
    chart = load_chart(args.chart)
    request = rg.build_request(chart, args.focus, model=args.model, effort=args.effort)
    estimate = upper_cost(request, 2, ASSUMED_OUTPUT_TOKENS if args.full else 50)
    print(f"モデル: {request['model']}  思考の深さ: {request['output_config']['effort']}  "
          f"保持時間: {rg.CACHE_TTL}  送る回数: 2 回（{'最後まで作る' if args.full else '入力の使用量を受け取ったら閉じる'}）")
    print("費用の目安（上限）: " + (f"${estimate:.3f}" if estimate is not None else "不明"))
    if not args.yes:
        print("送っていない。実際に送るには --yes を付ける")
        return 2

    client = llm_settings.make_client()
    results = []
    for index in (1, 2):
        usage, seconds = send_once(client, request, args.full)
        results.append(usage)
        print(f"{index} 回目: {meters_line(usage)}  ({seconds:.1f} 秒, {cost_line(request['model'], usage)})")
    first, second = results
    if not (first.get("cache_creation_input_tokens") or first.get("cache_read_input_tokens")):
        print("!! 1 回目に、キャッシュへの書き込みも読み出しも無い。区切りより前が、キャッシュできる最小の長さを"
              "下回っているか、区切りが打たれていない")
    if not second.get("cache_read_input_tokens"):
        print("!! 失敗: 2 回目に cache_read_input_tokens が立たない。キャッシュが効いていない")
        return 1
    print(f"OK: 2 回目に {second['cache_read_input_tokens']:,} トークンがキャッシュから読まれた")
    return 0


def guide_stats(guide):
    """ガイドの内容の目安を返す（読んで比べるときの手がかり）。"""
    steps = guide["steps"]
    return {
        "steps": len(steps),
        "chars": len(guide["overview"]) + sum(len(s["title"]) + len(s["body"]) for s in steps) + sum(len(c) for c in guide["cautions"]),
        "refs": sum(len(s["refs"]) for s in steps),
        "cautions": len(guide["cautions"]),
        "dropped_refs": guide["dropped_refs"],
        "unverified_terms": guide["unverified_terms"],
    }


def cmd_compare(args):
    chart = load_chart(args.chart)
    configs = []
    for item in args.configs.split(","):
        model, _, effort = item.strip().partition(":")
        configs.append((model, effort or rg.EFFORT))
    requests = [rg.build_request(chart, args.focus, model=model, effort=effort) for model, effort in configs]
    estimates = [upper_cost(request, 1) for request in requests]
    print(f"カルテ: {args.chart}  対象: {args.focus or '曲全体'}  送る回数: {len(configs)} 回")
    for (model, effort), estimate in zip(configs, estimates):
        print(f"  {model} / {effort}: 費用の目安（上限） " + (f"${estimate:.3f}" if estimate is not None else "不明"))
    if all(e is not None for e in estimates):
        print(f"合計の目安（上限）: ${sum(estimates):.3f}")
    if not args.yes:
        print("送っていない。実際に送るには --yes を付ける")
        return 2

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    client = llm_settings.make_client()
    rows = []
    for (model, effort), request in zip(configs, requests):
        started = time.monotonic()
        try:
            result = rg.generate(chart, args.focus, client=client, request=request)
        except rg.GuideError as e:
            print(f"{model} / {effort}: 失敗 ({e.code}) {e}  {meters_line(e.usage or {})}")
            continue
        seconds = time.monotonic() - started
        stats = guide_stats(result["guide"])
        cost = guide_usage.estimate_cost(result["model"], result["usage"], rg.CACHE_TTL or "5m")
        row = {"model": result["model"], "requested_model": model, "effort": effort, "seconds": round(seconds, 1),
               "usage": result["usage"], "cost_usd": cost, **stats}
        rows.append(row)
        name = f"{Path(args.chart).name.split('.')[0]}-{args.focus or 'whole'}-{model}-{effort}{args.tag}.json"
        (out / name).write_text(json.dumps({**row, "guide": result["guide"]}, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"{model} / {effort}: {meters_line(result['usage'])}  thinking={result['usage'].get('thinking_tokens')}  "
              f"{seconds:.1f} 秒  " + (f"概算 ${cost:.4f}" if cost is not None else "費用不明"))
        print(f"    手順 {stats['steps']} 個・本文 {stats['chars']:,} 文字・参照 {stats['refs']}（落とした {stats['dropped_refs']}）・"
              f"注意 {stats['cautions']}・カルテに無い語 {stats['unverified_terms'] or 'なし'}  → {out / name}")
    return 0 if len(rows) == len(configs) else 1


def cmd_usage(args):
    today = guide_usage.today()
    records = guide_usage.read_records()
    print(f"記録: {guide_usage.log_path()}（{len(records)} 行）")
    print(f"今日（{today['date']}）: {today['calls']} 回、概算 ${today['cost_usd']:.2f}"
          f"（上限: {today['limit_calls']} 回 / {today['limit_usd']} USD）")
    report = guide_usage.cache_report(records)
    gaps = report["gaps"]
    print(f"同じカルテへの呼び出しの間隔（開始から開始まで。対象 {report['calls']} 回）:")
    print(f"  そのカルテで最初: {gaps['first']}  5 分以内: {gaps['under_5m']}  5 分〜1 時間: {gaps['5m_to_1h']}  1 時間超: {gaps['over_1h']}")
    cost = report["input_cost_usd"]
    print("キャッシュの保持時間ごとの、指示文とカルテの入力の費用（概算。実際の間隔に当てはめた値）:")
    print(f"  キャッシュなし: ${cost['none']:.4f}  5 分: ${cost['5m']:.4f}  1 時間: ${cost['1h']:.4f}")
    return 0


def main():
    parser = argparse.ArgumentParser(description="再現ガイドの API 呼び出しを、実際に送って確かめる（開発用）")
    sub = parser.add_subparsers(dest="command", required=True)

    def common(p):
        p.add_argument("--chart", default=str(DEFAULT_CHART), help="カルテ（.bunri か、カルテの JSON）")
        p.add_argument("--focus", default=None, help="対象のセクション ID（省略すると曲全体）")

    p = sub.add_parser("count", help="入力のトークン数を数える（無料）")
    common(p)
    p.add_argument("--model", default=None)
    p.add_argument("--effort", default=None)
    p.set_defaults(func=cmd_count)

    p = sub.add_parser("cache", help="同じリクエストを 2 回送り、キャッシュが効いているかを確かめる（費用がかかる）")
    common(p)
    p.add_argument("--model", default=None)
    p.add_argument("--effort", default=None)
    p.add_argument("--full", action="store_true", help="最後まで作らせる（出力のぶんの費用もかかる）")
    p.add_argument("--yes", action="store_true", help="実際に送る")
    p.set_defaults(func=cmd_cache)

    p = sub.add_parser("compare", help="モデルと思考の深さの組み合わせを比べる（費用がかかる）")
    common(p)
    p.add_argument("--configs", required=True, help="モデル:思考の深さ をカンマで並べる。例: claude-opus-5-5:medium,claude-opus-5-5:low")
    p.add_argument("--out", default="results/guide/compare", help="作ったガイドの保存先")
    p.add_argument("--tag", default="", help="保存するファイル名の末尾に付ける文字")
    p.add_argument("--yes", action="store_true", help="実際に送る")
    p.set_defaults(func=cmd_compare)

    p = sub.add_parser("usage", help="記録から、今日の使用量と呼び出しの間隔を見る（API は呼ばない）")
    p.set_defaults(func=cmd_usage)

    args = parser.parse_args()
    try:
        return args.func(args)
    except rg.GuideError as e:
        print(f"失敗 ({e.code}): {e}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
