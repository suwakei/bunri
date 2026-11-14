/**
 * プロジェクトのファイル (.bunri): 学ぶ流れの途中を保存して、画面を開き直して開くと、そのまま続きができる。
 * 保存していない変更の印と確かめ、以前の形式 (projects/*.json) を開く、学習の記録、データの整理。
 *
 * 開発用のブラウザ起動なので、保存先はデータ置き場の projects/ (名前を尋ねられる)。デスクトップ版のダイアログと
 * 窓を閉じる前の確かめは、本物の窓のテスト (e2e-desktop/project.test.ts) と Rust のテストで見る。
 *
 * カルテとガイドは本物の API (Claude は偽のサーバ)。パート分離だけ応答を差し替える (数分かかり、モデルも要る)。
 */
import { expect, test, type Page } from '@playwright/test';
import { FAKE_LLM_URL, fakeJob, importSong, makeWav, openDaw, openNewestLegacy, openProject, openTab, runJob, saveProject, statusText, trackSummary } from './helpers';

test.skip(Boolean(process.env.BUNRI_E2E_LLM), '偽の Claude サーバを相手にするテスト。本物を呼ぶ BUNRI_E2E_LLM=1 のときは走らせない');

const note = (name: string, octave: number, step: number, length = 4) => ({ note: name, octave, step, length });
const BASS = [note('C', 3, 0), note('E', 3, 4), note('G', 3, 8)];

/** Claude (偽) を呼んだ回数 (ガイドと説明)。 */
async function llmCalls(page: Page): Promise<{ messages: number; explain: number }> {
    return (await page.request.get(`${FAKE_LLM_URL}/__calls`)).json();
}

/** パート分離の応答を差し替える (ベースだけ。音声は 4 秒の WAV)。 */
async function fakeParts(page: Page) {
    await fakeJob(page, '/api/decompose', () => ({
        bpm: 0,
        stems: { bass: { audio_url: '/api/download/decompose_bass_project.wav', notes: BASS, drum_events: [], gm_program: null, mix: { volume_db: -2, pan: 0.25, reverb_wet: 0 } } },
    }));
    await page.route('**/api/download/decompose_bass_project.wav', (route) => route.fulfill({ contentType: 'audio/wav', body: makeWav(4, [130.81]) }));
}

/** お手本の i 番目のノートをなぞって置く (ピアノロールで練習のトラックを開いている前提)。 */
async function traceGhost(page: Page, index: number) {
    const ghost = page.locator('#note-layer .note-ghost').nth(index);
    // ピアノロールがお手本の高さまでスクロールし終わるのを待つ (位置が 2 回続けて同じになるまで)
    let box = (await ghost.boundingBox())!;
    for (let i = 0; i < 20; i++) {
        await page.waitForTimeout(100);
        const next = (await ghost.boundingBox())!;
        if (next.x === box.x && next.y === box.y) break;
        box = next;
    }
    const before = await page.locator('#note-layer .note-block').count();
    await page.mouse.dblclick(box.x + Math.min(10, box.width / 2), box.y + box.height / 2);
    await expect(page.locator('#note-layer .note-block')).toHaveCount(before + 1);
}

