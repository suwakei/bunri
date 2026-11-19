# bunri DAW

## 概要
Demucs (Meta AI) による音源分離と、音声編集・ミキシング・エフェクトを備えた軽量DAW。
React / Vite / TypeScript の画面、FastAPI / Python 3.11 の音声処理、Tauri v2 / Rust のデスクトップアプリ。
この文書を Claude Code と Codex の共通規約とし、Codex の入口はルートの `AGENTS.md`。

## 起動
デスクトップアプリ（Tauri v2）。開発モード（Rust と uv が要る）:
```bash
make install && make install-frontend && make install-desktop   # 初回のみ
make desktop           # = npm run tauri dev
```
窓が開き、Python は sidecar として空きポートで一緒に起動する。配布物は `make desktop-build`（= `npm run tauri build`）。
アプリは音のエンジン（sfizz を submodule からビルドする）をリンクするので、submodule と cmake が要る（下の「テスト」）。
構成と、変えてはいけない約束ごとは [docs/desktop-architecture.md](../docs/desktop-architecture.md)。

ブラウザで開く版と Docker は廃止した。画面をブラウザで開く経路は、開発と自動テスト用にだけ残してある
（Vite の開発サーバ + `backend/run_web.py`。同文書の「開発用のブラウザ起動」）。

## テスト
音のエンジン（`src-tauri/audio-engine`）は sfizz を submodule からビルドするので、`make desktop` と、`make test` / `make lint` / `make check` の desktop 検証には
submodule と cmake が要る（`git submodule update --init --recursive`、`brew install cmake`）。設計は [docs/instrument-engine-design.md](../docs/instrument-engine-design.md)。
```bash
make check-plan   # 変更した領域に必要な検証を表示（実行しない）
make check        # 変更した領域の lint・型・単体テスト・build。UI 変更は E2E も含む
make check-all    # 全領域の検証 + ブラウザ / 本物の窓の E2E
make test    # 単体テスト（フロント + バック + Rust）
make lint
make e2e     # ブラウザを自動操作するテスト（Playwright。サーバは自分で起動して止める）
make e2e-desktop  # 本物の窓（テスト用にビルドしたデスクトップアプリ）を自動操作するテスト（mac のみ）
```
**検証は、変えたところに当たるものだけを選んで回す**（2026-11-19 の利用者の指示）。変更のたびに `make check` の全部を
回さない（ブラウザの E2E 全体だけで 15 分ほどかかり、そのあいだに main が動いて結果が古くなる）。

- Python: 触ったモジュールのテストファイルと lint（`uv run --frozen python -m pytest test/back/test_<名前>.py -q`、
  `uv run --frozen ruff check backend test/back`）
- 画面: 触った部品・`lib/` の単体テスト（`cd web-ui && npx vitest run src/__tests__/<名前>`）と、lint・型。
  操作の流れを変えたら、関係する spec だけ（`npm run e2e -- <名前>.spec.ts`）
- Rust: `cargo fmt --all --check`・`cargo clippy`・触ったモジュールの `cargo test <名前>`。本物の窓でしか確かめられないものは、
  関係するテストだけ（`cd web-ui && node e2e-desktop/build.mjs && npx vitest run --config e2e-desktop/vitest.config.ts -t "<名前>"`）
- 文言・コメント・文書だけの変更では、E2E を回さない
- `make check`（変更した領域の全部）と `make check-all` は、広い範囲を変えたときと、利用者に頼まれたときに使う
- 何を回して、何を回していないかを、報告に書く

