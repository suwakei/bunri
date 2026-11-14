#!/usr/bin/env node
/** 変更箇所から検証を選び、ユーザーの音声データを触らずに実行する。 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCOPES = ['frontend', 'backend', 'desktop', 'harness'];
const HELP = `Usage: node scripts/check.mjs [--scope frontend|backend|desktop|all|harness]
       [--e2e] [--desktop-e2e] [--list] [--staged | --base REF]

Without --scope, select checks from tracked and untracked changes.
UI changes automatically include Playwright. --e2e also requests it explicitly.
Native, CSP, font, bundle, sidecar and export changes include native E2E on macOS.
--desktop-e2e requests native E2E explicitly. --scope all runs both E2E suites.
--base REF includes changes since the merge base with REF, plus local changes.
--staged selects cached paths; relevant scopes and harness must be fully staged.
--list prints the plan without running checks or creating temporary data.
Live LLM E2E tests are always disabled here; run them explicitly outside this runner.
`;

export function parseArgs(args) {
    const options = { scope: null, e2e: false, desktopE2e: false, list: false, staged: false, base: null, help: false };
    for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        if (arg === '--scope' || arg === '--base') {
            const value = args[++index];
            if (!value || value.startsWith('-')) throw new Error(`${arg} needs a value`);
            options[arg === '--scope' ? 'scope' : 'base'] = value;
        } else if (arg === '--e2e') options.e2e = true;
        else if (arg === '--desktop-e2e') options.desktopE2e = true;
        else if (arg === '--list') options.list = true;
        else if (arg === '--staged') options.staged = true;
        else if (arg === '--help' || arg === '-h') options.help = true;
        else throw new Error(`Unknown argument: ${arg}`);
    }
    if (options.scope && ![...SCOPES, 'all'].includes(options.scope)) throw new Error(`Unknown scope: ${options.scope}`);
    if (options.staged && options.base) throw new Error('--staged and --base cannot be combined');
    if (options.staged && (options.e2e || options.desktopE2e)) throw new Error('--staged only runs fast checks; omit E2E flags');
    return options;
}

function gitOutput(root, args) {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.trim()}`);
    return result.stdout;
}

/** --no-renames により、移動元・移動先を両方検証対象にする。 */
export function changedFiles(root, options = {}) {
    const paths = [];
    const diff = (...revisions) => {
        paths.push(...gitOutput(root, ['diff', '--name-only', '--no-renames', '-z', ...revisions, '--']).split('\0').filter(Boolean));
    };
    if (options.staged) {
        diff('--cached');
        // 検査する作業ツリーと index を、対象領域の依存ファイルも含めて一致させる。
        // 同じパスの部分 stage だけを見ると、callee や生成済み設定の stage 漏れを見逃す。
        const activeScopes = new Set(['harness', ...selectScopes(paths).scopes]);
        if (options.scope === 'all') SCOPES.forEach(scope => activeScopes.add(scope));
        else if (options.scope) activeScopes.add(options.scope);
        const localOnly = new Set([
            ...gitOutput(root, ['diff', '--name-only', '--no-renames', '-z', '--']).split('\0').filter(Boolean),
            ...gitOutput(root, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean),
        ]);
        const unsafe = [...localOnly].filter(path => selectScopes([path]).scopes.some(scope => activeScopes.has(scope))).sort();
        if (unsafe.length) throw new Error(`Unstaged or untracked files in checked scopes would validate different contents from the commit. Stage these changes, or unstage the dependent changes before committing: ${unsafe.map(path => JSON.stringify(path)).join(', ')}`);
    }
    else {
        if (options.base) {
            const base = gitOutput(root, ['merge-base', options.base, 'HEAD']).trim();
            diff(base, 'HEAD');
        }
        // staged と unstaged が逆向きでも、それぞれの変更を見落とさない。
        diff('--cached');
        diff();
        paths.push(...gitOutput(root, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean));
    }
    return [...new Set(paths)].sort();
}

const GENERATED = /(^|\/)(node_modules|target|dist|__pycache__|\.venv|\.git|\.pytest_cache|\.ruff_cache|e2e-results|e2e-desktop-results|playwright-report)(\/|$)|^\.claude\/worktrees\/|^(uploads|results|projects|soundfonts)\/|^src-tauri\/(binaries|runtime|gen)\//;

