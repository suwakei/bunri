/**
 * bunri DAW — メインアプリケーション統合
 * UI イベントとモジュール間の接続
 */

// ---- プログレスバー ----
const progressBar = document.getElementById('global-progress');

function showProgress() {
    progressBar.classList.add('active');
}

function hideProgress() {
    progressBar.classList.remove('active');
}

// ---- ステータスバー ----
function setStatus(msg) {
    document.getElementById('status-text').textContent = msg;
}

/**
 * 非同期処理をプログレスバー付きで実行する
 * @param {HTMLButtonElement} btn - 無効化するボタン
 * @param {string} processingMsg - 処理中メッセージ
 * @param {Function} fn - 実行する非同期関数
 */
async function withProgress(btn, processingMsg, fn) {
    showProgress();
    if (btn) btn.disabled = true;
    setStatus(processingMsg);
    try {
        await fn();
    } catch (e) {
        setStatus('エラー: ' + e.message);
    } finally {
        hideProgress();
        if (btn) btn.disabled = false;
    }
}

// ---- パネルタブ切替 ----
document.querySelectorAll('#panel-tabs button').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('#panel-tabs button').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.panel-content').forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById(btn.dataset.panel).classList.add('active');
    });
});

// ---- トランスポート ----
const bpmInput = document.getElementById('bpm');
const timeSigSelect = document.getElementById('time-sig');
const timeDisplay = document.getElementById('time-display');

bpmInput.addEventListener('change', () => {
    engine.bpm = parseInt(bpmInput.value) || 120;
    timeline.render();
});

timeSigSelect.addEventListener('change', () => {
    engine.beatsPerBar = parseInt(timeSigSelect.value) || 4;
    timeline.render();
});

document.getElementById('btn-play').addEventListener('click', () => {
    engine.init();
    engine.play();
    setStatus('再生中...');
});

document.getElementById('btn-stop').addEventListener('click', () => {
    engine.stop();
    setStatus('停止');
});

document.getElementById('btn-metronome').addEventListener('click', (e) => {
    engine.init();
    engine.metronomeEnabled = !engine.metronomeEnabled;
    e.target.classList.toggle('active', engine.metronomeEnabled);
    setStatus(engine.metronomeEnabled ? 'メトロノーム ON' : 'メトロノーム OFF');
});

// 再生時間表示の更新
setInterval(() => {
    const t = engine.getCurrentTime();
    const min = Math.floor(t / 60);
    const sec = (t % 60).toFixed(1);
    timeDisplay.textContent = `${min}:${sec.padStart(4, '0')}`;
}, 100);

// ---- トラック追加 ----
document.getElementById('btn-add-track').addEventListener('click', () => {
    const t = engine.addTrack();
    timeline.render();
    updateTrackSelectors();
    setStatus(`「${t.name}」を追加しました`);
});

// 初期トラック
engine.addTrack('Track 1');
engine.addTrack('Track 2');
timeline.render();

// ---- ファイルインポート ----
document.getElementById('btn-import').addEventListener('click', async () => {
    const input = document.getElementById('file-import');
    if (!input.files.length) return;

    const fileTrackSel = document.getElementById('file-track');
    let trackId = fileTrackSel.value;
    if (!trackId || !engine.tracks.find(t => t.id === trackId)) {
        if (engine.tracks.length === 0) engine.addTrack();
        trackId = engine.tracks[engine.tracks.length - 1].id;
    }
    const trackName = engine.tracks.find(t => t.id === trackId)?.name || '';
    for (const file of input.files) {
        await engine.addClipFromFile(trackId, file);
        setStatus(`${file.name} を「${trackName}」に追加しました`);
    }
    timeline.render();
    updateTrackSelectors();
});