test('学ぶ流れの途中を保存し、画面を開き直して開くと、トラック・ノート・お手本・カルテ・ガイド・差分・学習の記録が戻る。Claude は呼ばない', async ({ page }, testInfo) => {
    const filename = `e2e-project-${testInfo.project.name}-${Date.now()}.wav`;
    await fakeParts(page);
    await openDaw(page);
    const analyzed = await runJob(page, '/api/chart', () => importSong(page, {
        name: filename, mimeType: 'audio/wav', buffer: makeWav(16, [261.63, 196.0, 220.0, 174.61, 261.63, 196.0, 220.0, 174.61]),
    }));
    expect(analyzed.state).toBe('done');
    await expect(statusText(page)).toContainText('カルテを作りました');
    // 題名に、まだ名前の無いプロジェクトと、保存していない変更のしるし
    await expect(page.locator('#project-title')).toHaveText('無題のプロジェクト●');
    await expect(page.locator('#project-title .unsaved-mark')).toHaveCount(1);
    expect(await page.title()).toBe('無題のプロジェクト ● — bunri');

    // ガイドを作る (Claude を 1 回呼ぶ)
    const before = await llmCalls(page);
    await openTab(page, 'ガイド');
    await page.locator('#guide-panel').getByRole('button', { name: 'ガイドを作る' }).click();
    await expect(page.locator('#guide-panel ol > li')).toHaveCount(3);

    // パートに分けて、ベースを練習する
    await openTab(page, '曲とパート');
    await page.getByRole('button', { name: /パートに分けて採譜する/ }).click();
    await expect(statusText(page)).toContainText('パートに分けました');
    await page.locator('#part-list').getByRole('button', { name: '「ベース」を練習する' }).click();
    await expect(page.locator('#note-layer .note-ghost')).toHaveCount(BASS.length);
    // 練習画面が開く。このテストは差分チェックの段で比べるので、アレンジに戻る
    await page.getByRole('button', { name: '← アレンジに戻る' }).click();

    // 1 つ置いて比べ、もう 1 つ置いて比べる。学習の記録に 2 回ぶん残り、前回との差が出る
    await traceGhost(page, 0);
    await openTab(page, '差分');
    const coach = page.locator('#coach-panel');
    await coach.getByRole('button', { name: 'お手本と比べる' }).click();
    await expect(coach.locator('#learn-history')).toContainText('一致 33%');
    await expect(coach.locator('#learn-history')).toContainText('はじめての記録');
    await traceGhost(page, 1);
    await coach.getByRole('button', { name: 'お手本と比べる' }).click();
    await expect(coach.locator('#learn-history')).toContainText('一致 67%');
    await expect(coach.locator('#learn-history')).toContainText('前回より +34%');
    await expect(coach.getByRole('list', { name: '最近の比較' }).locator('li')).toHaveCount(2);

    const name = await saveProject(page, `学ぶ流れ-${testInfo.project.name}-${Date.now()}`);
    await expect(page.locator('#project-title')).toHaveText(name);
    expect(await page.title()).toBe(`${name} — bunri`);
    const calls = await llmCalls(page);
    expect(calls.messages).toBe(before.messages + 1);

    // 画面を開き直す (トラックもカルテも無い)
    await page.reload();
    await page.getByText('準備完了').waitFor();
    await expect(page.locator('#empty-state')).toBeVisible();
    // 空の状態に、最近使ったプロジェクトとして出る
    await expect(page.locator('#empty-state').getByRole('list', { name: '最近使ったプロジェクト' })).toContainText(name);
    await openProject(page, name);

    expect((await trackSummary(page)).map((t) => t.name)).toEqual(['原曲', 'ベース', 'ベースの練習']);
    expect((await trackSummary(page))[0].clips).toEqual([filename]);
    await expect(page.locator('#project-title')).toHaveText(name);
    // ピアノロールは練習のトラックを開いていて、お手本が重なり、置いた 2 つのノートが在る
    await expect(page.locator('#piano-roll-area .area-label')).toContainText('ベースの練習');
    await expect(page.locator('#note-layer .note-ghost')).toHaveCount(BASS.length);
    await expect(page.locator('#note-layer .note-block')).toHaveCount(2);
    // パートのミュートと音量・パンも戻る
    await expect(page.getByRole('slider', { name: '「ベース」の音量' })).toHaveAttribute('aria-valuetext', '−2.0 dB');
    // 差分の段: 最後に比べた結果と、学習の記録
    await expect(page.getByRole('tab', { name: '差分' })).toHaveAttribute('aria-selected', 'true');
    await expect(coach.locator('#learn-history')).toContainText('前回より +34%');
    await expect(coach.getByText(/が合っています/)).toBeVisible();
    // 進み具合: ⑤ まで済み
    for (const key of ['import', 'chart', 'separate', 'practice', 'diff']) {
        await expect(page.locator(`#learn-progress [data-step="${key}"]`)).toHaveAttribute('data-state', 'done');
    }
    // カルテとガイド (保存済みとして出る。解析も Claude も呼ばない)
    await openTab(page, 'カルテ');
    await expect(page.locator('#chart-panel')).toBeVisible();
    await openTab(page, 'ガイド');
    await expect(page.locator('#guide-panel ol > li')).toHaveCount(3);
    await expect(page.getByText(/このガイドは保存済みです/)).toBeVisible();
    expect(await llmCalls(page)).toEqual(calls);
    // 開いた直後は、保存していない変更は無い。元に戻す履歴も、前のプロジェクトのものは無い
    await expect(page.locator('#project-title .unsaved-mark')).toHaveCount(0);
    await expect(page.locator('#btn-undo')).toBeDisabled();
    await testInfo.attach('reopened', { body: await page.screenshot(), contentType: 'image/png' });

    // 保存し直しても、音声は送り直さない (開いた写しに在るので)
    const puts: string[] = [];
    page.on('request', (r) => { if (r.method() === 'PUT' && r.url().includes('/api/project/audio/')) puts.push(r.url()); });
    await page.locator('#tracks-container .track-name').first().click();
    await page.locator('#note-layer').dblclick({ position: { x: 10, y: 100 } });
    await expect(page.locator('#project-title .unsaved-mark')).toHaveCount(1);
    await saveProject(page);
    expect(puts).toEqual([]);
});

