/**
 * ブラウザのテストで使う共通の部品。
 */
import type { Page, Request } from '@playwright/test';
import { fileURLToPath } from 'node:url';

/** テスト用の小さな MP3 (C4 E4 G4 C5 を 2 秒ずつ、8 秒)。WAV 以外の曲の取り込みを確かめるのに使う。 */
export const SONG_MP3 = fileURLToPath(new URL('./fixtures/song.mp3', import.meta.url));

/**
 * 画面 (Vite の開発サーバ) のポートと URL。ほかの開発サーバとぶつからないよう、よく使われる番号を避けている。
 * 同じリポジトリの別の作業ツリーで同時に走らせるときは、BUNRI_E2E_PORT で番号を変える
 * (同じ番号だと、後から始めたほうが起動に失敗する)。
 */
export const E2E_PORT = Number(process.env.BUNRI_E2E_PORT) || 5199;
export const E2E_URL = `http://127.0.0.1:${E2E_PORT}`;

/**
 * 「CSP が効いているか」を確かめるときに、わざと読み込ませて止めさせる先 (ポート 9 は使われない番号)。
 * ここへの違反だけは、最後の違反の確かめ (csp-check.ts) で数えない。
 */
export const CSP_PROBE_ORIGIN = 'http://127.0.0.1:9';

/**
 * 偽の Claude API サーバ (fake-anthropic.mjs) のポートと URL。playwright.config.ts が起動する。
 * 別の作業ツリーで同時に走らせるときは、BUNRI_E2E_PORT と一緒に BUNRI_E2E_FAKE_LLM_PORT も変える。
 */
export const FAKE_LLM_PORT = Number(process.env.BUNRI_E2E_FAKE_LLM_PORT) || 5198;
export const FAKE_LLM_URL = `http://127.0.0.1:${FAKE_LLM_PORT}`;

/**
 * 初回の案内 (ウェルカムガイド) を出さない状態で DAW の画面を開く。
 * 案内は初めて開いたときだけ出て、画面全体を覆うので、普段のテストでは既読にしておく。
 */
export async function openDaw(page: Page): Promise<void> {
    await page.addInitScript(() => localStorage.setItem('bunri-guide-seen', '1'));
    await page.goto('/');
    await page.getByText('準備完了').waitFor();
}

/**
 * テスト用の WAV ファイル (モノラル 16bit) を作る。
 *
 * @param seconds - 長さ (秒)
 * @param notes - 鳴らす音の周波数 (Hz)。等分して順に鳴らす
 * @param sampleRate - サンプルレート
 */
export function makeWav(seconds: number, notes: number[] = [440], sampleRate = 22050): Buffer {
    const total = Math.floor(seconds * sampleRate);
    const data = Buffer.alloc(total * 2);
    const per = Math.floor(total / notes.length);
    for (let i = 0; i < total; i++) {
        const freq = notes[Math.min(notes.length - 1, Math.floor(i / per))];
        // 音の切れ目でぷつっと鳴らないよう、各音の頭と終わりを短くなだらかにする
        const pos = i % per;
        const edge = Math.min(1, pos / 200, (per - pos) / 200);
        data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / sampleRate) * 12000 * edge), i * 2);
    }
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + data.length, 4);
    header.write('WAVEfmt ', 8);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(sampleRate * 2, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36);
    header.writeUInt32LE(data.length, 40);
    return Buffer.concat([header, data]);
}

/** ステータスバーの文 (左側)。 */
export const statusText = (page: Page) => page.locator('#status-text');

/** 左パネルの中の段と、それを持つ上の段のタブ。 */
const SUB_TAB_PARENT: Record<string, string> = {
    '曲とパート': '学ぶ', 'カルテ': '学ぶ', 'ガイド': '学ぶ', '差分': '学ぶ',
    'シンセ': '音作り', 'ドラム': '音作り', 'FX': '音作り',
};

/**
 * 左パネルのタブを開く。上の段のタブ (学ぶ・音作り・ファイル) か、中の段 (カルテ・シンセなど) の名前で指す。
 * 中の段なら、それを持つ上の段のタブを先に開く。
 */
export async function openTab(page: Page, label: string): Promise<void> {
    const parent = SUB_TAB_PARENT[label];
    await page.locator('#panel-tabs').getByRole('tab', { name: parent ?? label, exact: true }).click();
    if (parent) await page.locator('#left-panel [role="tabpanel"]:not([hidden])').getByRole('tab', { name: label, exact: true }).first().click();
}