Python のテスト出力は、`make check` 経由なら毎回新しい一時 `BUNRI_DATA_DIR` に隔離される。pytest を直接呼ぶときも、
利用者のデータ置き場に書かないようにする。ブランチ全体の差分を確かめるときは `node scripts/check.mjs --base main`。
隠しファイル込みの探索や lint で `.claude/worktrees/` の別チェックアウトを巻き込まない。
`make clean` はユーザーの `uploads/`・`results/`・`projects/` を削除するので、通常の検証では使わない。
画面の操作の流れを変えたら、関係する spec をブラウザで回す。単体テストが通っていても、画面に出ない・押せないといった
不具合は、ブラウザで実際に操作しないと見つからない（[docs/ui-testing.md](../docs/ui-testing.md) に実例）。
`make e2e` の画面にはデスクトップ版と同じ CSP が掛かっていて、違反があれば失敗する。

CSP・フォント・同梱物・`tauri.conf.json`・`src-tauri/`・sidecar の起動や鍵・書き出しを変えたら、`make e2e-desktop` も回す
（初回はビルドで数分、2 回目からは 20 秒ほど）。テスト用のビルドはアプリの中で WebDriver サーバを動かすので、
機能 `e2e` は配布物に入れない（[docs/desktop-architecture.md](../docs/desktop-architecture.md)「窓を自動操作するテスト」）。
エージェントが画面をその場で操作して確かめるときは、Playwright MCP と `make dev-web` を使う。
利用者に「こう操作して」「こう操作したらこうなった」と言われたときは `/drive`（`.claude/skills/drive`）:
本物の窓を画面のことばで操作し（`web-ui/e2e-desktop/drive.ts`）、アプリが残す**動きの記録**（押したボタン・結果・API・MIDI。
利用者も画面の「記録」で見ている。開発時は `logs/activity.log`）を読んで、何が起きたかを確かめる
（[docs/ui-testing.md](../docs/ui-testing.md)「4. 頼まれた操作を行い、動きの記録で追う」）。
MCP の共通ソースは `.mcp.json`、Codex 向け設定は `make harness-sync` で生成する `.codex/config.toml`。
実 LLM API を使うテストは通常の検証に含めず、ユーザーが明示したときだけ実行する。

## Git の運用
**変更は main に直接 commit して push する**（ブランチも PR も作らない。2026-11-19 の利用者の指示）。
頼まれた実装・修正が終わり、検証が通ったら、聞かずに main へ commit・push してよい。

- push の前に、変えたところに当たる検証を通す（「テスト」の節。全部は回さない）。落ちたまま push しない
  （CI はリント・型・ビルドだけで、テストは回さない）
- 作業の前に `git switch main && git pull --ff-only` で最新にする。push が拒まれたら `git pull --rebase` で取り込み直す
- 同じ作業ツリーを複数のセッションが使うことがある。`git add -A` の前に `git status --short` を見て、
  自分の作業でない変更が混ざっていないか確かめる（混ざっていたら、相手か利用者に確かめる）
- force push・履歴の書き換え（`reset --hard` で push 済みのものを消す、`rebase` で push 済みの commit を書き換える）はしない
- commit の文は日本語。1 つの commit に 1 つの話題を基本にする

## ファイル構成
Python のコードはすべて `backend/` に在る（フラットな構成のまま、置き場だけまとめてある）。
下の表のファイル名は `backend/` からの相対。

