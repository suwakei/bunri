# bunri DAW

## 概要
Demucs (Meta AI) による音源分離と、音声編集・ミキシング・エフェクトを備えた軽量DAW。FastAPI + HTML/CSS/JS の Web UI で操作。

## 起動
デスクトップアプリ（Tauri v2）。開発モード（Rust と uv が要る）:
```bash
make install && make install-frontend && make install-desktop   # 初回のみ
make desktop           # = npm run tauri dev
```
窓が開き、Python は sidecar として空きポートで一緒に起動する。配布物は `make desktop-build`（= `npm run tauri build`）。
構成と、変えてはいけない約束ごとは [docs/desktop-architecture.md](../docs/desktop-architecture.md)。

ブラウザで開く版と Docker は廃止した。画面をブラウザで開く経路は、開発と自動テスト用にだけ残してある
（Vite の開発サーバ + `backend/run_web.py`。同文書の「開発用のブラウザ起動」）。

## テスト
```bash
make test    # 単体テスト（フロント + バック + Rust）
make lint
make e2e     # ブラウザを自動操作するテスト（Playwright。サーバは自分で起動して止める）
make e2e-desktop  # 本物の窓（テスト用にビルドしたデスクトップアプリ）を自動操作するテスト（mac のみ）
```
画面を触る変更をしたら `make e2e` まで回す。単体テストが通っていても、画面に出ない・押せないといった
不具合は、ブラウザで実際に操作しないと見つからない（[docs/ui-testing.md](../docs/ui-testing.md) に実例）。
`make e2e` の画面にはデスクトップ版と同じ CSP が掛かっていて、違反があれば失敗する。

CSP・フォント・同梱物・`tauri.conf.json`・`src-tauri/`・sidecar の起動や鍵・書き出しを変えたら、`make e2e-desktop` も回す
（初回はビルドで数分、2 回目からは 20 秒ほど）。テスト用のビルドはアプリの中で WebDriver サーバを動かすので、
機能 `e2e` は配布物に入れない（[docs/desktop-architecture.md](../docs/desktop-architecture.md)「窓を自動操作するテスト」）。
Claude Code が画面をその場で操作して確かめるときは、Playwright MCP（`.mcp.json`）と `make dev-web` を使う。

## ファイル構成
Python のコードはすべて `backend/` に在る（フラットな構成のまま、置き場だけまとめてある）。
下の表のファイル名は `backend/` からの相対。

