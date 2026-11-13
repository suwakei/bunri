import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { buildPlan, changedFiles, parseArgs, runPlan, selectScopes } from './check.mjs';

function fixture(t) {
    const root = mkdtempSync(join(tmpdir(), 'bunri-check-test-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const git = (...args) => {
        const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
        return result.stdout.trim();
    };
    const write = (path, text = 'initial\n') => {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), text);
    };
    git('init', '-q');
    git('config', 'user.email', 'harness-test@example.invalid');
    git('config', 'user.name', 'Harness Test');
    // ホストの Git hook 設定をテスト用リポジトリに持ち込まない。
    git('config', 'core.hooksPath', join(root, 'no-hooks'));
    write('README.md');
    git('add', '.');
    git('commit', '-qm', 'fixture');
    return { root, git, write };
}

test('changed paths include unstaged, staged and untracked names with whitespace', t => {
    const { root, git, write } = fixture(t);
    write('backend/old.py');
    git('add', '.');
    git('commit', '-qm', 'backend');
    write('backend/old.py', 'changed\n');
    write('web-ui/src/new file\nwith newline.tsx');
    write('scripts/check.mjs');
    git('add', 'scripts/check.mjs');
    assert.deepEqual(changedFiles(root), ['backend/old.py', 'scripts/check.mjs', 'web-ui/src/new file\nwith newline.tsx']);
    assert.deepEqual(changedFiles(root, { staged: true }), ['scripts/check.mjs']);
});

test('staged moves select both old and new ownership, even with identical content', t => {
    const { root, git, write } = fixture(t);
    write('backend/module.py');
    git('add', '.');
    git('commit', '-qm', 'module');
    mkdirSync(join(root, 'web-ui/src'), { recursive: true });
    git('mv', 'backend/module.py', 'web-ui/src/module.ts');
    const paths = changedFiles(root, { staged: true });
    assert.deepEqual(paths, ['backend/module.py', 'web-ui/src/module.ts']);
    assert.deepEqual(selectScopes(paths).scopes, ['frontend', 'backend']);
});

test('opposite staged and working changes are still checked', t => {
    const { root, git, write } = fixture(t);
    write('backend/module.py');
    git('add', '.');
    git('commit', '-qm', 'module');
    write('backend/module.py', 'staged\n');
    git('add', '.');
    write('backend/module.py');
    assert.deepEqual(changedFiles(root), ['backend/module.py']);
    assert.throws(() => changedFiles(root, { staged: true }), /Unstaged or untracked.*backend\/module.py/);
});

test('unstaged unrelated files do not block the staged check', t => {
    const { root, git, write } = fixture(t);
    write('backend/module.py');
    git('add', '.');
    write('README.md', 'local documentation\n');
    write('docs/untracked-notes.md');
    write('web-ui/src/unrelated.tsx');
    assert.deepEqual(changedFiles(root, { staged: true }), ['backend/module.py']);
});

test('staged skill source with regenerated but unstaged output cannot validate a stale index', t => {
    const { root, git, write } = fixture(t);
    const source = '.claude/skills/feature/SKILL.md';
    const generated = '.agents/skills/bunri-feature/SKILL.md';
    write(source, 'old skill\n');
    write(generated, 'old skill\n');
    git('add', '.');
    git('commit', '-qm', 'initial generated skill');
    write(source, 'new skill\n');
    git('add', source);
    write(generated, readFileSync(join(root, source), 'utf8'));
    assert.equal(git('show', `:${generated}`), 'old skill');
    assert.equal(readFileSync(join(root, generated), 'utf8'), 'new skill\n');
    assert.throws(() => changedFiles(root, { staged: true }), /Unstaged or untracked.*\.agents\/skills\/bunri-feature\/SKILL.md/);
    git('add', generated);
    assert.deepEqual(changedFiles(root, { staged: true }), [generated, source]);
});

test('new generated output must be staged even when an unrelated documentation commit triggers sync', t => {
    const { root, git, write } = fixture(t);
    write('README.md', 'documentation update\n');
    git('add', 'README.md');
    write('.codex/config.toml', 'model = "fixture"\n');
    assert.throws(() => changedFiles(root, { staged: true }), /Unstaged or untracked.*\.codex\/config.toml/);
});

