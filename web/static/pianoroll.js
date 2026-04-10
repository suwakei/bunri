/**
 * bunri DAW — ピアノロール（トラック独立対応）
 * 各トラックが独自のノートデータを持ち、選択トラック切替で表示を切り替える
 * Vue.js コンポーネントから init() で初期化して使う
 */
class PianoRoll {
    constructor() {
        this.canvas = null;
        this.noteLayer = null;
        this.keysDiv = null;
        this.wrap = null;
        this.ctx = null;

        this.noteHeight = 14;
        this.stepWidth = 20;     // 16分音符1つの幅(px)
        this.totalSteps = 128;   // 8小節 × 16ステップ
        this.octaveRange = [2, 7]; // C2 ~ B6
        this.noteNames = ['B','A#','A','G#','G','F#','F','E','D#','D','C#','C'];
        this.blackKeys = new Set(['A#','G#','F#','D#','C#']);

        // 現在選択中のトラックID（null = なし）
        this.activeTrackId = null;

        // ノートデータ: [{note, octave, step, length, element}]
        this.notes = [];
        this.selectedNote = null;
        this.isDragging = false;
        this.isResizing = false;
        this.dragStartX = 0;
        this.dragStartStep = 0;
        this.snapToGrid = true;
        this.gridSize = 4; // 4 = 4分音符スナップ

        this.totalRows = (this.octaveRange[1] - this.octaveRange[0]) * 12;

        // コールバック（Vue側で設定）
        this.onTrackSwitch = null;
    }

    /**
     * DOM要素を受け取って初期化する（Vue の onMounted から呼ぶ）
     */
    init(elements) {
        this.canvas = elements.canvas;
        this.noteLayer = elements.noteLayer;
        this.keysDiv = elements.keysDiv;
        this.wrap = elements.wrap;
        this.ctx = this.canvas.getContext('2d');

        this._buildKeys();
        this._resize();
        this._drawGrid();
        this._bindEvents();
    }

    // ---- トラック切替 ----

    switchToTrack(trackId) {
        this._saveToEngine();
        this.activeTrackId = trackId !== null ? Number(trackId) : null;
        this.selectedNote = null;
        this._loadFromEngine();
        this._renderNotes();
        if (this.onTrackSwitch) this.onTrackSwitch(this.activeTrackId);
    }

    _saveToEngine() {
        if (this.activeTrackId === null) return;
        const track = engine.getTrack(this.activeTrackId);
        if (!track) return;
        track.pianoNotes = this.notes.map(n => ({
            note: n.note, octave: n.octave, step: n.step, length: n.length,
        }));
    }

    _loadFromEngine() {
        if (this.activeTrackId === null) {
            this.notes = [];
            return;
        }
        const track = engine.getTrack(this.activeTrackId);
        if (!track) {
            this.notes = [];
            return;
        }
        this.notes = (track.pianoNotes || []).map(n => ({ ...n }));
    }

    _buildKeys() {
        this.keysDiv.innerHTML = '';
        for (let oct = this.octaveRange[1] - 1; oct >= this.octaveRange[0]; oct--) {
            for (const name of this.noteNames) {
                const div = document.createElement('div');
                div.className = 'piano-key' + (this.blackKeys.has(name) ? ' black' : '');
                div.textContent = `${name}${oct}`;
                div.style.height = this.noteHeight + 'px';
                this.keysDiv.appendChild(div);
            }
        }
    }

    _resize() {
        const w = this.totalSteps * this.stepWidth;
        const h = this.totalRows * this.noteHeight;
        this.canvas.width = w;
        this.canvas.height = h;
        this.canvas.style.width = w + 'px';
        this.canvas.style.height = h + 'px';
        this.noteLayer.style.width = w + 'px';
        this.noteLayer.style.height = h + 'px';
    }

