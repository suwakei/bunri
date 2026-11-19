# 外部の楽器素材

## Salamander Grand Piano v3

- 録音・作者: Alexander Holm
- 調律版: Markus Fiedler
- SFZ の再構成: kinwie
- 出典: https://github.com/sfzinstruments/SalamanderGrandPiano
- 元の録音: https://archive.org/details/SalamanderGrandPianoV3
- ライセンス: Creative Commons Attribution 3.0 Unported（CC BY 3.0）
  https://creativecommons.org/licenses/by/3.0/
- 使用版: `3382bf9496bba2486f5ab0de55a264d1dfc38404`

素材そのものはアプリに同梱せず、利用者がダウンロードを選んだときに取得します。
配布元の SFZ・FLAC・LICENSE を変更せずに使用します。ライセンス全文は、導入した
楽器のディレクトリにある `LICENSE` に含まれています。アプリのピアノ音源の詳細にも
作者・ライセンス・出典を表示します。

## 追加の音源ライブラリ

外部素材は必要なパックを利用者が選んだときだけ取得します。固定版・容量・SHA-256・SFZ は
`backend/instrument_catalog.json` に記載し、配布元のライセンス・作者の表示も展開先に残します。

| 素材 | 作者・提供者 | ライセンス | 出典 |
|---|---|---|---|
| VSCO 2 Community Edition | Versilian Studios / Sam Gossner / Simon Dalzell、編集 Elan Hickler | CC0 1.0 | https://github.com/sgossner/VSCO-2-CE |
| Versilian Community Sample Library | Versilian Studios LLC | CC0 1.0 | https://github.com/sgossner/VCSL |
| Black And Blue Basses | Karoryfer Samples | CC0 1.0 | https://github.com/sfzinstruments/karoryfer.black-and-blue-basses |
| Black And Green Guitars | Karoryfer Samples | CC0 1.0 | https://github.com/sfzinstruments/karoryfer.black-and-green-guitars |
| Virtuosity Drums | Versilian Studios / Karoryfer Samples / Austin McMahon | CC0 1.0 | https://github.com/sfzinstruments/virtuosity_drums |
| Greg Sullivan E-Pianos | Greg Sullivan、SFZ 化 kinwie | CC BY 3.0 Unported | https://github.com/sfzinstruments/GregSullivan.E-Pianos |
| Legato Vocal Tutorial | Karoryfer Samples / Hadzi-Fia | CC0 1.0 | https://github.com/sfzinstruments/legato_vocal_tutorial |
| Meta Nylon / Steel Guitar | Meta Creative Audio | CC0 1.0 | https://github.com/facebookincubator/Meta-open-sound |

Greg Sullivan E-Pianos は、配布元の CP80・Pianet T・Wurlitzer EP200 の SFZ と録音を変更せずに使用します。
作者名・出典・ライセンスを各音色の詳細にも表示します。
ライセンス: https://creativecommons.org/licenses/by/3.0/

「コーラス・アー」は Hadzi-Fia の単独声を6層に重ねた派生 SFZ です。わずかな調律のずれ・左右の位置・
鳴らし始めを加えています。合唱団の録音ではありません。元の録音・SFZ はそのまま保持します。

VCSL のプサルテリウム3音色は、配布物内で素材が `Harpsichord, Italian` の下にあるため、
SFZ の参照先だけを合わせています。元の定義は隣の `.sfz.original` に保存し、録音は変更しません。

「16bitゲーム」の15音色は bunri が計算で作る波形で、CC0 1.0 Universal で提供します。
外部の録音素材の取得や、ゲームソフトの録音・ROM の音声の利用はありません。
CC0: https://creativecommons.org/publicdomain/zero/1.0/