test('staged frontend caller cannot depend on an unstaged or untracked callee', t => {
    const { root, git, write } = fixture(t);
    const caller = 'web-ui/src/caller.ts';
    const callee = 'web-ui/src/callee.ts';
    write(caller, "import { oldName } from './callee'; oldName();\n");
    write(callee, 'export function oldName() {}\n');
    git('add', '.');
    git('commit', '-qm', 'initial caller and callee');
    write(caller, "import { newName } from './callee'; newName();\n");
    git('add', caller);
    write(callee, 'export function newName() {}\n');
    assert.match(git('show', `:${callee}`), /oldName/);
    assert.deepEqual(git('diff', '--cached', '--name-only'), caller);
    assert.throws(() => changedFiles(root, { staged: true }), /Unstaged or untracked.*web-ui\/src\/callee.ts/);
    git('add', callee);
    write('web-ui/src/new-dependency.ts', 'export const value = 1;\n');
    assert.throws(() => changedFiles(root, { staged: true }), /Unstaged or untracked.*web-ui\/src\/new-dependency.ts/);
});

test('API integration activates frontend staging closure while generated artifacts stay irrelevant', t => {
    const { root, git, write } = fixture(t);
    write('backend/web/api.py');
    git('add', '.');
    write('web-ui/src/caller.ts');
    assert.throws(() => changedFiles(root, { staged: true }), /Unstaged or untracked.*web-ui\/src\/caller.ts/);
    git('add', 'web-ui/src/caller.ts');
    write('web-ui/dist/bundle.js');
    write('src-tauri/runtime/backend/main.py');
    write('.claude/worktrees/other/backend/main.py');
    assert.deepEqual(changedFiles(root, { staged: true }), ['backend/web/api.py', 'web-ui/src/caller.ts']);
});

test('--base adds committed branch changes and local untracked files', t => {
    const { root, git, write } = fixture(t);
    const base = git('rev-parse', 'HEAD');
    write('backend/module.py');
    git('add', '.');
    git('commit', '-qm', 'module');
    write('web-ui/src/untracked.tsx');
    assert.deepEqual(changedFiles(root, { base }), ['backend/module.py', 'web-ui/src/untracked.tsx']);
});

test('generated files, user data and Claude worktrees never request checks', () => {
    const paths = ['.claude/worktrees/other/backend/main.py', 'src-tauri/runtime/backend/main.py',
        'src-tauri/binaries/uv', 'src-tauri/gen/schemas/x.json', 'src-tauri/target/debug/x',
        'web-ui/node_modules/a.ts', 'web-ui/dist/x.js', 'web-ui/e2e-results/x.json',
        'results/x.wav', 'uploads/x.wav', 'projects/song.json', '.venv/x.py'];
    assert.deepEqual(selectScopes(paths), { scopes: [], e2e: false });
    assert.deepEqual(selectScopes(['web-ui/AGENTS.md', 'backend/AGENTS.md']).scopes, ['harness']);
});

test('frontend source changes require e2e; documentation alone does not', () => {
    const plan = buildPlan(['web-ui/src/panel.tsx']);
    assert.ok(plan.some(check => check.args.join(' ') === 'run e2e'));
    assert.deepEqual(buildPlan(['docs/ui-testing.md']), []);
    assert.ok(buildPlan([], { scope: 'backend', e2e: true }).some(check => check.args.join(' ') === 'run e2e'));
});

test('MCP source, setup script and harness documentation require harness verification', () => {
    for (const path of ['.mcp.json', 'scripts/setup-harness.mjs', 'docs/codex-harness.md']) {
        assert.deepEqual(selectScopes([path]), { scopes: ['harness'], e2e: false });
    }
});

test('API contract, access control and sidecar changes require frontend integration coverage', () => {
    for (const path of ['backend/web/api.py', 'backend/access_control.py', 'backend/run_web.py']) {
        assert.deepEqual(selectScopes([path]), { scopes: ['frontend', 'backend'], e2e: true });
        assert.ok(buildPlan([path]).some(check => check.args.join(' ') === 'run e2e'));
    }
    assert.deepEqual(selectScopes(['backend/edit.py']), { scopes: ['backend'], e2e: false });
});