    _drawGrid() {
        const { ctx, canvas } = this;
        const w = canvas.width;
        const h = canvas.height;
        ctx.clearRect(0, 0, w, h);

        for (let row = 0; row < this.totalRows; row++) {
            const y = row * this.noteHeight;
            const noteIdx = row % 12;
            const noteName = this.noteNames[noteIdx];

            if (this.blackKeys.has(noteName)) {
                ctx.fillStyle = 'rgba(0,0,0,0.2)';
                ctx.fillRect(0, y, w, this.noteHeight);
            }

            ctx.strokeStyle = noteIdx === 0 ? 'rgba(255,255,255,0.15)' : 'rgba(255,255,255,0.05)';
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(w, y);
            ctx.stroke();
        }

        for (let step = 0; step <= this.totalSteps; step++) {
            const x = step * this.stepWidth;
            const isBeat = step % 4 === 0;
            const isBar = step % 16 === 0;

            ctx.strokeStyle = isBar ? 'rgba(255,255,255,0.25)' :
                              isBeat ? 'rgba(255,255,255,0.1)' :
                              'rgba(255,255,255,0.03)';
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, h);
            ctx.stroke();
        }
    }

    _bindEvents() {
        // ダブルクリックでノート追加
        this.canvas.addEventListener('dblclick', (e) => {
            if (this.activeTrackId === null) return;
            const rect = this.canvas.getBoundingClientRect();
            const x = e.clientX - rect.left + this.wrap.scrollLeft;
            const y = e.clientY - rect.top + this.wrap.scrollTop;
            let step = Math.floor(x / this.stepWidth);
            if (this.snapToGrid) step = Math.floor(step / this.gridSize) * this.gridSize;
            const row = Math.floor(y / this.noteHeight);
            const { note, octave } = this._rowToNote(row);
            this._addNote(note, octave, step, this.gridSize);
        });

        // クリックで選択
        this.noteLayer.addEventListener('mousedown', (e) => {
            if (e.target.classList.contains('note-block')) {
                e.preventDefault();
                const idx = parseInt(e.target.dataset.index);
                this._selectNote(idx);

                const rect = e.target.getBoundingClientRect();
                if (e.clientX > rect.right - 10) {
                    this.isResizing = true;
                } else {
                    this.isDragging = true;
                }
                this.dragStartX = e.clientX;
                this.dragStartStep = this.notes[idx].step;
                this._dragLength = this.notes[idx].length;
            }
        });

        document.addEventListener('mousemove', (e) => {
            if (!this.isDragging && !this.isResizing) return;
            if (this.selectedNote === null) return;

            const dx = e.clientX - this.dragStartX;
            const dSteps = Math.round(dx / this.stepWidth);
            const note = this.notes[this.selectedNote];

            if (this.isDragging) {
                let newStep = this.dragStartStep + dSteps;
                if (this.snapToGrid) newStep = Math.round(newStep / this.gridSize) * this.gridSize;
                note.step = Math.max(0, newStep);
            } else if (this.isResizing) {
                let newLen = this._dragLength + dSteps;
                if (this.snapToGrid) newLen = Math.max(this.gridSize, Math.round(newLen / this.gridSize) * this.gridSize);
                else newLen = Math.max(1, newLen);
                note.length = newLen;
            }
            this._renderNotes();
        });

        document.addEventListener('mouseup', () => {
            if (this.isDragging || this.isResizing) {
                this._saveToEngine();
            }
            this.isDragging = false;
            this.isResizing = false;
        });

        // Deleteキーでノート削除
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Delete' && this.selectedNote !== null) {
                this._removeNote(this.selectedNote);
            }
        });
    }

    _rowToNote(row) {
        const noteIdx = row % 12;
        const octave = this.octaveRange[1] - 1 - Math.floor(row / 12);
        return { note: this.noteNames[noteIdx], octave };
    }

    _noteToRow(noteName, octave) {
        const noteIdx = this.noteNames.indexOf(noteName);
        const octOffset = this.octaveRange[1] - 1 - octave;
        return octOffset * 12 + noteIdx;
    }

    _addNote(note, octave, step, length) {
        this.notes.push({ note, octave, step, length });
        this._saveToEngine();
        this._renderNotes();
    }

    _removeNote(idx) {
        this.notes.splice(idx, 1);
        this.selectedNote = null;
        this._saveToEngine();
        this._renderNotes();
    }

    _selectNote(idx) {
        this.selectedNote = idx;
        this._renderNotes();
    }

    _renderNotes() {
        if (!this.noteLayer) return;
        this.noteLayer.innerHTML = '';

        if (this.activeTrackId === null) {
            const msg = document.createElement('div');
            msg.style.cssText = 'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);color:var(--text-dim);font-size:13px;pointer-events:none;';
            msg.textContent = 'トラックをクリックしてピアノロールを開く';
            this.noteLayer.appendChild(msg);
            return;
        }

        this.notes.forEach((n, i) => {
            const row = this._noteToRow(n.note, n.octave);
            const el = document.createElement('div');
            el.className = 'note-block' + (i === this.selectedNote ? ' selected' : '');
            el.style.left = (n.step * this.stepWidth) + 'px';
            el.style.top = (row * this.noteHeight) + 'px';
            el.style.width = (n.length * this.stepWidth - 1) + 'px';
            el.style.height = (this.noteHeight - 1) + 'px';
            el.dataset.index = i;
            el.title = `${n.note}${n.octave} step:${n.step} len:${n.length}`;
            this.noteLayer.appendChild(el);
        });
    }

    // ---- 外部インターフェース ----

    getNotes() {
        this._saveToEngine();
        return this.notes.map(n => ({
            note: n.note, octave: n.octave, step: n.step, length: n.length,
        }));
    }

    setNotes(notes) {
        this.notes = notes.map(n => ({ ...n }));
        this.selectedNote = null;
        this._saveToEngine();
        this._renderNotes();
    }

    getActiveTrackId() {
        return this.activeTrackId;
    }

    clear() {
        this.notes = [];
        this.selectedNote = null;
        this._saveToEngine();
        this._renderNotes();
    }

    setGridSize(size) {
        this.gridSize = size;
    }

    setStepWidth(w) {
        this.stepWidth = w;
        this._resize();
        this._drawGrid();
        this._renderNotes();
    }
}

// Vue側で初期化するため、自動インスタンス化しない
// window.pianoRoll は app.js 側で作成する
