/**
 * 動きの記録のファイル (src-tauri/src/activity.rs) を、続きから読むための部品。操作のコマンド (drive.ts) が使う。
 *
 * 「前に読んだところから先」を出すために、ファイルごとに読んだ位置を覚えておく。位置だけを覚えると、
 * 同じ名前のファイルが別の中身に替わったとき (アプリが記録を回した、窓を終わらせたあとの写しが上書きされた) に、
 * 新しい中身の途中から読んでしまう。そこで、位置と一緒にファイルの頭の行 (起動の時刻が入っている) も覚えておき、
 * 違っていたら、別のファイルとして頭から読む。
 */
import { closeSync, openSync, readSync, statSync } from 'node:fs';

/** 読んだ位置。 */
export interface Position {
    /** 次に読み始めるバイト位置。 */
    offset: number;
    /** そのときの、ファイルの頭の行 (ファイルの素性)。 */
    head: string;
}

/** 頭の行として覚えておく長さ (バイト)。 */
const HEAD_BYTES = 160;

/** ファイルの大きさ (無ければ 0)。 */
export function sizeOf(file: string): number {
    try {
        return statSync(file).size;
    } catch {
        return 0;
    }
}

/** ファイルの `from` バイト目から、最大 `length` バイトを読む (無ければ空)。 */
function readBytes(file: string, from: number, length: number): Buffer {
    if (length <= 0) return Buffer.alloc(0);
    let fd: number;
    try {
        fd = openSync(file, 'r');
    } catch {
        return Buffer.alloc(0);
    }
    try {
        const buffer = Buffer.alloc(length);
        return buffer.subarray(0, readSync(fd, buffer, 0, length, from));
    } finally {
        closeSync(fd);
    }
}

/** ファイルの頭の行 (書き終わっていなければ、いま在るぶん)。 */
export function headOf(file: string): string {
    const bytes = readBytes(file, 0, HEAD_BYTES);
    const end = bytes.indexOf(0x0a);
    return bytes.subarray(0, end < 0 ? bytes.length : end).toString('utf8');
}

/**
 * 覚えていた位置から、続きを読めるか。
 *
 * @returns `from`: 読み始める位置。`fresh`: 初めて読む (覚えていない、または別のファイルに替わった) なら true
 */
export function resume(file: string, saved: Position | undefined): { from: number; fresh: boolean } {
    if (!saved) return { from: 0, fresh: true };
    // 頭の行が違う、または覚えていた位置より小さくなった = 別のファイルに替わった
    if (saved.head !== headOf(file) || saved.offset > sizeOf(file)) return { from: 0, fresh: true };
    return { from: saved.offset, fresh: false };
}

/**
 * `from` バイト目から先の、書き終わっている行を読む。
 *
 * 書いている途中の行 (改行がまだ無い) は読まず、次の回に回す。
 *
 * @returns 読んだ行と、次に読み始める位置
 */
export function readLines(file: string, from: number): { lines: string[]; next: number } {
    const bytes = readBytes(file, from, sizeOf(file) - from);
    const end = bytes.lastIndexOf(0x0a);
    if (end < 0) return { lines: [], next: from };
    return { lines: bytes.subarray(0, end).toString('utf8').split('\n'), next: from + end + 1 };
}

/** いまの末尾 (書き終わっている行の終わり) の位置。 */
export function endOf(file: string): Position {
    const size = sizeOf(file);
    // 末尾が行の途中なら、その行の頭まで戻る
    const tail = readBytes(file, Math.max(0, size - 4096), Math.min(size, 4096));
    const lastBreak = tail.lastIndexOf(0x0a);
    const offset = lastBreak < 0 ? (size <= 4096 ? 0 : size) : size - tail.length + lastBreak + 1;
    return { offset, head: headOf(file) };
}

/** async 関数を作る口 (`new Function` の async 版)。 */
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (body: string) => unknown;

/**
 * `drive.ts eval` に渡された文字列を、画面の中で実行する本文にする。
 *
 * 1 つの式として読めるなら、その値を返す形にする (`document.title` → `return (document.title);`)。
 * 式として読めないもの (複数の文、`return` で始まる本文など) は、そのまま本文として実行する
 * (値を返すには、自分で `return` を書く)。
 *
 * `return` という語が入っているかどうかでは決めない。`items.map(x => { return x.id })` は、
 * `return` を含むが 1 つの式で、包まないと何も返らない。
 */
export function asScript(body: string): string {
    const expression = `return (${body}\n);`;
    try {
        // ここでは読めるかを確かめるだけで、実行はしない
        new AsyncFunction(expression);
        return expression;
    } catch {
        return body;
    }
}
