/**
 * bunri DAW — 使い方ガイドページ
 *
 * 文は docs/ui-terms.md の決まりに合わせる。色は styles/global.css のトークンを使う。
 */
import { Link } from 'react-router-dom';

const HELP_CSS = `
html, body { overflow: auto; height: auto; }
.help-page { font-family: var(--font-ui); background: var(--bg-primary); color: var(--text); line-height: 1.8; min-height: 100vh; }
.help-page .container { max-width:900px; margin:0 auto; padding:32px 24px 80px; }
.help-page .help-header { display:flex; align-items:center; justify-content:space-between; margin-bottom:32px; padding-bottom:16px; border-bottom:2px solid var(--border); }
.help-page .help-header h1 { font-size:24px; color:var(--accent); }
.help-page .help-nav { display:flex; gap:8px; }
.help-page .back-btn { background:var(--bg-panel); border:1px solid var(--border); color:var(--text); padding:8px 20px; border-radius:6px; font-size:13px; text-decoration:none; }
.help-page .back-btn:hover { background:var(--accent); color:var(--bg-deep); }
.help-page .toc { background:var(--bg-secondary); border:1px solid var(--border); border-radius:8px; padding:20px; margin-bottom:32px; }
.help-page .toc h3 { color:var(--accent); margin-bottom:12px; font-size:15px; }
.help-page .toc ul { list-style:none; }
.help-page .toc li { margin:6px 0; }
.help-page .toc a { color:var(--accent-hover); text-decoration:none; font-size:14px; }
.help-page .toc a:hover { text-decoration:underline; }
.help-page section { margin-bottom:40px; }
.help-page h2 { color:var(--accent); font-size:20px; margin-bottom:16px; padding-bottom:8px; border-bottom:1px solid var(--border); }
.help-page h3 { color:var(--accent-hover); font-size:16px; margin:20px 0 10px; }
.help-page p { margin-bottom:12px; color:var(--text-mid); font-size:14px; }
.help-page ul, .help-page ol { margin:12px 0; padding-left:24px; color:var(--text-mid); font-size:14px; }
.help-page li { margin:6px 0; }
.help-page strong { color:var(--text); }
.help-page code { background:var(--bg-panel); padding:2px 6px; border-radius:3px; font-size:13px; color:var(--accent); }
.help-page .kbd { display:inline-block; background:var(--bg-panel); border:1px solid var(--border); padding:2px 8px; border-radius:4px; font-size:12px; font-family:var(--font-mono); color:var(--text); }
.help-page .layout-box { background:var(--bg-secondary); border:1px solid var(--border); border-radius:8px; padding:20px; margin:16px 0; font-size:13px; color:var(--text-mid); }
`;

/**
 * 使い方ガイドページコンポーネント（/help ルート）。
 * 目次・各機能の説明・キーボードショートカット一覧をインライン CSS とともに表示する。
 * @returns ガイドページ全体の JSX 要素
 */
