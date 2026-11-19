/**
 * 動きの記録（lib/activity.ts、lib/activity-setup.ts、components/ActivityPanel.tsx）のテスト。
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import * as matchers from '@testing-library/jest-dom/matchers';
import {
    MAX_ENTRIES, activityEntries, describeApiPath, describeChange, describeElement, describeKey, formatActivityTime,
    recordActivity, resetActivityForTest, setActivityForward, subscribeActivity, tagLabel,
} from '../lib/activity';
import { installActivityListeners } from '../lib/activity-setup';
import { apiFetch } from '../lib/api';
import ActivityButton from '../components/ActivityPanel';

expect.extend(matchers);

/** いまの記録を「札: 文」の並びにする。 */
const lines = () => activityEntries().map((e) => `${e.tag}: ${e.message}`);

beforeEach(() => {
    resetActivityForTest();
    document.body.innerHTML = '';
});
afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
});

describe('記録の入れ物', () => {
    it('起きた順に並び、増えるたびに知らせる', () => {
        const heard = vi.fn();
        const stop = subscribeActivity(heard);
        recordActivity('click', 'ボタン「再生」');
        recordActivity('status', '再生中');
        expect(lines()).toEqual(['click: ボタン「再生」', 'status: 再生中']);
        expect(heard).toHaveBeenCalledTimes(2);
        // 増えるたびに、新しい配列になる (画面が変わったことを見分けられる)
        const before = activityEntries();
        recordActivity('status', '停止');
        expect(activityEntries()).not.toBe(before);
        stop();
        recordActivity('status', 'もう聞いていない');
        expect(heard).toHaveBeenCalledTimes(3);
    });

    it('決まった行数を超えたら、古いものから捨てる', () => {
        for (let i = 0; i < MAX_ENTRIES + 5; i++) recordActivity('status', `行 ${i}`);
        const all = activityEntries();
        expect(all).toHaveLength(MAX_ENTRIES);
        expect(all[0].message).toBe('行 5');
        expect(all[all.length - 1].message).toBe(`行 ${MAX_ENTRIES + 4}`);
    });

    it('送り先が在れば 1 行ごとに送る。ネイティブ側から届いた行は、送り返さない', () => {
        const forward = vi.fn();
        setActivityForward(forward);
        recordActivity('click', 'ボタン「保存」');
        recordActivity('midi-in', 'SMK25: note-on ch1 60(C4) vel 96', { local: true });
        expect(forward.mock.calls).toEqual([['click', 'ボタン「保存」']]);
        expect(lines()).toHaveLength(2);
    });

    it('送り先や聞き手が失敗しても、呼び出した側には伝えない', () => {
        setActivityForward(() => { throw new Error('書けない'); });
        expect(() => recordActivity('status', 'a')).not.toThrow();
    });

    it('同じエラーが続けて来たら、最初の 1 行と回数にまとめる', () => {
        const forward = vi.fn();
        setActivityForward(forward);
        for (let i = 0; i < 50; i++) recordActivity('error', 'x is not defined');
        expect(lines()).toEqual(['error: x is not defined']);
        // 別の行が来たところで、何回続いたかを 1 行で残す
        recordActivity('click', 'ボタン「停止」');
        recordActivity('error', 'x is not defined');
        expect(lines()).toEqual([
            'error: x is not defined',
            'error: （同じエラーが、さらに 49 回続きました）',
            'click: ボタン「停止」',
            'error: x is not defined',
        ]);
        expect(forward).toHaveBeenCalledTimes(4);
        // エラー以外は、同じ行が続いてもまとめない (同じボタンを 2 回押した、は 2 行)
        recordActivity('click', 'ボタン「再生」');
        recordActivity('click', 'ボタン「再生」');
        expect(lines().slice(-2)).toEqual(['click: ボタン「再生」', 'click: ボタン「再生」']);
    });

    it('札の呼び名と、時刻の形', () => {
        expect(tagLabel('agent')).toBe('アシスタント');
        expect(tagLabel('midi-in')).toBe('MIDI 受信');
        expect(tagLabel('unknown')).toBe('unknown');
        expect(formatActivityTime(new Date(2026, 10, 18, 9, 5, 7, 42).getTime())).toBe('09:05:07.042');
    });
});

