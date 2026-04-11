/**
 * bunri DAW — 使い方ガイドページ
 */
import { Link } from 'react-router-dom';

const HELP_CSS = `
.help-page { font-family: 'Outfit','Noto Sans JP',sans-serif; background: #111116; color: #e8e4de; line-height: 1.8; min-height: 100vh; }
.help-page .container { max-width:900px; margin:0 auto; padding:32px 24px 80px; }
.help-page .help-header { display:flex; align-items:center; justify-content:space-between; margin-bottom:32px; padding-bottom:16px; border-bottom:2px solid #2a2a35; }
.help-page .help-header h1 { font-size:24px; color:#d4a44c; }
.help-page .back-btn { background:#1c1c25; border:1px solid #2a2a35; color:#e8e4de; padding:8px 20px; border-radius:6px; font-size:13px; text-decoration:none; }
.help-page .back-btn:hover { background:#d4a44c; color:#fff; }
.help-page .toc { background:#17171e; border:1px solid #2a2a35; border-radius:8px; padding:20px; margin-bottom:32px; }
.help-page .toc h3 { color:#d4a44c; margin-bottom:12px; font-size:15px; }
.help-page .toc ul { list-style:none; }
.help-page .toc li { margin:6px 0; }
.help-page .toc a { color:#e8bc6a; text-decoration:none; font-size:14px; }
.help-page .toc a:hover { text-decoration:underline; }
.help-page section { margin-bottom:40px; }
.help-page h2 { color:#d4a44c; font-size:20px; margin-bottom:16px; padding-bottom:8px; border-bottom:1px solid #2a2a35; }
.help-page h3 { color:#e8bc6a; font-size:16px; margin:20px 0 10px; }
.help-page p { margin-bottom:12px; color:#9e9a92; font-size:14px; }
.help-page ul, .help-page ol { margin:12px 0; padding-left:24px; color:#9e9a92; font-size:14px; }
.help-page li { margin:6px 0; }
.help-page strong { color:#e8e4de; }
.help-page code { background:#1c1c25; padding:2px 6px; border-radius:3px; font-size:13px; color:#d4a44c; }
.help-page .kbd { display:inline-block; background:#1c1c25; border:1px solid #2a2a35; padding:2px 8px; border-radius:4px; font-size:12px; font-family:monospace; color:#e8e4de; }
.help-page .layout-box { background:#17171e; border:1px solid #2a2a35; border-radius:8px; padding:20px; margin:16px 0; font-size:13px; color:#9e9a92; }
`;

