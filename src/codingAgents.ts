import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { CodingAgentId, CodingAgentStatus } from './types';

export { CodingAgentId, CodingAgentStatus };

const AGENT_DEFINITIONS: ReadonlyArray<{
	readonly id: CodingAgentId;
	readonly name: string;
	readonly kind: 'chat' | 'cli';
	readonly extensionIds: ReadonlyArray<string>;
	readonly binaries: ReadonlyArray<string>;
}> = [
	{
		id: 'copilot-chat',
		name: 'Copilot Chat',
		kind: 'chat',
		extensionIds: ['github.copilot-chat', 'github.copilot'],
		binaries: []
	},
	{
		id: 'claude-code',
		name: 'Claude Code',
		kind: 'cli',
		extensionIds: ['anthropic.claude-code'],
		binaries: ['claude']
	},
	{
		id: 'codex',
		name: 'Codex',
		kind: 'cli',
		extensionIds: ['openai.chatgpt'],
		binaries: ['codex']
	},
	{
		id: 'copilot-cli',
		name: 'GitHub Copilot CLI',
		kind: 'cli',
		extensionIds: [],
		binaries: ['github-copilot-cli']
	},
	{
		id: 'opencode',
		name: 'OpenCode',
		kind: 'cli',
		extensionIds: [],
		binaries: ['opencode']
	}
];

const HOOK_START_MARKER = '# BEGIN git-map-agent-hook';
const HOOK_END_MARKER = '# END git-map-agent-hook';

function checkBinaryOnPath(bin: string): Promise<boolean> {
	return new Promise((resolve) => {
		const locator = process.platform === 'win32' ? 'where' : 'which';
		cp.execFile(locator, [bin], { timeout: 1500 }, (err) => {
			resolve(err === null);
		});
	});
}

function getMcpConfigPath(repoRoot: string, agentId: CodingAgentId): string {
	return agentId === 'copilot-chat'
		? path.join(repoRoot, '.vscode', 'mcp.json')
		: path.join(repoRoot, '.mcp.json');
}

function getMcpRootKey(agentId: CodingAgentId): 'servers' | 'mcpServers' {
	return agentId === 'copilot-chat' ? 'servers' : 'mcpServers';
}

export function hasGitMapMcpEntry(rawJson: string, agentId: CodingAgentId): boolean {
	try {
		const parsed = JSON.parse(rawJson);
		if (typeof parsed !== 'object' || parsed === null) return false;
		const key = getMcpRootKey(agentId);
		const map = parsed[key];
		return typeof map === 'object' && map !== null && typeof map['git-map'] === 'object' && map['git-map'] !== null;
	} catch (_) {
		return false;
	}
}

export function upsertGitMapMcpJson(
	existingRaw: string,
	agentId: CodingAgentId,
	serverScriptPath: string,
	repoRoot: string,
	enable: boolean
): string {
	let root: Record<string, unknown> = {};
	if (existingRaw.trim() !== '') {
		try {
			const parsed = JSON.parse(existingRaw);
			if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
				root = Object.assign({}, parsed);
			}
		} catch (_) {
			root = {};
		}
	}
	const key = getMcpRootKey(agentId);
	const existingMap = typeof root[key] === 'object' && root[key] !== null && !Array.isArray(root[key])
		? Object.assign({}, root[key] as Record<string, unknown>)
		: {};
	if (enable) {
		existingMap['git-map'] = {
			command: 'node',
			args: [serverScriptPath, '--repo', repoRoot]
		};
	} else {
		delete existingMap['git-map'];
	}
	root[key] = existingMap;
	return JSON.stringify(root, null, '\t') + '\n';
}

export function upsertAgentHookScript(existingHook: string, agentId: CodingAgentId, enable: boolean): string {
	const blockRegex = new RegExp(
		HOOK_START_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
		'[\\s\\S]*?' +
		HOOK_END_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
		'\\n?',
		'g'
	);
	const stripped = existingHook.replace(blockRegex, '').replace(/\s+$/, '');
	if (!enable) {
		return stripped === '' || stripped === '#!/bin/sh' ? '' : stripped + '\n';
	}
	const shebang = stripped.startsWith('#!') ? '' : '#!/bin/sh\n';
	const block = [
		HOOK_START_MARKER + ' (' + agentId + ')',
		'# Git Map local context trailer hint for coding agents',
		'if [ -n "$1" ] && [ -f "$1" ]; then',
		'\t:',
		'fi',
		HOOK_END_MARKER
	].join('\n');
	return (shebang + (stripped !== '' ? stripped + '\n\n' : '') + block + '\n');
}