/**
 * 「自由に作る」で始める (曲を取り込まずに、空のトラックを作る)。
 * 起動したときはトラックが無いので、トラックを使うテストはこれで用意する。
 *
 * @param tracks - 作るトラックの数 (Track 1, Track 2, …)
 */
export async function startFree(page: Page, tracks = 2): Promise<void> {
    await page.getByRole('button', { name: '自由に作る' }).click();
    for (let i = 1; i < tracks; i++) await page.getByRole('button', { name: '+ トラック追加' }).click();
    await page.locator('#tracks-container .track-row').nth(tracks - 1).waitFor();
}

/** 指定したテスト用の音声を、取り込む曲として選ぶ (原曲のファイルの欄。画面には出ていない)。 */
export async function importSong(page: Page, file: { name: string; mimeType: string; buffer: Buffer }): Promise<void> {
    await page.locator('#song-file').setInputFiles(file);
}

/**
 * 鳴らされた音 (オシレータ) の周波数を、鳴らした順に記録する仕掛けを入れる。画面を開く前に呼ぶ。
 * 試し聴き (ノートを置いたとき、鍵盤を押したとき) で、どの高さが鳴ったかを確かめるのに使う。
 * 記録は `soundedFrequencies` で読む。
 */
export async function recordOscillators(page: Page): Promise<void> {
    await page.addInitScript(() => {
        const log: number[] = [];
        (window as unknown as { __oscillators: number[] }).__oscillators = log;
        const start = OscillatorNode.prototype.start;
        OscillatorNode.prototype.start = function (this: OscillatorNode, ...args: [number?]) {
            log.push(Math.round(this.frequency.value * 100) / 100);
            return start.apply(this, args);
        };
    });
}

/** `recordOscillators` を入れてから鳴らされた音の周波数 (Hz。小数 2 桁)。 */
export function soundedFrequencies(page: Page): Promise<number[]> {
    return page.evaluate(() => (window as unknown as { __oscillators: number[] }).__oscillators.slice());
}

/** タイムラインの各トラックの、名前とクリップ名の一覧。 */
export function trackSummary(page: Page): Promise<{ name: string; clips: string[] }[]> {
    return page.locator('#tracks-container .track-row').evaluateAll((rows) => rows.map((row) => ({
        // 名前の後ろにノートの数のバッジが付くので、名前だけを取り出す
        name: (row.querySelector('.track-name')!.firstChild?.textContent ?? '').trim(),
        clips: [...row.querySelectorAll('.clip')].map((c) => c.textContent ?? ''),
    })));
}

/** テスト用の WAV を、ファイル選択に渡す形にする。 */
export function wavFile(name: string, seconds = 2, notes: number[] = [440]) {
    return { name, mimeType: 'audio/wav', buffer: makeWav(seconds, notes) };
}

/**
 * WAV (16bit PCM) の中身を読む。長さ (秒) と、いちばん大きい振幅 (0〜1) を返す。
 * 「音が出ている (無音ではない)」ことを確かめるのに使う。
 */
export function readWav(bytes: Buffer): { seconds: number; peak: number; sampleRate: number; channels: number } {
    if (bytes.subarray(0, 4).toString('latin1') !== 'RIFF' || bytes.subarray(8, 12).toString('latin1') !== 'WAVE') {
        throw new Error('WAV ではありません');
    }
    let pos = 12;
    let sampleRate = 0, channels = 0, bits = 0;
    while (pos + 8 <= bytes.length) {
        const id = bytes.subarray(pos, pos + 4).toString('latin1');
        const size = bytes.readUInt32LE(pos + 4);
        if (id === 'fmt ') {
            channels = bytes.readUInt16LE(pos + 10);
            sampleRate = bytes.readUInt32LE(pos + 12);
            bits = bytes.readUInt16LE(pos + 22);
        } else if (id === 'data') {
            if (bits !== 16) throw new Error(`16bit ではない WAV です (${bits}bit)`);
            const end = Math.min(bytes.length, pos + 8 + size);
            let peak = 0;
            for (let i = pos + 8; i + 1 < end; i += 2) peak = Math.max(peak, Math.abs(bytes.readInt16LE(i)));
            return { seconds: (end - pos - 8) / 2 / channels / sampleRate, peak: peak / 32768, sampleRate, channels };
        }
        pos += 8 + size + (size % 2);
    }
    throw new Error('WAV に data が在りません');
}

