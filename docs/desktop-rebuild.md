# bunri をデスクトップアプリ (Tauri v2 + Python sidecar) に再構築する

この文書は、再構築を実装するセッションへの作業指示。上から順に読めば着手できる。

## 目的

bunri は今「`python run_web.py` で FastAPI を立て、ブラウザで開く」ローカル Web アプリ。
これを **ダブルクリックで起動できるデスクトップアプリ** にする。ただし中身は書き直さない。
Python (AI・音声処理) / Web (画面) / Rust (ネイティブ) のハイブリッドにして、
それぞれが得意な部分だけを持つ形にする。

最終的に欲しい状態:

- mac でアプリを起動すると窓が開き、曲を読み込んで 分離 → 採譜 → ピアノロール編集 → 再生 まで
  今と同じにできる
- 利用者が Python も Node も自分で入れなくてよい
- 今のブラウザ版 (`python run_web.py` / `docker compose up`) も動き続ける
- 将来、再生・録音・MIDI 入力を Rust に移せる置き場が在る (今回は移さない)

## 着手前の注意: 作業ツリーに未コミットの作業が在る

この文書を書いた時点で、`main` の作業ツリーに **コミットされていない別の作業** が載っている
(`song_chart.py` `structure.py` `music_theory.py` `mix_profile.py` `bunri_file.py` の新規追加と、
`web/api.py` `audio_utils.py` `LeftPanel.tsx` `store.tsx` `DawPage.tsx` などの変更)。

- **捨てない・`git stash` しない・勝手にコミットしない。** まず `git status` で現物を見る
- PR 1 はファイルを `backend/` へ移すので、この作業と必ずぶつかる。
  **着手の前に、この未コミットぶんをどう扱うか (先にコミットして main に入れる / 別ブランチに退避する) を
  利用者に確認する**
- 下の「現状」は **`origin/main` を読んで書いた**。作業ツリーの現物とは数が違うので
  (API のルート数、`fetch` の箇所数、モジュールの本数)、自分で数え直す

## 決定済みの構成 (変えない。理由つき)

```
Tauri v2 アプリ
├─ WebView: web-ui (React) をアプリに同梱して表示
│     ├─ HTTP ──► Python sidecar (今の FastAPI。127.0.0.1 の空きポート)
│     └─ Tauri command ──► Rust コア
├─ Rust コア (src-tauri/): sidecar の起動・監視・終了、初回セットアップ、ポートとトークンの受け渡し
└─ Python sidecar: demucs / basic-pitch / librosa / fluidsynth / dawdreamer (今のコードのまま)
```

- **Tauri を選んだ理由**: ネイティブ側が Rust なので、後で低レイテンシの音声エンジン
  (cpal / midir) を同じ場所に書ける。Electron だとそこが C++ アドオンになる
- **Python を残す理由**: 音源分離と採譜のライブラリは Python にしか無い。ここが bunri の中身
- **Python を PyInstaller で固めない理由**: torch 込みで数 GB になる。代わりに
  **`uv` のバイナリだけを同梱し、初回起動時に依存をアプリのデータ置き場へ入れる**
- **画面を FastAPI から配らず Tauri に同梱する理由**: Python がまだ入っていない初回起動時に、
  セットアップの進捗画面を出す必要があるため

検討して捨てた案: Electron (上記) / pywebview (Rust の置き場が無い) /
純 Rust や JUCE での書き直し (demucs と basic-pitch を失う)。

## 現状 (`origin/main` を読んで確かめたこと)

- ルート直下に Python モジュールが約 20 本フラットに並び、`from audio_utils import save_tmp`
  のように相互に import している。API は `web/api.py` (約 30 ルート)
- 画面は `web-ui/` (React 19 + Vite 8 + TypeScript)。ビルド先は `web/static/dist/`
- 画面からの API 呼び出しは **相対パス** (`/api/...` `/download`) で、6 ファイルに約 40 箇所
  (`LeftPanel.tsx` と `ToolsPage.tsx` に集中)。開発時は Vite の proxy で 8000 番に流している
