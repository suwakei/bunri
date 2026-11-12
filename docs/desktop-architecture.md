# デスクトップ版の構成

bunri のデスクトップ版が、どういう部品で出来ていて、なぜその形なのかをまとめる。
コードを触る人が、変えてよいところと変えてはいけない約束ごとを見分けられるようにするための文書。

## 全体像

```
bunri.app (Tauri v2)
├─ WebView: web-ui (React) をアプリに同梱して表示
│     ├─ HTTP ──► Python sidecar (FastAPI。127.0.0.1 の空きポート)
│     └─ Tauri command ──► Rust (接続先とトークンを受け取る / 起動の進み具合を聞く)
├─ Rust (src-tauri/): 窓の生成、初回セットアップ、sidecar の起動・監視・終了
└─ Python sidecar (backend/): demucs / basic-pitch / librosa / fluidsynth / dawdreamer
```

Python (AI・音声処理)、Web (画面)、Rust (ネイティブ) が、それぞれ得意な部分だけを持つ。
製品としての形はデスクトップアプリだけ。ブラウザで開く版と Docker は廃止した。
開発用に、画面をブラウザで開く経路 (Vite の開発サーバ + `backend/run_web.py`) だけを残してある
(「開発用のブラウザ起動」の節)。

| 決めたこと | 理由 |
|---|---|
| ネイティブ側は Tauri (Rust) | 後で低レイテンシの音声エンジン (cpal / midir) を同じ場所に書ける。Electron だと C++ アドオンになる |
| Python を残す | 音源分離と採譜のライブラリは Python にしか無い。ここが bunri の中身 |
| Python を PyInstaller で固めない | torch 込みで数 GB になる。`uv` のバイナリだけを同梱し、初回起動時に依存を入れる |
| 画面は FastAPI から配らず Tauri に同梱 | Python がまだ入っていない初回起動時に、セットアップの進み具合を出す必要がある |

検討して捨てた案: Electron (上記)、pywebview (Rust の置き場が無い)、
純 Rust や JUCE での書き直し (demucs と basic-pitch を失う)。

## 起動の流れ

1. **Rust が起動方法を決める** (`src-tauri/src/sidecar.rs` の `LaunchConfig`)
   - `tauri dev`: 開発機の `uv run` で、リポジトリの `backend/` をそのまま起動する
   - 配布物: 下の 2〜3 を行う
2. **セットアップ** (配布物のみ): 同梱した `uv` で `uv sync --frozen --no-dev` を実行し、
   アプリのデータ置き場に Python 3.11 と依存を入れる。出力を画面に流す。
   毎回の起動で実行するが、揃っていれば 0.1 秒で終わり、ネットワークも使わない。
   `uv sync` は済んだぶんを飛ばすので、途中で落ちても次回の起動で続きから入る。
   成功したら、使った `uv.lock` の指紋を `runtime/setup-done` に書く。この印が同梱の指紋と
   合わないとき (初回、途中で落ちた、アプリの更新) は、時間がかかる旨を画面に出す
3. **sidecar の起動**: 作った環境の Python で `backend/run_web.py --sidecar` を起動する
4. **画面**: `web-ui/src/lib/api.ts` の `initBackend()` が Rust の `backend_info` を呼び、
   sidecar が待ち受けを始めるまで待つ。その間 `boot_status` を 0.5 秒おきに聞いて進み具合を表示する

## 約束ごと (変えるときは両側を一緒に変える)

### ポートは Python 側が決める

`run_web.py --sidecar` は空きポート (`--port 0`) で待ち受け、標準出力の最初の行に
`{"event": "listening", "port": N, "pid": P}` を出す。Rust はそれを読む。
Rust が空きポートを選んで渡すと、起動までの間に他のプロセスに取られることがある。

### API には鍵がかかっている

Rust が起動ごとに乱数のトークンを作り、環境変数 `BUNRI_TOKEN` で sidecar に渡す。
画面は全リクエストのヘッダ `X-Bunri-Token` にそれを付ける。トークン無しは 401。
127.0.0.1 で待っていても、同じ PC のブラウザで開いた別サイトから叩けるため。
CORS は `BUNRI_ALLOWED_ORIGINS` (アプリの origin) だけ許す。

- `<audio src>` と `<a href download>` はヘッダを付けられないので、クエリ `?token=` でも受け付ける。
  画面側は `backendUrl()` を通す
