import * as vscode from 'vscode';
import { getConfig } from './config';
import { DataSource } from './dataSource';
import { ExtensionState } from './extensionState';
import { runGit } from './historyRewrite';
import { t } from './l10n';
import { RepoManager } from './repoManager';
import { PullRequestBadgeInfo, PullRequestDetailsInfo } from './types';
import { getPathFromUri, getRepoName, showErrorMessage, showInformationMessage } from './utils';

export interface ParsedHostingRemote {
	readonly provider: 'github' | 'gitlab' | 'gitea' | 'bitbucket' | 'azure';
	readonly host: string;
	readonly ownerRepo: string; // e.g. "owner/repo", "group/subgroup/repo", or "org/project/repo" for Azure DevOps
	readonly remoteName: string;
}

const HOSTING_TOKEN_PREFIX = 'git-map.hosting.token.';
const PR_CACHE_TTL_MS = 120000;
const HTTP_TIMEOUT_MS = 4500;

let hostingSecrets: vscode.SecretStorage | null = null;
const prCache = new Map<string, { expiresAt: number, badges: { [branch: string]: PullRequestBadgeInfo } }>();
const inFlightPrRequests = new Map<string, Promise<{ [branch: string]: PullRequestBadgeInfo }>>();

export function setHostingSecretStorage(secrets: vscode.SecretStorage | null) {
	hostingSecrets = secrets;
	prCache.clear();
	inFlightPrRequests.clear();
}

export function clearPrStatusCache() {
	prCache.clear();
	inFlightPrRequests.clear();
}

