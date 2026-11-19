/**
 * 動きの記録を続きから読む部品 (reader.ts) のテスト。アプリは使わない (make e2e-desktop の中で一緒に走る)。
 */
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { asScript, endOf, headOf, readLines, resume } from './reader.ts';

const dir = mkdtempSync(join(tmpdir(), 'bunri-reader-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let count = 0;
const newFile = (text: string) => {
    const file = join(dir, `activity-${count++}.log`);
    writeFileSync(file, text);
    return file;
};

describe('記録を続きから読む', () => {
    it('書き終わっている行だけを読み、次の位置を返す。書きかけの行は次の回に読む', () => {
        const file = newFile('10:00:00.000 [app] 起動\n10:00:01.000 [click] ボタン「再生」\n10:00:02.000 [status] 再');
        const first = readLines(file, 0);
        expect(first.lines).toEqual(['10:00:00.000 [app] 起動', '10:00:01.000 [click] ボタン「再生」']);
        expect(readLines(file, first.next)).toEqual({ lines: [], next: first.next });

        appendFileSync(file, '生中\n');
        expect(readLines(file, first.next).lines).toEqual(['10:00:02.000 [status] 再生中']);
    });

    it('無いファイルと空のファイルは、何も読まない', () => {
        expect(readLines(join(dir, 'missing.log'), 0)).toEqual({ lines: [], next: 0 });
        expect(readLines(newFile(''), 0)).toEqual({ lines: [], next: 0 });
        expect(headOf(join(dir, 'missing.log'))).toBe('');
    });

    it('覚えていた位置から続ける。覚えていなければ、初めて読むものとして頭から', () => {
        const file = newFile('10:00:00.000 [app] 起動\n10:00:01.000 [status] a\n');
        expect(resume(file, undefined)).toEqual({ from: 0, fresh: true });
        const { next } = readLines(file, 0);
        expect(resume(file, { offset: next, head: headOf(file) })).toEqual({ from: next, fresh: false });
    });

    it('同じ名前のファイルが別の中身に替わっていたら、頭から読む (前より大きくても)', () => {
        const file = newFile('10:00:00.000 [app] 1 回目の起動\n10:00:01.000 [status] a\n');
        const saved = { offset: readLines(file, 0).next, head: headOf(file) };
        // 上書きされて、前の位置より長くなった (位置だけでは見分けられない)
        writeFileSync(file, '11:00:00.000 [app] 2 回目の起動\n11:00:01.000 [status] あいうえおかきくけこ\n11:00:02.000 [status] b\n');
        expect(resume(file, saved)).toEqual({ from: 0, fresh: true });
        // 小さくなったときも、頭から
        writeFileSync(file, '10:00:00.000 [app] 1 回目の起動\n');
        expect(resume(file, { ...saved, offset: 9999 })).toEqual({ from: 0, fresh: true });
    });

    it('末尾の位置は、書き終わっている行の終わり', () => {
        const file = newFile('10:00:00.000 [app] 起動\n10:00:01.000 [status] 書きか');
        const end = endOf(file);
        expect(end.head).toBe('10:00:00.000 [app] 起動');
        expect(readLines(file, end.offset).lines).toEqual([]);
        appendFileSync(file, 'け\n10:00:02.000 [midi] 押した C4\n');
        expect(readLines(file, end.offset).lines).toEqual(['10:00:01.000 [status] 書きかけ', '10:00:02.000 [midi] 押した C4']);
        expect(endOf(newFile(''))).toEqual({ offset: 0, head: '' });
    });
});

describe('eval に渡された文字列', () => {
    it('1 つの式は、その値を返す形にする (中に return が在っても)', () => {
        expect(asScript('document.title')).toBe('return (document.title\n);');
        expect(asScript('[...document.querySelectorAll("button")].map(b => { return b.id })')).toMatch(/^return \(/);
        expect(asScript('await fetch("/x").then(r => r.status)')).toMatch(/^return \(/);
        // 末尾のコメントで、閉じる括弧が消えない
        expect(asScript('1 + 1 // 足す')).toBe('return (1 + 1 // 足す\n);');
    });

    it('式として読めないものは、そのまま本文として実行する', () => {
        expect(asScript('const a = 1; return a + 1;')).toBe('const a = 1; return a + 1;');
        expect(asScript('return document.title')).toBe('return document.title');
        expect(asScript('document.title;')).toBe('document.title;');
    });
});