| ファイル | 役割 |
|---|---|
| `run_web.py` | API サーバの起動スクリプト。デスクトップアプリが sidecar として起動する（`--sidecar`）。開発用に単体でも起動できる |
| `web/api.py` | FastAPI バックエンド API（API だけ。画面は配らない） |
| `web/project_routes.py` | プロジェクトの保存・開く（`/api/project/*`）とデータの整理（`/api/storage*`）の API |
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
| `bunri_file.py` | `.bunri` ドキュメント（SQLiteベース単一ファイル）の読み書き。v2（2.0）はプロジェクト全体（トラック・ノート・音声 FLAC・カルテ・学ぶ流れの状態・学習の記録・ガイドと説明の写し）。v1 は `migrate` で上げる |
| `project_store.py` | プロジェクトの保存と開く（作業用の写し `work/`・音声の預かり・開発用の置き場 `projects/`・以前の形式 JSON・データの整理）。sidecar はデータ置き場の外を読み書きしない |
| `audio_utils.py` | 共通ユーティリティ（load_audio / save_tmp等）とデータ置き場の解決（data_dir / results_dir / uploads_dir / work_dir 等） |
| `_demucs_runner.py` | Demucs を子プロセスとして動かすスクリプト（torchaudio 保存パッチ。API から起動されたときは `demucs_progress` で進み具合を報告する） |
| `llm_settings.py` | Claude の API キーとモデルの解決（キーは呼び出しのたびに読む。配布物に同梱しない）。既定のモデルは Haiku 5.5、選べるモデルは Haiku / Sonnet / Opus |
| `model_router.py` | 依頼ごとのモデルの選択（ルーター）。依頼の最初の呼び出しの前に、Haiku が依頼の文から Haiku / Sonnet / Opus を選ぶ（Structured Outputs）。`BUNRI_GUIDE_MODEL` が在れば選ばずに固定。失敗したら Haiku |
| `reproduction_guide.py` | 再現ガイド（第2層）。カルテを Claude に渡して手順の説明にする。出力は Structured Outputs で形を固定し、カルテと突き合わせて検証する |
| `guide_cache.py` | 作った再現ガイドの保存（同じ条件なら Claude を呼ばない）と、同じカルテへの呼び出しを 1 つずつ通す錠 |
| `guide_usage.py` | 再現ガイドの使用量の記録（`results/guide/usage.jsonl`。中身とキーは残さない）、概算の費用、1 日の上限 |
| `llm_pricing.json` | Claude の単価の表（概算の費用の計算に使う。コードに埋めず、ここと設定で持つ） |
| `coach_diff.py` | 差分コーチ（第3層）の土台。お手本のノートと打ち込みの差分を事実として出す（LLM 不使用）。MIDI から読み込んだお手本のときだけ、強さの違いもまとまり（全体・範囲・強弱なし・アクセント）で出す。ドラムは `mode="drums"` で、種類（= 高さ）ごとの叩く位置だけを比べる（長さを見ない。許容は 16 分音符 1 個）。位置と長さの小数（三連符・32 分）を受け付け、差が 0.5 ステップ以上のときだけ「位置のずれ」「長さの違い」にする |
| `note_steps.py` | ノートの位置と長さ（`step` / `length`）の数の決まり。16 分音符単位の小数を 1/60 ステップの倍数に丸め、整数になる値は整数で返す（画面の `lib/grid.ts` と同じ値）。比べるときは刻みの数（`to_ticks`）で比べる |
| `coach_explain.py` | 差分コーチ（第3層）の言語化。差分の事実を Claude に渡して「どんな傾向か・なぜと考えられるか・まず何を見直すか」にする。出力は Structured Outputs で形を固定し、事実と突き合わせて検証する。保存・使用量の記録・1 日の上限は第2層と共通 |
| `model_cache.py` | 音源分離モデル（Demucs）が手元に在るか（初回ダウンロードが要るか）の確認 |
| `stem_models.py` | Demucs が自分では取りに行けない追加の分離モデル（ドラムの細分化）の置き場とダウンロード。ハッシュを照合してから置く。配るのは safetensors だけ（pickle 形式のモデルを利用者の PC で開かない） |
| `assistant.py` | アシスタント（アプリの中のチャット）の Claude の呼び出し。1 回の呼び出しごとに完結し、会話の状態を持たない（繰り返しとツールの実行は画面側）。応答は、まとめて返す形（`step`）と、少しずつ返す形（`stream_step`。NDJSON）が在る。使用量の記録・1 日の上限は第2層と共通。設計は [docs/assistant-design.md](../docs/assistant-design.md) |
| `assistant_tools.json` | アシスタントのツールの台帳（Claude に渡す定義の正本）。画面側は同じ名前の実行する関数を持ち、名前の一致をテストで確かめる |
| `access_control.py` | デスクトップ版で API にかける鍵（トークン検証）と CORS。`BUNRI_TOKEN` が在るときだけ有効 |
| `background_jobs.py` | 時間のかかる処理（ジョブ）を 1 つずつ裏で動かし、ステージ・進み具合・経過時間を持ち、キャンセルと書きかけの出力の削除を受け持つ（FastAPI に依存しない）。約束は [docs/jobs.md](../docs/jobs.md) |
| `demucs_progress.py` | Demucs の子プロセスとのやり取り（子の側で進み具合をイベントとして出し、親の側でジョブに伝える。親が居なくなったら子は自分で終わる） |

