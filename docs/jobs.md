# 時間のかかる処理（ジョブ）

音源分離・分解・カルテ・採譜は、CPU で数秒〜数分かかる。これらを「ジョブ」として裏で動かし、
画面がどのステージまで進んだかを出せて、途中でやめられるようにする仕組みをまとめる。

- 仕組みの本体: `backend/background_jobs.py`（FastAPI に依存しない）
- HTTP との橋渡し: `backend/web/job_routes.py`
- Demucs の子プロセスとのやり取り: `backend/demucs_progress.py`

画面はまだこの API を使っていない（従来の「終わるまで待つ」呼び方のまま）。画面の移行は別の変更で行う。

## API の約束

### 始める

時間のかかる API に、クエリ `?async=1` を付けて呼ぶ。フォームの中身は今までと同じ。

```
POST /api/decompose?async=1      (multipart: file, bpm, sensitivity)
→ 202  ジョブの状態（下の「ジョブの状態」）
```

`?async=1` を付けなければ、今までどおり終わるまで待って結果を返す（応答の形も失敗の返し方も同じ）。

| 応答 | 意味 |
|---|---|
| 202 | 始まった。本文はジョブの状態。`id` を控える |
| 409 | ほかのジョブが動いている。本文は `{"detail": 文, "code": "job_busy", "job": 動いているジョブの状態}` |
| 400 / 404 など | 入力の誤り（ファイル名が不正、カルテが無い、など）。ジョブは作られない。本文は従来どおり `{"detail": 文}` |
| 401 | トークンが無い（ほかの API と同じ） |

### 状態を聞く

```
GET /api/jobs/{id}
→ 200  ジョブの状態
→ 404  ジョブが無い（終わってから時間が経って、記録が消えた場合も）
```

0.5〜1 秒おきに聞く。`state` が `done` / `error` / `cancelled` になったら終わり。

### ジョブの状態

```ts
type Job<T> = {
  id: string;
  kind: 'separate' | 'deep_separate' | 'decompose' | 'chart' | 'chart_regrid' | 'analyze';
  title: string;            // 処理の名前（例: "音源の分解"）。そのまま見せてよい
  filename: string | null;  // 対象のファイル名（chart_regrid はカルテの ID）
  state: 'queued' | 'running' | 'done' | 'error' | 'cancelled';
  cancel_requested: boolean; // キャンセルを頼まれたが、まだ止まっていない間 true（止まったあとも true のまま）
  stage: string | null;      // いまのステージの表示名（例: "音源を分離しています"）。そのまま見せてよい
  stage_key: string | null;  // ステージの識別子（例: "separate"）
  stage_index: number | null; // 何番目のステージか（0 始まり）。表示は stage_index + 1
  stage_count: number;        // ステージの総数
  progress: number | null;    // いまのステージの中での進み具合（0〜1）。分からないときは null
  elapsed_sec: number;        // 走り始めてからの秒数。終わると止まる
  error: { status: number; detail: string } | null; // state が error のときだけ値が入る
  result: T | null;           // state が done のときだけ値が入る。同じ API を待つ呼び方で呼んだときの本文と同じ
};
```

- `progress` は**いまのステージの中での**割合で、全体の割合ではない。`null` のときは、長さの分からないバーを出す。
  時間から割合を見積もることはしていない（下の表で「数字が出る」としたステージ以外は、常に `null`）
- `stage` と `stage_index` は、走り始めた直後の一瞬だけ `null` のことがある
- `stage_index` は飛ぶことがある（たとえば「その他」のパートが無音なら、再分離のステージは通らない）。戻ることは無い
- `error` は、待つ呼び方が返す失敗と同じ。`status` が HTTP の状態コード、`detail` が利用者に見せる理由
- 失敗・キャンセルのあとも、`stage` には止まった時点のステージが残る

状態の移り方:

