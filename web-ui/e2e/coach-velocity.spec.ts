/**
 * 差分チェックの「強さの違い」を、画面から通す。
 *
 * 強さ (ベロシティ) を比べるのは、お手本が MIDI ファイルから読み込んだもののときだけ。音源から採譜した
 * お手本 (と、出どころの分からないお手本) では、強さの欄そのものを出さない (docs/coach-diff-design.md「強さの違い」)。
 *
 * MIDI のお手本は、強さつきの MIDI ファイルを「お手本として読み込む」で作る。採譜のお手本は数分かかるので、
 * お手本入りのプロジェクトを API で保存して、以前の形式として開く (出どころの分からないお手本になる)。
 * 本物の Claude は呼ばない (偽の Claude サーバは、強さの事実が届いたら、強さの点を 1 つ足して返す)。
 */
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { notesToMidi } from '../src/lib/midi';
import { FAKE_LLM_URL, openDaw, openNewestLegacy, openTab, startFree, statusText } from './helpers';

const note = (name: string, octave: number, step: number, velocity?: number, length = 4) =>
    ({ note: name, octave, step, length, ...(velocity === undefined ? {} : { velocity }) });

/** 2 小節の 8 ノート (4 分音符)。強さは `velocities` を順に繰り返す。 */
const PITCHES: [string, number][] = [['C', 4], ['E', 4], ['G', 4], ['C', 5], ['A', 4], ['E', 4], ['A', 4], ['G', 4]];
const phrase = (velocities: number[]) => PITCHES.map(([name, octave], i) => note(name, octave, i * 4, velocities[i % velocities.length]));

const midiFile = (tracks: { name: string; notes: ReturnType<typeof note>[] }[]) => ({
    name: 'song.mid', mimeType: 'audio/midi', buffer: Buffer.from(notesToMidi(tracks, 120)),
});

const coach = (page: Page) => page.locator('#coach-panel');
const strength = (page: Page) => page.getByRole('region', { name: '強さの違い' });

/** MIDI ファイルを選び、トラックごとの読み込み方を決めて読み込む。 */
async function importMidi(page: Page, file: ReturnType<typeof midiFile>, modes: Record<string, 'track' | 'reference' | 'skip'>) {
    await openDaw(page);
    await startFree(page, 1);
    await openTab(page, 'ファイル');
    await page.locator('#file-midi').setInputFiles(file);
    for (const [track, mode] of Object.entries(modes)) await page.getByLabel(`「${track}」の読み込み方`).selectOption(mode);
    await page.locator('#midi-import').getByRole('button', { name: '読み込む', exact: true }).click();
    await expect(statusText(page)).toContainText('song.mid から');
}

/** 差分の段を開き、打ち込みのトラックを選んで比べる。説明を探し終わるまで待つ。 */
async function compareWith(page: Page, attempt: string) {
    await openTab(page, '差分');
    await coach(page).getByLabel('比べる打ち込み').selectOption({ label: attempt });
    const saved = page.waitForResponse((r) => r.url().endsWith('/api/coach/explain/saved'));
    const diff = page.waitForRequest((r) => r.url().endsWith('/api/coach/diff'));
    await coach(page).getByRole('button', { name: 'お手本と比べる' }).click();
    const sent = JSON.parse((await diff).postData() ?? '{}');
    expect((await saved).ok()).toBe(true);
    return sent;
}

/** ブラウザごとに違う数 (説明の保存がブラウザをまたいで使われないように)。 */
const variantOf = (testInfo: TestInfo) => (testInfo.project.name === 'webkit' ? 1 : 0);