export default function HelpPage() {
    return (
        <div className="help-page">
            <style>{HELP_CSS}</style>
            <div className="container">
                <div className="help-header">
                    <h1>bunri DAW 使い方ガイド</h1>
                    <Link to="/" className="back-btn">DAWに戻る</Link>
                </div>

                <div className="toc">
                    <h3>目次</h3>
                    <ul>
                        <li><a href="#overview">画面の構成</a></li>
                        <li><a href="#quickstart">クイックスタート</a></li>
                        <li><a href="#timeline">タイムライン</a></li>
                        <li><a href="#pianoroll">ピアノロール</a></li>
                        <li><a href="#synth">シンセサイザー</a></li>
                        <li><a href="#drum">ドラムマシン</a></li>
                        <li><a href="#fx">エフェクト</a></li>
                        <li><a href="#transport">トランスポート</a></li>
                        <li><a href="#tools">ツールページ</a></li>
                        <li><a href="#shortcuts">キーボードショートカット</a></li>
                    </ul>
                </div>

                <section id="overview">
                    <h2>画面の構成</h2>
                    <div className="layout-box">
                        <p><strong>ヘッダー（上部）:</strong> BPM、拍子、再生/停止/録音、メトロノーム、保存/読込/書出ボタン</p>
                        <p><strong>左パネル:</strong> シンセ / ドラム / FX / ファイル の4タブ</p>
                        <p><strong>中央:</strong></p>
                        <ul>
                            <li><strong>タイムライン:</strong> トラックとクリップの配置エリア。WAVをD&Dで追加可能</li>
                            <li><strong>ピアノロール:</strong> ノートの配置・編集。ダブルクリックで追加</li>
                            <li><strong>オートメーション:</strong> パラメータの時間変化を曲線で描画</li>
                        </ul>
                        <p><strong>ステータスバー（下部）:</strong> 操作状況とヒント表示</p>
                    </div>
                </section>

                <section id="quickstart">
                    <h2>クイックスタート</h2>
                    <h3>方法1: WAVファイルから始める</h3>
                    <ol>
                        <li>左パネル「ファイル」タブからWAVを読み込み、またはタイムラインにD&D</li>
                        <li>▶ で再生して確認</li>
                        <li>「書出」でミックスしたWAVをダウンロード</li>
                    </ol>
                    <h3>方法2: シンセで音を作る</h3>
                    <ol>
                        <li>タイムラインのトラック名をクリック → ピアノロールが開く</li>
                        <li>ピアノロール上でダブルクリックしてノートを配置</li>
                        <li>「シンセ」タブで楽器・波形を選び「シーケンスをレンダリング」</li>
                    </ol>
                    <h3>方法3: ドラムを追加</h3>
                    <ol>
                        <li>「ドラム」タブでパターンを選択（8ビート等）</li>
                        <li>「ドラム生成 → トラックに追加」をクリック</li>
                    </ol>
                </section>

                <section id="timeline">
                    <h2>タイムライン</h2>
                    <ul>
                        <li><strong>クリップ追加:</strong> WAVファイルをドラッグ&ドロップ、またはファイルタブから追加</li>
                        <li><strong>クリップ移動:</strong> クリップをドラッグして拍単位でスナップ移動</li>
                        <li><strong>クリップ削除:</strong> 右クリックで削除</li>
                        <li><strong>トラック追加:</strong> 「+ トラック追加」ボタン</li>
                        <li><strong>M（ミュート）:</strong> そのトラックを無音にする</li>
                        <li><strong>S（ソロ）:</strong> そのトラックだけを聴く</li>
                        <li><strong>▶（再生）:</strong> そのトラックだけを再生</li>
                    </ul>
                </section>

                <section id="pianoroll">
                    <h2>ピアノロール</h2>
                    <ul>
                        <li><strong>ノート追加:</strong> ダブルクリック（4分音符グリッドにスナップ）</li>
                        <li><strong>ノート移動:</strong> ドラッグ</li>
                        <li><strong>ノート長さ変更:</strong> 右端をドラッグ</li>
                        <li><strong>ノート削除:</strong> 選択して <code>Delete</code> キー</li>
                        <li><strong>トラック切替:</strong> タイムラインのトラック名をクリック</li>
                    </ul>
                </section>

                <section id="synth">
                    <h2>シンセサイザー</h2>
                    <p>ピアノロールに配置したノートを音声にレンダリングします。</p>
                    <ul>
                        <li><strong>GM音源:</strong> リアルなサンプル音（ピアノ、ギター、ストリングス等）</li>
                        <li><strong>カスタム波形:</strong> Sine/Square/Sawtooth/Triangle の基本波形</li>
                        <li><strong>ADSR:</strong> Attack/Decay/Sustain/Release で音の立ち上がりと減衰を制御</li>
                    </ul>
                </section>

                <section id="drum">
                    <h2>ドラムマシン</h2>
                    <p>プリセットパターンからドラムトラックを自動生成します。</p>
                    <ul>
                        <li>8ビート、4つ打ち、ボサノバ、レゲエ から選択</li>
                        <li>小節数と音量を調整可能</li>
                    </ul>
                </section>

                <section id="fx">
                    <h2>エフェクト</h2>
                    <p>トラック内のクリップにエフェクトを適用します。</p>
                    <ul>
                        <li><strong>EQ（3バンド）:</strong> Low/Mid/High の音量バランスを調整</li>
                        <li><strong>コンプレッサー:</strong> 音量の大小差を圧縮して均一化</li>
                        <li><strong>リバーブ:</strong> 残響効果を追加</li>
                        <li><strong>ディレイ:</strong> やまびこ効果</li>
                        <li><strong>ピッチシフト:</strong> 音程を上下に変更</li>
                        <li><strong>タイムストレッチ:</strong> 音程を維持したまま速度変更</li>
                    </ul>
                </section>

                <section id="transport">
                    <h2>トランスポート</h2>
                    <ul>
                        <li><strong>▶ / ⏸:</strong> 再生 / 一時停止</li>
                        <li><strong>■:</strong> 停止（先頭に戻る）</li>
                        <li><strong>●:</strong> 録音（マイク入力）</li>
                        <li><strong>BPM:</strong> テンポ設定（20〜300）</li>
                        <li><strong>拍子:</strong> 4/4, 3/4, 6/8</li>
                        <li><strong>メトロノーム:</strong> 再生中にクリック音を鳴らす</li>
                    </ul>
                </section>

                <section id="tools">
                    <h2>ツールページ</h2>
                    <p>「ツール」リンクから別タブで開けます。以下の機能があります:</p>
                    <ul>
                        <li><strong>音源分離:</strong> Demucs AIによるボーカル/楽器パート分離</li>
                        <li><strong>音声解析:</strong> FFT分析、楽器推定、テンポ推定</li>
                        <li><strong>音声編集:</strong> トリム、カット、コピー、無音挿入、ループ</li>
                        <li><strong>エフェクト:</strong> ファイル単位でのエフェクト適用</li>
                        <li><strong>一括編集:</strong> 複数ファイルに同じ操作を適用</li>
                        <li><strong>音源合成:</strong> 2つの音源を重ねてミックス</li>
                        <li><strong>変換:</strong> MP4→WAV/MP3 フォーマット変換</li>
                    </ul>
                </section>

                <section id="shortcuts">
                    <h2>キーボードショートカット</h2>
                    <ul>
                        <li><span className="kbd">Delete</span> — 選択中のノートを削除</li>
                        <li><strong>ダブルクリック</strong>（ピアノロール上） — ノート追加</li>
                        <li><strong>ダブルクリック</strong>（オートメーション上） — ポイント追加</li>
                        <li><strong>右クリック</strong>（クリップ上） — クリップ削除</li>
                        <li><strong>右クリック</strong>（オートメーション上） — ポイント削除</li>
                        <li><strong>ドラッグ&ドロップ</strong>（WAVファイル → タイムライン） — クリップ追加</li>
                    </ul>
                </section>
            </div>
        </div>
    );
}
