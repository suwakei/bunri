/**
 * デスクトップアプリと同じ CSP の下で、画面が欠けずに出ることを確かめる。
 *
 * 画面には src-tauri/tauri.conf.json の CSP が掛かっている (scripts/dev-web.mjs)。違反は、どのテストで起きても
 * 最後に失敗になる (csp-check.ts)。ここでは、その仕組み自体が効いていることと、同梱したフォントが
 * すべて読み込めることを確かめる。本物の窓 (WKWebView) での同じ確かめは e2e-desktop/ に在る。
 */
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { CSP_PROBE_ORIGIN, openDaw } from './helpers';

/** tauri.conf.json の CSP (指令 → 値)。 */
function desktopCsp(): Record<string, string> {
    const config = JSON.parse(readFileSync(new URL('../../src-tauri/tauri.conf.json', import.meta.url), 'utf8'));
    return config.app.security.csp;
}

/** CSP の文字列を、指令 → 値 の表にする。 */
function parseCsp(header: string): Record<string, string> {
    return Object.fromEntries(header.split(';').map((p) => p.trim()).filter(Boolean).map((p) => {
        const [name, ...values] = p.split(/\s+/);
        return [name, values.join(' ')];
    }));
}

test('画面には、デスクトップアプリと同じ CSP が掛かっている', async ({ page }) => {
    const response = await page.goto('/');
    const served = parseCsp((await response!.allHeaders())['content-security-policy'] ?? '');
    for (const [name, value] of Object.entries(desktopCsp())) {
        // 開発サーバの事情で足したもの (nonce、自動再読み込みの接続) の分だけ長くなることはあるが、
        // デスクトップ版の値はそのまま含む
        expect(served[name], name).toBeDefined();
        expect(served[name].startsWith(value), `${name}: ${served[name]}`).toBe(true);
    }
});

test('CSP は実際に効いている (許していない読み込みは止まる)', async ({ page }) => {
    await openDaw(page);
    const violation = await page.evaluate((origin) => new Promise<string>((resolve) => {
        document.addEventListener('securitypolicyviolation', (e) => resolve(e.effectiveDirective), { once: true });
        const script = document.createElement('script');
        script.src = `${origin}/bunri-csp-probe.js`;
        document.head.appendChild(script);
    }), CSP_PROBE_ORIGIN);
    expect(violation).toMatch(/^script-src/);
});

test('同梱したフォントは、すべて読み込める', async ({ page }) => {
    await openDaw(page);
    const faces = await page.evaluate(async () => {
        await document.fonts.ready;
        const all = [...document.fonts];
        // 使われている文字の範囲 (unicode-range) のぶんだけ読まれるので、全部を明示的に読ませる
        await Promise.allSettled(all.map((face) => face.load()));
        return all.map((face) => ({ family: face.family.replace(/"/g, ''), weight: face.weight, range: face.unicodeRange, status: face.status }));
    });
    const families = new Set(faces.map((f) => f.family));
    expect(families).toContain('Outfit Variable');
    expect(families).toContain('IBM Plex Mono');
    expect(faces.filter((f) => f.status !== 'loaded')).toEqual([]);
    // 画面の文字は、同梱したフォントで描かれている
    const bodyFont = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
    expect(bodyFont).toMatch(/^"?Outfit Variable/);
    expect(await page.evaluate(() => document.fonts.check('16px "Outfit Variable"'))).toBe(true);
    expect(await page.evaluate(() => document.fonts.check('16px "IBM Plex Mono"'))).toBe(true);
});
