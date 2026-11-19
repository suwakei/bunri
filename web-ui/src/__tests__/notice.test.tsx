/**
 * 知らせ（失敗と「いまはできない理由」を、画面に浮かせて出す）のテスト
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import * as matchers from '@testing-library/jest-dom/matchers';

expect.extend(matchers);

class MockGainNode {
    gain = { value: 1, setValueAtTime: () => {}, linearRampToValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} };
    connect() { return this; }
}
class MockAudioContext {
    currentTime = 0;
    destination = {};
    createGain() { return new MockGainNode() as unknown as GainNode; }
    createStereoPanner() { return { pan: { value: 0 }, connect() { return this; } } as unknown as StereoPannerNode; }
    createOscillator() {
        return {
            type: 'sine', frequency: { value: 0, setValueAtTime: () => {} }, onended: null,
            connect() { return this; }, disconnect() {}, start() {}, stop() {},
        } as unknown as OscillatorNode;
    }
}
// @ts-expect-error AudioContext モック
globalThis.AudioContext = MockAudioContext;

const { DawProvider, useDaw } = await import('../lib/store');
const { MAX_NOTICES, REPEAT_QUIET_MS, blockedBy, blockedReason, clearNotices, dismissNotice, getNotices, noticeDuration, notify } = await import('../lib/notice');
const { activityEntries: getActivity, resetActivityForTest: clearActivity } = await import('../lib/activity');
const engine = (await import('../lib/engine')).default;
const NoticeLayer = (await import('../components/NoticeToast')).default;
const StatusBar = (await import('../components/StatusBar')).default;

const toasts = () => Array.from(document.querySelectorAll<HTMLElement>('.notice-toast'));

beforeEach(() => { cleanup(); clearNotices(); clearActivity(); });
afterEach(() => { vi.useRealTimers(); });

describe('lib/notice', () => {
    it('出した順に並び、閉じると消える', () => {
        const a = notify('error', '保存できませんでした');
        const b = notify('hint', '先にトラックを選んでください');
        expect(getNotices().map((n) => [n.kind, n.text])).toEqual([
            ['error', '保存できませんでした'], ['hint', '先にトラックを選んでください'],
        ]);
        dismissNotice(a);
        expect(getNotices().map((n) => n.id)).toEqual([b]);
    });

    it('同じ文がもう一度来たら、並べずに、出し直した回数だけを増やす', () => {
        const first = notify('hint', '先にトラックを選んでください');
        const again = notify('hint', '先にトラックを選んでください');
        expect(again).toBe(first);
        expect(getNotices()).toHaveLength(1);
        // 続けざまに来たぶん (キーの押しっぱなしなど) は、時間を数え直すだけで、目を引く動きはさせない
        expect(getNotices()[0]).toMatchObject({ bump: 0, renew: 1 });
        vi.useFakeTimers();
        vi.setSystemTime(Date.now() + REPEAT_QUIET_MS + 1);
        notify('hint', '先にトラックを選んでください');
        expect(getNotices()[0]).toMatchObject({ bump: 1, renew: 2 });
        // 種類が違えば、別の知らせ
        notify('error', '先にトラックを選んでください');
        expect(getNotices()).toHaveLength(2);
    });

    it('上限を超えたら、古いものから閉じる。空の文は出さない', () => {
        for (let i = 0; i < MAX_NOTICES + 2; i++) notify('hint', `知らせ ${i}`);
        expect(getNotices().map((n) => n.text)).toEqual(['知らせ 2', '知らせ 3', '知らせ 4']);
        expect(notify('error', '  ')).toBe(-1);
        expect(getNotices()).toHaveLength(MAX_NOTICES);
    });

    it('失敗は理由より長く出す。長い文とボタンの付いた知らせは、さらに長く出す（上限つき）', () => {
        const hint = noticeDuration({ kind: 'hint', text: '短い文' });
        expect(noticeDuration({ kind: 'error', text: '短い文' })).toBeGreaterThan(hint);
        expect(noticeDuration({ kind: 'hint', text: 'あ'.repeat(100) })).toBeGreaterThan(hint);
        expect(noticeDuration({ kind: 'hint', text: '短い文', action: { label: '開く', run: () => {} } })).toBeGreaterThan(hint);
        expect(noticeDuration({ kind: 'error', text: 'あ'.repeat(2000) })).toBe(20_000);
    });

    it('押せない部品を押したときの文は、その部品の説明。押せる部品・説明の無い部品では出さない', () => {
        document.body.innerHTML = `
            <button id="a" disabled data-tip="ノートを選ぶと押せます"><span id="a-in">強さ</span></button>
            <button id="b" data-tip="保存します">保存</button>
            <button id="c" disabled>名前なし</button>
            <button id="d" disabled data-tip="書き出します" data-blocked="トラックにノートを置くと、書き出せます">書き出し</button>
            <label data-tip="パートに分けると選べます"><input id="e" type="checkbox" disabled /><span id="e-text">お手本</span></label>
            <div id="f" aria-disabled="true" data-tip="再生を止めると変えられます">拍子</div>`;
        const reason = (id: string) => blockedReason(document.getElementById(id));
        expect(reason('a')).toBe('いまは使えません。ノートを選ぶと押せます');
        // ボタンの中の文字を押しても、同じ
        expect(reason('a-in')).toBe('いまは使えません。ノートを選ぶと押せます');
        expect(reason('b')).toBeNull();
        expect(reason('c')).toBeNull();
        // 押せない理由を別に書いてあれば、そちら
        expect(reason('d')).toBe('トラックにノートを置くと、書き出せます');
        // 説明が、包んでいるラベルに書いてあるとき
        expect(reason('e')).toBe('いまは使えません。パートに分けると選べます');
        // ラベルの文字を押しても、同じ
        expect(reason('e-text')).toBe('いまは使えません。パートに分けると選べます');
        expect(reason('f')).toBe('いまは使えません。再生を止めると変えられます');
        expect(blockedReason(null)).toBeNull();
        // 押されたときに自分で理由を出す部品 (空の data-blocked) では、出さない
        document.body.innerHTML = '<button id="g" aria-disabled="true" data-tip="お手本のノートがありません" data-blocked="">A メロ</button>';
        expect(reason('g')).toBeNull();
        // 理由を書く属性は、理由が在るときだけ付く
        expect(blockedBy(false)).toEqual({});
        expect(blockedBy('処理が終わるまで待ってください')).toEqual({ 'data-blocked': '処理が終わるまで待ってください' });
        document.body.innerHTML = '';
    });
});

describe('NoticeLayer', () => {
    function Buttons() {
        const { setStatus } = useDaw();
        return (
            <>
                <button onClick={() => setStatus('保存できませんでした。もう一度押してください', 'error')}>失敗</button>
                <button onClick={() => setStatus('先に、ノートを入れるトラックをクリックして選んでください', 'hint')}>できない</button>
                <button onClick={() => setStatus('保存しました')}>成功</button>
            </>
        );
    }
    const renderAll = () => render(<DawProvider><Buttons /><StatusBar /><NoticeLayer /></DawProvider>);

    it('失敗と「いまはできない理由」は、ステータスバーに加えて、知らせとしても出る。うまくいった結果は出ない', () => {
        renderAll();
        fireEvent.click(screen.getByText('成功'));
        expect(toasts()).toHaveLength(0);

        fireEvent.click(screen.getByText('失敗'));
        expect(toasts()).toHaveLength(1);
        expect(toasts()[0]).toHaveTextContent('保存できませんでした。もう一度押してください');
        expect(toasts()[0]).toHaveAttribute('data-notice-kind', 'error');
        // 読み上げは、ステータスバーの側だけ (2 回読まれないように、知らせには役割を付けず、読み上げ用の欄にも流さない)
        expect(screen.getAllByRole('alert')).toHaveLength(1);
        expect(screen.getByRole('alert')).toHaveAttribute('id', 'status-text');
        expect(toasts()[0]).not.toHaveAttribute('role');
        expect(document.getElementById('notice-live')).toBeEmptyDOMElement();

        fireEvent.click(screen.getByText('できない'));
        expect(toasts()).toHaveLength(2);
        expect(toasts()[1]).toHaveAttribute('data-notice-kind', 'hint');
        // 理由は、失敗の色にはしない
        expect(document.getElementById('status-text')).not.toHaveClass('error');
        expect(document.getElementById('status-text')).toHaveTextContent('先に、ノートを入れるトラックをクリックして選んでください');
    });

    it('動きの記録には、失敗は「エラー: 」、理由は「知らせ: 」を付けて残る', () => {
        renderAll();
        fireEvent.click(screen.getByText('失敗'));
        fireEvent.click(screen.getByText('できない'));
        const lines = getActivity().filter((e) => e.tag === 'status').map((e) => e.message);
        expect(lines).toContain('エラー: 保存できませんでした。もう一度押してください');
        expect(lines).toContain('知らせ: 先に、ノートを入れるトラックをクリックして選んでください');
    });

    it('しばらくすると閉じる。中のボタンにマウスを載せているあいだは閉じない。✕ でも閉じる', () => {
        vi.useFakeTimers();
        renderAll();
        fireEvent.click(screen.getByText('できない'));
        fireEvent.mouseEnter(screen.getByLabelText('知らせを閉じる'));
        act(() => { vi.advanceTimersByTime(60_000); });
        expect(toasts()).toHaveLength(1);
        fireEvent.mouseLeave(screen.getByLabelText('知らせを閉じる'));
        act(() => { vi.advanceTimersByTime(20_000); });
        expect(toasts()).toHaveLength(0);

        fireEvent.click(screen.getByText('失敗'));
        fireEvent.click(screen.getByLabelText('知らせを閉じる'));
        expect(toasts()).toHaveLength(0);
    });

    it('同じ文がもう一度来ても 1 つのままで、閉じるまでの時間を数え直す', () => {
        vi.useFakeTimers();
        renderAll();
        fireEvent.click(screen.getByText('できない'));
        const total = noticeDuration({ kind: 'hint', text: '先に、ノートを入れるトラックをクリックして選んでください' });
        act(() => { vi.advanceTimersByTime(total - 1000); });
        fireEvent.click(screen.getByText('できない'));
        expect(toasts()).toHaveLength(1);
        act(() => { vi.advanceTimersByTime(total - 1000); });
        expect(toasts()).toHaveLength(1);
        act(() => { vi.advanceTimersByTime(2000); });
        expect(toasts()).toHaveLength(0);
    });

    it('✕ で閉じたときだけ、閉じたことを呼び出し元に伝える (時間で閉じたときは伝えない)', () => {
        vi.useFakeTimers();
        const onDismiss = vi.fn();
        render(<NoticeLayer />);
        act(() => { notify('hint', '鍵盤がつながっています', { onDismiss }); });
        act(() => { vi.advanceTimersByTime(60_000); });
        expect(toasts()).toHaveLength(0);
        expect(onDismiss).not.toHaveBeenCalled();
        act(() => { notify('hint', '鍵盤がつながっています', { onDismiss }); });
        fireEvent.click(screen.getByLabelText('知らせを閉じる'));
        expect(onDismiss).toHaveBeenCalledTimes(1);
    });

    it('知らせの中のボタンを選んでいるあいだに同じ文が来ても、要素は作り直さない (フォーカスを失わない)', () => {
        vi.useFakeTimers();
        renderAll();
        fireEvent.click(screen.getByText('できない'));
        const close = screen.getByLabelText('知らせを閉じる');
        close.focus();
        vi.setSystemTime(Date.now() + REPEAT_QUIET_MS + 1);
        fireEvent.click(screen.getByText('できない'));
        expect(screen.getByLabelText('知らせを閉じる')).toBe(close);
        expect(document.activeElement).toBe(close);
        expect(toasts()[0]).toHaveClass('again');
    });

    it('「次にすること」のボタンを押すと、それを行って閉じる', () => {
        const run = vi.fn();
        function WithAction() {
            const { setStatus } = useDaw();
            return <button onClick={() => setStatus('MIDI 鍵盤がつながっています', 'hint', { action: { label: 'MIDI 入力を始める', run } })}>知らせる</button>;
        }
        render(<DawProvider><WithAction /><NoticeLayer /></DawProvider>);
        fireEvent.click(screen.getByText('知らせる'));
        fireEvent.click(screen.getByRole('button', { name: 'MIDI 入力を始める' }));
        expect(run).toHaveBeenCalledTimes(1);
        expect(toasts()).toHaveLength(0);
    });

    it('押せないボタンを押すと、どうすれば押せるかが知らせとして出る。押せるボタンでは出ない', () => {
        render(
            <>
                <button disabled data-tip="ピアノロールでノートを選ぶと、強さを変えられます">強さ</button>
                <button data-tip="保存します">保存</button>
                <NoticeLayer />
            </>,
        );
        fireEvent.pointerDown(screen.getByText('保存'), { button: 0 });
        expect(toasts()).toHaveLength(0);
        fireEvent.pointerDown(screen.getByText('強さ'), { button: 0 });
        expect(toasts()).toHaveLength(1);
        expect(toasts()[0]).toHaveTextContent('いまは使えません。ピアノロールでノートを選ぶと、強さを変えられます');
        // この文は、ほかのどこにも出ないので、いつも在る読み上げ用の欄に流す
        expect(screen.getByRole('status')).toHaveTextContent('いまは使えません。ピアノロールでノートを選ぶと、強さを変えられます');
        expect(getActivity().map((e) => e.message)).toContain('押せない状態の部品を押した: いまは使えません。ピアノロールでノートを選ぶと、強さを変えられます');
    });
});

describe('押したのに何も起きない、を作らない (ストア)', () => {
    function Transport() {
        const { play, stop, undo, midiRef } = useDaw();
        return (
            <>
                <button onClick={() => play()}>再生</button>
                <button onClick={stop}>停止</button>
                <button onClick={undo}>元に戻す</button>
                <button onClick={() => { midiRef.current = { connected: true, mode: 'realtime' } as never; }}>リアルタイム録音にする</button>
            </>
        );
    }
    const renderAll = () => render(<DawProvider><Transport /><StatusBar /><NoticeLayer /></DawProvider>);
    const statusLine = () => document.getElementById('status-text')!.textContent;
    const addNotes = (name: string) => {
        const track = engine.addTrack(name);
        track.pianoNotes = [{ note: 'C', octave: 4, step: 0, length: 4 }];
        return track;
    };

    beforeEach(() => {
        engine.stop();
        for (const track of [...engine.tracks]) engine.removeTrack(track.id);
        engine.metronomeEnabled = false;
        engine.countInBeats = 0;
        engine.setListenOverride(null);
    });
    afterEach(() => { engine.stop(); engine.metronomeEnabled = false; engine.setListenOverride(null); });

    it('鳴らすものが無いまま再生すると、音が鳴らない理由を出す。ノートが在れば「再生中…」', () => {
        renderAll();
        fireEvent.click(screen.getByText('再生'));
        expect(statusLine()).toContain('鳴らすものがまだありません');
        expect(toasts()).toHaveLength(1);
        expect(toasts()[0]).toHaveAttribute('data-notice-kind', 'hint');

        fireEvent.click(screen.getByText('停止'));
        act(() => { clearNotices(); });
        addNotes('Track 1');
        fireEvent.click(screen.getByText('再生'));
        expect(statusLine()).toBe('再生中…');
        expect(toasts()).toHaveLength(0);
    });

    it('音の入ったトラックがミュートされていると、M と S を確かめるよう出す。練習画面の「聴く」で選んでいるあいだは、「聴く」のことを言う', () => {
        renderAll();
        const track = addNotes('Track 1');
        const empty = engine.addTrack('Track 2');
        track.mute = true;
        fireEvent.click(screen.getByText('再生'));
        expect(statusLine()).toContain('M（ミュート）と S（ソロ）を確かめてください');

        fireEvent.click(screen.getByText('停止'));
        track.mute = false;
        engine.setListenOverride([empty.id]);
        fireEvent.click(screen.getByText('再生'));
        expect(statusLine()).toContain('「聴く」で選んでいるほうには、まだ鳴らすものがありません');
    });

    it('メトロノームを鳴らすとき・MIDI のリアルタイム録音のときは、空でも理由を出さない (再生する意味が在る)', () => {
        renderAll();
        engine.metronomeEnabled = true;
        fireEvent.click(screen.getByText('再生'));
        expect(statusLine()).toBe('再生中…');
        fireEvent.click(screen.getByText('停止'));
        engine.metronomeEnabled = false;

        fireEvent.click(screen.getByText('リアルタイム録音にする'));
        fireEvent.click(screen.getByText('再生'));
        expect(statusLine()).toBe('再生中…');
        expect(toasts()).toHaveLength(0);
    });

    it('取り消すものが無いのに「元に戻す」: 理由を出す。続けざまに押しても、動きの記録は 1 行のまま (キーの押しっぱなし)', () => {
        renderAll();
        for (let i = 0; i < 5; i++) fireEvent.click(screen.getByText('元に戻す'));
        expect(statusLine()).toBe('取り消せる操作はまだありません');
        expect(toasts()).toHaveLength(1);
        expect(getActivity().filter((e) => e.message === '知らせ: 取り消せる操作はまだありません')).toHaveLength(1);
        // 目を引く動きもさせない (点滅しない)
        expect(getNotices()[0].bump).toBe(0);
    });
});
