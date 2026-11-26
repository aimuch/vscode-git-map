import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { resolveTargetRepo } from './companionPanelBase';
import { DataSource } from './dataSource';
import { ExtensionState } from './extensionState';
import { t } from './l10n';
import { RepoManager } from './repoManager';
import { getRepoName, showErrorMessage, showInformationMessage } from './utils';
import { Disposable } from './utils/disposable';

function runGit(gitPath: string, repo: string, args: string[]): Promise<{ readonly code: number, readonly stdout: string, readonly stderr: string }> {
	return new Promise((resolve) => {
		cp.execFile(gitPath, args, { cwd: repo, maxBuffer: 4 * 1024 * 1024, timeout: 30000 }, (err, stdout, stderr) => {
			resolve({
				code: err === null ? 0 : (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1),
				stdout: stdout || '',
				stderr: stderr || (err ? err.message : '')
			});
		});
	});
}

export interface RepoHealthReport {
	readonly repo: string;
	readonly hasCommitGraph: boolean;
	readonly coreCommitGraphEnabled: boolean;
	readonly looseObjects: number;
	readonly sizeKb: number;
	readonly sshSignersFile: string | null;
	readonly sshSignersExists: boolean;
	readonly recommendations: ReadonlyArray<string>;
}

export function parseCountObjectsOutput(raw: string): { readonly looseObjects: number, readonly sizeKb: number } {
	let looseObjects = 0;
	let sizeKb = 0;
	const lines = raw.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const mCount = lines[i].match(/^count:\s*(\d+)/);
		if (mCount !== null) looseObjects = parseInt(mCount[1], 10);
		const mSize = lines[i].match(/^size:\s*(\d+)/);
		if (mSize !== null) sizeKb = parseInt(mSize[1], 10);
	}
	return { looseObjects: looseObjects, sizeKb: sizeKb };
}

export async function inspectRepoHealth(gitPath: string, repo: string): Promise<RepoHealthReport> {
	const gitDirRes = await runGit(gitPath, repo, ['rev-parse', '--git-common-dir']);
	const rawGitDir = gitDirRes.code === 0 ? gitDirRes.stdout.toString().trim() : '.git';
	const gitCommonDir = path.isAbsolute(rawGitDir) ? rawGitDir : path.resolve(repo, rawGitDir);

	const graphSingle = path.join(gitCommonDir, 'objects', 'info', 'commit-graph');
	const graphChain = path.join(gitCommonDir, 'objects', 'info', 'commit-graphs');
	const hasCommitGraph = fs.existsSync(graphSingle) || fs.existsSync(graphChain);

	const cfgGraph = await runGit(gitPath, repo, ['config', '--get', 'core.commitGraph']);
	const coreCommitGraphEnabled = cfgGraph.code === 0 && cfgGraph.stdout.toString().trim().toLowerCase() === 'true';

	const countRes = await runGit(gitPath, repo, ['count-objects', '-v']);
	const counts = countRes.code === 0 ? parseCountObjectsOutput(countRes.stdout.toString()) : { looseObjects: 0, sizeKb: 0 };

	const signersRes = await runGit(gitPath, repo, ['config', '--get', 'gpg.ssh.allowedSignersFile']);
	const rawSigners = signersRes.code === 0 ? signersRes.stdout.toString().trim() : '';
	const resolvedSigners = rawSigners !== ''
		? (rawSigners.startsWith('~/') ? path.join(os.homedir(), rawSigners.slice(2)) : (path.isAbsolute(rawSigners) ? rawSigners : path.resolve(repo, rawSigners)))
		: null;
	const sshSignersExists = resolvedSigners !== null && fs.existsSync(resolvedSigners);

	const recommendations: string[] = [];
	if (!hasCommitGraph || !coreCommitGraphEnabled) {
		recommendations.push(t('Enable Git commit-graph index to accelerate log, blame, and graph rendering.'));
	}
	if (counts.looseObjects > 500) {
		recommendations.push(t('Pack {0} loose Git objects ({1} KB) with git gc to speed up repository operations.', counts.looseObjects, counts.sizeKb));
	}
	if (!sshSignersExists) {
		recommendations.push(t('Configure SSH allowed_signers file if verifying SSH-signed commits locally.'));
	}

	return {
		repo: repo,
		hasCommitGraph: hasCommitGraph,
		coreCommitGraphEnabled: coreCommitGraphEnabled,
		looseObjects: counts.looseObjects,
		sizeKb: counts.sizeKb,
		sshSignersFile: resolvedSigners,
		sshSignersExists: sshSignersExists,
		recommendations: recommendations
	};
}

