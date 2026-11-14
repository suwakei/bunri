#!/usr/bin/env node
// Claude 側のスキル・役割・MCP 設定から Codex の参照ファイルを生成する。
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const GENERATED_MARKER = '@generated scripts/sync-codex-harness.mjs';
const SKILLS = ['feature', 'qa'];
const ROLES = ['backend', 'frontend', 'desktop', 'reviewer'];
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function readText(root, relativePath) {
  try {
    return readFileSync(join(root, relativePath), 'utf8');
  } catch (error) {
    throw new Error(`${relativePath} を読めません: ${error.message}`);
  }
}

function metadata(root, relativePath) {
  const source = readText(root, relativePath);
  const frontmatter = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!frontmatter) throw new Error(`${relativePath}: frontmatter が必要です`);
  const result = {};
  for (const key of ['name', 'description']) {
    const matches = [...frontmatter[1].matchAll(new RegExp(`^${key}:[ \\t]*(.*)$`, 'gm'))];
    if (matches.length !== 1) throw new Error(`${relativePath}: ${key} は 1 行で 1 回指定してください`);
    let value = matches[0][1].trim();
    if (/^[|>][+-]?$/.test(value)) throw new Error(`${relativePath}: ${key} の複数行記法には対応していません`);
    try {
      if (value.startsWith('"')) value = JSON.parse(value);
      else if (value.startsWith("'")) {
        if (!value.endsWith("'")) throw new Error('引用符が閉じていません');
        value = value.slice(1, -1).replaceAll("''", "'");
      }
    } catch (error) {
      throw new Error(`${relativePath}: ${key} が不正です: ${error.message}`);
    }
    if (typeof value !== 'string' || !value.trim() || /[\r\n]/.test(value)) {
      throw new Error(`${relativePath}: ${key} は空でない 1 行の文字列にしてください`);
    }
    result[key] = value;
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(result.name)) {
    throw new Error(`${relativePath}: name は英小文字・数字・ハイフンのみ使用できます`);
  }
  return result;
}