// ---- シンセ → シーケンスレンダリング ----
document.getElementById('btn-render-seq').addEventListener('click', async () => {
    const notes = pianoRoll.getNotes();
    if (notes.length === 0) {
        setStatus('ピアノロールにノートを配置してください');
        return;
    }

    const gmProgram = document.getElementById('synth-gm').value;
    const instrument = document.getElementById('synth-instrument').value;
    const wave = document.getElementById('synth-wave').value;
    const vol = parseFloat(document.getElementById('synth-vol').value);
    const a = parseFloat(document.getElementById('synth-a').value);
    const d = parseFloat(document.getElementById('synth-d').value);
    const s = parseFloat(document.getElementById('synth-s').value);
    const r = parseFloat(document.getElementById('synth-r').value);
    const bpm = parseInt(bpmInput.value);

    const formData = new FormData();
    formData.append('notes_json', JSON.stringify(notes));
    formData.append('bpm', bpm);
    formData.append('waveform', wave);
    formData.append('volume', vol);
    formData.append('attack', a);
    formData.append('decay', d);
    formData.append('sustain', s);
    formData.append('release', r);
    formData.append('instrument', instrument);
    formData.append('gm_program', gmProgram);

    const btn = document.getElementById('btn-render-seq');
    await withProgress(btn, 'シーケンスをレンダリング中...', async () => {
        const resp = await fetch('/api/synth/sequence', { method: 'POST', body: formData });
        if (!resp.ok) throw new Error(await resp.text());
        const blob = await resp.blob();
        const arrayBuf = await blob.arrayBuffer();
        const buffer = await engine.ctx.decodeAudioData(arrayBuf);

        const synthTrackSel = document.getElementById('synth-track');
        let trackId = synthTrackSel.value;
        if (!trackId || !engine.tracks.find(t => t.id === trackId)) {
            if (engine.tracks.length === 0) engine.addTrack('Synth');
            trackId = engine.tracks[0].id;
        }
        const trackName = engine.tracks.find(t => t.id === trackId)?.name || '';
        await engine.addClipFromBuffer(trackId, buffer, 'synth-seq');
        timeline.render();
        updateTrackSelectors();
        setStatus(`シーケンスを「${trackName}」に追加しました`);
    });
});

// ---- ドラム生成 ----
document.getElementById('btn-gen-drum').addEventListener('click', async () => {
    const pattern = document.getElementById('drum-pattern').value;
    const bars = document.getElementById('drum-bars').value;
    const vol = document.getElementById('drum-vol').value;
    const bpm = bpmInput.value;

    const formData = new FormData();
    formData.append('pattern', pattern);
    formData.append('bpm', bpm);
    formData.append('bars', bars);
    formData.append('volume', vol);

    const btn = document.getElementById('btn-gen-drum');
    await withProgress(btn, 'ドラム生成中...', async () => {
        const resp = await fetch('/api/synth/drum', { method: 'POST', body: formData });
        if (!resp.ok) throw new Error(await resp.text());
        const blob = await resp.blob();
        const arrayBuf = await blob.arrayBuffer();
        const buffer = await engine.ctx.decodeAudioData(arrayBuf);

        const drumTrackSel = document.getElementById('drum-track');
        let drumTrack;
        if (drumTrackSel.value === '__new__') {
            drumTrack = engine.addTrack('Drum');
        } else {
            drumTrack = engine.tracks.find(t => t.id === drumTrackSel.value);
            if (!drumTrack) drumTrack = engine.addTrack('Drum');
        }
        await engine.addClipFromBuffer(drumTrack.id, buffer, `drum-${pattern}`);
        timeline.render();
        updateTrackSelectors();
        setStatus(`ドラムを「${drumTrack.name}」に追加しました`);
    });
});

// ---- WAV解析 → ピアノロール ----
document.getElementById('btn-analyze').addEventListener('click', async () => {
    const input = document.getElementById('analyze-file');
    if (!input.files.length) {
        setStatus('解析するWAVファイルを選択してください');
        return;
    }

    const file = input.files[0];
    const sensitivity = parseFloat(document.getElementById('analyze-sensitivity').value);
    const bpm = parseInt(bpmInput.value);

    const formData = new FormData();
    formData.append('file', file);
    formData.append('bpm', bpm);
    formData.append('sensitivity', sensitivity);

    const btn = document.getElementById('btn-analyze');
    await withProgress(btn, `音声を解析中...（${file.name}）`, async () => {
        const resp = await fetch('/api/analyze', { method: 'POST', body: formData });
        if (!resp.ok) throw new Error(await resp.text());
        const notes = await resp.json();

        if (notes.length === 0) {
            setStatus('ノートが検出されませんでした。感度を上げてみてください');
            return;
        }

        pianoRoll.setNotes(notes);
        setStatus(`${notes.length}個のノートを検出しました — ピアノロールに配置済み`);
    });
});

// ---- 録音 ----
document.getElementById('btn-mic-record').addEventListener('click', async () => {
    try {
        await engine.startRecording();
        document.getElementById('btn-mic-record').style.display = 'none';
        document.getElementById('btn-mic-stop').style.display = '';
        setStatus('録音中...');
    } catch (e) {
        setStatus('マイクにアクセスできません');
    }
});

document.getElementById('btn-mic-stop').addEventListener('click', async () => {
    const buffer = await engine.stopRecording();
    document.getElementById('btn-mic-record').style.display = '';
    document.getElementById('btn-mic-stop').style.display = 'none';

    let recTrack = engine.tracks.find(t => t.name.includes('Rec'));
    if (!recTrack) recTrack = engine.addTrack('Rec');
    await engine.addClipFromBuffer(recTrack.id, buffer, 'recording');
    timeline.render();
    updateTrackSelectors();
    setStatus('録音をトラックに追加しました');
});