| ファイル | 役割 |
|---|---|
| `run_web.py` | API サーバの起動スクリプト。デスクトップアプリが sidecar として起動する（`--sidecar`）。開発用に単体でも起動できる |
| `web/api.py` | FastAPI バックエンド API（API だけ。画面は配らない） |
| `web/job_routes.py` | ジョブの API（`/api/jobs…`）と、時間のかかる API を `?async=1` でジョブとして始めるための共通処理（`dispatch`） |
| `separate.py` | Demucs 音源分離（htdemucs標準） |
| `deep_separate.py` | 6ステム詳細分離（htdemucs_6s） |
| `edit.py` | 基本編集（トリム/カット/分割/コピー/音量/フェード/ループ/パン/速度/結合/ノーマライズ/リバース/MP3書き出し） |
| `effects.py` | エフェクト（3バンドEQ/コンプレッサー/リバーブ/ディレイ） |
| `overlay.py` | 音源合成（オーバーレイ） |
| `mixer.py` | マルチトラックミキサー（最大4トラック） |
| `recorder.py` | マイク録音 |
| `convert.py` | フォーマット変換（MP4→WAV/MP3） |
| `pitch_time.py` | ピッチシフト/タイムストレッチ（フェーズボコーダー実装） |
| `metronome.py` | メトロノーム/BPMユーティリティ |
| `synth.py` | ソフトウェアシンセ + ステップシーケンサー + ドラムマシン（FluidSynth/SoundFont） |
| `analyze.py` | WAV音声解析 → ピアノロール用ノートデータ |
| `song_chart.py` | 楽曲カルテの組み立て・正規化（第1層のオーケストレーション） |
| `structure.py` | グリッド推定（BPM/ダウンビート）とセクション検出 |
| `music_theory.py` | キー推定・コード検出・ディグリー変換・用語辞書 |
| `mix_profile.py` | 曲全体のミックス特性（ラウドネス/ステレオ幅/残響/帯域） |
| `bunri_file.py` | `.bunri` ドキュメント（SQLiteベース単一ファイル）の読み書き |
| `audio_utils.py` | 共通ユーティリティ（load_audio / save_tmp等）とデータ置き場の解決（data_dir / results_dir / uploads_dir 等） |
| `_demucs_runner.py` | Demucs を子プロセスとして動かすスクリプト（torchaudio 保存パッチ。API から起動されたときは `demucs_progress` で進み具合を報告する） |
| `llm_settings.py` | Claude の API キーとモデルの解決（キーは呼び出しのたびに読む。配布物に同梱しない） |
| `reproduction_guide.py` | 再現ガイド（第2層）。カルテを Claude に渡して手順の説明にする。出力は Structured Outputs で形を固定し、カルテと突き合わせて検証する |
| `guide_cache.py` | 作った再現ガイドの保存（同じ条件なら Claude を呼ばない）と、同じカルテへの呼び出しを 1 つずつ通す錠 |
| `guide_usage.py` | 再現ガイドの使用量の記録（`results/guide/usage.jsonl`。中身とキーは残さない）、概算の費用、1 日の上限 |
| `llm_pricing.json` | Claude の単価の表（概算の費用の計算に使う。コードに埋めず、ここと設定で持つ） |
| `coach_diff.py` | 差分コーチ（第3層）の土台。お手本のノートと打ち込みの差分を事実として出す（LLM 不使用） |
| `coach_explain.py` | 差分コーチ（第3層）の言語化。差分の事実を Claude に渡して「どんな傾向か・なぜと考えられるか・まず何を見直すか」にする。出力は Structured Outputs で形を固定し、事実と突き合わせて検証する。保存・使用量の記録・1 日の上限は第2層と共通 |
| `model_cache.py` | 音源分離モデル（Demucs）が手元に在るか（初回ダウンロードが要るか）の確認 |
| `access_control.py` | デスクトップ版で API にかける鍵（トークン検証）と CORS。`BUNRI_TOKEN` が在るときだけ有効 |
| `background_jobs.py` | 時間のかかる処理（ジョブ）を 1 つずつ裏で動かし、ステージ・進み具合・経過時間を持ち、キャンセルと書きかけの出力の削除を受け持つ（FastAPI に依存しない）。約束は [docs/jobs.md](../docs/jobs.md) |
| `demucs_progress.py` | Demucs の子プロセスとのやり取り（子の側で進み具合をイベントとして出し、親の側でジョブに伝える。親が居なくなったら子は自分で終わる） |

`backend/` の外:

| 場所 | 役割 |
|---|---|
| `web-ui/` | 画面（React + Vite + TypeScript）。API 呼び出しは必ず `src/lib/api.ts` の `apiFetch` / `backendUrl` を通す（素の `fetch('/api/...')` を書かない） |
| `src-tauri/` | デスクトップアプリのネイティブ側（Rust）。窓の生成、初回セットアップ、Python sidecar の起動・監視・終了、API キーのキーチェーン保存、MIDI 入力の受け取りだけを持つ |
| `scripts/dev-web.mjs` | 開発用のブラウザ起動（Vite + API サーバ）。画面をブラウザで開いて直すときと、自動操作のテストに使う |
| `scripts/guide_probe.py` | 再現ガイドの API 呼び出しを実際に送って確かめる（キャッシュが効いているか、トークン数、モデルと思考の深さの比較）。費用がかかるものは `--yes` を付けたときだけ送る |
| `web-ui/e2e/` | ブラウザを自動操作するテスト（Playwright） |
| `web-ui/e2e-desktop/` | 本物の窓を自動操作するテスト（WebDriver + vitest）。テスト用のビルドとアプリの起動・後片付けも |
| `scripts/prepare-desktop.mjs` | デスクトップ版に同梱するもの（`uv` のバイナリと `backend/`）を用意する。`npm run tauri dev` / `build` の前に自動で走る |

## 依存関係
`pyproject.toml` に記載し、`uv.lock` で版を固定する（`uv sync` で入る。Python は 3.11）。
主要なもの:
- `demucs`, `torch`, `torchaudio` — 音源分離
- `fastapi`, `uvicorn`, `python-multipart` — Web API
- `soundfile` — WAV読み書き
- `numpy` — 音声処理全般（遅延インポート）
- `librosa` — 音声解析
- `pyfluidsynth` — SoundFont シンセ（`soundfonts/MuseScore_General.sf3`を使用）