- 再生は `web-ui/src/lib/engine.ts` の Web Audio、録音は `getUserMedia` + `MediaRecorder`
- `web/api.py` は `ROOT / "uploads"` `ROOT / "results"` をソースの隣に作る。`projects/` も同様
- `_save_upload` は `UPLOAD_DIR / upload.filename` と、受け取ったファイル名をそのまま繋いでいる
- 依存は `requirements.txt` (版の固定なし)。`pyproject.toml` には依存が書かれていない
- `pyfluidsynth` は OS 側の libfluidsynth が要る。`soundfonts/MuseScore_General.sf3` は
  gitignore 対象でリポジトリに無い
- `results/` は `.gitignore` に在るのに WAV 12 本 (約 360MB) が追跡されている
- `.claude/CLAUDE.md` は画面を「HTML/CSS/JS」と書いていて古い。`recorder.py` の docstring は
  Gradio 前提のまま
- CI (`.github/workflows/ci.yml`) は `test_api.py` と `test_decompose.py` を除外して回している

## 最初に確かめること (ここが崩れると設計が変わる)

実装に入る前に、最小の Tauri アプリで次の 2 つを確かめ、結果を報告してから進める。

1. **mac の WebView から sidecar へ fetch が通るか。** 画面の origin は `tauri://localhost`、
   相手は `http://127.0.0.1:<port>`。JSON の POST、ファイルのアップロード、WAV の取得
   (`engine.ts` が `fetch(url)` で音声を読む) の 3 つを試す。
   通らない場合は、Rust 側でローカルの代理を立てるか `tauri-plugin-http` を使う案に切り替え、
   どちらにしたかと理由を報告する
2. **依存が `uv` で mac arm64 に入るか。** `requirements.txt` を `pyproject.toml` へ移して
   `uv lock` → `uv sync` し、`basic-pitch` と `dawdreamer` が import できるところまで見る。
   入らないものがあれば、そこで止めて報告する (勝手に機能を落とさない)

Tauri v2 の設定キーや plugin の API は記憶に頼らず、現行のドキュメントを引いて確かめること。

## やること (この順で、PR を分ける)

### PR 1: 下ごしらえ (デスクトップ化と無関係に正しい修正)

- Python モジュールを `backend/` へ `git mv` する。**モジュール名も import 文も変えない**
  (フラットな構成のまま、置き場だけ移す)。同梱するとき 1 ディレクトリを指せば済むようにするため
- `results/` の WAV を `git rm --cached` で追跡から外す。**履歴の書き換えはしない**
  (force push が要るので、やるかどうかを利用者に確認する)
- 依存を `pyproject.toml` へ移し、`uv.lock` をコミットする。`requirements.txt` は
  Docker が使っているなら生成物として残すか、Dockerfile を `uv` に寄せる
- データ置き場 (`uploads/` `results/` `projects/` `soundfonts/`) を 1 つの関数から引くようにし、
  環境変数 `BUNRI_DATA_DIR` で差し替えられるようにする。無指定なら今と同じ場所
- アップロードとダウンロードのファイル名を検証する。解決後のパスがデータ置き場の外に出たら拒否
- 既存のテスト・lint・`python run_web.py` が通ることを確かめる

### PR 2: Tauri の殻と sidecar (開発モードで動くところまで)

- `src-tauri/` を足す。`web-ui` を表示する窓を 1 つ
- **ポートは Python 側が決める。** `--port 0` で待ち受け、決まったポートを標準出力に 1 行の
  JSON で出し、Rust がそれを読む (Rust が空きポートを選んで渡すと、起動までの間に取られる)
- **API に鍵をかける。** Rust が起動ごとに乱数のトークンを作って sidecar に渡し、
  画面は全リクエストのヘッダにそれを付ける。トークン無しは 401。127.0.0.1 で待っていても、
  同じ PC のブラウザで開いた別サイトから叩けるため。CORS はアプリの origin だけ許す。
  ブラウザ版 (トークンを渡されずに起動したとき) は今と同じ挙動にする