/** ブラウザでは拾えない起動・認証・同梱フォント・ファイル書き出しの経路。 */
function needsDesktopE2e(path) {
    return path.startsWith('src-tauri/')
        || path.startsWith('web-ui/e2e-desktop/')
        || /^web-ui\/src\/(styles\/|assets\/|fonts\/)/.test(path)
        || /^web-ui\/src\/.*(?:export|download|font)/i.test(path)
        || /^web-ui\/src\/lib\/(api|dialog|engine|midi|project-file|project-actions|project-prompts|project-snapshot|storage)\.ts$/.test(path)
        || ['scripts/desktop-csp.mjs', 'scripts/prepare-desktop.mjs', 'package.json', 'package-lock.json',
            'pyproject.toml', 'uv.lock', '.python-version', 'web-ui/package.json', 'web-ui/package-lock.json',
            'web-ui/index.html', 'web-ui/vite.config.js', 'web-ui/src/main.tsx',
            'web-ui/src/components/HeaderBar.tsx', 'web-ui/src/components/BootMessage.tsx',
            'backend/web/api.py', 'backend/web/project_routes.py', 'backend/access_control.py',
            'backend/run_web.py', 'backend/audio_utils.py', 'backend/bunri_file.py', 'backend/project_store.py'].includes(path);
}

export function selectScopes(paths) {
    const selected = new Set();
    let e2e = false;
    let desktopE2e = false;
    for (const path of paths) {
        if (GENERATED.test(path)) continue;
        if (path === '.gitmodules' || path === 'third_party/sfizz' || path.startsWith('third_party/sfizz/')) {
            selected.add('desktop');
            desktopE2e = true;
            // submodule 内の AGENTS やテストを、このプロジェクトの設定として扱わない。
            continue;
        }
        if (!path.endsWith('.md') && needsDesktopE2e(path)) desktopE2e = true;
        if (path === 'Makefile' || path.startsWith('.github/workflows/')) SCOPES.forEach(scope => selected.add(scope));
        if (/(^|\/)AGENTS(?:\.override)?\.md$/.test(path)
            || /^(\.agents|\.codex|\.githooks)\//.test(path)
            || /^\.claude\/(CLAUDE\.md|skills\/|agents\/)/.test(path)
            || /^scripts\/(check(?:\.test)?\.mjs|.*codex.*)$/.test(path)
            || ['.gitignore', '.mcp.json', 'scripts/setup-harness.mjs', 'docs/codex-harness.md'].includes(path)) selected.add('harness');
        if (path.startsWith('web-ui/') && !path.endsWith('.md')) {
            selected.add('frontend');
            e2e = true;
        }
        if (/^(backend\/|test\/back\/)/.test(path) && !path.endsWith('.md')
            || ['pyproject.toml', 'uv.lock', '.python-version'].includes(path)) selected.add('backend');
        if (path.startsWith('src-tauri/') && !path.endsWith('.md')
            || ['package.json', 'package-lock.json', 'scripts/prepare-desktop.mjs'].includes(path)) selected.add('desktop');
        if (['scripts/dev-web.mjs', 'backend/web/api.py', 'backend/access_control.py', 'backend/run_web.py'].includes(path)
            || /^backend\/web\/[^/]+_routes\.py$/.test(path)) {
            selected.add('frontend');
            selected.add('backend');
            e2e = true;
        }
        if (path === 'scripts/desktop-csp.mjs' || path === 'src-tauri/tauri.conf.json') {
            selected.add('frontend');
            selected.add('desktop');
            e2e = true;
        }
    }
    return { scopes: SCOPES.filter(scope => selected.has(scope)), e2e, desktopE2e };
}