export async function optimizeRepo(
	gitPath: string,
	repo: string,
	mode: 'commitGraph' | 'gc' | 'maintenance'
): Promise<string | null> {
	await runGit(gitPath, repo, ['config', '--local', 'core.commitGraph', 'true']);
	await runGit(gitPath, repo, ['config', '--local', 'fetch.writeCommitGraph', 'true']);
	const cgRes = await runGit(gitPath, repo, ['commit-graph', 'write', '--reachable', '--changed-paths']);
	if (mode === 'commitGraph') {
		return cgRes.code === 0 ? null : (cgRes.stderr.trim() || 'Failed to write commit-graph.');
	}
	if (mode === 'gc') {
		const gcRes = await runGit(gitPath, repo, ['gc', '--auto']);
		return gcRes.code === 0 ? null : (gcRes.stderr.trim() || 'Failed to run git gc.');
	}
	const maintRes = await runGit(gitPath, repo, ['maintenance', 'run', '--auto']);
	return maintRes.code === 0 ? null : (maintRes.stderr.trim() || null);
}

export async function ensureSshAllowedSignersFile(
	gitPath: string,
	repo: string
): Promise<{ readonly filePath: string | null, readonly error: string | null }> {
	try {
		const emailRes = await runGit(gitPath, repo, ['config', '--get', 'user.email']);
		const userEmail = emailRes.code === 0 ? emailRes.stdout.toString().trim() : 'user@example.com';

		const signersRes = await runGit(gitPath, repo, ['config', '--get', 'gpg.ssh.allowedSignersFile']);
		const rawSigners = signersRes.code === 0 ? signersRes.stdout.toString().trim() : '';
		let targetPath: string;
		if (rawSigners !== '') {
			targetPath = rawSigners.startsWith('~/')
				? path.join(os.homedir(), rawSigners.slice(2))
				: (path.isAbsolute(rawSigners) ? rawSigners : path.resolve(repo, rawSigners));
		} else {
			const gitDirRes = await runGit(gitPath, repo, ['rev-parse', '--git-common-dir']);
			const rawGitDir = gitDirRes.code === 0 ? gitDirRes.stdout.toString().trim() : '.git';
			const gitCommonDir = path.isAbsolute(rawGitDir) ? rawGitDir : path.resolve(repo, rawGitDir);
			targetPath = path.join(gitCommonDir, 'allowed_signers');
			await runGit(gitPath, repo, ['config', '--local', 'gpg.ssh.allowedSignersFile', targetPath]);
		}

		if (!fs.existsSync(targetPath)) {
			await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
			let pubKeyHint = 'ssh-ed25519 AAAA...';
			const defaultEd = path.join(os.homedir(), '.ssh', 'id_ed25519.pub');
			try {
				if (fs.existsSync(defaultEd)) {
					const rawPub = (await fs.promises.readFile(defaultEd, 'utf8')).trim();
					if (rawPub !== '') pubKeyHint = rawPub;
				}
			} catch (_) {
				// Ignore unreadable ~/.ssh directory and fall back to placeholder public key hint
			}
			const template = [
				'# Git SSH Allowed Signers (<email-or-principal> <key-type> <base64-public-key>)',
				'# Uncomment or add trusted signer public keys below to verify SSH commit signatures:',
				'# ' + (userEmail || 'user@example.com') + ' ' + pubKeyHint,
				''
			].join('\n');
			await fs.promises.writeFile(targetPath, template, 'utf8');
		}
		return { filePath: targetPath, error: null };
	} catch (err) {
		return { filePath: null, error: err instanceof Error ? err.message : String(err) };
	}
}

