---
title: "ブラウザDAWから「音声→ピアノロール変換OSS」へのピボット"
emoji: "🎹"
type: "tech"
topics: ["Python", "React", "音声処理", "OSS", "Ollama"]
published: false
---

# ブラウザDAWから「音声→ピアノロール変換OSS」へのピボット

## はじめに

bunri は、楽曲ファイルをアップロードすると楽器パートごとに分離し、各パートの音符をピアノロール上に自動配置するオープンソースツールです。

当初は「ブラウザで動く軽量DAW」として開発を始めましたが、途中で方向性を転換しました。この記事では、なぜピボットしたのか、技術的にどう実装したのかを書きます。

GitHub: https://github.com/[YOUR_USERNAME]/bunri

---

## 1. なぜピボットしたのか

### DAWとしての限界

ブラウザDAWとして見ると、REAPER、Ableton、BandLab といった既存製品に機能面で勝てません。VST非対応、オーディオドライバ直接操作不可、レイテンシ問題など、ブラウザの制約が大きすぎます。

### 真の差別化ポイント

一方で、「音声ファイルを解析してピアノロールに自動配置する」機能は、既存OSSにほとんどありません。

| ツール | ステム分離 | ノート転写 | ローカル | 無料 |
|---|---|---|---|---|
| Moises.ai | ○ | ✗ | ✗ | ✗ |
| RipX DAW | ○ | ○ | ○ | ✗（$200+） |
| Spleeter / UVR | ○ | ✗ | ○ | ○ |
| Basic Pitch (Spotify) | ✗ | ○ | ○ | ○（UI無し） |
| **bunri** | **○** | **○** | **○** | **○** |

bunri はこのギャップを埋めます: **分離 → 転写 → 編集 → 再レンダリングが一気通貫で、ローカル完結、無料**。

---

## 2. アーキテクチャ

```
音声ファイル（WAV/MP3/FLAC）
    │
    ▼
Demucs（htdemucs_6s）
    │
    ├─ vocals → pyin（librosa）      → 単音ノートデータ
    ├─ bass   → pyin / STFT（単音制限）→ ベースラインノートデータ
    ├─ drums  → オンセット検出        → kick/snare/hihat イベント
    ├─ guitar → STFT倍音解析（4声）   → ポリフォニックノートデータ
    ├─ piano  → STFT倍音解析（4声）   → ポリフォニックノートデータ
    └─ other  → Demucs再分離 → 上記を繰り返す
    │
    ▼
ピアノロール（React + Canvas）
    │
    ├─ 編集（ノート追加/移動/削除）
    ├─ GM音源再生（FluidSynth + MuseScore_General.sf3）
    ├─ AIアシスタント（Ollama + Gemma 3 / Claude API）
    └─ WAV書き出し
```

FastAPIバックエンドは Python で、React 19 + TypeScript のフロントエンドをビルドして同一プロセスで配信します。

---

## 3. 技術選定の詳細

### 音源分離: Demucs (Meta AI)

htdemucs_6s モデルで6ステム（ボーカル/ドラム/ベース/ギター/ピアノ/その他）に分離。CPU環境で `segment=7`, `jobs=1` に制限してメモリを節約します。

```python
# separate.py（一部）
def separate_audio(
    input_path: str,
    model: str = "htdemucs",
    segment: int = 7,   # 7秒セグメントでメモリ使用量を抑制
    jobs: int = 1,      # CPU負荷を最小化
) -> dict[str, Path]:
    ...
```

「深層分離モード」では、「other」ステムをさらにDemucsで再分離します。ストリングスやシンセパッドなど、メインの4カテゴリに収まらない音が `other_guitar`, `other_piano` 等として別れてくることがあります。

```python
# decompose.py（簡略版）
stem_paths = deep_separate(
    input_path,
    output_dir="results/separated",
    segment=7, jobs=1,
    recursive_depth=1,  # otherを1回だけ再分離
)
# => {"vocals": Path, "drums": Path, "bass": Path,
#     "guitar": Path, "piano": Path,
#     "other_guitar": Path, "other_piano": Path, ...}
```