describe('操作を文にする', () => {
    it('ボタンは、中の要素を押しても外側のボタンの名前で出す', () => {
        document.body.innerHTML = '<button><span id="icon">▶</span> 再生</button><button aria-label="トラックを追加">＋</button>';
        expect(describeElement(document.querySelector('#icon')!)).toBe('ボタン「▶ 再生」');
        expect(describeElement(document.querySelector('[aria-label]')!)).toBe('ボタン「トラックを追加」');
    });

    it('操作の対象でない要素は、タグと id・クラスで示す', () => {
        document.body.innerHTML = '<canvas id="note-layer"></canvas><div class="track-row selected"></div><p></p>';
        expect(describeElement(document.querySelector('canvas')!)).toBe('canvas#note-layer');
        expect(describeElement(document.querySelector('div')!)).toBe('div.track-row');
        expect(describeElement(document.querySelector('p')!)).toBe('p');
    });

    it('選択肢・チェック・数値は、選んだものを載せる', () => {
        document.body.innerHTML = `
            <select aria-label="録り方"><option value="off">録らない</option><option value="step" selected>ステップ入力</option></select>
            <label><input type="checkbox" checked> 録音前にカウント</label>
            <input type="number" aria-label="遅れの補正（ミリ秒）" value="25">`;
        expect(describeChange(document.querySelector('select')!)).toBe('選択肢「録り方」 → ステップ入力');
        expect(describeChange(document.querySelector('[type=checkbox]')!)).toBe('チェック「録音前にカウント」 → オン');
        expect(describeChange(document.querySelector('[type=number]')!)).toBe('入力欄「遅れの補正（ミリ秒）」 → 25');
    });

    it('文字を打つ欄は、値を載せない (API キーや打った文を残さない)', () => {
        document.body.innerHTML = '<input type="password" aria-label="API キー" value="sk-ant-secret"><input type="text" aria-label="プロジェクトの名前" value="わたしの曲"><textarea aria-label="メモ">ひみつ</textarea>';
        for (const el of Array.from(document.querySelectorAll('input, textarea'))) {
            const text = describeChange(el);
            expect(text).toContain('値は記録しません');
            expect(text).not.toMatch(/sk-ant|わたしの曲|ひみつ/);
        }
    });

    it('ラベルで包んだ欄の名前に、欄の中身 (打った文、選択肢) を入れない', () => {
        document.body.innerHTML = '<label>メモ <textarea>ひみつの文</textarea></label><label>音色 <select><option>ピアノ</option><option>ベース</option></select></label>';
        expect(describeElement(document.querySelector('textarea')!)).toBe('入力欄「メモ」');
        expect(describeChange(document.querySelector('textarea')!)).not.toContain('ひみつ');
        expect(describeChange(document.querySelector('select')!)).toBe('選択肢「音色」 → ピアノ');
    });

    it('API の呼び出し先は、接続先を外して、トークンを落とす', () => {
        expect(describeApiPath('/api/chart?async=1')).toBe('/api/chart?async=1');
        expect(describeApiPath('http://127.0.0.1:51234/api/download/a.wav?token=SECRET')).toBe('/api/download/a.wav');
        expect(describeApiPath('http://127.0.0.1:51234/api/x?a=1&token=SECRET&b=2')).toBe('/api/x?a=…&b=…');
        // クエリの値は載せない (ファイルの名前などが入る)。処理の始め方 (async) だけは残す
        expect(describeApiPath('/api/project/audio/abc?name=わたしの曲.wav')).toBe('/api/project/audio/abc?name=…');
        expect(describeApiPath('/api/separate?async=1&model=htdemucs')).toBe('/api/separate?async=1&model=…');
    });

    it('キーは、修飾キーつきの名前にする。修飾キーだけなら出さない', () => {
        expect(describeKey({ key: ' ' })).toBe('Space');
        expect(describeKey({ key: 'z', metaKey: true, shiftKey: true })).toBe('⌘+Shift+Z');
        expect(describeKey({ key: 'Escape' })).toBe('Escape');
        expect(describeKey({ key: 'Shift', shiftKey: true })).toBeNull();
    });
});

describe('画面全体の操作を拾う', () => {
    it('クリック、値の変更、キー、捕まえられなかった例外を記録する', () => {
        document.body.innerHTML = '<button>再生</button><select aria-label="録り方"><option>録らない</option><option>ステップ入力</option></select>';
        const remove = installActivityListeners();
        fireEvent.click(screen.getByText('再生'));
        fireEvent.change(screen.getByLabelText('録り方'), { target: { value: 'ステップ入力' } });
        fireEvent.keyDown(document.body, { key: ' ' });
        window.dispatchEvent(new ErrorEvent('error', { message: 'x is not defined' }));
        expect(lines()).toEqual([
            'click: ボタン「再生」',
            'change: 選択肢「録り方」 → ステップ入力',
            'key: Space',
            'error: x is not defined',
        ]);
        remove();
        fireEvent.click(screen.getByText('再生'));
        expect(lines()).toHaveLength(4);
    });

    it('部品が伝わりを止めていても、クリックを拾う', () => {
        document.body.innerHTML = '<button>止める</button>';
        document.querySelector('button')!.addEventListener('click', (e) => e.stopPropagation());
        const remove = installActivityListeners();
        fireEvent.click(screen.getByText('止める'));
        expect(lines()).toEqual(['click: ボタン「止める」']);
        remove();
    });

    it('文字を打つ欄の中のキーと、押しっぱなしの繰り返しは記録しない', () => {
        document.body.innerHTML = '<input type="text" aria-label="名前"><input type="password" aria-label="API キー">';
        const remove = installActivityListeners();
        fireEvent.keyDown(screen.getByLabelText('名前'), { key: 'a' });
        fireEvent.keyDown(screen.getByLabelText('API キー'), { key: 's' });
        fireEvent.keyDown(document.body, { key: 'ArrowRight', repeat: true });
        expect(lines()).toEqual([]);
        remove();
    });
});