export function parseHostingRemoteUrl(remoteName: string, rawUrl: string): ParsedHostingRemote | null {
	const trimmed = rawUrl.trim();
	// Azure DevOps HTTPS: https://[user@]dev.azure.com/org/project/_git/repo or https://org.visualstudio.com/[DefaultCollection/]project/_git/repo
	let azMatch = trimmed.match(/^https?:\/\/(?:[^@/]+@)?dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/?#]+?)(?:\.git)?\/?$/i);
	if (azMatch !== null) {
		return { provider: 'azure', host: 'dev.azure.com', ownerRepo: azMatch[1] + '/' + azMatch[2] + '/' + azMatch[3], remoteName: remoteName };
	}
	azMatch = trimmed.match(/^https?:\/\/(?:[^@/]+@)?([^/.]+)\.visualstudio\.com\/(?:DefaultCollection\/)?([^/]+)\/_git\/([^/?#]+?)(?:\.git)?\/?$/i);
	if (azMatch !== null) {
		return { provider: 'azure', host: 'dev.azure.com', ownerRepo: azMatch[1] + '/' + azMatch[2] + '/' + azMatch[3], remoteName: remoteName };
	}
	// Azure DevOps SSH: git@ssh.dev.azure.com:v3/org/project/repo
	azMatch = trimmed.match(/^(?:ssh:\/\/)?[^@\s/]+@ssh\.dev\.azure\.com(?::v3|\/v3)\/([^/]+)\/([^/]+)\/([^/?#]+?)(?:\.git)?\/?$/i);
	if (azMatch !== null) {
		return { provider: 'azure', host: 'dev.azure.com', ownerRepo: azMatch[1] + '/' + azMatch[2] + '/' + azMatch[3], remoteName: remoteName };
	}

	let host = '', repoPath = '';
	let m = trimmed.match(/^https?:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/i);
	if (m !== null) {
		host = m[1].toLowerCase();
		repoPath = m[2];
	} else if ((m = trimmed.match(/^ssh:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/i)) !== null) {
		host = m[1].toLowerCase();
		repoPath = m[2];
	} else if ((m = trimmed.match(/^[^@\s/]+@([^:\s]+):(.+?)(?:\.git)?\/?$/)) !== null) {
		host = m[1].toLowerCase();
		repoPath = m[2];
	} else {
		return null;
	}
	if (host === '' || repoPath === '' || !repoPath.includes('/')) return null;
	if (host.includes('github')) {
		return { provider: 'github', host: host, ownerRepo: repoPath, remoteName: remoteName };
	}
	if (host.includes('gitlab')) {
		return { provider: 'gitlab', host: host, ownerRepo: repoPath, remoteName: remoteName };
	}
	if (host === 'codeberg.org' || host.includes('gitea') || host.includes('forgejo')) {
		return { provider: 'gitea', host: host, ownerRepo: repoPath, remoteName: remoteName };
	}
	if (host.includes('bitbucket')) {
		return { provider: 'bitbucket', host: host, ownerRepo: repoPath, remoteName: remoteName };
	}
	return null;
}

async function getHostingToken(host: string): Promise<string | null> {
	if (hostingSecrets === null) return null;
	const val = await hostingSecrets.get(HOSTING_TOKEN_PREFIX + host);
	return typeof val === 'string' && val.trim() !== '' ? val.trim() : null;
}

export async function setHostingTokenCommand() {
	if (hostingSecrets === null) return;
	const host = await vscode.window.showInputBox({
		title: t('Git Map: Set GitHub / GitLab Token'),
		value: 'github.com',
		prompt: t('Enter the Git hosting domain (e.g. github.com or gitlab.com)'),
		ignoreFocusOut: true
	});
	if (typeof host !== 'string' || host.trim() === '') return;
	const cleanHost = host.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
	const token = await vscode.window.showInputBox({
		title: t('Personal Access Token for {0}', cleanHost),
		prompt: t('Stored in Visual Studio Code Secret Storage for reading Pull Request & CI statuses.'),
		password: true,
		ignoreFocusOut: true
	});
	if (typeof token !== 'string' || token.trim() === '') return;
	await hostingSecrets.store(HOSTING_TOKEN_PREFIX + cleanHost, token.trim());
	prCache.clear();
	showInformationMessage(t('Saved token for {0}.', cleanHost));
}

export async function clearHostingTokenCommand() {
	if (hostingSecrets === null) return;
	const host = await vscode.window.showInputBox({
		title: t('Git Map: Clear GitHub / GitLab Token'),
		value: 'github.com',
		prompt: t('Enter the Git hosting domain whose token should be deleted'),
		ignoreFocusOut: true
	});
	if (typeof host !== 'string' || host.trim() === '') return;
	const cleanHost = host.trim().toLowerCase();
	await hostingSecrets.delete(HOSTING_TOKEN_PREFIX + cleanHost);
	prCache.clear();
	showInformationMessage(t('Cleared token for {0}.', cleanHost));
}

async function fetchJson(url: string, headers: { [k: string]: string }): Promise<any | null> {
	if (typeof fetch !== 'function') return null;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
	if (typeof timer === 'object' && timer !== null && typeof timer.unref === 'function') timer.unref();
	try {
		const res = await fetch(url, { method: 'GET', headers: headers, signal: controller.signal });
		if (!res.ok) return null;
		return JSON.parse(await res.text());
	} catch (_) {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

async function detectHostingRemote(dataSource: DataSource, repo: string): Promise<ParsedHostingRemote | null> {
	const res = await runGit(dataSource, repo, ['remote', '-v']);
	if (res.code !== 0) return null;
	const lines = res.stdout.toString().split(/\r?\n/);
	let fallback: ParsedHostingRemote | null = null;
	for (const line of lines) {
		const m = line.match(/^(\S+)\s+(\S+)\s+\(fetch\)$/);
		if (m === null) continue;
		const parsed = parseHostingRemoteUrl(m[1], m[2]);
		if (parsed !== null) {
			if (parsed.remoteName === 'origin') return parsed;
			if (fallback === null) fallback = parsed;
		}
	}
	return fallback;
}

export async function fetchRepoPullRequestBadges(dataSource: DataSource, repo: string, force: boolean = false): Promise<{ [branch: string]: PullRequestBadgeInfo }> {
	if (!getConfig().pullRequestStatusEnabled) return {};
	const cached = prCache.get(repo);
	if (!force && typeof cached !== 'undefined' && cached.expiresAt > Date.now()) {
		return cached.badges;
	}
	const existingInFlight = !force ? inFlightPrRequests.get(repo) : undefined;
	if (typeof existingInFlight !== 'undefined') {
		return existingInFlight;
	}
	const task = performFetchRepoPullRequestBadges(dataSource, repo);
	inFlightPrRequests.set(repo, task);
	try {
		return await task;
	} finally {
		if (inFlightPrRequests.get(repo) === task) {
			inFlightPrRequests.delete(repo);
		}
	}
}

async function performFetchRepoPullRequestBadges(dataSource: DataSource, repo: string): Promise<{ [branch: string]: PullRequestBadgeInfo }> {
	const remote = await detectHostingRemote(dataSource, repo);
	if (remote === null) return {};
	const token = await getHostingToken(remote.host);
	const badges: { [branch: string]: PullRequestBadgeInfo } = {};

	if (remote.provider === 'github') {
		const apiBase = remote.host === 'github.com' ? 'https://api.github.com' : ('https://' + remote.host + '/api/v3');
		const headers: { [k: string]: string } = { 'Accept': 'application/vnd.github+json', 'User-Agent': 'vscode-git-map' };
		if (token !== null) headers['Authorization'] = 'Bearer ' + token;
		const pulls = await fetchJson(apiBase + '/repos/' + remote.ownerRepo + '/pulls?state=open&per_page=30', headers);
		if (Array.isArray(pulls)) {
			const top = pulls.slice(0, 12);
			await Promise.all(top.map(async (pr: any) => {
				if (!pr || !pr.head || typeof pr.head.ref !== 'string' || typeof pr.number !== 'number') return;
				const branch = pr.head.ref;
				const sha = typeof pr.head.sha === 'string' ? pr.head.sha : '';
				let ci: PullRequestBadgeInfo['ciStatus'] = 'unknown';
				if (sha !== '') {
					const checks = await fetchJson(apiBase + '/repos/' + remote.ownerRepo + '/commits/' + sha + '/check-runs?per_page=30', headers);
					if (checks && Array.isArray(checks.check_runs) && checks.check_runs.length > 0) {
						const runs: any[] = checks.check_runs;
						if (runs.some((r) => r.status !== 'completed')) ci = 'pending';
						else if (runs.some((r) => r.conclusion === 'failure' || r.conclusion === 'timed_out' || r.conclusion === 'cancelled')) ci = 'failure';
						else if (runs.every((r) => r.conclusion === 'success' || r.conclusion === 'neutral' || r.conclusion === 'skipped')) ci = 'success';
					}
				}
				badges[branch] = {
					number: pr.number,
					title: String(pr.title || ''),
					url: String(pr.html_url || ('https://' + remote.host + '/' + remote.ownerRepo + '/pull/' + pr.number)),
					state: pr.draft ? 'draft' : 'open',
					ciStatus: ci,
					baseBranch: pr.base && typeof pr.base.ref === 'string' ? pr.base.ref : ''
				};
			}));
		}
	} else if (remote.provider === 'gitlab') {
		const apiBase = 'https://' + remote.host + '/api/v4';
		const headers: { [k: string]: string } = { 'Accept': 'application/json' };
		if (token !== null) headers['PRIVATE-TOKEN'] = token;
		const encodedProj = encodeURIComponent(remote.ownerRepo);
		const mrs = await fetchJson(apiBase + '/projects/' + encodedProj + '/merge_requests?state=opened&per_page=25', headers);
		if (Array.isArray(mrs)) {
			for (const mr of mrs) {
				if (!mr || typeof mr.source_branch !== 'string' || typeof mr.iid !== 'number') continue;
				const pipelineStatus = mr.head_pipeline && typeof mr.head_pipeline.status === 'string' ? mr.head_pipeline.status : '';
				const ci: PullRequestBadgeInfo['ciStatus'] = pipelineStatus === 'success'
					? 'success'
					: (pipelineStatus === 'failed' || pipelineStatus === 'canceled' ? 'failure' : (pipelineStatus === 'running' || pipelineStatus === 'pending' ? 'pending' : 'unknown'));
				badges[mr.source_branch] = {
					number: mr.iid,
					title: String(mr.title || ''),
					url: String(mr.web_url || ('https://' + remote.host + '/' + remote.ownerRepo + '/-/merge_requests/' + mr.iid)),
					state: mr.draft || mr.work_in_progress ? 'draft' : 'open',
					ciStatus: ci,
					baseBranch: typeof mr.target_branch === 'string' ? mr.target_branch : ''
				};
			}
		}
	} else if (remote.provider === 'gitea') {
		const apiBase = 'https://' + remote.host + '/api/v1';
		const headers: { [k: string]: string } = { 'Accept': 'application/json', 'User-Agent': 'vscode-git-map' };
		if (token !== null) headers['Authorization'] = 'token ' + token;
		const pulls = await fetchJson(apiBase + '/repos/' + remote.ownerRepo + '/pulls?state=open&limit=25', headers);
		if (Array.isArray(pulls)) {
			await Promise.all(pulls.slice(0, 12).map(async (pr: any) => {
				if (!pr || !pr.head || typeof pr.head.ref !== 'string' || typeof pr.number !== 'number') return;
				const sha = typeof pr.head.sha === 'string' ? pr.head.sha : '';
				let ci: PullRequestBadgeInfo['ciStatus'] = 'unknown';
				if (sha !== '') {
					const st = await fetchJson(apiBase + '/repos/' + remote.ownerRepo + '/commits/' + sha + '/status', headers);
					const s = st && typeof st.state === 'string' ? st.state.toLowerCase() : '';
					if (s === 'success') ci = 'success';
					else if (s === 'failure' || s === 'error') ci = 'failure';
					else if (s === 'pending' || s === 'warning') ci = 'pending';
				}
				badges[pr.head.ref] = {
					number: pr.number,
					title: String(pr.title || ''),
					url: String(pr.html_url || ('https://' + remote.host + '/' + remote.ownerRepo + '/pulls/' + pr.number)),
					state: pr.draft || pr.wip ? 'draft' : 'open',
					ciStatus: ci,
					baseBranch: pr.base && typeof pr.base.ref === 'string' ? pr.base.ref : ''
				};
			}));
		}
	} else if (remote.provider === 'bitbucket') {
		const apiBase = remote.host === 'bitbucket.org' ? 'https://api.bitbucket.org/2.0' : ('https://' + remote.host + '/rest/api/1.0');
		const headers: { [k: string]: string } = { 'Accept': 'application/json', 'User-Agent': 'vscode-git-map' };
		if (token !== null) {
			headers['Authorization'] = token.includes(':')
				? ('Basic ' + Buffer.from(token, 'utf8').toString('base64'))
				: ('Bearer ' + token);
		}
		if (remote.host === 'bitbucket.org') {
			const data = await fetchJson(apiBase + '/repositories/' + remote.ownerRepo + '/pullrequests?state=OPEN&pagelen=25', headers);
			if (data && Array.isArray(data.values)) {
				await Promise.all(data.values.slice(0, 12).map(async (pr: any) => {
					const branch = pr && pr.source && pr.source.branch && typeof pr.source.branch.name === 'string' ? pr.source.branch.name : '';
					if (branch === '' || typeof pr.id !== 'number') return;
					let ci: PullRequestBadgeInfo['ciStatus'] = 'unknown';
					const statusHref = pr.links && pr.links.statuses && typeof pr.links.statuses.href === 'string' ? pr.links.statuses.href : '';
					if (statusHref !== '') {
						const stData = await fetchJson(statusHref, headers);
						if (stData && Array.isArray(stData.values) && stData.values.length > 0) {
							const vals: any[] = stData.values;
							if (vals.some((v) => v.state === 'INPROGRESS')) ci = 'pending';
							else if (vals.some((v) => v.state === 'FAILED' || v.state === 'STOPPED')) ci = 'failure';
							else if (vals.every((v) => v.state === 'SUCCESSFUL')) ci = 'success';
						}
					}
					badges[branch] = {
						number: pr.id,
						title: String(pr.title || ''),
						url: String((pr.links && pr.links.html && pr.links.html.href) || ('https://bitbucket.org/' + remote.ownerRepo + '/pull-requests/' + pr.id)),
						state: pr.draft ? 'draft' : 'open',
						ciStatus: ci,
						baseBranch: pr.destination && pr.destination.branch && typeof pr.destination.branch.name === 'string' ? pr.destination.branch.name : ''
					};
				}));
			}
		}
	} else if (remote.provider === 'azure') {
		const segs = remote.ownerRepo.split('/');
		if (segs.length >= 3) {
			const [org, proj, repoName] = segs;
			const headers: { [k: string]: string } = { 'Accept': 'application/json', 'User-Agent': 'vscode-git-map' };
			if (token !== null) {
				headers['Authorization'] = 'Basic ' + Buffer.from(':' + token, 'utf8').toString('base64');
			}
			const url = 'https://dev.azure.com/' + encodeURIComponent(org) + '/' + encodeURIComponent(proj) + '/_apis/git/repositories/' + encodeURIComponent(repoName) + '/pullrequests?searchCriteria.status=active&$top=25&api-version=7.0';
			const data = await fetchJson(url, headers);
			if (data && Array.isArray(data.value)) {
				for (const pr of data.value) {
					if (!pr || typeof pr.sourceRefName !== 'string' || typeof pr.pullRequestId !== 'number') continue;
					const branch = pr.sourceRefName.replace(/^refs\/heads\//, '');
					const target = typeof pr.targetRefName === 'string' ? pr.targetRefName.replace(/^refs\/heads\//, '') : '';
					badges[branch] = {
						number: pr.pullRequestId,
						title: String(pr.title || ''),
						url: 'https://dev.azure.com/' + encodeURIComponent(org) + '/' + encodeURIComponent(proj) + '/_git/' + encodeURIComponent(repoName) + '/pullrequest/' + pr.pullRequestId,
						state: pr.isDraft ? 'draft' : 'open',
						ciStatus: pr.mergeStatus === 'conflicts' || pr.mergeStatus === 'failure' ? 'failure' : (pr.mergeStatus === 'succeeded' ? 'success' : 'unknown'),
						baseBranch: target
					};
				}
			}
		}
	}

	prCache.set(repo, { expiresAt: Date.now() + PR_CACHE_TTL_MS, badges: badges });
	return badges;
}

/**
 * Fetch detailed Pull Request / Merge Request information (description, author, CI check runs, review summary)
 * for the interactive PR popover card, falling back gracefully to cached badge metadata when offline.
 */
export async function fetchPullRequestDetails(
	dataSource: DataSource,
	repo: string,
	prNumber: number,
	branch: string
): Promise<PullRequestDetailsInfo | null> {
	const cachedBadges = prCache.get(repo);
	const cachedBadge = typeof cachedBadges !== 'undefined' ? cachedBadges.badges[branch] : undefined;
	const remote = await detectHostingRemote(dataSource, repo);
	if (remote === null) {
		return typeof cachedBadge !== 'undefined'
			? {
				number: cachedBadge.number,
				title: cachedBadge.title,
				body: '',
				author: '',
				state: cachedBadge.state,
				url: cachedBadge.url,
				baseBranch: cachedBadge.baseBranch,
				headBranch: branch,
				ciStatus: cachedBadge.ciStatus,
				checks: [],
				reviewSummary: ''
			}
			: null;
	}
	const token = await getHostingToken(remote.host);
	let body = '', author = '', reviewSummary = '';
	let title = typeof cachedBadge !== 'undefined' ? cachedBadge.title : ('#' + prNumber);
	let state: PullRequestDetailsInfo['state'] = typeof cachedBadge !== 'undefined' ? cachedBadge.state : 'open';
	let url = typeof cachedBadge !== 'undefined' ? cachedBadge.url : '';
	let baseBranch = typeof cachedBadge !== 'undefined' ? cachedBadge.baseBranch : '';
	let ciStatus: PullRequestDetailsInfo['ciStatus'] = typeof cachedBadge !== 'undefined' ? cachedBadge.ciStatus : 'unknown';
	const checks: { name: string, status: string }[] = [];

	if (remote.provider === 'github') {
		const apiBase = remote.host === 'github.com' ? 'https://api.github.com' : ('https://' + remote.host + '/api/v3');
		const headers: { [k: string]: string } = { 'Accept': 'application/vnd.github+json', 'User-Agent': 'vscode-git-map' };
		if (token !== null) headers['Authorization'] = 'Bearer ' + token;
		const [pr, reviews] = await Promise.all([
			fetchJson(apiBase + '/repos/' + remote.ownerRepo + '/pulls/' + prNumber, headers),
			fetchJson(apiBase + '/repos/' + remote.ownerRepo + '/pulls/' + prNumber + '/reviews?per_page=20', headers)
		]);
		if (pr) {
			title = String(pr.title || title);
			body = String(pr.body || '').trim();
			author = pr.user && typeof pr.user.login === 'string' ? pr.user.login : '';
			state = pr.merged ? 'merged' : pr.state === 'closed' ? 'closed' : (pr.draft ? 'draft' : 'open');
			url = String(pr.html_url || url);
			baseBranch = pr.base && typeof pr.base.ref === 'string' ? pr.base.ref : baseBranch;
			const sha = pr.head && typeof pr.head.sha === 'string' ? pr.head.sha : '';
			if (sha !== '') {
				const checkData = await fetchJson(apiBase + '/repos/' + remote.ownerRepo + '/commits/' + sha + '/check-runs?per_page=20', headers);
				if (checkData && Array.isArray(checkData.check_runs)) {
					for (const run of checkData.check_runs.slice(0, 12)) {
						checks.push({ name: String(run.name || 'check'), status: String(run.conclusion || run.status || 'unknown') });
					}
					if (checkData.check_runs.some((r: any) => r.status !== 'completed')) ciStatus = 'pending';
					else if (checkData.check_runs.some((r: any) => r.conclusion === 'failure' || r.conclusion === 'timed_out' || r.conclusion === 'cancelled')) ciStatus = 'failure';
					else if (checkData.check_runs.length > 0 && checkData.check_runs.every((r: any) => r.conclusion === 'success' || r.conclusion === 'neutral' || r.conclusion === 'skipped')) ciStatus = 'success';
				}
			}
		}
		if (Array.isArray(reviews) && reviews.length > 0) {
			const approved = reviews.filter((r: any) => r && r.state === 'APPROVED').length;
			const changesRequested = reviews.filter((r: any) => r && r.state === 'CHANGES_REQUESTED').length;
			const parts: string[] = [];
			if (approved > 0) parts.push(approved + ' approved');
			if (changesRequested > 0) parts.push(changesRequested + ' changes requested');
			reviewSummary = parts.join(' · ');
		}
	} else if (remote.provider === 'gitlab') {
		const apiBase = 'https://' + remote.host + '/api/v4';
		const headers: { [k: string]: string } = { 'Accept': 'application/json' };
		if (token !== null) headers['PRIVATE-TOKEN'] = token;
		const mr = await fetchJson(apiBase + '/projects/' + encodeURIComponent(remote.ownerRepo) + '/merge_requests/' + prNumber, headers);
		if (mr) {
			title = String(mr.title || title);
			body = String(mr.description || '').trim();
			author = mr.author && typeof mr.author.username === 'string' ? mr.author.username : '';
			state = mr.state === 'merged' ? 'merged' : mr.state === 'closed' ? 'closed' : (mr.draft || mr.work_in_progress ? 'draft' : 'open');
			url = String(mr.web_url || url);
			baseBranch = typeof mr.target_branch === 'string' ? mr.target_branch : baseBranch;
			if (mr.head_pipeline && typeof mr.head_pipeline.status === 'string') {
				checks.push({ name: 'Pipeline #' + (mr.head_pipeline.id || ''), status: mr.head_pipeline.status });
			}
		}
	} else if (remote.provider === 'gitea') {
		const apiBase = 'https://' + remote.host + '/api/v1';
		const headers: { [k: string]: string } = { 'Accept': 'application/json', 'User-Agent': 'vscode-git-map' };
		if (token !== null) headers['Authorization'] = 'token ' + token;
		const pr = await fetchJson(apiBase + '/repos/' + remote.ownerRepo + '/pulls/' + prNumber, headers);
		if (pr) {
			title = String(pr.title || title);
			body = String(pr.body || '').trim();
			author = pr.user && typeof pr.user.login === 'string' ? pr.user.login : '';
			state = pr.merged ? 'merged' : pr.state === 'closed' ? 'closed' : (pr.draft ? 'draft' : 'open');
			url = String(pr.html_url || url);
			baseBranch = pr.base && typeof pr.base.ref === 'string' ? pr.base.ref : baseBranch;
		}
	}

	if (body.length > 1200) body = body.substring(0, 1200) + '…';
	return {
		number: prNumber,
		title: title,
		body: body,
		author: author,
		state: state,
		url: url,
		baseBranch: baseBranch,
		headBranch: branch,
		ciStatus: ciStatus,
		checks: checks,
		reviewSummary: reviewSummary
	};
}

export async function checkoutPullRequestCommand(dataSource: DataSource, repoManager: RepoManager, extensionState: ExtensionState, arg?: any) {
	let repo: string | null = typeof arg === 'object' && arg !== null && typeof arg.repo === 'string' ? arg.repo : null;
	if (repo === null && vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri.scheme === 'file') {
		repo = repoManager.getRepoContainingFile(getPathFromUri(vscode.window.activeTextEditor.document.uri));
	}
	if (repo === null) {
		const last = extensionState.getLastActiveRepo();
		const repos = repoManager.getRepos();
		repo = last !== null && typeof repos[last] !== 'undefined' ? last : (Object.keys(repos)[0] || null);
	}
	if (repo === null) {
		showErrorMessage(t('No Git repositories were found in the current workspace.'));
		return;
	}
	const remote = await detectHostingRemote(dataSource, repo);
	if (remote === null) {
		showInformationMessage(t('No GitHub or GitLab remote was detected in "{0}".', getRepoName(repo)));
		return;
	}
	const badges = await fetchRepoPullRequestBadges(dataSource, repo, true);
	const entries = Object.entries(badges);
	if (entries.length === 0) {
		showInformationMessage(t('No open Pull Requests were found on {0} (if the repository is private, run "Git Map: Set GitHub / GitLab Token").', remote.ownerRepo));
		return;
	}
	if (typeof vscode.window.showQuickPick !== 'function') return;
	const picked = await vscode.window.showQuickPick(
		entries.map(([branch, info]) => ({
			label: '#' + info.number + ' ' + info.title,
			description: branch + (info.baseBranch !== '' ? ' → ' + info.baseBranch : ''),
			branch: branch,
			number: info.number
		})),
		{ title: t('Checkout Pull Request ({0})', remote.ownerRepo), placeHolder: t('Select an open Pull Request to fetch and check out locally'), ignoreFocusOut: true }
	);
	if (typeof picked === 'undefined') return;
	const localBranch = 'pr-' + picked.number + '-' + picked.branch.replace(/[^A-Za-z0-9._/-]+/g, '-');
	const refSpec = remote.provider === 'gitlab'
		? ('merge-requests/' + picked.number + '/head:' + localBranch)
		: remote.provider === 'bitbucket'
			? (picked.branch + ':' + localBranch)
			: ('pull/' + picked.number + '/head:' + localBranch);
	const fetchRes = await runGit(dataSource, repo, ['fetch', '-f', remote.remoteName, refSpec]);
	if (fetchRes.code !== 0) {
		showErrorMessage(fetchRes.stderr || 'Failed to fetch Pull Request ref.');
		return;
	}
	const checkoutErr = await dataSource.checkoutBranch(repo, localBranch, null);
	if (checkoutErr !== null) showErrorMessage(checkoutErr);
	else showInformationMessage(t('Checked out Pull Request #{0} as local branch "{1}".', String(picked.number), localBranch));
}
