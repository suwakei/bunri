import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { buildArtifacts, GENERATED_MARKER, runCli, syncHarness } from './sync-codex-harness.mjs';

function put(root, path, content) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'bunri-harness-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  put(root, 'AGENTS.md', '# 作業ルール\n');
  for (const skill of ['feature', 'qa']) {
    put(root, `.claude/skills/${skill}/SKILL.md`, `---\nname: ${skill}\ndescription: ${JSON.stringify(`${skill}: 日本語の説明 "引用"`)}\n---\n\n# 手順\n`);
  }
  for (const role of ['backend', 'frontend', 'desktop', 'reviewer']) {
    put(root, `.claude/agents/${role}.md`, `---\nname: ${role}\ndescription: ${role} の担当範囲\n---\n\n# 指示\n`);
  }
  put(root, '.mcp.json', JSON.stringify({ mcpServers: { playwright: {
    command: 'npx', args: ['-y', '@playwright/mcp@0.0.85', '--isolated'],
  } } }));
  return root;
}

function snapshot(root, base = '') {
  return readdirSync(join(root, base), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry) => {
    const path = join(base, entry.name);
    return entry.isDirectory() ? snapshot(root, path) : [[path, readFileSync(join(root, path), 'utf8')]];
  });
}

test('生成先のリンクは元ファイルを指し、設定は MCP のみを同期する', (t) => {
  const root = fixture(t);
  const artifacts = buildArtifacts(root);
  assert.equal(artifacts.size, 7);
  const skillPath = '.agents/skills/bunri-feature/SKILL.md';
  const skill = artifacts.get(skillPath);
  assert.match(skill, /^name: bunri-feature$/m);
  assert.match(skill, /description: "feature: 日本語の説明 \\"引用\\""/);
  for (const [, href] of skill.matchAll(/\]\(([^)]+)\)/g)) {
    assert.ok(existsSync(resolve(root, dirname(skillPath), href)), href);
  }
  const config = artifacts.get('.codex/config.toml');
  assert.match(config, /\[mcp_servers.playwright\]/);
  assert.match(config, /args = \["-y","@playwright\/mcp@0.0.85","--isolated"\]/);
  assert.doesNotMatch(config, /model|approval_policy|sandbox|network_access/);
  for (const role of ['backend', 'frontend', 'desktop', 'reviewer']) {
    const agent = artifacts.get(`.codex/agents/${role}.toml`);
    assert.match(agent, new RegExp(`name = "${role}"`));
    assert.match(agent, /developer_instructions = /);
    assert.match(agent, new RegExp(`\\.claude/agents/${role}\\.md`));
  }
});

test('同期は冪等で、--check は不足・編集・不要ファイルを検出して一切変更しない', (t) => {
  const root = fixture(t);
  const before = snapshot(root);
  assert.throws(() => syncHarness(root, { check: true }), /ハーネスが古い/);
  assert.deepEqual(snapshot(root), before);
  assert.equal(syncHarness(root).updates.length, 7);
  const generated = snapshot(root);
  assert.equal(syncHarness(root).updates.length, 0);
  assert.deepEqual(snapshot(root), generated);
  assert.doesNotThrow(() => syncHarness(root, { check: true }));
  put(root, '.codex/agents/backend.toml', `${readFileSync(join(root, '.codex/agents/backend.toml'), 'utf8')}# 手動編集\n`);
  put(root, '.agents/skills/bunri-old/SKILL.md', `<!-- ${GENERATED_MARKER} -->\n旧設定\n`);
  const drifted = snapshot(root);
  assert.throws(() => syncHarness(root, { check: true }), /更新: .codex\/agents\/backend.toml[\s\S]*不要: .agents\/skills\/bunri-old\/SKILL.md/);
  assert.deepEqual(snapshot(root), drifted);
});

test('不要な生成ファイルだけを削除し、同じディレクトリの利用者ファイルを保存する', (t) => {
  const root = fixture(t);
  syncHarness(root);
  put(root, '.agents/skills/bunri-old/SKILL.md', `<!-- ${GENERATED_MARKER} -->\n`);
  put(root, '.agents/skills/bunri-old/notes.md', '利用者のメモ\n');
  put(root, '.agents/skills/custom/SKILL.md', '# 独自スキル\n');
  put(root, '.codex/agents/old.toml', `# ${GENERATED_MARKER}\n`);
  put(root, '.codex/agents/custom.toml', '# 独自エージェント\n');
  assert.deepEqual(syncHarness(root).stale, ['.agents/skills/bunri-old/SKILL.md', '.codex/agents/old.toml']);
  assert.equal(existsSync(join(root, '.agents/skills/bunri-old/SKILL.md')), false);
  assert.equal(readFileSync(join(root, '.agents/skills/bunri-old/notes.md'), 'utf8'), '利用者のメモ\n');
  assert.equal(readFileSync(join(root, '.agents/skills/custom/SKILL.md'), 'utf8'), '# 独自スキル\n');
  assert.equal(readFileSync(join(root, '.codex/agents/custom.toml'), 'utf8'), '# 独自エージェント\n');
});

test('手書きファイルとの衝突時は生成を始めず、利用者の設定を保存する', (t) => {
  const root = fixture(t);
  put(root, '.codex/config.toml', '# 利用者の設定\nmodel = "chosen-model"\n');
  const before = snapshot(root);
  assert.throws(() => syncHarness(root), /手書きファイルとの衝突/);
  assert.deepEqual(snapshot(root), before);
});

test('元ファイルの欠落・不正なメタデータ・MCP 設定では書き込まない', (t) => {
  for (const mutate of [
    (root) => unlinkSync(join(root, '.claude/agents/desktop.md')),
    (root) => put(root, '.claude/skills/qa/SKILL.md', 'frontmatter がない\n'),
    (root) => put(root, '.claude/skills/qa/SKILL.md', '---\nname: qa\ndescription: |\n  複数行\n---\n'),
    (root) => put(root, '.claude/skills/qa/SKILL.md', '---\nname: qa\ndescription:\n---\n'),
    (root) => put(root, '.mcp.json', '{broken'),
    (root) => put(root, '.mcp.json', JSON.stringify({ mcpServers: { playwright: { command: 'npx', args: 'invalid' } } })),
  ]) {
    const root = fixture(t);
    mutate(root);
    const before = snapshot(root);
    assert.throws(() => syncHarness(root));
    assert.deepEqual(snapshot(root), before);
  }
});

test('不明な引数を拒否し、ヘルプ表示は元ファイルを要求しない', (t) => {
  const root = fixture(t);
  const before = snapshot(root);
  assert.throws(() => runCli(['--unknown'], root), /使い方/);
  assert.throws(() => runCli(['--check', '--check'], root), /使い方/);
  assert.throws(() => runCli(['--check', '--help'], root), /使い方/);
  assert.match(runCli(['--help'], join(root, 'missing')), /使い方/);
  assert.deepEqual(snapshot(root), before);
});