describe('API の呼び出し', () => {
    it('呼び出し先と結果の番号を記録する。見張りと進み具合の問い合わせは、成功していれば記録しない', async () => {
        const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) =>
            new Response('{}', { status: String(url).includes('/api/missing') ? 404 : 200 }));
        await apiFetch('/api/chart?async=1', { method: 'POST', body: 'secret-body' });
        await apiFetch('/api/health');
        await apiFetch('/api/jobs/abc');
        await apiFetch('/api/missing');
        await Promise.resolve();
        expect(fetchMock).toHaveBeenCalledTimes(4);
        const api = lines().filter((l) => l.startsWith('api: ')).map((l) => l.replace(/（\d+ ms）$/, ''));
        expect(api).toEqual(['api: POST /api/chart?async=1 → 200', 'api: GET /api/missing → 404']);
        expect(lines().join('\n')).not.toContain('secret-body');
    });

    it('届かなかった呼び出しと、見張りの失敗は記録する。失敗は、そのまま呼び出した側へ返す', async () => {
        vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Load failed'));
        await expect(apiFetch('/api/health')).rejects.toThrow('Load failed');
        await Promise.resolve();
        expect(lines().some((l) => l.startsWith('api: GET /api/health → 届きませんでした: Load failed'))).toBe(true);
    });
});

describe('「記録」の一覧', () => {
    it('「記録」を押すと開き、起きたことが時刻・呼び名つきで並ぶ。開いているあいだに増えた行も出る', () => {
        recordActivity('click', 'ボタン「MIDI 入力」');
        recordActivity('error', '読み込めませんでした');
        render(<ActivityButton />);
        expect(screen.queryByRole('region', { name: '動きの記録' })).toBeNull();

        const toggle = screen.getByRole('button', { name: '記録' });
        fireEvent.click(toggle);
        expect(toggle).toHaveAttribute('aria-expanded', 'true');
        const panel = screen.getByRole('region', { name: '動きの記録' });
        const rows = () => Array.from(panel.querySelectorAll('li')).map((li) => li.textContent);
        expect(rows()).toHaveLength(2);
        expect(rows()[0]).toMatch(/^\d\d:\d\d:\d\d\.\d{3}操作ボタン「MIDI 入力」$/);
        expect(panel.querySelector('.activity-error')).toHaveTextContent('エラー');

        act(() => recordActivity('midi', '押した C4（強さ 96）'));
        expect(rows()).toHaveLength(3);
        expect(rows()[2]).toContain('MIDI押した C4（強さ 96）');
        // ブラウザでは、ファイルには残らないことを伝える
        expect(panel).toHaveTextContent('画面の中にだけ残ります');

        fireEvent.click(screen.getByRole('button', { name: '動きの記録を閉じる' }));
        expect(screen.queryByRole('region', { name: '動きの記録' })).toBeNull();
    });

    it('記録が無ければ、そのことを伝える', () => {
        render(<ActivityButton />);
        fireEvent.click(screen.getByRole('button', { name: '記録' }));
        expect(screen.getByText('まだ記録がありません')).toBeInTheDocument();
    });

    it('一覧の中の操作は、記録しない (読んでいるだけで行が増えない)', () => {
        const remove = installActivityListeners();
        render(<ActivityButton />);
        fireEvent.click(screen.getByRole('button', { name: '記録' }));
        fireEvent.click(screen.getByRole('region', { name: '動きの記録' }));
        // 一覧にフォーカスして、キーで読み進めても増えない
        act(() => recordActivity('status', '読むための 1 行'));
        fireEvent.keyDown(screen.getByRole('list'), { key: 'ArrowDown' });
        fireEvent.click(screen.getByRole('button', { name: '動きの記録を閉じる' }));
        expect(lines()).toEqual(['status: 読むための 1 行']);
        remove();
    });
});
