/**
 * bunri DAW — WebAudio リアルタイム再生エンジン
 * トラック管理、クリップ再生、ピアノノート再生、メトロノーム、録音を担当
 */

// 音名 → 周波数テーブル
const NOTE_FREQ = {};
(() => {
    const names = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
    for (let oct = 0; oct <= 8; oct++) {
        for (let i = 0; i < 12; i++) {
            const midi = (oct + 1) * 12 + i;
            const freq = 440 * Math.pow(2, (midi - 69) / 12);
            NOTE_FREQ[`${names[i]}${oct}`] = freq;
        }
    }
})();

class AudioEngine {
    constructor() {
        this.ctx = null; // AudioContext（ユーザー操作後に初期化）
        this.masterGain = null;
        this.isPlaying = false;
        this.isRecording = false;
        this.startTime = 0;     // ctx.currentTime ベースの再生開始時刻
        this.playOffset = 0;    // 再生位置オフセット（秒）
        this.bpm = 120;
        this.beatsPerBar = 4;
        this.metronomeEnabled = false;
        this.metronomeInterval = null;

        // トラック: { id, name, clips, pianoNotes, gain, pan, mute, solo }
        this.tracks = [];
        this.nextTrackId = 1;

        // 録音
        this.mediaStream = null;
        this.mediaRecorder = null;
        this.recordedChunks = [];

        // 再生中のソースノード（停止用）
        this.activeSources = [];
        this.soloTrackId = null; // 単独再生中のトラックID（nullなら全トラック）
    }

    init() {
        if (this.ctx) return;
        this.ctx = new (window.AudioContext || window.webkitAudioContext)();
        this.masterGain = this.ctx.createGain();
        this.masterGain.connect(this.ctx.destination);
    }

    // ---- トラック管理 ----

    addTrack(name) {
        this.init();
        const track = {
            id: this.nextTrackId++,
            name: name || `Track ${this.tracks.length + 1}`,
            clips: [],       // {buffer, offset, name}
            pianoNotes: [],  // [{note, octave, step, length}]
            gain: 0,         // dB
            pan: 0,          // -1 ~ 1
            mute: false,
            solo: false,
            gainNode: this.ctx.createGain(),
            panNode: this.ctx.createStereoPanner(),
        };
        track.panNode.connect(track.gainNode);
        track.gainNode.connect(this.masterGain);
        this.tracks.push(track);
        return track;
    }

    removeTrack(trackId) {
        trackId = Number(trackId);
        this.tracks = this.tracks.filter(t => t.id !== trackId);
    }

    getTrack(trackId) {
        trackId = Number(trackId);
        return this.tracks.find(t => t.id === trackId);
    }

    updateTrackGain(trackId, db) {
        const track = this.getTrack(trackId);
        if (!track) return;
        track.gain = db;
        track.gainNode.gain.value = track.mute ? 0 : Math.pow(10, db / 20);
    }

    updateTrackPan(trackId, pan) {
        const track = this.getTrack(trackId);
        if (!track) return;
        track.pan = pan;
        track.panNode.pan.value = pan;
    }

    toggleMute(trackId) {
        const track = this.getTrack(trackId);
        if (!track) return;
        track.mute = !track.mute;
        track.gainNode.gain.value = track.mute ? 0 : Math.pow(10, track.gain / 20);
        return track.mute;
    }

    // ---- クリップ管理 ----

    async addClipFromFile(trackId, file, offsetSec = 0) {
        this.init();
        const track = this.getTrack(trackId);
        if (!track) return;

        const arrayBuf = await file.arrayBuffer();
        const buffer = await this.ctx.decodeAudioData(arrayBuf);
        const clip = { buffer, offset: offsetSec, name: file.name, duration: buffer.duration };
        track.clips.push(clip);
        return clip;
    }

    async addClipFromUrl(trackId, url, name, offsetSec = 0) {
        this.init();
        const track = this.getTrack(trackId);
        if (!track) return;

        const resp = await fetch(url);
        const arrayBuf = await resp.arrayBuffer();
        const buffer = await this.ctx.decodeAudioData(arrayBuf);
        const clip = { buffer, offset: offsetSec, name: name || 'clip', duration: buffer.duration };
        track.clips.push(clip);
        return clip;
    }

