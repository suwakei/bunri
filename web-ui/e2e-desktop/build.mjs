#!/usr/bin/env node
/**
 * 本物の窓を操作するテスト用に、アプリをビルドする (make e2e-desktop の前半)。
 *
 * 配布物と同じ手順 (`tauri build`: 画面を同梱し、tauri://localhost で出す。CSP も同じ) で、違いは 2 つだけ:
 * - debug でビルドする (機能 e2e は release では使えない。src-tauri/src/lib.rs の compile_error!)
 * - 機能 e2e を付ける (アプリの中で WebDriver サーバが動く。配布物には入らない)
 *
 * 出力は src-tauri/target/e2e/debug/bunri。開発用の `tauri dev` (src-tauri/target/debug/) とは分けてある。
 * 同じ場所だと、機能の違いで毎回ビルドし直しになり、開発中のアプリの実行ファイルもテスト用に置き換わるため。
 * .app に固める段階は飛ばす (--no-bundle)。
 */
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const result = spawnSync('npx', ['tauri', 'build', '--debug', '--no-bundle', '--features', 'e2e', '--ci'], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, CARGO_TARGET_DIR: join(ROOT, 'src-tauri', 'target', 'e2e') },
});
process.exit(result.status ?? 1);
