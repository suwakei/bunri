# デスクトップ版の構成

bunri のデスクトップ版が、どういう部品で出来ていて、なぜその形なのかをまとめる。
コードを触る人が、変えてよいところと変えてはいけない約束ごとを見分けられるようにするための文書。

## 全体像

```
bunri.app (Tauri v2)
├─ WebView: web-ui (React) をアプリに同梱して表示
│     ├─ HTTP ──► Python sidecar (FastAPI。127.0.0.1 の空きポート)
│     └─ Tauri command ──► Rust (接続先とトークンを受け取る / 起動の進み具合を聞く / 再生を頼む)
├─ Rust (src-tauri/): 窓の生成、初回セットアップ、sidecar の起動・監視・終了、
│                     プロジェクトのファイルの保存・開く (ダイアログ)、閉じる前の確かめ、
│                     音の再生 (audio-engine/ の engine を cpal で鳴らす)
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
   sidecar が待ち受けを始めるまで待つ。その間 `boot_status` を 0.5 秒おきに聞いて進み具合を表示する。
   起動できなかったときは理由と「再試行」を出す（押すと下の `restart_backend` で起動し直す）
5. **起動したあと**: 画面は sidecar が止まっていないかを見張る（下の「sidecar が止まったとき」）

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
  画面側は `backendUrl()` を通す。uvicorn のアクセスログは URL をそのまま出すので、`run_web.py` がログの
  `token=` の値を `***` に伏せる（`RedactTokenFilter`）
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

### sidecar が止まったとき

起動したあとに sidecar が落ちる (メモリ不足、ライブラリの異常終了など) と、画面の操作は黙って失敗し続ける。
そこで画面が見張り、利用者が起動し直せるようにする。

- **見張り** (`web-ui/src/lib/health.ts`): 5 秒おき (画面が隠れている間は 15 秒) に `boot_status` と
  `GET /api/health` (軽い応答だけ) を聞く。API の呼び出しが届かなかったとき (`apiFetch` の失敗) は、次の回を待たずに
  すぐ確かめる。一瞬の取りこぼしで知らせないよう、応答が無ければ 0.8 秒後にもう 1 回だけ確かめる
- **知らせ** (`components/HealthBanner.tsx`): 画面の上に重ねるが、操作は止めない (モーダルにしない)。トラックやノートは
  画面の側に在るので、止まっている間も編集はできる。「再起動」を押すと、Rust のコマンド `restart_backend` を呼ぶ
- **起動し直し** (`src-tauri/src/sidecar.rs` の `Sidecar::restart`): 初めの起動と同じ手順 (配布物ではセットアップから) で、
  新しい sidecar を起動する。**ポートを Python 側が決める・トークンを起動ごとに作る・標準入力を握る** の約束はそのまま。
  ポートとトークンは新しくなるので、`restart_backend` は待ち受けを始めるまで待って新しい接続情報を返し、画面は
  `apiFetch` / `backendUrl` の接続先を差し替える (`restartBackend`)。動いている sidecar を起動し直すときは、前の sidecar を
  起動スレッドの中で終わらせてから起動する (標準入力を閉じ、3 秒で kill)
- **世代**: 起動し直すたびに世代を 1 つ進める。前の sidecar の起動スレッドが遅れて「終了した」と書き込んだり、
  新しい sidecar を取り上げたり (終了の後始末) しないよう、状態の書き込みと子プロセスの預け入れは、いまの世代のときだけ行う
- **ほかの窓**: ツールの画面 (別の窓) も同じ見張りを持つ。片方が起動し直したら、もう片方は `boot_status` が起動中・
  待ち受け中であることを見て、`backend_info` で新しい接続情報を受け取り直すだけにする (2 回起動し直さない)
- **ジョブ**: 起動し直すと、ジョブの記録は消える。画面は見張っていたジョブを失敗として終わらせる (docs/jobs.md)
- **開発用のブラウザ起動**: 画面からは起動し直せないので、知らせに `make dev-web` を起動し直すよう案内する。
  応答が戻れば知らせは消える
- 起動方法を決められなかった (同梱物の場所が分からない、など) ときと、アプリの終了中は、起動し直さずに理由を返す

自動では起動し直さない。落ちた原因が続いていると、起動と異常終了を繰り返すことになるため (利用者が押したときだけ)。

### アプリの中には書き込まない

署名の封印が壊れるので、`bunri.app` の中には何も書かない。書き込む先はすべてデータ置き場。

| 場所 (mac) | 中身 |
|---|---|
| `bunri.app/Contents/MacOS/uv` | 同梱した `uv` (版とハッシュは `scripts/prepare-desktop.mjs` で固定) |
| `bunri.app/Contents/Resources/runtime/` | `backend/` と `pyproject.toml` / `uv.lock` (読み取り専用) |
| `~/Library/Application Support/io.github.suwakei.bunri/runtime/` | Python 本体、venv、uv のキャッシュ、`.pyc` |
| `~/Library/Application Support/io.github.suwakei.bunri/data/` | `uploads/` `results/` `projects/` (以前の形式) `work/` (作業中のプロジェクトの写し) `soundfonts/` `models/` (追加の分離モデル) `recent-projects.json` (最近使ったプロジェクト) (`BUNRI_DATA_DIR`) |
| 利用者が選んだ場所 (既定は `~/Documents/bunri/`) | 保存したプロジェクト (`.bunri`)。書くのは Rust だけ (下の「プロジェクトのファイル」) |
| `~/.cache/huggingface/` `~/.cache/torch/` | 音源分離のモデル (ライブラリの既定の置き場のまま)。Demucs が自分で取りに行けない追加のモデルだけは、上の `data/models/` に入る (`backend/stem_models.py`) |

Python 側は、データの場所を `audio_utils.data_dir()` から引く。パスを直書きしない。
外から受け取ったファイル名は `audio_utils.safe_join()` を通す。

## プロジェクトのファイル

プロジェクト (`.bunri`。形は [song-chart-design.md](song-chart-design.md)「プロジェクトの保存」) は、利用者が選んだ場所に保存する。
ダイアログは Tauri 公式の `tauri-plugin-dialog` (`=2.8.4`、MIT/Apache-2.0) を **Rust から**出す。

### 誰がどこを読み書きするか (変えるときは両側を一緒に変える)

| 誰が | 読み書きする場所 |
|---|---|
| sidecar (Python) | データ置き場の中だけ。保存は `work/<token>.bunri` (作業用の写し) に書いて名前を返す。開くのは `work/` に置かれた写しだけ |
| Rust (`src-tauri/src/project.rs`) | 利用者が選んだ場所と `work/` の間で写す。写してよい行き先は「この起動でダイアログで選ばれた場所」と「最近使ったプロジェクトに在る場所」(これもダイアログで選ばれたものだけが入る) だけ。拡張子は `.bunri` だけ。写しの名前は 24 桁の 16 進だけ (パスの区切りを含められない) |
| 画面 (WebView) | パスを Rust に渡すだけ。ファイルの中身には触らない。ダイアログの権限 (`dialog:*`) は渡していない (`capabilities/` に足していない) |

- 保存: 画面が文書と音声を sidecar に送る → sidecar が `work/` に書く → 画面が `project_pick_save` (初めて・別名で保存のときだけ) →
  `project_commit(token, path)` → Rust が同じフォルダの別名に写してから置き換える (書きかけを利用者のファイルとして残さない)
- 開く: `project_pick_open` (ダイアログ) か `project_open_recent(path)` (一覧に在るものだけ) → Rust が `work/` に写す →
  画面が sidecar の `POST /api/project/open/{token}` を呼ぶ。古い形式の写しは sidecar が v2 に上げる (利用者のファイルはそのまま)
- 最近使ったプロジェクト: Rust がデータ置き場の `recent-projects.json` に持つ (12 件まで。外せる。無くなったファイルは `exists: false`)
- 作業用の写しは「データの整理」で消せる (開いているものは残す)。sidecar の起動では消さない

**なぜこの形か**: sidecar の API に任意のパスを受け取らせると、API の鍵を持つ画面が乗っ取られたとき (XSS など)、利用者の
どのファイルでも上書きできてしまう (`~/.zshrc` など)。パスの検査を sidecar に足しても、何が「利用者が選んだ」かを sidecar は知らない。
ダイアログを出したのは Rust なので、Rust が選ばれた場所を覚え、そこにだけ写す。sidecar は今までどおり「データ置き場の外に触らない」。
検討して捨てた案: 画面からダイアログを出してパスを sidecar に渡す (上の理由)、Rust と sidecar の間に別の鍵を作って許可したパスを
sidecar に教える (鍵と HTTP の呼び出しが Rust に増える。写すだけなら Rust で足りる)、ファイルの中身を画面経由で運ぶ (100 MB を超える)。

開発用のブラウザ起動 (Rust が無い) では、名前を尋ねてデータ置き場の `projects/` に置く (`POST /api/project/library/save`)。
一覧もそこから作る。ブラウザのテストはこの経路で、保存・開く・以前の形式・確かめを通す。

### 保存していない変更と、閉じる前の確かめ

画面が `document_state(dirty, title)` で、窓の題名 (「曲名 ● — bunri」) と保存していない変更の有無を Rust に知らせる。

- メインの窓を閉じる (`CloseRequested`) / ⌘Q (`RunEvent::ExitRequested` で `code` が無いもの) とき、変更が在れば止めて、
  イベント `close-requested` (`{quit}`) を画面に送る。画面は「保存 / 保存しない / キャンセル」を尋ね、保存か保存しないなら
  `close_confirmed(quit)` を呼ぶ。Rust は印を下ろしてから閉じる (終える)
- 判断は `DocumentState::decide_close` (Rust のテストで確かめる)。画面が何も知らせていない (起動中など) ときは止めない
- 開く・新しいプロジェクトの前の確かめは、画面だけで行う (`lib/project-actions.ts` の `confirmDiscard`)
- 開発用のブラウザ起動では、タブを閉じる前の確かめ (`beforeunload`) は付けていない (製品の形ではなく、テストの再読み込みを妨げるため)

`.bunri` をダブルクリックして開く (ファイルの関連付け) は、まだ入れていない (`tauri.conf.json` の `fileAssociations` と、起動時に渡された
パスを受けて開く仕組みが要る)。

### テスト用のビルドで

WebDriver はネイティブのダイアログ (NSSavePanel / NSOpenPanel) を操作できない。機能 `e2e` のときだけ、ダイアログを出さずに環境変数
`BUNRI_E2E_SAVE_PATH` / `BUNRI_E2E_OPEN_PATH` の場所が選ばれたことにする (`src-tauri/src/e2e.rs` の `dialog_path`)。テストは一時ディレクトリの
中を渡す。それ以外 (写してよい場所の確かめ、最近使ったプロジェクト、閉じる前の確かめ) は配布物と同じに動く。

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
  別窓、初回セットアップ、Rust の engine での再生。画面側は `isDesktop()` で見分けて、ブラウザで出来る範囲に切り替える
  (再生は Web Audio で鳴らす)
- `scripts/dev-web.mjs` で起動したときは、画面にデスクトップ版と同じ CSP を掛ける (`tauri.conf.json` から
  起動のたびに読む。`scripts/desktop-csp.mjs`)。違いは、Vite が埋め込むスクリプトの nonce、自動再読み込みの
  接続 (`ws:`)、違反の知らせ先 (`report-uri`) を足したことだけ。CSP を変えたら、ブラウザのテスト (`make e2e`) で
  違反が無いことまで確かめられる

## 窓を自動操作するテスト

本物の窓 (WKWebView) をプログラムで操作するテスト (`make e2e-desktop`、[ui-testing.md](ui-testing.md))。
mac の WKWebView には、ブラウザのような外から操作する口 (WebDriver) が無い。Tauri 公式の `tauri-driver` も
mac には対応していない。そこで、**テスト用のビルドだけ**、アプリの中で WebDriver サーバを動かす。

- 使うもの: `tauri-plugin-wdio-webdriver` (Rust のプラグイン。WebdriverIO の公式、MIT)。版は `=1.5.1` で固定
- テスト側は npm のクライアントを入れず、W3C WebDriver の HTTP の API を直接呼ぶ (`web-ui/e2e-desktop/webdriver.ts`)
- 機能 `e2e` (Cargo の feature) を付けたときだけ入る。付けるのは `web-ui/e2e-desktop/build.mjs` だけ

### 守ること (配布物に WebDriver サーバを入れない)

WebDriver サーバには認証が無い。同じ PC のプロセスなら誰でも窓を操作し、任意の JavaScript を実行できる
(= sidecar のトークンも読める)。**配布物には絶対に入れない。** 次の 4 重で止めている:

1. 依存は `optional = true` で、機能 `e2e` は `default` に入れない (`Cargo.toml`)。既定のビルドには
   プラグインのコードが入らない (`cargo tree -i tauri-plugin-wdio-webdriver` が「見つからない」になる。`make lint` で確かめる)
2. release ビルドで機能 `e2e` を付けると、`compile_error!` でビルドが止まる (`src-tauri/src/lib.rs`)。
   `tauri build` (配布物) は release なので、誤って `--features e2e` を付けても配布物はできない。
   プラグインの登録自体も `#[cfg(all(feature = "e2e", debug_assertions))]` の中にある
