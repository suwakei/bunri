/**
 * キーボードのショートカットを効かせてよい場面の判定 (lib/keys.ts)。
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach } from 'vitest';
import { isDialogOpen, isTextEntry, isTypingTarget } from '../lib/keys';

afterEach(() => { document.body.innerHTML = ''; });

/** HTML から要素を 1 つ作って、画面に置く。 */
function make(html: string): HTMLElement {
    document.body.innerHTML = html;
    return document.body.firstElementChild as HTMLElement;
}

describe('isTypingTarget', () => {
    it.each([
        '<input type="text">', '<input type="number">', '<input>', '<input type="password">',
        '<textarea></textarea>', '<select><option>a</option></select>',
    ])('文字を打ち込む欄 (%s) では true', (html) => {
        expect(isTypingTarget(make(html))).toBe(true);
    });

    it.each([
        '<input type="range">', '<input type="checkbox">', '<input type="file">',
        '<button>a</button>', '<div>a</div>', '<a href="#">a</a>',
    ])('文字を打ち込まない部品 (%s) では false', (html) => {
        expect(isTypingTarget(make(html))).toBe(false);
    });

    it('要素でないもの (document など) は false', () => {
        expect(isTypingTarget(document)).toBe(false);
        expect(isTypingTarget(null)).toBe(false);
    });
});

describe('isTextEntry', () => {
    it('文字を書き換えられる欄では true、選択欄やボタンでは false', () => {
        expect(isTextEntry(make('<input type="number">'))).toBe(true);
        expect(isTextEntry(make('<textarea></textarea>'))).toBe(true);
        // 選択欄での Backspace は文字を消す操作ではない (ブラウザによっては「戻る」になるので、止める側に入れる)
        expect(isTextEntry(make('<select><option>a</option></select>'))).toBe(false);
        expect(isTextEntry(make('<button>a</button>'))).toBe(false);
        expect(isTextEntry(make('<input type="range">'))).toBe(false);
    });
});

describe('isDialogOpen', () => {
    it('画面を覆う窓 (aria-modal) が在るあいだだけ true', () => {
        expect(isDialogOpen()).toBe(false);
        make('<div role="dialog" aria-modal="true"></div>');
        expect(isDialogOpen()).toBe(true);
    });
});