## 設計方針
- **CPU環境前提**: GPU不要。低スペックPCでも動作するよう設計
- **メモリ節約**: segment=7で処理セグメントを短くしメモリ使用量を抑制
- **並列制限**: jobs=1でCPU負荷を最小化
- **WAV入出力**: エンコード/デコードの負荷を避けるためWAVをデフォルトに
- **遅延インポート**: 起動高速化のため、重いモジュール（numpy等）はボタン押下時にインポート
- **モデル**: htdemucs（標準）を推奨。htdemucs_ftは高精度だがCPUでは非常に遅い

## コーディング規約
- 日本語でdocstring・コメントを書く
- 新しいモジュールは `audio_utils.py` の `load_audio` / `save_tmp` を活用する
- 重いインポート（numpy, librosa等）は関数内で遅延インポートする
- 一時ファイルは `tempfile` を使い、結果は `results/` に保存する
- 新規モジュールの出力先は `audio_utils.results_dir()` 経由で解決する（デスクトップアプリでは環境変数 `BUNRI_DATA_DIR` で置き場を差し替えるため、パス直書きを避ける）
- 外から受け取ったファイル名は `audio_utils.safe_join()` を通してからパスにする

## AI統合の方針
このプロジェクトは「生成しないAIアシスタント」を目指す。取り込んだ楽曲を教材として、ユーザー自身が再現できるよう導く。

原則: **DSPが事実を出し、LLMは言語化だけをする。LLMは音符を1つも出力しない。**

3層構成（第1層と第2層を実装済み。第3層は、差分を出す部分と、それを言葉にする部分のバックエンドまで。言葉にする部分の画面はまだ無い。第2層・第3層の決定は暫定）:
1. **楽曲カルテ** — 解析結果の構造化データ。LLM不使用（`song_chart.py` ほか）
2. **再現ガイド** — 「こう作れば再現できる」の説明。LLM使用
3. **差分コーチ** — ユーザーの打ち込みと原曲の差分指摘。本命の差別化点

グリッド推定（テンポと 1 拍目の位置）を直すときは、[docs/grid-estimation.md](../docs/grid-estimation.md) を読み、
`uv run python test/back/bench_grid.py` で直す前と後の誤差を比べる（正解の分かっている合成音源 157 件）。

詳細は [docs/song-chart-design.md](../docs/song-chart-design.md)（第1層）、[docs/reproduction-guide-design.md](../docs/reproduction-guide-design.md)（第2層）、[docs/coach-diff-design.md](../docs/coach-diff-design.md)（第3層。差分と、その言語化）を参照。

Claude を呼ぶコードは公式の `anthropic` SDK を使い、キーは `llm_settings` 経由で取る（`os.getenv` を import 時に呼ばない）。

Claude の呼び出しは費用がかかる。再現ガイドには、無駄に呼ばないための仕組みが入っている
（[docs/reproduction-guide-design.md](../docs/reproduction-guide-design.md) の「費用」）。手を入れるときの決まり:

- 通常のテスト（`make test`、`make e2e`）は Claude を呼ばない。e2e は偽の Claude サーバ（`web-ui/e2e/fake-anthropic.mjs`）を相手にする。本物を呼ぶのは `BUNRI_E2E_LLM=1` を付けたときと、`scripts/guide_probe.py` に `--yes` を付けたときだけ。**どちらも、実行の前に利用者の了承を取る**
- 指示文（`SYSTEM_PROMPT`）・出力の形（`GUIDE_SCHEMA`）・カルテの渡し方（`prompt_chart`）・検証を変えたら、`GUIDE_VERSION` を上げる（保存済みのガイドを使わせないため）
- リクエストの組み立てを変えたら、プロンプトキャッシュが効いているかを、コードを読んで判断せず `scripts/guide_probe.py cache --yes` で確かめる
- キャッシュの区切りより前（指示文とカルテ）に、時刻・乱数・呼び出しごとに変わる値を入れない。モデル・思考の深さ・出力の形を、呼び出しごとに変えない
- `max_tokens` は切れたときの歯止めで、節約の手段ではない。出力を短くしたいときは指示文で行う
