#!/usr/bin/env python
"""アシスタントの API 呼び出しを、本物の Claude に実際に送って確かめる（開発用）

指示文（``assistant.SYSTEM_PROMPT``）・ツールの台帳（``assistant_tools.json``）・リクエストの組み立てを変えたら、
コードを読んで判断せず、これで確かめる。偽の Claude サーバ（e2e）は、台帳の形が本物に通るかも、
プロンプトキャッシュが効いているかも教えてくれない。

使い方（リポジトリ直下で）::

    uv run python scripts/assistant_probe.py          # 何を送るかと費用の目安を出すだけ（送らない）
    uv run python scripts/assistant_probe.py --yes    # 実際に送る（費用がかかる）

``--yes`` を付けると Claude を実際に呼ぶので **費用がかかる**。実行の前に、利用者の了承を取る。

確かめること:

1. ツールの台帳と指示文を付けたリクエストが、400 にならずに通るか
2. Claude が返したツールの引数が、台帳の ``input_schema`` に合っているか（型・必須・余分なキー・enum）
3. 応答の ``content``（思考のブロックを含む）を、そのまま送り返して次の呼び出しが通るか
4. プロンプトキャッシュが効いているか（同じ依頼の続き・別の会話で ``cache_read`` が立つか）
5. 少しずつ返す版（``stream_step``）が、本物の応答で最後まで読めるか

ツールは実行しない（画面が無いので）。結果の代わりに、決まった偽の結果を返して先へ進める。
2 回目以降に ``cache_read`` が立たない呼び出しが在るか、台帳と合わない引数が在れば、終了コード 1 で終わる。

API キーは、アプリと同じ順で解決する（環境変数 → リポジトリ直下の .env）。キーは表示しない。
使用量は、一時のデータ置き場に記録する（アプリの使用量の記録 = 1 日の上限の勘定には入れない。
そのため、設定画面で選んだモデルではなく、環境変数か既定のモデルで送る）。
"""
import argparse
import json
import os
import sys
import tempfile
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))
# アプリの使用量の記録に混ぜない（backend のモジュールを読む前に、置き場を差し替える）
os.environ["BUNRI_DATA_DIR"] = tempfile.mkdtemp(prefix="bunri-assistant-probe-")

import assistant  # noqa: E402
import llm_settings  # noqa: E402

LEDGER = {tool["name"]: tool for tool in assistant.load_ledger()}

# 偽のプロジェクト (ツールの結果として返す)
PROJECT = {
    "ok": True, "summary": "プロジェクトの様子を読みました",
    "bpm": 120, "beats_per_bar": 4, "steps_per_bar": 16, "length_bars": 8,
    "tracks": [
        {"id": 1, "name": "Track 1", "role": "free", "mute": False, "solo": False, "gain_db": 0, "pan": 0,
         "notes": 0, "clips": 0, "has_reference": False},
        {"id": 2, "name": "Track 2", "role": "free", "mute": False, "solo": False, "gain_db": 0, "pan": 0,
         "notes": 4, "clips": 0, "has_reference": False},
    ],
    "open_track_id": 1, "playing": False, "position_bar": 1, "has_chart": False, "practice_open": False,
}


def check_input(name, value):
    """ツールの引数が、台帳の input_schema に合っているかを確かめる (型・必須・余分なキー)。合わない点の一覧を返す。"""
    problems = []

    def walk(schema, v, path):
        kind = schema.get("type")
        if kind == "object":
            if not isinstance(v, dict):
                problems.append(f"{path}: object でない ({type(v).__name__})")
                return
            for key in schema.get("required", []):
                if key not in v:
                    problems.append(f"{path}: 必須の {key} が無い")
            props = schema.get("properties", {})
            for key, item in v.items():
                if key not in props:
                    if schema.get("additionalProperties") is False:
                        problems.append(f"{path}: 台帳に無いキー {key}")
                    continue
                walk(props[key], item, f"{path}.{key}")
        elif kind == "array":
            if not isinstance(v, list):
                problems.append(f"{path}: array でない")
                return
            for i, item in enumerate(v):
                walk(schema.get("items", {}), item, f"{path}[{i}]")
        elif kind == "integer":
            if not isinstance(v, int) or isinstance(v, bool):
                problems.append(f"{path}: integer でない ({v!r})")
        elif kind == "number":
            if not isinstance(v, (int, float)) or isinstance(v, bool):
                problems.append(f"{path}: number でない ({v!r})")
        elif kind == "string":
            if not isinstance(v, str):
                problems.append(f"{path}: string でない ({v!r})")
            elif "enum" in schema and v not in schema["enum"]:
                problems.append(f"{path}: enum に無い値 {v!r}")
        elif kind == "boolean":
            if not isinstance(v, bool):
                problems.append(f"{path}: boolean でない ({v!r})")

    if name not in LEDGER:
        return [f"台帳に無いツール {name}"]
    walk(LEDGER[name]["input_schema"], value, name)
    return problems


def fake_result(name, value):
    """ツールの結果の代わり (画面が返す形に合わせる)。"""
    if name == "get_project":
        return PROJECT
    if name == "get_notes":
        return {"ok": True, "summary": "ノートを読みました（0 個）", "notes": [], "truncated": False}
    if name in ("add_notes", "replace_notes"):
        return {"ok": True, "summary": f"ノートを {len(value.get('notes', []))} 個置きました（Track 1、1 小節）",
                "added": len(value.get("notes", []))}
    return {"ok": True, "summary": f"{LEDGER.get(name, {}).get('label', name)}を行いました"}


