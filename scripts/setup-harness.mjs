#!/usr/bin/env node
// この clone だけに Git hook を設定する。既存の有効な hook 設定は置き換えない。
import { spawnSync } from 'node:child_process';
import { accessSync, chmodSync, constants, existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncHarness } from './sync-codex-harness.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function git(args, allowMissing = false) {
    const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
    if (result.error) throw result.error;
    if (allowMissing && result.status === 1) return '';
    if (result.status !== 0) throw new Error(result.stderr.trim() || `git ${args[0]} failed`);
    return result.stdout.trim();
}

function setup() {
    const configured = git(['config', '--get', 'core.hooksPath'], true);
    if (configured && configured !== '.githooks') {
        throw new Error(`既存の core.hooksPath (${configured}) があるため変更しません。既存 hook と .githooks/pre-commit を統合してください。`);
    }
    if (!configured) {
        const hooksDir = resolve(ROOT, git(['rev-parse', '--git-path', 'hooks']));
        const active = existsSync(hooksDir) ? readdirSync(hooksDir).filter(name => {
            if (name.endsWith('.sample')) return false;
            try { accessSync(join(hooksDir, name), constants.X_OK); return true; }
            catch { return false; }
        }) : [];
        if (active.length) throw new Error(`既存の Git hooks (${active.join(', ')}) があるため設定を変更しません。既存 hook と統合してください。`);
    }
    syncHarness(ROOT);
    chmodSync(join(ROOT, '.githooks/pre-commit'), 0o755);
    git(['config', '--local', 'core.hooksPath', '.githooks']);
    console.log('Codex ハーネスを同期し、この clone の pre-commit hook を有効にしました。');
    console.log('依存は既存の make install / install-frontend / install-desktop で準備します。');
}

try {
    const args = process.argv.slice(2);
    if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
        console.log('Usage: node scripts/setup-harness.mjs\n生成設定を同期し、既存 hooks が無い場合に core.hooksPath=.githooks をこの clone に設定します。');
    } else {
        if (args.length) throw new Error('Usage: node scripts/setup-harness.mjs [--help]');
        setup();
    }
} catch (error) {
    console.error(`[harness-setup] ${error.message}`);
    process.exitCode = 1;
}