// ---- 全パネルのトラック選択を更新 ----
function updateTrackSelectors() {
    const selectors = ['fx-track', 'synth-track', 'file-track'];
    for (const id of selectors) {
        const sel = document.getElementById(id);
        if (!sel) continue;
        const prev = sel.value;
        sel.innerHTML = '';
        for (const t of engine.tracks) {
            const opt = document.createElement('option');
            opt.value = t.id;
            opt.textContent = t.name;
            sel.appendChild(opt);
        }
        // 以前の選択を復元
        if (prev && [...sel.options].some(o => o.value === prev)) {
            sel.value = prev;
        }
    }
    // ドラム用は「新規作成」オプション付き
    const drumSel = document.getElementById('drum-track');
    if (drumSel) {
        const prev = drumSel.value;
        drumSel.innerHTML = '<option value="__new__">新規作成（Drum）</option>';
        for (const t of engine.tracks) {
            const opt = document.createElement('option');
            opt.value = t.id;
            opt.textContent = t.name;
            drumSel.appendChild(opt);
        }
        if (prev && [...drumSel.options].some(o => o.value === prev)) {
            drumSel.value = prev;
        }
    }
}
updateTrackSelectors();

const FX_PARAMS = {
    eq: `<label>Low (dB)</label><input type="range" id="fx-eq-low" min="-12" max="12" value="0">
         <label>Mid (dB)</label><input type="range" id="fx-eq-mid" min="-12" max="12" value="0">
         <label>High (dB)</label><input type="range" id="fx-eq-high" min="-12" max="12" value="0">`,
    compressor: `<label>Threshold (dB)</label><input type="range" id="fx-comp-thresh" min="-40" max="0" value="-20">
                 <label>Ratio</label><input type="range" id="fx-comp-ratio" min="1" max="20" step="0.5" value="4">`,
    reverb: `<label>Room Size</label><input type="range" id="fx-rv-size" min="0" max="1" step="0.05" value="0.5">
             <label>Wet</label><input type="range" id="fx-rv-wet" min="0" max="1" step="0.05" value="0.3">`,
    delay: `<label>Time (ms)</label><input type="range" id="fx-dl-ms" min="50" max="2000" step="10" value="300">
            <label>Feedback</label><input type="range" id="fx-dl-fb" min="0" max="0.9" step="0.05" value="0.4">
            <label>Wet</label><input type="range" id="fx-dl-wet" min="0" max="1" step="0.05" value="0.3">`,
    normalize: '',
    pitch_shift: `<label>半音</label><input type="range" id="fx-ps-semi" min="-12" max="12" value="0">`,
    time_stretch: `<label>速度</label><input type="range" id="fx-ts-rate" min="0.25" max="3" step="0.05" value="1">`,
};

document.getElementById('fx-type').addEventListener('change', (e) => {
    document.getElementById('fx-params').innerHTML = FX_PARAMS[e.target.value] || '';
});
document.getElementById('fx-params').innerHTML = FX_PARAMS['eq'];

// ---- 書き出し ----
document.getElementById('btn-export').addEventListener('click', async () => {
    engine.init();

    // クリップが1つもないか確認
    const totalClips = engine.tracks.reduce((sum, t) => sum + t.clips.length, 0);
    if (totalClips === 0) {
        setStatus('書き出すクリップがありません。シンセのレンダリングやWAVの追加を先に行ってください');
        return;
    }

    const btn = document.getElementById('btn-export');
    await withProgress(btn, `ミックスダウン中...（${totalClips}クリップ, ${engine.tracks.length}トラック）`, async () => {
        const blob = await engine.exportWav();
        if (!blob) {
            setStatus('書き出しに失敗しました。トラックにクリップがあるか確認してください');
            return;
        }
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'bunri_mix.wav';
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }, 1000);
        setStatus('WAVファイルを書き出しました');
    });
});

// ---- プロジェクト保存/読込 ----
document.getElementById('btn-save-project').addEventListener('click', async () => {
    const project = {
        bpm: engine.bpm,
        beatsPerBar: engine.beatsPerBar,
        tracks: engine.tracks.map(t => ({
            name: t.name,
            gain: t.gain,
            pan: t.pan,
            mute: t.mute,
            clips: t.clips.map(c => ({ name: c.name, offset: c.offset, duration: c.duration })),
        })),
        pianoRollNotes: pianoRoll.getNotes(),
        automation: automation.toJSON(),
    };
    const formData = new FormData();
    formData.append('data', JSON.stringify(project));
    await fetch('/api/project/save', { method: 'POST', body: formData });
    setStatus('プロジェクトを保存しました');
});