3. 設定ファイルからの混入を Rust のテストで止める (`lib.rs` の `配布物の設定では_webdriverの機能が有効にならない`):
   `default` に `e2e` が無い、`tauri.conf.json` の `build.features` に `e2e` が無い、窓の権限 (`capabilities/`) に
   プラグインの権限が無い (プラグインの既定の権限は空なので、足す必要も無い)
4. デスクトップの e2e のワークフロー (`.github/workflows/desktop-e2e.yml`。手で起動したときだけ走る) で、
   既定の依存にプラグインが無いことと、release + `e2e` のビルドが失敗することを確かめる。
   前者は `make lint` でも確かめる

### テスト用のビルドで変わること

機能 `e2e` のときだけ、次のように動く (`src-tauri/src/e2e.rs`)。どれも、利用者のデータに触れないためと、
テストが確かめやすくするため。

| 何が | どう変わるか | なぜ |
|---|---|---|
| 画面 | 配布物と同じく、同梱した画面を `tauri://localhost` で出す (CSP も同じ) | 本物と同じ条件で確かめるため |
| sidecar の起動 | 開発時と同じく、リポジトリの `backend/` を開発機の `uv run` で起動する (`sidecar.rs` の `for_e2e`)。CORS の許可先は `tauri://localhost` だけ | 配布物の起動方法 (アプリのデータ置き場に `uv sync`) だと、利用者のデータ置き場に触れ、毎回 torch を入れ直すことになる |
| データの置き場 | テストが環境変数 `BUNRI_DATA_DIR` で一時ディレクトリを渡す | 利用者の `uploads/` などを汚さない |
| WebView の保存領域 | 使い捨て (incognito)。localStorage は毎回空から始まる | 開発用の `tauri dev` と実行ファイル名が同じで、そのままだと保存領域を共有してしまう |
| キーチェーン | 起動時に読まない。API キーの保存・削除は、別の項目名 (`<識別子>.e2e`) に向ける | 利用者の本物のキーに触れない。テストは偽のキーを環境変数で渡す |
| 書き出したファイル | 環境変数 `BUNRI_E2E_DOWNLOAD_DIR` の場所に保存する | `~/Downloads` に書かない |
| プロジェクトの保存・開くのダイアログ | 出さずに、環境変数 `BUNRI_E2E_SAVE_PATH` / `BUNRI_E2E_OPEN_PATH` の場所を使う | WebDriver はネイティブのダイアログを操作できない。`~/Documents` に書かない |
| 再生の音 | 環境変数 `BUNRI_E2E_AUDIO_SILENT=1` のとき (テストの起動が渡す)、Rust の engine が作った音に 0 を掛けてからデバイスへ渡す。出力デバイスを開くところから位置を送るところまでは、配布物と同じに動く | テストを回している機械のスピーカーから音を出さない |
| 記録 | CSP の違反と、捕まえられなかった例外を `window.__bunriE2E` に記録する (画面の読み込みより前に入れる) | テストが、起動の途中で起きた違反まで拾えるように |
| WebView の UI の受け手 | プラグインが WKWebView の UI の受け手 (WKUIDelegate) を自分のものに差し替える | `alert()` などをテストから扱うため。代わりに、別窓 (ツール・使い方)、ファイルを選ぶ画面、マイクの許可の確認は、テスト用のビルドでは配布物と同じには動かない ([ui-testing.md](ui-testing.md) の「確かめられない範囲」) |