function resolveGitHooksDir(repoRoot: string): Promise<string> {
	return new Promise((resolve) => {
		cp.execFile('git', ['-C', repoRoot, 'rev-parse', '--git-path', 'hooks'], { timeout: 2000 }, (err, stdout) => {
			if (err === null && stdout.trim() !== '') {
				const raw = stdout.trim();
				resolve(path.isAbsolute(raw) ? raw : path.resolve(repoRoot, raw));
			} else {
				resolve(path.join(repoRoot, '.git', 'hooks'));
			}
		});
	});
}

export async function detectCodingAgents(repoRoot: string | null, defaultAgent: string): Promise<CodingAgentStatus[]> {
	const results: CodingAgentStatus[] = [];
	const hooksDir = repoRoot !== null ? await resolveGitHooksDir(repoRoot) : null;
	const hookFile = hooksDir !== null ? path.join(hooksDir, 'prepare-commit-msg') : null;
	const hookContent = hookFile !== null && fs.existsSync(hookFile) ? fs.readFileSync(hookFile, 'utf8') : '';

	for (let i = 0; i < AGENT_DEFINITIONS.length; i++) {
		const def = AGENT_DEFINITIONS[i];
		let detected = def.extensionIds.some((extId) => typeof vscode.extensions.getExtension === 'function' && typeof vscode.extensions.getExtension(extId) !== 'undefined');
		if (!detected && def.binaries.length > 0) {
			for (let b = 0; b < def.binaries.length; b++) {
				if (await checkBinaryOnPath(def.binaries[b])) {
					detected = true;
					break;
				}
			}
		}
		let mcpConfigured = false;
		let hooksConfigured = false;
		if (repoRoot !== null) {
			const mcpPath = getMcpConfigPath(repoRoot, def.id);
			if (fs.existsSync(mcpPath)) {
				mcpConfigured = hasGitMapMcpEntry(fs.readFileSync(mcpPath, 'utf8'), def.id);
			}
			hooksConfigured = hookContent.includes(HOOK_START_MARKER + ' (' + def.id + ')') ||
				(def.kind === 'cli' && hookContent.includes(HOOK_START_MARKER));
		}
		results.push({
			id: def.id,
			name: def.name,
			kind: def.kind,
			detected: detected,
			isDefault: defaultAgent === def.id,
			mcpConfigured: mcpConfigured,
			hooksConfigured: hooksConfigured
		});
	}
	return results;
}

export async function toggleCodingAgentMcp(
	repoRoot: string,
	extensionPath: string,
	agentId: CodingAgentId,
	enable: boolean
): Promise<{ readonly ok: boolean, readonly configPath: string, readonly error: string | null }> {
	const configPath = getMcpConfigPath(repoRoot, agentId);
	const serverScript = path.join(extensionPath, 'out', 'mcpServerCli.js');
	try {
		await fs.promises.mkdir(path.dirname(configPath), { recursive: true });
		const existing = fs.existsSync(configPath) ? await fs.promises.readFile(configPath, 'utf8') : '';
		const next = upsertGitMapMcpJson(existing, agentId, serverScript, repoRoot, enable);
		await fs.promises.writeFile(configPath, next, 'utf8');
		return { ok: true, configPath: configPath, error: null };
	} catch (err) {
		return { ok: false, configPath: configPath, error: err instanceof Error ? err.message : String(err) };
	}
}

export async function toggleCodingAgentHooks(
	repoRoot: string,
	agentId: CodingAgentId,
	enable: boolean
): Promise<{ readonly ok: boolean, readonly hookPath: string, readonly error: string | null }> {
	const hooksDir = await resolveGitHooksDir(repoRoot);
	const hookPath = path.join(hooksDir, 'prepare-commit-msg');
	try {
		await fs.promises.mkdir(hooksDir, { recursive: true });
		const existing = fs.existsSync(hookPath) ? await fs.promises.readFile(hookPath, 'utf8') : '';
		const next = upsertAgentHookScript(existing, agentId, enable);
		if (next === '') {
			if (fs.existsSync(hookPath)) await fs.promises.unlink(hookPath);
		} else {
			await fs.promises.writeFile(hookPath, next, { encoding: 'utf8', mode: 0o755 });
			if (process.platform !== 'win32') {
				await fs.promises.chmod(hookPath, 0o755);
			}
		}
		return { ok: true, hookPath: hookPath, error: null };
	} catch (err) {
		return { ok: false, hookPath: hookPath, error: err instanceof Error ? err.message : String(err) };
	}
}