document.getElementById('btn-load-project').addEventListener('click', async () => {
    const resp = await fetch('/api/project/list');
    const files = await resp.json();
    if (files.length === 0) {
        setStatus('保存されたプロジェクトがありません');
        return;
    }
    const name = files[0]; // 最新のプロジェクト
    const projResp = await fetch(`/api/project/load/${name}`);
    const project = await projResp.json();

    engine.bpm = project.bpm || 120;
    engine.beatsPerBar = project.beatsPerBar || 4;
    bpmInput.value = engine.bpm;
    timeSigSelect.value = engine.beatsPerBar;

    pianoRoll.setNotes(project.pianoRollNotes || []);
    automation.fromJSON(project.automation || {});

    setStatus(`プロジェクト ${name} を読み込みました（※音声データは再インポートが必要です）`);
});

// ---- Record ボタン（トランスポート） ----
document.getElementById('btn-record').addEventListener('click', async () => {
    if (!engine.isRecording) {
        try {
            await engine.startRecording();
            engine.play();
            document.getElementById('btn-record').classList.add('active');
            document.getElementById('btn-record').style.color = '#e74c3c';
            setStatus('録音中...');
        } catch (e) {
            setStatus('マイクにアクセスできません');
        }
    } else {
        const buffer = await engine.stopRecording();
        engine.pause();
        document.getElementById('btn-record').classList.remove('active');
        document.getElementById('btn-record').style.color = '';

        let recTrack = engine.tracks.find(t => t.name.includes('Rec'));
        if (!recTrack) recTrack = engine.addTrack('Rec');
        await engine.addClipFromBuffer(recTrack.id, buffer, 'recording');
        timeline.render();
        setStatus('録音完了');
    }
});

// ---- ヒント表示（ホバー → ステータスバー） ----
const hintText = document.getElementById('hint-text');

document.querySelectorAll('[data-hint]').forEach(el => {
    el.addEventListener('mouseenter', () => {
        hintText.textContent = el.dataset.hint;
    });
    el.addEventListener('mouseleave', () => {
        hintText.textContent = '';
    });
});

// ---- ウェルカムガイド ----
const guideOverlay = document.getElementById('guide-overlay');

function showGuide() {
    guideOverlay.classList.remove('hidden');
}

function hideGuide() {
    guideOverlay.classList.add('hidden');
    localStorage.setItem('bunri-guide-seen', '1');
}

document.getElementById('btn-close-guide').addEventListener('click', hideGuide);
document.getElementById('btn-help').addEventListener('click', showGuide);

// 初回訪問でなければガイドを非表示
if (localStorage.getItem('bunri-guide-seen')) {
    guideOverlay.classList.add('hidden');
}

// ---- GM楽器リスト読み込み ----
(async () => {
    try {
        const resp = await fetch('/api/gm-instruments');
        const instruments = await resp.json();
        const sel = document.getElementById('synth-gm');
        // カテゴリ分け
        const categories = {
            'ピアノ': [0, 1, 2, 4, 5, 6, 8],
            'クロマチックパーカッション': [9, 10, 11, 12, 13],
            'ギター': [24, 25, 26, 27, 28, 29, 30],
            'ベース': [32, 33, 34, 35, 36, 38],
            'ストリングス': [40, 41, 42, 43, 44, 45, 46, 48, 49, 50],
            'コーラス/ボイス': [52, 53, 54],
            'ブラス': [56, 57, 58, 59, 60, 61, 62],
            'リード/サックス': [64, 65, 66, 67],
            '木管': [68, 69, 70, 71, 72, 73, 74, 75, 79],
            'シンセリード': [80, 81],
            'シンセパッド': [88, 89, 90, 91, 95],
            'エスニック/その他': [104, 105, 108, 110, 114],
        };
        const instMap = {};
        instruments.forEach(i => { instMap[i.program] = i.name; });

        for (const [cat, programs] of Object.entries(categories)) {
            const group = document.createElement('optgroup');
            group.label = cat;
            for (const p of programs) {
                if (instMap[p]) {
                    const opt = document.createElement('option');
                    opt.value = p;
                    opt.textContent = instMap[p];
                    group.appendChild(opt);
                }
            }
            if (group.children.length > 0) sel.appendChild(group);
        }
    } catch (e) {
        console.warn('GM楽器リストの読み込みに失敗:', e);
    }
})();

// ---- 初期表示 ----
setStatus('準備完了 — トラックにWAVファイルをドラッグ&ドロップして開始');
automation.draw();