`backend/` の外:

| 場所 | 役割 |
|---|---|
| `web-ui/` | 画面（React + Vite + TypeScript）。API 呼び出しは必ず `src/lib/api.ts` の `apiFetch` / `backendUrl` を通す（素の `fetch('/api/...')` を書かない）。再生は `src/lib/engine.ts` を通す（デスクトップ版では Rust の engine、ブラウザでは Web Audio で鳴らす。Rust に渡す口 `src/lib/native-audio.ts` を部品から直接呼ばない） |
| `src-tauri/` | デスクトップアプリのネイティブ側（Rust）。窓の生成、初回セットアップ、Python sidecar の起動・監視・終了、API キーのキーチェーン保存、MIDI 入力の受け取り、プロジェクトのファイルの保存・開く（ダイアログ・最近使ったプロジェクト・閉じる前の確かめ。`project.rs`）、動きの記録のファイル（`activity.rs`）、音の再生（`audio.rs`。画面の頼みを音のエンジンに渡し、再生位置を知らせる）だけを持つ |
| `src-tauri/audio-engine/` | 音のエンジン（crate `bunri-audio`）。曲（トラック・ノート・クリップ・楽器）を受け取ってブロックごとに音を作る engine、sfizz のサンプラー、仮の音（三角波）、ドラムの合成音（`drum.rs`）、クリップの鳴らす範囲とフェード（`clips.rs`）、再生の状態（transport）、cpal での出力、オフライン描画（WAV 書き出し）。デスクトップ版の再生と鍵盤の試聴はここが鳴らす。書き出しは、まだ画面側。画面の書き出しと同じ音かは `tests/webaudio_parity.rs` が確かめる（設計と PR の並びは `docs/instrument-engine-design.md`） |
| `scripts/dev-web.mjs` | 開発用のブラウザ起動（Vite + API サーバ）。画面をブラウザで開いて直すときと、自動操作のテストに使う |
| `scripts/webaudio-reference.mjs` | Web Audio の書き出し（本物の `engine.ts` の `mixdown`）で決まった曲を WebKit と Chromium で WAV にし、Rust の engine と突き合わせる基準（`src-tauri/audio-engine/tests/fixtures/webaudio/`）を作る。サーバは立てない |
| `scripts/guide_probe.py` | 再現ガイドの API 呼び出しを実際に送って確かめる（キャッシュが効いているか、トークン数、モデルと思考の深さの比較）。費用がかかるものは `--yes` を付けたときだけ送る |
| `scripts/assistant_probe.py` | アシスタントの API 呼び出しを実際に送って確かめる（台帳の形が通るか、ツールの引数が台帳に合うか、思考のブロックごと送り返せるか、キャッシュが効いているか、少しずつ返す版が読めるか）。`--yes` を付けたときだけ送る |
| `web-ui/e2e/` | ブラウザを自動操作するテスト（Playwright） |
| `web-ui/e2e-desktop/` | 本物の窓を自動操作するテスト（WebDriver + vitest）。テスト用のビルドとアプリの起動・後片付けも。エージェントが頼まれた操作を行うコマンド（`drive.ts`）と、押せるものを画面のことばで探す部品（`controls.ts`）も |
| `web-ui/src/lib/assistant.ts` / `assistant-tools.ts` | アシスタントの会話と繰り返し、ツールの実行（引数の確かめ、元に戻す履歴へのまとめ、操作ログ）。画面は `components/AssistantPanel.tsx`（右側のドック）。ツールは種類ごとに `assistant-tools-notes.ts`（ノートの変形）・`assistant-tools-learn.ts`（差分・ガイド・練習の設定・場所を示す）・`assistant-tools-app.ts`（パート分離・書き出し・保存・クリップ・エフェクト）、共通の部品と画面の入口の形は `assistant-tool-kit.ts`、本物の入口は `assistant-env.ts` |
| `web-ui/src/lib/assistant-history.ts` / `assistant-project.ts` | アシスタントの会話の保存（プロジェクトの節 `assistant`。画面に並ぶ文と操作ログの行だけ）と、長くなったとき・開き直したときに送る会話を置き換える「これまでの記録」（決まった規則で作る。Claude は呼ばない） |
| `web-ui/src/lib/assistant-landmarks.ts` / `assistant-suggestions.ts` | アシスタントが示せる画面の場所の一覧（`show_in_app`）と、ドックが空のときに出す頼み方の例（状況に合わせて選ぶ） |
| `web-ui/src/lib/fx.ts` / `export-actions.ts` | エフェクトの定義とかける処理、WAV・MIDI の書き出し。画面のボタンとアシスタントのツールが、同じ処理を使う |
| `web-ui/src/lib/practice-map.ts` | 練習の地図（学ぶ → 差分 の段と、練習画面の「構成」の段）の集計。学習の記録から、パートごと・構成の区間ごとの一致率を出す（LLM 不使用。画面は `components/PracticeMap.tsx`。決まりは `docs/coach-diff-design.md`「練習の地図」） |
| `web-ui/src/lib/autosave.ts` | 自動保存と、落ちたときの復旧。保存していない変更を、データ置き場の `recovery/` に復旧用の写しとして残す（利用者のファイルは自動では書き換えない。置き場と目印は `project_store.py`）。起動したときに残っていれば「続きを開きますか」と尋ねる |
| `web-ui/src/lib/clip.ts` / `waveform.ts` | クリップの鳴らす範囲とフェード（縮める・分割・フェード。音声は書き換えない）と、クリップに描く波形。再生・区間ループ・書き出し・練習画面の速度・タイムライン・アシスタントのツールが、同じ計算を使う |
| `web-ui/src/lib/drums.ts` / `drum-sound.ts` | ドラムの決まり（種類 → 高さの対応 `DRUM_ROWS`、ドラムのトラックの見分け方、差分の比べ方 `diffModeOf`）と、ドラムの簡単な合成音（`playDrum`。再生・区間ループ・書き出し・試聴が同じ関数を使う）。デスクトップ版の再生で鳴らす同じ音は `src-tauri/audio-engine/src/drum.rs`（変えるときは両方を一緒に変え、`node scripts/webaudio-reference.mjs` で基準の WAV を作り直す） |
| `web-ui/src/lib/snap.ts` / `pitch-hints.ts` | ピアノロールの刻み（4 分〜32 分・三連）とスウィングの計算（画面は `components/SnapBar.tsx`）と、キーの音・コードの音の色づけ（カルテのキーとコード。コードの表は `backend/music_theory.py` とテストで突き合わせる。画面は `components/PitchHintBar.tsx`） |
| `web-ui/src/lib/activity.ts` | 動きの記録（いま何が起きたか）。操作・ステータスバーの文・API の呼び出しは自動で残る。入力欄に打っている途中の文字・API キー・トークンは載せない |
| `web-ui/src/lib/notice.ts` | 知らせ（失敗と「いまはできない理由」を、画面に浮かせて出す）。ストアの `setStatus(文, 'error' \| 'hint')` が呼ぶ。押せない部品を押したときの理由（`blockedBy` / `blockedReason`）も。表示は `components/NoticeToast.tsx`（`main.tsx` に 1 つ） |
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
- 動きの記録（`recordActivity`）に、入力欄に打っている途中の文字・API キー・トークン・API に送った中身を載せない（プロジェクト・トラック・ファイルの名前は、結果の文として載ってよい）
- ノートの `step` / `length` は 16 分音符単位で、小数を持てる（0.5 = 32 分、4/3 = 8 分の三連）。ノートを作る・動かす・貼る・読み込む場所は、1/60 ステップの倍数にそろえる関数（画面は `lib/grid.ts`、Python は `note_steps.py`）を通す。差・等しさ・範囲・小節の判定は、小数のまま比べず、刻みの数（1/60 ステップの整数）で比べる
- クリップの鳴らす範囲とフェードは `lib/clip.ts` の関数で読む（`clip.buffer.duration` をクリップの長さとして使わない）
- 利用者の操作（押す・キー・ドロップ・鍵盤）を、黙って何もせずに戻さない。条件が足りないときは `setStatus(文, 'hint')`（なぜ何も起きないか + どうすればできるか）、失敗は `setStatus(文, 'error')`。どちらも、画面に浮かぶ知らせとしても出る（`lib/notice.ts`）。押せないボタンの説明が理由になっていないときは `blockedBy(条件 && '理由')` を付ける（[docs/ui-terms.md](../docs/ui-terms.md)「書き方」）