### ピッチ検出: pyin（単音） vs STFT倍音解析（ポリ）

単音メロディ（ボーカル、ベース）には librosa の `pyin`（確率的YIN法）を使います。

```python
# analyze.py
f0, voiced_flag, voiced_prob = librosa.pyin(
    y, fmin=librosa.note_to_hz('C2'),
       fmax=librosa.note_to_hz('C7'),
    sr=sr, frame_length=2048, hop_length=512,
)
```

ポリフォニック（ギター、ピアノ）には自作のSTFT倍音解析パイプラインを使います。

```python
# decompose.py
def _find_harmonic_peaks(spectrum, freqs, midi_min, midi_max, threshold, max_peaks):
    """
    スペクトルから倍音構造を考慮してピークを検出。
    基音と倍音（2f, 3f, 4f）のエネルギーを合算して信頼度を上げる。
    """
    results = []

    for midi in range(midi_min, midi_max + 1):
        f0 = 440.0 * (2.0 ** ((midi - 69) / 12.0))
        energy = 0.0
        harmonics_found = 0

        for h in range(1, 5):  # 基音 + 3倍音
            target_freq = f0 * h
            idx = np.argmin(np.abs(freqs - target_freq))
            local_max = np.max(spectrum[max(0, idx-1):idx+2])
            weight = 1.0 / h  # 高次倍音ほど重みを下げる
            energy += local_max * weight
            if local_max > threshold * 0.5:
                harmonics_found += 1

        # 基音エネルギー閾値以上 + 倍音2つ以上確認 → 採用
        if energy > threshold and harmonics_found >= 2:
            results.append((midi, energy))
```

倍音の確認（`harmonics_found >= 2`）がポイントです。ランダムなノイズスペクトルでは基音と倍音が整数比で並ばないため、これだけで誤検出がかなり減ります。

ベースラインは `max_notes_per_frame=1` で単音制限をかけています：

```python
# decompose.py
max_polyphony = 1 if "bass" in stem_name or "vocal" in stem_name else 4
stem_data["notes"] = transcribe_polyphonic(
    stem_path, bpm, sensitivity,
    max_notes_per_frame=max_polyphony,
)
```

**なぜBasic Pitchを使わなかったか:** Basic PitchはPyTorchモデルのダウンロード（15MB）と初期化コストが生じます。CPU環境で4分の楽曲を処理するときに追加の遅延になることと、依存を増やしたくなかったという判断です。精度向上のためのオプションとして今後検討しています。

### ドラム分類

ドラムステムはピッチ検出ではなく、オンセット検出 + スペクトル重心でkick/snare/hihatを分類します。

```python
# decompose.py
def _classify_drum_hit(window, sr):
    """短い音声区間からドラムの種類と強さを判定"""
    fft = np.abs(np.fft.rfft(window))
    freqs = np.fft.rfftfreq(len(window), 1 / sr)
    centroid = np.sum(freqs * fft) / np.sum(fft)

    # 重心が低い → キック、中 → スネア、高 → ハイハット
    if centroid < 200:
        return "kick", velocity
    elif centroid < 2000:
        return "snare", velocity
    else:
        return "hihat", velocity
```

簡易な分類ですが、Demucsで分離済みのドラムステムに対してはそれなりに機能します。

---

## 4. バニラJSからReact 19への移行

最初のバージョンはHTML/CSS/バニラJS + FastAPIという構成でした。`window.engine`、`window.timeline`、`window.pianoRoll` というグローバルオブジェクトを読み込み順に初期化するシンプルな設計でした。

この構成は機能が増えると問題が出てきました。

- 複数コンポーネントが同じ状態（BPM、再生位置、アクティブトラック）を参照するとき、グローバル変数の参照タイミングが難しい
- ピアノロール/タイムライン/オートメーションが互いにコールバックを呼び合う構造が複雑になる
- テストが書きにくい（グローバル依存）

React + Context APIへの移行で、状態管理が `DawProvider` に集約されました。