function mcpConfig(root) {
  let parsed;
  try {
    parsed = JSON.parse(readText(root, '.mcp.json'));
  } catch (error) {
    throw new Error(`.mcp.json が不正です: ${error.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !parsed.mcpServers ||
      typeof parsed.mcpServers !== 'object' || Array.isArray(parsed.mcpServers)) {
    throw new Error('.mcp.json: mcpServers オブジェクトが必要です');
  }
  const lines = [`# ${GENERATED_MARKER}`, '# MCP の正準は .mcp.json。変更後に make harness-sync を実行する。'];
  for (const name of Object.keys(parsed.mcpServers).sort()) {
    const server = parsed.mcpServers[name];
    if (!/^[a-zA-Z0-9_-]+$/.test(name) || !server || typeof server !== 'object' || Array.isArray(server)) {
      throw new Error(`.mcp.json: MCP サーバ ${name} の定義が不正です`);
    }
    for (const key of Object.keys(server)) {
      if (!['command', 'args', 'url', 'env'].includes(key)) {
        throw new Error(`.mcp.json: ${name}.${key} の同期には対応していません`);
      }
    }
    if (Boolean(server.command) === Boolean(server.url)) {
      throw new Error(`.mcp.json: ${name} は command または url の一方を指定してください`);
    }
    for (const key of ['command', 'url']) {
      if (key in server && (typeof server[key] !== 'string' || !server[key].trim())) {
        throw new Error(`.mcp.json: ${name}.${key} は空でない文字列にしてください`);
      }
    }
    if ('args' in server && (!server.command || !Array.isArray(server.args) || server.args.some((arg) => typeof arg !== 'string'))) {
      throw new Error(`.mcp.json: ${name}.args は command 用の文字列配列にしてください`);
    }
    if ('env' in server && (!server.command || !server.env || typeof server.env !== 'object' ||
        Array.isArray(server.env) || Object.values(server.env).some((value) => typeof value !== 'string'))) {
      throw new Error(`.mcp.json: ${name}.env は command 用の文字列マップにしてください`);
    }
    lines.push('', `[mcp_servers.${name}]`);
    for (const key of ['command', 'args', 'url']) {
      if (key in server) lines.push(`${key} = ${JSON.stringify(server[key])}`);
    }
    if (server.env && Object.keys(server.env).length) {
      lines.push('', `[mcp_servers.${name}.env]`);
      for (const key of Object.keys(server.env).sort()) {
        lines.push(`${JSON.stringify(key)} = ${JSON.stringify(server.env[key])}`);
      }
    }
  }
  return `${lines.join('\n')}\n`;
}

export function buildArtifacts(root) {
  readText(root, 'AGENTS.md');
  const artifacts = new Map();
  for (const skill of SKILLS) {
    const source = `.claude/skills/${skill}/SKILL.md`;
    const { name, description } = metadata(root, source);
    const generatedName = `bunri-${name}`;
    const output = `.agents/skills/${generatedName}/SKILL.md`;
    if (artifacts.has(output)) throw new Error(`${source}: 生成先 ${output} が重複しています`);
    artifacts.set(output, `---
name: ${generatedName}
description: ${JSON.stringify(description)}
---

<!-- ${GENERATED_MARKER} -->

# ${generatedName}

[AGENTS.md](../../../AGENTS.md) を読み、続けて [${source}](../../../${source}) の手順に従う。
規約と手順の正準は参照先に置き、このファイルは直接編集しない。
`);
  }
  for (const role of ROLES) {
    const source = `.claude/agents/${role}.md`;
    const { name, description } = metadata(root, source);
    if (name !== role) throw new Error(`${source}: name は ${role} にしてください`);
    const instructions = `最初にリポジトリルートの AGENTS.md を読み、次に ${source} を読んで担当範囲と手順に従う。参照パスはリポジトリルートから解決する。`;
    artifacts.set(`.codex/agents/${role}.toml`, `# ${GENERATED_MARKER}
name = ${JSON.stringify(name)}
description = ${JSON.stringify(description)}
developer_instructions = ${JSON.stringify(instructions)}
`);
  }
  artifacts.set('.codex/config.toml', mcpConfig(root));
  return artifacts;
}

function currentContent(root, relativePath) {
  const path = join(root, relativePath);
  if (!existsSync(path)) return null;
  if (!lstatSync(path).isFile()) throw new Error(`${relativePath}: 通常ファイル以外は上書きできません`);
  return readText(root, relativePath);
}

function generatedPaths(root) {
  const result = [];
  const skillsPath = join(root, '.agents/skills');
  if (existsSync(skillsPath)) {
    for (const entry of readdirSync(skillsPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const relative = `.agents/skills/${entry.name}/SKILL.md`;
      if (currentContent(root, relative)?.includes(GENERATED_MARKER)) result.push(relative);
    }
  }
  const agentsPath = join(root, '.codex/agents');
  if (existsSync(agentsPath)) {
    for (const entry of readdirSync(agentsPath, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.toml')) continue;
      const relative = `.codex/agents/${entry.name}`;
      if (currentContent(root, relative)?.includes(GENERATED_MARKER)) result.push(relative);
    }
  }
  return result.sort();
}

export function syncHarness(root, { check = false } = {}) {
  const artifacts = buildArtifacts(root);
  const updates = [];
  for (const [relativePath, content] of artifacts) {
    const current = currentContent(root, relativePath);
    if (current !== null && !current.includes(GENERATED_MARKER)) {
      throw new Error(`${relativePath}: 手書きファイルとの衝突を検出しました。上書きしません`);
    }
    if (current !== content) updates.push(relativePath);
  }
  const stale = generatedPaths(root).filter((relativePath) => !artifacts.has(relativePath));
  if (check && (updates.length || stale.length)) {
    throw new Error(`Codex ハーネスが古いです。make harness-sync を実行してください:\n${[
      ...updates.map((path) => `  更新: ${path}`), ...stale.map((path) => `  不要: ${path}`),
    ].join('\n')}`);
  }
  if (!check) {
    for (const relativePath of updates) {
      const path = join(root, relativePath);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, artifacts.get(relativePath));
    }
    for (const relativePath of stale) unlinkSync(join(root, relativePath));
  }
  return { count: artifacts.size, updates, stale };
}

export function runCli(args, root = ROOT) {
  if (args.some((arg) => !['--check', '--help'].includes(arg)) || new Set(args).size !== args.length || args.length > 1) {
    throw new Error('使い方: node scripts/sync-codex-harness.mjs [--check | --help]');
  }
  if (args.includes('--help')) return '使い方: node scripts/sync-codex-harness.mjs [--check | --help]';
  const check = args.includes('--check');
  const { count, updates, stale } = syncHarness(root, { check });
  return check ? `Codex ハーネスは最新です (${count} ファイル)` :
    `Codex ハーネスを同期しました (${count} ファイル / 更新 ${updates.length} / 不要 ${stale.length})`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(runCli(process.argv.slice(2)));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