export function buildPlan(paths, options = {}) {
    const detected = selectScopes(paths);
    const scopes = options.scope === 'all' ? SCOPES : options.scope ? [options.scope] : detected.scopes;
    const commands = [];
    const add = (scope, cwd, command, args, extra = {}) => commands.push({ scope, cwd, command, args, ...extra });
    // コミット時は設定の同期を常に確認する。検証は index のコピーではなく作業ツリーに対して行う。
    if (options.staged || scopes.includes('harness')) add('harness', '.', 'node', ['scripts/sync-codex-harness.mjs', '--check']);
    if (scopes.includes('frontend')) {
        add('frontend', 'web-ui', 'npm', ['run', 'lint']);
        add('frontend', 'web-ui', 'npx', ['--no-install', 'tsc', '--noEmit']);
        if (!options.staged) {
            add('frontend', 'web-ui', 'npm', ['test']);
            add('frontend', 'web-ui', 'npm', ['run', 'build']);
        }
    }
    if (scopes.includes('backend')) {
        add('backend', '.', 'uv', ['run', '--frozen', ...(options.staged ? ['--no-sync'] : []), 'ruff', 'check', 'backend', 'test/back']);
        if (!options.staged) add('backend', '.', 'uv', ['run', '--frozen', 'python', '-m', 'pytest', 'test/back', '-q'], { isolateData: true });
    }
    if (scopes.includes('desktop')) {
        if (!options.staged) add('desktop', '.', 'node', ['scripts/prepare-desktop.mjs']);
        add('desktop', 'src-tauri', 'cargo', ['fmt', '--all', '--check']);
        if (!options.staged) {
            add('desktop', 'src-tauri', 'cargo', ['clippy', '--workspace', '--locked', '--all-targets', '--', '-D', 'warnings']);
            add('desktop', 'src-tauri', 'cargo', ['clippy', '--locked', '--all-targets', '--features', 'e2e', '--', '-D', 'warnings']);
            add('desktop', 'src-tauri', 'cargo', ['tree', '--locked', '-e', 'normal', '--prefix', 'none'], { forbidWebdriver: true });
            add('desktop', 'src-tauri', 'cargo', ['test', '--workspace', '--locked']);
        }
    }
    if (scopes.includes('harness') && !options.staged) add('harness', '.', 'node', ['--test', 'scripts/check.test.mjs', 'scripts/sync-codex-harness.test.mjs']);
    if (!options.staged && (options.scope === 'all' || options.e2e || (scopes.includes('frontend') && detected.e2e))) add('frontend', 'web-ui', 'npm', ['run', 'e2e'], { disableLiveLlm: true });
    if (!options.staged && (options.scope === 'all' || options.desktopE2e
        || (detected.desktopE2e && scopes.some(scope => detected.scopes.includes(scope))))) add('desktop', 'web-ui', 'npm', ['run', 'e2e:desktop'], { disableLiveLlm: true });
    return commands;
}

export function assertDefaultDependencies(tree) {
    if (typeof tree !== 'string') throw new Error('Cannot inspect default dependencies: cargo tree returned no text');
    if (/^tauri-plugin-wdio-webdriver(?:\s|$)/m.test(tree)) throw new Error('Default dependencies include the test-only WebDriver server');
}

export function runPlan(plan, { root = ROOT, env = process.env, spawn = spawnSync, log = console.log } = {}) {
    for (const check of plan) {
        log(`[${check.scope}] (${check.cwd}) ${[check.command, ...check.args].join(' ')}`);
        let dataDir;
        try {
            if (check.isolateData) dataDir = mkdtempSync(join(tmpdir(), 'bunri-check-'));
            const checkEnv = { ...env };
            if (dataDir) checkEnv.BUNRI_DATA_DIR = dataDir;
            if (check.disableLiveLlm) delete checkEnv.BUNRI_E2E_LLM;
            const result = spawn(check.command, check.args, {
                cwd: resolve(root, check.cwd),
                stdio: check.forbidWebdriver ? ['inherit', 'pipe', 'inherit'] : 'inherit',
                encoding: 'utf8',
                maxBuffer: 16 * 1024 * 1024,
                env: checkEnv,
            });
            if (result.error) throw result.error;
            if (result.status !== 0) {
                log(`Check failed${result.signal ? ` (${result.signal})` : ''}: ${check.command}`);
                return result.status || 1;
            }
            if (check.forbidWebdriver) assertDefaultDependencies(result.stdout);
        } finally {
            // この呼び出しで作った一時ディレクトリだけを削除する。
            if (dataDir) rmSync(dataDir, { recursive: true, force: true });
        }
    }
    return 0;
}

export function main(args = process.argv.slice(2), root = ROOT) {
    try {
        const options = parseArgs(args);
        if (options.help) { console.log(HELP); return 0; }
        const files = changedFiles(root, options);
        const plan = buildPlan(files, options);
        if (options.list) {
            for (const check of plan) console.log(`[${check.scope}] (${check.cwd}) ${[check.command, ...check.args].join(' ')}${check.isolateData ? ' [temporary BUNRI_DATA_DIR]' : ''}`);
            if (!plan.length) console.log('No relevant changes.');
            return 0;
        }
        if (!plan.length) { console.log('No relevant changes.'); return 0; }
        return runPlan(plan, { root });
    } catch (error) {
        console.error(`[check] ${error.message}`);
        return 1;
    }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