test('保存していない変更があると、開く・新しいプロジェクトの前に確かめる。キャンセルすればそのまま、保存しないなら捨てる', async ({ page }, testInfo) => {
    await openDaw(page);
    await page.getByRole('button', { name: '自由に作る' }).click();
    const name = await saveProject(page, `確かめ-${testInfo.project.name}-${Date.now()}`);
    await expect(page.locator('#project-title .unsaved-mark')).toHaveCount(0);
    await page.locator('#tracks-container .track-name').first().click();
    await page.locator('#note-layer').dblclick({ position: { x: 10, y: 100 } });
    await expect(page.locator('#project-title .unsaved-mark')).toHaveCount(1);
    // 元に戻して保存したときと同じになれば、しるしは消える
    await page.keyboard.press('ControlOrMeta+z');
    await expect(page.locator('#project-title .unsaved-mark')).toHaveCount(0);
    await page.keyboard.press('ControlOrMeta+Shift+z');
    await expect(page.locator('#project-title .unsaved-mark')).toHaveCount(1);

    // 新しいプロジェクト → キャンセル: そのまま
    await page.getByRole('button', { name: 'プロジェクトのメニュー' }).click();
    await page.getByRole('menuitem', { name: '新しいプロジェクト' }).click();
    const guard = page.getByRole('alertdialog', { name: '保存していない変更があります' });
    await expect(guard).toContainText('新しいプロジェクトにする前に');
    await guard.getByRole('button', { name: 'キャンセル' }).click();
    await expect(guard).toHaveCount(0);
    await expect(page.locator('#note-layer .note-block')).toHaveCount(1);

    // 開く → 保存しない: 捨てて、保存した内容 (ノート無し) を開く
    await page.getByRole('button', { name: '開く', exact: true }).click();
    await page.getByRole('dialog', { name: 'プロジェクトを開く' }).locator('.project-entry-open', { hasText: name }).first().click();
    await guard.getByRole('button', { name: '保存しない' }).click();
    await expect(statusText(page)).toContainText(`プロジェクト「${name}」を開きました`);
    await expect(page.locator('#tracks-container .track-row').first().locator('.notes-badge')).toHaveCount(0);

    // 新しいプロジェクト → 保存: 保存してから空にする (⌘S でも保存できる)
    await page.locator('#tracks-container .track-name').first().click();
    await page.locator('#note-layer').dblclick({ position: { x: 10, y: 100 } });
    await page.getByRole('button', { name: 'プロジェクトのメニュー' }).click();
    await page.getByRole('menuitem', { name: '新しいプロジェクト' }).click();
    await guard.getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.locator('#empty-state')).toBeVisible();
    await expect(page.locator('#project-title')).toHaveText('無題のプロジェクト');
    await openProject(page, name);
    await expect(page.locator('#tracks-container .track-row').first().locator('.notes-badge')).toHaveText('1');
});