```
queued ──► running ──► done
              │   ├──► error
              │   └──► cancelled      （キャンセルを頼まれ、実際に止まった）
              └ cancel_requested: true のまま running が続くことがある（止められない処理の最中）
```

### やめる

```
POST /api/jobs/{id}/cancel
→ 200  ジョブの状態（result は入らない）
→ 404  ジョブが無い
```

- 頼むだけで、すぐ止まるとは限らない。応答が `state: "running"` かつ `cancel_requested: true` なら、
  止まるのを待っているところ。画面は「キャンセル中」と出し、状態を聞き続ける
- 何度呼んでもよい。すでに終わっているジョブには何もしない（その状態が返る）
- キャンセルを頼んだジョブは、そのあと成功しても失敗しても `cancelled` で終わる（結果は捨てる）。
  頼んだ時点ですでに終わっていた場合だけ、`done` / `error` のまま

### 動いているジョブを見つける

```
GET /api/jobs
→ 200  {"active": 動いているジョブの状態 | null, "jobs": [記録に在るジョブの状態（新しい順）]}
```

画面を開き直したときに、動いているジョブにつなぎ直すための API。こちらの状態には `result` のキーが無い
（結果は大きいことがある）。結果は `GET /api/jobs/{id}` で取る。

終わったジョブの記録は、メモリに 30 分・10 件まで残る。それを過ぎると 404 になる
（出力ファイルは `results/` に残るが、結果の本文は取り直せない）。サーバを再起動すると、記録はすべて消える。

## 対象の処理とステージ

| API | `kind` | ステージ（`stage_key`） | 数字が出るステージ |
|---|---|---|---|
| `/api/separate` | `separate` | `model` → `separate` | `separate` |
| `/api/deep-separate` | `deep_separate` | `model` → `separate` → `separate_other`（`depth=0` なら無し） | `separate` `separate_other` |
| `/api/decompose` | `decompose` | `tempo`（BPM 指定なら無し）→ `model` → `separate` → `separate_other` → `transcribe` | `separate` `separate_other` `transcribe` |
| `/api/chart` `/api/chart/regrid` | `chart` `chart_regrid` | `grid` → `key` → `chords` → `sections` → `mix` → `save` | 無し |
| `/api/analyze` | `analyze` | `transcribe` | 無し |

- **`separate` / `separate_other`**: Demucs が処理した区間の数（1 区間は音声 5 秒強）。本物の進み具合
- **`transcribe`（分解）**: 済んだパートの数 ÷ パートの総数。表示名にも「2/7: ベース」のように入る。
  1 つのパートの途中の進み具合は取れない
- **`model`**: モデルを用意している間。モデルが手元に無い（初回）ときは、表示名が
  「モデルをダウンロードしています（初回のみ）」になる。**ダウンロードの量（何 MB 中の何 MB）は出していない**。
  Demucs が使うダウンロードの仕組み（HuggingFace hub / Xet）は合計の量を確かな形で渡してこないため、
  表示名だけにした
- ほかのステージ（テンポ・カルテの各解析・採譜）は、表示名だけ

## 重い処理は同時に 1 つ

CPU 前提・低スペック PC 向けなので、ジョブは 1 つずつしか動かさない（動かすスレッドが 1 本だけ）。

- **`?async=1` の開始は、ほかのジョブが動いていれば 409 で断る**（順番待ちにはしない）。
  何が動いているかを `job` で返すので、画面は「〇〇を実行中です」と出して、キャンセルを選ばせられる。
  二重に押してしまった場合も、2 つ目は 409 になる。断るときは、アップロードも保存しない
- 待つ呼び方（`?async=1` 無し）は、今までどおり断らない。動いているものが終わるのを待ってから動く。
  画面がまだこの呼び方を使っているため、挙動を変えていない
- キャンセルを頼んだだけでは枠は空かない。実際に止まるまで、次の開始は 409 になる