- **sidecar を孤児にしない。** アプリ終了時に止める。アプリが異常終了しても残らないよう、
  Python 側でも親が居なくなったら自分で終わる
- 画面側の API 呼び出しを 1 つの薄い関数に通し、接続先とトークンをそこで付ける。
  すべての `fetch` を置き換える。**ブラウザ版では接続先が空文字 (相対パス) になり、
  今と同じに動くこと**
- 録音が動くよう、マイクの使用目的 (`NSMicrophoneUsageDescription`) を設定する
- この段階の sidecar は、開発機の `uv run` で起動してよい

### PR 3: 初回セットアップと配布物

- `uv` のバイナリを Tauri の sidecar として同梱し、`backend/` と `uv.lock` をリソースとして同梱する
- 初回起動時、アプリのデータ置き場に Python 環境を作る (`uv sync --frozen` 相当)。
  **進捗が見える画面**を出し、途中で落ちても次回の起動で続きから入る
- SoundFont の入手と libfluidsynth の扱いを決める (同梱するか、初回に取得するか、
  無ければ GM 音源だけ無効にして他は動かすか)。**決める前に案とライセンスを利用者に出す**
- demucs / basic-pitch のモデルは初回利用時に落ちてくる。その待ち時間が画面から分かるようにする
- `npm run tauri build` で mac 向けの `.app` / `.dmg` が出るところまで。
  **署名と公証はやらない** (Apple Developer の契約が要るので利用者がやる)。
  未署名で開く手順を README に書く

### 最後に

- `.claude/CLAUDE.md` と README (英日) を新しい構成に合わせる。起動方法は
  デスクトップ版 / ブラウザ版 / Docker の 3 通りを書く
- CI に `src-tauri` の `cargo fmt --check` と `cargo clippy` を足す
- この文書は、3 本の PR が入ったら役目を終える。残す内容 (構成と理由) は
  `docs/daw-features.md` か新しい設計文書へ移し、この文書は消す

## やらないこと

- 再生・録音・MIDI 入力の Rust への移行 (次の段階。ただし `src-tauri` 内に
  音声エンジンを足せる構成にはしておく)
- VST プラグインの GUI ホスト
- Python の処理ロジックの書き換え、UI のデザイン変更
- Windows / Linux 向けのデスクトップ配布物 (ブラウザ版と Docker が動けばよい。
  ただし mac でしか動かないコードを共有部分に入れない)
- 署名・公証・自動更新

## 終わったと言える条件

各 PR で、該当するものを実際に動かして確かめる。動かせなかったものは「未確認」と書く。

1. `npm run tauri dev` で窓が開き、音声ファイルを読み込んで 分離 → ピアノロール表示 → 再生 →
   WAV 書き出し が通る
2. マイク録音が窓の中で動く
3. アプリを終了したあと、Python のプロセスが残っていない (`ps` で確かめる)。
   アプリを強制終了した場合も同じ
4. トークン無しで sidecar の API を `curl` すると 401 が返る
5. `../` を含むファイル名のアップロードが拒否される
6. `python run_web.py` と `docker compose up` が今までどおり動く
7. `make test` と `make lint` が通る。CI で除外されている `test_api.py` は手元で回し、
   結果を報告する
8. (PR 3) Python も Node も入っていない状態を模して (PATH から外して) `.app` を起動し、
   セットアップが完走して 1 が通る

## 進め方

- ブランチを切って PR を `main` に出す。3 本を 1 本にまとめない
- 「最初に確かめること」の 2 つが済んだ時点と、各 PR を出した時点で止まって報告する
- 報告には、確かめたこと・確かめられなかったこと・利用者の判断が要ることを分けて書く
- コメントと docstring は日本語 (リポジトリの規約どおり)
- 次の操作は必ず先に利用者へ確認する: force push、履歴の書き換え、依存の削除や機能の無効化、
  ライセンスが絡む同梱物の追加
