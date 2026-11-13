# bunri

あらゆる楽曲を編集可能なピアノロールに変換 — ローカル完結・プライバシー重視・オープンソース

![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)
![Python](https://img.shields.io/badge/python-3.11-blue.svg)
![Node](https://img.shields.io/badge/node-22%2B-green.svg)
![Platform](https://img.shields.io/badge/platform-CPU%20only-lightgrey.svg)

[English version](README.md)

<!-- demo.gif -->
![Demo](docs/demo.gif)

## なぜ bunri？

- **ローカル完結**: クラウド不要・サブスク不要。全てあなたのPC上で動作
- **オープンソース**: Apache-2.0。自由にフォーク・拡張・再配布
- **編集可能**: ステム分離だけでなく、MIDI的なノートデータとして編集・再配置・再レンダリング可能

## クイックスタート

bunri は macOS（Apple Silicon）のデスクトップアプリ。Python のバックエンドと機械学習のライブラリは手元の Mac で動き、その用意はアプリが自分で行う。

配布済みのバイナリはまだ無いので、自分でビルドする。

```bash
# Rust と Node.js 22 以上、インターネット接続が要る（同梱する uv をビルド時に取得する）
npm ci
npm --prefix web-ui ci
npm run tauri build
# → src-tauri/target/release/bundle/dmg/bunri_<版>_aarch64.dmg
# → src-tauri/target/release/bundle/macos/bunri.app
```

**初回の起動。** アプリには Python も機械学習のライブラリも入っていない（入れると数 GB になるため）。
初回の起動時に Python 3.11 と依存（約 1.2GB）を
`~/Library/Application Support/io.github.suwakei.bunri/` へダウンロードし、その進み具合を表示する。
数分かかる。途中で終了したり回線が切れたりしても、次回の起動で続きから入る。
2 回目以降の起動は数秒。音源分離のモデルは、初めて分離するときにダウンロードされる
（状態表示にその旨が出る）。

**未署名のアプリを開く。** このアプリは Apple Developer ID で署名されておらず、公証も受けていない。
自分でビルドしたものはそのまま開ける。他の人から `.dmg` を受け取った場合は、初回に macOS が開くのを止める。

1. 一度アプリを開く（止められる）。そのあと **システム設定 > プライバシーとセキュリティ** を開き、**このまま開く** を押す
2. または隔離の印を外す: `xattr -dr com.apple.quarantine /Applications/bunri.app`

**データの場所。** アップロード・処理結果・プロジェクトは
`~/Library/Application Support/io.github.suwakei.bunri/data/` に保存される。書き出したファイルは `~/Downloads` に保存される。

**任意で入れるもの。** 同梱していない。無くても他の機能は動く。

- GM 音源（FluidSynth）: `brew install fluid-synth` を実行し、
  [`MuseScore_General.sf3`](https://ftp.osuosl.org/pub/musescore/soundfont/MuseScore_General/)（MIT ライセンス、38MB）を
  データの場所の中の `soundfonts/`（`.../io.github.suwakei.bunri/data/soundfonts/`）に置く。
  無いときは内蔵のシンセで鳴る
- MP3 / MP4 の変換: `brew install ffmpeg`

開発するときは開発モードで起動する。初回だけ `make install` `make install-frontend` `make install-desktop`、以降は `make desktop`。

Codex で開発するときは `make harness-setup`。共通規約・スキル・担当エージェント・検証手順は [Codex ハーネスの使い方](docs/codex-harness.md) を参照。

## 仕組み

```mermaid
graph LR
    A[音声ファイル] --> B[Demucs<br/>音源分離]
    B --> C[Basic Pitch<br/>ポリフォニック転写]
    C --> D[編集可能な<br/>ピアノロール]
    D --> E[GM音源で<br/>再レンダリング]
```

## 競合比較

| 機能 | bunri | Spleeter | LALAL.AI | GarageBand |
|---|---|---|---|---|
| ローカル実行 | yes | yes | no | yes |
| 無料・オープンソース | yes | yes | no | no |
| ピアノロール編集 | yes | no | no | yes |
| ポリフォニック転写 | yes | no | no | no |
| ステム分離 | yes | yes | yes | no |
| GM音源再レンダリング | yes | no | no | yes |
| Web UI | yes | no | yes | no |

## 機能

### DAW 画面 (`/`)

| 機能 | 内容 |
|---|---|
| タイムライン | トラック上にクリップを配置。ドラッグで移動、拍単位スナップ、WAV ファイルのドラッグ&ドロップ対応 |
| ピアノロール | トラックごとに独立。C0〜B8 の範囲でノート編集（ダブルクリックで追加、横のドラッグで位置・縦のドラッグで高さの変更、Delete / Backspace で削除）。置いたノートと押した鍵盤はその高さで鳴る |
| シンセサイザー | 基本波形 4 種（Sine / Square / Sawtooth / Triangle）、簡易楽器プリセット 6 種、GM 音源（FluidSynth 経由、84 音色） |
| ドラムマシン | 4 パターン（8ビート / 4つ打ち / ボサノバ / レゲエ）、小節数・音量指定可 |
| エフェクト | EQ（3バンド）/ コンプレッサー / リバーブ / ディレイ / ノーマライズ / ピッチシフト / タイムストレッチ |
| 楽曲完全解析 | Demucs 分離 → ポリフォニックピッチ検出 → トラック自動生成 → ピアノロール自動配置 |
| 単音メロディ解析 | pyin ピッチ検出で単音 WAV をピアノロールに変換 |
| トランスポート | BPM / 拍子 / 再生・停止・録音 / メトロノーム / シークバー |
| 録音 | マイク入力からトラックに直接録音 |
| プロジェクト保存・読込 | JSON 形式で保存・復元 |
| WAV 書き出し | 全トラックをオフラインミックスダウンして WAV で書き出す（再生と同じく、ミュートとソロに従う） |
| MIDI キーボード入力 | つないだ鍵盤を弾いてピアノロールに打ち込む。ステップ入力（弾くたびに 1 つ進む）とリアルタイム録音（再生に合わせて弾く。録音前のカウントと、遅れの補正つき）。弾いた強さ（ベロシティ）もノートに残る |
| MIDI 書き出し | ピアノロールのノートを標準 MIDI ファイル（SMF）としてエクスポート。ほかの DAW や楽譜ソフトで開ける |
| MIDI 読み込み | 標準 MIDI ファイルのノートを、強さごと、新しいトラックとして、またはお手本として読み込む（位置と長さは 16 分音符に丸める） |

### ツール画面 (`/tools`)

| タブ | 内容 |
|---|---|
| 完全分解 | Demucs 6 ステム分離 → ポリフォニックピッチ検出 → 楽器推定 → JSON 出力 |
| 音源分離 | Demucs による 2/4/6 ステム分離 |
| 解析 | 周波数帯域分布、推定楽器構成、テンポ推定 |
| 編集 | トリム / カット / 範囲コピー / 無音挿入 / ループ |
| エフェクト | EQ / コンプレッサー / リバーブ / ディレイ / 音量 / フェード / パン / リバース / ピッチシフト / タイムストレッチ |
| 一括編集 | 複数ファイルに同一操作を適用 |
| 音源合成 | 2 つの WAV をオーバーレイミックス |
| 変換 | MP4/AVI/MKV 等 → WAV / MP3 変換（ffmpeg 使用） |
| WAV 最適化 | サンプルレート変換 + ビット深度変換（TPDF ディザリング）で容量削減 |

### ヘルプ画面 (`/help`)

操作ガイド、画面構成の説明、キーボードショートカット一覧を掲載。

## ロードマップ

- [x] MIDI エクスポート（ピアノロールのノートを標準 MIDI ファイルに書き出す）
- [x] MIDI キーボード入力（ステップ入力とリアルタイム録音）
- [x] MIDI インポート（新しいトラックとして、またはお手本として読み込む）
- [ ] VST プラグインサポート
- [ ] リアルタイムコラボレーション
- [ ] モバイル対応
- [ ] より多くの AI モデルへの対応

## コントリビュート

コントリビュート歓迎です！まずissueで議論してからPRを送ってください。

## ライセンス

[Apache-2.0](LICENSE)

## 詳細なDAW機能ドキュメント

[DAW機能の詳細はこちら](docs/daw-features.md)

デスクトップ版の構成は [docs/desktop-architecture.md](docs/desktop-architecture.md) を参照。