### 選んだ理由と、検討して捨てた案

| 候補 | 判断 |
|---|---|
| `tauri-plugin-wdio-webdriver` 1.5.1 (採用) | WebdriverIO の公式 (github.com/webdriverio/desktop-mobile)、MIT。2026-05 に公開、月に 1〜2 回の更新、crates.io で 41 万ダウンロード (直近 90 日 37 万)。127.0.0.1 だけで待ち受け、ポートは環境変数で変えられる。mac (WKWebView) に対応 |
| `@wdio/tauri-service` (npm。上のプラグインを使う WebdriverIO の仕組み) | 不採用。アプリの起動を受け持つが、環境変数 (データ置き場、偽の Claude) を渡す設定が無く、sidecar まで終わったかの確認もできない。`@wdio/cli` などを含め依存が多い |
| `webdriverio` (npm のクライアント) 9.31.9 | 不採用。試したが、200 を超える依存 (ブラウザや FTP のダウンロードなど、ここでは使わないもの) が入り、そのうち `basic-ftp` に深刻度 high の勧告が出ていた。使う API は 7 つだけなので、fetch で直接呼ぶ |
| Tauri 公式の `tauri-driver` | mac に対応していない (WKWebView の WebDriver が無い) |
| `@crabnebula/tauri-driver` | mac では有料のキーが要る |
| `tauri-webdriver-automation` + `tauri-wd` | MIT/Apache-2.0 だが、利用が少ない (約 4 千ダウンロード) |
| MCP の橋渡し (`tauri-plugin-mcp-bridge` など) | 入れていない。窓の画像と JS の実行は WebDriver で足りる (`npm run desktop:inspect`)。もう 1 つ自動操作のサーバをアプリに入れることになり、npm の MCP サーバも第三者製のため |

