import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { prepareRuntime } from './prepare-desktop.mjs';

test('推論のコード・設定・ライセンスを同梱し、比較入口とキャッシュを含めない', () => {
    const root = mkdtempSync(join(tmpdir(), 'bunri-bundle-test-'));
    const put = (relative, value) => {
        const path = join(root, relative);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, value);
    };
    try {
        put('pyproject.toml', '[project]\nname="fixture"\n');
        put('uv.lock', 'fixture-lock\n');
        put('backend/_modern_separate_runner.py', '# 推論入口\n');
        put('backend/_bench_subroformer.py', '# 比較専用\n');
        put('backend/separation_bench.py', '# 比較専用\n');
        put('backend/_vendor/subroformer/LICENSE', 'MIT License\n');
        put('backend/_vendor/subroformer/SOURCE.json', '{"revision":"fixed"}\n');
        put('backend/_vendor/subroformer/subroformer/inference/engine.py', '# 同梱する上流コード\n');
        put('backend/_vendor/subroformer/subroformer/configs/model.yaml', 'model: fixed\n');
        put('backend/_vendor/subroformer/subroformer/__pycache__/engine.pyc', 'cache');
        put('backend/loose.pyc', 'cache');
        prepareRuntime(root);
        const runtime = join(root, 'src-tauri', 'runtime');
        for (const relative of ['backend/_modern_separate_runner.py', 'backend/_vendor/subroformer/LICENSE',
            'backend/_vendor/subroformer/SOURCE.json', 'backend/_vendor/subroformer/subroformer/inference/engine.py',
            'backend/_vendor/subroformer/subroformer/configs/model.yaml']) {
            assert.ok(existsSync(join(runtime, relative)), relative);
        }
        for (const relative of ['backend/_bench_subroformer.py', 'backend/separation_bench.py', 'backend/loose.pyc',
            'backend/_vendor/subroformer/subroformer/__pycache__']) {
            assert.equal(existsSync(join(runtime, relative)), false, relative);
        }
        const expected = createHash('sha256').update('fixture-lock\n').digest('hex') + '\n';
        assert.equal(readFileSync(join(runtime, 'lock.sha256'), 'utf8'), expected);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
