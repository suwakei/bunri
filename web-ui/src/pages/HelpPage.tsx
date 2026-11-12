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
                        <li><a href="#quickstart">クイックスタート</a></li>
                        <li><a href="#learn">原曲を手本にして学ぶ</a></li>
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
                        <p><strong>ヘッダー（上部）:</strong> BPM、拍子、再生 / 停止 / 録音、メトロノーム、「保存」「読み込む」「WAV 書き出し」「MIDI 書き出し」のボタン</p>
                        <p><strong>左パネル:</strong> シンセ / ドラム / FX / ファイル / カルテ の 5 つのタブ</p>
                        <p><strong>中央:</strong></p>
                        <ul>
                            <li><strong>タイムライン:</strong> トラックとクリップを並べる場所。WAV ファイルをドロップして追加できます</li>
                            <li><strong>ピアノロール:</strong> ノートを置いて直す場所。ダブルクリックでノートを追加します</li>
                        </ul>
                        <p>タイムラインとピアノロールの境目をドラッグすると、ピアノロールの高さを変えられます。</p>
                        <p><strong>ステータスバー（下部）:</strong> 操作の結果と、マウスを載せた部品の説明が出ます。うまくいかなかったときの理由も、ここに赤い文字で出ます</p>
                    </div>
                </section>

                <section id="quickstart">
                    <h2>クイックスタート</h2>
                    <h3>方法 1: WAV ファイルから始める</h3>
                    <ol>
                        <li>左パネルの「ファイル」タブで WAV ファイルを読み込むか、タイムラインにドラッグ&ドロップします</li>
                        <li>▶ か <span className="kbd">Space</span> キーで再生して確かめます</li>
                        <li>「WAV 書き出し」で、全トラックを混ぜた WAV ファイルを保存します</li>
                    </ol>
                    <h3>方法 2: シンセで音を作る</h3>
                    <ol>
                        <li>タイムラインのトラック名をクリックすると、ピアノロールが開きます</li>
                        <li>ピアノロールをダブルクリックして、ノートを置きます（置いた高さの音が鳴ります）</li>
                        <li>「シンセ」タブで楽器か波形を選び、「シーケンスをレンダリング」を押します</li>
                    </ol>
                    <h3>方法 3: ドラムを追加する</h3>
                    <ol>
                        <li>「ドラム」タブでパターンを選びます（8ビートなど）</li>
                        <li>「ドラム生成 → トラックに追加」を押します</li>
                    </ol>
                </section>

                <section id="learn">
                    <h2>原曲を手本にして学ぶ</h2>
                    <p>好きな曲を取り込んで、その曲がどう作られているかを調べ、自分の手で再現していく使い方です。</p>
                    <ol>
                        <li><strong>原曲を取り込む:</strong> 「ファイル」タブで曲のファイルを選び、「原曲を取り込んでカルテを作る」を押します。終わると「カルテ」タブが開きます</li>
                        <li><strong>カルテを読む:</strong> キー・コード進行・構成・ミックスの特性が出ます。まず「グリッドを確認・補正する」で、拍の位置が合っているかを確かめてください</li>
                        <li><strong>再現ガイドを作る:</strong> カルテの内容を、「こう作れば再現できる」という手順の説明にします（Claude の API キーが要ります）</li>
                        <li><strong>パートに分ける:</strong> 「ファイル」タブの「パートに分ける（パート分離）」で、原曲をパート（ボーカル・ドラム・ベースなど）に分け、パートごとにノートを採譜します。採譜したノートが<strong>お手本</strong>になります</li>
                        <li><strong>お手本を見ながら打ち込む:</strong> ピアノロールの「お手本を重ねる」で、お手本のノートを水色で薄く重ねて表示できます</li>
                        <li><strong>差分チェック:</strong> 「カルテ」タブの下の「お手本と比べる」で、打ち込みとお手本の違い（抜け、高さの違いなど）が一覧で出ます。指摘を押すと、その小節がピアノロールに出ます</li>
                    </ol>
                    <p>お手本は自動で採譜したもので、原曲とぴったり同じとは限りません。耳でも確かめながら使ってください。</p>
                </section>

                <section id="timeline">
                    <h2>タイムライン</h2>
                    <ul>
                        <li><strong>クリップの追加:</strong> WAV ファイルをドラッグ&ドロップするか、「ファイル」タブから読み込みます</li>
                        <li><strong>クリップの移動:</strong> クリップをドラッグします（拍の位置にそろいます）</li>
                        <li><strong>クリップの削除:</strong> クリップを右クリックします</li>
                        <li><strong>トラックの追加:</strong> 「+ トラック追加」ボタン</li>
                        <li><strong>▶（再生）:</strong> そのトラックだけを再生します</li>
                        <li><strong>M（ミュート）:</strong> そのトラックを鳴らしません</li>
                        <li><strong>S（ソロ）:</strong> そのトラックだけを鳴らします</li>
                        <li><strong>✕:</strong> トラックを削除します</li>
                    </ul>
                    <p>ミュートとソロは、再生にも「WAV 書き出し」にも同じように効きます。</p>
                </section>

                <section id="pianoroll">
                    <h2>ピアノロール</h2>
                    <ul>
                        <li><strong>ノートの追加:</strong> ダブルクリック（4 分音符の位置にそろいます）。置いた高さの音が鳴ります</li>
                        <li><strong>ノートの移動:</strong> ドラッグ。横に動かすと位置が、縦に動かすと音の高さが変わります</li>
                        <li><strong>ノートの長さの変更:</strong> 右端をドラッグ</li>
                        <li><strong>ノートの削除:</strong> ノートをクリックして選び、<span className="kbd">Delete</span> か <span className="kbd">Backspace</span> キー</li>
                        <li><strong>音を確かめる:</strong> 左の鍵盤を押すと、その高さの音が鳴ります</li>
                        <li><strong>トラックの切り替え:</strong> タイムラインのトラック名をクリック</li>
                    </ul>
                    <p>選んでいるノートは、白い縁取りで示されます。</p>
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
                        <li><span className="kbd">Space</span> — 再生 / 一時停止（文字を入力する欄に居るときは効きません）</li>
                        <li><span className="kbd">Delete</span> / <span className="kbd">Backspace</span> — 選んでいるノートを削除</li>
                        <li><span className="kbd">Esc</span> — 案内やグリッドの補正の窓を閉じる</li>
                        <li><span className="kbd">←</span> <span className="kbd">→</span> — 左パネルのタブを移る（タブを選んでいるとき）</li>
                        <li><span className="kbd">↑</span> <span className="kbd">↓</span> — ピアノロールの高さを変える（タイムラインとの境目を選んでいるとき）</li>
                        <li><strong>ダブルクリック</strong>（ピアノロール） — ノートを追加</li>
                        <li><strong>ドラッグ</strong>（ノート） — 横で位置、縦で音の高さを変える</li>
                        <li><strong>右クリック</strong>（クリップ） — クリップを削除</li>
                        <li><strong>ドラッグ&ドロップ</strong>（WAV ファイル → タイムライン） — クリップを追加</li>
                    </ul>
                </section>
            </div>
        </div>
    );
}
