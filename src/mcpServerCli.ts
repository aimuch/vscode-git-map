import * as cp from 'child_process';
import * as path from 'path';
import * as readline from 'readline';

interface JsonRpcRequest {
	readonly jsonrpc: string;
	readonly id?: number | string | null;
	readonly method: string;
	readonly params?: Record<string, unknown>;
}

function parseRepoArg(argv: ReadonlyArray<string>): string {
	for (let i = 0; i < argv.length - 1; i++) {
		if (argv[i] === '--repo' && typeof argv[i + 1] === 'string' && argv[i + 1] !== '') {
			return path.resolve(argv[i + 1]);
		}
	}
	return process.cwd();
}

function execGitReadOnly(repo: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		cp.execFile('git', args, { cwd: repo, maxBuffer: 2 * 1024 * 1024, timeout: 8000 }, (err, stdout, stderr) => {
			if (err !== null) {
				reject(new Error((stderr || err.message).trim()));
			} else {
				resolve(stdout);
			}
		});
	});
}

export const MCP_TOOL_DEFINITIONS = [
	{
		name: 'git_map_status',
		description: 'Read current branch, upstream tracking status, and uncommitted files in the repository.',
		inputSchema: { type: 'object', properties: {} }
	},
	{
		name: 'git_map_recent_commits',
		description: 'List recent commits in the repository with hash, author, date, and subject.',
		inputSchema: {
			type: 'object',
			properties: {
				limit: { type: 'number', description: 'Maximum commits to return (1-50).' }
			}
		}
	},
	{
		name: 'git_map_diff',
		description: 'Get unified diff for uncommitted working tree changes or a specific commit hash.',
		inputSchema: {
			type: 'object',
			properties: {
				commit: { type: 'string', description: 'Optional commit hash (4-40 hex chars). Omit for working tree diff.' }
			}
		}
	},
	{
		name: 'git_map_branches',
		description: 'List local and remote branches with their tip commit hashes.',
		inputSchema: { type: 'object', properties: {} }
	}
];

export async function handleMcpToolCall(repo: string, name: string, args: Record<string, unknown> = {}): Promise<string> {
	switch (name) {
		case 'git_map_status':
			return execGitReadOnly(repo, ['status', '--short', '--branch']);
		case 'git_map_recent_commits': {
			const rawLimit = typeof args.limit === 'number' ? Math.floor(args.limit) : 15;
			const limit = Math.max(1, Math.min(50, rawLimit));
			return execGitReadOnly(repo, ['log', '-n', String(limit), '--date=iso', '--pretty=format:%h %ad | %an: %s']);
		}
		case 'git_map_diff': {
			const commit = typeof args.commit === 'string' ? args.commit.trim() : '';
			if (commit !== '') {
				if (!/^[0-9a-fA-F]{4,40}$/.test(commit)) {
					throw new Error('Invalid commit hash.');
				}
				return execGitReadOnly(repo, ['show', '--stat', '--patch', commit, '--']);
			}
			return execGitReadOnly(repo, ['diff', 'HEAD', '--']);
		}
		case 'git_map_branches':
			return execGitReadOnly(repo, ['branch', '-a', '-v', '--no-abbrev']);
		default:
			throw new Error('Unknown tool: ' + name);
	}
}

function sendJsonRpc(payload: Record<string, unknown>): void {
	process.stdout.write(JSON.stringify(payload) + '\n');
}

export function startMcpStdioServer(repo: string): void {
	const rl = readline.createInterface({ input: process.stdin, terminal: false });
	rl.on('line', async (line) => {
		const trimmed = line.trim();
		if (trimmed === '') return;
		let req: JsonRpcRequest;
		try {
			req = JSON.parse(trimmed) as JsonRpcRequest;
		} catch (_) {
			return;
		}
		if (typeof req.id === 'undefined') return; // Notification
		try {
			if (req.method === 'initialize') {
				sendJsonRpc({
					jsonrpc: '2.0',
					id: req.id,
					result: {
						protocolVersion: '2024-11-05',
						capabilities: { tools: {} },
						serverInfo: { name: 'git-map-mcp', version: '1.0.0' }
					}
				});
			} else if (req.method === 'tools/list') {
				sendJsonRpc({
					jsonrpc: '2.0',
					id: req.id,
					result: { tools: MCP_TOOL_DEFINITIONS }
				});
			} else if (req.method === 'tools/call') {
				const params = req.params || {};
				const toolName = typeof params.name === 'string' ? params.name : '';
				const toolArgs = typeof params.arguments === 'object' && params.arguments !== null
					? params.arguments as Record<string, unknown>
					: {};
				const output = await handleMcpToolCall(repo, toolName, toolArgs);
				sendJsonRpc({
					jsonrpc: '2.0',
					id: req.id,
					result: {
						content: [{ type: 'text', text: output || '(empty)' }]
					}
				});
			} else {
				sendJsonRpc({
					jsonrpc: '2.0',
					id: req.id,
					error: { code: -32601, message: 'Method not found: ' + req.method }
				});
			}
		} catch (err) {
			sendJsonRpc({
				jsonrpc: '2.0',
				id: req.id,
				result: {
					isError: true,
					content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }]
				}
			});
		}
	});
}

if (require.main === module) {
	startMcpStdioServer(parseRepoArg(process.argv.slice(2)));
}