    async addClipFromBuffer(trackId, audioBuffer, name, offsetSec = 0) {
        const track = this.getTrack(trackId);
        if (!track) return;
        const clip = { buffer: audioBuffer, offset: offsetSec, name: name || 'clip', duration: audioBuffer.duration };
        track.clips.push(clip);
        return clip;
    }

    moveClip(trackId, clipIndex, newOffset) {
        const track = this.getTrack(trackId);
        if (!track || !track.clips[clipIndex]) return;
        track.clips[clipIndex].offset = Math.max(0, newOffset);
    }

    removeClip(trackId, clipIndex) {
        const track = this.getTrack(trackId);
        if (!track) return;
        track.clips.splice(clipIndex, 1);
    }

    // ---- 再生 ----

    play(fromSec = null) {
        this.init();
        if (this.isPlaying) this.stop();

        // 再生前にアクティブトラックのピアノロールを保存
        if (window.pianoRoll) {
            pianoRoll._saveToEngine();
        }

        if (fromSec !== null) this.playOffset = fromSec;
        this.startTime = this.ctx.currentTime;
        this.isPlaying = true;
        this.soloTrackId = null; // 全トラック再生モード
        this.activeSources = [];

        // ソロ判定
        const hasSolo = this.tracks.some(t => t.solo);

        for (const track of this.tracks) {
            if (track.mute) continue;
            if (hasSolo && !track.solo) continue;
            this._scheduleTrack(track);
        }

        // メトロノーム
        if (this.metronomeEnabled) this._startMetronome();
    }

    /**
     * 指定トラックだけを再生する
     */
    playSingleTrack(trackId, fromSec = null) {
        this.init();
        if (this.isPlaying) this.stop();

        if (window.pianoRoll) {
            pianoRoll._saveToEngine();
        }

        const track = this.getTrack(trackId);
        if (!track) return;

        if (fromSec !== null) this.playOffset = fromSec;
        this.startTime = this.ctx.currentTime;
        this.isPlaying = true;
        this.soloTrackId = trackId; // 単独再生モード
        this.activeSources = [];

        this._scheduleTrack(track);

        if (this.metronomeEnabled) this._startMetronome();
    }

    /**
     * トラックのクリップとピアノノートをスケジュール再生
     */
    _scheduleTrack(track) {
        // オーディオクリップ再生
        for (const clip of track.clips) {
            const source = this.ctx.createBufferSource();
            source.buffer = clip.buffer;
            source.connect(track.panNode);

            const clipStart = clip.offset - this.playOffset;
            if (clipStart >= 0) {
                source.start(this.ctx.currentTime + clipStart);
            } else if (-clipStart < clip.duration) {
                source.start(this.ctx.currentTime, -clipStart);
            } else {
                continue;
            }
            this.activeSources.push(source);
        }

        // ピアノノート再生
        this._scheduleTrackNotes(track);
    }

    /**
     * トラックのpianoNotesをWebAudioオシレーターでスケジュール再生
     */
    _scheduleTrackNotes(track) {
        if (!track.pianoNotes || track.pianoNotes.length === 0) return;

        const stepSec = 60 / this.bpm / 4; // 16分音符1つの秒数

        for (const n of track.pianoNotes) {
            const freq = NOTE_FREQ[`${n.note}${n.octave}`];
            if (!freq) continue;

            const noteStart = n.step * stepSec;
            const noteDur = n.length * stepSec;
            const relStart = noteStart - this.playOffset;

            // 既に終わったノートはスキップ
            if (relStart + noteDur <= 0) continue;

            const attack = 0.01;
            const release = Math.min(0.15, noteDur * 0.3);
            const sustainDur = Math.max(0, noteDur - attack - release);

            // オシレーター
            const osc = this.ctx.createOscillator();
            const gain = this.ctx.createGain();
            osc.type = 'triangle';
            osc.frequency.value = freq;

            gain.gain.setValueAtTime(0, this.ctx.currentTime);
            osc.connect(gain);
            gain.connect(track.panNode);

            if (relStart >= 0) {
                const when = this.ctx.currentTime + relStart;
                // ADSR エンベロープ
                gain.gain.setValueAtTime(0, when);
                gain.gain.linearRampToValueAtTime(0.25, when + attack);
                gain.gain.setValueAtTime(0.25, when + attack + sustainDur);
                gain.gain.linearRampToValueAtTime(0, when + noteDur);
                osc.start(when);
                osc.stop(when + noteDur + 0.01);
            } else {
                // 途中からのノート
                const elapsed = -relStart;
                const remaining = noteDur - elapsed;
                if (remaining <= 0) continue;
                const when = this.ctx.currentTime;
                gain.gain.setValueAtTime(0.25, when);
                gain.gain.setValueAtTime(0.25, when + Math.max(0, remaining - release));
                gain.gain.linearRampToValueAtTime(0, when + remaining);
                osc.start(when);
                osc.stop(when + remaining + 0.01);
            }

            this.activeSources.push(osc);
        }
    }