export default function HelpPage() {
    return (
        <div className="help-page">
            <style>{HELP_CSS}</style>
            <div className="container">
                <div className="help-header">
                    <h1>bunri DAW 使い方ガイド</h1>
                    <div className="help-nav">
                        {/* /?guide=1 で開くと、初回の案内がもう一度出る (lib/store.tsx) */}
                        <Link to="/?guide=1" className="back-btn">はじめの案内をもう一度見る</Link>
                        <Link to="/" className="back-btn">DAW に戻る</Link>
                    </div>
                </div>

                <div className="toc">
                    <h3>目次</h3>
                    <ul>
                        <li><a href="#overview">画面の構成</a></li>
                        <li><a href="#learn">曲を教材にして学ぶ（5 つの段階）</a></li>
                        <li><a href="#project">プロジェクトの保存と開く</a></li>
                        <li><a href="#quickstart">自由に作る</a></li>
                        <li><a href="#timeline">タイムライン</a></li>
                        <li><a href="#pianoroll">ピアノロール</a></li>
                        <li><a href="#synth">シンセサイザー</a></li>
                        <li><a href="#drum">ドラムマシン</a></li>
                        <li><a href="#fx">エフェクト</a></li>
                        <li><a href="#transport">トランスポート</a></li>
                        <li><a href="#tools">ツールの画面</a></li>
                        <li><a href="#shortcuts">キーボードとマウスの操作</a></li>
                    </ul>
                </div>

                <section id="overview">
                    <h2>画面の構成</h2>
                    <div className="layout-box">
                        <p><strong>ヘッダー（上部）:</strong> BPM、拍子、再生 / 停止 / 録音、メトロノーム、元に戻す（↶）/ やり直す（↷）、「保存」「開く」「▾」（新しいプロジェクト・別名で保存・最近使ったプロジェクト）「WAV 書き出し」「MIDI 書き出し」のボタン。↶ にマウスを載せると、何が戻るかが出ます。左上にプロジェクトの名前が出て、保存していない変更があると「●」が付きます</p>
                        <p><strong>進み具合（ヘッダーの下）:</strong> ① 曲を取り込む ② カルテを見る ③ パートに分ける ④ 打ち込む ⑤ 差分で直す の、どこまで済んだかが出ます。段階を押すと、その作業をする場所が開きます。「進み具合」を押すと畳めます</p>
                        <p><strong>左パネル:</strong> 3 つのタブ</p>
                        <ul>
                            <li><strong>学ぶ:</strong> 「曲とパート」「カルテ」「ガイド」「差分」の 4 つの段。曲を取り込んでから差分チェックまでの流れ</li>
                            <li><strong>音作り:</strong> 「シンセ」「ドラム」「FX」</li>
                            <li><strong>ファイル:</strong> 音声ファイルの読み込み、単音メロディ解析、録音、データの整理</li>
                        </ul>
                        <p>左パネルの右端の境目をドラッグすると、幅を変えられます。</p>
                        <p><strong>中央:</strong></p>
                        <ul>
                            <li><strong>タイムライン:</strong> トラックとクリップを並べる場所。音声ファイルをドロップして追加できます</li>
                            <li><strong>ピアノロール:</strong> ノートを置いて直す場所。ダブルクリックでノートを追加します</li>
                        </ul>
                        <p>再生中は、金色の線が再生位置を示し、見える位置まで自動でスクロールします（シークバーの横の「再生位置を追う」で止められます）。タイムラインとピアノロールの境目をドラッグすると、ピアノロールの高さを変えられます。</p>
                        <p><strong>ステータスバー（下部）:</strong> 操作の結果と、マウスを載せた部品の説明が出ます。うまくいかなかったときの理由も、ここに赤い文字で出ます</p>
                    </div>
                </section>

                <section id="learn">
                    <h2>曲を教材にして学ぶ（5 つの段階）</h2>
                    <p>好きな曲を取り込んで、その曲がどう作られているかを調べ、自分の手で再現していく使い方です。</p>
                    <ol>
                        <li><strong>① 曲を取り込む:</strong> 起動したときの「曲を取り込んで始める」か、「学ぶ」タブの「曲を取り込む」で曲のファイル（MP3・WAV・FLAC・M4A など）を選びます。音声が「原曲」のトラックに置かれ、カルテが作られます</li>
                        <li><strong>② カルテを見る:</strong> キー・コード進行・構成・ミックスの特性が出ます。まず「グリッドを確認・補正する」で、拍の位置が合っているかを確かめてください。コードや構成を押すと、その小節へ移動します。カルテの小節番号は、タイムラインとピアノロールの小節番号と同じです</li>
                        <li><strong>③ パートに分ける:</strong> 「曲とパート」の「パートに分けて採譜する」で、原曲をパート（ボーカル・ドラム・ベースなど）に分け、パートごとにノートを採譜します（数分）。採譜したノートが<strong>お手本</strong>になります。パートのトラックは、原曲と重ならないようミュートした状態で作られます</li>
                        <li><strong>④ 打ち込む:</strong> パートの「このパートを練習する」を押すと、練習画面が開き、練習のトラック（「ベースの練習」など）にお手本が水色で重なります。お手本と、そのパートの音を聴きながらノートを置きます。お手本を最初から打ち込みとして使いたいときは「お手本をノートとして取り込む」を押します</li>
                        <li><strong>⑤ 差分で直す:</strong> 「差分」の「お手本と比べる」で、打ち込みとお手本の違い（抜け、高さの違いなど）が一覧で出ます。指摘を押すと、その場所（小節とノートの高さ）へ移動します</li>
                    </ol>
                    <h3 id="practice">練習画面</h3>
                    <p>「入力 → 比べる → 直す」を 1 つの画面で回すための画面です。「このパートを練習する」か、練習のトラックの「練習画面」で開き、「← アレンジに戻る」か <span className="kbd">Esc</span> でふだんの画面に戻ります（表示の大きさやスクロールの位置は元に戻ります）。</p>
                    <ul>
                        <li><strong>構成・コード・小節の段:</strong> ピアノロールと同じ横の位置に並びます。小節の段をドラッグすると、その範囲が区間ループになります。構成の区間を押すと、その区間が区間ループになります</li>
                        <li><strong>区間ループ:</strong> 区間の終わりで頭に戻って、繰り返し鳴ります。小節の欄で決めることもできます</li>
                        <li><strong>速度:</strong> 50〜100% に遅くします。音の高さは変わりません（区間ループの中だけで効きます。最初の 1 回は、音を用意するあいだ 100% で鳴ります）</li>
                        <li><strong>聴く:</strong> パート（パートの音声）/ 自分（自分のノート）/ 両方。<strong>お手本:</strong> 見せる / 隠す。どちらもプロジェクトのミュート・ソロは変えず、元に戻す履歴にも残りません</li>
                        <li><strong>入力:</strong> マウス / MIDI ステップ（区間の頭から 1 つずつ置く）/ MIDI リアルタイム（再生しながら弾く。区間ループ中は 1 周ごとに重ねて録り、元に戻すと最後の 1 周ぶんが消えます）</li>
                        <li><strong>比べる:</strong> 区間の中のノートをお手本と比べ、ノートに色と模様を付けます（緑の縁: 合っている / 黄色の斜線: 高さが違う / 黄色の点線の縁: 位置か長さがずれている / 赤と ×: お手本にない / 赤い破線のお手本: 抜け）。右の一覧の指摘を押すと、そのノートを選んで光らせます。色の付いたノートを押すと、その指摘が出ます。ノートを変えると色は消え、「もう一度比べてください」と出ます</li>
                        <li><strong>一致:</strong> 比べた区間のお手本のうち、高さが同じで、位置が 16 分音符 2 個以内だったノートの割合です</li>
                    </ul>
                    <p>「ガイド」では、カルテの内容を「こう作れば再現できる」という手順の説明にできます（Claude の API キーが要ります）。手順の小節を押すと、その小節へ移動します。</p>
                    <p>お手本は自動で採譜したもので、原曲とぴったり同じとは限りません。耳でも確かめながら使ってください。ドラムは差分チェックの対象外です。</p>
                </section>

                <section id="project">
                    <h2>プロジェクトの保存と開く</h2>
                    <p>1 曲の作業（トラック・ノート・お手本・音声・カルテ・ガイド・差分の結果・学習の記録）を、1 つの <code>.bunri</code> ファイルに保存します。開くと、続きからそのまま始められます（解析し直したり、Claude を呼び直したりはしません）。</p>
                    <ul>
                        <li><strong>保存</strong>（<span className="kbd">⌘S</span>）: 初めての保存では保存先を選びます（はじめは「書類」の中の bunri フォルダ）。2 回目からは同じファイルに上書きします</li>
                        <li><strong>別名で保存</strong>（<span className="kbd">⌘⇧S</span>）: 別の名前・場所に保存します。以後はそのファイルが開いているプロジェクトになります</li>
                        <li><strong>開く</strong>（<span className="kbd">⌘O</span>）: 最近使ったプロジェクトから選ぶか、「ほかのファイルを選ぶ…」で .bunri を選びます。一覧の「×」は一覧から外すだけで、ファイルは消しません</li>
                        <li><strong>保存していない変更</strong>: 名前の後ろに「●」が付きます。開く・新しいプロジェクト・窓を閉じる前に「保存 / 保存しない / キャンセル」を尋ねます</li>
                        <li><strong>以前の形式</strong>: 前の版で保存したプロジェクトは、一覧に「以前の形式」と出ます。音声は保存されていないので、音声の無いクリップは上に一覧で出ます。「音声を読み込み直す」で手元のファイルを選んでください。保存すると .bunri になります（前のファイルは残ります）</li>
                        <li><strong>学習の記録</strong>: 「お手本と比べる」を押すたびに、一致率と違いの件数が残ります。「差分」に「一致 72% 前回より +8%」のように出ます。記録もプロジェクトに保存されます</li>
                        <li><strong>データの整理</strong>: 「ファイル」タブの下で、アプリのデータの置き場の使用量を見て、一時ファイルを消せます。保存したプロジェクトは音声とカルテを中に持っているので、整理しても開けます</li>
                    </ul>
                    <p>開くと、元に戻すの履歴は空になります（前のプロジェクトの操作は戻せません）。</p>
                </section>

                <section id="quickstart">
                    <h2>自由に作る</h2>
                    <p>曲を使わずに作るときは、起動したときの「自由に作る」で空のトラックを作ります。</p>
                    <h3>音声ファイルから始める</h3>
                    <ol>
                        <li>「ファイル」タブで音声ファイルを読み込むか、タイムラインにドラッグ&ドロップします</li>
                        <li>▶ か <span className="kbd">Space</span> キーで再生して確かめます</li>
                        <li>「WAV 書き出し」で、全トラックを混ぜた WAV ファイルを保存します</li>
                    </ol>
                    <h3>シンセで音を作る</h3>
                    <ol>
                        <li>タイムラインのトラック名をクリックすると、ピアノロールが開きます</li>
                        <li>ピアノロールをダブルクリックして、ノートを置きます（置いた高さの音が鳴ります）</li>
                        <li>「音作り」タブの「シンセ」で楽器か波形を選び、「シーケンスをレンダリング」を押します</li>
                    </ol>
                    <h3>ドラムを追加する</h3>
                    <ol>
                        <li>「音作り」タブの「ドラム」でパターンを選びます（8ビートなど）</li>
                        <li>「ドラム生成 → トラックに追加」を押します</li>
                    </ol>
                </section>
                <section id="timeline">
                    <h2>タイムライン</h2>
                    <ul>
                        <li><strong>クリップの追加:</strong> 音声ファイル（WAV・MP3・FLAC など）をドラッグ&ドロップするか、「ファイル」タブから読み込みます</li>
                        <li><strong>クリップの移動:</strong> クリップをドラッグします（拍の位置にそろいます）</li>
                        <li><strong>クリップのメニュー:</strong> クリップを右クリックすると「複製」「削除」が出ます（クリップを選んで <span className="kbd">Delete</span> でも削除できます）</li>
                        <li><strong>トラックの追加:</strong> 「+ トラック追加」ボタン</li>
                        <li><strong>▶（再生）:</strong> そのトラックだけを再生します</li>
                        <li><strong>M（ミュート）:</strong> そのトラックを鳴らしません</li>
                        <li><strong>S（ソロ）:</strong> そのトラックだけを鳴らします</li>
                        <li><strong>音量:</strong> トラックの見出しの下の段のつまみ（−60〜+6 dB）。ダブルクリックで 0 dB に戻ります</li>
                        <li><strong>パン:</strong> M・S の右のつまみ（左右の位置）。ダブルクリックで中央に戻ります</li>
                        <li><strong>…（メニュー）:</strong> 名前の変更、上へ移動・下へ移動、トラックの削除</li>
                    </ul>
                    <p>ミュート・ソロ・音量・パンは、再生にも「WAV 書き出し」にも同じように効きます。音量とパンはプロジェクトに保存されます。</p>
                    <p>トラックやクリップを削除すると、画面の下に「元に戻す」付きの知らせが出ます。間違えて消したときは、そこか <span className="kbd">⌘Z</span>（<span className="kbd">Ctrl+Z</span>）で戻せます。</p>
                </section>

                <section id="pianoroll">
                    <h2>ピアノロール</h2>
                    <ul>
                        <li><strong>ノートの追加:</strong> ダブルクリック（4 分音符の位置にそろいます）。置いた高さの音が鳴ります</li>
                        <li><strong>ノートの移動:</strong> ドラッグ。横に動かすと位置が、縦に動かすと音の高さが変わります</li>
                        <li><strong>ノートの長さの変更:</strong> 右端をドラッグ</li>
                        <li><strong>ノートの削除:</strong> ノートをクリックして選び、<span className="kbd">Delete</span> か <span className="kbd">Backspace</span> キー</li>
                        <li><strong>まとめて選ぶ:</strong> 何も無いところからドラッグして囲む、<span className="kbd">Shift</span> を押しながらクリックで足す・外す、<span className="kbd">⌘A</span> で全部。選んだノートは、まとめて動かす・消すことができます</li>
                        <li><strong>矢印キー:</strong> 選んだノートを、<span className="kbd">←</span> <span className="kbd">→</span> でグリッドの刻み（1 拍）、<span className="kbd">↑</span> <span className="kbd">↓</span> で半音、<span className="kbd">Shift</span> + <span className="kbd">↑</span> <span className="kbd">↓</span> で 1 オクターブ動かします</li>
                        <li><strong>コピーと貼り付け:</strong> <span className="kbd">⌘C</span> でコピー、<span className="kbd">⌘X</span> で切り取り、<span className="kbd">⌘V</span> で再生位置に貼り付け、<span className="kbd">⌘D</span> で選んだノートのすぐ後ろに複製します。別のトラックにも貼り付けられます</li>
                        <li><strong>表示の大きさ:</strong> 見出しの「横」「縦」の − / ＋。<span className="kbd">⌘</span> を押しながらホイール（トラックパッドならピンチ）でも横の大きさが変わります</li>
                        <li><strong>音を確かめる:</strong> 左の鍵盤を押すと、その高さの音が鳴ります</li>
                        <li><strong>トラックの切り替え:</strong> タイムラインのトラック名をクリック</li>
                    </ul>
                    <p>選んでいるノートは、白い縁取りで示されます。お手本（水色のノート）は選べません。⌘ のショートカットは、ピアノロールを一度クリックしてから使います（Windows では Ctrl）。</p>
                </section>

                <section id="synth">
                    <h2>シンセサイザー</h2>
                    <p>ピアノロールに置いたノートを、音声のクリップにします。</p>
                    <ul>
                        <li><strong>GM 音源:</strong> 楽器の音（ピアノ、ギター、ストリングスなど）</li>
                        <li><strong>カスタム波形:</strong> サイン波 / 矩形波 / のこぎり波 / 三角波 の基本の波形</li>
                        <li><strong>アタック / ディケイ / サステイン / リリース:</strong> 音の立ち上がりから消えるまでの形を決めます</li>
                    </ul>
                </section>

                <section id="drum">
                    <h2>ドラムマシン</h2>
                    <p>決まったパターンから、ドラムの音声のクリップを作ります。</p>
                    <ul>
                        <li>8ビート、4つ打ち、ボサノバ、レゲエ から選べます</li>
                        <li>小節数と音量を変えられます</li>
                    </ul>
                </section>

                <section id="fx">
                    <h2>エフェクト</h2>
                    <p>トラックの最初のクリップにエフェクトをかけます。</p>
                    <ul>
                        <li><strong>EQ（3 バンド）:</strong> 低域 / 中域 / 高域 の大きさのバランスを変えます</li>
                        <li><strong>コンプレッサー:</strong> 大きい音を抑えて、音量の差を小さくします</li>
                        <li><strong>リバーブ:</strong> 響きを足します</li>
                        <li><strong>ディレイ:</strong> やまびこのように、遅れた音を重ねます</li>
                        <li><strong>ノーマライズ:</strong> 音割れしない範囲で、音量をいちばん大きくします</li>
                        <li><strong>ピッチシフト:</strong> 音の高さを上げ下げします</li>
                        <li><strong>タイムストレッチ:</strong> 音の高さを変えずに、速さを変えます</li>
                    </ul>
                </section>

                <section id="transport">
                    <h2>トランスポート</h2>
                    <ul>
                        <li><strong>▶ / ⏸:</strong> 再生 / 一時停止（<span className="kbd">Space</span> キーでも切り替えられます）</li>
                        <li><strong>■:</strong> 停止（先頭に戻ります）</li>
                        <li><strong>●:</strong> 録音（マイクの音を録ります）</li>
                        <li><strong>BPM:</strong> テンポ（20〜300）</li>
                        <li><strong>拍子:</strong> 4/4、3/4、6/8</li>
                        <li><strong>メトロノーム:</strong> 再生中に、拍に合わせてクリック音を鳴らします</li>
                    </ul>
                </section>

                <section id="tools">
                    <h2>ツールの画面</h2>
                    <p>ヘッダーの「ツール」から開きます。音声ファイルを 1 つずつ加工する道具が並んでいます。</p>
                    <ul>
                        <li><strong>パート分離と採譜:</strong> 原曲をパートに分け、パートごとにノートを採譜します</li>
                        <li><strong>パート分離:</strong> 原曲をパート（ボーカルと伴奏、または楽器ごと）に分けます</li>
                        <li><strong>解析:</strong> 帯域の分布、楽器の構成の推定、テンポの推定</li>
                        <li><strong>編集:</strong> トリム、カット、範囲コピー、無音挿入、ループ</li>
                        <li><strong>エフェクト:</strong> ファイルにエフェクトをかけます</li>
                        <li><strong>一括編集:</strong> 複数のファイルに同じ操作をかけます</li>
                        <li><strong>音源合成:</strong> 2 つの音声を重ねて 1 つにします</li>
                        <li><strong>変換:</strong> 動画や音声のファイルを WAV / MP3 にします</li>
                        <li><strong>WAV 最適化:</strong> WAV ファイルの容量を小さくします</li>
                    </ul>
                </section>

                <section id="shortcuts">
                    <h2>キーボードとマウスの操作</h2>
                    <ul>
                        <li><span className="kbd">Space</span> — 再生 / 一時停止（文字を入力する欄に居るときは効きません）。練習画面では区間の中で再生します</li>
                        <li><span className="kbd">⌘S</span> / <span className="kbd">⌘⇧S</span> / <span className="kbd">⌘O</span>（<span className="kbd">Ctrl</span> でも） — プロジェクトを保存 / 別名で保存 / 開く</li>
                        <li><span className="kbd">⌘Z</span>（<span className="kbd">Ctrl+Z</span>） — 元に戻す。ノート・トラック・クリップ・音量とパンの変更を、1 つずつ戻します（文字を入力する欄の中では、その欄の文字を戻します）</li>
                        <li><span className="kbd">⌘⇧Z</span>（<span className="kbd">Ctrl+Shift+Z</span> / <span className="kbd">Ctrl+Y</span>） — やり直す</li>
                        <li><span className="kbd">Delete</span> / <span className="kbd">Backspace</span> — 選んでいるノートを削除（クリップを選んでいるときは、そのクリップを削除）</li>
                        <li><span className="kbd">⌘A</span> / <span className="kbd">⌘C</span> / <span className="kbd">⌘X</span> / <span className="kbd">⌘V</span> / <span className="kbd">⌘D</span> — ピアノロールで、全部選ぶ / コピー / 切り取り / 再生位置に貼り付け / すぐ後ろに複製</li>
                        <li><span className="kbd">←</span> <span className="kbd">→</span> <span className="kbd">↑</span> <span className="kbd">↓</span>（ピアノロール） — 選んだノートを動かす（<span className="kbd">Shift</span> + <span className="kbd">↑</span> <span className="kbd">↓</span> で 1 オクターブ）</li>
                        <li><span className="kbd">Esc</span>（ピアノロール） — ノートの選択を外す</li>
                        <li><span className="kbd">Esc</span> — 案内やグリッドの補正の窓を閉じる。練習画面では、アレンジに戻る</li>
                        <li><span className="kbd">L</span>（練習画面） — 区間ループを入れる / 止める</li>
                        <li><span className="kbd">[</span> <span className="kbd">]</span>（練習画面） — 区間を 1 小節前 / 後ろへ動かす</li>
                        <li><strong>ドラッグ</strong>（練習画面の小節の段） — その範囲を区間ループにする</li>
                        <li><span className="kbd">←</span> <span className="kbd">→</span> — 左パネルのタブを移る（タブを選んでいるとき）。左パネルの幅を変える（右端の境目を選んでいるとき）</li>
                        <li><span className="kbd">↑</span> <span className="kbd">↓</span> — ピアノロールの高さを変える（タイムラインとの境目を選んでいるとき）</li>
                        <li><strong>ダブルクリック</strong>（ピアノロール） — ノートを追加</li>
                        <li><strong>ドラッグ</strong>（ノート） — 横で位置、縦で音の高さを変える（選んだノートはまとめて動く）</li>
                        <li><strong>ドラッグ</strong>（ピアノロールの何も無いところ） — 囲んだノートを選ぶ</li>
                        <li><strong>⌘ + ホイール</strong>（ピアノロール） — 横の表示の大きさを変える</li>
                        <li><strong>右クリック</strong>（クリップ） — メニュー（複製・削除）。<span className="kbd">Shift+F10</span> でも開きます</li>
                        <li><strong>ダブルクリック</strong>（音量・パンのつまみ） — 0 dB・中央に戻す</li>
                        <li><strong>ドラッグ&ドロップ</strong>（音声ファイル → タイムライン） — クリップを追加</li>
                    </ul>
                </section>
            </div>
        </div>
    );
}
