import * as fs from 'fs';
import * as vscode from 'vscode';
import { resolveTargetRepo } from './companionPanelBase';
import { DataSource } from './dataSource';
import { ExtensionState } from './extensionState';
import { runGit } from './historyRewrite';
import { t } from './l10n';
import { RepoManager } from './repoManager';
import { getPathFromUri, getRepoName, showErrorMessage, showInformationMessage } from './utils';

export interface ChangelogCommitItem {
	readonly hash: string;
	readonly subject: string;
	readonly author: string;
	readonly dateIso: string;
}

/**
 * Group commits by Conventional Commit prefix into a clean Markdown changelog / weekly report.
 */
export function buildChangelogMarkdown(commits: ReadonlyArray<ChangelogCommitItem>, title: string): string {
	const groups: { [key: string]: ChangelogCommitItem[] } = {
		features: [],
		fixes: [],
		refactor: [],
		docs: [],
		other: []
	};

	for (const c of commits) {
		const lower = c.subject.toLowerCase();
		if (/^feat(?:\([^)]*\))?!?:\s*/.test(lower)) groups.features.push(c);
		else if (/^fix(?:\([^)]*\))?!?:\s*/.test(lower)) groups.fixes.push(c);
		else if (/^(?:refactor|perf)(?:\([^)]*\))?!?:\s*/.test(lower)) groups.refactor.push(c);
		else if (/^docs(?:\([^)]*\))?!?:\s*/.test(lower)) groups.docs.push(c);
		else groups.other.push(c);
	}

	const lines: string[] = ['# ' + title, ''];
	const appendSection = (heading: string, list: ReadonlyArray<ChangelogCommitItem>) => {
		if (list.length === 0) return;
		lines.push('## ' + heading);
		for (const c of list) {
			lines.push('- ' + c.subject + ' (`' + c.hash.substring(0, 7) + '`, ' + c.author + ', ' + c.dateIso + ')');
		}
		lines.push('');
	};

	appendSection('Features', groups.features);
	appendSection('Bug Fixes', groups.fixes);
	appendSection('Refactoring & Performance', groups.refactor);
	appendSection('Documentation', groups.docs);
	appendSection('Other Changes', groups.other);

	if (commits.length === 0) {
		lines.push('_No commits found in the selected range._', '');
	}
	return lines.join('\n');
}

export async function exportChangelogCommand(
	dataSource: DataSource,
	repoManager: RepoManager,
	extensionState: ExtensionState,
	arg?: any
) {
	const repo = resolveTargetRepo(repoManager, extensionState, arg);
	if (repo === null) {
		showErrorMessage(t('No Git repositories were found in the current workspace.'));
		return;
	}

	const lastTagRes = await runGit(dataSource, repo, ['describe', '--tags', '--abbrev=0']);
	const lastTag = lastTagRes.code === 0 ? lastTagRes.stdout.toString().trim() : '';

	const rangeChoices: { label: string, since: string | null, rangeSpec: string | null, limit: number }[] = [];
	if (lastTag !== '') {
		rangeChoices.push({ label: t('Since Last Tag ({0}..HEAD)', lastTag), since: null, rangeSpec: lastTag + '..HEAD', limit: 300 });
	}
	rangeChoices.push(
		{ label: t('Last 7 Days (Weekly Report)'), since: '7.days.ago', rangeSpec: null, limit: 200 },
		{ label: t('Last 30 Days (Monthly Changelog)'), since: '30.days.ago', rangeSpec: null, limit: 300 },
		{ label: t('Latest 50 Commits'), since: null, rangeSpec: null, limit: 50 }
	);
	let chosen = rangeChoices[0];
	if (typeof vscode.window.showQuickPick === 'function') {
		const picked = await vscode.window.showQuickPick(rangeChoices, {
			title: t('Export Changelog / Weekly Report'),
			placeHolder: t('Select the commit range to export as Markdown'),
			ignoreFocusOut: true
		});
		if (typeof picked === 'undefined') return;
		chosen = picked;
	}

	const args = ['-c', 'log.showSignature=false', 'log', '--no-merges', '-n', String(chosen.limit), '--format=%H%x1f%s%x1f%an%x1f%cs'];
	if (chosen.since !== null) args.push('--since=' + chosen.since);
	if (chosen.rangeSpec !== null) args.push(chosen.rangeSpec);
	const res = await runGit(dataSource, repo, args);
	if (res.code !== 0) {
		showErrorMessage(res.stderr || t('Failed to read commit log.'));
		return;
	}
	const commits: ChangelogCommitItem[] = res.stdout.toString().split(/\r?\n/).filter((l) => l.trim() !== '').map((line) => {
		const [hash, subject, author, dateIso] = line.split('\x1f');
		return { hash: hash || '', subject: subject || '', author: author || '', dateIso: dateIso || '' };
	});
	const md = buildChangelogMarkdown(commits, getRepoName(repo) + ' — ' + chosen.label);
	const doc = await vscode.workspace.openTextDocument({ content: md, language: 'markdown' });
	await vscode.window.showTextDocument(doc, { preview: false });
}

export async function exportGraphSvgToFile(repo: string, svgMarkup: string) {
	if (typeof vscode.window.showSaveDialog !== 'function') return;
	const defaultUri = vscode.Uri.file(repo + '/' + getRepoName(repo) + '-git-map.svg');
	const uri = await vscode.window.showSaveDialog({
		defaultUri: defaultUri,
		filters: { 'SVG Image': ['svg'] },
		saveLabel: t('Export SVG')
	});
	if (typeof uri === 'undefined') return;
	try {
		await fs.promises.writeFile(getPathFromUri(uri), svgMarkup, 'utf8');
		showInformationMessage(t('Exported Git Map graph to "{0}".', uri.fsPath));
	} catch (e) {
		showErrorMessage(String(e));
	}
}