test('以前の形式のプロジェクトは一覧に「以前の形式」と出て開ける。音声の無いクリップは示され、読み込み直せる。保存すると .bunri になる', async ({ page, request }, testInfo) => {
    const legacy = {
        bpm: 90, beatsPerBar: 3,
        tracks: [{ name: 'Rec', gain: -6, pan: 0, mute: false, pianoNotes: [note('C', 4, 0)], clips: [{ name: 'take.wav', offset: 1, duration: 2 }] }],
    };
    expect((await request.post('/api/project/save', { form: { data: JSON.stringify(legacy) } })).ok()).toBe(true);
    await openDaw(page);
    await page.getByRole('button', { name: '開く', exact: true }).click();
    const list = page.getByRole('dialog', { name: 'プロジェクトを開く' });
    await expect(list.locator('.project-badge', { hasText: '以前の形式' }).first()).toBeVisible();
    await list.getByRole('button', { name: 'キャンセル' }).click();
    await openNewestLegacy(page);
    await expect(statusText(page)).toContainText('以前の形式のプロジェクト');
    await expect(page.locator('#project-title')).toContainText('（以前の形式）');
    await expect(page.locator('#transport-bpm')).toHaveValue('90');
    expect(await trackSummary(page)).toEqual([{ name: 'Rec', clips: ['take.wav'] }]);

    const bar = page.getByRole('region', { name: '音声の無いクリップ' });
    await expect(bar).toContainText('音声の無いクリップが 1 個あります');
    await testInfo.attach('missing-audio', { body: await page.screenshot(), contentType: 'image/png' });
    await bar.getByLabel('「Rec」の「take.wav」に読み込む音声のファイル').setInputFiles({ name: 'take.wav', mimeType: 'audio/wav', buffer: makeWav(2, [440]) });
    await expect(statusText(page)).toContainText('「take.wav」の音声を読み込み直しました');
    await expect(bar).toHaveCount(0);

    // 保存すると .bunri になる (以前の形式のファイルは消さない)
    const name = await saveProject(page, `以前の形式から-${testInfo.project.name}-${Date.now()}`);
    await expect(page.locator('#project-title')).toHaveText(name);
    const library = await (await request.get('/api/project/library')).json() as { projects: { name: string; kind: string }[] };
    expect(library.projects.find((p) => p.name === name)?.kind).toBe('bunri');
    expect(library.projects.some((p) => p.kind === 'legacy')).toBe(true);
    // 開き直すと、読み込み直した音声も入っている
    await page.reload();
    await page.getByText('準備完了').waitFor();
    await openProject(page, name);
    await expect(page.getByRole('region', { name: '音声の無いクリップ' })).toHaveCount(0);
    expect(await trackSummary(page)).toEqual([{ name: 'Rec', clips: ['take.wav'] }]);
});

test('データの整理: 置き場の使用量が出て、一時ファイルを整理できる', async ({ page }) => {
    await openDaw(page);
    await openTab(page, 'ファイル');
    const section = page.locator('#data-cleanup');
    await expect(section.getByRole('heading', { name: 'データの整理' })).toBeVisible();
    await expect(section.locator('.usage-table')).toContainText('作業中のプロジェクトの写し');
    await expect(section.locator('.usage-table')).toContainText('保存したガイドと説明');
    await section.getByRole('button', { name: '一時ファイルを整理する' }).click();
    await expect(section.getByRole('status')).toContainText(/一時ファイルを \d+ 個消しました|消せる一時ファイルはありませんでした/);
});