待つ呼び方も、中では同じジョブとして動く。そのため、この呼び方で始めた処理も `/api/jobs` に出てきて、
キャンセルできる（キャンセルされた呼び出しは 409 `処理はキャンセルされました` で返る）。
以前は処理の間 API サーバ全体が止まっていたが、処理が別スレッドになったので、その間もほかの API は応える。

## キャンセルで止まるもの・止まらないもの

| 処理 | 止まり方 |
|---|---|
| Demucs（`model` `separate` `separate_other`） | 子プロセスを kill する。1 秒以内に止まる（手元の計測で 0.1 秒）。終了を頼んで 2 秒待っても終わらなければ強制終了する |
| モデルのダウンロード | 上と同じ（子プロセスの中で動いている）。途中まで落としたファイルの扱いはライブラリ任せで、こちらでは消さない |
| 分解の `transcribe` | パートとパートの間で止まる。**1 つのパートを音符にしている最中は止められない**（長い曲だと数十秒かかることがある） |
| 分解の `tempo`、カルテの各ステージ | **ステージの途中では止められない**。次のステージに入るところで止まる（それぞれ数秒） |
| `/api/analyze` | **止められない**（切れ目が無い）。最後まで走ってから `cancelled` になり、結果は捨てる |
| カルテの `save` | 保存を始めたあとは取り消さない。再計算（`chart_regrid`）は、`save` より前にやめれば元のカルテがそのまま残る |

止められないのは、Python の中で動いている処理（librosa / basic-pitch）をスレッドの外から止める手段が無いため。
その間は `state: "running"`・`cancel_requested: true` のままで、CPU も使い続ける。

失敗またはキャンセルで終わったジョブは、**そのジョブが書いた出力**を消す:
Demucs の出力ディレクトリ（`results/separated/…`）、`results/` 直下に置いたステム、新しく作ったカルテ。
前回の成功で出来たファイルのうち、今回まだ書き直していないものは消さない。アップロードされた元ファイル
（`uploads/`）は残す。

## サーバが終わるとき

動いているジョブと、その子プロセスを残さない。

- sidecar が親（アプリ）を失ったとき: `run_web` が、プロセスグループを終わらせる前にジョブを止め、
  書きかけの出力を消す（待つのは 1.5 秒まで）
- 通常の終了（開発用の起動を Ctrl+C で止めたとき）: `atexit` で同じことをする
- API サーバが強制終了されたとき: Demucs の子プロセスは、標準入力のパイプが閉じたことで親が居なくなったと
  知り、自分で終わる（sidecar とアプリの間と同じ仕組み）。この場合、書きかけの出力は残る

## 時間のかかる API を足すとき

1. 処理の関数に `job=None` を足し、ステージの切れ目で `job.enter_stage(キー)` を呼ぶ
   （キャンセルの確認も兼ねる）。進み具合が本当に分かるところでだけ `job.set_progress(0〜1)` を呼ぶ
2. 書き始める直前に `job.remove_on_abort(パス)` で出力を登録する
3. 子プロセスは `job.run_process(cmd)` で動かす（キャンセルで kill される）
4. API では、処理を `task(job, prepared)` にまとめて `job_routes.dispatch(...)` に渡す。
   アップロードの保存や入力の確認は `prepare` に入れる

## 暫定の決めごと

- 2 つ目を断る（順番待ちにしない）。順番待ちが欲しくなったら、`JobManager.submit(queue=True)` がすでに在る
- 記録を残す時間（30 分）と件数（10 件）
- 状態は聞きに来てもらう（ポーリング）。押し出し（SSE / WebSocket）にはしていない
- Demucs の進み具合は、Demucs の内部の 2 箇所（`demucs.separate.Separator` と `demucs.apply.tqdm`）に
  手を入れて取っている。Demucs の版が変わって見つからなくなったら、分離は動き、進み具合だけ出なくなる
  （`test_demucs_progress.py` が気づく）