## AI統合の方針
このプロジェクトは「生成しないAIアシスタント」を目指す。取り込んだ楽曲を教材として、ユーザー自身が再現できるよう導く。

原則: **DSPが事実を出し、LLMは言語化だけをする。LLMは音符を1つも出力しない。**

3層構成（3 層とも画面まで実装済み。第3層は、差分を出す部分と、それを言葉にする部分。第2層・第3層の決定は暫定）:
1. **楽曲カルテ** — 解析結果の構造化データ。LLM不使用（`song_chart.py` ほか）
2. **再現ガイド** — 「こう作れば再現できる」の説明。LLM使用。頼むのも結果が出るのも、アシスタントのドックのチャット（ツール `make_guide`。結果はカード）
3. **差分コーチ** — ユーザーの打ち込みと原曲の差分指摘。本命の差別化点。差分の一覧は「学ぶ」の差分の段、言語化はドックのチャット（ツール `explain_diff`。結果はカード）。ドラムも対象（叩く位置だけを比べる。ドラムでは言語化を呼ばない。ドラムに広げるときは `coach_explain` の指示文と版を変え、本物の Claude で確かめる。[docs/coach-diff-design.md](../docs/coach-diff-design.md)「ドラムの差分」）

グリッド推定（テンポと 1 拍目の位置）を直すときは、[docs/grid-estimation.md](../docs/grid-estimation.md) を読み、
`uv run python test/back/bench_grid.py` で直す前と後の誤差を比べる（正解の分かっている合成音源 157 件）。
採譜のグリッドの見分け（16 分か 8 分の三連か。`decompose.detect_grid_feel`）の値を直すときは、docs/coach-diff-design.md の「採譜のグリッド」を読む。
ふつうの曲を三連と取り違えないことを優先する（迷うときは 16 分）。値は合成したデータでしか確かめていない。
ドラムを種類ごとに分ける追加のモデル（約 160 MB）は、利用者が選んだときだけダウンロードする（用意できない・細分化が失敗したときは、失敗にせず分けない採譜に落とす）。