test('MIDI のお手本では、強さの違いがまとまりで出る。押すとノートが選ばれ、強さを直して比べ直すと消える', async ({ page }) => {
    // お手本は強さ 100、打ち込みは強さ 50 (高さ・位置・長さは同じ)
    await importMidi(page, midiFile([{ name: 'Lead', notes: phrase([100]) }, { name: 'Mine', notes: phrase([50]) }]),
        { Lead: 'reference', Mine: 'track' });
    const sent = await compareWith(page, 'Mine（8 ノート）');
    expect(sent.reference_source).toBe('midi');

    // 一致率と、位置・高さ・長さの指摘は、強さに左右されない
    await expect(coach(page).getByText('100%', { exact: true })).toBeVisible();
    await expect(coach(page).getByText('高さ・位置・長さは、お手本どおりです。')).toBeVisible();
    await expect(coach(page).getByRole('list', { name: '指摘の一覧' })).toHaveCount(0);

    await expect(strength(page)).toContainText('MIDI ファイルから読み込んだお手本なので、強さも比べています。');
    await expect(strength(page)).toContainText('合った 8 ノートの強さを比べました（お手本より弱い 8）');
    const finding = strength(page).getByRole('button', { name: /^全体に弱い: 合った 8 ノートのうち 8 ノートが、お手本より弱くなっています（強さの差は 50 ほど）$/ });
    await expect(finding).toBeVisible();
    // 違うのは強さだけなので、Claude は呼ばずに、強さの欄へ案内する
    await expect(coach(page).getByText(/次は「強さの違い」の欄を見て/)).toBeVisible();
    await expect(coach(page).getByText(/違うのは強さだけで、上の「強さの違い」を読めば足りるので、Claude は呼んでいません/)).toBeVisible();
    await test.info().attach('coach-velocity', { body: await coach(page).screenshot(), contentType: 'image/png' });

    // まとまりを押すと、比べたトラックがピアノロールに開き、当たるノートが選ばれる
    await finding.click();
    await expect(page.locator('#piano-roll-area .area-label')).toContainText('Mine');
    await expect(page.locator('#velocity-note')).toContainText('（8 ノート）');
    await expect(page.locator('#velocity-input')).toHaveValue('50');

    // 「強さ」の欄で直して比べ直すと、強さの違いは消える
    await page.locator('#velocity-input').fill('100');
    await page.locator('#velocity-input').press('Enter');
    await compareWith(page, 'Mine（8 ノート）');
    await expect(strength(page)).toContainText('どれも、お手本と合っています（差が 16 以内）');
    await expect(strength(page).getByRole('button')).toHaveCount(0);
    await expect(coach(page).getByText('お手本どおりです。', { exact: true })).toBeVisible();
});

test('採譜のお手本 (出どころの分からないお手本) では、強さが大きく違っても、強さの欄を出さない', async ({ page, request }) => {
    // お手本入りのプロジェクトを以前の形式で保存して開く (MIDI ファイルから読み込んだお手本ではない)
    const project = {
        bpm: 120, beatsPerBar: 4,
        tracks: [{ name: 'Track 1', pianoNotes: phrase([20]), referenceNotes: phrase([120, 96, 60, 96]) }],
        automation: {},
    };
    expect((await request.post('/api/project/save', { form: { data: JSON.stringify(project) } })).ok()).toBe(true);
    await openDaw(page);
    await openNewestLegacy(page);

    const response = page.waitForResponse((r) => r.url().endsWith('/api/coach/diff'));
    const sent = await compareWith(page, 'Track 1（8 ノート）');
    expect(sent.reference_source).toBeUndefined();
    expect((await (await response).json()).velocity).toBeNull();

    await expect(coach(page).getByText('100%', { exact: true })).toBeVisible();
    await expect(coach(page).getByText('お手本どおりです。', { exact: true })).toBeVisible();
    await expect(strength(page)).toHaveCount(0);
    await expect(coach(page)).not.toContainText('強さ');
});