## ビルド

アプリは音のエンジン (`src-tauri/audio-engine`) をリンクする。エンジンが使う sfizz は submodule
(`third_party/sfizz`) で、cargo のビルドの中で cmake にかけるので、`make desktop` / `make desktop-build` /
`make e2e-desktop` には submodule と cmake が要る (`git submodule update --init --recursive`、`brew install cmake`)。

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

## 音の再生

デスクトップ版では、再生・停止・位置・区間ループ・メトロノーム・録音前のカウント・鍵盤の試聴を、
Rust の engine (`src-tauri/audio-engine`、crate `bunri-audio`) が cpal で鳴らす。画面とのつなぎは
`src-tauri/src/audio.rs` (command は `audio_` で始まる 10 個、event は `audio://position`)。
画面の側の口は `web-ui/src/lib/native-audio.ts` の 1 か所で、呼ぶのは再生エンジン (`lib/engine.ts`) だけ。
設計・決めたこと・音の決まりは [instrument-engine-design.md](instrument-engine-design.md)
(「再生を Rust に移して分かったこと」)。

変えるときは両側を一緒に変える:

- command の名前・引数 (`audio.rs` の `#[tauri::command]`) と、`native-audio.ts` の呼び出し。
  クリップの音声 (`audio_clip_put`) は、生のバイト列とヘッダで渡す (JSON にしない)