def show_usage(label, usage, cost):
    print(f"  {label}: input={usage.get('input_tokens')} cache_write={usage.get('cache_creation_input_tokens')} "
          f"cache_read={usage.get('cache_read_input_tokens')} output={usage.get('output_tokens')} "
          f"thinking={usage.get('thinking_tokens')} cost_usd={cost}")


def handle(result, messages, problems):
    """応答を会話に足し、ツールが在れば結果を足す。続けるなら True。"""
    kinds = [b.get("type") for b in result["content"]]
    print(f"  stop_reason={result['stop_reason']} model={result['model']} blocks={kinds}")
    for block in result["content"]:
        if block.get("type") == "text" and block.get("text", "").strip():
            print(f"  text: {block['text'].strip()[:200]}")
    messages.append({"role": "assistant", "content": result["content"]})
    if result["stop_reason"] != "tool_use":
        return False
    results = []
    for block in result["content"]:
        if block.get("type") != "tool_use":
            continue
        bad = check_input(block["name"], block["input"])
        problems.extend(bad)
        print(f"  tool_use: {block['name']} {json.dumps(block['input'], ensure_ascii=False)[:300]}"
              + (f"  ← 台帳と合わない: {bad}" if bad else ""))
        results.append({"type": "tool_result", "tool_use_id": block["id"],
                        "content": json.dumps(fake_result(block["name"], block["input"]), ensure_ascii=False)})
    messages.append({"role": "user", "content": results})
    return True


def main():
    parser = argparse.ArgumentParser(description="アシスタントの呼び出しを、本物の Claude に送って確かめる（費用がかかる）")
    parser.add_argument("--yes", action="store_true", help="実際に送る")
    args = parser.parse_args()
    print(f"model={llm_settings.model()} key_source={llm_settings.key_source()} tools={len(LEDGER)} "
          f"version={assistant.ASSISTANT_VERSION} effort={assistant.EFFORT}")
    if not args.yes:
        print("送るもの: 依頼 A（ノートを置く。step で最大 6 回）と、依頼 B（読むだけ。stream_step で最大 4 回）。")
        print("費用の目安: 2026-11-18 の実測で、5 回・概算 $0.08（claude-opus-5-5、ツール 39 個。"
              "台帳と指示文の約 12,500 トークンは、2 回目からキャッシュから読まれる）")
        print("送っていない。実際に送るには --yes を付ける")
        return 0
    if llm_settings.key_source() == "none":
        print("API キーが見つからない（環境変数か、リポジトリ直下の .env に置く）")
        return 1
    problems, total, calls, reads = [], 0.0, 0, []

    print("\n[依頼 A] ふつうの呼び出し (step): ノートを置く依頼")
    messages = [{"role": "user", "content": [{"type": "text", "text":
                 "Track 1 の 1 小節目の頭に、C メジャーのコード（ド・ミ・ソ）を 4 分音符で置いて"}]}]
    turn = f"probe-{uuid.uuid4().hex[:12]}"
    for step in range(6):
        result = assistant.step(messages, turn, step)
        calls += 1
        total += result.get("cost_usd") or 0
        reads.append(("A", step, result["usage"]))
        print(f" step {step}")
        show_usage("usage", result["usage"], result.get("cost_usd"))
        if not handle(result, messages, problems):
            break

    print("\n[依頼 B] 少しずつ返す版 (stream_step): 別の会話で、読むだけの依頼")
    messages = [{"role": "user", "content": [{"type": "text", "text": "いまのテンポと拍子を教えて"}]}]
    turn = f"probe-{uuid.uuid4().hex[:12]}"
    for step in range(4):
        counts, done = {}, None
        for event in assistant.stream_step(messages, turn, step):
            if event is None:
                continue
            counts[event["type"]] = counts.get(event["type"], 0) + 1
            if event["type"] == "done":
                done = event
            elif event["type"] == "error":
                print(f"  error のイベント: {event['detail']}")
                problems.append(f"stream の error: {event['detail']}")
        print(f" step {step} イベントの数: {counts}")
        if done is None:
            problems.append("stream が done を出さずに終わった")
            break
        calls += 1
        total += done.get("cost_usd") or 0
        reads.append(("B", step, done["usage"]))
        show_usage("usage", done["usage"], done.get("cost_usd"))
        if not handle(done, messages, problems):
            break

    print("\n[まとめ]")
    print(f"  Claude を呼んだ回数: {calls}、概算の費用の合計: ${total:.4f}")
    first = reads[0][2]
    later = [(t, s, u) for t, s, u in reads[1:]]
    print(f"  最初の呼び出し: cache_write={first.get('cache_creation_input_tokens')} cache_read={first.get('cache_read_input_tokens')}")
    misses = [(t, s) for t, s, u in later if not (u.get("cache_read_input_tokens") or 0) > 0]
    print(f"  2 回目以降で cache_read が立たなかった呼び出し: {misses if misses else '無し'}")
    print(f"  ツールの引数が台帳と合わなかった点: {problems if problems else '無し'}")
    return 1 if (misses or problems) else 0


if __name__ == "__main__":
    sys.exit(main())
