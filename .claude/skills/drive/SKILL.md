---
name: drive
description: bunri の本物の窓（デスクトップアプリ）を、チャットで頼まれたとおりに操作し、動きの記録を読んで何が起きたかを報告する。利用者が自分で操作した結果を、記録から追うときにも使う。
---

# bunri の窓を操作して、何が起きたかを追う

利用者が「こう操作して」「こう操作したらこうなった」と言ったときの手順。共通規約は `.claude/CLAUDE.md`、
仕組みの説明は `docs/ui-testing.md`「4. 頼まれた操作を行い、動きの記録で追う」。

アプリは、いま何が起きたかを **動きの記録** に 1 行ずつ残す（`時:分:秒.ミリ秒 [札] 文`）。
利用者は画面のステータスバーの「記録」で同じものを見ている。札は `click` `change` `key`（操作）、`status`（ステータスバーの文）、
`api`（処理を担当する部分の呼び出し）、`midi`（鍵盤の操作と置いたノート）、`midi-in`（届いた MIDI。ポートの名前つき）、
`error`、`agent`（こちらが行った操作）。

## どちらの窓か、先に決める

| 場面 | 相手 | 記録の場所 |
|---|---|---|
| 利用者が自分で触っている（鍵盤を弾く、マイク、自分のプロジェクト） | 利用者の `make desktop` | `logs/activity.log`（リポジトリ直下） |
| こちらが操作して確かめる | 切り離して起動する窓（テスト用のビルド） | 起動のたびに変わる。`drive.ts` が知っている |

利用者の `make desktop` の窓は、こちらからは操作できない（外から操作する口は、テスト用のビルドにしか入れていない）。
記録を読むことはできる。

## 利用者の操作を、記録から追う

```bash
node web-ui/e2e-desktop/drive.ts log --dev                 # 前に読んだところから先
node web-ui/e2e-desktop/drive.ts log --dev --tail 80       # 末尾の 80 行
node web-ui/e2e-desktop/drive.ts wait-log 'midi-in.*note-on' --dev --timeout 120   # その行が出るまで待つ
```

`wait-log` は、前に読んだところから先を見る（まだ一度も読んでいない記録では、いまより後に出た行だけ）。
利用者に「いまから弾いてください」と頼む前に `log --dev` で読んでおくと、そのあとの行だけを待てる。

アプリが動いていなければ、利用者に自分のターミナルで `make desktop` を起動してもらう（こちらでは起動しない）。

## こちらが操作する

1. 起動する。**サーバの起動にあたるので、頼まれたときだけ**行い、始める前に利用者へ伝える: 利用者のデータから切り離した
   別のアプリが開くこと、ポートは空いている番号を OS に選ばせるので利用者の `make desktop` とぶつからないこと。
   ```bash
   cd web-ui && npm run desktop:inspect        # 裏で動かす（run_in_background）。初回はビルドに数分
   node web-ui/e2e-desktop/drive.ts wait-ready # 窓の準備ができるまで待つ
   ```
2. 画面を見る。押せるものが、画面のことばで並ぶ。
   ```bash
   node web-ui/e2e-desktop/drive.ts ui            # 全部
   node web-ui/e2e-desktop/drive.ts ui MIDI       # 名前で絞る
   node web-ui/e2e-desktop/drive.ts shot          # 窓の画像（保存先が出るので Read で見る）
   ```
3. 1 つ操作するたびに 1 回呼ぶ。行ったことと、そのあと記録に増えた行、ステータスバーの文が返る。
   ```bash
   node web-ui/e2e-desktop/drive.ts click "MIDI 入力"
   node web-ui/e2e-desktop/drive.ts set "録り方" "ステップ入力"
   node web-ui/e2e-desktop/drive.ts key Space
   node web-ui/e2e-desktop/drive.ts wait-log 'midi-in.*note-on' --timeout 60   # 利用者が鍵盤を弾くのを待つ、など
   ```
   同じ名前が 2 つ以上あると止まるので、`--nth N` で選ぶ。
   時間のかかる操作の結果を待つときは `wait-log '<正規表現>' --since-action`（直前の操作の行から先を見る。
   付けないと、操作のコマンドがもう出した行は見ない）。
4. 終わったら必ず止める: `node web-ui/e2e-desktop/drive.ts stop`（記録の写しが `web-ui/e2e-desktop-results/activity.log` に残る）。

## できないこと

- クリックは画面の中の `element.click()`。ドラッグ、ピアノロールのキャンバスの上の細かな操作はできない
  （必要なら `drive.ts eval '<JavaScript>'`、またはブラウザの Playwright MCP + `make dev-web`）
- ファイルを選ぶ画面、マイクの許可の確認、別窓（ツール・使い方）は、テスト用のビルドでは配布物と同じには動かない
- Claude は偽のサーバを向いている。本物の API は呼ばない
- 別窓（ツール・使い方）の操作は、ファイルには残るが、メインの窓の「記録」の一覧には出ない

## 記録に載るもの・載らないもの

入力欄に打っている途中の文字、API キー、sidecar のトークン、API の中身は載らない。プロジェクト・トラック・ファイルの名前は、
結果の文として載る。記録を引用して報告するときは、そのことを踏まえる（外のサービスへ送らない）。

## 報告

何を操作したか、記録に何が出たか（該当の行を引用する）、そこから言えることと言えないことを分けて書く。
記録に出ていないことを、起きたことにしない。
