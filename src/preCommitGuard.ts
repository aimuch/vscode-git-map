import * as vscode from 'vscode';
import { escapeCompanionHtml, resolveTargetRepo, selectAiModelWithConsent } from './companionPanelBase';
import { getConfig } from './config';
import { DataSource } from './dataSource';
import { runCustomAiPrompt, wrapUntrustedBlock } from './explainCommit';
import { ExtensionState } from './extensionState';
import { GitFeatures } from './gitFeatures';
import { runGit } from './historyRewrite';
import { getLanguage, t } from './l10n';
import { Logger } from './logger';
import { RepoManager } from './repoManager';
import { AsyncRequestSequencer } from './stateMachines';
import { GuardRiskEvidence, GuardRiskReport, PreCommitIssue } from './types';
import { getUndoManager } from './undoManager';
import { getNonce, getRepoName, showErrorMessage, showInformationMessage } from './utils';
import { Disposable } from './utils/disposable';

export interface CommitSplitGroup {
	readonly message: string;
	readonly files: ReadonlyArray<string>;
	readonly rationale: string;
}

const SECRET_RULES: ReadonlyArray<{ readonly rx: RegExp, readonly label: string }> = [
	{ rx: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/, label: 'Private key material detected' },
	{ rx: /\bAKIA[0-9A-Z]{16}\b/, label: 'Possible AWS Access Key ID' },
	{ rx: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/, label: 'Possible GitHub Personal Access Token' },
	{ rx: /\bsk-(?:proj-)?[A-Za-z0-9_-]{24,}\b/, label: 'Possible API secret key (sk-...)' },
	{ rx: /\bglpat-[A-Za-z0-9_-]{20,}\b/, label: 'Possible GitLab Personal Access Token' },
	{ rx: /\b(?:api[_-]?key|secret[_-]?key|access[_-]?token|private[_-]?key|password)\s*[:=]\s*['"][A-Za-z0-9/+_.-]{16,}['"]/i, label: 'Hardcoded secret or credential assignment' }
];

const DEBUG_RULES: ReadonlyArray<{ readonly rx: RegExp, readonly label: string }> = [
	{ rx: /\bconsole\.(?:log|debug|trace)\s*\(/, label: 'Debug console.log statement' },
	{ rx: /^\s*debugger\s*;?\s*$/, label: 'JavaScript debugger statement' },
	{ rx: /\bpdb\.set_trace\s*\(|\bbreakpoint\s*\(/, label: 'Python breakpoint / pdb.set_trace()' },
	{ rx: /\bbinding\.pry\b/, label: 'Ruby binding.pry breakpoint' }
];

const MARKER_RULES: ReadonlyArray<{ readonly rx: RegExp, readonly label: string }> = [
	{ rx: /\b(?:DO NOT COMMIT|DON'T COMMIT|NOCOMMIT)\b/i, label: 'DO NOT COMMIT marker' },
	{ rx: /\bFIXME\b/, label: 'Unresolved FIXME marker' }
];

/**
 * Scan unified diff text (added lines only) for leaked secrets, debug leftovers, and DO NOT COMMIT / FIXME markers.
 */
export function scanDiffForPreCommitIssues(diffText: string): PreCommitIssue[] {
	const issues: PreCommitIssue[] = [];
	const lines = diffText.replace(/\r\n/g, '\n').split('\n');
	let currentFile = '';
	let currentNewLine = 0;

	for (let i = 0; i < lines.length; i++) {
		const ln = lines[i];
		if (ln.startsWith('+++ b/')) {
			currentFile = ln.substring(6).trim();
			continue;
		}
		if (ln.startsWith('@@ ')) {
			const m = ln.match(/\+(\d+)/);
			currentNewLine = m !== null ? parseInt(m[1], 10) : 1;
			continue;
		}
		if (ln.startsWith('+') && !ln.startsWith('+++')) {
			const code = ln.substring(1);
			const snippet = code.trim().substring(0, 120);
			let matched = false;
			for (const rule of SECRET_RULES) {
				if (rule.rx.test(code)) {
					issues.push({ severity: 'high', kind: 'secret', file: currentFile, line: currentNewLine, message: rule.label, snippet: snippet });
					matched = true;
					break;
				}
			}
			if (!matched) {
				for (const rule of DEBUG_RULES) {
					if (rule.rx.test(code)) {
						issues.push({ severity: 'medium', kind: 'debug', file: currentFile, line: currentNewLine, message: rule.label, snippet: snippet });
						matched = true;
						break;
					}
				}
			}
			if (!matched) {
				for (const rule of MARKER_RULES) {
					if (rule.rx.test(code)) {
						issues.push({ severity: 'low', kind: 'marker', file: currentFile, line: currentNewLine, message: rule.label, snippet: snippet });
						break;
					}
				}
			}
			currentNewLine++;
			if (issues.length >= 60) break;
		} else if (!ln.startsWith('-') && !ln.startsWith('\\')) {
			currentNewLine++;
		}
	}
	return issues;
}

/**
 * Parse a JSON array of commit split groups returned by an AI model, filtering strictly to real changed files.
 */
export function parseCommitSplitPlan(rawText: string, validFiles: ReadonlyArray<string>): CommitSplitGroup[] {
	const validSet = new Set(validFiles);
	const stripped = rawText.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
	const startIdx = stripped.indexOf('[');
	const endIdx = stripped.lastIndexOf(']');
	if (startIdx === -1 || endIdx <= startIdx) return [];
	try {
		const parsed = JSON.parse(stripped.substring(startIdx, endIdx + 1));
		if (!Array.isArray(parsed)) return [];
		const assigned = new Set<string>();
		const groups: CommitSplitGroup[] = [];
		for (const item of parsed) {
			if (!item || typeof item !== 'object') continue;
			const msg = typeof item.message === 'string' ? item.message.trim() : '';
			const rationale = typeof item.rationale === 'string' ? item.rationale.trim() : '';
			const rawFiles = Array.isArray(item.files) ? item.files : [];
			const files: string[] = rawFiles.filter((f: unknown): f is string => typeof f === 'string' && validSet.has(f) && !assigned.has(f));
			if (msg !== '' && files.length > 0) {
				files.forEach((f: string) => assigned.add(f));
				groups.push({ message: msg, files: files, rationale: rationale });
			}
		}
		const remaining = validFiles.filter((f) => !assigned.has(f));
		if (remaining.length > 0 && groups.length > 0) {
			groups.push({ message: 'chore: update remaining files', files: remaining, rationale: '' });
		}
		return groups;
	} catch (_) {
		return [];
	}
}

export async function scanRepoWorkingTreeForIssues(dataSource: DataSource, repo: string): Promise<PreCommitIssue[]> {
	const [stagedRes, unstagedRes] = await Promise.all([
		runGit(dataSource, repo, ['-c', 'core.quotepath=false', 'diff', '--cached', '--no-color', '-U0'], null, null, undefined, 2 * 1024 * 1024),
		runGit(dataSource, repo, ['-c', 'core.quotepath=false', 'diff', '--no-color', '-U0'], null, null, undefined, 2 * 1024 * 1024)
	]);
	const combined = (stagedRes.code === 0 || stagedRes.truncated ? stagedRes.stdout.toString() : '') + '\n' +
		(unstagedRes.code === 0 || unstagedRes.truncated ? unstagedRes.stdout.toString() : '');
	return scanDiffForPreCommitIssues(combined);
}

/**
 * Compute an explainable 0-100 change health/safety score with explicit evidence items.
 * Every point deduction is tied to a concrete, inspectable rule hit rather than an opaque pass/fail.
 */
export function computeGuardRiskScore(
	issues: ReadonlyArray<PreCommitIssue>,
	fileCount: number = 0,
	totalChangedLines: number = 0
): GuardRiskReport {
	let score = 100;
	const evidence: GuardRiskEvidence[] = [];

	issues.forEach((iss) => {
		const deduction = iss.severity === 'high' ? 40 : (iss.severity === 'medium' ? 12 : 5);
		score -= deduction;
		evidence.push({
			severity: iss.severity,
			label: iss.message,
			detail: (iss.file !== '' ? iss.file + ':' + iss.line + ' — ' : '') + iss.snippet,
			deduction: deduction,
			file: iss.file,
			line: iss.line
		});
	});

	if (fileCount >= 20) {
		const deduction = fileCount >= 40 ? 15 : 8;
		score -= deduction;
		evidence.push({
			severity: 'medium',
			label: 'Broad multi-file change footprint',
			detail: fileCount + ' files modified in scope — consider splitting into atomic commits.',
			deduction: deduction
		});
	}

	if (totalChangedLines >= 600) {
		const deduction = totalChangedLines >= 1500 ? 15 : 8;
		score -= deduction;
		evidence.push({
			severity: 'medium',
			label: 'Large diff volume',
			detail: totalChangedLines + ' changed lines — higher cognitive load during review.',
			deduction: deduction
		});
	}

	if (evidence.length === 0) {
		evidence.push({
			severity: 'info',
			label: 'No secret, debug, or marker risks detected',
			detail: fileCount > 0 ? (fileCount + ' file(s) scanned cleanly.') : 'Working tree scanned cleanly.',
			deduction: 0
		});
	}

	const clamped = Math.max(0, Math.min(100, score));
	const grade: GuardRiskReport['grade'] = clamped >= 80 ? 'safe' : (clamped >= 50 ? 'caution' : 'high-risk');
	return { score: clamped, grade: grade, evidence: evidence };
}

export class PreCommitAndSplitter extends Disposable {
	private static instance: PreCommitAndSplitter | null = null;

	private readonly dataSource: DataSource;
	private readonly repoManager: RepoManager;
	private readonly extensionState: ExtensionState;
	private readonly logger: Logger;
	private readonly gitFeatures: GitFeatures;
	private readonly splitSeq: AsyncRequestSequencer = new AsyncRequestSequencer();
	private activeAiCancellation: vscode.CancellationTokenSource | null = null;
	private panel: vscode.WebviewPanel | null = null;
	private currentRepo: string | null = null;

	constructor(dataSource: DataSource, repoManager: RepoManager, extensionState: ExtensionState, logger: Logger) {
		super();
		this.dataSource = dataSource;
		this.repoManager = repoManager;
		this.extensionState = extensionState;
		this.logger = logger;
		this.gitFeatures = new GitFeatures(dataSource);
		PreCommitAndSplitter.instance = this;
		this.registerDisposables(
			vscode.commands.registerCommand('git-map.preCommitCheck', (arg?: unknown) => this.runPreCommitCheckCommand(arg)),
			vscode.commands.registerCommand('git-map.aiSmartCommitSplit', (arg?: unknown) => this.runSmartSplitCommand(arg)),
			{
				dispose: () => {
					this.splitSeq.cancel();
					this.cancelActiveAi();
					if (this.panel !== null) this.panel.dispose();
					if (PreCommitAndSplitter.instance === this) PreCommitAndSplitter.instance = null;
				}
			}
		);
	}

	private cancelActiveAi() {
		if (this.activeAiCancellation !== null) {
			this.activeAiCancellation.cancel();
			this.activeAiCancellation.dispose();
			this.activeAiCancellation = null;
		}
	}

	public static getInstance() {
		return PreCommitAndSplitter.instance;
	}

	public async runPreCommitCheckCommand(arg?: any) {
		const repo = resolveTargetRepo(this.repoManager, this.extensionState, arg);
		if (repo === null) {
			showErrorMessage(t('No Git repositories were found in the current workspace.'));
			return;
		}
		const issues = await scanRepoWorkingTreeForIssues(this.dataSource, repo);
		const report = computeGuardRiskScore(issues);
		if (issues.length === 0) {
			showInformationMessage(t('Pre-Commit Guard ({0}/100): No secrets, debug statements, or warning markers found in "{1}".', String(report.score), getRepoName(repo)));
			return;
		}
		if (typeof vscode.window.showQuickPick === 'function') {
			const picked = await vscode.window.showQuickPick(
				issues.map((iss) => ({
					label: '[' + iss.severity.toUpperCase() + '] ' + iss.file + ':' + iss.line,
					description: iss.message,
					detail: iss.snippet,
					issue: iss
				})),
				{
					title: t('Pre-Commit Guard · Health {0}/100 · {1} issue(s)', String(report.score), String(issues.length)),
					placeHolder: t('Select an issue to jump to the line in the editor'),
					ignoreFocusOut: true
				}
			);
			if (typeof picked !== 'undefined' && picked.issue.file !== '') {
				const uri = vscode.Uri.file(repo + '/' + picked.issue.file);
				const line = Math.max(0, picked.issue.line - 1);
				await vscode.commands.executeCommand('vscode.open', uri, {
					selection: new vscode.Range(new vscode.Position(line, 0), new vscode.Position(line, 0))
				});
			}
		}
	}

	public async runSmartSplitCommand(arg?: any) {
		const repo = resolveTargetRepo(this.repoManager, this.extensionState, arg);
		if (repo === null) {
			showErrorMessage(t('No Git repositories were found in the current workspace.'));
			return;
		}
		const wt = await this.gitFeatures.getWorkingTreeStatus(repo);
		const filePaths = wt.files.map((f) => f.path);
		if (filePaths.length < 2) {
			showInformationMessage(t('Smart Commit Splitter requires at least 2 changed files in "{0}".', getRepoName(repo)));
			return;
		}

		const selected = await selectAiModelWithConsent(
			this.extensionState,
			repo,
			t('Git Map: AI Smart Commit Splitter')
		);
		if (selected === null) return;

		this.currentRepo = repo;
		const title = t('AI Smart Commit Splitter: {0}', getRepoName(repo));
		if (this.panel === null) {
			this.panel = vscode.window.createWebviewPanel(
				'git-map.smartCommitSplit',
				title,
				getConfig().openNewTabEditorGroup,
				{ enableScripts: true, localResourceRoots: [], retainContextWhenHidden: true }
			);
			const created = this.panel;
			const msgSub = created.webview.onDidReceiveMessage((msg) => this.onMessage(msg));
			const dispSub = created.onDidDispose(() => {
				msgSub.dispose();
				dispSub.dispose();
				if (this.panel === created) {
					this.splitSeq.cancel();
					this.cancelActiveAi();
					this.panel = null;
					this.currentRepo = null;
				}
			});
		} else {
			this.panel.title = title;
			this.panel.reveal();
		}

		this.panel.webview.html = getSplitterHtml(getRepoName(repo), this.panel.webview.cspSource);
		const seq = this.splitSeq.begin();
		const diffData = await this.gitFeatures.getChangesForCommitMessage(repo);
		if (!this.splitSeq.isCurrent(seq) || this.panel === null || this.currentRepo !== repo) return;

		const lang = getLanguage();
		const prompt = [
			'You are an expert Git workflow engineer. Group the changed files below into logical, atomic Conventional Commits.',
			'Write commit messages in ' + (lang === 'zh-cn' ? 'Simplified Chinese' : 'English') + '.',
			'Output ONLY a valid JSON array with no extra prose: `[{"message":"feat(scope): summary","files":["path/a.ts"],"rationale":"short reason"}]`.',
			'Every file in the changed file list must appear in at most one group. Use only exact paths from the file list.',
			'Changed files:\n' + filePaths.join('\n'),
			wrapUntrustedBlock('DIFF_SUMMARY', diffData.text)
		].join('\n');

		this.cancelActiveAi();
		const cts = this.activeAiCancellation = new vscode.CancellationTokenSource();
		try {
			const res = await runCustomAiPrompt(prompt, selected.id, () => { }, cts.token);
			if (!this.splitSeq.complete(seq) || cts.token.isCancellationRequested || this.panel === null || this.currentRepo !== repo) return;
			if (res.error !== null) {
				this.panel.webview.postMessage({ command: 'splitError', error: res.error, committedCount: 0 });
				return;
			}
			const groups = parseCommitSplitPlan(res.text, filePaths);
			if (groups.length === 0) {
				this.panel.webview.postMessage({
					command: 'splitPlan',
					groups: [{ message: 'chore: update workspace changes', files: filePaths, rationale: '' }]
				});
			} else {
				this.panel.webview.postMessage({ command: 'splitPlan', groups: groups });
			}
			this.logger.log('Generated AI Smart Commit Split plan with ' + groups.length + ' groups for ' + repo);
		} finally {
			cts.dispose();
			if (this.activeAiCancellation === cts) this.activeAiCancellation = null;
		}
	}

	private async onMessage(raw: unknown) {
		if (typeof raw !== 'object' || raw === null || this.currentRepo === null || this.panel === null) return;
		const repo = this.currentRepo;
		const msg = <{ command?: unknown, groups?: unknown }>raw;
		if (msg.command === 'executePlan' && Array.isArray(msg.groups)) {
			const sign = getConfig().signCommits;
			const undoManager = getUndoManager(this.dataSource);
			let committed = 0;
			const fail = (err: string) => {
				showErrorMessage(err);
				if (this.panel !== null && this.currentRepo === repo) {
					this.panel.webview.postMessage({ command: 'splitError', error: err, committedCount: committed });
				}
			};
			for (const g of msg.groups) {
				if (!g || typeof g !== 'object') continue;
				const rec = <{ message?: unknown, files?: unknown }>g;
				const message = typeof rec.message === 'string' ? rec.message.trim() : '';
				const files = Array.isArray(rec.files) ? rec.files.filter((f): f is string => typeof f === 'string' && f !== '') : [];
				if (message === '' || files.length === 0) continue;
				const unstageErr = await this.gitFeatures.unstageFiles(repo, null);
				if (unstageErr !== null) {
					fail(unstageErr);
					return;
				}
				const stageErr = await this.gitFeatures.stageFiles(repo, files);
				if (stageErr !== null) {
					fail(stageErr);
					return;
				}
				const commitErr = await undoManager.trackHead(
					repo,
					t('Commit Changes'),
					() => this.gitFeatures.commitStagedChanges(repo, message, false, false, sign),
					(err) => err === null,
					true
				);
				if (commitErr !== null) {
					fail(commitErr);
					return;
				}
				committed++;
			}
			showInformationMessage(t('Created {0} atomic commits in "{1}".', String(committed), getRepoName(repo)));
			if (this.panel !== null && this.currentRepo === repo) {
				this.panel.webview.postMessage({ command: 'splitDone', count: committed });
			}
		}
	}
}

function getSplitterHtml(repoName: string, cspSource: string) {
	const nonce = getNonce();
	const locale = getLanguage() === 'zh-cn' ? 'zh-CN' : 'en';
	const strings = {
		title: t('AI Smart Commit Splitter'),
		loading: t('Analyzing changes and grouping atomic commits…'),
		execute: t('Create All Commits Sequentially'),
		retryRemaining: t('Retry Remaining Commits'),
		done: t('All planned commits have been created!'),
		commitHeading: t('Commit #{0}'),
		committedBadge: t('Committed'),
		messageLabel: t('Commit Message')
	};
	return '<!DOCTYPE html><html lang="' + locale + '"><head><meta charset="UTF-8">' +
		'<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src ' + cspSource + ' \'unsafe-inline\'; script-src \'nonce-' + nonce + '\';">' +
		'<meta name="viewport" content="width=device-width, initial-scale=1.0"><style>' +
		'*{box-sizing:border-box}body{margin:0;padding:16px 20px;font-family:var(--vscode-font-family);font-size:13px;color:var(--vscode-foreground);background:var(--vscode-editor-background)}' +
		'h1{margin:0 0 12px;font-size:15px}.scCard{border:1px solid var(--vscode-panel-border,rgba(128,128,128,.3));border-radius:8px;padding:12px 14px;margin-bottom:12px;display:flex;flex-direction:column;gap:8px}.scCard.done{opacity:.65}' +
		'.scInput{width:100%;padding:6px 8px;border-radius:4px;border:1px solid var(--vscode-input-border,rgba(128,128,128,.4));background:var(--vscode-input-background);color:inherit;font:inherit}' +
		'.scFiles{font-family:var(--vscode-editor-font-family);font-size:12px;display:flex;flex-wrap:wrap;gap:6px}.scFile{padding:2px 7px;border-radius:4px;background:rgba(128,128,128,.16)}' +
		'.scBtn{height:28px;padding:0 14px;border:0;border-radius:6px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);font-weight:600;cursor:pointer}.scBtn:disabled{opacity:.55;cursor:wait}' +
		'.scErr{margin:0 0 12px;padding:8px 12px;border-radius:6px;border:1px solid color-mix(in srgb,var(--vscode-errorForeground,#cf222e) 50%,transparent);background:color-mix(in srgb,var(--vscode-errorForeground,#cf222e) 14%,transparent);color:var(--vscode-errorForeground,#cf222e)}' +
		'.scMuted{color:var(--vscode-descriptionForeground);font-size:12px}</style></head><body data-sm-status="loading">' +
		'<h1>' + escapeCompanionHtml(strings.title) + ' — ' + escapeCompanionHtml(repoName) + '</h1><div id="scBody"><p class="scMuted">' + escapeCompanionHtml(strings.loading) + '</p></div>' +
		'<script nonce="' + nonce + '">var STRINGS=' + JSON.stringify(strings).replace(/</g, '\\u003c') + ';' +
		'(function(){var vscode=acquireVsCodeApi(),GROUPS=[],DONE_COUNT=0,LAST_ERR="";function esc(s){return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");}' +
		'function render(){var el=document.getElementById("scBody");var errHtml=LAST_ERR?"<div class=\\"scErr\\">"+esc(LAST_ERR)+"</div>":"";el.innerHTML=errHtml+GROUPS.map(function(g,i){var isDone=i<DONE_COUNT;return "<div class=\\"scCard"+(isDone?" done":"")+"\\"><label class=\\"scMuted\\">"+esc(STRINGS.commitHeading.replace("{0}",String(i+1)))+(isDone?" — "+esc(STRINGS.committedBadge):"")+"</label><input class=\\"scInput\\" data-msg-idx=\\""+i+"\\" value=\\""+esc(g.message)+"\\""+(isDone?" disabled":"")+">"+(g.rationale?"<div class=\\"scMuted\\">"+esc(g.rationale)+"</div>":"")+"<div class=\\"scFiles\\">"+g.files.map(function(f){return "<span class=\\"scFile\\">"+esc(f)+"</span>";}).join("")+"</div></div>";}).join("")+"<button type=\\"button\\" id=\\"scRun\\" class=\\"scBtn\\">"+esc(DONE_COUNT>0?STRINGS.retryRemaining:STRINGS.execute)+"</button>";' +
		'var run=document.getElementById("scRun");if(run)run.addEventListener("click",function(){var payload=[];GROUPS.forEach(function(g,i){if(i<DONE_COUNT)return;var inp=document.querySelector("[data-msg-idx=\\""+i+"\\"]");var msg=inp?inp.value:g.message;g.message=msg;payload.push({message:msg,files:g.files});});if(payload.length===0)return;LAST_ERR="";run.disabled=true;vscode.postMessage({command:"executePlan",groups:payload});});}' +
		'window.addEventListener("message",function(ev){var m=ev.data;if(!m)return;if(m.command==="splitPlan"){GROUPS=m.groups||[];DONE_COUNT=0;LAST_ERR="";document.body.dataset.smStatus="ready";render();}else if(m.command==="splitError"){document.body.dataset.smStatus="error";LAST_ERR=m.error||"";if(typeof m.committedCount==="number"&&m.committedCount>0)DONE_COUNT+=m.committedCount;if(GROUPS.length>0){render();}else{document.getElementById("scBody").innerHTML="<div class=\\"scErr\\">"+esc(LAST_ERR)+"</div>";}}else if(m.command==="splitDone"){document.body.dataset.smStatus="done";document.getElementById("scBody").innerHTML="<p>"+esc(STRINGS.done)+"</p>";}});})();' +
		'</script></body></html>';
}