- `BUNRI_TOKEN` が無いとき (開発用の起動とテスト) は、トークンも CORS も足さない
- **画面から API を呼ぶときは、必ず `apiFetch` / `backendUrl` を通す。** 素の `fetch('/api/...')` は
  開発用のブラウザ起動では動くが、デスクトップアプリでは接続先もトークンも付かず失敗する

### sidecar を孤児にしない

Rust は sidecar の標準入力をパイプで握ったままにする。sidecar は標準入力が EOF になったら、
自分と自分が起動した子プロセス (demucs の実行など) をまとめて終わらせる。
アプリが強制終了されても、OS がパイプを閉じるので同じように終わる。
通常の終了時は、Rust が先にパイプを閉じ、3 秒待っても終わらなければ kill する。

sidecar は、終わる前に、動いているジョブ (下の「時間のかかる処理」) を止めて書きかけの出力を消す。
片付けに使うのは 1.5 秒まで (アプリが kill しに来る 3 秒より短くしてある)。
Demucs の子プロセスも同じ仕組みで sidecar を見張っていて、sidecar が強制終了されたら自分で終わる。

セットアップ中 (`uv sync` の実行中) は事情が違う。通常の終了なら Rust が `uv` をプロセスグループごと
kill するが、アプリが強制終了された場合、`uv` は親が居なくなったことに気づかず、ダウンロードを
最後まで続けてから終わる。害は無い (次回の起動はその続きから入る) が、プロセスはしばらく残る。

### アプリの中には書き込まない

署名の封印が壊れるので、`bunri.app` の中には何も書かない。書き込む先はすべてデータ置き場。

| 場所 (mac) | 中身 |
|---|---|
| `bunri.app/Contents/MacOS/uv` | 同梱した `uv` (版とハッシュは `scripts/prepare-desktop.mjs` で固定) |
| `bunri.app/Contents/Resources/runtime/` | `backend/` と `pyproject.toml` / `uv.lock` (読み取り専用) |
| `~/Library/Application Support/io.github.suwakei.bunri/runtime/` | Python 本体、venv、uv のキャッシュ、`.pyc` |
| `~/Library/Application Support/io.github.suwakei.bunri/data/` | `uploads/` `results/` `projects/` `soundfonts/` (`BUNRI_DATA_DIR`) |
| `~/.cache/huggingface/` `~/.cache/torch/` | 音源分離のモデル (ライブラリの既定の置き場のまま) |

Python 側は、データの場所を `audio_utils.data_dir()` から引く。パスを直書きしない。
外から受け取ったファイル名は `audio_utils.safe_join()` を通す。

## 時間のかかる処理

音源分離・分解・カルテ・採譜は、sidecar の中で「ジョブ」として 1 つずつ動く。画面は API に `?async=1` を
付けて始め、`GET /api/jobs/{id}` で進み具合 (ステージの名前、分かるときは割合) を聞き、
`POST /api/jobs/{id}/cancel` でやめる。`?async=1` を付けない従来の呼び方も、そのまま使える。

- 重い処理は同時に 1 つ。動いている間の開始は 409 で断り、何が動いているかを返す
- Demucs は子プロセスなので、キャンセルで kill できる。Python の中で動く解析は、ステージの切れ目でしか止まらない
- ジョブの API も、ほかの API と同じくトークンで守られる

API の約束、どのステージで割合が出るか、キャンセルで止まらないものは [jobs.md](jobs.md) にまとめてある。

## 開発用のブラウザ起動

画面をブラウザで開いて直すとき、またはブラウザを自動操作してテストするときの経路。製品の形ではない。

- バックエンド: `uv run python backend/run_web.py --port <N>`。トークン無しで API だけを待ち受ける
- 画面: `cd web-ui && npm run dev`。Vite の開発サーバが画面を出し、`/api` をバックエンドへ中継する
  (中継先のポートは環境変数 `BUNRI_API_PORT`)
- この経路では、ネイティブ側 (Rust) の機能は動かない: API キーのキーチェーン保存、MIDI のネイティブ入力、
  別窓、初回セットアップ。画面側は `isDesktop()` で見分けて、ブラウザで出来る範囲に切り替える

## ビルド

`npm run tauri build` (または `npm run tauri dev`) の前に、`scripts/prepare-desktop.mjs` が自動で走る。