この原則は、原曲を教材にする 3 層のもの。別に **アシスタント**（アプリの中のチャット。右側のドック）が在り、
利用者に頼まれた操作を、ツールで代わりに行う。ノートを置く・変える操作も持つ（2026-11-18 の利用者の決定）。
行った操作はチャットの操作ログに出て、1 回の依頼ぶんを 1 回で元に戻せる。お手本との差分は、アシスタントも
信号処理の側の事実（`check_diff`）から言葉にする（自分で比べない）。会話は、プロジェクトに保存される。利用者が「アシスタント」と言うときは、
この機能のこと（Claude Code のことではない）。設計は [docs/assistant-design.md](../docs/assistant-design.md)。

詳細は [docs/song-chart-design.md](../docs/song-chart-design.md)（第1層）、[docs/reproduction-guide-design.md](../docs/reproduction-guide-design.md)（第2層）、[docs/coach-diff-design.md](../docs/coach-diff-design.md)（第3層。差分と、その言語化）を参照。

Claude を呼ぶコードは公式の `anthropic` SDK を使い、キーは `llm_settings` 経由で取る（`os.getenv` を import 時に呼ばない）。

Claude の呼び出しは費用がかかる。再現ガイドには、無駄に呼ばないための仕組みが入っている
（[docs/reproduction-guide-design.md](../docs/reproduction-guide-design.md) の「費用」）。手を入れるときの決まり:

- 通常のテスト（`make test`、`make e2e`）は Claude を呼ばない。e2e は偽の Claude サーバ（`web-ui/e2e/fake-anthropic.mjs`）を相手にする。本物を呼ぶのは `BUNRI_E2E_LLM=1` を付けたときと、`scripts/guide_probe.py`・`scripts/assistant_probe.py` に `--yes` を付けたときだけ。**どれも、実行の前に利用者の了承を取る**
- 指示文（`SYSTEM_PROMPT`）・出力の形（`GUIDE_SCHEMA`）・カルテの渡し方（`prompt_chart`）・検証を変えたら、`GUIDE_VERSION` を上げる（保存済みのガイドを使わせないため）
- リクエストの組み立てを変えたら、プロンプトキャッシュが効いているかを、コードを読んで判断せず `scripts/guide_probe.py cache --yes` で確かめる
- キャッシュの区切りより前（指示文とカルテ）に、時刻・乱数・呼び出しごとに変わる値を入れない。思考の深さ・出力の形を、呼び出しごとに変えない。
  モデルは、ルーター（`model_router.py`）が **依頼の境目でだけ** 選ぶ（2026-11-19 の利用者の決定）。依頼の途中（続きの呼び出し・その依頼の中で作るガイドと説明）では変えない。
  ルーターの指示文・出力の形を変えたら `ROUTER_VERSION` を上げ、本物の Claude で選び方を確かめる（利用者の了承を取ってから）
- `max_tokens` は切れたときの歯止めで、節約の手段ではない。出力を短くしたいときは指示文で行う
- アシスタントの指示文（`assistant.SYSTEM_PROMPT`）・ツールの台帳（`assistant_tools.json`）を変えたら、`ASSISTANT_VERSION` を上げる。
  台帳のツールを足す・外す・名前を変えるときは、画面側の実行する関数（`assistant-tools.ts`）も一緒に変える
  台帳の形が本物の Claude に通るか・キャッシュが効いているかは、コードを読んで判断せず `scripts/assistant_probe.py --yes` で確かめる
- アシスタントの会話は、足すだけにする（前のメッセージを書き換えない・間引かない）。応答の `content` は、思考のブロックごと
  変えずに送り返す。縮めるのは依頼の境目だけで、そのときは送る会話を丸ごと「これまでの記録」1 つに置き換える
  （`assistant-history.ts`。途中のメッセージだけを抜かない。記録を作るのに Claude を呼ばない）
- アシスタントの差分チェック（`check_diff`）は、事実を返すだけにする（信号処理の側の差分。言語化の API を呼ばない）。
  画面の部品に在る処理をツールにするときは、処理を `lib/` の関数に出して、部品とツールの両方から呼ぶ（同じ処理を 2 か所に書かない）
- アシスタントのツールの失敗は、Claude に返す文（`ToolError` の `message`。ツールや引数の名前で、直し方を書く）と、
  操作ログに出す文（`shown`。利用者向け。内部の名前を入れない）を分ける。引数の指定の誤りは `ArgError` にする
- 示せる場所を足す・外すときは、`assistant-landmarks.ts` と台帳の `show_in_app` の `target` を一緒に変える（指示文の
  「Where things are in bunri」も、画面の構成が変わったら直す）