```tsx
// web-ui/src/lib/store.tsx（一部抜粋）
export function DawProvider({ children }: { children: ReactNode }) {
    const [bpm, setBpmState] = useState(120);
    const [isPlaying, setIsPlaying] = useState(false);
    const pianoRollRef = useRef<any>(null);

    const setBpm = useCallback((v: string | number) => {
        const val = parseInt(String(v)) || 120;
        setBpmState(val);
        engine.bpm = val;  // AudioEngineにも同期
    }, []);
    // ...
}
```

`engine`（AudioEngine）はReactの外で生きるためrefで保持し、状態変更時に手動で同期します。Web Audio APIのライフサイクルとReactのライフサイクルが衝突しないよう、このハイブリッドアプローチが現実的でした。

---

## 5. AI作曲アシスタント: Ollama + Gemma 3

`music_assistant.py` は自然言語プロンプトをピアノロール用ノートデータ（JSON）に変換します。

**設計思想:** AIが生成するのはノートデータのみ。音声は生成しません。音色はユーザーが選んだGM音源で再生されます。「AIが作曲した波形」ではなく「AIが提案したノートをユーザーが鳴らす」という関係です。

システムプロンプトでJSON出力フォーマットを厳密に指定しています：

```python
# music_assistant.py
SYSTEM_PROMPT = """You are a music composition assistant for a DAW.
OUTPUT FORMAT (strict JSON, no markdown):
{
  "notes": [
    {"note": "C", "octave": 4, "step": 0, "length": 4}
  ],
  "explanation": "Brief description in Japanese."
}
RULES:
- "step" is position in 16th notes (0 = first beat). 1 bar = 16 steps.
- "length" is duration in 16th notes (1=16th, 2=8th, 4=quarter, 16=whole)
- Output ONLY valid JSON, no markdown fences, no extra text
"""
```

ローカル/クラウドのルーティング設定：

```bash
# 環境変数で設定
OLLAMA_URL=http://localhost:11434   # デフォルト
OLLAMA_MODEL=gemma3:4b              # デフォルト（12bも可）
ANTHROPIC_API_KEY=sk-...            # オプション：クラウドフォールバック
```

フロントエンドのAssistantPanelは既存のピアノロールノートをコンテキストとして渡せるので、「このメロディを続けて」「この上にハーモニーを追加して」という指示が通ります。

```tsx
// web-ui/src/components/AssistantPanel.tsx（一部）
const contextNotes = pr?.getNotes?.() ?? [];
fd.append('context_notes', JSON.stringify(contextNotes));
```

---

## 6. テスト構成

```
test/back/
├── test_api.py             APIエンドポイントの統合テスト
├── test_audio_utils.py     ロード/保存ユーティリティ
├── test_edit.py            編集操作（トリム/カット/フェード等）
├── test_effects.py         EQ/コンプ/リバーブ/ディレイ
├── test_synth.py           シンセ/ドラムマシン
├── test_decompose.py       分離パイプライン（モック使用）
└── test_music_assistant.py LLM統合（モック使用）
```

- フロントエンド: Vitest + Testing Library（3ファイル、36テスト）
- バックエンド: pytest（12ファイル、113テスト）
- CI: GitHub Actions（ESLint → tsc → vitest → build → ruff → pytest）

---

## 7. 今後の展望

- **Basic Pitch統合:** Spotifyのモデルを組み込んでポリフォニック精度を上げる
- **MIDI書き出し:** ピアノロールのノートをMIDIファイルとして書き出す
- **Docker化:** セルフホスト用コンテナイメージ
- **リアルタイム書き起こし:** マイク入力をリアルタイムでピアノロールに変換

---

## まとめ

「ブラウザDAW」から「音声→ピアノロール変換OSS」へのピボットは、競合優位性の観点から正しい判断だったと思います。DAW機能は補助として残しつつ、コアバリューを「ローカル完結の音声転写パイプライン」に絞ることで、明確なポジショニングができました。

**Moises / RipXのローカル代替** という一言でポジションが説明できるようになったのが大きいです。

Apache-2.0 ライセンスで公開しています。フィードバック歓迎です。

GitHub: https://github.com/[YOUR_USERNAME]/bunri
