/**
 * bunri DAW — WebAudio リアルタイム再生エンジン
 * トラック管理、クリップ再生、メトロノーム、録音を担当
 */
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

        // トラック: { id, name, clips: [{buffer, offset, gainNode}], gain, pan, mute, solo }
        this.tracks = [];
        this.nextTrackId = 1;

        // 録音
        this.mediaStream = null;
        this.mediaRecorder = null;
        this.recordedChunks = [];

        // 再生中のソースノード（停止用）
        this.activeSources = [];
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
        this.tracks = this.tracks.filter(t => t.id !== trackId);
    }

    getTrack(trackId) {
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

        if (fromSec !== null) this.playOffset = fromSec;
        this.startTime = this.ctx.currentTime;
        this.isPlaying = true;
        this.activeSources = [];

        // ソロ判定
        const hasSolo = this.tracks.some(t => t.solo);

        for (const track of this.tracks) {
            if (track.mute) continue;
            if (hasSolo && !track.solo) continue;

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
                    continue; // クリップ全体が再生位置より前
                }
                this.activeSources.push(source);
            }
        }

        // メトロノーム
        if (this.metronomeEnabled) this._startMetronome();
    }

    stop() {
        this.isPlaying = false;
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
        for (const track of this.tracks) {
            for (const clip of track.clips) {
                maxEnd = Math.max(maxEnd, clip.offset + clip.duration);
            }
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
                // WebM → AudioBuffer に変換
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
        const duration = this.getTotalDuration();
        if (duration === 0) return null;

        const sampleRate = 44100;
        const offCtx = new OfflineAudioContext(2, Math.ceil(duration * sampleRate), sampleRate);
        const master = offCtx.createGain();
        master.connect(offCtx.destination);

        for (const track of this.tracks) {
            if (track.mute) continue;
            const gainNode = offCtx.createGain();
            gainNode.gain.value = Math.pow(10, track.gain / 20);
            const panNode = offCtx.createStereoPanner();
            panNode.pan.value = track.pan;
            panNode.connect(gainNode);
            gainNode.connect(master);

            for (const clip of track.clips) {
                const src = offCtx.createBufferSource();
                src.buffer = clip.buffer;
                src.connect(panNode);
                src.start(clip.offset);
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