- 位置の event の中身 (`PositionEvent`)。画面は `token` が今の再生のものだけを使う
- 音声スレッド (cpal のコールバック) の中では、メモリの確保と解放・ロック・ファイルの読み書き・ログ出力をしない
- Rust の呼び出しが失敗したら、画面はそのセッションのあいだ Web Audio に切り替える。Rust の側は、
  正しくない引数を黙って直さず、エラーで返す

書き出し (WAV)・録音 (`MediaRecorder`)・音声のデコードは、画面側のまま。

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

- 録音と書き出しの Rust への移行。いまは `MediaRecorder` と Web Audio のまま（再生は Rust に移した。上の「音の再生」）
- sfizz と依存のライセンス文の同梱（配布する前に要る。[instrument-engine-design.md](instrument-engine-design.md) の「分かっていない点」）
- VST プラグインの GUI ホスト
- Windows / Linux 向けの配布物 (ブラウザで開く版と Docker を廃止したので、いまは mac でしか使えない)
- Apple Developer ID での署名・公証、自動更新
- 書き出し (WAV・MIDI) の保存先を選ぶダイアログ (プロジェクトの保存にはダイアログを入れた)。いまは `~/Downloads` に保存する (同じ名前が在れば `名前 (1).wav` のように番号を付ける)。
  保存は Rust が受けている (`src-tauri/src/windows.rs` の `on_download`)。受けなくても WKWebView は `~/Downloads` に
  保存するが、受けておくとログに残り、窓を自動操作するテストが保存先を差し替えられる