    stop() {
        this.isPlaying = false;
        this.soloTrackId = null;
        for (const src of this.activeSources) {
            try { src.stop(); } catch (e) {}
        }
        this.activeSources = [];
        this._stopMetronome();
        this.playOffset = 0;
    }

    pause() {
        if (!this.isPlaying) return;
        this.playOffset += this.ctx.currentTime - this.startTime;
        this.isPlaying = false;
        for (const src of this.activeSources) {
            try { src.stop(); } catch (e) {}
        }
        this.activeSources = [];
        this._stopMetronome();
    }

    getCurrentTime() {
        if (!this.isPlaying) return this.playOffset;
        return this.playOffset + (this.ctx.currentTime - this.startTime);
    }

    getTotalDuration() {
        let maxEnd = 0;
        const stepSec = 60 / this.bpm / 4;
        for (const track of this.tracks) {
            maxEnd = Math.max(maxEnd, this._getTrackEndTime(track, stepSec));
        }
        return maxEnd;
    }

    getTrackDuration(trackId) {
        const track = this.getTrack(trackId);
        if (!track) return 0;
        const stepSec = 60 / this.bpm / 4;
        return this._getTrackEndTime(track, stepSec);
    }

    _getTrackEndTime(track, stepSec) {
        let maxEnd = 0;
        for (const clip of track.clips) {
            maxEnd = Math.max(maxEnd, clip.offset + clip.duration);
        }
        for (const n of (track.pianoNotes || [])) {
            maxEnd = Math.max(maxEnd, (n.step + n.length) * stepSec);
        }
        return maxEnd;
    }

    // ---- メトロノーム ----

    _startMetronome() {
        this._stopMetronome();
        const beatSec = 60 / this.bpm;
        let nextBeat = 0;
        const currentPos = this.playOffset;
        nextBeat = Math.ceil(currentPos / beatSec) * beatSec;

        const schedule = () => {
            if (!this.isPlaying || !this.metronomeEnabled) return;
            const now = this.getCurrentTime();
            while (nextBeat < now + 0.1) {
                const beatInBar = Math.round(nextBeat / beatSec) % this.beatsPerBar;
                const freq = beatInBar === 0 ? 1500 : 1000;
                this._playClick(nextBeat - this.playOffset + this.startTime, freq);
                nextBeat += beatSec;
            }
        };
        schedule();
        this.metronomeInterval = setInterval(schedule, 50);
    }

    _stopMetronome() {
        if (this.metronomeInterval) {
            clearInterval(this.metronomeInterval);
            this.metronomeInterval = null;
        }
    }

