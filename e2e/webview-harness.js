/**
 * Webview UI Harness - Injected (by ./suite.js) into a copy of the Git Map View's HTML, and run in a real Visual
 * Studio Code Webview. It replaces the Webview's messaging API with a fake back-end serving fixture data, drives the
 * UI with DOM events (as a user would), and posts the result of each check back to the Extension Host.
 */
(function () {
	'use strict';
	const realApi = acquireVsCodeApi();
	const requests = [];
	const REPO = '/e2e/harness-repo';
	const NOW = Math.round(Date.now() / 1000);
	const ISSUE_URL = 'gitgraph-e2e://issue/$1';
	const hash = (n) => n.toString(16).padStart(40, '0');
	const HEAD_INDEX = 19;
	// Stashes that aren't in the loaded commits (so the commits are the same as without stashes)
	const STASHES = [
		{ hash: 'a'.repeat(40), baseHash: 'f'.repeat(40), untrackedFilesHash: null, selector: 'refs/stash@{0}', author: 'E2E Author', email: 'author@example.com', date: NOW - 600, message: 'WIP on main: 0000001 Fix #12' },
		{ hash: 'b'.repeat(40), baseHash: 'f'.repeat(40), untrackedFilesHash: 'c'.repeat(40), selector: 'refs/stash@{1}', author: 'E2E Author', email: 'author@example.com', date: NOW - 7200, message: 'On feature: Experiment' }
	];

	/* Fixture Data */

	const makeCommits = (count) => {
		const commits = [];
		for (let i = 0; i < count; i++) {
			commits.push({
				hash: hash(i + 1),
				parents: i < count - 1 ? [hash(i + 2)] : [],
				author: i % 3 === 1 ? 'Second Author' : 'E2E Author',
				email: i % 3 === 1 ? 'second@example.com' : 'author@example.com',
				date: NOW - i * 3600,
				message: i === 0 ? 'Fix #12 and rename files' : (i % 2 === 0 ? 'Resolve #' + (100 + i) : 'Commit ' + i),
				heads: i === 0 ? ['feature'] : i === HEAD_INDEX ? ['main'] : [],
				tags: i === 5 ? [{ name: 'v1.0.0', annotated: true }, { name: 'v1.0.0-rc.2', annotated: false }, { name: 'v1.0.0-rc.1', annotated: false }] : [],
				remotes: [],
				stash: null
			});
		}
		return commits;
	};

	let undoInfo = null; // The action that the extension says can be undone
	let worktreesFixture = []; // The worktrees of the repository
	let operationFixture = null; // The operation in progress in the repository
	let commitCountFixture = null; // The number of commits loaded (instead of 10 or 25)
	let bisectFixture = null; // The state of the bisect in progress in the repository
	let uncommittedFixture = false; // Are the uncommitted changes & a stash (based on the 3rd commit) loaded
	const STASH_COMMIT = { hash: 'd'.repeat(40), parents: [hash(3)], author: 'E2E Author', email: 'author@example.com', date: NOW - 300, message: 'WIP on main: Experiment', heads: [], tags: [], remotes: [], stash: { selector: 'refs/stash@{0}', baseHash: hash(3), untrackedFilesHash: null } };
	const withUncommitted = (commits) => uncommittedFixture ? [{ hash: '*', parents: [hash(HEAD_INDEX + 1)], author: '*', email: '', date: NOW, message: 'Uncommitted Changes (3)', heads: [], tags: [], remotes: [], stash: null }, STASH_COMMIT].concat(commits) : commits;
	const respond = (msg) => {
		switch (msg.command) {
			case 'loadRepoInfo':
				return { command: 'loadRepoInfo', refreshId: msg.refreshId, branches: ['feature', 'main'], head: 'main', remotes: ['origin'], stashes: STASHES, upstreams: { main: { name: 'origin/main', ahead: 2, behind: 1, gone: false } }, isRepo: true, undo: undoInfo, error: null };
			case 'undo':
				undoInfo = null;
				return { command: 'undo', error: null };
			case 'loadWorktrees':
				return { command: 'loadWorktrees', repo: msg.repo, worktrees: worktreesFixture, error: null };
			case 'loadRebaseCommits':
				return { command: 'loadRebaseCommits', base: msg.base, error: null, commits: [5, 4, 3, 2].map((i) => makeCommits(6)[i - 1]).map((commit) => ({ hash: commit.hash, subject: commit.message, message: commit.message + '\n\nThe body of ' + commit.message, author: commit.author, date: commit.date })) };
			case 'rebaseInteractive':
				return { command: 'rebaseInteractive', error: null };
			case 'rebase':
				return { command: 'rebase', actionOn: msg.actionOn, interactive: msg.interactive, error: null };
			case 'loadOperationInProgress':
				return { command: 'loadOperationInProgress', repo: msg.repo, operation: operationFixture };
			case 'controlOperation':
				return { command: 'controlOperation', action: msg.action, error: null };
			case 'addWorktree':
				return { command: 'addWorktree', errors: [null] };
			case 'removeWorktree':
			case 'pruneWorktrees':
			case 'openWorktree':
				return { command: msg.command, error: null };
			case 'loadCommits':
				if (msg.filePath === 'e2e-wide.txt') {
					const base = makeCommits(1)[0], tips = [];
					for (let i = 0; i < 40; i++) tips.push(Object.assign(makeCommits(1)[0], { hash: 'e'.repeat(38) + i.toString(16).padStart(2, '0'), parents: [base.hash], date: base.date + 40 - i, message: 'Branch ' + i, heads: ['branch-' + i] }));
					return { command: 'loadCommits', refreshId: msg.refreshId, commits: tips.concat([base]), head: hash(HEAD_INDEX + 1), tags: [], moreCommitsAvailable: false, onlyFollowFirstParent: msg.onlyFollowFirstParent, fileHistory: { filePath: msg.filePath, paths: [msg.filePath], commits: {} }, error: null };
				}
				if (msg.filePath === 'src/lines.ts') {
					// The history of lines 3-5 of a file: the commits that change them
					const history = makeCommits(9).filter((_, i) => i % 4 === 0);
					history.forEach((commit, i) => commit.parents = i < history.length - 1 ? [history[i + 1].hash] : []);
					const commits = {};
					history.forEach((commit, i) => commits[commit.hash] = { filePath: 'src/lines.ts', oldFilePath: null, additions: i + 1, deletions: 1 });
					return { command: 'loadCommits', refreshId: msg.refreshId, commits: history, head: hash(HEAD_INDEX + 1), tags: [], moreCommitsAvailable: false, onlyFollowFirstParent: msg.onlyFollowFirstParent, fileHistory: { filePath: msg.filePath, paths: [msg.filePath], commits: commits, lineRange: msg.lineRange }, error: null };
				}
				if (msg.filePath === 'e2e-dates.txt') {
					// A commit each day, for the after: & before: search operators (commit 8 is a merge commit, for selecting commits)
					const daily = makeCommits(20).map((commit, i) => Object.assign(commit, { date: NOW - i * 86400, heads: [] }));
					daily[8].parents = [hash(10), hash(11)];
					return { command: 'loadCommits', refreshId: msg.refreshId, commits: daily, head: daily[0].hash, tags: [], moreCommitsAvailable: false, onlyFollowFirstParent: msg.onlyFollowFirstParent, fileHistory: { filePath: msg.filePath, paths: [msg.filePath], commits: {} }, error: null };
				}
				if (msg.filePath === 'src/new-name.ts') {
					// The history of src/new-name.ts: every 5th commit (with the parents rewritten by Git), renamed from src/old-name.ts in the oldest commit
					const history = makeCommits(25).filter((_, i) => i % 5 === 0);
					history.forEach((commit, i) => commit.parents = i < history.length - 1 ? [history[i + 1].hash] : []);
					const commits = {};
					history.forEach((commit, i) => commits[commit.hash] = { filePath: 'src/new-name.ts', oldFilePath: i === history.length - 1 ? 'src/old-name.ts' : null, additions: i + 1, deletions: i });
					return { command: 'loadCommits', refreshId: msg.refreshId, commits: history, head: hash(HEAD_INDEX + 1), tags: [], moreCommitsAvailable: false, onlyFollowFirstParent: msg.onlyFollowFirstParent, fileHistory: { filePath: msg.filePath, paths: ['src/new-name.ts', 'src/old-name.ts'], commits: commits }, error: null };
				}
				if (commitCountFixture !== null) {
					return { command: 'loadCommits', refreshId: msg.refreshId, commits: makeCommits(commitCountFixture), head: hash(HEAD_INDEX + 1), tags: [], moreCommitsAvailable: false, onlyFollowFirstParent: msg.onlyFollowFirstParent, error: null };
				}
				// HEAD is the 20th commit, which isn't included in the first load of 10 commits
				return msg.maxCommits <= 10
					? { command: 'loadCommits', refreshId: msg.refreshId, commits: withUncommitted(makeCommits(10)), head: hash(HEAD_INDEX + 1), tags: [], moreCommitsAvailable: true, onlyFollowFirstParent: msg.onlyFollowFirstParent, error: null }
					: { command: 'loadCommits', refreshId: msg.refreshId, commits: withUncommitted(makeCommits(25)), head: hash(HEAD_INDEX + 1), tags: [], moreCommitsAvailable: false, onlyFollowFirstParent: msg.onlyFollowFirstParent, error: null };
			case 'loadConfig':
				return {
					command: 'loadConfig', repo: msg.repo, error: null,
					config: {
						branches: {}, diffTool: null, guiDiffTool: null, pushDefault: null,
						remotes: [{ name: 'origin', url: 'git@github.com:e2e-owner/e2e-repo.git', pushUrl: null }],
						user: { name: { local: null, global: 'E2E Author' }, email: { local: null, global: 'author@example.com' } }
					}
				};
			case 'commitDetails':
				return {
					command: 'commitDetails', avatar: null, codeReview: null, refresh: msg.refresh, error: null,
					commitDetails: {
						hash: msg.commitHash, parents: [hash(2)],
						author: 'E2E Author', authorEmail: 'author@example.com', authorDate: NOW,
						committer: 'E2E Author', committerEmail: 'author@example.com', committerDate: NOW,
						signature: null, body: 'Fix #12 and rename files',
						fileChanges: [
							{ oldFilePath: 'src/old-name.ts', newFilePath: 'src/new-name.ts', type: 'R', additions: 1, deletions: 1 },
							{ oldFilePath: 'lib/moved.ts', newFilePath: 'src/moved.ts', type: 'R', additions: 0, deletions: 0 },
							{ oldFilePath: 'README.md', newFilePath: 'README.md', type: 'M', additions: 2, deletions: 1 }
						]
					}
				};
			case 'loadCommitStats':
				// Each commit changes 1 file (the 3rd commit changes 2), with lines added & deleted based on its index
				return { command: 'loadCommitStats', error: null, stats: Object.fromEntries(msg.hashes.map((commitHash) => {
					const index = parseInt(commitHash, 16) - 1;
					return [commitHash, { files: index === 2 ? 2 : 1, additions: index * 10, deletions: index }];
				})) };
			case 'loadFileDiff':
				return { command: 'loadFileDiff', commitHash: msg.commitHash, filePath: msg.newFilePath, error: null, diff: 'diff --git a/' + msg.oldFilePath + ' b/' + msg.newFilePath + '\n--- a/' + msg.oldFilePath + '\n+++ b/' + msg.newFilePath + '\n@@ -1,3 +1,3 @@\n line 1\n-line <2>\n+line <two>\n line 3\n' };
			case 'loadStashStats':
				return { command: 'loadStashStats', error: null, stats: Object.fromEntries(msg.stashes.map((stash) => [stash.hash, stash.hash === STASHES[0].hash ? { files: 3, additions: 46, deletions: 8, untrackedFiles: 0 } : { files: 2, additions: 5, deletions: 0, untrackedFiles: 1 }])) };
			case 'loadFileIconTheme':
				// A file icon theme with a font icon for Markdown files, and a default icon for other files
				return {
					command: 'loadFileIconTheme',
					theme: {
						id: 'e2e', fonts: [], light: null, highContrast: null,
						definitions: { '_md': { fontCharacter: 'M', fontColor: '#123456', fontId: null, fontSize: null, iconPath: null }, '_file': { fontCharacter: 'F', fontColor: null, fontId: null, fontSize: null, iconPath: null } },
						file: '_file', folder: null, folderExpanded: null, fileExtensions: { 'md': '_md' }, fileNames: {}, folderNames: {}, folderNamesExpanded: {}
					}
				};
			case 'searchCommits':
				// The commits that change a file whose path contains "README" are the even commits
				return { command: 'searchCommits', id: msg.id, error: null, hashes: msg.files.some((file) => 'readme.md'.includes(file.toLowerCase())) ? makeCommits(25).filter((_, i) => i % 2 === 0).map((commit) => commit.hash) : [] };
			case 'cherrypickCommits':
				return { command: 'cherrypickCommits', errors: [null] };
			case 'compareBranches':
				// feature has the first 4 commits that main doesn't, and their merge base is the 5th commit
				return {
					command: 'compareBranches', error: null,
					comparison: { left: msg.left, right: msg.right, leftHash: hash(1), rightHash: hash(HEAD_INDEX + 1), mergeBase: hash(5), leftOnly: [hash(1), hash(2), hash(3), hash(4)], rightOnly: [] },
					fileChanges: [
						{ oldFilePath: 'src/app.ts', newFilePath: 'src/app.ts', type: 'M', additions: 12, deletions: 3 },
						{ oldFilePath: 'docs/old.md', newFilePath: 'docs/new.md', type: 'R', additions: 1, deletions: 1 }
					]
				};
			case 'loadBranchCleanup':
				return {
					command: 'loadBranchCleanup', repo: msg.repo, defaultBranch: 'main', error: null,
					candidates: [
						{ name: 'old-feature', hash: hash(7), upstream: 'origin/old-feature', upstreamGone: false, merged: true, unmergedCommits: 0, date: NOW - 86400 * 30, author: 'E2E Author', remotes: ['origin'] },
						{ name: 'spike', hash: hash(8), upstream: 'origin/spike', upstreamGone: true, merged: false, unmergedCommits: 2, date: NOW - 86400 * 60, author: 'E2E Author', remotes: [] }
					]
				};
			case 'deleteBranches':
				return { command: 'deleteBranches', deleted: msg.branches.length, errors: [] };
			case 'loadCommitMessage':
				return { command: 'loadCommitMessage', commitHash: msg.commitHash, message: 'Commit ' + HEAD_INDEX + '\n\nThe body', pushedTo: 'origin/main', error: null };
			case 'editCommitMessage':
				return { command: 'editCommitMessage', error: null };
			case 'loadBisectState':
				return { command: 'loadBisectState', repo: msg.repo, state: bisectFixture };
			case 'bisect':
				return { command: 'bisect', action: msg.action, error: null };
			case 'viewBisectLog':
				return { command: 'viewBisectLog', error: null };
			case 'loadLanguageModels':
				return { command: 'loadLanguageModels', models: [{ id: 'm1', name: 'Model One', vendor: 'copilot' }, { id: 'm2', name: 'Model Two', vendor: 'copilot' }], error: null };
			case 'explainCommit':
				// The first part of the explanation (the rest is sent by the check)
				return { command: 'explainCommit', commitHash: msg.commitHash, text: '## Summary\nThis commit **fixes** a bug', done: false, model: 'Model One', truncated: false, error: null };
			case 'loadStashableFiles':
				return {
					command: 'loadStashableFiles', filePath: msg.filePath, stagedSupported: true, error: null,
					files: [{ path: 'src/new-name.ts', staged: true, unstaged: false, untracked: false }, { path: 'README.md', staged: false, unstaged: true, untracked: false }, { path: 'notes.txt', staged: false, unstaged: false, untracked: true }]
				};
			case 'pushStash':
				return { command: 'pushStash', error: null };
			case 'checkPatch':
				return { command: 'checkPatch', error: null, patch: { file: '/e2e/fix.patch', name: 'fix.patch', commits: 2, files: 3, additions: 10, deletions: 2, appliesCleanly: true, checkError: null } };
			case 'applyPatch':
				return { command: 'applyPatch', error: null };
			case 'restoreFileFromStash':
				// The file has uncommitted changes, so it's only restored when forced
				return { command: 'restoreFileFromStash', stashHash: msg.stashHash, selector: msg.selector, filePath: msg.filePath, untracked: msg.untracked, hasChanges: !msg.force, error: null };
			case 'copyToClipboard':
				return { command: 'copyToClipboard', type: msg.type, error: null };
			case 'openExternalUrl':
			case 'setGlobalViewState':
			case 'setWorkspaceViewState':
				return { command: msg.command, error: null };
			default:
				return null;
		}
	};

	const fakeApi = {
		postMessage: (msg) => {
			requests.push(msg);
			const response = respond(msg);
			if (response !== null) setTimeout(() => window.dispatchEvent(new MessageEvent('message', { data: response })), 0);
		},
		getState: () => null,
		setState: () => { }
	};
	globalThis.acquireVsCodeApi = () => fakeApi;

	// Load the fixture repository, with Issue Linking configured to use a custom URL scheme
	const repoState = Object.assign({}, initialState.repos[Object.keys(initialState.repos)[0]], { issueLinkingConfig: { issue: '#(\\d+)', url: ISSUE_URL }, name: null });
	initialState.repos = { [REPO]: repoState };
	initialState.loadViewTo = { repo: REPO };
	initialState.lastActiveRepo = REPO;
	initialState.config.fetchAvatars = false;
	initialState.config.initialLoadCommits = 10;
	initialState.config.loadMoreCommits = 15;
	initialState.config.onRepoLoad = Object.assign({}, initialState.config.onRepoLoad, { scrollToHead: false });

	/* Helpers */

	const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
	const waitFor = async (description, condition, timeout = 5000) => {
		const start = Date.now();
		while (Date.now() - start < timeout) {
			const value = condition();
			if (value) return value;
			await sleep(25);
		}
		throw new Error('Timed out waiting for ' + description);
	};
	const assert = (condition, message) => {
		if (!condition) throw new Error(message);
	};
	const key = (target, k, modifiers) => {
		const event = new KeyboardEvent('keydown', Object.assign({ key: k, bubbles: true, cancelable: true }, modifiers || {}));
		target.dispatchEvent(event);
		return event;
	};
	const mouse = (target, type, init) => {
		const bounds = target.getBoundingClientRect();
		const event = new MouseEvent(type, Object.assign({ bubbles: true, cancelable: true, clientX: Math.round(bounds.left + Math.min(bounds.width / 2, 50)), clientY: Math.round(bounds.top + bounds.height / 2) }, init || {}));
		target.dispatchEvent(event);
		return event;
	};
	const requestsOf = (command) => requests.filter((msg) => msg.command === command);
	// Take a screenshot of the workbench (by the Extension Host, see ./suite.js), saved in e2e/.artifacts/screenshots as ui-<name>.png
	let screenshotId = 0;
	const shot = async (name) => {
		await sleep(400); // Let the Webview repaint first
		return shotNow(name);
	};
	const shotNow = (name) => new Promise((resolve) => {
		const id = ++screenshotId;
		const listener = (e) => {
			if (e.data && e.data.command === 'e2eScreenshotTaken' && e.data.id === id) {
				window.removeEventListener('message', listener);
				resolve(e.data.file);
			}
		};
		window.addEventListener('message', listener);
		realApi.postMessage({ command: 'e2eScreenshot', name: name, id: id });
		setTimeout(() => resolve(null), 10000);
	});
	const commitRow = (index) => document.querySelector('#commitTable tr.commit[data-id="' + index + '"]');
	const isMac = navigator.platform.toUpperCase().indexOf('MAC') > -1;
	const ctrl = isMac ? { metaKey: true } : { ctrlKey: true };
	const results = [];
	const check = async (id, title, fn) => {
		realApi.postMessage({ command: 'e2eProgress', id: id }); // So that a check that hangs can be named
		try {
			results.push({ id: id, title: title, pass: true, details: (await fn()) || '' });
		} catch (err) {
			results.push({ id: id, title: title, pass: false, details: err && err.stack ? err.stack : String(err) });
		}
	};

	/* Checks */

	// Run when the Git Map View is displayed in Simplified Chinese (git-map.language)
	const runL10n = async () => {
		await waitFor('the commits to be rendered', () => document.querySelectorAll('#commitTable tr.commit').length === 10, 10000);

		await check('l10n-view', 'The control bar, column headers, dates & tooltips are displayed in Simplified Chinese', async () => {
			assert(document.documentElement.lang === 'zh-CN', 'Unexpected lang: ' + document.documentElement.lang);
			const controls = document.getElementById('controls').textContent, labels = Array.from(document.querySelectorAll('#controls .dropdownLabel')).map((elem) => elem.textContent);
			assert(JSON.stringify(labels) === JSON.stringify(['仓库', '分支', '作者']), 'Unexpected dropdown labels: ' + JSON.stringify(labels));
			['显示远程分支', '提取', '拉取', '推送'].forEach((text) => assert(controls.includes(text), 'The control bar doesn\'t include "' + text + '": ' + controls));
			const headers = Array.from(document.querySelectorAll('#tableColHeaders th')).map((elem) => elem.textContent.trim());
			assert(JSON.stringify(headers) === JSON.stringify(['分支 / 标签', '图形', '说明', '日期', '作者', '改动', '提交']), 'Unexpected column headers: ' + JSON.stringify(headers));
			const date = commitRow(0).querySelector('.dateCol');
			assert(/^\d{4}年\d{1,2}月\d{1,2}日 \d{2}:\d{2}$/.test(date.textContent), 'Unexpected date: ' + date.textContent);
			assert(date.title.includes('年'), 'Unexpected date tooltip: ' + date.title);
			assert(document.getElementById('findBtn').title === '查找', 'Unexpected Find tooltip: ' + document.getElementById('findBtn').title);
			const legend = document.querySelector('.minimapLegend > span');
			assert(legend !== null && legend.textContent === '视图内提交', 'Unexpected minimap legend: ' + (legend && legend.textContent));
			return 'Columns: ' + headers.join(' | ') + ', date: ' + date.textContent;
		});

		await check('l10n-menu-dialog', 'Context menus and dialogs are displayed in Simplified Chinese', async () => {
			const openContextMenu = async (target) => {
				mouse(target, 'contextmenu', { button: 2 });
				const items = await waitFor('the context menu to open', () => {
					const elems = document.querySelectorAll('.contextMenu .contextMenuItem');
					return elems.length > 0 ? Array.from(elems) : null;
				});
				const untranslated = items.filter((elem) => !/[一-鿿]/.test(elem.textContent));
				assert(untranslated.length === 0, 'Untranslated context menu items: ' + untranslated.map((elem) => elem.textContent).join(' | '));
				return items;
			};
			const branchItems = await openContextMenu(commitRow(0).querySelector('.gitRef.head'));
			key(document.body, 'Escape');
			await waitFor('the context menu to close', () => document.querySelector('.contextMenu') === null);

			const items = await openContextMenu(commitRow(1));
			const createBranchItem = items.find((elem) => elem.textContent.startsWith('创建分支'));
			assert(createBranchItem, 'Unexpected context menu: ' + items.map((elem) => elem.textContent).join(' | '));
			mouse(createBranchItem, 'click');
			const dialogElem = await waitFor('the dialog to open', () => document.querySelector('.dialog'));
			const action = document.getElementById('dialogAction').textContent, cancel = document.getElementById('dialogSecondaryAction').textContent;
			assert(dialogElem.textContent.includes('上创建分支：') && action === '创建分支' && cancel === '取消', 'Unexpected dialog: ' + dialogElem.textContent);
			key(document.body, 'Escape');
			await waitFor('the dialog to close', () => document.querySelector('.dialog') === null);
			return 'Commit context menu: ' + items.map((elem) => elem.textContent).join(' | ') + '; branch context menu: ' + branchItems.length + ' items; dialog buttons: ' + action + ' / ' + cancel;
		});

		await check('l10n-cdv', 'The Commit Details View and the Authors dropdown are displayed in Simplified Chinese', async () => {
			mouse(commitRow(0), 'click');
			const cdv = await waitFor('the Commit Details View to load', () => document.querySelector('#cdv .fileTreeFileRecord') ? document.getElementById('cdv') : null);
			['提交：', '父提交：', '作者：', '提交者：', '日期：'].forEach((text) => assert(cdv.textContent.includes(text), 'The Commit Details View doesn\'t include "' + text + '"'));
			const actions = Array.from(cdv.querySelectorAll('#cdvActions .cdvActionBtn')).map((elem) => elem.textContent);
			assert(actions[0] === '签出…' && actions[1] === '创建分支…' && actions[2] === '拣选…', 'Unexpected action buttons: ' + JSON.stringify(actions));
			assert(document.querySelector('#minimap .minimapTitle').textContent === '活动每日提交数', 'Unexpected minimap title: ' + document.querySelector('#minimap .minimapTitle').textContent);
			const dropdown = document.getElementById('authorDropdown');
			mouse(dropdown.querySelector('.dropdownCurrentValue'), 'click');
			const options = await waitFor('the author options', () => {
				const elems = dropdown.querySelectorAll('.dropdownOption');
				return elems.length > 0 ? Array.from(elems).map((elem) => elem.textContent.trim()) : null;
			});
			assert(options[0] === '全部', 'Unexpected author options: ' + JSON.stringify(options));
			key(document.body, 'Escape');
			return 'Author options: ' + options.join(', ');
		});

		await check('l10n-settings', 'The Repository Settings Widget and its dialogs are displayed in Simplified Chinese', async () => {
			mouse(document.getElementById('settingsBtn'), 'click');
			const widget = await waitFor('the Repository Settings Widget to load', () => document.getElementById('editIssueLinking') ? document.getElementById('settingsWidget') : null);
			const sections = Array.from(widget.querySelectorAll('h3, h4')).map((elem) => elem.textContent.trim());
			['外观 · 所有仓库', '界面语言 · 所有仓库', '状态栏 · 所有仓库', '此仓库', 'Issue 链接', '远程仓库', '常规', '用户信息', '拉取请求创建'].forEach((text) => assert(sections.includes(text), 'Unexpected sections: ' + JSON.stringify(sections)));
			assert(widget.querySelector('#settingsHeader h2').textContent === '设置', 'Unexpected title: ' + widget.querySelector('#settingsHeader h2').textContent);
			mouse(document.getElementById('editIssueLinking'), 'click');
			await waitFor('the Issue Linking dialog', () => document.getElementById('dialogInput1'));
			const action = document.getElementById('dialogAction').textContent, cancel = document.getElementById('dialogSecondaryAction').textContent;
			assert(action === '保存' && cancel === '取消', 'Unexpected dialog buttons: ' + action + ' / ' + cancel);
			key(document.body, 'Escape');
			return 'Sections: ' + sections.join(', ') + '; Issue Linking dialog buttons: ' + action + ' / ' + cancel;
		});
	};

	const run = async () => {
		if (initialState.l10n !== null) return runL10n();
		const keybindings = initialState.config.keybindings;
		await waitFor('the commits to be rendered', () => document.querySelectorAll('#commitTable tr.commit').length === 10, 10000);

		await check('#857', '"Scroll to HEAD" loads more commits until HEAD is loaded', async () => {
			const loads = requestsOf('loadCommits').length;
			key(document.body, keybindings.scrollToHead, ctrl);
			await waitFor('more commits to be requested', () => requestsOf('loadCommits').length > loads);
			await waitFor('the HEAD commit to be scrolled to', () => commitRow(HEAD_INDEX) !== null && commitRow(HEAD_INDEX).classList.contains('flash'));
			return 'Requested maxCommits ' + requestsOf('loadCommits').map((msg) => msg.maxCommits).join(' → ');
		});

		await check('#892', 'The second keypress of a keybinding chord (e.g. Ctrl+K Ctrl+H) is left to Visual Studio Code', async () => {
			key(document.body, 'k', ctrl);
			const chordEvent = key(document.body, keybindings.find, ctrl);
			assert(!chordEvent.defaultPrevented, 'Git Map handled the second keypress of the chord');
			assert(!document.querySelector('.findWidget').classList.contains('active'), 'The Find Widget was opened by the second keypress of the chord');
			const event = key(document.body, keybindings.find, ctrl);
			assert(event.defaultPrevented, 'Git Map didn\'t handle its own keybinding outside of a chord');
			await waitFor('the Find Widget to open', () => document.querySelector('.findWidget').classList.contains('active'));
			key(document.getElementById('findInput'), 'Escape');
			await waitFor('the Find Widget to close', () => !document.querySelector('.findWidget').classList.contains('active'));
		});

		await check('#928', 'Tooltips are shown for elements with a title (e.g. the (i) icons)', async () => {
			const findBtn = document.getElementById('findBtn');
			let tooltip = null;
			for (let attempt = 1; attempt <= 3 && tooltip === null; attempt++) {
				// Retried, as real mouse / focus events (the Visual Studio Code window is on screen) can hide a pending tooltip
				mouse(findBtn, 'mouseover');
				assert(!findBtn.hasAttribute('title'), 'The title attribute should be removed while hovering, so the native tooltip isn\'t also shown');
				tooltip = await waitFor('the tooltip to be shown', () => document.getElementById('titleTooltip'), 1500).catch(() => null);
			}
			assert(tooltip !== null, 'The tooltip wasn\'t shown');
			assert(tooltip.textContent === 'Find', 'Unexpected tooltip: ' + tooltip.textContent);
			mouse(document.getElementById('commitTable'), 'mouseover');
			assert(document.getElementById('titleTooltip') === null, 'The tooltip wasn\'t hidden');
			assert(findBtn.getAttribute('title') === 'Find', 'The title attribute wasn\'t restored');
		});

		await check('#852', 'The mouse back / forward buttons navigate the editor history', async () => {
			mouse(document.getElementById('view'), 'mouseup', { button: 3 });
			mouse(document.getElementById('view'), 'mouseup', { button: 4 });
			const navigations = requestsOf('navigateEditorHistory').map((msg) => msg.forward);
			assert(navigations.length === 2 && navigations[0] === false && navigations[1] === true, 'Unexpected navigation requests: ' + JSON.stringify(navigations));
		});

		// Open the Commit Details View of the first commit
		mouse(commitRow(0), 'click');
		await waitFor('the Commit Details View to load', () => document.querySelector('#cdv .fileTreeFileRecord'));

		await check('#723', 'Renamed files show their original name in the Commit Details View', async () => {
			const labels = Array.from(document.querySelectorAll('#cdv .gitFileRenamedFrom')).map((elem) => elem.textContent);
			assert(labels.length === 2 && labels.includes('← old-name.ts') && labels.includes('← lib/moved.ts'), 'Unexpected labels: ' + JSON.stringify(labels));
			return labels.join(', ');
		});

		await check('#792', 'Issue links using a custom URL scheme are opened (via the extension)', async () => {
			const link = await waitFor('the issue link', () => Array.from(document.querySelectorAll('#cdv a.externalUrl')).find((elem) => elem.getAttribute('href').startsWith('gitgraph-e2e:')));
			// If Git Map doesn't handle the click, prevent the Webview from navigating to the link (which would unload this harness)
			let reachedSafetyNet = false, preventedBeforeSafetyNet = false;
			const safetyNet = (e) => {
				reachedSafetyNet = true;
				preventedBeforeSafetyNet = e.defaultPrevented;
				e.preventDefault();
			};
			window.addEventListener('click', safetyNet);
			const event = mouse(link, 'click');
			window.removeEventListener('click', safetyNet);
			assert(reachedSafetyNet ? preventedBeforeSafetyNet : event.defaultPrevented, 'The click wasn\'t handled');
			const opened = requestsOf('openExternalUrl').map((msg) => msg.url);
			assert(opened.length === 1 && opened[0] === 'gitgraph-e2e://issue/12', 'Unexpected URLs opened: ' + JSON.stringify(opened));
			return 'Opened ' + opened[0];
		});

		await check('#864', 'The Menu key / Shift+F10 opens the context menu of the commit selected with the keyboard', async () => {
			const view = document.getElementById('view');
			view.focus();
			mouse(view, 'contextmenu', { button: 0 });
			const menu = await waitFor('the context menu to open', () => document.querySelector('.contextMenu'));
			assert(menu.textContent.includes('Create Branch'), 'Unexpected context menu: ' + menu.textContent);
			assert(commitRow(0).classList.contains('contextMenuActive'), 'The context menu isn\'t for the selected commit');
			key(document.body, 'Escape');
			await waitFor('the context menu to close', () => document.querySelector('.contextMenu') === null);
		});

		await check('ui-toolbar', '[Redesign] The control bar is sticky, has its labels inside the dropdowns, and a Jump to HEAD button', async () => {
			const controls = document.getElementById('controls');
			assert(getComputedStyle(controls).position === 'sticky', 'The controls aren\'t sticky: ' + getComputedStyle(controls).position);
			const labels = Array.from(document.querySelectorAll('#controls .dropdownLabel')).map((elem) => elem.textContent);
			assert(JSON.stringify(labels) === JSON.stringify(['Repo', 'Branches', 'Authors']), 'Unexpected dropdown labels: ' + JSON.stringify(labels));
			const headBtn = document.getElementById('scrollToHeadBtn');
			assert(headBtn !== null && headBtn.querySelector('svg') !== null && headBtn.getAttribute('title') === 'Scroll to HEAD' && headBtn.textContent === 'HEAD', 'The Jump to HEAD button is missing');

			// The Pull & Push buttons show how many commits the current branch (main) is behind / ahead of its upstream (origin/main)
			const pullBtn = document.getElementById('pullBtn'), pushBtn = document.getElementById('pushBtn');
			assert(pullBtn.textContent === 'Pull1' && pushBtn.textContent === 'Push2' && pushBtn.classList.contains('pending'), 'Unexpected sync buttons: ' + pullBtn.textContent + ' / ' + pushBtn.textContent);
			mouse(pushBtn, 'click');
			const pushDialog = await waitFor('the Push Branch dialog', () => document.querySelector('.dialog'));
			assert(pushDialog.textContent.includes('push the branch main'), 'Unexpected Push dialog: ' + pushDialog.textContent);
			key(document.body, 'Escape');
			await waitFor('the dialog to close', () => document.querySelector('.dialog') === null);
			mouse(pullBtn, 'click');
			const pullDialog = await waitFor('the Pull dialog', () => document.querySelector('.dialog'));
			assert(pullDialog.textContent.includes('pull the remote branch origin/main into main'), 'Unexpected Pull dialog: ' + pullDialog.textContent);
			key(document.body, 'Escape');
			await waitFor('the dialog to close', () => document.querySelector('.dialog') === null);
			mouse(document.querySelector('#branchDropdown .dropdownLabel'), 'click');
			await waitFor('the Branches dropdown to open when its label is clicked', () => document.getElementById('branchDropdown').classList.contains('dropdownOpen'));
			mouse(controls, 'click');
			await waitFor('the Branches dropdown to close', () => !document.getElementById('branchDropdown').classList.contains('dropdownOpen'));
			return 'Labels: ' + labels.join(', ') + '; sync: ' + pullBtn.textContent + ', ' + pushBtn.textContent;
		});

		await check('ui-cdv', '[Redesign] The Commit Details View is docked to the right, with buttons for the most common commit actions', async () => {
			mouse(commitRow(3), 'click');
			await waitFor('the Commit Details View of the commit to load', () => document.querySelector('#cdv .fileTreeFileRecord') && document.querySelector('#cdvActions .cdvActionBtn') && commitRow(3).classList.contains('commitDetailsOpen'));
			const cdv = document.getElementById('cdv');
			assert(cdv.classList.contains('docked') && cdv.classList.contains('right') && document.body.classList.contains('cdvDockedRight'), 'The Commit Details View isn\'t docked to the right: ' + cdv.className);
			assert(cdv.style.width !== '' && document.getElementById('view').style.right === cdv.style.width, 'The view isn\'t beside the Commit Details View: ' + document.getElementById('view').style.right + ' / ' + cdv.style.width);
			const buttons = Array.from(document.querySelectorAll('#cdvActions .cdvActionBtn')).map((elem) => elem.textContent);
			assert(JSON.stringify(buttons) === JSON.stringify(['Checkout\u2026', 'Create Branch\u2026', 'Cherry Pick\u2026', '\u00b7\u00b7\u00b7']), 'Unexpected action buttons: ' + JSON.stringify(buttons));
			mouse(document.getElementById('cdvMoreActions'), 'click');
			const menu = await waitFor('the commit context menu to open', () => document.querySelector('.contextMenu'));
			assert(menu.textContent.includes('Revert') && menu.textContent.includes('Copy Commit Hash to Clipboard'), 'Unexpected context menu: ' + menu.textContent);
			key(document.body, 'Escape');
			await waitFor('the context menu to close', () => document.querySelector('.contextMenu') === null);
			return 'Width: ' + cdv.style.width + ', actions: ' + buttons.join(' | ');
		});

		await check('ui-cdv-panel', '[Redesign] The Commit Details View has a header with previous / next buttons, chips to copy the hash / open on the remote / compare, the branches containing the commit, and tabs of the changed files & commit message', async () => {
			const title = document.querySelector('#cdvHeader .cdvHeaderTitle');
			assert(title !== null && title.textContent === 'Commit Details', 'Unexpected header: ' + (title && title.textContent));
			const chips = Array.from(document.querySelectorAll('#cdvSummary .cdvChip')).map((elem) => elem.textContent);
			assert(JSON.stringify(chips) === JSON.stringify([hash(4).substring(0, 8), 'Open on Remote', 'Compare with\u2026']), 'Unexpected chips: ' + JSON.stringify(chips));
			mouse(document.getElementById('cdvCopyHash'), 'click');
			const copied = requestsOf('copyToClipboard').pop();
			assert(copied && copied.data === hash(4), 'The hash wasn\'t copied: ' + JSON.stringify(copied));
			mouse(document.getElementById('cdvOpenOnRemote'), 'click');
			const opened = requestsOf('openExternalUrl').pop();
			assert(opened && opened.url === 'https://github.com/e2e-owner/e2e-repo/commit/' + hash(4), 'Unexpected URL opened: ' + JSON.stringify(opened));
			const branches = Array.from(document.querySelectorAll('#cdvSummary .cdvBranch')).map((elem) => elem.textContent);
			assert(JSON.stringify(branches) === JSON.stringify(['feature']), 'Unexpected branches: ' + JSON.stringify(branches));
			const stats = document.querySelector('#cdvSummary .cdvStats').textContent;
			assert(stats === '3 files+3\u22122', 'Unexpected stats: ' + stats);
			const badges = Array.from(document.querySelectorAll('#cdvFileView .fileTreeFileRecord')).map((elem) => elem.querySelector('.fileTreeFileBadge').textContent + (elem.querySelector('.changeBar') !== null ? ' bar' : ''));
			assert(badges.length === 3 && badges.every((badge) => badge.endsWith(' bar')) && badges.filter((badge) => badge.startsWith('R')).length === 2, 'Unexpected files: ' + JSON.stringify(badges));
			// The icons of the files are from the file icon theme of Visual Studio Code
			const icons = Array.from(document.querySelectorAll('#cdvFileView .fileTreeFileRecord')).map((elem) => elem.querySelector('.gitFileName').textContent + '=' + elem.querySelector('.fileTypeIcon').textContent).sort();
			assert(JSON.stringify(icons) === JSON.stringify(['README.md=M', 'moved.ts=F', 'new-name.ts=F']), 'Unexpected file icons: ' + JSON.stringify(icons));
			const readmeIcon = Array.from(document.querySelectorAll('#cdvFileView .fileTypeIcon')).find((elem) => elem.textContent === 'M');
			assert(getComputedStyle(readmeIcon).color === 'rgb(18, 52, 86)', 'The colour of the icon isn\'t from the theme: ' + getComputedStyle(readmeIcon).color);

			mouse(document.querySelector('.cdvTab[data-tab="message"]'), 'click');
			const messageView = document.getElementById('cdvMessageView');
			assert(!messageView.classList.contains('hidden') && document.getElementById('cdvFileView').classList.contains('hidden') && messageView.textContent.includes('Commit:'), 'The Commit Message tab wasn\'t shown');
			mouse(document.querySelector('.cdvTab[data-tab="files"]'), 'click');
			assert(messageView.classList.contains('hidden') && !document.getElementById('cdvFileView').classList.contains('hidden'), 'The Changed Files tab wasn\'t shown');

			mouse(document.getElementById('cdvNext'), 'click');
			await waitFor('the next commit to be loaded', () => commitRow(4).classList.contains('commitDetailsOpen') && document.querySelector('#cdv .fileTreeFileRecord'));
			mouse(document.getElementById('cdvPrev'), 'click');
			await waitFor('the previous commit to be loaded', () => commitRow(3).classList.contains('commitDetailsOpen') && document.getElementById('cdvCompare'));

			mouse(document.getElementById('cdvCompare'), 'click');
			assert(document.getElementById('cdvCompare').classList.contains('active'), 'The Compare chip isn\'t active');
			mouse(commitRow(6), 'click');
			const compare = await waitFor('the commits to be compared', () => requestsOf('compareCommits').pop());
			assert(compare.commitHash === hash(4) && compare.compareWithHash === hash(7), 'Unexpected comparison: ' + JSON.stringify(compare));
			await waitFor('the header to show the comparison', () => document.querySelector('#cdvHeader .cdvHeaderTitle').textContent === 'Commit Comparison');
			mouse(document.getElementById('cdvClose'), 'click');
			await waitFor('the Commit Details View to close', () => document.getElementById('cdv') === null);
			return 'Chips: ' + chips.join(' | ') + '; branches: ' + branches.join(', ') + '; stats: ' + stats + '; files: ' + badges.join(', ') + '; icons: ' + icons.join(', ');
		});

		await check('ui-commit-list', '[Redesign] The commits have a Branches / Tags column (with how far branches are ahead / behind their upstream) and a Changes column (loaded on demand, which can be hidden), and a footer', async () => {
			const headers = Array.from(document.querySelectorAll('#tableColHeaders th')).map((elem) => elem.textContent.trim());
			assert(JSON.stringify(headers) === JSON.stringify(['Branches / Tags', 'Graph', 'Description', 'Date', 'Author', 'Changes', 'Commit']), 'Unexpected column headers: ' + JSON.stringify(headers));
			assert(commitRow(0).querySelector('td.refsCol .gitRef.head').textContent === 'feature' && commitRow(0).querySelector('td.descriptionCol .gitRef') === null, 'The branch label isn\'t in the Branches / Tags column');
			const main = commitRow(HEAD_INDEX).querySelector('td.refsCol .gitRef.head');
			assert(main.textContent === 'main\u21912\u21931' && main.querySelector('.gitRefTrack').title === '2 commit(s) ahead of origin/main, 1 commit(s) behind origin/main', 'Unexpected label of main: ' + main.textContent);
			// The labels that don't fit are truncated (the first label isn't), and the tooltip of the cell lists them
			const tagsCell = commitRow(5).querySelector('td.refsCol'), firstTag = tagsCell.querySelector('.gitRef');
			assert(tagsCell.querySelectorAll('.gitRef').length === 3 && document.querySelector('.refsColMore') === null, 'Unexpected labels: ' + tagsCell.innerHTML);
			assert(tagsCell.title === 'v1.0.0\nv1.0.0-rc.2\nv1.0.0-rc.1' && firstTag.querySelector('.gitRefName').scrollWidth <= firstTag.querySelector('.gitRefName').clientWidth, 'The labels don\'t fit: "' + tagsCell.title + '"');
			const graphLeft = document.querySelector('#commitGraph').getBoundingClientRect().left, graphColLeft = document.getElementById('tableHeaderGraphCol').getBoundingClientRect().left;
			assert(Math.abs(graphLeft - graphColLeft) < 1, 'The graph isn\'t in the Graph column: ' + graphLeft + ' / ' + graphColLeft);

			const stats = await waitFor('the changes of the commits', () => {
				const cells = Array.from(document.querySelectorAll('#commitTable tr.commit td.changesCol')).map((cell) => cell.textContent);
				return cells.length > 0 && cells.every((cell) => cell !== '') ? cells : null;
			});
			assert(stats[0] === '+0\u22120' && stats[3] === '+30\u22123' && commitRow(2).querySelector('td.changesCol > span').title === '2 files', 'Unexpected changes: ' + JSON.stringify(stats.slice(0, 4)));
			const requested = requestsOf('loadCommitStats').reduce((hashes, msg) => hashes.concat(msg.hashes), []);
			assert(new Set(requested).size === requested.length, 'The changes of a commit were requested more than once');

			mouse(document.getElementById('columnSettingsBtn'), 'click');
			const menu = await waitFor('the column menu', () => document.querySelector('.contextMenu'));
			const changesItem = Array.from(menu.querySelectorAll('.contextMenuItem')).find((item) => item.textContent === 'Changes');
			assert(changesItem && changesItem.querySelector('svg') !== null, 'The Changes column isn\'t checked in the column menu');
			mouse(changesItem, 'click');
			await waitFor('the Changes column to be hidden', () => document.querySelector('#commitTable td.changesCol') === null);
			mouse(document.getElementById('columnSettingsBtn'), 'click');
			mouse(Array.from((await waitFor('the column menu', () => document.querySelector('.contextMenu'))).querySelectorAll('.contextMenuItem')).find((item) => item.textContent === 'Changes'), 'click');
			await waitFor('the Changes column to be shown', () => document.querySelector('#commitTable tr.commit td.changesCol') !== null && commitRow(0).querySelector('td.changesCol').textContent !== '');

			const footer = document.getElementById('listFooter').textContent;
			assert(footer.includes(document.querySelectorAll('#commitTable tr.commit').length + ' commits loaded') && footer.includes('Scrollbar markers:'), 'Unexpected footer: ' + footer);
			return 'Columns: ' + headers.join(' | ') + '; main: ' + main.textContent + '; footer: ' + footer;
		});

		await check('ui-stash-list', '[Redesign] The Stashes button lists the stashes (with their branch, date & changes), applies / pops / drops them, and goes to them', async () => {
			const stashBtn = document.getElementById('stashBtn');
			assert(!stashBtn.classList.contains('hidden') && stashBtn.textContent === 'Stashes2', 'Unexpected Stashes button: ' + stashBtn.textContent);
			mouse(stashBtn, 'click');
			const list = await waitFor('the list of stashes', () => document.getElementById('stashList'));
			const items = () => Array.from(list.querySelectorAll('.stashListItem'));
			assert(JSON.stringify(items().map((item) => item.querySelector('.stashListSelector').textContent)) === JSON.stringify(['stash@{0}', 'stash@{1}']), 'Unexpected stashes');
			const stats = requestsOf('loadStashStats').pop();
			assert(stats && stats.stashes.length === 2 && stats.stashes[1].untrackedFilesHash === 'c'.repeat(40), 'The stats of the stashes weren\'t requested: ' + JSON.stringify(stats));
			const metas = await waitFor('the stats of the stashes', () => {
				const metas = items().map((item) => item.querySelector('.stashListMeta').textContent);
				return metas.every((meta) => meta.includes(' files · ')) ? metas : null;
			});
			assert(metas[0].startsWith('main') && metas[0].includes('3 files · +46 \u22128') && metas[1].startsWith('feature') && metas[1].includes('Includes untracked files') && metas.every((meta) => meta.includes('Not in the loaded commits')), 'Unexpected stashes: ' + JSON.stringify(metas));
			assert(document.getElementById('stashListStashChanges').classList.contains('disabled'), 'Stashing is possible without uncommitted changes');

			mouse(items()[0].querySelector('.stashListAction[data-action="apply"]'), 'click');
			const applyDialog = await waitFor('the Apply Stash dialog', () => document.querySelector('.dialog'));
			assert(applyDialog.textContent.includes('apply the stash stash@{0}') && document.getElementById('stashList') === null, 'Unexpected Apply Stash dialog: ' + applyDialog.textContent);
			key(document.body, 'Escape');
			await waitFor('the dialog to close', () => document.querySelector('.dialog') === null);

			mouse(stashBtn, 'click');
			await waitFor('the list of stashes', () => document.getElementById('stashList'));
			mouse(document.querySelectorAll('#stashList .stashListItem')[1].querySelector('.stashListAction[data-action="drop"]'), 'click');
			const dropDialog = await waitFor('the Drop Stash dialog', () => document.querySelector('.dialog'));
			assert(dropDialog.textContent.includes('drop the stash stash@{1}'), 'Unexpected Drop Stash dialog: ' + dropDialog.textContent);
			key(document.body, 'Escape');
			await waitFor('the dialog to close', () => document.querySelector('.dialog') === null);

			// The stash isn't in the commits (and all commits are loaded), so it can't be gone to
			mouse(stashBtn, 'click');
			await waitFor('the list of stashes', () => document.getElementById('stashList'));
			mouse(document.querySelector('#stashList .stashListMessage'), 'click');
			const message = await waitFor('the message', () => document.querySelector('.dialog'));
			assert(message.textContent.includes('stash@{0} isn\'t in the commits that are currently shown'), 'Unexpected message: ' + message.textContent);
			key(document.body, 'Escape');
			await waitFor('the dialog to close', () => document.querySelector('.dialog') === null);
			mouse(stashBtn, 'click');
			await waitFor('the list of stashes', () => document.getElementById('stashList'));
			key(document.body, 'Escape');
			await waitFor('the list to close', () => document.getElementById('stashList') === null && !stashBtn.classList.contains('active'));
			return metas.join(' | ');
		});

		await check('ui-branch-highlight', '[GitLens] Hovering over a commit highlights the branch it is on in the graph', async () => {
			const graph = document.querySelector('#commitGraph > svg');
			mouse(commitRow(5), 'mouseover');
			await waitFor('the branch to be highlighted', () => graph.classList.contains('branchHighlight'));
			const highlighted = graph.querySelectorAll('path.line.highlight').length, vertices = graph.querySelectorAll('circle.highlight').length;
			assert(highlighted > 0 && vertices > 0, 'Nothing was highlighted: ' + highlighted + ' lines, ' + vertices + ' vertices');
			mouse(document.getElementById('commitTable'), 'mouseleave');
			await waitFor('the highlight to be removed', () => !graph.classList.contains('branchHighlight'));
			return highlighted + ' line(s) & ' + vertices + ' vertices highlighted';
		});

		await check('ui-minimap', '[GitLens] The minimap shows the activity of the loaded commits, where HEAD & branches are, and the visible commits', async () => {
			const minimap = document.getElementById('minimap');
			assert(minimap.classList.contains('active'), 'The minimap isn\'t shown');
			const bars = Array.from(minimap.querySelectorAll('.minimapBar')), activeBars = bars.filter((bar) => !bar.classList.contains('empty'));
			const loaded = document.querySelectorAll('#commitTable tr.commit').length;
			const counted = activeBars.reduce((sum, bar) => sum + parseInt(bar.getAttribute('title').match(/: (\d+) commits?$/)[1]), 0);
			assert(bars.length >= 30 && counted === loaded, 'Unexpected bars: ' + bars.length + ' days, ' + counted + ' of ' + loaded + ' commits');
			assert(minimap.querySelector('.minimapMarker.head') !== null && minimap.querySelector('.minimapMarker.branch') !== null, 'The HEAD & branch markers are missing');
			const viewport = document.getElementById('minimapViewport');
			assert(viewport !== null && viewport.style.width !== '', 'The visible commits aren\'t shown');
			// The bars of the visible commits are highlighted, the box describes them, and a legend explains the minimap
			assert(minimap.querySelectorAll('.minimapBar.visible:not(.empty)').length > 0 && viewport.title.startsWith('The commits in view: ') && /\(\d+ commits?\)\nDrag to scroll through the commits\.$/.test(viewport.title), 'Unexpected box of the commits in view: ' + viewport.title);
			const legend = Array.from(minimap.querySelectorAll('.minimapLegend > span')).map((elem) => elem.textContent);
			assert(JSON.stringify(legend) === JSON.stringify(['In view', 'HEAD', 'Branches', 'Tags']), 'Unexpected legend: ' + JSON.stringify(legend));
			const axis = Array.from(minimap.querySelectorAll('.minimapAxis > span')).map((elem) => elem.textContent);
			assert(axis.length >= 3 && axis[axis.length - 1] === 'Today' && minimap.querySelector('.minimapUnit').textContent === 'Commits per day', 'Unexpected axis: ' + JSON.stringify(axis));
			mouse(activeBars[0], 'click');
			const flashed = await waitFor('the oldest day\'s newest commit to be scrolled to', () => document.querySelector('#commitTable tr.commit.flash'));
			// The commit isn't hidden by the frozen column headers or footer
			const rowRect = flashed.getBoundingClientRect();
			assert(rowRect.top >= document.querySelector('#tableColHeaders th').getBoundingClientRect().bottom - 1 && rowRect.bottom <= document.getElementById('footer').getBoundingClientRect().top + 1, 'The commit scrolled to is hidden: ' + JSON.stringify(rowRect));
			return bars.length + ' days, ' + activeBars.length + ' with commits (' + counted + ' commits); axis: ' + axis.join(' | ') + '; ' + viewport.title.replace('\n', ' ');
		});

		await check('ui-minimap-zoom', '[GitLens] The minimap can be zoomed in on a range of dates (its bars & axis changing with it) and panned, its box of the commits in view dragged to scroll, and its height changed', async () => {
			const minimap = document.getElementById('minimap'), view = document.getElementById('view');
			const numBars = () => minimap.querySelectorAll('.minimapBar').length, axis = () => Array.from(minimap.querySelectorAll('.minimapAxis > span')).map((elem) => elem.textContent);
			const zoomBtn = (zoom) => minimap.querySelector('.minimapZoomBtn[data-zoom="' + zoom + '"]'), chart = () => minimap.querySelector('.minimapChart');
			// The view is made shorter, so that it can be scrolled
			view.style.bottom = Math.max(window.innerHeight - 460, 0) + 'px';
			view.scrollTop = 0;
			try {
				const allBars = numBars(), allAxis = axis().join(' | ');
				assert(zoomBtn('out').classList.contains('disabled') && zoomBtn('all').classList.contains('disabled') && !zoomBtn('in').classList.contains('disabled'), 'Unexpected zoom buttons before zooming in');

				// The zoom buttons & Ctrl / Cmd + scroll zoom in (around the mouse), down to a week
				mouse(zoomBtn('in'), 'click');
				await waitFor('the minimap to zoom in', () => numBars() < allBars && !zoomBtn('all').classList.contains('disabled'));
				const zoomedBars = numBars();
				let chartRect = chart().getBoundingClientRect();
				chart().dispatchEvent(new WheelEvent('wheel', Object.assign({ bubbles: true, cancelable: true, deltaY: -1000, clientX: chartRect.right - 2, clientY: chartRect.top + 20 }, ctrl)));
				await waitFor('the minimap to zoom in further', () => numBars() < zoomedBars);
				const weekAxis = axis();
				assert(numBars() === 7 && zoomBtn('in').classList.contains('disabled') && weekAxis[weekAxis.length - 1] === 'Today' && weekAxis.join(' | ') !== allAxis, 'Unexpected zoomed in minimap: ' + numBars() + ' bars, axis: ' + weekAxis.join(' | '));

				// Scrolling horizontally pans the minimap to earlier dates (the commits in view are then outside of it)
				chartRect = chart().getBoundingClientRect();
				chart().dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaX: -chartRect.width, clientX: chartRect.left + 20, clientY: chartRect.top + 20 }));
				await waitFor('the minimap to pan', () => axis()[axis().length - 1] !== 'Today');
				assert(document.getElementById('minimapViewport').style.display === 'none', 'The box of the commits in view should be hidden when they\'re outside of the minimap');
				const pannedAxis = axis().join(' | ');
				// Scrolling the view pans the minimap back to the commits in view
				view.scrollTop = 40;
				await waitFor('the minimap to follow the view', () => axis()[axis().length - 1] === 'Today' && document.getElementById('minimapViewport').style.display !== 'none');
				view.scrollTop = 0;
				await sleep(100);

				// Dragging the box of the commits in view to the left scrolls the view to older commits
				const box = document.getElementById('minimapViewport'), boxRect = box.getBoundingClientRect(), barWidth = chart().getBoundingClientRect().width / numBars();
				const down = mouse(box, 'mousedown', { button: 0, clientX: Math.round(boxRect.right - 2) });
				const overlay = document.getElementById('eventCaptureElem');
				overlay.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: down.clientX - 10, clientY: down.clientY }));
				overlay.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: Math.round(down.clientX - barWidth * 1.5), clientY: down.clientY }));
				overlay.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: Math.round(down.clientX - barWidth * 1.5), clientY: down.clientY }));
				// The newest commit from before today is scrolled to the top of the view (or into view, if the view can't be scrolled that far)
				const scrolled = await waitFor('the view to scroll', () => view.scrollTop > 0 ? view.scrollTop : null);
				const midnight = new Date();
				midnight.setHours(0, 0, 0, 0);
				let expected = 0;
				while (NOW - expected * 3600 >= midnight.getTime() / 1000) expected++;
				const headersBottom = document.querySelector('#tableColHeaders th').getBoundingClientRect().bottom, expectedRect = commitRow(expected).getBoundingClientRect();
				const atTop = Math.abs(expectedRect.top - headersBottom) < 1.5, atEnd = view.scrollTop >= view.scrollHeight - view.clientHeight - 1;
				assert(atTop || (atEnd && expectedRect.top >= headersBottom - 1 && expectedRect.bottom <= document.getElementById('footer').getBoundingClientRect().top + 1), 'Commit ' + expected + ' wasn\'t scrolled to: ' + expectedRect.top + ' / ' + headersBottom + ' (scrolled ' + view.scrollTop + 'px)');
				const topRow = commitRow(expected);

				// Show all of the loaded commits again
				await sleep(350);
				mouse(zoomBtn('all'), 'click');
				await waitFor('all of the loaded commits to be shown', () => numBars() === allBars && zoomBtn('all').classList.contains('disabled'));

				// Dragging the bottom edge makes the minimap taller (remembered for all repositories), and the frozen column headers move down with it
				view.scrollTop = 0;
				const handle = minimap.querySelector('.minimapResize'), height = minimap.offsetHeight, headerCell = document.querySelector('#tableColHeaders th'), headersTop = headerCell.getBoundingClientRect().top;
				const resize = (dy) => {
					const start = mouse(handle, 'mousedown', { button: 0 }), capture = document.getElementById('eventCaptureElem');
					if (dy !== 0) capture.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: start.clientX, clientY: start.clientY + dy }));
					capture.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: start.clientX, clientY: start.clientY + dy }));
				};
				resize(40);
				await waitFor('the minimap to be taller', () => minimap.offsetHeight === height + 40 && Math.abs(headerCell.getBoundingClientRect().top - headersTop - 40) < 1.5);
				const saved = requestsOf('setGlobalViewState').slice(-1)[0];
				assert(saved && saved.state.minimapHeight === height + 40, 'The height of the minimap wasn\'t saved: ' + JSON.stringify(saved && saved.state));
				// Double-clicking the bottom edge resets the height
				resize(0);
				resize(0);
				await waitFor('the height of the minimap to be reset', () => minimap.offsetHeight === height);
				return 'All: ' + allBars + ' bars (' + allAxis + '); zoomed in: ' + weekAxis.join(' | ') + '; panned: ' + pannedAxis + '; dragging the box scrolled ' + scrolled + 'px to commit ' + topRow.dataset.id + '; height ' + height + ' -> ' + (height + 40) + 'px';
			} finally {
				view.style.bottom = '';
			}
		});

		await check('ui-refs-column', '[Redesign] The Branches / Tags column can be resized (remembered for each repository, double-clicking its edge resets it), and the labels that don\'t fit are truncated', async () => {
			const handle = document.getElementById('refsColResize'), header = handle.parentElement, tagsCell = () => commitRow(5).querySelector('td.refsCol');
			const graphAligned = () => Math.abs(document.querySelector('#commitGraph').getBoundingClientRect().left - document.getElementById('tableHeaderGraphCol').getBoundingClientRect().left) < 1;
			const drag = (dx) => {
				const start = mouse(handle, 'mousedown', { button: 0 }), capture = document.getElementById('eventCaptureElem');
				if (dx !== 0) capture.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: start.clientX + dx, clientY: start.clientY }));
				capture.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: start.clientX + dx, clientY: start.clientY }));
			};
			const width = Math.round(header.getBoundingClientRect().width);
			assert(width === 172 && tagsCell().title !== '', 'Unexpected initial column: ' + width + 'px, "' + tagsCell().title + '"');

			// Widening the column moves the graph with it, and the labels then fit
			drag(160);
			await waitFor('the column to be wider', () => Math.round(header.getBoundingClientRect().width) === width + 160);
			const saved = requestsOf('setRepoState').slice(-1)[0];
			assert(saved.state.refsColumnWidth === width + 160 && graphAligned(), 'The width wasn\'t saved, or the graph didn\'t move: ' + saved.state.refsColumnWidth);
			assert(!tagsCell().hasAttribute('title') && !tagsCell().querySelector('.refsColLabels').classList.contains('overflowing'), 'The labels should fit: "' + tagsCell().title + '"');

			// Narrowing the column truncates the labels: the first label keeps most of the width, and the others fade out at the edge
			drag(-212);
			await waitFor('the column to be narrower', () => Math.round(header.getBoundingClientRect().width) === width - 52);
			const labels = tagsCell().querySelector('.refsColLabels'), first = labels.querySelector('.gitRef').getBoundingClientRect().width;
			assert(tagsCell().title === 'v1.0.0\nv1.0.0-rc.2\nv1.0.0-rc.1' && labels.classList.contains('overflowing') && first >= labels.clientWidth * 0.6 - 1 && graphAligned(), 'Unexpected truncated labels: "' + tagsCell().title + '", first label ' + first + ' of ' + labels.clientWidth + 'px');

			// Double-clicking the edge resets the width
			drag(0);
			drag(0);
			await waitFor('the width to be reset', () => Math.round(header.getBoundingClientRect().width) === width);
			assert(requestsOf('setRepoState').slice(-1)[0].state.refsColumnWidth === width && graphAligned(), 'The width wasn\'t reset');
			return 'Width ' + width + ' -> ' + (width + 160) + ' -> ' + (width - 52) + ' (first label ' + Math.round(first) + ' of ' + labels.clientWidth + 'px) -> ' + width + 'px';
		});

		await check('ui-frozen-panes', '[Redesign] The column headers & the footer stay visible while scrolling through the commits (both can be unfrozen)', async () => {
			const view = document.getElementById('view'), headers = document.getElementById('tableColHeaders'), footer = document.getElementById('footer');
			assert(document.body.classList.contains('freezeColumnHeaders') && document.body.classList.contains('freezeFooter') && getComputedStyle(headers.querySelector('th')).position === 'sticky', 'The column headers & footer aren\'t frozen');
			view.style.bottom = Math.max(window.innerHeight - 460, 0) + 'px';
			try {
				view.scrollTop = 160;
				await waitFor('the view to scroll', () => view.scrollTop === 160);
				await sleep(150);
				// (The cells of the column headers are sticky, not their row)
				const controlsBottom = document.getElementById('controls').getBoundingClientRect().bottom, headersRect = headers.querySelector('th').getBoundingClientRect();
				assert(Array.from(headers.children).every((th) => Math.abs(th.getBoundingClientRect().top - controlsBottom) < 1.5), 'The column headers aren\'t below the controls: ' + headersRect.top + ' / ' + controlsBottom);
				assert(Math.abs(footer.getBoundingClientRect().bottom - view.getBoundingClientRect().bottom) < 1.5 && view.scrollHeight - view.clientHeight > 160, 'The footer isn\'t at the bottom of the view: ' + footer.getBoundingClientRect().bottom + ' / ' + view.getBoundingClientRect().bottom);
				// The column headers & footer are drawn above the commits (and the graph)
				const headersHit = document.elementFromPoint(headersRect.left + 300, headersRect.top + headersRect.height / 2), footerHit = document.elementFromPoint(footer.getBoundingClientRect().left + 300, footer.getBoundingClientRect().bottom - 10);
				assert(headers.contains(headersHit) && footer.contains(footerHit), 'The column headers or footer are covered: ' + (headersHit && headersHit.outerHTML.substring(0, 60)) + ' / ' + (footerHit && footerHit.outerHTML.substring(0, 60)));
				// The commits in view (on the minimap) are the commits between the column headers & the footer
				const box = document.getElementById('minimapViewport').title;
				const visible = Array.from(document.querySelectorAll('#commitTable tr.commit')).filter((row) => row.getBoundingClientRect().top < footer.getBoundingClientRect().top && row.getBoundingClientRect().bottom > headersRect.bottom).length;
				assert(box.includes('(' + visible + ' commits)'), 'Unexpected box of the commits in view: ' + box + ' (' + visible + ' commits are visible)');
			} finally {
				view.style.bottom = '';
				view.scrollTop = 0;
			}
			// Both can be unfrozen from the column menu
			const updates = () => requestsOf('updateExtensionSetting').map((msg) => msg.key + '=' + msg.value), before = updates().length;
			for (const title of ['Freeze Column Headers', 'Freeze Footer']) {
				mouse(document.getElementById('columnSettingsBtn'), 'click');
				const item = Array.from((await waitFor('the column menu', () => document.querySelector('.contextMenu'))).querySelectorAll('.contextMenuItem')).find((elem) => elem.textContent === title);
				assert(item && item.querySelector('svg') !== null, 'The "' + title + '" item isn\'t checked');
				mouse(item, 'click');
			}
			const sent = await waitFor('the settings to be sent', () => updates().length >= before + 2 ? updates().slice(before) : null);
			assert(JSON.stringify(sent) === JSON.stringify(['graph.freezeColumnHeaders=false', 'graph.freezeFooter=false']), 'Unexpected updates: ' + JSON.stringify(sent));
			return 'Frozen below the controls & at the bottom of the view; sent: ' + sent.join(', ');
		});

		// Open the "Create Branch" dialog from the context menu of a commit
		mouse(commitRow(1), 'contextmenu', { button: 2 });
		const createBranchItem = await waitFor('the "Create Branch..." action', () => Array.from(document.querySelectorAll('.contextMenu .contextMenuItem')).find((elem) => elem.textContent.startsWith('Create Branch')));
		mouse(createBranchItem, 'click');
		const dialogElem = await waitFor('the dialog to open', () => document.querySelector('.dialog'));

		await check('#856', 'Pasting a branch name with the mouse enables the "Create Branch" button', async () => {
			assert(dialogElem.classList.contains('noInput'), 'The dialog should initially indicate that no name was entered');
			const input = document.getElementById('dialogInput0');
			input.value = 'feature/pasted-with-the-mouse';
			input.dispatchEvent(new Event('input', { bubbles: true })); // Pasting with the context menu triggers an input event (no key events)
			assert(!dialogElem.classList.contains('noInput'), 'The "Create Branch" button is still disabled');
		});

		await check('#652', 'The dialog buttons can be focused with Tab (after the inputs), and activated with Enter', async () => {
			const inputTabIndexes = Array.from(dialogElem.querySelectorAll('input, .customSelectCurrent')).map((elem) => elem.tabIndex);
			const actionButton = document.getElementById('dialogAction'), cancelButton = document.getElementById('dialogSecondaryAction');
			// The buttons are in the order they're shown: Cancel, then the action
			assert(cancelButton.tabIndex > Math.max.apply(null, inputTabIndexes) && actionButton.tabIndex > cancelButton.tabIndex, 'Unexpected tab order: inputs ' + JSON.stringify(inputTabIndexes) + ', buttons ' + cancelButton.tabIndex + ', ' + actionButton.tabIndex);
			cancelButton.focus();
			assert(document.activeElement === cancelButton, 'The Cancel button can\'t be focused');
			key(cancelButton, 'Enter');
			await waitFor('the dialog to close', () => document.querySelector('.dialog') === null);
			assert(requestsOf('createBranch').length === 0, 'Enter on the Cancel button created the branch');
			return 'Tab order: inputs ' + inputTabIndexes.join(', ') + ' → buttons ' + cancelButton.tabIndex + ', ' + actionButton.tabIndex;
		});

		await check('ui-components', '[Redesign] Dialogs show the commit they are for, labels above inputs & the buttons on the right; context menus show keyboard shortcuts (Ctrl/Cmd+C copies the commit hash); the Authors dropdown shows initials, checkboxes & counts', async () => {
			// The Create Branch dialog of a commit
			mouse(commitRow(4), 'contextmenu', { button: 2 });
			const menu = await waitFor('the context menu', () => document.querySelector('.contextMenu'));
			const copyItem = Array.from(menu.querySelectorAll('.contextMenuItem')).find((item) => item.textContent.startsWith('Copy Commit Hash to Clipboard'));
			const shortcut = copyItem.querySelector('.contextMenuItemShortcut').textContent;
			assert(shortcut === '\u2318C' || shortcut === 'Ctrl+C', 'Unexpected shortcut: ' + shortcut);
			const copies = requestsOf('copyToClipboard').length;
			key(document.body, 'c', { ctrlKey: true });
			await waitFor('the commit hash to be copied', () => requestsOf('copyToClipboard').length > copies && document.querySelector('.contextMenu') === null);
			assert(requestsOf('copyToClipboard').pop().data === hash(5), 'The hash of the commit wasn\'t copied');
			mouse(commitRow(4), 'contextmenu', { button: 2 });
			mouse(Array.from((await waitFor('the context menu', () => document.querySelector('.contextMenu'))).querySelectorAll('.contextMenuItem')).find((item) => item.textContent === 'Create Branch\u2026'), 'click');
			const dialog = await waitFor('the Create Branch dialog', () => document.querySelector('.dialog'));
			const subtitle = dialog.querySelector('.dialogSubtitle').textContent;
			assert(dialog.querySelector('.dialogMessage').textContent.includes('Create branch at commit') && subtitle === 'Commit ' + hash(5).substring(0, 8) + ' \u00b7 ' + commitRow(4).querySelector('.description .text').textContent, 'Unexpected title / subtitle: ' + subtitle);
			const labels = Array.from(dialog.querySelectorAll('.dialogFormLabel')).map((elem) => elem.textContent), checkbox = dialog.querySelector('.dialogFormCheckbox label').textContent;
			assert(JSON.stringify(labels) === JSON.stringify(['Name']) && checkbox === 'Check out', 'Unexpected labels: ' + JSON.stringify(labels) + ', ' + checkbox);
			const buttons = Array.from(dialog.querySelectorAll('.dialogButtons .roundedBtn')).map((elem) => elem.id);
			const actionBounds = document.getElementById('dialogAction').getBoundingClientRect(), contentBounds = dialog.querySelector('.dialogContent').getBoundingClientRect();
			assert(JSON.stringify(buttons) === JSON.stringify(['dialogSecondaryAction', 'dialogAction']) && contentBounds.right - actionBounds.right < 30, 'The buttons aren\'t on the right: ' + JSON.stringify(buttons));
			const defaultColour = getComputedStyle(document.getElementById('dialogAction')).backgroundColor;
			assert(!dialog.classList.contains('danger'), 'The Create Branch dialog is shown as dangerous');
			key(document.body, 'Escape');
			await waitFor('the dialog to close', () => document.querySelector('.dialog') === null);

			// A dialog confirming an action that can discard work shows its primary action as dangerous
			mouse(commitRow(4), 'contextmenu', { button: 2 });
			mouse(Array.from((await waitFor('the context menu', () => document.querySelector('.contextMenu'))).querySelectorAll('.contextMenuItem')).find((item) => item.textContent === 'Reset current branch to this Commit\u2026'), 'click');
			const dangerDialog = await waitFor('the Reset dialog', () => document.querySelector('.dialog'));
			const dangerColour = getComputedStyle(document.getElementById('dialogAction')).backgroundColor;
			assert(dangerDialog.classList.contains('danger') && dangerColour !== defaultColour && dangerColour !== 'rgba(0, 0, 0, 0)', 'The Reset dialog isn\'t shown as dangerous: ' + dangerDialog.className + ', ' + dangerColour + ' (default: ' + defaultColour + ')');
			key(document.body, 'Escape');
			await waitFor('the dialog to close', () => document.querySelector('.dialog') === null);

			// The Authors dropdown
			const dropdown = document.getElementById('authorDropdown');
			mouse(dropdown.querySelector('.dropdownCurrentValue'), 'click');
			const options = await waitFor('the author options', () => {
				const elems = Array.from(dropdown.querySelectorAll('.dropdownOption'));
				return elems.length > 1 ? elems : null;
			});
			const loaded = makeCommits(document.querySelectorAll('#commitTable tr.commit').length);
			const authors = options.slice(1).map((option) => option.textContent + ':' + option.querySelector('.authorInitial').dataset.initial + ':' + option.querySelector('.dropdownOptionCount').dataset.count);
			const expected = ['E2E Author', 'Second Author'].map((name) => name + ':' + name.charAt(0) + ':' + loaded.filter((commit) => commit.author === name).length);
			assert(JSON.stringify(authors) === JSON.stringify(expected), 'Unexpected authors: ' + JSON.stringify(authors) + ' (expected ' + JSON.stringify(expected) + ')');
			assert(options.every((option) => option.querySelector('.dropdownOptionCheckbox') !== null) && options[0].querySelector('.dropdownOptionCheckbox.checked') !== null, 'The options don\'t have checkboxes');
			key(document.body, 'Escape');
			await waitFor('the dropdown to close', () => !dropdown.classList.contains('dropdownOpen'));
			return 'Shortcut: ' + shortcut + '; subtitle: ' + subtitle + '; authors: ' + authors.join(', ');
		});

		await check('#707', 'Adding Issue Linking prefills the Issue URL of the repository\'s GitHub remote (not an example URL)', async () => {
			if (document.querySelector('.dialog') !== null) {
				key(document.body, 'Escape'); // Close any dialog left open by a previous (failed) check
				await waitFor('the dialog to close', () => document.querySelector('.dialog') === null);
			}
			const loadedCommits = document.querySelectorAll('#commitTable tr.commit').length;
			mouse(document.getElementById('settingsBtn'), 'click');
			mouse(await waitFor('the "Remove" Issue Linking button', () => document.getElementById('removeIssueLinking')), 'click');
			mouse(await waitFor('the confirmation', () => document.getElementById('dialogAction')), 'click');
			// Removing the Issue Linking hard refreshes the view, wait for the commits to be reloaded (they're used to detect the Issue Regex)
			await waitFor('the commits to be reloaded', () => document.querySelectorAll('#commitTable tr.commit').length === loadedCommits);
			const addButton = await waitFor('the "Add Issue Linking" button', () => {
				const elem = document.getElementById('editIssueLinking');
				return elem !== null && elem.classList.contains('addBtn') ? elem : null;
			});
			mouse(addButton, 'click');
			const issueUrlInput = await waitFor('the Issue Linking dialog', () => document.getElementById('dialogInput1'));
			const issueRegex = document.getElementById('dialogInput0').value;
			assert(issueRegex === '#(\\d+)', 'Unexpected Issue Regex: ' + issueRegex);
			assert(issueUrlInput.value === 'https://github.com/e2e-owner/e2e-repo/issues/$1', 'Unexpected Issue URL: ' + issueUrlInput.value);
			assert(!document.querySelector('.dialog').textContent.includes('mhutchie'), 'The dialog still refers to the original author\'s repository');
			key(document.body, 'Escape');
			return 'Prefilled: ' + issueRegex + ' → ' + issueUrlInput.value;
		});

		await check('#171', 'Commits can be filtered by selecting authors in the Authors dropdown', async () => {
			if (document.querySelector('.dialog') !== null) {
				key(document.body, 'Escape');
				await waitFor('the dialog to close', () => document.querySelector('.dialog') === null);
			}
			assert(requestsOf('loadCommits').every((msg) => msg.authors === null), 'Commits were filtered by author before an author was selected');
			const dropdown = document.getElementById('authorDropdown');
			const findOption = (name) => Array.from(dropdown.querySelectorAll('.dropdownOption')).find((elem) => elem.textContent.trim() === name);
			mouse(dropdown.querySelector('.dropdownCurrentValue'), 'click');
			const options = await waitFor('the author options', () => findOption('Second Author') && findOption('E2E Author') ? Array.from(dropdown.querySelectorAll('.dropdownOption')).map((elem) => elem.textContent.trim()) : null);

			const loads = requestsOf('loadCommits').length;
			mouse(findOption('Second Author'), 'click');
			const filtered = await waitFor('the commits of the selected author to be requested', () => requestsOf('loadCommits').slice(loads).find((msg) => msg.authors !== null));
			assert(JSON.stringify(filtered.authors) === '["Second Author"]', 'Unexpected authors: ' + JSON.stringify(filtered.authors));

			mouse(findOption('Show All'), 'click');
			await waitFor('the commits of all authors to be requested', () => requestsOf('loadCommits').slice(-1)[0].authors === null);
			key(document.body, 'Escape');
			return 'Options: ' + options.join(', ') + ' → requested authors ' + JSON.stringify(filtered.authors);
		});

		await check('ui-file-history', '[Redesign] The history of a file (opened by the extension) shows the commits that change it, how they change it, its renames, and its changes in a commit (with a diff)', async () => {
			const rows = () => document.querySelectorAll('#commitTable tr.commit');
			window.dispatchEvent(new MessageEvent('message', { data: { command: 'loadRepos', repos: initialState.repos, lastActiveRepo: REPO, loadViewTo: { repo: REPO, fileHistory: 'src/new-name.ts' } } }));
			await waitFor('the history of the file to be loaded', () => requestsOf('loadCommits').slice(-1)[0].filePath === 'src/new-name.ts' && rows().length === 5);
			const bar = document.getElementById('fileHistoryBar');
			assert(bar.classList.contains('active') && bar.textContent.includes('File History') && bar.textContent.includes('src/new-name.ts') && bar.textContent.includes('5 commits') && bar.textContent.includes('followed 1 rename'), 'Unexpected File History bar: ' + bar.textContent);
			assert(document.querySelector('#tableColHeaders .fileChangesCol').textContent === 'Changes to this File', 'The Changes to this File column is missing');
			const changes = Array.from(rows()).map((row) => row.querySelector('td.fileChangesCol').textContent);
			assert(JSON.stringify(changes) === JSON.stringify(['+1\u22120', '+2\u22121', '+3\u22122', '+4\u22123', '+5\u22124']), 'Unexpected changes: ' + JSON.stringify(changes));
			assert(rows()[4].querySelector('.fileHistoryRenamed').textContent.includes('Renamed from src/old-name.ts'), 'The rename isn\'t shown');
			const columns = new Set(Array.from(document.querySelectorAll('#commitGraph svg circle')).map((circle) => circle.getAttribute('cx')));
			assert(columns.size === 1, 'The graph of the history isn\'t connected');

			// Only the history on the current branch can be shown (which is also selected in the Branches dropdown)
			mouse(document.querySelector('.fileHistoryBranchesOption[data-value="current"]'), 'click');
			await waitFor('the history on the current branch to be loaded', () => JSON.stringify(requestsOf('loadCommits').slice(-1)[0].branches) === JSON.stringify(['main']) && requestsOf('loadCommits').slice(-1)[0].filePath === 'src/new-name.ts' && rows().length === 5);
			const branchValue = document.querySelector('#branchDropdown .dropdownValue').textContent;
			assert(branchValue === 'main' && document.querySelector('.fileHistoryBranchesOption[data-value="current"]').classList.contains('active'), 'The current branch isn\'t selected: ' + branchValue);
			mouse(document.querySelector('.fileHistoryBranchesOption[data-value="all"]'), 'click');
			await waitFor('the history on all branches to be loaded', () => requestsOf('loadCommits').slice(-1)[0].branches === null && rows().length === 5);

			mouse(rows()[1], 'click');
			await waitFor('the changes to the file in the commit', () => document.getElementById('cdvFileFocus') && document.querySelector('#cdvFileDiff .cdvFileDiffLine'));
			assert(document.querySelector('#cdvHeader .cdvHeaderTitle').textContent === 'Changes to this File in the Commit', 'Unexpected title: ' + document.querySelector('#cdvHeader .cdvHeaderTitle').textContent);
			const diffRequest = requestsOf('loadFileDiff').pop();
			assert(diffRequest.commitHash === hash(6) && diffRequest.oldFilePath === 'src/old-name.ts' && diffRequest.newFilePath === 'src/new-name.ts' && diffRequest.parentHash === hash(2), 'Unexpected diff request: ' + JSON.stringify(diffRequest));
			const lines = Array.from(document.querySelectorAll('#cdvFileDiff .cdvFileDiffLine')).map((line) => line.className.split(' ')[1] + ':' + line.lastElementChild.textContent);
			assert(JSON.stringify(lines) === JSON.stringify(['context:line 1', 'del:line <2>', 'add:line <two>', 'context:line 3']), 'Unexpected diff: ' + JSON.stringify(lines));
			mouse(document.getElementById('cdvFileFocusDiff'), 'click');
			const viewDiff = await waitFor('the diff to be opened', () => requestsOf('viewDiff').pop());
			assert(viewDiff.newFilePath === 'src/new-name.ts' && viewDiff.oldFilePath === 'src/old-name.ts', 'Unexpected diff opened: ' + JSON.stringify(viewDiff));
			mouse(document.getElementById('cdvFileFocusAll'), 'click');
			await waitFor('the whole commit to be shown', () => document.getElementById('cdvFileFocus') === null && document.querySelector('#cdvHeader .cdvHeaderTitle').textContent === 'Commit Details');
			mouse(document.getElementById('cdvClose'), 'click');
			await waitFor('the Commit Details View to close', () => document.getElementById('cdv') === null);

			mouse(document.getElementById('fileHistoryExit'), 'click');
			await waitFor('all of the commits to be loaded', () => requestsOf('loadCommits').slice(-1)[0].filePath === null && rows().length === 10 && !bar.classList.contains('active') && document.querySelector('#tableColHeaders .fileChangesCol') === null);
			return changes.length + ' commits: ' + changes.join(', ') + '; diff: ' + lines.length + ' lines';
		});

		await check('ui-graph-fit', '[Redesign] When the lanes of the graph don\'t fit in the Graph column, they\'re moved closer together (so the commits aren\'t cut off)', async () => {
			window.dispatchEvent(new MessageEvent('message', { data: { command: 'loadRepos', repos: initialState.repos, lastActiveRepo: REPO, loadViewTo: { repo: REPO, fileHistory: 'e2e-wide.txt' } } }));
			await waitFor('the wide graph to be loaded', () => document.querySelectorAll('#commitTable tr.commit').length === 41 && document.querySelectorAll('#commitGraph svg circle').length === 41);
			const svg = document.querySelector('#commitGraph svg'), circles = Array.from(svg.querySelectorAll('circle')).map((circle) => parseFloat(circle.getAttribute('cx')));
			const lanes = Array.from(new Set(circles)).sort((a, b) => a - b), spacing = lanes[1] - lanes[0], width = parseFloat(svg.getAttribute('width'));
			assert(lanes.length === 40 && spacing < 16, 'The lanes weren\'t moved closer together: ' + lanes.length + ' lanes, ' + spacing + 'px apart');
			assert(spacing === 8 || Math.max.apply(null, circles) + 4 <= width, 'A commit is cut off: ' + Math.max.apply(null, circles) + ' of ' + width + 'px');
			mouse(document.getElementById('fileHistoryExit'), 'click');
			await waitFor('all of the commits to be loaded', () => requestsOf('loadCommits').slice(-1)[0].filePath === null && document.querySelectorAll('#commitTable tr.commit').length === 10);
			return lanes.length + ' lanes, ' + spacing + 'px apart, in a ' + width + 'px wide graph (natural width ' + (32 + 39 * 16) + 'px)';
		});

		await check('ui-settings-panel', '[Redesign] The Repository Settings panel changes the colour preset, line style, language & Status Bar Item for all repositories', async () => {
			if (document.querySelector('.dialog') !== null) {
				key(document.body, 'Escape');
				await waitFor('the dialog to close', () => document.querySelector('.dialog') === null);
			}
			if (!document.getElementById('settingsWidget').classList.contains('active')) mouse(document.getElementById('settingsBtn'), 'click');
			const widget = await waitFor('the Repository Settings panel to load', () => document.querySelector('#settingsWidget.active .settingsPreset') ? document.getElementById('settingsWidget') : null);
			// The panel slides in from the right
			await waitFor('the panel to be docked to the right', () => {
				const bounds = widget.getBoundingClientRect();
				return Math.round(bounds.right) === window.innerWidth && Math.round(bounds.top) === 0 && Math.round(bounds.bottom) === window.innerHeight;
			}).catch((err) => {
				throw new Error(err.message + ': ' + JSON.stringify(widget.getBoundingClientRect()) + ' in ' + window.innerWidth + 'x' + window.innerHeight);
			});
			const presets = Array.from(widget.querySelectorAll('.settingsPreset')), selected = presets.filter((elem) => elem.classList.contains('selected'));
			assert(presets.length === 6 && selected.length === 1, 'Unexpected colour presets: ' + presets.length + ' (' + selected.length + ' selected)');
			const updates = () => requestsOf('updateExtensionSetting').map((msg) => msg.key + '=' + msg.value);
			const before = updates().length;
			mouse(presets.find((elem) => elem.dataset.preset === 'Tokyo Subway'), 'click');
			mouse(widget.querySelector('.settingsSegmented[data-setting="graph.style"] .settingsSegment[data-value="angular"]'), 'click');
			mouse(widget.querySelector('.settingsSegmented[data-setting="statusBarItemDisplay"] .settingsSegment[data-value="Icon"]'), 'click');
			mouse(widget.querySelector('.settingsSegmented[data-setting="graph.density"] .settingsSegment[data-value="Compact"]'), 'click');
			mouse(widget.querySelector('.settingsSegmented[data-setting="graph.nodeStyle"] .settingsSegment[data-value="Avatar"]'), 'click');
			mouse(widget.querySelector('.settingsSegmented[data-setting="graph.freezeColumnHeaders"] .settingsSegment[data-value="false"]'), 'click');
			mouse(widget.querySelector('.settingsSegmented[data-setting="graph.freezeFooter"] .settingsSegment[data-value="false"]'), 'click');
			const english = Array.from(widget.querySelectorAll('input[name="settingsLanguage"]')).find((elem) => elem.value === 'English');
			english.checked = true;
			english.dispatchEvent(new Event('change', { bubbles: true }));
			const sent = await waitFor('the settings to be sent to the extension', () => updates().length >= before + 8 ? updates().slice(before) : null);
			assert(JSON.stringify(sent) === JSON.stringify(['graph.colourPreset=Tokyo Subway', 'graph.style=angular', 'statusBarItemDisplay=Icon', 'graph.density=Compact', 'graph.nodeStyle=Avatar', 'graph.freezeColumnHeaders=false', 'graph.freezeFooter=false', 'language=English']), 'Unexpected updates: ' + JSON.stringify(sent));
			assert(typeof requestsOf('updateExtensionSetting').find((msg) => msg.key === 'graph.freezeFooter').value === 'boolean', 'The freeze settings should be sent as booleans');
			assert(document.querySelector('.settingsStatusBarPreview svg') !== null && !document.querySelector('.settingsStatusBarPreview').textContent.includes('Git Map'), 'The Status Bar Item preview wasn\'t updated');
			mouse(document.getElementById('settingsClose'), 'click');
			await waitFor('the panel to close', () => !document.getElementById('settingsWidget').classList.contains('active'));
			return 'Sent: ' + sent.join(', ');
		});

		await check('ui-find-operators', '[GitLens] The Find Widget supports the author:, message: & commit: search operators, shown alongside the scrollbar', async () => {
			await waitFor('the commits to be reloaded', () => document.querySelectorAll('#commitTable tr.commit').length > 0 && requestsOf('loadCommits').slice(-1)[0].authors === null);
			const loaded = document.querySelectorAll('#commitTable tr.commit').length, fixture = makeCommits(loaded);
			const find = async (text) => {
				const input = document.getElementById('findInput');
				input.value = text;
				input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'a' }));
				const expected = text === '' ? '' : null;
				return waitFor('the matches of ' + text, () => {
					const position = document.getElementById('findPosition').textContent;
					return position !== '' && document.getElementById('findInput').value === text && !document.querySelector('.findWidget').hasAttribute('data-error') ? position : expected;
				});
			};
			document.getElementById('findBtn').dispatchEvent(new MouseEvent('click', { bubbles: true }));
			await waitFor('the Find Widget to open', () => document.querySelector('.findWidget').classList.contains('active'));
			const results = {};
			const expect = async (text, count) => {
				const position = await find(text);
				await sleep(300);
				const actual = document.getElementById('findPosition').textContent;
				assert(actual === (count > 0 ? '1 of ' + count : 'No Results'), 'Unexpected matches of ' + text + ': ' + actual + ' (expected ' + count + ')');
				results[text] = actual;
			};
			await expect('author:"Second Author" Commit', fixture.filter((c) => c.author === 'Second Author' && c.message.includes('Commit')).length);
			await expect('@:second', fixture.filter((c) => c.author === 'Second Author').length);
			await expect('message:Resolve =:#10', fixture.filter((c) => c.message.includes('Resolve') && c.message.includes('#10')).length);
			await expect('commit:' + hash(5), 1);
			const view = document.getElementById('view'), markers = document.querySelectorAll('#scrollMarkers .scrollMarker.findMatch').length;
			assert(view.scrollHeight <= view.clientHeight || markers === 1, 'The find match isn\'t shown alongside the scrollbar: ' + markers + ' markers');
			// The find match is also marked below its day on the minimap (and its legend explains it)
			const minimapMatches = () => Array.from(document.querySelectorAll('#minimap .minimapFindMatch'));
			const legend = () => Array.from(document.querySelectorAll('.minimapLegend > span')).map((elem) => elem.textContent);
			await waitFor('the find match to be marked on the minimap', () => minimapMatches().length === 1 && minimapMatches()[0].title.endsWith(': 1 matching commit') && legend().includes('Find Matches'))
				.catch((err) => { throw new Error(err.message + ': ' + minimapMatches().map((elem) => elem.title).join(', ') + ' / ' + legend().join(', ')); });
			const minimapMatch = minimapMatches()[0].title;
			mouse(document.getElementById('findClose'), 'click');
			await waitFor('the Find Widget to close', () => !document.querySelector('.findWidget').classList.contains('active'));
			await waitFor('the find match to be removed from the minimap', () => minimapMatches().length === 0 && legend().length === 4);
			return JSON.stringify(results) + (view.scrollHeight > view.clientHeight ? ', scrollbar markers shown' : ', the view isn\'t scrollable (no scrollbar markers)') + ', minimap: ' + minimapMatch;
		});

		await check('ui-find-dates', '[GitLens] The after: & before: search operators find the commits in a range of dates (which can also be searched for from the zoomed in minimap)', async () => {
			// The history of a file with a commit each day is loaded
			window.dispatchEvent(new MessageEvent('message', { data: { command: 'loadRepos', repos: initialState.repos, lastActiveRepo: REPO, loadViewTo: { repo: REPO, fileHistory: 'e2e-dates.txt' } } }));
			await waitFor('the daily commits to be loaded', () => requestsOf('loadCommits').slice(-1)[0].filePath === 'e2e-dates.txt' && document.querySelectorAll('#commitTable tr.commit').length === 20);
			const fixture = makeCommits(20).map((commit, i) => Object.assign(commit, { date: NOW - i * 86400 }));
			const startOfDay = (daysAgo) => {
				const date = new Date();
				date.setHours(0, 0, 0, 0);
				date.setDate(date.getDate() - daysAgo);
				return date.getTime() / 1000;
			};
			const count = (from, to) => fixture.filter((commit) => commit.date >= from && commit.date < to).length;
			// The number of matches (the current match can be any of them)
			const expected = (n) => n > 0 ? 'of ' + n : 'No Results';
			const matches = (text) => text === 'No Results' ? text : text.replace(/^\d+ /, '');
			const input = document.getElementById('findInput'), widget = document.querySelector('.findWidget'), position = () => document.getElementById('findPosition').textContent;
			const search = async (text) => {
				input.value = text;
				input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'a' }));
				await sleep(500);
				return widget.hasAttribute('data-error') ? 'Error: ' + widget.getAttribute('data-error') : position();
			};
			document.getElementById('findBtn').dispatchEvent(new MouseEvent('click', { bubbles: true }));
			await waitFor('the Find Widget to open', () => widget.classList.contains('active'));
			const results = {};
			const day = (daysAgo) => {
				const date = new Date(startOfDay(daysAgo) * 1000), pad = (value) => (value < 10 ? '0' : '') + value;
				return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
			};
			for (const [text, from, to] of [['after:today', startOfDay(0), Infinity], ['before:today', -Infinity, startOfDay(0)], ['>:yesterday <:today', startOfDay(1), startOfDay(0)], ['after:1w', startOfDay(7), Infinity], ['after:' + day(12) + ' before:' + day(5), startOfDay(12), startOfDay(5)]]) {
				results[text] = await search(text);
				assert(matches(results[text]) === expected(count(from, to)), 'Unexpected matches of ' + text + ': ' + results[text] + ' (expected ' + expected(count(from, to)) + ')');
			}
			assert(matches(results['after:1w']) === 'of 8' && matches(results['before:today']) === 'of 19', 'Unexpected matches: ' + JSON.stringify(results));
			const invalid = await search('after:2026-02-30');
			assert(invalid.startsWith('Error: ') && invalid.includes('"2026-02-30" isn\'t a date'), 'An invalid date wasn\'t reported: ' + invalid);
			mouse(document.getElementById('findClose'), 'click');
			await waitFor('the Find Widget to close', () => !widget.classList.contains('active'));

			// The range of dates that the minimap is zoomed in on can be searched for
			const minimap = document.getElementById('minimap'), zoomBtn = (zoom) => minimap.querySelector('.minimapZoomBtn[data-zoom="' + zoom + '"]');
			assert(zoomBtn('search').classList.contains('disabled'), 'The minimap can only search the range of dates it\'s zoomed in on');
			mouse(zoomBtn('in'), 'click');
			await waitFor('the minimap to zoom in', () => !zoomBtn('search').classList.contains('disabled'));
			mouse(zoomBtn('search'), 'click');
			const chips = await waitFor('the range to be searched for', () => {
				const values = Array.from(document.querySelectorAll('#findChips .findChip')).map((chip) => chip.textContent);
				return values.length === 2 ? values : null;
			});
			const [, after] = chips[0].match(/^after:(\d{4}-\d{2}-\d{2})$/) || [], [, before] = chips[1].match(/^before:(\d{4}-\d{2}-\d{2})$/) || [];
			assert(after && before, 'Unexpected chips: ' + JSON.stringify(chips));
			assert(input.placeholder === 'Add a condition…', 'Unexpected placeholder: ' + input.placeholder);
			const parse = (day) => new Date(parseInt(day.substring(0, 4)), parseInt(day.substring(5, 7)) - 1, parseInt(day.substring(8, 10))).getTime() / 1000;
			await waitFor('the commits in the range to be found', () => matches(position()) === expected(count(parse(after), parse(before))))
				.catch((err) => { throw new Error(err.message + ': ' + position() + ' (expected ' + expected(count(parse(after), parse(before))) + ')'); });
			const rangeResult = position();
			mouse(document.getElementById('findClose'), 'click');
			await waitFor('the Find Widget to close', () => !widget.classList.contains('active'));
			mouse(zoomBtn('all'), 'click');
			await waitFor('all of the loaded commits to be shown', () => zoomBtn('all').classList.contains('disabled'));
			mouse(document.getElementById('fileHistoryExit'), 'click');
			await waitFor('all of the commits to be loaded', () => requestsOf('loadCommits').slice(-1)[0].filePath === null && document.querySelectorAll('#commitTable tr.commit').length === 10);
			return JSON.stringify(results) + '; invalid: ' + invalid + '; minimap range: ' + chips.join(' ') + ' → ' + rangeResult;
		});

		await check('ui-multi-select', '[GitLens] Commits can be selected with Shift (+ Ctrl / Cmd) + click, and cherry picked together (oldest first, merge commits refused), or their hashes copied', async () => {
			window.dispatchEvent(new MessageEvent('message', { data: { command: 'loadRepos', repos: initialState.repos, lastActiveRepo: REPO, loadViewTo: { repo: REPO, fileHistory: 'e2e-dates.txt' } } }));
			await waitFor('the daily commits to be loaded', () => requestsOf('loadCommits').slice(-1)[0].filePath === 'e2e-dates.txt' && document.querySelectorAll('#commitTable tr.commit').length === 20);
			const selected = () => Array.from(document.querySelectorAll('#commitTable tr.commit.multiSelected')).map((row) => parseInt(row.dataset.id));
			const footer = () => document.getElementById('listFooterSelection').textContent;
			const shiftClick = (index, toggle) => mouse(commitRow(index).querySelector('td.descriptionCol'), 'click', Object.assign({ shiftKey: true }, toggle ? ctrl : {}));

			// Shift + click selects the commits from the commit whose details are open
			mouse(commitRow(2).querySelector('td.descriptionCol'), 'click');
			await waitFor('the Commit Details View to open', () => document.getElementById('cdv') !== null);
			shiftClick(5, false);
			assert(JSON.stringify(selected()) === '[2,3,4,5]' && footer().startsWith('4 commits selected'), 'Unexpected selection: ' + JSON.stringify(selected()) + ', "' + footer() + '"');
			// Ctrl / Cmd + Shift + click removes (or adds) a commit
			shiftClick(4, true);
			assert(JSON.stringify(selected()) === '[2,3,5]' && footer().startsWith('3 commits selected'), 'Unexpected selection after removing a commit: ' + JSON.stringify(selected()));

			// The context menu of a selected commit acts on all of the selected commits
			mouse(commitRow(3), 'contextmenu', { button: 2 });
			const menu = await waitFor('the context menu', () => document.querySelector('.contextMenu'));
			const items = Array.from(menu.querySelectorAll('.contextMenuItem')).map((item) => item.textContent);
			assert(JSON.stringify(items) === JSON.stringify(['Cherry Pick 3 Commits…', 'Copy 3 Commit Hashes to Clipboard', 'Copy 3 Commit Subjects to Clipboard', 'Save 3 Commits as Patch…', 'Clear Selection']), 'Unexpected context menu: ' + JSON.stringify(items));
			mouse(Array.from(menu.querySelectorAll('.contextMenuItem')).find((item) => item.textContent.startsWith('Copy 3 Commit Hashes')), 'click');
			const copied = await waitFor('the hashes to be copied', () => requestsOf('copyToClipboard').slice(-1)[0]);
			assert(copied.data === [hash(6), hash(4), hash(3)].join('\n'), 'The hashes weren\'t copied oldest first: ' + JSON.stringify(copied.data));

			// Cherry picking them (from the footer) confirms the commits, which are cherry picked oldest first
			mouse(Array.from(document.querySelectorAll('#listFooterSelection .listFooterAction')).find((elem) => elem.dataset.action === 'cherrypick'), 'click');
			const dialogElem = await waitFor('the dialog to open', () => document.querySelector('.dialog'));
			const dialogText = dialogElem.textContent;
			assert(dialogText.includes('cherry pick these 3 commits') && dialogText.indexOf('Commit 5') < dialogText.indexOf('Commit 3') && dialogText.indexOf('Commit 3') < dialogText.indexOf('Resolve #102'), 'Unexpected dialog: ' + dialogText);
			const before = requestsOf('cherrypickCommits').length;
			mouse(document.getElementById('dialogAction'), 'click');
			const request = await waitFor('the commits to be cherry picked', () => requestsOf('cherrypickCommits').length > before ? requestsOf('cherrypickCommits').slice(-1)[0] : null);
			assert(JSON.stringify(request.commitHashes) === JSON.stringify([hash(6), hash(4), hash(3)]) && request.recordOrigin === false && request.noCommit === false, 'Unexpected request: ' + JSON.stringify(request));
			await waitFor('the selection to be cleared', () => selected().length === 0 && footer() === '');
			if (document.querySelector('.dialog') !== null) key(document.body, 'Escape');

			// A merge commit can't be cherry picked with other commits (the range is selected from the commit whose details are opened)
			mouse(commitRow(7).querySelector('td.descriptionCol'), 'click');
			await waitFor('the details of the commit to open', () => document.querySelector('#commitTable tr.commit.commitDetailsOpen') === commitRow(7));
			shiftClick(9, false);
			assert(JSON.stringify(selected()) === '[7,8,9]', 'Unexpected selection including the merge commit: ' + JSON.stringify(selected()));
			mouse(Array.from(document.querySelectorAll('#listFooterSelection .listFooterAction')).find((elem) => elem.dataset.action === 'cherrypick'), 'click');
			const errorDialog = await waitFor('the error dialog', () => document.querySelector('.dialog'));
			assert(errorDialog.textContent.includes('Merge commits can\'t be cherry picked with other commits') && errorDialog.textContent.includes('(00000000)'), 'Unexpected dialog: ' + errorDialog.textContent);
			key(document.body, 'Escape');
			await waitFor('the dialog to close', () => document.querySelector('.dialog') === null);

			// Escape, or clicking a commit, clears the selection
			key(document.body, 'Escape');
			assert(selected().length === 0, 'Escape didn\'t clear the selection');
			shiftClick(10, false);
			shiftClick(11, false);
			assert(selected().length > 0, 'The commits weren\'t selected');
			mouse(commitRow(12).querySelector('td.descriptionCol'), 'click');
			assert(selected().length === 0, 'Clicking a commit didn\'t clear the selection');
			mouse(document.getElementById('fileHistoryExit'), 'click');
			await waitFor('all of the commits to be loaded', () => requestsOf('loadCommits').slice(-1)[0].filePath === null && document.querySelectorAll('#commitTable tr.commit').length === 10);
			return 'Copied: ' + copied.data.split('\n').map((h) => h.substring(32)).join(', ') + '; cherry picked: ' + request.commitHashes.map((h) => h.substring(32)).join(', ') + '; merge commit refused';
		});

		await check('ui-row-actions', '[GitLens] Hovering over a commit shows buttons of its most common actions at the end of its row (which run the actions of its context menu)', async () => {
			if (document.getElementById('cdv') !== null) {
				mouse(document.getElementById('cdvClose'), 'click');
				await waitFor('the Commit Details View to close', () => document.getElementById('cdv') === null);
			}
			const row = commitRow(3);
			mouse(row.querySelector('td.descriptionCol .text'), 'mouseover');
			const toolbar = await waitFor('the buttons to be shown', () => row.querySelector('td.descriptionCol #rowActions'));
			const titles = Array.from(toolbar.querySelectorAll('.rowAction')).filter((elem) => elem.style.display !== 'none').map((elem) => elem.title);
			assert(JSON.stringify(titles) === JSON.stringify(['Create Branch…', 'Checkout…', 'Cherry Pick…', 'Copy Commit Hash to Clipboard', 'More Actions…']), 'Unexpected buttons: ' + JSON.stringify(titles));
			const toolbarRect = toolbar.getBoundingClientRect(), cellRect = row.querySelector('td.descriptionCol').getBoundingClientRect();
			assert(Math.abs(toolbarRect.right - cellRect.right) < 1 && toolbarRect.top >= cellRect.top - 1 && toolbarRect.bottom <= cellRect.bottom + 1, 'The buttons aren\'t at the end of the row: ' + JSON.stringify(toolbarRect));
			const button = (action) => toolbar.querySelector('.rowAction[data-action="' + action + '"]');

			// Copying the hash doesn't open the Commit Details View (the click isn't handled by the row)
			const detailsRequests = requestsOf('commitDetails').length;
			mouse(button('copyHash'), 'click');
			const copied = await waitFor('the hash to be copied', () => requestsOf('copyToClipboard').slice(-1)[0]);
			assert(copied.data === hash(4) && document.getElementById('cdv') === null && requestsOf('commitDetails').length === detailsRequests, 'Unexpected copy: ' + JSON.stringify(copied));

			// Create Branch opens the same dialog as the context menu
			mouse(button('createBranch'), 'click');
			const dialogElem = await waitFor('the dialog to open', () => document.querySelector('.dialog'));
			assert(dialogElem.textContent.includes('Create branch at commit') && row.classList.contains('dialogActive'), 'Unexpected dialog: ' + dialogElem.textContent);
			key(document.body, 'Escape');
			await waitFor('the dialog to close', () => document.querySelector('.dialog') === null);

			// More Actions opens the commit's context menu
			mouse(button('more'), 'click');
			const menu = await waitFor('the context menu', () => document.querySelector('.contextMenu'));
			const items = Array.from(menu.querySelectorAll('.contextMenuItem')).map((item) => item.textContent);
			assert(items[0] === 'Add Tag…' && items.includes('Cherry Pick…') && items.includes('Copy Commit Subject to Clipboard'), 'Unexpected context menu: ' + JSON.stringify(items));
			key(document.body, 'Escape');
			await waitFor('the context menu to close', () => document.querySelector('.contextMenu') === null);

			// The buttons follow the mouse, and are hidden when it leaves the commits
			mouse(commitRow(6).querySelector('td.dateCol'), 'mouseover');
			assert(commitRow(6).querySelector('#rowActions') !== null && row.querySelector('#rowActions') === null, 'The buttons didn\'t move to the commit the mouse is over');
			document.getElementById('commitTable').dispatchEvent(new MouseEvent('mouseleave'));
			assert(document.getElementById('rowActions') === null, 'The buttons weren\'t hidden');
			return 'Buttons: ' + titles.join(' | ') + '; copied ' + copied.data.substring(32) + ', opened the Create Branch dialog & the context menu';
		});

		await check('ui-undo', '[GitKraken] After an action that can be undone, an Undo button & a notification are shown, which undo it (after confirming)', async () => {
			const undoBtn = document.getElementById('undoBtn'), toast = document.getElementById('undoToast');
			assert(undoBtn.classList.contains('hidden') && !toast.classList.contains('active'), 'Undo is shown when there\'s nothing to undo');
			undoInfo = { id: 7, description: 'Merge "feature"' };
			mouse(document.getElementById('refreshBtn'), 'click');
			await waitFor('the Undo button to be shown', () => !undoBtn.classList.contains('hidden'));
			assert(undoBtn.title === 'Undo: Merge "feature"' && toast.classList.contains('active') && toast.textContent === 'Merge "feature"Undo', 'Unexpected Undo button / notification: ' + undoBtn.title + ' / ' + toast.textContent);

			// The notification's Undo asks to confirm undoing the action
			mouse(toast.querySelector('.undoToastAction'), 'click');
			const dialogElem = await waitFor('the dialog to open', () => document.querySelector('.dialog'));
			assert(dialogElem.textContent.includes('Are you sure you want to undo Merge "feature"?') && dialogElem.textContent.includes('Uncommitted changes are kept') && !toast.classList.contains('active'), 'Unexpected dialog: ' + dialogElem.textContent);
			const before = requestsOf('undo').length;
			mouse(document.getElementById('dialogAction'), 'click');
			const request = await waitFor('the action to be undone', () => requestsOf('undo').length > before ? requestsOf('undo').slice(-1)[0] : null);
			assert(request.repo === REPO, 'Unexpected request: ' + JSON.stringify(request));
			await waitFor('the Undo button to be hidden', () => undoBtn.classList.contains('hidden'));

			// An action that could already be undone isn't notified again (e.g. when the view is refreshed)
			undoInfo = { id: 7, description: 'Merge "feature"' };
			mouse(document.getElementById('refreshBtn'), 'click');
			await waitFor('the Undo button to be shown', () => !undoBtn.classList.contains('hidden'));
			assert(!toast.classList.contains('active'), 'The same action was notified again');
			undoInfo = null;
			mouse(document.getElementById('refreshBtn'), 'click');
			await waitFor('the Undo button to be hidden', () => undoBtn.classList.contains('hidden'));
			return 'Button: ' + 'Undo: Merge "feature"' + '; notified once; undo requested for ' + request.repo;
		});

		await check('ui-worktrees', '[GitLens] The Worktrees button lists the worktrees (opening, removing & pruning them), branches checked out in other worktrees are marked, and worktrees are created from the context menu', async () => {
			const worktreeBtn = document.getElementById('worktreeBtn');
			assert(worktreeBtn.classList.contains('hidden'), 'The Worktrees button is shown when there\'s only one worktree');
			worktreesFixture = [
				{ path: REPO, head: hash(HEAD_INDEX + 1), branch: 'main', isMain: true, isCurrent: true, locked: false, prunable: false },
				{ path: '/e2e/harness-repo-feature', head: hash(1), branch: 'feature', isMain: false, isCurrent: false, locked: true, prunable: false },
				{ path: '/e2e/harness-repo-old', head: hash(3), branch: null, isMain: false, isCurrent: false, locked: false, prunable: true }
			];
			try {
				mouse(document.getElementById('refreshBtn'), 'click');
				await waitFor('the Worktrees button to be shown', () => !worktreeBtn.classList.contains('hidden') && worktreeBtn.textContent === 'Worktrees3');
				// The branch checked out in another worktree is marked
				const featureLabel = await waitFor('the branch to be marked', () => commitRow(0).querySelector('.gitRef.head.inWorktree'));
				assert(featureLabel.title === 'Checked out in the worktree /e2e/harness-repo-feature' && featureLabel.querySelector('.gitRefWorktree svg') !== null && featureLabel.textContent === 'feature', 'Unexpected marker: ' + featureLabel.title);

				// The list of the worktrees
				const openList = async () => {
					mouse(worktreeBtn, 'click');
					return waitFor('the list of worktrees', () => document.querySelectorAll('#worktreeList .worktreeListItem').length === 3 ? Array.from(document.querySelectorAll('#worktreeList .worktreeListItem')) : null);
				};
				let items = await openList();
				const texts = items.map((item) => item.querySelector('.stashListMeta').textContent);
				assert(texts[0].includes('Current') && texts[0].includes('Main') && texts[1].includes('Locked') && texts[2].includes('Detached HEAD') && texts[2].includes('The folder no longer exists'), 'Unexpected worktrees: ' + JSON.stringify(texts));
				assert(items[0].querySelector('[data-action="remove"]').classList.contains('disabled') && !items[1].querySelector('[data-action="remove"]').classList.contains('disabled'), 'The main worktree can be removed');
				mouse(items[1].querySelector('[data-action="open"]'), 'click');
				const opened = await waitFor('the worktree to be opened', () => requestsOf('openWorktree').slice(-1)[0]);
				assert(opened.path === '/e2e/harness-repo-feature', 'Unexpected request: ' + JSON.stringify(opened));

				// Removing a worktree is confirmed (forcing it is optional)
				items = await openList();
				mouse(items[1].querySelector('[data-action="remove"]'), 'click');
				let dialogElem = await waitFor('the dialog to open', () => document.querySelector('.dialog'));
				assert(dialogElem.textContent.includes('remove the worktree /e2e/harness-repo-feature') && document.getElementById('dialogInput0').checked === false, 'Unexpected dialog: ' + dialogElem.textContent);
				mouse(document.getElementById('dialogAction'), 'click');
				const removed = await waitFor('the worktree to be removed', () => requestsOf('removeWorktree').slice(-1)[0]);
				assert(removed.path === '/e2e/harness-repo-feature' && removed.force === false, 'Unexpected request: ' + JSON.stringify(removed));
				await waitFor('the dialog to close', () => document.querySelector('.dialog') === null || document.querySelector('.dialog.actionRunning') === null);
				if (document.querySelector('.dialog') !== null) key(document.body, 'Escape');

				// Pruning the worktrees whose folders no longer exist
				await openList();
				mouse(document.getElementById('worktreeListPrune'), 'click');
				await waitFor('the dialog to open', () => document.querySelector('.dialog'));
				mouse(document.getElementById('dialogAction'), 'click');
				await waitFor('the worktrees to be pruned', () => requestsOf('pruneWorktrees').length > 0);

				// Creating a worktree at a commit, with a new branch
				await waitFor('the dialog to close', () => document.querySelector('.dialog') === null || !document.querySelector('.dialog').textContent.includes('prune'));
				mouse(commitRow(2), 'contextmenu', { button: 2 });
				const menu = await waitFor('the context menu', () => document.querySelector('.contextMenu'));
				mouse(Array.from(menu.querySelectorAll('.contextMenuItem')).find((item) => item.textContent === 'Create Worktree…'), 'click');
				dialogElem = await waitFor('the dialog to open', () => document.querySelector('.dialog'));
				const folderInput = document.getElementById('dialogInput0'), branchInput = document.getElementById('dialogInput1');
				assert(folderInput.value === '/e2e/harness-repo-00000000' && branchInput.value === '', 'Unexpected default folder: ' + folderInput.value);
				branchInput.value = 'wt-test';
				branchInput.dispatchEvent(new Event('input', { bubbles: true }));
				mouse(document.getElementById('dialogAction'), 'click');
				const added = await waitFor('the worktree to be created', () => requestsOf('addWorktree').slice(-1)[0]);
				assert(added.path === '/e2e/harness-repo-00000000' && added.ref === hash(3) && added.newBranch === 'wt-test' && added.open === true, 'Unexpected request: ' + JSON.stringify(added));

				// A branch that's checked out in another worktree can't be added as a worktree
				await waitFor('the dialog to close', () => document.querySelector('.dialog') === null || document.querySelector('.dialog.actionRunning') === null);
				if (document.querySelector('.dialog') !== null) key(document.body, 'Escape');
				mouse(commitRow(0).querySelector('.gitRef.head'), 'contextmenu', { button: 2 });
				const branchMenu = Array.from((await waitFor('the context menu', () => document.querySelector('.contextMenu'))).querySelectorAll('.contextMenuItem')).map((item) => item.textContent);
				assert(!branchMenu.includes('Create Worktree…'), 'A branch checked out in another worktree can be added as a worktree');
				key(document.body, 'Escape');
				return 'Listed ' + texts.length + ' worktrees; opened ' + opened.path + '; removed ' + removed.path + '; pruned; created ' + added.path + ' (' + added.newBranch + ')';
			} finally {
				worktreesFixture = [];
				mouse(document.getElementById('refreshBtn'), 'click');
				await waitFor('the Worktrees button to be hidden', () => worktreeBtn.classList.contains('hidden') && document.querySelector('.gitRef.inWorktree') === null);
			}
		});

		await check('ui-line-history', '[GitLens] The history of lines (opened by the extension) shows the commits that change them, and how they change them', async () => {
			const rows = () => document.querySelectorAll('#commitTable tr.commit');
			window.dispatchEvent(new MessageEvent('message', { data: { command: 'loadRepos', repos: initialState.repos, lastActiveRepo: REPO, loadViewTo: { repo: REPO, fileHistory: 'src/lines.ts', lineRange: { start: 3, end: 5 } } } }));
			await waitFor('the history of the lines to be loaded', () => rows().length === 3);
			const request = requestsOf('loadCommits').slice(-1)[0];
			assert(request.filePath === 'src/lines.ts' && JSON.stringify(request.lineRange) === '{"start":3,"end":5}', 'Unexpected request: ' + JSON.stringify(request));
			const bar = document.getElementById('fileHistoryBar').textContent, header = document.querySelector('#tableColHeaders .fileChangesCol').textContent;
			const changes = Array.from(rows()).map((row) => row.querySelector('td.fileChangesCol').textContent);
			assert(bar.includes('Line History') && bar.includes('Lines 3–5') && bar.includes('src/lines.ts') && bar.includes('Exit Line History') && header === 'Changes to these Lines', 'Unexpected bar / header: ' + bar + ' / ' + header);
			assert(JSON.stringify(changes) === JSON.stringify(['+1−1', '+2−1', '+3−1']), 'Unexpected changes: ' + JSON.stringify(changes));
			mouse(document.getElementById('fileHistoryExit'), 'click');
			await waitFor('all of the commits to be loaded', () => requestsOf('loadCommits').slice(-1)[0].filePath === null && requestsOf('loadCommits').slice(-1)[0].lineRange === null && rows().length === 10);
			return bar.replace(/\s+/g, ' ').trim() + '; changes: ' + changes.join(', ');
		});

		await check('ui-rebase-editor', '[GitLens] An interactive rebase opens the Rebase Editor (reordering commits by dragging them, and choosing to pick, reword, squash, fixup or drop each one), and an operation in progress can be continued or aborted', async () => {
			// Open the Rebase Editor from the Rebase dialog
			mouse(commitRow(5), 'contextmenu', { button: 2 });
			const menu = await waitFor('the context menu', () => document.querySelector('.contextMenu'));
			mouse(Array.from(menu.querySelectorAll('.contextMenuItem')).find((item) => item.textContent.startsWith('Rebase current branch on this Commit')), 'click');
			await waitFor('the dialog to open', () => document.querySelector('.dialog'));
			const interactive = document.getElementById('dialogInput0');
			interactive.checked = true;
			mouse(document.getElementById('dialogAction'), 'click');
			const editor = await waitFor('the Rebase Editor to load', () => document.querySelectorAll('#rebaseEditor .rebaseEditorItem').length === 4 ? document.getElementById('rebaseEditor') : null);
			assert(requestsOf('loadRebaseCommits').slice(-1)[0].base === hash(6) && editor.textContent.includes('Rebase main on 00000000'), 'Unexpected Rebase Editor: ' + editor.textContent.substring(0, 120));
			const items = () => Array.from(document.querySelectorAll('#rebaseEditor .rebaseEditorItem'));
			const order = () => items().map((item) => item.querySelector('.rebaseEditorSubject, .rebaseEditorMessageInput').value || item.querySelector('.rebaseEditorSubject, .rebaseEditorMessageInput').textContent);
			const setAction = (index, action) => {
				const select = items()[index].querySelector('select');
				select.value = action;
				select.dispatchEvent(new Event('change', { bubbles: true }));
			};
			const start = () => document.getElementById('rebaseEditorStart');
			assert(JSON.stringify(order()) === JSON.stringify(['Resolve #104', 'Commit 3', 'Resolve #102', 'Commit 1']) && !start().classList.contains('disabled'), 'Unexpected commits: ' + JSON.stringify(order()));

			// The first commit can't be squashed
			setAction(0, 'squash');
			assert(start().classList.contains('disabled') && editor.querySelector('.rebaseEditorProblem').textContent.includes('can\'t be squashed'), 'Squashing the first commit wasn\'t refused');
			setAction(0, 'pick');

			// Reword, fixup & drop, and reorder (with the buttons, and by dragging)
			setAction(1, 'reword');
			const messageInput = items()[1].querySelector('textarea');
			assert(messageInput.value === 'Commit 3\n\nThe body of Commit 3', 'The message to reword isn\'t the full message: ' + JSON.stringify(messageInput.value));
			messageInput.value = 'Reworded commit 3';
			messageInput.dispatchEvent(new Event('input', { bubbles: true }));
			setAction(2, 'fixup');
			setAction(3, 'drop');
			mouse(items()[3].querySelector('.rebaseEditorMoveBtn[data-move="-1"]'), 'click');
			assert(JSON.stringify(order()) === JSON.stringify(['Resolve #104', 'Reworded commit 3', 'Commit 1', 'Resolve #102']), 'Moving a commit up failed: ' + JSON.stringify(order()));
			const dataTransfer = new DataTransfer(), dragged = items()[0], target = items()[2], targetBounds = target.getBoundingClientRect();
			dragged.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dataTransfer }));
			target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dataTransfer, clientY: targetBounds.bottom - 2 }));
			target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dataTransfer, clientY: targetBounds.bottom - 2 }));
			dragged.dispatchEvent(new DragEvent('dragend', { bubbles: true }));
			assert(JSON.stringify(order()) === JSON.stringify(['Reworded commit 3', 'Commit 1', 'Resolve #104', 'Resolve #102']), 'Dragging a commit failed: ' + JSON.stringify(order()));

			mouse(start(), 'click');
			const request = await waitFor('the rebase to be started', () => requestsOf('rebaseInteractive').slice(-1)[0]);
			assert(JSON.stringify(request.todo) === JSON.stringify([
				{ action: 'reword', hash: hash(4), message: 'Reworded commit 3' },
				{ action: 'drop', hash: hash(2), message: null },
				{ action: 'pick', hash: hash(5), message: null },
				{ action: 'fixup', hash: hash(3), message: null }
			]) && request.base === hash(6) && document.getElementById('rebaseEditor') === null, 'Unexpected rebase: ' + JSON.stringify(request));

			// An operation in progress is shown, and can be continued or aborted (after confirming)
			await waitFor('the dialog to close', () => document.querySelector('.dialog') === null || document.querySelector('.dialog.actionRunning') === null);
			if (document.querySelector('.dialog') !== null) key(document.body, 'Escape');
			operationFixture = 'rebase';
			try {
				mouse(document.getElementById('refreshBtn'), 'click');
				const bar = await waitFor('the operation bar', () => document.querySelector('#operationBar.active'));
				const buttons = Array.from(bar.querySelectorAll('.operationBarBtn')).map((button) => button.textContent);
				assert(bar.textContent.includes('A rebase is in progress') && JSON.stringify(buttons) === JSON.stringify(['Open Source Control', 'Continue', 'Skip Commit', 'Abort']), 'Unexpected operation bar: ' + bar.textContent);
				mouse(bar.querySelector('[data-action="continue"]'), 'click');
				const continued = await waitFor('the rebase to be continued', () => requestsOf('controlOperation').slice(-1)[0]);
				assert(continued.operation === 'rebase' && continued.action === 'continue', 'Unexpected request: ' + JSON.stringify(continued));
				await waitFor('the dialog to close', () => document.querySelector('.dialog') === null || document.querySelector('.dialog.actionRunning') === null);
				mouse(document.querySelector('#operationBar [data-action="abort"]'), 'click');
				const confirmElem = await waitFor('the confirmation', () => document.querySelector('.dialog'));
				assert(confirmElem.textContent.includes('abort the rebase'), 'Unexpected confirmation: ' + confirmElem.textContent);
				mouse(document.getElementById('dialogAction'), 'click');
				await waitFor('the rebase to be aborted', () => requestsOf('controlOperation').slice(-1)[0].action === 'abort');
			} finally {
				operationFixture = null;
				mouse(document.getElementById('refreshBtn'), 'click');
				await waitFor('the operation bar to be hidden', () => document.querySelector('#operationBar.active') === null);
			}
			return 'Todo: ' + request.todo.map((item) => item.action + ' ' + item.hash.substring(32)).join(', ') + '; operation bar: continued & aborted';
		});

		await check('ui-find-filter', '[Redesign] The search box adds conditions as chips, can only show the matching commits (keeping the graph connected), and searches the files changed by the commits (file:)', async () => {
			const rows = () => document.querySelectorAll('#commitTable tr.commit').length, total = rows(), fixture = makeCommits(total);
			const countText = (count) => count !== 1 ? count + ' commits match' : '1 commit matches';
			const input = document.getElementById('findInput');
			input.focus();
			input.value = 'author:"Second Author"';
			key(input, 'Enter');
			assert(document.querySelectorAll('#findChips .findChip').length === 1 && input.value === '', 'The condition wasn\'t added as a chip');
			const expected = fixture.filter((commit) => commit.author === 'Second Author').length;
			await waitFor('the matches to be counted', () => document.getElementById('findCount').textContent === countText(expected));

			mouse(document.querySelector('.findMode[data-mode="filter"]'), 'click');
			await waitFor('only the matching commits to be shown', () => rows() === expected);
			const columns = new Set(Array.from(document.querySelectorAll('#commitGraph svg circle')).map((circle) => circle.getAttribute('cx')));
			assert(columns.size === 1, 'The graph of the matching commits isn\'t connected (' + columns.size + ' columns)');

			input.value = '?:README';
			input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'E' }));
			const search = await waitFor('the files changed by the commits to be searched', () => requestsOf('searchCommits').pop());
			assert(JSON.stringify(search.files) === JSON.stringify(['README']) && search.changes.length === 0, 'Unexpected search: ' + JSON.stringify(search));
			const both = fixture.filter((commit, i) => commit.author === 'Second Author' && i % 2 === 0).length;
			await waitFor('the commits matching both conditions to be shown', () => rows() === both && document.getElementById('findCount').textContent === countText(both))
				.catch((err) => { throw new Error(err.message + ' (' + rows() + ' rows, "' + document.getElementById('findCount').textContent + '", expected ' + both + ')'); });

			mouse(document.getElementById('findClear'), 'click');
			await waitFor('all of the commits to be shown again', () => rows() === total && !document.querySelector('.findWidget').classList.contains('active'));
			assert(document.querySelectorAll('#findChips .findChip').length === 0, 'The chips weren\'t cleared');
			return expected + ' commit(s) by Second Author (' + columns.size + ' graph column), ' + both + ' also changing README, of ' + total;
		});

		await check('ui-virtual-rows', '[Performance] When thousands of commits are loaded, only the rows near the view are rendered (the others are replaced by spacers of the same height), and scrolling, finding, the scrollbar markers & the Commit Details View work on all of the commits', async () => {
			const COUNT = 5000, FAR = COUNT - 3, view = document.getElementById('view');
			const config = initialState.config, initialLocation = config.commitDetailsView.location; // The config of the Git Map View
			const rendered = () => document.querySelectorAll('#commitTable tr.commit').length;
			const spacers = () => document.querySelectorAll('#commitTable tr.virtualSpacer').length;
			const inView = (elem) => {
				const bounds = elem.getBoundingClientRect(), viewBounds = view.getBoundingClientRect();
				return bounds.top >= viewBounds.top && bounds.bottom <= viewBounds.bottom;
			};
			// The row at the centre of the view (NULL if there isn't a row there, i.e. the rows near the view aren't rendered)
			const rowAtCentre = () => {
				const bounds = view.getBoundingClientRect(), elem = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
				return elem !== null ? elem.closest('tr.commit') : null;
			};
			// The distance between the centre of a commit's row and its vertex on the graph (which are in line if the spacers have the same height as the rows they replace)
			const offset = (index) => {
				const row = commitRow(index), circle = document.querySelector('#commitGraph svg circle[data-id="' + index + '"]');
				if (row === null || circle === null) return null;
				const rowBounds = row.getBoundingClientRect(), circleBounds = circle.getBoundingClientRect();
				return Math.abs(rowBounds.top + rowBounds.height / 2 - (circleBounds.top + circleBounds.height / 2));
			};
			commitCountFixture = COUNT;
			try {
				const start = performance.now();
				mouse(document.getElementById('refreshBtn'), 'click');
				await waitFor('the commits to be loaded', () => spacers() > 0 && commitRow(0) !== null, 15000);
				const loadMs = Math.round(performance.now() - start), rows = rendered(), nodes = document.getElementsByTagName('*').length;
				assert(rows < 400 && commitRow(COUNT - 1) === null && document.querySelectorAll('#commitTable tr.virtualSizer').length > 0, 'Unexpected rows: ' + rows + ' of ' + COUNT + ' rendered');
				const rowHeight = commitRow(0).getBoundingClientRect().height, headersHeight = document.getElementById('tableColHeaders').getBoundingClientRect().height;
				const tableHeight = commitRow(0).closest('table').getBoundingClientRect().height;
				assert(Math.abs(tableHeight - headersHeight - COUNT * rowHeight) < 2, 'The table is ' + tableHeight + 'px high, not ' + (headersHeight + COUNT * rowHeight) + 'px');

				// Scrolling to the middle & the end renders the rows there, in line with the graph (as the first row is)
				const firstOffset = offset(0), drifts = [];
				for (const index of [Math.floor(COUNT / 2), COUNT - 1]) {
					view.scrollTop = index === COUNT - 1 ? view.scrollHeight : index * rowHeight;
					await waitFor('the rows near commit ' + index + ' to be rendered', () => offset(index) !== null && rowAtCentre() !== null);
					drifts.push(Math.abs(offset(index) - firstOffset));
					assert(drifts[drifts.length - 1] < 0.5 && rendered() < 400, 'Commit ' + index + ' is ' + offset(index) + 'px from its vertex, the first commit ' + firstOffset + 'px (' + rendered() + ' rows rendered)');
				}

				// Finding a commit that isn't rendered scrolls to it, and marks it on the scrollbar
				view.scrollTop = 0;
				await waitFor('the first rows to be rendered', () => commitRow(0) !== null && commitRow(COUNT - 1) === null);
				document.getElementById('findBtn').dispatchEvent(new MouseEvent('click', { bubbles: true }));
				await waitFor('the Find Widget to open', () => document.querySelector('.findWidget').classList.contains('active'));
				mouse(document.querySelector('.findMode[data-mode="highlight"]'), 'click');
				const input = document.getElementById('findInput');
				input.value = 'Commit ' + FAR;
				input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'a' }));
				const found = await waitFor('the commit to be found', () => document.getElementById('findPosition').textContent === '1 of 1' && commitRow(FAR) !== null && commitRow(FAR).classList.contains('findMatchRow') && inView(commitRow(FAR)) ? commitRow(FAR) : null);
				const marker = await waitFor('the scrollbar marker of the match', () => document.querySelector('#scrollMarkers .scrollMarker.findMatch'));
				const tagMarker = document.querySelector('#scrollMarkers .scrollMarker.tag');
				assert(parseFloat(marker.style.top) > 99 && tagMarker !== null && parseFloat(tagMarker.style.top) < 1, 'Unexpected markers: match at ' + marker.style.top + ', tag at ' + (tagMarker !== null ? tagMarker.style.top : 'none'));

				// Opening the details of the commit: docked (only the rows near the view are rendered), and inline (all of the rows are rendered, as
				// the Commit Details View is in the table)
				const rowsWithCdv = [];
				for (const cdvLocation of [2, 0]) {
					config.commitDetailsView.location = cdvLocation;
					mouse(commitRow(FAR), 'click');
					const cdv = await waitFor('the Commit Details View to open', () => document.getElementById('cdv'));
					assert(cdv.classList.contains('inline') === (cdvLocation === 0), 'Unexpected Commit Details View: ' + cdv.className);
					await waitFor('the rows to be rendered', () => cdvLocation === 0 ? rendered() === COUNT && spacers() === 0 && document.getElementById('cdv') !== null && document.getElementById('cdv').previousElementSibling === commitRow(FAR) : rendered() < 400 && commitRow(FAR).classList.contains('commitDetailsOpen'), 10000)
						.catch((err) => { throw new Error(err.message + ' (location ' + cdvLocation + ': ' + rendered() + ' rows, ' + spacers() + ' spacers, commit ' + FAR + (commitRow(FAR) !== null ? ': ' + commitRow(FAR).className : ' isn\'t rendered') + ')'); });
					assert(inView(commitRow(FAR)), 'The commit isn\'t in view');
					rowsWithCdv.push(rendered());
					mouse(document.getElementById('cdvClose'), 'click');
					await waitFor('the Commit Details View to close', () => document.getElementById('cdv') === null && spacers() > 0 && rendered() < 400, 10000);
				}
				mouse(document.getElementById('findClear'), 'click');
				await waitFor('the Find Widget to close', () => !document.querySelector('.findWidget').classList.contains('active'));
				return 'Loaded ' + COUNT + ' commits in ' + loadMs + 'ms: ' + rows + ' rows rendered (' + nodes + ' DOM nodes), table ' + Math.round(tableHeight) + 'px high; rows in line with the graph at commits ' + Math.floor(COUNT / 2) + ' & ' + (COUNT - 1) + ' (drift ' + Math.max.apply(null, drifts).toFixed(2) + 'px); found commit ' + FAR + ' (scrollbar marker at ' + marker.style.top + '); Commit Details View docked: ' + rowsWithCdv[0] + ' rows rendered, inline: ' + rowsWithCdv[1];
			} finally {
				config.commitDetailsView.location = initialLocation;
				commitCountFixture = null;
				mouse(document.getElementById('refreshBtn'), 'click');
				await waitFor('the commits to be loaded again', () => spacers() === 0 && rendered() > 0 && rendered() <= 25, 15000);
			}
		});

		await check('ui-branch-compare', '[GitLens] "Compare with Branch…" shows a bar with the two branches, their merge base & the commits only on each (only those commits are shown, marked), and a panel of the files changed, which open their changes', async () => {
			const rows = () => document.querySelectorAll('#commitTable tr.commit'), total = rows().length;
			mouse(commitRow(0).querySelector('.gitRef.head'), 'contextmenu', { button: 2 });
			const menu = await waitFor('the context menu', () => document.querySelector('.contextMenu'));
			mouse(Array.from(menu.querySelectorAll('.contextMenuItem')).find((item) => item.textContent === 'Compare with Branch…'), 'click');
			const dialogElem = await waitFor('the dialog to open', () => document.querySelector('.dialog'));
			assert(dialogElem.textContent.includes('Compare feature with the branch:'), 'Unexpected dialog: ' + dialogElem.textContent);
			mouse(document.getElementById('dialogAction'), 'click');
			const request = await waitFor('the branches to be compared', () => requestsOf('compareBranches').slice(-1)[0]);
			assert(request.left === 'feature' && request.right === 'main', 'Unexpected request: ' + JSON.stringify(request));
			try {
				const bar = await waitFor('the comparison bar', () => document.querySelector('#compareBar.active .compareSegments') ? document.getElementById('compareBar') : null);
				const segments = Array.from(bar.querySelectorAll('.compareSegment')).map((segment) => segment.textContent);
				assert(JSON.stringify(segments) === JSON.stringify(['Only in feature 4', 'Only in main 0', 'Both 4']) && bar.textContent.includes('Merge base 00000000'), 'Unexpected bar: ' + bar.textContent);
				await waitFor('only the commits of the comparison to be shown', () => rows().length === 5 && document.querySelectorAll('#commitTable tr.commit.compareLeft').length === 4);
				assert(document.querySelector('#commitTable tr.commit.compareBase .compareBaseLabel') !== null, 'The merge base isn\'t labelled');
				const panel = await waitFor('the panel of the changed files', () => document.getElementById('comparePanel'));
				const files = Array.from(panel.querySelectorAll('.comparePanelFile')).map((file) => file.textContent.replace(/\s+/g, ' ').trim());
				assert(files.length === 2 && files[1].includes('docs/ (from docs/old.md)') && document.getElementById('view').style.right === panel.style.width && parseInt(panel.style.width) >= 280 && parseInt(panel.style.width) <= 380, 'Unexpected panel: ' + JSON.stringify(files));
				await shot('branch-compare');
				mouse(panel.querySelector('.comparePanelFile'), 'click');
				const diff = await waitFor('the changes of the file to be opened', () => requestsOf('viewDiff').slice(-1)[0]);
				assert(diff.fromHash === hash(5) && diff.toHash === hash(1) && diff.newFilePath === 'src/app.ts', 'Unexpected diff: ' + JSON.stringify(diff));
				mouse(panel.querySelector('[data-panel="openAll"]'), 'click');
				const openAll = await waitFor('all of the changes to be opened', () => requestsOf('openAllChanges').slice(-1)[0]);
				assert(openAll.fileChanges.length === 2 && openAll.title === 'feature ↔ main' && openAll.fromHash === hash(5), 'Unexpected request: ' + JSON.stringify(openAll));
				// The changes between the latest commits (A..B) instead of since the merge base
				assert(request.fromMergeBase === true && panel.querySelector('[data-panel="fromMergeBase"]').checked && bar.textContent.includes('Merge base 00000000 · '), 'Unexpected merge base option / age: ' + bar.textContent);
				const fromBase = panel.querySelector('[data-panel="fromMergeBase"]'), compares = requestsOf('compareBranches').length;
				fromBase.checked = false;
				fromBase.dispatchEvent(new Event('change', { bubbles: true }));
				const latest = await waitFor('the latest commits to be compared', () => requestsOf('compareBranches').length > compares ? requestsOf('compareBranches').slice(-1)[0] : null);
				await waitFor('the panel to describe it', () => document.getElementById('comparePanel').textContent.includes('The differences between the latest commits of feature and main.'));
				mouse(document.querySelector('#comparePanel .comparePanelFile'), 'click');
				const latestDiff = await waitFor('the changes between the latest commits', () => requestsOf('viewDiff').slice(-1)[0].fromHash === hash(HEAD_INDEX + 1) ? requestsOf('viewDiff').slice(-1)[0] : null);
				assert(latest.fromMergeBase === false && latestDiff.toHash === hash(1), 'Unexpected request: ' + JSON.stringify(latest));
				const again = document.querySelector('#comparePanel [data-panel="fromMergeBase"]');
				again.checked = true;
				again.dispatchEvent(new Event('change', { bubbles: true }));
				await waitFor('the merge base to be used again', () => requestsOf('compareBranches').slice(-1)[0].fromMergeBase === true);
				mouse(bar.querySelector('[data-compare="right"]'), 'click');
				await waitFor('only the merge base to be shown (main has no other commits)', () => rows().length === 1);
				return 'Bar: ' + segments.join(' / ') + '; ' + files.length + ' files in the panel; opened the changes of ' + diff.newFilePath + ' and all of them';
			} finally {
				const exit = document.querySelector('#compareBar [data-compare="exit"]');
				if (exit !== null) mouse(exit, 'click');
				await waitFor('the comparison to end', () => !document.getElementById('compareBar').classList.contains('active') && document.getElementById('comparePanel') === null && rows().length === total);
			}
		});

		await check('ui-branch-cleanup', '[GitLens] "Clean Up Branches…" (at the bottom of the Branches dropdown) lists the branches that can be deleted (those that aren\'t merged unselected, with a warning), and deletes the selected ones (also on the remote, if chosen)', async () => {
			const footer = document.querySelector('#branchControl .dropdownFooterAction');
			assert(footer !== null && footer.textContent.startsWith('Clean Up Branches…'), 'The action isn\'t at the bottom of the Branches dropdown'); // (with the number of branches, if the dropdown was opened before)
			const counts = requestsOf('loadBranchCleanup').length;
			mouse(document.querySelector('#branchControl .dropdownCurrentValue'), 'click');
			// The number of branches is only loaded when the dropdown is opened
			await waitFor('the number of branches to be shown', () => requestsOf('loadBranchCleanup').length > counts && footer.querySelector('.dropdownFooterBadge') !== null && footer.querySelector('.dropdownFooterBadge').textContent === '2');
			await shot('branch-cleanup-badge');
			mouse(footer, 'click');
			const list = await waitFor('the branches that can be deleted', () => document.querySelectorAll('#branchCleanup .branchCleanupItem').length === 2 ? document.getElementById('branchCleanup') : null);
			const items = Array.from(list.querySelectorAll('.branchCleanupItem')), checked = items.map((item) => item.querySelector('input').checked);
			assert(JSON.stringify(checked) === JSON.stringify([true, false]) && items[1].textContent.includes('Not merged: deleting it loses 2 commits') && items[1].textContent.includes('origin/spike is gone'), 'Unexpected branches: ' + list.textContent);
			await shot('branch-cleanup');
			const remote = list.querySelector('[data-action="deleteOnRemote"]');
			remote.checked = true;
			remote.dispatchEvent(new Event('change', { bubbles: true }));
			const deleteBtn = document.querySelector('#branchCleanup [data-action="delete"]');
			assert(deleteBtn.textContent === 'Delete 1 Branch (+1 on origin)', 'Unexpected button: ' + deleteBtn.textContent);
			mouse(deleteBtn, 'click');
			const request = await waitFor('the branches to be deleted', () => requestsOf('deleteBranches').slice(-1)[0]);
			assert(JSON.stringify(request.branches) === '["old-feature"]' && JSON.stringify(request.remoteBranches) === '[{"remote":"origin","branch":"old-feature"}]' && document.getElementById('branchCleanup') === null, 'Unexpected request: ' + JSON.stringify(request));
			await waitFor('the dialog to close', () => document.querySelector('.dialog') === null || document.querySelector('.dialog.actionRunning') === null);
			if (document.querySelector('.dialog') !== null) key(document.body, 'Escape');
			return 'Listed old-feature (selected) & spike (not merged, unselected); deleted ' + request.branches.join(', ') + ' (and on origin)';
		});

		await check('ui-edit-message', '[GitLens] "Edit Commit Message…" opens a dialog with the full message in a multi-line input (Enter adds a line, Ctrl / Cmd + Enter saves it)', async () => {
			if (commitRow(HEAD_INDEX) === null) key(document.body, keybindings.scrollToHead, ctrl); // Load the commits until HEAD
			const row = await waitFor('the row of HEAD', () => commitRow(HEAD_INDEX));
			mouse(row, 'contextmenu', { button: 2 });
			const menu = await waitFor('the context menu', () => document.querySelector('.contextMenu'));
			const titles = Array.from(menu.querySelectorAll('.contextMenuItem')).map((item) => item.textContent);
			assert(titles.includes('Undo Commit…') && titles.includes('Fix Up Staged Changes into this Commit…') && titles.includes('Copy as Patch'), 'Unexpected context menu: ' + JSON.stringify(titles));
			mouse(Array.from(menu.querySelectorAll('.contextMenuItem')).find((item) => item.textContent === 'Edit Commit Message…'), 'click');
			const input = await waitFor('the dialog to open', () => document.querySelector('.dialog textarea.dialogTextArea'));
			assert(input.value === 'Commit ' + HEAD_INDEX + '\n\nThe body' && document.activeElement === input, 'Unexpected input: ' + JSON.stringify(input.value));
			const callout = document.querySelector('.dialog .dialogCallout.warning');
			assert(callout !== null && callout.textContent.includes('This commit is already on origin/main. Changing it gives it a new hash, so the branch must be force-pushed.'), 'The commit isn\'t said to have been pushed: ' + (callout !== null ? callout.textContent : 'no callout'));
			await shot('edit-message');
			const before = requestsOf('editCommitMessage').length;
			key(input, 'Enter');
			await sleep(100);
			assert(requestsOf('editCommitMessage').length === before && document.querySelector('.dialog') !== null, 'Enter saved the message');
			input.value = 'New subject\n\nNew body';
			key(input, 'Enter', ctrl);
			const request = await waitFor('the message to be saved', () => requestsOf('editCommitMessage').length > before ? requestsOf('editCommitMessage').slice(-1)[0] : null);
			assert(request.commitHash === hash(HEAD_INDEX + 1) && request.message === 'New subject\n\nNew body', 'Unexpected request: ' + JSON.stringify(request));
			await waitFor('the dialog to close', () => document.querySelector('.dialog') === null || document.querySelector('.dialog.actionRunning') === null);
			if (document.querySelector('.dialog') !== null) key(document.body, 'Escape');
			return 'Saved ' + JSON.stringify(request.message) + ' with ' + (isMac ? 'Cmd' : 'Ctrl') + ' + Enter';
		});

		await check('ui-bisect', '[GitLens] While bisecting, the operation bar shows how many commits are left (with Good / Bad / Skip buttons) and the commits are labelled; when the first bad commit is found, it\'s shown', async () => {
			const bar = document.getElementById('operationBar');
			bisectFixture = { bad: hash(1), good: [hash(9)], skipped: [hash(3)], current: hash(5), remaining: 4, steps: 2, firstBad: null, candidates: [1, 2, 3, 4, 5, 6, 7, 8].map(hash) };
			try {
				mouse(document.getElementById('refreshBtn'), 'click');
				await waitFor('the bisect bar', () => bar.classList.contains('active') && bar.classList.contains('bisect'));
				const buttons = Array.from(bar.querySelectorAll('.operationBarBtn')).map((button) => button.textContent);
				assert(bar.textContent.includes('Bisecting — 4 commits left to test (about 2 steps).') && bar.textContent.includes('Checked out 00000000') && JSON.stringify(buttons) === JSON.stringify(['Good', 'Bad', 'Skip', 'View Log', 'Stop Bisecting']), 'Unexpected bar: ' + bar.textContent + ' ' + JSON.stringify(buttons));
				const labels = await waitFor('the commits to be labelled', () => commitRow(4) !== null && commitRow(4).querySelector('.bisectLabel.testing') ? [0, 2, 4, 8].map((i) => (commitRow(i).querySelector('.bisectLabel') || { textContent: '' }).textContent) : null);
				assert(JSON.stringify(labels) === JSON.stringify(['bad', 'skipped', 'testing', 'good']), 'Unexpected labels: ' + JSON.stringify(labels));
				const excluded = Array.from(document.querySelectorAll('#commitTable tr.commit.bisectExcluded')).map((row) => parseInt(row.dataset.id));
				assert(excluded.length > 0 && excluded.every((i) => i >= 8), 'The commits that can\'t be the first bad commit aren\'t dimmed: ' + JSON.stringify(excluded));
				mouse(bar.querySelector('[data-bisect="viewLog"]'), 'click');
				await waitFor('the log to be opened', () => requestsOf('viewBisectLog').length > 0);
				document.getElementById('view').scrollTop = 0;
				await shot('bisect');
				mouse(bar.querySelector('[data-bisect="good"]'), 'click');
				const marked = await waitFor('the commit to be marked', () => requestsOf('bisect').slice(-1)[0]);
				assert(marked.action === 'good' && marked.commitHash === null, 'Unexpected request: ' + JSON.stringify(marked));
				await waitFor('the dialog to close', () => document.querySelector('.dialog') === null || document.querySelector('.dialog.actionRunning') === null);
				if (document.querySelector('.dialog') !== null) key(document.body, 'Escape');

				bisectFixture = Object.assign({}, bisectFixture, { firstBad: hash(3) });
				mouse(document.getElementById('refreshBtn'), 'click');
				await waitFor('the first bad commit to be shown', () => bar.classList.contains('bisectDone') && bar.textContent.includes('Found the first bad commit: 00000000'));
				await shot('bisect-done');
				return 'Bar: ' + buttons.join(' / ') + '; labels: ' + labels.join(', ') + '; first bad commit shown';
			} finally {
				bisectFixture = null;
				mouse(document.getElementById('refreshBtn'), 'click');
				await waitFor('the bisect bar to be hidden', () => !bar.classList.contains('active'));
			}
		});

		const closeDialog = async () => {
			await waitFor('the dialog to close', () => document.querySelector('.dialog') === null || document.querySelector('.dialog.actionRunning') === null);
			if (document.querySelector('.dialog') !== null) key(document.body, 'Escape');
		};
		const contextMenuItems = async (target) => {
			mouse(target, 'contextmenu', { button: 2 });
			const menu = await waitFor('the context menu', () => document.querySelector('.contextMenu'));
			return Array.from(menu.querySelectorAll('.contextMenuItem'));
		};
		const clickMenuItem = async (target, title) => {
			const item = (await contextMenuItems(target)).find((elem) => elem.textContent === title);
			assert(item, 'The context menu doesn\'t have "' + title + '"');
			mouse(item, 'click');
		};
		const openDetails = async (row) => {
			mouse(row, 'click');
			return waitFor('the Commit Details View to load', () => document.querySelector('#cdv #cdvFileView .fileTreeFileRecord') !== null ? document.getElementById('cdv') : null);
		};
		const closeDetails = async () => {
			if (document.getElementById('cdvClose') !== null) mouse(document.getElementById('cdvClose'), 'click');
			await waitFor('the Commit Details View to close', () => document.getElementById('cdv') === null);
		};
		const fileRecord = (name) => Array.from(document.querySelectorAll('#cdvFileView .fileTreeFileRecord')).find((elem) => elem.textContent.includes(name));

		await check('ui-explain-tab', '[AI] The Explain tab (git-map.ai.explainCommit.enabled) asks which language model the commit is sent to before sending it, then shows the explanation as it\'s received (rendered from Markdown, without rendering HTML), which can be copied', async () => {
			initialState.config.explainCommit = true; // The config of the Git Map View
			try {
				await openDetails(commitRow(2));
				const tab = await waitFor('the Explain tab', () => document.querySelector('.cdvTab[data-tab="explain"]'));
				const models = requestsOf('loadLanguageModels').length, explained = requestsOf('explainCommit').length;
				mouse(tab, 'click');
				const consent = await waitFor('the consent card', () => document.querySelector('#cdvExplainView .explainConsent #explainModel') ? document.querySelector('#cdvExplainView .explainConsent') : null);
				const options = Array.from(consent.querySelectorAll('#explainModel option')).map((option) => option.textContent);
				assert(requestsOf('loadLanguageModels').length > models && requestsOf('explainCommit').length === explained, 'The commit was sent before it was confirmed');
				assert(JSON.stringify(options) === JSON.stringify(['Model One (GitHub Copilot)', 'Model Two (GitHub Copilot)']) && consent.textContent.includes('up to 3,000 lines) are sent to Model One, provided by GitHub Copilot') && consent.querySelector('#explainDontAsk + .customCheckbox') !== null, 'Unexpected consent card: ' + consent.textContent);
				await shot('explain-consent');
				document.getElementById('explainModel').value = 'm2';
				document.getElementById('explainModel').dispatchEvent(new Event('change', { bubbles: true }));
				assert(document.getElementById('explainConsentText').textContent.includes('sent to Model Two, provided by GitHub Copilot'), 'The consent doesn\'t name the model chosen: ' + document.getElementById('explainConsentText').textContent);
				mouse(consent.querySelector('[data-explain="explain"]'), 'click');
				const request = await waitFor('the commit to be explained', () => requestsOf('explainCommit').length > explained ? requestsOf('explainCommit').slice(-1)[0] : null);
				assert(request.commitHash === hash(3) && request.modelId === 'm2', 'Unexpected request: ' + JSON.stringify(request));
				await waitFor('the first part of the explanation', () => document.querySelector('#cdvExplainView .explainLoading') !== null && document.querySelector('#cdvExplainView .explainText') !== null);
				window.dispatchEvent(new MessageEvent('message', { data: { command: 'explainCommit', commitHash: hash(3), done: true, model: 'Model Two', truncated: false, error: null, text: '## Summary\nThis commit **fixes** a bug in `parse()`.\n\n## Changes\n- Handles <img src=x onerror="window.e2eInjected=1"> empty input\n- Adds a test\n\n## Worth checking\nNothing in particular.' } }));
				const view = await waitFor('the explanation', () => document.querySelector('#cdvExplainView .explainFooter') ? document.getElementById('cdvExplainView') : null);
				const headings = Array.from(view.querySelectorAll('.explainHeading')).map((elem) => elem.textContent);
				assert(JSON.stringify(headings) === JSON.stringify(['Summary', 'Changes', 'Worth checking']) && view.querySelectorAll('.explainText li').length === 2 && view.querySelector('.explainText code').textContent === 'parse()' && view.querySelector('.explainText b').textContent === 'fixes', 'Unexpected explanation: ' + view.innerHTML.substring(0, 300));
				assert(view.querySelector('img') === null && typeof window.e2eInjected === 'undefined' && view.textContent.includes('<img src=x'), 'HTML in the explanation was rendered');
				assert(view.querySelector('.explainFooter').textContent.includes('Model Two · may be inaccurate') && view.querySelector('.explainLoading') === null, 'Unexpected footer: ' + view.querySelector('.explainFooter').textContent);
				await shot('explain-result');
				mouse(view.querySelector('[data-explain="copy"]'), 'click');
				const copied = await waitFor('the explanation to be copied', () => requestsOf('copyToClipboard').filter((msg) => msg.type === 'Explanation').slice(-1)[0]);
				assert(copied.data.startsWith('## Summary'), 'Unexpected copy: ' + JSON.stringify(copied));
				return 'Asked first (2 models), explained by Model Two: ' + headings.join(' / ') + '; HTML escaped; copied';
			} finally {
				initialState.config.explainCommit = false;
				await closeDetails();
			}
		});

		await check('ui-cdv-visual-file-history', '[GitLens] "Visual File History" in the context menu of a file in the Commit Details View opens the visual history of the file', async () => {
			await openDetails(commitRow(1));
			try {
				const items = (await contextMenuItems(fileRecord('README.md'))).map((item) => item.textContent);
				assert(items.includes('Visual File History') && !items.includes('Stash this File…') && !items.includes('Restore File from this Stash…'), 'Unexpected context menu: ' + JSON.stringify(items));
				key(document.body, 'Escape');
				await clickMenuItem(fileRecord('README.md'), 'Visual File History');
				const request = await waitFor('the Visual File History to be opened', () => requestsOf('viewVisualFileHistory').slice(-1)[0]);
				assert(request.repo === REPO && request.filePath === 'README.md', 'Unexpected request: ' + JSON.stringify(request));
				return 'Requested the Visual File History of ' + request.filePath;
			} finally {
				await closeDetails();
			}
		});

		// The uncommitted changes & a stash (for the checks that follow)
		uncommittedFixture = true;
		mouse(document.getElementById('refreshBtn'), 'click');
		await waitFor('the uncommitted changes & the stash to be loaded', () => document.getElementById('uncommittedChanges') !== null && commitRow(1) !== null && commitRow(1).textContent.includes('WIP on main: Experiment'));

		await check('ui-stash-partial', '[GitLens] "Stash uncommitted changes…" lists the changed files (so that only some of them are stashed), and can stash only the staged changes', async () => {
			await clickMenuItem(document.getElementById('uncommittedChanges'), 'Stash uncommitted changes…');
			const dialogElem = await waitFor('the dialog to open', () => document.querySelector('.dialog #dialogInput5') ? document.querySelector('.dialog') : null);
			const labels = Array.from(dialogElem.querySelectorAll('.dialogFormCheckbox label')).map((label) => label.textContent.trim());
			assert(JSON.stringify(labels.slice(0, 4)) === JSON.stringify(['src/new-name.ts staged', 'README.md modified', 'notes.txt untracked', 'Only the staged changes']) && [1, 2, 3].every((i) => document.getElementById('dialogInput' + i).checked), 'Unexpected dialog: ' + JSON.stringify(labels));
			const button = () => document.getElementById('dialogAction').textContent;
			assert(dialogElem.querySelector('.dialogFilesHeader') !== null && button() === 'Stash 3 Files', 'Unexpected file selection: ' + button());
			mouse(dialogElem.querySelector('[data-select="none"]'), 'click');
			assert(button() === 'Stash 0 Files' && [1, 2, 3].every((i) => !document.getElementById('dialogInput' + i).checked), 'None didn\'t unselect the files: ' + button());
			mouse(dialogElem.querySelector('[data-select="all"]'), 'click');
			assert(button() === 'Stash 3 Files', 'All didn\'t select the files: ' + button());
			document.getElementById('dialogInput2').checked = false;
			document.getElementById('dialogInput2').dispatchEvent(new Event('change', { bubbles: true }));
			assert(button() === 'Stash 2 Files', 'Unexpected button: ' + button());
			await shot('stash-partial');
			document.getElementById('dialogInput5').checked = true;
			const before = requestsOf('pushStash').length;
			mouse(document.getElementById('dialogAction'), 'click');
			const request = await waitFor('the changes to be stashed', () => requestsOf('pushStash').length > before ? requestsOf('pushStash').slice(-1)[0] : null);
			assert(JSON.stringify(request.paths) === JSON.stringify(['src/new-name.ts', 'notes.txt']) && request.onlyStaged === false && request.includeUntracked === true, 'Unexpected request: ' + JSON.stringify(request));
			await closeDialog();

			// Only the staged changes
			await clickMenuItem(document.getElementById('uncommittedChanges'), 'Stash uncommitted changes…');
			await waitFor('the dialog to open', () => document.querySelector('.dialog #dialogInput4'));
			document.getElementById('dialogInput4').checked = true;
			mouse(document.getElementById('dialogAction'), 'click');
			const staged = await waitFor('the staged changes to be stashed', () => requestsOf('pushStash').length > before + 1 ? requestsOf('pushStash').slice(-1)[0] : null);
			assert(staged.paths === null && staged.onlyStaged === true, 'Unexpected request: ' + JSON.stringify(staged));
			await closeDialog();
			return 'Stashed ' + request.paths.join(', ') + ' (with untracked files); then only the staged changes';
		});

		await check('ui-stash-file', '[GitLens] "Stash this File…" in the context menu of a file of the uncommitted changes stashes only that file', async () => {
			await openDetails(document.getElementById('uncommittedChanges'));
			try {
				await clickMenuItem(fileRecord('new-name.ts'), 'Stash this File…');
				await waitFor('the dialog to open', () => document.querySelector('.dialog #dialogInput3'));
				const checked = [1, 2, 3].map((i) => document.getElementById('dialogInput' + i).checked);
				assert(JSON.stringify(checked) === JSON.stringify([true, false, false]) && document.getElementById('dialogAction').textContent === 'Stash 1 File', 'Only the file should be selected: ' + JSON.stringify(checked));
				const before = requestsOf('pushStash').length;
				mouse(document.getElementById('dialogAction'), 'click');
				const request = await waitFor('the file to be stashed', () => requestsOf('pushStash').length > before ? requestsOf('pushStash').slice(-1)[0] : null);
				assert(JSON.stringify(request.paths) === JSON.stringify(['src/new-name.ts']), 'Unexpected request: ' + JSON.stringify(request));
				await closeDialog();
				return 'Stashed ' + request.paths[0];
			} finally {
				await closeDetails();
			}
		});

		await check('ui-restore-from-stash', '[GitLens] "Restore File from this Stash…" in the context menu of a file of a stash restores it, asking first (as a dangerous action) when the file has uncommitted changes', async () => {
			await openDetails(commitRow(1));
			try {
				const before = requestsOf('restoreFileFromStash').length;
				await clickMenuItem(fileRecord('README.md'), 'Restore File from this Stash…');
				const first = await waitFor('the file to be restored', () => requestsOf('restoreFileFromStash').length > before ? requestsOf('restoreFileFromStash').slice(-1)[0] : null);
				assert(first.stashHash === STASH_COMMIT.hash && first.selector === 'refs/stash@{0}' && first.filePath === 'README.md' && first.force === false, 'Unexpected request: ' + JSON.stringify(first));
				const dialogElem = await waitFor('the confirmation', () => document.querySelector('.dialog'));
				assert(dialogElem.classList.contains('danger') && dialogElem.textContent.includes('Restore README.md from stash@{0}? It has uncommitted changes'), 'Unexpected confirmation: ' + dialogElem.className + ' ' + dialogElem.textContent);
				await shot('restore-from-stash');
				mouse(document.getElementById('dialogAction'), 'click');
				const forced = await waitFor('the file to be replaced', () => requestsOf('restoreFileFromStash').length > before + 1 ? requestsOf('restoreFileFromStash').slice(-1)[0] : null);
				assert(forced.force === true, 'Unexpected request: ' + JSON.stringify(forced));
				await closeDialog();
				return 'Asked to confirm (danger), then restored ' + forced.filePath + ' from ' + forced.selector.substring(5);
			} finally {
				await closeDetails();
			}
		});

		await check('ui-apply-patch', '[GitLens] "Apply Patch…" in the context menu of the uncommitted changes shows what the chosen patch contains and whether it applies cleanly, and applies it as commits or as uncommitted changes', async () => {
			try {
				await clickMenuItem(document.getElementById('uncommittedChanges'), 'Apply Patch…');
				const dialogElem = await waitFor('the dialog to open', () => document.querySelector('.dialog .dialogNote') ? document.querySelector('.dialog') : null);
				const radios = document.querySelectorAll('input[name="dialogInput0"]');
				assert(dialogElem.textContent.includes('Apply the patch fix.patch?') && dialogElem.textContent.includes('2 commits · 3 files +10 −2') && dialogElem.querySelector('.dialogNote.ok') !== null && radios.length === 2 && radios[0].checked, 'Unexpected dialog: ' + dialogElem.textContent);
				const descriptions = Array.from(dialogElem.querySelectorAll('.dialogRadioDescription')).map((elem) => elem.textContent);
				assert(JSON.stringify(descriptions) === JSON.stringify(['Keeps their authors & messages (git am)', 'Merges with your changes where it can (git apply --3way)']), 'Unexpected options: ' + JSON.stringify(descriptions));
				await shot('apply-patch');
				radios[1].checked = true;
				const before = requestsOf('applyPatch').length;
				mouse(document.getElementById('dialogAction'), 'click');
				const request = await waitFor('the patch to be applied', () => requestsOf('applyPatch').length > before ? requestsOf('applyPatch').slice(-1)[0] : null);
				assert(request.file === '/e2e/fix.patch' && request.asCommits === false, 'Unexpected request: ' + JSON.stringify(request));
				await closeDialog();
				return 'Showed fix.patch (2 commits, 3 files, applies cleanly), applied as uncommitted changes';
			} finally {
				uncommittedFixture = false;
				mouse(document.getElementById('refreshBtn'), 'click');
				await waitFor('the uncommitted changes to be hidden', () => document.getElementById('uncommittedChanges') === null);
			}
		});
	};

	window.addEventListener('load', () => {
		setTimeout(() => {
			run().catch((err) => {
				results.push({ id: 'webview-harness', title: 'The Webview UI harness ran', pass: false, details: err && err.stack ? err.stack : String(err) });
			}).then(() => {
				realApi.postMessage({ command: 'e2eResults', results: results });
			});
		}, 0);
	});
})();