- `uv` のバイナリを取得して `src-tauri/binaries/` に置く (ハッシュが合わなければ中止する)
- `backend/` の `.py` と `pyproject.toml` / `uv.lock` を `src-tauri/runtime/` に並べ直す

どちらも生成物で、コミットしない。

署名は ad-hoc (`signingIdentity: "-"`) で、Apple Developer ID での署名と公証はしていない。
ad-hoc 署名は、同梱物を含めてバンドルの封印を整えるためのもの。配布するときに Developer ID で
署名・公証する場合は、`tauri.conf.json` の `signingIdentity` を差し替える
(`Entitlements.plist` のマイクの許可は、そのまま要る)。

## MIDI キーボードの入力

mac の WebView（WKWebView）は Web MIDI API を持たない（実測で確認）。そこでデスクトップ版では、
Rust が OS の MIDI を受けて画面に渡す（`src-tauri/src/midi.rs`）。

- 画面が `midi_start` を呼ぶと、つながっている入力ポートをすべて開く。受けたメッセージは
  イベント `midi-message` で画面に送る（中身はバイト列 `[status, data1, data2]`）
- 画面側は、Web MIDI API（開発用に Chrome で開いたとき）から来たメッセージと同じ経路で処理する。入力元の選び分けは
  `web-ui/src/lib/midi-input.ts` の `pickMidiSource()`
- 機器の抜き差しは自動では追わない。画面の「再検出」で開き直す
- 鍵盤が無くても、仮想の MIDI ポートを使ったテストで OS の MIDI を通して確かめられる
  （`cargo test -- --ignored 仮想ポート`）

音を鳴らすのは今も画面側（Web Audio）。弾いてから鳴るまでの遅れを詰めたくなったら、
音声エンジンを Rust に移す段階で一緒に扱う。

## API キー

Claude の API キー（再現ガイドが使う）は配布物に同梱しない。利用者が設定画面で入れたキーを、
Rust が OS のキーチェーンに保存する（`src-tauri/src/secrets.rs`。サービス名はアプリの識別子）。

- 起動時、Rust がキーチェーンから読み、sidecar に環境変数 `ANTHROPIC_API_KEY` で渡す
  （すでに環境変数が在るときはそちらを使い、キーチェーンは読まない）
- 設定した直後は、画面が動いている sidecar にも API で渡す。sidecar はメモリにだけ持つ
- キーは画面にもログにも返さない。ファイルにも書かない
- 署名が ad-hoc の間は、アプリをビルドし直すたびに、キーチェーンが読み出しの許可を尋ねることがある
  （項目が、書き込んだときの署名に結び付いているため）

## 同梱していないもの

| もの | ライセンス | 無いとき |
|---|---|---|
| libfluidsynth (FluidSynth) | LGPL-2.1 | GM 音源の代わりに内蔵のシンセで鳴る |
| `MuseScore_General.sf3` (SoundFont) | MIT | 同上 |
| ffmpeg | LGPL / GPL (ビルドによる) | MP3 / MP4 の変換だけ使えない |

利用者が自分で入れれば使える (README の手順)。Finder から起動したアプリの `PATH` には
Homebrew の置き場が入っていないので、Rust 側で `/opt/homebrew/bin` などを `PATH` に足し、
`HOMEBREW_PREFIX` を渡している。

同梱しなかった理由: libfluidsynth は依存するライブラリ (glib など) ごと同梱して、LGPL の条件
(差し替えられる形での配布、ライセンス文の同梱) を満たす必要がある。SoundFont は MIT で同梱できるが、
libfluidsynth が無ければ使えない。まず「無くても動く」形で出し、同梱は需要を見て決める。

## 今回やっていないこと

- 再生・録音の Rust への移行。いまは Web Audio と `MediaRecorder` のまま（MIDI 入力の受け取りだけは Rust に在る）。
  移すときは `src-tauri/src/` に `mod audio;` を足し、`invoke_handler` にコマンドを並べる
- VST プラグインの GUI ホスト
- Windows / Linux 向けの配布物 (ブラウザで開く版と Docker を廃止したので、いまは mac でしか使えない)
- Apple Developer ID での署名・公証、自動更新
- 書き出しの保存先を選ぶダイアログ (WebView の既定の動きで `~/Downloads` に保存される)