export class GitMaintenanceController extends Disposable {
	private readonly dataSource: DataSource;
	private readonly repoManager: RepoManager;
	private readonly extensionState: ExtensionState;

	constructor(dataSource: DataSource, repoManager: RepoManager, extensionState: ExtensionState) {
		super();
		this.dataSource = dataSource;
		this.repoManager = repoManager;
		this.extensionState = extensionState;

		this.registerDisposables(
			vscode.commands.registerCommand('git-map.checkRepoHealth', (arg?: unknown) => this.runHealthCheckInteractive(arg)),
			vscode.commands.registerCommand('git-map.editSshAllowedSigners', (arg?: unknown) => this.openSshAllowedSignersInteractive(arg))
		);
	}

	private resolveGitPath(): string {
		const anyDs = this.dataSource as unknown as { gitExecutable?: { path: string } | null };
		return anyDs.gitExecutable?.path || 'git';
	}

	public async runHealthCheckInteractive(arg?: unknown): Promise<RepoHealthReport | null> {
		const repo = resolveTargetRepo(this.repoManager, this.extensionState, arg);
		if (repo === null) {
			showErrorMessage(t('No Git repositories were found in the current workspace.'));
			return null;
		}
		const gitPath = this.resolveGitPath();
		const report = await inspectRepoHealth(gitPath, repo);
		const repoName = getRepoName(repo);
		const items: Array<vscode.QuickPickItem & { readonly act?: 'commitGraph' | 'gc' | 'maintenance' | 'ssh' }> = [
			{
				label: (report.hasCommitGraph && report.coreCommitGraphEnabled ? '$(pass) ' : '$(zap) ') + t('Write & Enable Git Commit-Graph Index'),
				description: report.hasCommitGraph ? t('Active') : t('Recommended'),
				detail: t('Speeds up commit graph traversal, blame, and branch containment queries'),
				act: 'commitGraph'
			},
			{
				label: '$(package) ' + t('Run Git Garbage Collection (git gc --auto)'),
				description: t('{0} loose objects ({1} KB)', report.looseObjects, report.sizeKb),
				act: 'gc'
			},
			{
				label: '$(tools) ' + t('Run Background Git Maintenance'),
				description: repoName,
				act: 'maintenance'
			},
			{
				label: (report.sshSignersExists ? '$(verified) ' : '$(key) ') + t('Configure SSH Allowed Signers File…'),
				description: report.sshSignersExists ? t('Configured') : t('Not set'),
				act: 'ssh'
			}
		];
		const picked = await vscode.window.showQuickPick(items, {
			title: t('Git Map: Repository Health & Optimization ({0})', repoName),
			placeHolder: report.recommendations.length > 0
				? report.recommendations[0]
				: t('Repository is healthy — select an optimization or signer tool to run')
		});
		if (!picked || !picked.act) return report;
		if (picked.act === 'ssh') {
			await this.openSshAllowedSignersInteractive({ repo: repo });
			return report;
		}
		const err = await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: t('Optimizing Git repository "{0}"…', repoName) },
			() => optimizeRepo(gitPath, repo, picked.act as 'commitGraph' | 'gc' | 'maintenance')
		);
		if (err !== null) {
			showErrorMessage(err);
		} else {
			showInformationMessage(t('Git optimization completed for "{0}".', repoName));
		}
		return report;
	}

	public async openSshAllowedSignersInteractive(arg?: unknown): Promise<void> {
		const repo = resolveTargetRepo(this.repoManager, this.extensionState, arg);
		if (repo === null) {
			showErrorMessage(t('No Git repositories were found in the current workspace.'));
			return;
		}
		const res = await ensureSshAllowedSignersFile(this.resolveGitPath(), repo);
		if (res.error !== null || res.filePath === null) {
			showErrorMessage(res.error || t('Unable to open SSH allowed_signers file.'));
			return;
		}
		const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(res.filePath));
		await vscode.window.showTextDocument(doc);
	}
}
