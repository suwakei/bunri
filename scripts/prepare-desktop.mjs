#!/usr/bin/env node
/**
 * デスクトップアプリに同梱するものを src-tauri/ の下に用意する。
 *
 * `npm run tauri dev` / `npm run tauri build` の前に自動で走る (tauri.conf.json の
 * beforeDevCommand / beforeBuildCommand)。用意するものは 2 つ。
 *
 * 1. `uv` のバイナリ → src-tauri/binaries/uv-<target triple>
 *    Python は PyInstaller で固めず (torch 込みで数 GB になる)、uv だけを同梱して
 *    初回起動時に依存をアプリのデータ置き場へ入れる。版とハッシュはここで固定する。
 * 2. Python のコードと依存の定義 → src-tauri/runtime/
 *    backend/ の .py と pyproject.toml / uv.lock。__pycache__ は入れない。
 *
 * どちらも生成物なのでコミットしない (.gitignore 済み)。何度実行してもよい。
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TAURI_DIR = join(ROOT, 'src-tauri');

/** 同梱する uv の版。上げるときは下のハッシュも一緒に更新する。 */
const UV_VERSION = '0.13.7';
/** リリースに添付されている配布物の SHA-256 (https://github.com/astral-sh/uv/releases)。 */
const UV_SHA256 = {
    'aarch64-apple-darwin': { ext: 'tar.gz', sha256: '81b811b57e4624df7ed3aac148e0359100d9962f3d9dce00aec533dc2e086731' },
    'x86_64-unknown-linux-gnu': { ext: 'tar.gz', sha256: 'c5221ff41b7892bfc223543883600125f6a47fe845093e0f5bdff4f359196d83' },
    'aarch64-unknown-linux-gnu': { ext: 'tar.gz', sha256: '71279f8d3c67241e807b9d8db872d1bf541579fb9f08b7d1eb1682196d1e57dc' },
    'x86_64-pc-windows-msvc': { ext: 'zip', sha256: '0cdc5b38fe5a8168ed6a25814f5ba43c21d313dd3187314fccb37b7cec46e021' },
};

/** ビルド対象の target triple。Tauri CLI が渡す値を優先し、無ければ rustc に聞く。 */
function targetTriple() {
    if (process.env.TAURI_ENV_TARGET_TRIPLE) return process.env.TAURI_ENV_TARGET_TRIPLE;
    const out = execFileSync('rustc', ['-vV'], { encoding: 'utf8' });
    const host = out.split('\n').find((l) => l.startsWith('host: '));
    if (!host) throw new Error('rustc -vV から host を読めません');
    return host.slice('host: '.length).trim();
}

/** uv のバイナリを用意する。版が合うものが既に在れば何もしない。 */
async function prepareUv(triple) {
    const exe = triple.includes('windows') ? '.exe' : '';
    const dest = join(TAURI_DIR, 'binaries', `uv-${triple}${exe}`);
    if (existsSync(dest)) {
        try {
            const version = execFileSync(dest, ['--version'], { encoding: 'utf8' });
            if (version.split(/\s+/)[1] === UV_VERSION) {
                console.log(`[prepare] uv ${UV_VERSION} は用意済み`);
                return;
            }
        } catch {
            // 壊れている、または別の環境用。取り直す
        }
    }
    const asset = UV_SHA256[triple];
    if (!asset) {
        throw new Error(`uv の配布物のハッシュが未登録の環境です: ${triple} (scripts/prepare-desktop.mjs の UV_SHA256 に足してください)`);
    }
    const name = `uv-${triple}.${asset.ext}`;
    const url = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${name}`;
    console.log(`[prepare] uv ${UV_VERSION} をダウンロード: ${url}`);
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`uv をダウンロードできません: HTTP ${resp.status}`);
    const data = Buffer.from(await resp.arrayBuffer());
    const actual = createHash('sha256').update(data).digest('hex');
    if (actual !== asset.sha256) {
        throw new Error(`uv のハッシュが一致しません (期待 ${asset.sha256} / 実際 ${actual})。同梱を中止します`);
    }

    const work = mkdtempSync(join(tmpdir(), 'bunri-uv-'));
    try {
        const archive = join(work, name);
        writeFileSync(archive, data);
        // tar は macOS / Linux / Windows 10 以降に標準で在り、zip も展開できる (bsdtar)
        execFileSync('tar', ['-xf', archive, '-C', work]);
        const found = findFile(work, `uv${exe}`);
        if (!found) throw new Error('展開した中に uv が見つかりません');
        mkdirSync(dirname(dest), { recursive: true });
        rmSync(dest, { force: true });
        renameOrCopy(found, dest);
        if (!exe) chmodSync(dest, 0o755);
    } finally {
        rmSync(work, { recursive: true, force: true });
    }
    console.log(`[prepare] uv を配置: ${dest}`);
}

/** ディレクトリを下って、名前が一致する最初のファイルを返す。 */
function findFile(dir, name) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
            const hit = findFile(full, name);
            if (hit) return hit;
        } else if (entry.name === name) {
            return full;
        }
    }
    return null;
}

/** 別のボリュームをまたぐと rename できないので、そのときはコピーする。 */
function renameOrCopy(src, dest) {
    try {
        renameSync(src, dest);
    } catch {
        cpSync(src, dest);
    }
}

/** Python のコードと依存の定義を src-tauri/runtime/ に並べ直す。 */
function prepareRuntime() {
    const dest = join(TAURI_DIR, 'runtime');
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dest, { recursive: true });
    for (const file of ['pyproject.toml', 'uv.lock']) {
        cpSync(join(ROOT, file), join(dest, file));
    }
    let count = 0;
    cpSync(join(ROOT, 'backend'), join(dest, 'backend'), {
        recursive: true,
        filter: (src) => {
            const rel = src.slice(join(ROOT, 'backend').length).replaceAll('\\', '/');
            if (rel.includes('/__pycache__')) return false;
            if (rel.endsWith('.py')) count += 1;
            return true;
        },
    });
    // 同梱した uv.lock の指紋。アプリ側が「環境がこのロックのとおりか」を見分けるのに使う
    const lockHash = createHash('sha256').update(readFileSync(join(ROOT, 'uv.lock'))).digest('hex');
    writeFileSync(join(dest, 'lock.sha256'), lockHash + '\n');
    console.log(`[prepare] runtime を用意: Python ファイル ${count} 本 → ${dest}`);
}

const triple = targetTriple();
await prepareUv(triple);
prepareRuntime();