test('staged mode runs only fast checks and always verifies generated instructions', () => {
    const plan = buildPlan([], { scope: 'all', staged: true });
    assert.deepEqual(plan.map(check => [check.command, ...check.args].join(' ')), [
        'node scripts/sync-codex-harness.mjs --check', 'npm run lint', 'npx --no-install tsc --noEmit',
        'uv run --frozen --no-sync ruff check backend test/back', 'cargo fmt --check',
    ]);
    assert.equal(plan.some(check => check.isolateData), false);
    assert.throws(() => parseArgs(['--staged', '--e2e']), /fast checks/);
    assert.throws(() => parseArgs(['--staged', '--base', 'main']), /cannot be combined/);
    assert.throws(() => parseArgs(['--scope', 'unknown']), /Unknown scope/);
    assert.throws(() => parseArgs(['--scope']), /needs a value/);
});

test('backend test uses fresh owned data and preserves the inherited directory', t => {
    const { root, write } = fixture(t);
    write('user-data/keep.wav', 'precious');
    const originalDataDir = join(root, 'user-data');
    let isolated;
    const plan = buildPlan([], { scope: 'backend' });
    const status = runPlan(plan, {
        root, env: { BUNRI_DATA_DIR: originalDataDir }, log: () => {},
        spawn: (command, args, options) => {
            if (args.includes('pytest')) {
                isolated = options.env.BUNRI_DATA_DIR;
                assert.notEqual(isolated, originalDataDir);
                assert.equal(existsSync(isolated), true);
                writeFileSync(join(isolated, 'generated.wav'), 'temporary');
            }
            return { status: 0 };
        },
    });
    assert.equal(status, 0);
    assert.equal(existsSync(isolated), false);
    assert.equal(readFileSync(join(originalDataDir, 'keep.wav'), 'utf8'), 'precious');
});

test('failure stops subsequent checks and removes only the owned temp directory', t => {
    const { root } = fixture(t);
    let calls = 0;
    let isolated;
    const plan = [{ scope: 'backend', cwd: '.', command: 'fixture', args: [], isolateData: true },
        { scope: 'backend', cwd: '.', command: 'must-not-run', args: [] }];
    assert.equal(runPlan(plan, { root, log: () => {}, spawn: (command, args, options) => {
        calls++;
        isolated = options.env.BUNRI_DATA_DIR;
        return { status: 7 };
    } }), 7);
    assert.equal(calls, 1);
    assert.equal(existsSync(isolated), false);
    assert.throws(() => runPlan(plan, { root, log: () => {}, spawn: () => ({ error: new Error('cannot spawn') }) }), /cannot spawn/);
});

test('automatic and explicitly requested e2e cannot inherit the live LLM opt-in', () => {
    const env = { BUNRI_E2E_LLM: '1', KEEP: 'value' };
    for (const plan of [buildPlan(['web-ui/src/panel.tsx']), buildPlan([], { e2e: true })]) {
        let sawE2e = false;
        assert.equal(runPlan(plan, { env, log: () => {}, spawn: (command, args, options) => {
            if (args.includes('e2e')) {
                sawE2e = true;
                assert.equal(options.env.BUNRI_E2E_LLM, undefined);
                assert.equal(options.env.KEEP, 'value');
            }
            return { status: 0 };
        } }), 0);
        assert.equal(sawE2e, true);
    }
    assert.equal(env.BUNRI_E2E_LLM, '1');
});

test('--list reports the plan without executing a check', t => {
    const { root } = fixture(t);
    const runner = resolve(dirname(fileURLToPath(import.meta.url)), 'check.mjs');
    // CLI は runner 自身のリポジトリを使う。明示 scope で未登録のサーバ起動を伴わず確認する。
    const result = spawnSync(process.execPath, [runner, '--scope', 'backend', '--list'], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /pytest.*temporary BUNRI_DATA_DIR/);
    assert.doesNotMatch(result.stdout, /passed|collected|All checks passed/);
});