    _playClick(when, freq) {
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.3, when);
        gain.gain.exponentialRampToValueAtTime(0.001, when + 0.05);
        osc.connect(gain);
        gain.connect(this.ctx.destination);
        osc.start(when);
        osc.stop(when + 0.05);
    }

    // ---- 録音 ----

    async startRecording() {
        this.init();
        this.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        this.mediaRecorder = new MediaRecorder(this.mediaStream);
        this.recordedChunks = [];
        this.mediaRecorder.ondataavailable = (e) => {
            if (e.data.size > 0) this.recordedChunks.push(e.data);
        };
        this.mediaRecorder.start();
        this.isRecording = true;
    }

    async stopRecording() {
        return new Promise((resolve) => {
            this.mediaRecorder.onstop = async () => {
                this.isRecording = false;
                this.mediaStream.getTracks().forEach(t => t.stop());
                const blob = new Blob(this.recordedChunks, { type: 'audio/webm' });
                const arrayBuf = await blob.arrayBuffer();
                const buffer = await this.ctx.decodeAudioData(arrayBuf);
                resolve(buffer);
            };
            this.mediaRecorder.stop();
        });
    }

    // ---- ミックスダウン（オフライン） ----

    async mixdown() {
        this.init();
        // 保存前にアクティブトラックのノートを反映
        if (window.pianoRoll) pianoRoll._saveToEngine();

        const duration = this.getTotalDuration();
        if (duration === 0) return null;

        const sampleRate = 44100;
        const offCtx = new OfflineAudioContext(2, Math.ceil(duration * sampleRate), sampleRate);
        const master = offCtx.createGain();
        master.connect(offCtx.destination);

        const stepSec = 60 / this.bpm / 4;

        for (const track of this.tracks) {
            if (track.mute) continue;
            const gainNode = offCtx.createGain();
            gainNode.gain.value = Math.pow(10, track.gain / 20);
            const panNode = offCtx.createStereoPanner();
            panNode.pan.value = track.pan;
            panNode.connect(gainNode);
            gainNode.connect(master);

            // オーディオクリップ
            for (const clip of track.clips) {
                const src = offCtx.createBufferSource();
                src.buffer = clip.buffer;
                src.connect(panNode);
                src.start(clip.offset);
            }

            // ピアノノート
            for (const n of (track.pianoNotes || [])) {
                const freq = NOTE_FREQ[`${n.note}${n.octave}`];
                if (!freq) continue;
                const noteStart = n.step * stepSec;
                const noteDur = n.length * stepSec;
                const attack = 0.01;
                const release = Math.min(0.15, noteDur * 0.3);
                const sustainDur = Math.max(0, noteDur - attack - release);

                const osc = offCtx.createOscillator();
                const g = offCtx.createGain();
                osc.type = 'triangle';
                osc.frequency.value = freq;
                g.gain.setValueAtTime(0, noteStart);
                g.gain.linearRampToValueAtTime(0.25, noteStart + attack);
                g.gain.setValueAtTime(0.25, noteStart + attack + sustainDur);
                g.gain.linearRampToValueAtTime(0, noteStart + noteDur);
                osc.connect(g);
                g.connect(panNode);
                osc.start(noteStart);
                osc.stop(noteStart + noteDur + 0.01);
            }
        }

        const rendered = await offCtx.startRendering();
        return rendered;
    }

    async exportWav() {
        const buffer = await this.mixdown();
        if (!buffer) return null;
        return this._audioBufferToWav(buffer);
    }

    _audioBufferToWav(buffer) {
        const numChannels = buffer.numberOfChannels;
        const sampleRate = buffer.sampleRate;
        const length = buffer.length;
        const bytesPerSample = 2;
        const dataLength = length * numChannels * bytesPerSample;
        const headerLength = 44;
        const wav = new ArrayBuffer(headerLength + dataLength);
        const view = new DataView(wav);

        const writeString = (offset, str) => {
            for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
        };

        writeString(0, 'RIFF');
        view.setUint32(4, 36 + dataLength, true);
        writeString(8, 'WAVE');
        writeString(12, 'fmt ');
        view.setUint32(16, 16, true);
        view.setUint16(20, 1, true);
        view.setUint16(22, numChannels, true);
        view.setUint32(24, sampleRate, true);
        view.setUint32(28, sampleRate * numChannels * bytesPerSample, true);
        view.setUint16(32, numChannels * bytesPerSample, true);
        view.setUint16(34, 8 * bytesPerSample, true);
        writeString(36, 'data');
        view.setUint32(40, dataLength, true);

        const channels = [];
        for (let ch = 0; ch < numChannels; ch++) channels.push(buffer.getChannelData(ch));

        let offset = 44;
        for (let i = 0; i < length; i++) {
            for (let ch = 0; ch < numChannels; ch++) {
                const sample = Math.max(-1, Math.min(1, channels[ch][i]));
                view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7FFF, true);
                offset += 2;
            }
        }
        return new Blob([wav], { type: 'audio/wav' });
    }
}

// グローバルインスタンス
window.engine = new AudioEngine();