test('強さの違いは、Claude の説明の材料にもなる (MIDI のお手本のときだけ)', async ({ page }, testInfo) => {
    // お手本は 1 拍目と 3 拍目が強い。打ち込みは、2 小節目の 3 ノートを抜かし (指摘 3 件)、強さは全部同じ
    const extra = note('DF'[variantOf(testInfo)], 3, 28, 96);
    const mine = [...phrase([96]).slice(0, 5), extra];
    await importMidi(page, midiFile([{ name: 'Lead', notes: phrase([120, 60]) }, { name: 'Mine', notes: mine }]),
        { Lead: 'reference', Mine: 'track' });
    const before = (await (await page.request.get(`${FAKE_LLM_URL}/__calls`)).json()).explain;
    await compareWith(page, 'Mine（6 ノート）');
    await expect(coach(page).getByText('抜け 3 / 余分なノート 1')).toBeVisible();
    await expect(strength(page).getByRole('button', { name: /^強弱が付いていません: 打ち込みの強さは 96 で一定ですが、お手本は 60〜120 の幅があります$/ })).toBeVisible();

    await coach(page).getByRole('button', { name: 'Claude に説明してもらう' }).click();
    const points = coach(page).getByRole('list', { name: '見直すとよい点' }).locator(':scope > li');
    // 偽の Claude は、強さの事実が届いたときだけ、3 つ目の点 (強さ) を返す
    await expect(points).toHaveCount(3);
    await expect(points.nth(2)).toContainText('強さを見直す');
    await expect(points.nth(2)).toContainText('1 小節目から、強さがお手本と違っています（まとまり 1 個）');
    expect((await (await page.request.get(`${FAKE_LLM_URL}/__calls`)).json()).explain).toBe(before + 1);
    // 強さだけが違う小節 (1 小節目) への札も、落とされずに出る
    await expect(points.nth(2).getByRole('button', { name: '1 小節' })).toBeVisible();
});

test('練習画面でも、MIDI のお手本と比べると強さの違いが出て、押すとそのノートが光る', async ({ page }) => {
    // お手本は 1 小節の 4 ノート。1 つ目が強く、3 つ目が弱い
    const lead = phrase([120, 96, 60, 96]).slice(0, 4);
    await importMidi(page, midiFile([{ name: 'Lead', notes: lead }]), { Lead: 'reference' });
    await openTab(page, '学ぶ');
    await page.locator('#part-list li').filter({ hasText: 'Lead' }).getByRole('button', { name: '「Lead」を練習する' }).click();
    await expect(page.getByRole('region', { name: '練習画面' })).toBeVisible();
    await expect(page.locator('#note-layer .note-ghost')).toHaveCount(lead.length);

    // お手本をなぞって、マウスでノートを置く (強さを持たないノートになる)
    for (let i = 0; i < lead.length; i++) {
        const g = (await page.locator('#note-layer .note-ghost').nth(i).boundingBox())!;
        await page.mouse.dblclick(g.x + 4, g.y + g.height / 2);
        await expect(page.locator('#note-layer .note-block')).toHaveCount(i + 1);
    }
    await page.getByRole('button', { name: '比べる', exact: true }).click();
    await expect(page.getByTestId('match-rate')).toHaveText('100%');

    const side = page.locator('#practice-side');
    await expect(side.getByText('この範囲の高さ・位置・長さは、お手本どおりです。')).toBeVisible();
    const finding = side.getByRole('button', { name: /^強弱が付いていません: 打ち込みの強さは 96 で一定ですが、お手本は 60〜120 の幅があります$/ });
    await expect(finding).toBeVisible();
    await expect(side).toContainText('マウスで置いたノートは強さを持たないので、96 として比べています。');
    await test.info().attach('practice-velocity', { body: await side.screenshot(), contentType: 'image/png' });

    // 押すと、強さの違う 2 ノート (1 つ目と 3 つ目) が選ばれて光る。お手本の側も光る
    await finding.click();
    await expect(finding).toHaveAttribute('aria-current', 'true');
    await expect(page.locator('#note-layer .note-block.flash')).toHaveCount(2);
    await expect(page.locator('#note-layer .note-ghost.flash')).toHaveCount(2);
    await expect(page.locator('#velocity-note')).toContainText('（2 ノート）');

    // 強さを変えると「もう一度比べて」になる (強さも、比べたノートの一部)
    await page.locator('#velocity-input').fill('110');
    await page.locator('#velocity-input').press('Enter');
    await expect(side.getByText('ノートを変えたので、もう一度比べてください')).toBeVisible();
    await expect(side.getByRole('region', { name: '強さの違い' })).toHaveCount(0);
});