/** ジョブの API (docs/jobs.md) のパスと種類。 */
const JOB_KINDS: Record<string, string> = {
    '/api/chart': 'chart', '/api/chart/regrid': 'chart_regrid', '/api/decompose': 'decompose',
    '/api/analyze': 'analyze', '/api/separate': 'separate', '/api/deep-separate': 'deep_separate',
};

/**
 * 時間のかかる API (`?async=1` でジョブとして始める) の応答を差し替える。始めると 202 でジョブを返し、
 * 状態を聞かれたら「終わった」と `result()` の結果を返す。差し替えは画面を開く前に仕掛ける。
 *
 * @param path - API のパス (`/api/chart` など)
 * @param result - ジョブの結果 (待つ呼び方の応答の本文と同じ形)
 * @param onStart - 始めるリクエストを受け取ったとき (送られた中身を確かめるのに使う)
 */
export async function fakeJob(page: Page, path: string, result: () => unknown, onStart?: (request: Request) => void): Promise<void> {
    const kind = JOB_KINDS[path] ?? 'chart';
    const results = new Map<string, unknown>();
    const job = (id: string, state: string, extra: object = {}) => ({
        id, kind, title: 'テスト用のジョブ', filename: 'song', state, cancel_requested: false, stage: null, stage_key: null,
        stage_index: null, stage_count: 1, progress: null, elapsed_sec: 0, error: null, result: null, ...extra,
    });
    await page.route((url) => url.pathname === path, (route) => {
        if (route.request().method() !== 'POST') return route.fallback();
        onStart?.(route.request());
        const id = `fake-${kind}-${results.size + 1}`;
        results.set(id, result());
        return route.fulfill({ status: 202, json: job(id, 'running') });
    });
    await page.route((url) => url.pathname.startsWith(`/api/jobs/fake-${kind}-`), (route) => {
        const id = decodeURIComponent(new URL(route.request().url()).pathname.split('/').pop() ?? '');
        if (!results.has(id)) return route.fallback();
        return route.fulfill({ json: job(id, 'done', { result: results.get(id) }) });
    });
}

/**
 * 時間のかかる API をジョブとして始める操作をして、ジョブが終わるまで待ち、最後の状態を返す。
 *
 * @param path - API のパス (`/api/chart` など)
 * @param action - ジョブを始める操作 (ボタンを押す、ファイルを選ぶ)
 */
export async function runJob(page: Page, path: string, action: () => Promise<void>, timeout = 60_000): Promise<{ state: string; result: unknown; id: string }> {
    const started = page.waitForResponse((r) => new URL(r.url()).pathname === path && r.request().method() === 'POST', { timeout });
    await action();
    const response = await started;
    if (response.status() !== 202) throw new Error(`ジョブが始まりませんでした (${response.status()}): ${await response.text()}`);
    const { id } = await response.json();
    const finished = await page.waitForResponse(async (r) => {
        if (new URL(r.url()).pathname !== `/api/jobs/${id}`) return false;
        const state = (await r.json().catch(() => ({}))).state;
        return state === 'done' || state === 'error' || state === 'cancelled';
    }, { timeout });
    return finished.json();
}

/**
 * テスト用の、わざと遅いジョブを API サーバで直接始める (backend/web/e2e_routes.py。BUNRI_E2E_HOOKS=1 のときだけ在る)。
 * 名前とステージは本物の種類と同じ。
 */
export async function startSlowJob(page: Page, kind: string, seconds: number, filename = 'e2e-slow.wav') {
    const response = await page.request.post(`/api/e2e/slow-job?kind=${kind}&seconds=${seconds}&filename=${encodeURIComponent(filename)}`);
    if (response.status() !== 202) throw new Error(`遅いジョブを始められませんでした (${response.status()}): ${await response.text()}`);
    return response.json() as Promise<{ id: string; title: string }>;
}

/** 動いているジョブがあれば中止して、終わるまで待つ (ほかのテストに持ち越さない)。 */
export async function cancelActiveJobs(page: Page): Promise<void> {
    for (let i = 0; i < 100; i++) {
        const { active } = await (await page.request.get('/api/jobs')).json();
        if (!active) return;
        await page.request.post(`/api/jobs/${active.id}/cancel`);
        await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('ジョブが止まりませんでした');
}
