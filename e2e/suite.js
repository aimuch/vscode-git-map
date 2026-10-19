/**
 * End-to-End Test Suite - Runs inside the Extension Host of a real instance of Visual Studio Code (see ./run.js).
 *
 * The checks drive Git Map the way a user does (running its commands, and the messages exchanged between the
 * Git Map View's Webview and the extension), against real Git repositories. Each check writes its result to the
 * report, so that the run can be verified & repeated.
 */
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vscode = require('vscode');

const fixtures = JSON.parse(process.env.E2E_FIXTURES);
const results = [];

const GIT_ENV = Object.assign({}, process.env, {
	GIT_AUTHOR_NAME: 'E2E Author', GIT_AUTHOR_EMAIL: 'author@example.com',
	GIT_COMMITTER_NAME: 'E2E Committer', GIT_COMMITTER_EMAIL: 'committer@example.com'
});

function git(cwd, ...args) {
	return cp.execFileSync('git', args, { cwd: cwd, env: GIT_ENV, encoding: 'utf8' }).trim();
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(description, condition, timeout = 20000) {
	const start = Date.now();
	while (Date.now() - start < timeout) {
		const value = await condition();
		if (value) return value;
		await sleep(100);
	}
	throw new Error('Timed out waiting for ' + description);
}

function withTimeout(promise, ms, description) {
	return Promise.race([promise, sleep(ms).then(() => { throw new Error('Timed out after ' + ms + 'ms: ' + description); })]);
}

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

/**
 * Take a screenshot of the workbench of Visual Studio Code (through the DevTools protocol, as it's started with --remote-debugging-port=0),
 * saved in e2e/.artifacts/screenshots.
 * @param name The name of the screenshot.
 * @returns The path of the screenshot, or NULL if it couldn't be taken.
 */
async function screenshot(name) {
	try {
		const port = parseInt(fs.readFileSync(path.join(path.dirname(fixtures.workspace), 'user-data', 'DevToolsActivePort'), 'utf8').split('\n')[0]);
		const targets = await (await fetch('http://127.0.0.1:' + port + '/json')).json();
		const target = targets.find((t) => t.type === 'page' && t.url.includes('workbench'));
		const ws = new WebSocket(target.webSocketDebuggerUrl);
		await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
		const data = await new Promise((resolve, reject) => {
			ws.onmessage = (event) => {
				const msg = JSON.parse(event.data);
				if (msg.id === 1) msg.result ? resolve(msg.result.data) : reject(new Error(JSON.stringify(msg.error)));
			};
			ws.send(JSON.stringify({ id: 1, method: 'Page.captureScreenshot', params: { format: 'png' } }));
		});
		ws.close();
		const dir = path.join(path.dirname(fixtures.workspace), 'screenshots'), file = path.join(dir, name + '.png');
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(file, Buffer.from(data, 'base64'));
		return file;
	} catch (_) {
		return null;
	}
}

// E2E_ONLY (a comma separated list of check ids, and / or "harness") only runs those checks, while developing them
const ONLY = process.env.E2E_ONLY ? process.env.E2E_ONLY.split(',') : null;

async function check(id, title, fn) {
	if (ONLY !== null && !ONLY.includes(id)) return;
	const start = Date.now();
	try {
		const details = await fn();
		results.push({ id: id, title: title, pass: true, details: details || '', durationMs: Date.now() - start });
	} catch (err) {
		results.push({ id: id, title: title, pass: false, details: err && err.stack ? err.stack : String(err), durationMs: Date.now() - start });
	}
}

function realpath(p) {
	return fs.realpathSync(p).replace(/\\/g, '/');
}

/**
 * Create a new repository for a check that changes it (outside of the workspace, so that it isn't discovered by Git Map).
 * @param name The name of the repository.
 * @param files The files committed in the first commit of the repository.
 * @returns The path of the repository.
 */
function createScratchRepo(name, files) {
	const repo = path.join(path.dirname(fixtures.workspace), 'scratch', name);
	fs.rmSync(repo, { recursive: true, force: true });
	fs.mkdirSync(repo, { recursive: true });
	git(repo, 'init', '-q', '-b', 'main');
	git(repo, 'config', 'commit.gpgsign', 'false');
	// The identity used by the Git commands that Git Map runs (the global Git config isn't used by the checks)
	git(repo, 'config', 'user.name', 'E2E Committer');
	git(repo, 'config', 'user.email', 'committer@example.com');
	Object.keys(files).forEach((file) => fs.writeFileSync(path.join(repo, file), files[file]));
	git(repo, 'add', '-A');
	git(repo, 'commit', '-q', '-m', 'Initial commit');
	return realpath(repo);
}

/**
 * Make a commit in a repository, changing a file.
 * @returns The hash of the commit.
 */
function commitFile(repo, file, contents, message) {
	fs.writeFileSync(path.join(repo, file), contents);
	git(repo, 'add', file);
	git(repo, 'commit', '-q', '-m', message);
	return git(repo, 'rev-parse', 'HEAD');
}

/**
 * Instrument the Git Map View, recording the messages exchanged between its Webview and the extension.
 */
function instrumentGitGraphView(extensionPath) {
	const { GitGraphView } = require(path.join(extensionPath, 'out', 'gitGraphView.js'));
	const record = { requests: [], responses: [], html: [] };

	const respondToMessage = GitGraphView.prototype.respondToMessage;
	GitGraphView.prototype.respondToMessage = function (msg) {
		record.requests.push(msg);
		return respondToMessage.call(this, msg);
	};
	const sendMessage = GitGraphView.prototype.sendMessage;
	GitGraphView.prototype.sendMessage = function (msg) {
		record.responses.push(msg);
		return sendMessage.call(this, msg);
	};
	const getHtmlForWebview = GitGraphView.prototype.getHtmlForWebview;
	GitGraphView.prototype.getHtmlForWebview = function () {
		const html = getHtmlForWebview.call(this);
		record.html.push(html);
		return html;
	};

	return { GitGraphView, record };
}

function getGitGraphTabs() {
	return vscode.window.tabGroups.all.flatMap((group) => group.tabs).filter((tab) => tab.input instanceof vscode.TabInputWebview && tab.label === 'Git Map');
}

/**
 * Wait for the Webview to request (and the extension to respond with) the commits of a repository.
 */
async function waitForCommitsLoaded(record, repo, sinceIndex) {
	await waitFor('the Webview to request the commits of ' + repo, () => record.requests.slice(sinceIndex.requests).some((msg) => msg.command === 'loadCommits' && msg.repo === repo));
	return waitFor('the extension to respond with the commits of ' + repo, () => {
		const request = record.requests.slice(sinceIndex.requests).reverse().find((msg) => msg.command === 'loadCommits' && msg.repo === repo);
		return record.responses.slice(sinceIndex.responses).reverse().find((msg) => msg.command === 'loadCommits' && msg.refreshId === request.refreshId);
	});
}

function marker(record) {
	return { requests: record.requests.length, responses: record.responses.length };
}

async function run() {
	const extension = vscode.extensions.getExtension('aimdev.git-map');
	assert(extension, 'The Git Map extension is not loaded');
	const { GitGraphView, record } = instrumentGitGraphView(extension.extensionPath);
	await extension.activate();

	const main = realpath(fixtures.main), sub = realpath(fixtures.sub), wt = realpath(fixtures.wt);

	// Get the open Git Map View (opening it if a previous check failed to), so that each check is independent of the others
	const getView = async () => {
		if (!GitGraphView.currentPanel) await vscode.commands.executeCommand('git-map.view');
		return waitFor('the Git Map View to open', () => GitGraphView.currentPanel);
	};

	await check('activation', 'Git Map activates in this version of Visual Studio Code (onStartupFinished)', async () => {
		const packageJson = JSON.parse(fs.readFileSync(path.join(extension.extensionPath, 'package.json'), 'utf8'));
		assert(extension.isActive, 'The extension is not active');
		assert(JSON.stringify(packageJson.activationEvents) === '["onStartupFinished"]', 'Unexpected activation events: ' + JSON.stringify(packageJson.activationEvents));
		return 'Visual Studio Code ' + vscode.version + ', engines.vscode ' + packageJson.engines.vscode;
	});

	await check('#903', '"View Git Map" is contributed to the scm/repository menu (Source Control Repositories view)', async () => {
		const menus = JSON.parse(fs.readFileSync(path.join(extension.extensionPath, 'package.json'), 'utf8')).contributes.menus;
		const repositoryMenu = menus['scm/repository'] || [];
		assert(repositoryMenu.some((item) => item.command === 'git-map.view' && item.group === 'inline' && item.when.includes('\'Inline\'')), 'No inline scm/repository menu item');
		assert(repositoryMenu.some((item) => item.command === 'git-map.view' && item.group !== 'inline' && item.when.includes('\'More Actions\'')), 'No "More Actions" scm/repository menu item');
	});

	await check('status-bar', 'The Status Bar Item displays the Git Map icon and / or text, as configured by git-map.statusBarItemDisplay', async () => {
		const packageJson = JSON.parse(fs.readFileSync(path.join(extension.extensionPath, 'package.json'), 'utf8'));
		const icon = packageJson.contributes.icons['git-map-logo'];
		assert(icon && fs.statSync(path.join(extension.extensionPath, icon.default.fontPath)).size > 0, 'The git-map-logo icon font is missing');

		const { StatusBarItem } = require(path.join(extension.extensionPath, 'out', 'statusBarItem.js'));
		const { EventEmitter } = require(path.join(extension.extensionPath, 'out', 'utils', 'event.js'));
		const { Logger } = require(path.join(extension.extensionPath, 'out', 'logger.js'));
		const onDidChangeRepos = new EventEmitter(), onDidChangeConfiguration = new EventEmitter(), logger = new Logger();
		const statusBarItem = new StatusBarItem(1, onDidChangeRepos.subscribe, onDidChangeConfiguration.subscribe, logger);
		const texts = {};
		try {
			for (const display of ['Icon', 'Text', 'Icon & Text']) {
				await vscode.workspace.getConfiguration('git-map').update('statusBarItemDisplay', display, vscode.ConfigurationTarget.Global);
				onDidChangeConfiguration.emit({ affectsConfiguration: (section) => section === 'git-map' || section === 'git-map.statusBarItemDisplay' });
				texts[display] = statusBarItem.statusBarItem.text;
			}
		} finally {
			await vscode.workspace.getConfiguration('git-map').update('statusBarItemDisplay', undefined, vscode.ConfigurationTarget.Global);
			statusBarItem.dispose();
			logger.dispose();
		}
		assert(texts['Icon'] === '$(git-map-logo)' && texts['Text'] === 'Git Map' && texts['Icon & Text'] === '$(git-map-logo) Git Map', 'Unexpected texts: ' + JSON.stringify(texts));
		return JSON.stringify(texts);
	});

	await check('#794', 'The "View Git Map" command opens the view when invoked with a null argument', async () => {
		const since = marker(record);
		await vscode.commands.executeCommand('git-map.view', null);
		await waitFor('the Git Map View to open', () => GitGraphView.currentPanel && getGitGraphTabs().length === 1, 10000);
		// The Webview's script runs & requests the repositories, i.e. the Webview's resources load in this version of Visual Studio Code
		await waitFor('the Webview to request data', () => record.requests.slice(since.requests).some((msg) => msg.command === 'loadRepoInfo'));
		return 'Webview requests: ' + Array.from(new Set(record.requests.map((msg) => msg.command))).join(', ');
	});

	await check('webview-csp', 'The Webview HTML loads its script & stylesheet through the Webview resource URIs and CSP of this version', async () => {
		await getView();
		const html = await waitFor('the Webview HTML', () => record.html.slice().reverse().find((html) => html.includes('id="view"')));
		assert(/<meta http-equiv="Content-Security-Policy" content="[^"]*script-src 'nonce-[^']+'/.test(html), 'No nonce based script-src CSP');
		const scriptSrc = (html.match(/<script nonce="[^"]+" src="([^"]+)">/) || [])[1];
		assert(scriptSrc && scriptSrc.includes('out.min.js') && !scriptSrc.startsWith('file:'), 'Unexpected script src: ' + scriptSrc);
		return 'script src: ' + scriptSrc;
	});

	await check('ui-file-icon-theme', '[Redesign] The file icon theme of Visual Studio Code (Seti) is sent to the Webview, with its language ids mapped to file extensions and its font loadable by the Webview', async () => {
		const view = await getView();
		const count = record.responses.filter((msg) => msg.command === 'loadFileIconTheme').length;
		await view.respondToMessage({ command: 'loadFileIconTheme' });
		const response = await waitFor('the file icon theme', () => {
			const responses = record.responses.filter((msg) => msg.command === 'loadFileIconTheme');
			return responses.length > count ? responses[responses.length - 1] : null;
		});
		const theme = response.theme, iconTheme = vscode.workspace.getConfiguration('workbench').get('iconTheme');
		assert(theme !== null && theme.id === iconTheme, 'Unexpected file icon theme: ' + (theme && theme.id) + ' (workbench.iconTheme: ' + iconTheme + ')');
		const tsIcon = theme.definitions[theme.fileExtensions['ts']];
		assert(tsIcon && typeof tsIcon.fontCharacter === 'string' && tsIcon.fontCharacter.length === 1 && tsIcon.fontColor !== null, 'TypeScript files don\'t have a font icon: ' + JSON.stringify(tsIcon));
		assert(theme.fonts.length > 0 && !theme.fonts[0].src.startsWith('file:') && theme.fonts[0].src.includes('seti'), 'The font isn\'t loadable by the Webview: ' + (theme.fonts[0] && theme.fonts[0].src));
		const html = record.html.slice().reverse().find((html) => html.includes('id="view"'));
		assert(/font-src [^;"]+/.test(html), 'The CSP doesn\'t allow the font to be loaded');
		return theme.id + ': ' + Object.keys(theme.definitions).length + ' icons, .ts → ' + theme.fileExtensions['ts'] + ', font ' + theme.fonts[0].id;
	});

	// File icon themes of SVG images (like vscode-icons). The ways it could go wrong, which this check asserts don't happen: the theme's
	// images aren't converted into URIs the Webview can load (their paths are relative to its definition), the definition can't be read when
	// the view asks for it (e.g. the extension generating it is writing it) and isn't loaded once it can be (so the built-in icons stay until
	// the view is reopened), and a change to the definition isn't loaded.
	await check('file-icon-theme-svg', '[Redesign] A file icon theme of SVG images is loaded, also if its definition can only be read later (e.g. while it\'s being written), and again when it changes', async () => {
		const view = await getView();
		const themeFile = path.join(fixtures.iconThemeExtension, 'dist', 'theme.json');
		const themes = () => record.responses.filter((msg) => msg.command === 'loadFileIconTheme');
		const config = vscode.workspace.getConfiguration('workbench');
		const since = themes().length;
		await config.update('iconTheme', 'e2e-svg-icons', vscode.ConfigurationTarget.Global);
		try {
			// The definition is invalid (being written), so no theme is sent, and then it's written
			await waitFor('the unreadable theme to be sent', () => themes().slice(since).some((msg) => msg.theme === null));
			fs.writeFileSync(themeFile, JSON.stringify({ iconDefinitions: { _file: { iconPath: '../icons/file.svg' }, _python: { iconPath: '../icons/python.svg' } }, file: '_file', fileExtensions: { py: '_python' } }));
			const loaded = await waitFor('the theme to be loaded once it can be read', () => themes().slice(since).find((msg) => msg.theme !== null && msg.theme.id === 'e2e-svg-icons'));
			const python = loaded.theme.definitions[loaded.theme.fileExtensions.py];
			assert(/^https:\/\/.*vscode-resource.*\/icon-theme-extension\/icons\/python\.svg$/.test(python.iconPath) && loaded.theme.file === '_file', 'Unexpected theme: ' + JSON.stringify(loaded.theme.definitions));
			// A change to the definition is loaded
			const before = themes().length;
			fs.writeFileSync(themeFile, JSON.stringify({ iconDefinitions: { _file: { iconPath: '../icons/file.svg' }, _python: { iconPath: '../icons/python.svg' }, _excel: { iconPath: '../icons/excel.svg' } }, file: '_file', fileExtensions: { py: '_python', xlsx: '_excel' } }));
			const changed = await waitFor('the changed theme to be loaded', () => themes().slice(before).find((msg) => msg.theme !== null && msg.theme.fileExtensions.xlsx === '_excel'));
			return 'Loaded once readable (py: ' + python.iconPath.substring(python.iconPath.indexOf('/icons/')) + '), and again after it changed (xlsx: ' + changed.theme.definitions._excel.iconPath.substring(changed.theme.definitions._excel.iconPath.indexOf('/icons/')) + ')';
		} finally {
			await config.update('iconTheme', undefined, vscode.ConfigurationTarget.Global);
			await waitFor('the default theme to be sent again', () => { const last = themes().slice(-1)[0]; return last && last.theme !== null && last.theme.id === 'vs-seti'; }).catch(() => null);
			assert(view !== null, 'The view was closed');
		}
	});

	await check('#668', 'Repositories, submodules and worktrees in the workspace are all discovered', async () => {
		const view = await getView();
		const repos = await waitFor('the repositories to be discovered', () => {
			const repos = Object.keys(view.repoManager.getRepos());
			return [main, sub, wt].every((repo) => repos.includes(repo)) ? repos : null;
		}).catch((err) => {
			throw new Error(err.message + '. Discovered: ' + Object.keys(view.repoManager.getRepos()).join(', '));
		});
		return 'Repositories: ' + repos.map((repo) => path.relative(realpath(fixtures.workspace), repo)).join(', ');
	});

	// Migrating the Extension Settings from git-graph.* to git-map.* (run.js sets them under their old names). The ways it could go wrong,
	// which this check asserts don't happen: a value isn't copied (losing the user's setting), a value already set under the new name is
	// overwritten, a value is copied to a different scope (user / workspace), legacy names & values that are arrays aren't copied, the
	// settings are read before they're copied (#668 relies on git-map.maxDepthOfRepoSearch being copied before the repositories are
	// discovered), the old settings are removed without asking, the migration runs again (copying a value the user has reset since), and
	// removing the old settings fails (as they're no longer registered) or also removes the new ones.
	await check('settings-migration', '[Rename] The git-graph.* Extension Settings are copied to git-map.* when Git Map starts (once for the user & the workspace), and can then be removed', async () => {
		const { migrateSettings, removeOldSettings } = require(path.join(extension.extensionPath, 'out', 'settingsMigration.js'));
		const { Logger } = require(path.join(extension.extensionPath, 'out', 'logger.js'));
		const user = (section, name) => vscode.workspace.getConfiguration(section).inspect(name).globalValue;
		const workspace = (section, name) => vscode.workspace.getConfiguration(section).inspect(name).workspaceValue;
		const memento = (migrated) => {
			const values = { settingsMigratedToGitMap: migrated };
			return { get: (key, defaultValue) => key in values ? values[key] : defaultValue, update: async (key, value) => { values[key] = value; }, keys: () => Object.keys(values), values: values };
		};

		// Copied when Git Map started
		assert(user('git-map', 'maxDepthOfRepoSearch') === 2 && user('git-map', 'integratedTerminalShell') === '/bin/sh', 'The user settings weren\'t copied');
		assert(user('git-map', 'repository.commits.mute.mergeCommits') === true && JSON.stringify(user('git-map', 'customEmojiShortcodeMappings')) === JSON.stringify([{ shortcode: ':e2e-migrated:', emoji: '✅' }]), 'The legacy name or the array wasn\'t copied');
		assert(user('git-map', 'muteMergeCommits') === undefined && workspace('git-map', 'commitOrdering') === undefined, 'A deprecated (legacy) name was set');
		assert(user('git-map', 'tabIconColourTheme') === 'colour', 'The setting already set under its new name was overwritten');
		assert(workspace('git-map', 'fileEncoding') === 'utf8' && workspace('git-map', 'repository.commits.order') === 'date' && user('git-map', 'fileEncoding') === undefined && user('git-map', 'repository.commits.order') === undefined, 'The workspace settings weren\'t copied to the workspace');
		assert(user('git-graph', 'maxDepthOfRepoSearch') === 2 && workspace('git-graph', 'fileEncoding') === 'utf8', 'The old settings were removed without asking');

		const logger = new Logger();
		try {
			// Once migrated, a setting the user resets isn't copied again
			await vscode.workspace.getConfiguration('git-map').update('tabIconColourTheme', undefined, vscode.ConfigurationTarget.Global);
			const again = await migrateSettings(memento(true), memento(true), extension.packageJSON, logger);
			assert(again.copied.length === 0 && user('git-map', 'tabIconColourTheme') === undefined, 'The settings were migrated again: ' + JSON.stringify(again.copied));

			// Migrating (as when Git Map starts for the first time) only copies the settings that aren't set under their new names
			const globalState = memento(false), workspaceState = memento(false);
			const result = await migrateSettings(globalState, workspaceState, extension.packageJSON, logger);
			assert(JSON.stringify(result.copied) === JSON.stringify(['git-map.tabIconColourTheme (User)']) && user('git-map', 'tabIconColourTheme') === 'grey' && result.errors.length === 0, 'Unexpected migration: ' + JSON.stringify(result));
			assert(globalState.values.settingsMigratedToGitMap === true && workspaceState.values.settingsMigratedToGitMap === true, 'The migration wasn\'t recorded');
			const oldNames = result.oldValues.map((value) => value.name + (value.target === vscode.ConfigurationTarget.Global ? ' (User)' : ' (Workspace)')).sort();

			// Removing the old settings (from the notification) removes them from the settings files, keeping the new settings
			const errors = await removeOldSettings(result.oldValues, logger);
			const userSettings = fs.readFileSync(path.join(path.dirname(fixtures.workspace), 'user-data', 'User', 'settings.json'), 'utf8');
			const workspaceSettings = fs.readFileSync(path.join(fixtures.workspace, '.vscode', 'settings.json'), 'utf8');
			assert(errors.length === 0 && !userSettings.includes('"git-graph.') && !workspaceSettings.includes('"git-graph.'), 'The old settings weren\'t removed: ' + errors.join(', ') + '\n' + userSettings + '\n' + workspaceSettings);
			assert(user('git-map', 'maxDepthOfRepoSearch') === 2 && workspace('git-map', 'fileEncoding') === 'utf8' && user('git-map', 'repository.commits.mute.mergeCommits') === true, 'The new settings were removed');
			return 'Copied at startup (user: maxDepthOfRepoSearch, integratedTerminalShell, muteMergeCommits → repository.commits.mute.mergeCommits, customEmojiShortcodeMappings; workspace: fileEncoding, commitOrdering → repository.commits.order; tabIconColourTheme kept); not migrated again; removed ' + oldNames.join(', ');
		} finally {
			await vscode.workspace.getConfiguration('git-map').update('tabIconColourTheme', 'colour', vscode.ConfigurationTarget.Global);
		}
	});

	await check('#935', 'Commits after a commit whose subject contains a raw CR character are loaded (from the Webview)', async () => {
		await vscode.commands.executeCommand('git-map.view', { rootUri: vscode.Uri.file(main) }); // As invoked from the Source Control View
		const response = await waitForCommitsLoaded(record, main, { requests: 0, responses: 0 }); // The repository may already have been loaded when the view was opened
		const hashes = response.commits.map((commit) => commit.hash);
		const crCommit = response.commits.find((commit) => commit.hash === fixtures.crCommit);
		assert(crCommit, 'The commit containing a raw CR character is missing');
		assert(crCommit.message.includes('\r'), 'The raw CR character was not preserved in the subject');
		assert(hashes.includes(fixtures.firstCommit), 'The commits before the CR commit are missing: loaded ' + hashes.length + ' commits');
		return 'Loaded ' + hashes.length + ' commits, including ' + fixtures.firstCommit.substring(0, 8) + ' (before the CR commit)';
	});

	await check('#171', 'Commits can be filtered by author (a name containing regular expression characters is matched literally)', async () => {
		const dataSource = (await getView()).dataSource;
		const getHashes = async (authors) => {
			const result = await dataSource.getCommits(main, null, 300, true, true, false, false, 'date', ['origin'], [], [], authors);
			assert(result.error === null, 'Loading the commits failed: ' + result.error);
			return result.commits.filter((commit) => commit.hash !== '*').map((commit) => commit.hash);
		};
		const all = await getHashes(null);
		const secondAuthor = await getHashes([fixtures.secondAuthor]);
		assert(secondAuthor.length === 1 && secondAuthor[0] === fixtures.secondAuthorCommit, 'Unexpected commits for "' + fixtures.secondAuthor + '": ' + JSON.stringify(secondAuthor));
		const regexLike = await getHashes(['Dr. Q.A (Second)']); // "." must not match the "+" in the author's name
		assert(regexLike.length === 0, 'The author name was matched as a regular expression: ' + JSON.stringify(regexLike));
		const bothAuthors = await getHashes(['E2E Author', fixtures.secondAuthor]);
		assert(bothAuthors.length === all.length, 'Selecting all authors returned ' + bothAuthors.length + ' of ' + all.length + ' commits');
		return 'All authors: ' + all.length + ' commits, "' + fixtures.secondAuthor + '": 1 commit';
	});

	await check('ui-sync-search', '[Redesign] The repository info includes how far each branch is behind / ahead of its upstream, and commits can be searched by the files they change (file:) and the lines they add or remove (change:)', async () => {
		const dataSource = (await getView()).dataSource;
		git(main, 'branch', 'e2e-behind', fixtures.crCommit);
		git(main, 'branch', '--set-upstream-to=origin/main', 'e2e-behind');
		git(main, 'branch', 'e2e-gone', fixtures.firstCommit);
		git(main, 'config', 'branch.e2e-gone.remote', 'origin');
		git(main, 'config', 'branch.e2e-gone.merge', 'refs/heads/e2e-deleted');
		try {
			const info = await dataSource.getRepoInfo(main, true, false, []);
			assert(info.error === null, 'Loading the repository info failed: ' + info.error);
			const behind = info.upstreams['e2e-behind'], gone = info.upstreams['e2e-gone'];
			assert(behind && behind.name === 'origin/main' && behind.behind === 3 && behind.ahead === 0 && !behind.gone, 'Unexpected upstream of e2e-behind: ' + JSON.stringify(behind));
			assert(gone && gone.name === 'origin/e2e-deleted' && gone.gone, 'Unexpected upstream of e2e-gone: ' + JSON.stringify(gone));
			assert(typeof info.upstreams['main'] === 'undefined', 'main shouldn\'t have an upstream: ' + JSON.stringify(info.upstreams['main']));

			const search = async (files, changes, isRegex, isCaseSensitive) => {
				const result = await dataSource.searchCommits(main, files, changes, isRegex, isCaseSensitive, 0);
				assert(result.error === null, 'Searching failed: ' + result.error);
				return result.hashes;
			};
			const fileMatches = await search(['FILE.TXT'], [], false, false);
			assert(fileMatches.length === 4 && fileMatches.includes(fixtures.firstCommit) && fileMatches.includes(fixtures.secondAuthorCommit) && !fileMatches.includes(fixtures.headCommit), 'Unexpected commits changing FILE.TXT: ' + fileMatches.length);
			assert((await search(['FILE.TXT'], [], false, true)).length === 0, 'The case sensitive file search matched file.txt');
			const changeMatches = await search([], ['FOUR'], false, false);
			assert(changeMatches.length === 1 && changeMatches[0] === fixtures.secondAuthorCommit, 'Unexpected commits changing a line containing FOUR: ' + JSON.stringify(changeMatches));
			const literal = await search([], ['t.o'], false, true), regex = await search([], ['t.o'], true, true);
			assert(literal.length === 0 && regex.length === 2 && regex.includes(fixtures.crCommit), 'Unexpected commits changing t.o: ' + literal.length + ' (literal), ' + regex.length + ' (regular expression)');
			const both = await search(['file'], ['four', 'one'], false, false);
			assert(both.length === 0, 'A commit was matched by only one of the changes: ' + JSON.stringify(both));
			return 'e2e-behind: ' + behind.behind + ' behind ' + behind.name + ', e2e-gone: gone; file: ' + fileMatches.length + ' commits, change: ' + changeMatches.length + ' commit, t.o: ' + literal.length + ' literal / ' + regex.length + ' regex';
		} finally {
			git(main, 'branch', '-D', 'e2e-behind', 'e2e-gone');
		}
	});

	await check('ui-commit-stats', '[Redesign] The files & lines changed by commits (merge commits compared to their first parent) and the uncommitted changes are loaded for the Changes column', async () => {
		const dataSource = (await getView()).dataSource;
		const result = await dataSource.getCommitStats(main, [fixtures.firstCommit, fixtures.secondAuthorCommit, fixtures.headCommit, '*']);
		assert(result.error === null, 'Loading the stats failed: ' + result.error);
		const stats = result.stats;
		assert(JSON.stringify(stats[fixtures.firstCommit]) === JSON.stringify({ files: 1, additions: 1, deletions: 0 }) && JSON.stringify(stats[fixtures.secondAuthorCommit]) === JSON.stringify({ files: 1, additions: 1, deletions: 1 }) && stats[fixtures.headCommit].files === 2 && stats['*'] === null, 'Unexpected stats: ' + JSON.stringify(stats));
		// A merge commit is compared to its first parent
		const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'git-map-e2e-merge-'));
		try {
			git(repo, 'init', '-q', '-b', 'main');
			fs.writeFileSync(path.join(repo, 'a.txt'), '1\n');
			git(repo, 'add', '-A');
			git(repo, 'commit', '-q', '-m', 'a');
			git(repo, 'checkout', '-q', '-b', 'feature');
			fs.writeFileSync(path.join(repo, 'b.txt'), '1\n2\n3\n');
			git(repo, 'add', '-A');
			git(repo, 'commit', '-q', '-m', 'b');
			git(repo, 'checkout', '-q', 'main');
			fs.writeFileSync(path.join(repo, 'a.txt'), '1\nx\n');
			git(repo, 'commit', '-q', '-a', '-m', 'c');
			git(repo, 'merge', '-q', '--no-edit', 'feature');
			const merge = git(repo, 'rev-parse', 'HEAD');
			const mergeStats = (await dataSource.getCommitStats(repo, [merge])).stats[merge];
			assert(JSON.stringify(mergeStats) === JSON.stringify({ files: 1, additions: 3, deletions: 0 }), 'Unexpected stats of the merge commit: ' + JSON.stringify(mergeStats));
			return JSON.stringify(stats[fixtures.secondAuthorCommit]) + ', merge: ' + JSON.stringify(mergeStats);
		} finally {
			fs.rmSync(repo, { recursive: true, force: true });
		}
	});

	await check('ui-stash-stats', '[Redesign] The stats of a stash (the files it changes, lines added & deleted, and untracked files it includes) are loaded for the list of stashes', async () => {
		const dataSource = (await getView()).dataSource;
		fs.writeFileSync(path.join(main, 'file.txt'), 'four\nfive\nsix\n');
		fs.writeFileSync(path.join(main, 'e2e-untracked.txt'), 'untracked\n');
		git(main, 'stash', 'push', '--include-untracked', '-m', 'E2E stash');
		try {
			const info = await dataSource.getRepoInfo(main, true, true, []);
			const stash = info.stashes.find((stash) => stash.message.includes('E2E stash'));
			assert(stash && stash.untrackedFilesHash !== null, 'The stash with untracked files is missing: ' + JSON.stringify(info.stashes));
			const result = await dataSource.getStashStats(main, [stash]);
			const stats = result.stats[stash.hash];
			assert(result.error === null && stats && stats.files === 2 && stats.additions === 2 && stats.deletions === 0 && stats.untrackedFiles === 1, 'Unexpected stats: ' + JSON.stringify(result));
			return stash.selector + ': ' + JSON.stringify(stats);
		} finally {
			git(main, 'stash', 'drop');
		}
	});

	await check('ui-file-history', '[Redesign] The history of a file follows it through renames, with the parents of its commits rewritten (so the graph is connected), the changes to the file in each commit, and its diff', async () => {
		const dataSource = (await getView()).dataSource;
		const commands = await vscode.commands.getCommands(true);
		assert(commands.includes('git-map.viewFileHistory'), 'The View File History command isn\'t registered');
		const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'git-map-e2e-history-')); // Outside of the workspace, so it isn't discovered
		try {
			git(repo, 'init', '-q', '-b', 'main');
			fs.mkdirSync(path.join(repo, 'dir'));
			const commit = (message) => {
				git(repo, 'add', '-A');
				git(repo, 'commit', '-q', '-m', message);
				return git(repo, 'rev-parse', 'HEAD');
			};
			fs.writeFileSync(path.join(repo, 'dir', 'old.txt'), '1\n2\n3\n');
			const a = commit('a');
			fs.writeFileSync(path.join(repo, 'dir', 'old.txt'), '1\n2\n3\n4\n');
			const b = commit('b');
			fs.renameSync(path.join(repo, 'dir', 'old.txt'), path.join(repo, 'dir', '新.txt'));
			fs.writeFileSync(path.join(repo, 'dir', '新.txt'), '1\n2\n3\n4\n5\n');
			const c = commit('c (rename)');
			fs.writeFileSync(path.join(repo, 'other.txt'), 'x\n');
			commit('d (another file)');
			fs.writeFileSync(path.join(repo, 'dir', '新.txt'), '0\n1\n2\n3\n4\n5\n');
			const e = commit('e');

			const result = await dataSource.getCommits(repo, null, 100, true, true, false, false, 'date', [], [], [], null, 'dir/新.txt');
			assert(result.error === null, 'Loading the history failed: ' + result.error);
			const graph = result.commits.map((commit) => commit.hash + '>' + commit.parents.join(','));
			assert(JSON.stringify(graph) === JSON.stringify([e + '>' + c, c + '>' + b, b + '>' + a, a + '>']), 'Unexpected history: ' + JSON.stringify(result.commits.map((commit) => commit.message)));
			const history = result.fileHistory;
			assert(history !== null && JSON.stringify(history.paths) === JSON.stringify(['dir/新.txt', 'dir/old.txt']), 'Unexpected paths: ' + JSON.stringify(history && history.paths));
			assert(history.commits[c].oldFilePath === 'dir/old.txt' && history.commits[c].filePath === 'dir/新.txt' && history.commits[c].additions === 1 && history.commits[e].additions === 1 && history.commits[a].additions === 3 && history.commits[a].filePath === 'dir/old.txt', 'Unexpected changes: ' + JSON.stringify(history.commits));

			const diff = await dataSource.getFileDiff(repo, c, b, 'dir/old.txt', 'dir/新.txt');
			assert(diff.error === null && diff.diff.includes('rename from dir/old.txt') && /^\+5$/m.test(diff.diff), 'Unexpected diff: ' + diff.diff);
			const rootDiff = await dataSource.getFileDiff(repo, a, null, 'dir/old.txt', 'dir/old.txt');
			assert(rootDiff.error === null && /^\+1$/m.test(rootDiff.diff), 'Unexpected diff of the root commit: ' + rootDiff.diff);
			return result.commits.length + ' commits, renamed from dir/old.txt, diff of the rename: ' + diff.diff.split('\n').length + ' lines';
		} finally {
			fs.rmSync(repo, { recursive: true, force: true });
		}
	});

	await check('ui-file-history-command', '[Redesign] The "View File History in Git Map" command opens the view showing the history of the file (relative to its repository)', async () => {
		await getView();
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
		const since = { requests: record.requests.length, responses: record.responses.length };
		await vscode.commands.executeCommand('git-map.viewFileHistory', vscode.Uri.file(path.join(main, 'file.txt')));
		const request = await waitFor('the history of file.txt to be requested', () => record.requests.slice(since.requests).find((msg) => msg.command === 'loadCommits' && msg.repo === main && msg.filePath === 'file.txt'));
		const response = await waitFor('the history to be loaded', () => record.responses.slice(since.responses).find((msg) => msg.command === 'loadCommits' && msg.refreshId === request.refreshId));
		const hashes = response.commits.map((commit) => commit.hash);
		assert(response.error === null && response.fileHistory !== null && hashes.length === 4 && hashes.includes(fixtures.firstCommit) && hashes.includes(fixtures.secondAuthorCommit) && !hashes.includes(fixtures.headCommit), 'Unexpected history of file.txt: ' + hashes.length + ' commits');
		// The latest commit that changed the file is selected (its details are opened)
		const latest = git(main, 'log', '-n', '1', '--format=%H', '--', 'file.txt');
		await waitFor('the latest commit of file.txt to be selected', () => record.requests.slice(since.requests).some((msg) => msg.command === 'commitDetails' && msg.commitHash === latest));
		// Exit the history of the file (so all commits are shown for the following checks), in the view that was opened (as closing the editors closed the previous one)
		const exitSince = record.requests.length, opened = await getView();
		opened.respondLoadRepos(opened.repoManager.getRepos(), { repo: main, fileHistory: null });
		await waitFor('all of the commits to be requested', () => record.requests.slice(exitSince).some((msg) => msg.command === 'loadCommits' && msg.repo === main && msg.filePath === null))
			.catch((err) => { throw new Error(err.message + ' (requests: ' + record.requests.slice(exitSince).map((msg) => msg.command + (msg.command === 'loadCommits' ? ' ' + msg.filePath : '')).join(', ') + ')'); });
		return 'file.txt: ' + hashes.length + ' commits, the latest selected';
	});

	await check('#940', 'Interactive rebase on a branch whose name contains shell syntax does not execute it', async () => {
		const dataSource = (await getView()).dataSource;
		assert(!fs.existsSync(fixtures.injectionMarker), 'The marker exists before the rebase');
		const reflogBefore = git(main, 'reflog', '--format=%gs').split('\n').length;
		const error = await dataSource.rebase(main, fixtures.injectionBranch, 'Branch', false, true);
		assert(error === null, 'Rebase returned an error: ' + error);
		const terminal = vscode.window.terminals.find((terminal) => terminal.name === 'Git Map: Rebase on "' + fixtures.injectionBranch + '"');
		assert(terminal, 'The interactive rebase terminal was not opened');
		// The rebase runs in the Integrated Terminal, wait for it to finish
		await waitFor('the interactive rebase to finish', () => {
			assert(!fs.existsSync(fixtures.injectionMarker), 'The command substitution in the branch name was executed by the shell');
			const reflog = git(main, 'reflog', '--format=%gs').split('\n');
			return reflog.length > reflogBefore && reflog.some((entry) => /^rebase.*\(finish\)/.test(entry));
		}, 30000);
		await sleep(1000);
		assert(!fs.existsSync(fixtures.injectionMarker), 'The command substitution in the branch name was executed by the shell');
		return 'Rebase completed in the terminal, and the marker file was not created';
	});
	vscode.window.terminals.forEach((terminal) => terminal.dispose());

	await check('#708', 'Tags & branches that share a name can be deleted from and pushed to a remote', async () => {
		const dataSource = (await getView()).dataSource;
		const remoteRefs = () => git(main, 'ls-remote', 'origin').split('\n').map((line) => line.split('\t')[1]);

		let error = await dataSource.deleteTag(main, 'asd', 'origin');
		assert(error === null, 'Deleting the tag failed: ' + error);
		assert(!remoteRefs().includes('refs/tags/asd') && remoteRefs().includes('refs/heads/asd'), 'Unexpected remote refs after deleting the tag: ' + remoteRefs().join(', '));

		git(main, 'tag', 'asd', fixtures.crCommit);
		const errors = await dataSource.pushTag(main, 'asd', ['origin'], fixtures.crCommit, true);
		assert(errors.length === 1 && errors[0] === null, 'Pushing the tag failed: ' + errors.join(', '));
		assert(remoteRefs().includes('refs/tags/asd'), 'The tag was not pushed');

		git(main, 'branch', '-f', 'asd', fixtures.crCommit);
		error = await dataSource.pushBranch(main, 'asd', 'origin', false, '');
		assert(error === null, 'Pushing the branch failed: ' + error);
		assert(git(main, 'ls-remote', 'origin', 'refs/heads/asd').startsWith(fixtures.crCommit), 'The branch was not pushed');

		error = await dataSource.deleteRemoteBranch(main, 'asd', 'origin');
		assert(error === null, 'Deleting the remote branch failed: ' + error);
		assert(!remoteRefs().includes('refs/heads/asd') && remoteRefs().includes('refs/tags/asd'), 'Unexpected remote refs after deleting the branch: ' + remoteRefs().join(', '));
	});

	await check('cherry-pick-commits', '[GitLens] Several selected commits are cherry picked together, oldest first (recording their origin if chosen)', async () => {
		const view = await getView(), dataSource = view.dataSource;
		const repo = createScratchRepo('cherry-pick', { 'base.txt': 'base\n' });
		git(repo, 'checkout', '-q', '-b', 'feature');
		const a = commitFile(repo, 'a.txt', 'a\n', 'Add a'), b = commitFile(repo, 'b.txt', 'b\n', 'Add b'), c = commitFile(repo, 'c.txt', 'c\n', 'Add c');
		git(repo, 'checkout', '-q', 'main');

		const error = await dataSource.cherrypickCommits(repo, [a, c], false, false);
		assert(error === null, 'Cherry picking failed: ' + error);
		const subjects = git(repo, 'log', '--format=%s', '-3').split('\n');
		assert(JSON.stringify(subjects) === JSON.stringify(['Add c', 'Add a', 'Initial commit']), 'Unexpected commits: ' + JSON.stringify(subjects));

		// The request from the Webview, recording the origin of each commit
		const count = record.responses.filter((msg) => msg.command === 'cherrypickCommits').length;
		await view.respondToMessage({ command: 'cherrypickCommits', repo: repo, commitHashes: [b], recordOrigin: true, noCommit: false });
		const response = await waitFor('the response', () => record.responses.filter((msg) => msg.command === 'cherrypickCommits')[count]);
		const body = git(repo, 'log', '-1', '--format=%B');
		assert(response.errors.every((error) => error === null) && body.includes('(cherry picked from commit ' + b + ')'), 'Unexpected result: ' + JSON.stringify(response) + ', ' + body);
		return 'main: ' + git(repo, 'log', '--format=%s', '-4').split('\n').join(' ← ');
	});

	// Undoing Git Map's actions. The ways it could go wrong, which these checks assert don't happen: losing uncommitted changes or
	// untracked files, undoing after the repository was changed by something else (or while a merge is in progress), restoring a
	// different commit / tag object than was there, losing a branch's upstream, and offering to undo after it was undone.
	const undoHelpers = (view, repo) => {
		// The response to a message (the view also loads the info of its repository itself, e.g. when it's refreshed after an action)
		const respond = async (msg, command, matches = () => true) => {
			const count = record.responses.filter((response) => response.command === command).length;
			await view.respondToMessage(msg);
			return waitFor('the ' + command + ' response', () => record.responses.filter((response) => response.command === command).slice(count).find(matches));
		};
		let refreshId = 1000;
		return {
			respond: respond,
			undoInfo: async () => {
				const id = ++refreshId;
				return (await respond({ command: 'loadRepoInfo', repo: repo, refreshId: id, showRemoteBranches: true, showStashes: true, hideRemotes: [] }, 'loadRepoInfo', (response) => response.refreshId === id)).undo;
			},
			undo: async () => (await respond({ command: 'undo', repo: repo }, 'undo')).error
		};
	};

	await check('undo-merge', '[GitKraken] A merge can be undone (keeping uncommitted changes & untracked files), unless the repository has changed since', async () => {
		const view = await getView();
		const repo = createScratchRepo('undo-merge', { 'a.txt': 'a\n' });
		const { respond, undoInfo, undo } = undoHelpers(view, repo);
		git(repo, 'checkout', '-q', '-b', 'feature');
		commitFile(repo, 'b.txt', 'b\n', 'Add b');
		git(repo, 'checkout', '-q', 'main');
		const beforeMerge = commitFile(repo, 'c.txt', 'c\n', 'Add c');
		fs.writeFileSync(path.join(repo, 'a.txt'), 'a (changed locally)\n');
		fs.writeFileSync(path.join(repo, 'untracked.txt'), 'untracked\n');

		const merged = await respond({ command: 'merge', repo: repo, obj: 'feature', actionOn: 'Branch', createNewCommit: true, squash: false, noCommit: false }, 'merge');
		assert(merged.error === null && git(repo, 'rev-parse', 'HEAD') !== beforeMerge, 'The merge failed: ' + merged.error);
		const info = await undoInfo();
		assert(info && info.description === 'Merge "feature"', 'The merge can\'t be undone: ' + JSON.stringify(info));
		const error = await undo();
		assert(error === null, 'Undo failed: ' + error);
		assert(git(repo, 'rev-parse', 'HEAD') === beforeMerge && git(repo, 'symbolic-ref', '--short', 'HEAD') === 'main', 'HEAD wasn\'t restored: ' + git(repo, 'log', '--oneline', '-3'));
		assert(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8') === 'a (changed locally)\n' && fs.existsSync(path.join(repo, 'untracked.txt')), 'The uncommitted changes or untracked files were lost');
		assert(await undoInfo() === null, 'Undo is still offered after it was undone');

		// Undo is refused when the repository has been changed by something else since
		await respond({ command: 'merge', repo: repo, obj: 'feature', actionOn: 'Branch', createNewCommit: true, squash: false, noCommit: false }, 'merge');
		git(repo, 'commit', '-q', '--allow-empty', '-m', 'Committed outside of Git Map');
		const afterExternal = git(repo, 'rev-parse', 'HEAD');
		const refused = await undo();
		assert(refused !== null && refused.includes('has changed') && git(repo, 'rev-parse', 'HEAD') === afterExternal, 'Undo wasn\'t refused after an external commit: ' + refused);

		// Undo is refused while a merge is in progress (after an action that can be undone)
		git(repo, 'checkout', '-q', '-b', 'side', beforeMerge);
		const sideCommit = commitFile(repo, 'd.txt', 'd\n', 'Add d');
		commitFile(repo, 'c.txt', 'c (side)\n', 'Change c on side');
		git(repo, 'checkout', '-q', 'main');
		commitFile(repo, 'c.txt', 'c (main)\n', 'Change c on main');
		const picked = await respond({ command: 'cherrypickCommit', repo: repo, commitHash: sideCommit, parentIndex: 0, recordOrigin: false, noCommit: false }, 'cherrypickCommit');
		assert(picked.errors[0] === null && (await undoInfo()) !== null, 'The cherry pick can\'t be undone: ' + JSON.stringify(picked));
		try {
			git(repo, 'merge', 'side');
		} catch (_) { /* The merge conflicts */ }
		const inProgress = await undo();
		assert(inProgress !== null && inProgress.includes('in progress') && fs.existsSync(path.join(repo, '.git', 'MERGE_HEAD')), 'Undo wasn\'t refused while a merge is in progress: ' + inProgress);
		git(repo, 'merge', '--abort');
		return 'Undid the merge (local changes & untracked files kept); refused: "' + refused + '"; "' + inProgress + '"';
	});

	await check('undo-refs', '[GitKraken] Creating, deleting, checking out & renaming branches and tags can be undone (restoring the same commits, tag objects & upstreams)', async () => {
		const view = await getView();
		const repo = createScratchRepo('undo-refs', { 'a.txt': 'a\n' });
		const { respond, undoInfo, undo } = undoHelpers(view, repo);
		const first = git(repo, 'rev-parse', 'HEAD'), second = commitFile(repo, 'b.txt', 'b\n', 'Add b');
		const results = [];

		// Delete a branch (with an upstream)
		git(repo, 'branch', 'topic', first);
		git(repo, 'config', 'branch.topic.remote', 'origin');
		git(repo, 'config', 'branch.topic.merge', 'refs/heads/topic');
		await respond({ command: 'deleteBranch', repo: repo, branchName: 'topic', forceDelete: true, deleteOnRemotes: [] }, 'deleteBranch');
		assert((await undoInfo()).description === 'Delete Branch "topic"' && await undo() === null, 'Deleting the branch couldn\'t be undone');
		assert(git(repo, 'rev-parse', 'topic') === first && git(repo, 'config', 'branch.topic.merge') === 'refs/heads/topic', 'The branch or its upstream wasn\'t restored');
		results.push('deleted branch restored with its upstream');

		// Delete an annotated tag
		git(repo, 'tag', '-a', 'v1.0', '-m', 'Version 1.0', first);
		const tagObject = git(repo, 'rev-parse', 'refs/tags/v1.0');
		await respond({ command: 'deleteTag', repo: repo, tagName: 'v1.0', deleteOnRemote: null }, 'deleteTag');
		assert((await undoInfo()).description === 'Delete Tag "v1.0"' && await undo() === null, 'Deleting the tag couldn\'t be undone');
		assert(git(repo, 'rev-parse', 'refs/tags/v1.0') === tagObject && git(repo, 'cat-file', '-t', 'v1.0') === 'tag', 'A different tag object was restored');
		results.push('deleted annotated tag restored (same tag object)');

		// Add a tag
		await respond({ command: 'addTag', repo: repo, tagName: 'v2.0', commitHash: second, type: 'lightweight', message: '', pushToRemote: null, pushSkipRemoteCheck: false, force: false }, 'addTag');
		assert((await undoInfo()).description === 'Add Tag "v2.0"' && await undo() === null && git(repo, 'tag', '-l', 'v2.0') === '', 'Adding the tag couldn\'t be undone');
		results.push('added tag removed');

		// Create a branch & check it out
		await respond({ command: 'createBranch', repo: repo, branchName: 'new-branch', commitHash: first, checkout: true, force: false }, 'createBranch');
		assert(git(repo, 'symbolic-ref', '--short', 'HEAD') === 'new-branch', 'The branch wasn\'t checked out');
		assert((await undoInfo()).description === 'Create Branch "new-branch"' && await undo() === null, 'Creating the branch couldn\'t be undone');
		assert(git(repo, 'symbolic-ref', '--short', 'HEAD') === 'main' && git(repo, 'branch', '--list', 'new-branch') === '', 'The previous branch wasn\'t checked out, or the branch wasn\'t deleted');
		results.push('created & checked out branch removed');

		// Check out a branch
		await respond({ command: 'checkoutBranch', repo: repo, branchName: 'topic', remoteBranch: null, pullAfterwards: null }, 'checkoutBranch');
		assert((await undoInfo()).description === 'Checkout "topic"' && await undo() === null && git(repo, 'symbolic-ref', '--short', 'HEAD') === 'main', 'Checking out the branch couldn\'t be undone');
		results.push('checkout undone');

		// Rename a branch
		await respond({ command: 'renameBranch', repo: repo, oldName: 'topic', newName: 'renamed' }, 'renameBranch');
		assert((await undoInfo()).description === 'Rename Branch "topic"' && await undo() === null && git(repo, 'rev-parse', 'topic') === first && git(repo, 'branch', '--list', 'renamed') === '', 'Renaming the branch couldn\'t be undone');
		results.push('rename undone');
		return results.join('; ');
	});

	await check('undo-stash', '[GitKraken] Dropping a stash can be undone (the same stash is restored)', async () => {
		const view = await getView();
		const repo = createScratchRepo('undo-stash', { 'a.txt': 'a\n' });
		const { respond, undoInfo, undo } = undoHelpers(view, repo);
		fs.writeFileSync(path.join(repo, 'a.txt'), 'a (stashed)\n');
		git(repo, 'stash', 'push', '-q', '-m', 'Work in progress');
		const stash = git(repo, 'rev-parse', 'stash@{0}');
		await respond({ command: 'dropStash', repo: repo, selector: 'refs/stash@{0}' }, 'dropStash');
		assert(git(repo, 'stash', 'list') === '', 'The stash wasn\'t dropped');
		assert((await undoInfo()).description === 'Drop Stash "stash@{0}"' && await undo() === null, 'Dropping the stash couldn\'t be undone');
		assert(git(repo, 'rev-parse', 'stash@{0}') === stash && git(repo, 'stash', 'list').includes('Work in progress'), 'The stash wasn\'t restored: ' + git(repo, 'stash', 'list'));
		return 'Restored ' + git(repo, 'stash', 'list');
	});

	await check('worktrees', '[GitLens] The worktrees of a repository are listed, and can be added (for a branch, or at a commit), removed (only forced if they have changes) & pruned', async () => {
		const view = await getView();
		// The response to a message (the view also loads the worktrees of its repository itself, e.g. when it's refreshed after an action)
		const respond = async (msg, command, matches = () => true) => {
			const count = record.responses.filter((response) => response.command === command).length;
			await view.respondToMessage(msg);
			return waitFor('the ' + command + ' response', () => record.responses.filter((response) => response.command === command).slice(count).find(matches));
		};
		const list = async (repo) => {
			const response = await respond({ command: 'loadWorktrees', repo: repo }, 'loadWorktrees', (response) => response.repo === repo);
			assert(response.error === null, 'Loading the worktrees failed: ' + response.error);
			return response.worktrees;
		};

		// The worktrees of the main repository of the workspace
		const mainWorktrees = await list(main);
		assert(mainWorktrees.length === 2 && mainWorktrees[0].isMain && mainWorktrees[0].isCurrent && mainWorktrees[0].branch === 'main' && realpath(mainWorktrees[1].path) === wt && mainWorktrees[1].branch === 'wt-branch' && !mainWorktrees[1].isCurrent, 'Unexpected worktrees: ' + JSON.stringify(mainWorktrees));

		const repo = createScratchRepo('worktrees', { 'a.txt': 'a\n' }), first = git(repo, 'rev-parse', 'HEAD');
		const second = commitFile(repo, 'b.txt', 'b\n', 'Add b');
		const worktreePath = (name) => path.join(path.dirname(repo), 'worktrees-' + name).replace(/\\/g, '/');

		// A branch that's checked out (in the main worktree) can't be checked out in another worktree
		const checkedOut = await respond({ command: 'addWorktree', repo: repo, path: worktreePath('main'), ref: 'main', newBranch: null, open: false }, 'addWorktree');
		assert(checkedOut.errors[0] !== null && !fs.existsSync(worktreePath('main')), 'A checked out branch was added as a worktree');

		// A new branch, and a commit (detached HEAD)
		let added = await respond({ command: 'addWorktree', repo: repo, path: worktreePath('feature'), ref: 'main', newBranch: 'feature-wt', open: false }, 'addWorktree');
		assert(added.errors.length === 1 && added.errors[0] === null, 'Adding the worktree of a new branch failed: ' + JSON.stringify(added.errors));
		added = await respond({ command: 'addWorktree', repo: repo, path: worktreePath('detached'), ref: first, newBranch: null, open: false }, 'addWorktree');
		assert(added.errors[0] === null, 'Adding the worktree at a commit failed: ' + JSON.stringify(added.errors));
		let worktrees = await list(repo);
		const feature = worktrees.find((worktree) => worktree.branch === 'feature-wt'), detached = worktrees.find((worktree) => worktree.head === first);
		assert(worktrees.length === 3 && feature && feature.head === second && detached && detached.branch === null, 'Unexpected worktrees: ' + JSON.stringify(worktrees));

		// A worktree with uncommitted changes is only removed when forced
		fs.writeFileSync(path.join(worktreePath('feature'), 'a.txt'), 'a (changed)\n');
		const refused = await respond({ command: 'removeWorktree', repo: repo, path: worktreePath('feature'), force: false }, 'removeWorktree');
		assert(refused.error !== null && fs.existsSync(worktreePath('feature')), 'A worktree with uncommitted changes was removed without being forced');
		const forced = await respond({ command: 'removeWorktree', repo: repo, path: worktreePath('feature'), force: true }, 'removeWorktree');
		assert(forced.error === null && !fs.existsSync(worktreePath('feature')) && git(repo, 'rev-parse', 'feature-wt') === second, 'Forcing the removal failed (or the branch was removed): ' + forced.error);

		// A worktree whose directory was deleted is pruned
		fs.rmSync(worktreePath('detached'), { recursive: true, force: true });
		worktrees = await list(repo);
		assert(worktrees.length === 2 && worktrees[1].prunable, 'The deleted worktree isn\'t prunable: ' + JSON.stringify(worktrees));
		const pruned = await respond({ command: 'pruneWorktrees', repo: repo }, 'pruneWorktrees');
		worktrees = await list(repo);
		assert(pruned.error === null && worktrees.length === 1 && worktrees[0].isCurrent, 'The worktree wasn\'t pruned: ' + JSON.stringify(worktrees));
		return 'Workspace: ' + mainWorktrees.map((worktree) => worktree.branch).join(', ') + '; refused a checked out branch: "' + checkedOut.errors[0].trim().split('\n')[0] + '"; removal refused without force: "' + refused.error.trim().split('\n')[0] + '"; pruned';
	});

	await check('line-history', '[GitLens] The history of a range of lines only includes the commits that change them (following them as they move, and the file through renames), with the graph kept connected', async () => {
		const dataSource = (await getView()).dataSource;
		const lines = (changes) => Array.from({ length: 10 }, (_, i) => (changes[i + 1] || 'line ' + (i + 1)) + '\n').join('');
		const repo = createScratchRepo('line-history', { 'code.txt': lines({}) });
		const created = git(repo, 'rev-parse', 'HEAD');
		const changed3 = commitFile(repo, 'code.txt', lines({ 3: 'line 3 (changed)' }), 'Change line 3');
		const changed8 = commitFile(repo, 'code.txt', lines({ 3: 'line 3 (changed)', 8: 'line 8 (changed)' }), 'Change line 8');
		// Two lines are added above, so the line moves to line 5 (and the file is renamed)
		fs.writeFileSync(path.join(repo, 'code.txt'), 'new 1\nnew 2\n' + lines({ 3: 'line 3 (changed again)', 8: 'line 8 (changed)' }));
		git(repo, 'add', 'code.txt');
		git(repo, 'commit', '-q', '-m', 'Change line 3 again');
		const changedAgain = git(repo, 'rev-parse', 'HEAD');
		git(repo, 'mv', 'code.txt', 'renamed.txt');
		git(repo, 'commit', '-q', '-m', 'Rename the file');

		const data = await dataSource.getCommits(repo, null, 300, true, true, false, false, 'date', [], [], [], null, 'renamed.txt', { start: 5, end: 5 });
		assert(data.error === null, 'Loading the line history failed: ' + data.error);
		const hashes = data.commits.map((commit) => commit.hash), history = data.fileHistory;
		assert(JSON.stringify(hashes) === JSON.stringify([changedAgain, changed3, created]) && !hashes.includes(changed8), 'Unexpected commits: ' + data.commits.map((commit) => commit.message).join(', '));
		assert(JSON.stringify(data.commits.map((commit) => commit.parents)) === JSON.stringify([[changed3], [created], []]), 'The graph isn\'t connected: ' + JSON.stringify(data.commits.map((commit) => commit.parents)));
		assert(history.lineRange.start === 5 && history.commits[changed3].additions === 1 && history.commits[changed3].deletions === 1 && history.commits[changedAgain].additions === 1, 'Unexpected changes to the line: ' + JSON.stringify(history.commits));

		// The "View Line History in Git Map" command shows the history of the selected lines of the active editor
		const document = await vscode.workspace.openTextDocument(path.join(main, 'file.txt'));
		const editor = await vscode.window.showTextDocument(document);
		editor.selection = new vscode.Selection(0, 0, 0, 2);
		const since = record.requests.length;
		await vscode.commands.executeCommand('git-map.viewLineHistoryInGitMap');
		const request = await waitFor('the Webview to request the line history', () => record.requests.slice(since).find((msg) => msg.command === 'loadCommits' && msg.filePath === 'file.txt' && msg.lineRange))
			.catch((err) => { throw new Error(err.message + ' (requests: ' + record.requests.slice(since).map((msg) => msg.command + (msg.command === 'loadCommits' ? ' ' + msg.repo + ' ' + msg.filePath + ' ' + JSON.stringify(msg.lineRange) : '')).join(', ') + '; HTML loadViewTo: ' + (record.html.length > 0 ? (record.html[record.html.length - 1].match(/"loadViewTo":(\{[^}]*\}[^,]*)/) || [])[1] : '') + ')'); });
		assert(request.repo === main && request.lineRange.start === 1 && request.lineRange.end === 1, 'Unexpected request: ' + JSON.stringify(request));
		const response = await waitFor('the line history', () => record.responses.find((msg) => msg.command === 'loadCommits' && msg.refreshId === request.refreshId));
		const shown = response.commits.map((commit) => commit.hash);
		assert(shown.includes(fixtures.firstCommit) && shown.includes(fixtures.secondAuthorCommit) && !shown.includes(fixtures.headCommit), 'Unexpected line history: ' + response.commits.map((commit) => commit.message).join(', '));
		await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
		return 'Line 5 of renamed.txt: ' + data.commits.map((commit) => commit.message).join(' ← ') + '; command: line 1 of file.txt (' + shown.length + ' commits)';
	});

	await check('line-blame', '[GitLens] The line the cursor is on is blamed using the contents of the editor (so lines of files with uncommitted changes match), and the blame links to the commit in Git Map', async () => {
		const view = await getView(), dataSource = view.dataSource;
		const repo = createScratchRepo('line-blame', { 'code.txt': 'one\ntwo\nthree\n' });
		const changedTwo = commitFile(repo, 'code.txt', 'one\ntwo (changed)\nthree\n', 'Change line two');
		// Uncommitted changes add a line above the blamed line
		const contents = 'zero (uncommitted)\none\ntwo (changed)\nthree\n';
		const blame = await dataSource.getLineBlame(repo, 'code.txt', 3, contents), uncommitted = await dataSource.getLineBlame(repo, 'code.txt', 1, contents);
		assert(blame !== null && blame.hash === changedTwo && blame.committed && blame.summary === 'Change line two' && blame.author === 'E2E Author' && blame.authorEmail === 'author@example.com', 'Unexpected blame: ' + JSON.stringify(blame));
		assert(uncommitted !== null && !uncommitted.committed, 'The uncommitted line wasn\'t recognised: ' + JSON.stringify(uncommitted));
		const { getBlameText } = require(path.join(extension.extensionPath, 'out', 'lineBlame.js'));
		const text = getBlameText(blame);
		assert(/^E2E Author, \d+ seconds? ago • Change line two$/.test(text) && getBlameText(uncommitted) === 'You, Uncommitted changes', 'Unexpected text: ' + text);
		assert(await dataSource.getLineBlame(repo, 'untracked.txt', 1, 'x\n') === null, 'An untracked file was blamed');

		// The link opens the commit in the Git Map View (as soon as the view, which was just shown again, has loaded)
		const since = record.requests.length;
		await vscode.commands.executeCommand('git-map.viewCommitInGitMap', main, fixtures.firstCommit);
		const details = await waitFor('the details of the commit to be requested', () => record.requests.slice(since).find((msg) => msg.command === 'commitDetails' && msg.commitHash === fixtures.firstCommit))
			.catch((err) => { throw new Error(err.message + ' (requests: ' + record.requests.slice(since).map((msg) => msg.command + (msg.repo ? ' ' + msg.repo : '')).join(', ') + ')'); });
		return 'Blame: ' + text + '; the link requested the details of ' + details.commitHash.substring(0, 8);
	});

	// The history of lines in the drawer & the inline window. The ways it could go wrong, which these checks assert don't happen: the history
	// is of the wrong lines (the editor has uncommitted changes above them, or the selected line itself is changed), the uncommitted changes
	// are missing, commits that don't change the lines are included (or ones that do are missing, e.g. before the file was renamed), the diff
	// of a change isn't how it changed the lines, the drawer or the inline window doesn't show the history (or the inline window can be
	// replied to, or lacks the authors, dates & avatars, or isn't closed), the actions open the wrong revision or don't select the lines, the
	// remote link is to the wrong commit or lines, and the drawer doesn't follow the cursor (or follows it when it shouldn't).
	await check('line-history-drawer', '[GitLens] The history of lines (right-click > Git Map > View Line History) is shown in a drawer on the right, or an inline window below the lines: the uncommitted changes & each commit that changed them, with its author, date & avatar', async () => {
		const view = await getView();
		const { LineHistory } = require(path.join(extension.extensionPath, 'out', 'lineHistory.js'));
		const { getLineHistoryPage } = require(path.join(extension.extensionPath, 'out', 'lineHistoryDrawer.js'));
		const lineHistory = LineHistory.getInstance();
		assert(lineHistory !== null, 'The Line History isn\'t created');
		const lines = (changes) => Array.from({ length: 12 }, (_, i) => (changes[i + 1] || 'line ' + (i + 1)) + '\n').join('');
		const repo = createScratchRepo('line-history-drawer', { 'app.ts': lines({}) });
		const created = git(repo, 'rev-parse', 'HEAD');
		const commitAs = (file, contents, message, name, email) => {
			fs.writeFileSync(path.join(repo, file), contents);
			git(repo, 'add', '-A');
			cp.execFileSync('git', ['commit', '-q', '-m', message], { cwd: repo, env: Object.assign({}, GIT_ENV, { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email }) });
			return git(repo, 'rev-parse', 'HEAD');
		};
		const bySecond = commitAs('app.ts', lines({ 4: 'line 4 (second)' }), 'Change line 4', 'Second Author', 'second@example.com');
		commitFile(repo, 'app.ts', lines({ 4: 'line 4 (second)', 9: 'line 9 (changed)' }), 'Change line 9');
		git(repo, 'mv', 'app.ts', 'src.ts');
		git(repo, 'commit', '-q', '-m', 'Rename app.ts to src.ts');
		const latest = commitFile(repo, 'src.ts', lines({ 4: 'line 4 (latest)', 9: 'line 9 (changed)' }), 'Change line 4 again');
		git(repo, 'remote', 'add', 'origin', 'git@github.com:e2e-owner/e2e-repo.git');
		await view.repoManager.registerRepo(repo, false);
		const config = () => vscode.workspace.getConfiguration('git-map');
		const shown = () => lineHistory.getShown();
		const waitForHistory = (description, condition) => waitFor(description, () => shown() !== null && condition(shown()) ? shown() : null)
			.catch((err) => { throw new Error(err.message + ' (shown: ' + JSON.stringify(shown() !== null ? { range: shown().target.range, headRange: shown().history.headRange, entries: shown().history.entries.map((entry) => entry.subject || entry.hash) } : null) + ')'); });

		// Two uncommitted lines are added at the top (unsaved), so lines 6-7 of the editor are lines 4-5 in HEAD
		const document = await vscode.workspace.openTextDocument(path.join(repo, 'src.ts'));
		const editor = await vscode.window.showTextDocument(document);
		await editor.edit((builder) => builder.insert(new vscode.Position(0, 0), 'new 1\nnew 2\n'));
		editor.selection = new vscode.Selection(5, 0, 6, 3);
		await vscode.commands.executeCommand('git-map.viewLineHistory');
		let history = (await waitForHistory('the history of lines 6-7', (value) => value.target.range.start === 6 && value.target.range.end === 7)).history;
		assert(JSON.stringify(history.headRange) === JSON.stringify({ start: 4, end: 5 }), 'The lines weren\'t mapped to HEAD: ' + JSON.stringify(history.headRange));
		assert(JSON.stringify(history.entries.map((entry) => entry.hash)) === JSON.stringify([latest, bySecond, created]), 'Unexpected changes: ' + history.entries.map((entry) => entry.subject).join(', '));
		const latestEntry = history.entries[0], secondEntry = history.entries[1];
		assert(latestEntry.diff.includes('-line 4 (second)') && latestEntry.diff.includes('+line 4 (latest)') && latestEntry.filePath === 'src.ts' && JSON.stringify(latestEntry.newRange) === JSON.stringify({ start: 4, end: 5 }), 'Unexpected diff of the latest change: ' + JSON.stringify(latestEntry));
		assert(secondEntry.author === 'Second Author' && secondEntry.filePath === 'app.ts' && secondEntry.diff.includes('+line 4 (second)'), 'Unexpected change before the rename: ' + JSON.stringify(secondEntry));
		assert(history.entries[2].fileAdded && history.entries[2].oldRange === null, 'The commit that added the lines isn\'t recognised');
		const drawer = lineHistory.getDrawer();
		await waitFor('the drawer to be shown', () => drawer.isVisible() && drawer.getContent().kind === 'history');

		// The selected line itself is changed (not committed): its history is its previous version's, after the uncommitted change
		await editor.edit((builder) => builder.replace(new vscode.Range(5, 0, 5, 15), 'line 4 (uncommitted)'));
		editor.selection = new vscode.Selection(5, 0, 6, 3);
		await vscode.commands.executeCommand('git-map.viewLineHistory');
		history = (await waitForHistory('the history including the uncommitted change', (value) => value.history.entries.length > 0 && value.history.entries[0].hash === '*')).history;
		const uncommitted = history.entries[0];
		assert(JSON.stringify(history.headRange) === JSON.stringify({ start: 4, end: 5 }) && JSON.stringify(uncommitted.diff) === JSON.stringify(['-line 4 (latest)', '+line 4 (uncommitted)', ' line 5']) && history.entries[1].hash === latest, 'Unexpected uncommitted change: ' + JSON.stringify(uncommitted) + ', head range ' + JSON.stringify(history.headRange));

		// The inline window below the lines: a comment for each change, which can't be replied to
		await vscode.commands.executeCommand('git-map.lineHistory.switchToInline');
		const thread = await waitFor('the inline window', () => lineHistory.getInline().getThread());
		const comments = thread.comments;
		assert(config().get('lineHistory.location') === 'Inline Window' && thread.canReply === false && thread.range.start.line === 5 && thread.range.end.line === 6 && thread.uri.toString() === document.uri.toString(), 'Unexpected inline window: ' + JSON.stringify({ canReply: thread.canReply, range: thread.range }));
		assert(comments.length === history.entries.length && comments[0].author.name === 'You' && comments[2].author.name === 'Second Author' && comments[2].timestamp instanceof Date && comments[2].author.iconPath.scheme === 'data' && comments[1].label === latest.substring(0, 8), 'Unexpected comments: ' + JSON.stringify(comments.map((comment) => ({ author: comment.author.name, label: comment.label }))));
		assert(comments[1].body.value.includes('```diff') && comments[1].body.value.includes('+line 4 (latest)') && comments[1].body.value.includes('command:git-map.lineHistory.openChanges'), 'Unexpected comment: ' + comments[1].body.value);
		await sleep(1500);
		await screenshot('line-history-inline');
		await vscode.commands.executeCommand('git-map.lineHistory.close');
		assert(lineHistory.getInline().getThread() === null, 'The inline window wasn\'t closed');
		await vscode.commands.executeCommand('git-map.lineHistory.switchToDrawer');
		assert(config().get('lineHistory.location') === 'Drawer', 'The drawer wasn\'t chosen');

		// The actions: the changes of a commit (selecting the lines), and the lines before it
		await vscode.commands.executeCommand('git-map.lineHistory.openChanges', latest);
		const diffTab = await waitFor('the diff', () => {
			const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
			return tab && tab.input instanceof vscode.TabInputTextDiff && tab.input.modified.scheme === 'git-map' ? tab : null;
		});
		const diffSelection = vscode.window.activeTextEditor.selection.start.line;
		await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
		await vscode.commands.executeCommand('git-map.lineHistory.openBefore', latest);
		const before = await waitFor('the lines before the change', () => vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri.scheme === 'git-map' && vscode.window.activeTextEditor.document.getText().includes('line 4 (second)') ? vscode.window.activeTextEditor : null);
		assert(diffSelection === 3 && before.selection.start.line === 3, 'The lines weren\'t selected: ' + diffSelection + ', ' + before.selection.start.line);
		await vscode.commands.executeCommand('workbench.action.closeActiveEditor');

		// The link to the lines on the remote's web page, at the commit
		await vscode.env.clipboard.writeText('');
		await vscode.commands.executeCommand('git-map.lineHistory.copyRemoteLink', latest);
		const link = await waitFor('the link to be copied', async () => (await vscode.env.clipboard.readText()) || null);
		assert(link === 'https://github.com/e2e-owner/e2e-repo/blob/' + latest + '/src.ts#L4-L5', 'Unexpected link: ' + link);

		// The drawer follows the cursor (only while following it is chosen)
		await vscode.window.showTextDocument(document);
		await config().update('lineHistory.followCursor', true, vscode.ConfigurationTarget.Global);
		try {
			vscode.window.activeTextEditor.selection = new vscode.Selection(11, 0, 11, 0);
			await waitForHistory('the drawer to follow the cursor', (value) => value.target.range.start === 12 && value.target.range.end === 12);
			await config().update('lineHistory.followCursor', false, vscode.ConfigurationTarget.Global);
			vscode.window.activeTextEditor.selection = new vscode.Selection(9, 0, 9, 0);
			await sleep(1500);
			assert(shown().target.range.start === 12, 'The drawer followed the cursor after following it was stopped');
		} finally {
			await config().update('lineHistory.followCursor', undefined, vscode.ConfigurationTarget.Global);
			await config().update('lineHistory.location', undefined, vscode.ConfigurationTarget.Global);
		}

		// The page of the drawer (for screenshots), showing the history of lines 6-7
		editor.selection = new vscode.Selection(5, 0, 6, 3);
		await vscode.window.showTextDocument(document, { selection: new vscode.Selection(5, 0, 6, 3) });
		await vscode.commands.executeCommand('git-map.viewLineHistory');
		await waitForHistory('the history of lines 6-7 again', (value) => value.target.range.start === 6 && value.history.entries.length === 4);
		fs.writeFileSync(path.join(path.dirname(fixtures.workspace), 'line-history-drawer.html'), getLineHistoryPage(drawer.getContent(), ''));
		await sleep(1500);
		await screenshot('line-history-drawer');
		await config().update('language', 'Simplified Chinese', vscode.ConfigurationTarget.Global);
		try {
			await vscode.commands.executeCommand('git-map.lineHistory.refresh');
			await sleep(1500);
			await screenshot('line-history-drawer-zh');
		} finally {
			await config().update('language', undefined, vscode.ConfigurationTarget.Global);
		}
		await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
		return 'Lines 6-7 of the editor = lines 4-5 in HEAD: ' + history.entries.map((entry) => entry.hash === '*' ? 'uncommitted' : entry.subject + ' (' + entry.author + ')').join(' ← ') + '; inline window: ' + comments.length + ' comments; link: ' + link;
	});

	// The hover of the blame of a line, and links to lines on the remote. The ways it could go wrong, which this check asserts don't happen:
	// the hover's diff isn't how the commit changed the line (e.g. the line has moved since, or the file was renamed), its links have the
	// wrong arguments (or aren't allowed to run), the changes are opened without selecting the line, and the link to the selected lines of
	// an editor with uncommitted changes is to the wrong lines (or a different commit than HEAD).
	await check('blame-hover-and-links', '[GitLens] The hover of the blame of a line shows how the commit changed it, with links to the history of the line, its changes, the commit & a link to it on the remote; the selected lines can be copied as a link to the remote', async () => {
		const view = await getView(), dataSource = view.dataSource;
		const { getBlameHover } = require(path.join(extension.extensionPath, 'out', 'lineBlame.js'));
		const { LineHistory } = require(path.join(extension.extensionPath, 'out', 'lineHistory.js'));
		const repo = createScratchRepo('blame-hover', { 'old.txt': 'one\ntwo\nthree\nfour\n' });
		git(repo, 'mv', 'old.txt', 'code.txt');
		git(repo, 'commit', '-q', '-m', 'Rename old.txt');
		const changedTwo = commitFile(repo, 'code.txt', 'one\ntwo (changed)\nthree\nfour\n', 'Change line two');
		git(repo, 'remote', 'add', 'origin', 'https://gitlab.com/e2e-group/e2e-repo.git');
		await view.repoManager.registerRepo(repo, false);

		// An uncommitted line is added above the line, so line 3 of the editor is line 2 of the commit
		const contents = 'zero (uncommitted)\none\ntwo (changed)\nthree\nfour\n';
		const blame = await dataSource.getLineBlame(repo, 'code.txt', 3, contents);
		assert(blame !== null && blame.hash === changedTwo && blame.originalLine === 2 && blame.originalFilePath === 'code.txt', 'Unexpected blame: ' + JSON.stringify(blame));
		const change = await dataSource.getLineChange(repo, blame.hash, blame.originalFilePath, blame.originalLine);
		assert(change !== null && JSON.stringify(change.diff) === JSON.stringify(['-two', '+two (changed)']), 'Unexpected change: ' + JSON.stringify(change));
		const uri = vscode.Uri.file(path.join(repo, 'code.txt'));
		const hover = getBlameHover(repo, blame, uri, 3, change.diff);
		const links = (hover.value.match(/command:git-map\.[a-zA-Z.]+/g) || []).map((link) => link.substring(8));
		assert(hover.value.includes('```diff\n-two\n+two (changed)\n```') && JSON.stringify(links) === JSON.stringify(['git-map.viewLineHistory', 'git-map.openLineChanges', 'git-map.viewCommitInGitMap', 'git-map.copyRemoteLink']) && links.every((link) => hover.isTrusted.enabledCommands.includes(link)), 'Unexpected hover: ' + hover.value);

		// The links: the changes (selecting the line), the history of the line (the file is given as a string), and the link to the line on the remote
		await vscode.commands.executeCommand('git-map.openLineChanges', repo, changedTwo, 'code.txt', 2);
		const diffEditor = await waitFor('the changes', () => {
			const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
			return tab && tab.input instanceof vscode.TabInputTextDiff && tab.input.modified.scheme === 'git-map' && vscode.window.activeTextEditor ? vscode.window.activeTextEditor : null;
		});
		assert(diffEditor.selection.start.line === 1, 'The line wasn\'t selected: ' + diffEditor.selection.start.line);
		await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
		const document = await vscode.workspace.openTextDocument(uri);
		const editor = await vscode.window.showTextDocument(document);
		await editor.edit((builder) => builder.insert(new vscode.Position(0, 0), 'zero (uncommitted)\n'));
		await vscode.commands.executeCommand('git-map.viewLineHistory', { uri: uri.toString(), start: 3, end: 3 });
		const shown = await waitFor('the history of the line', () => {
			const value = LineHistory.getInstance().getShown();
			return value !== null && value.target.uri.toString() === uri.toString() && value.target.range.start === 3 ? value : null;
		});
		assert(shown.history.entries[0].hash === changedTwo && JSON.stringify(shown.history.headRange) === JSON.stringify({ start: 2, end: 2 }), 'Unexpected history: ' + JSON.stringify(shown.history.entries.map((entry) => entry.subject)));
		const head = git(repo, 'rev-parse', 'HEAD');
		await vscode.env.clipboard.writeText('');
		await vscode.commands.executeCommand('git-map.copyRemoteLink', repo, changedTwo, 'code.txt', 2, 2);
		const commitLink = await waitFor('the link to the line', async () => (await vscode.env.clipboard.readText()) || null);
		assert(commitLink === 'https://gitlab.com/e2e-group/e2e-repo/-/blob/' + changedTwo + '/code.txt#L2', 'Unexpected link: ' + commitLink);

		// The link to the selected lines of the editor (lines 3-4, which are lines 2-3 at HEAD)
		await vscode.window.showTextDocument(document, { selection: new vscode.Selection(2, 0, 3, 2) });
		await vscode.env.clipboard.writeText('');
		await vscode.commands.executeCommand('git-map.copyRemoteLinkToLines');
		const linesLink = await waitFor('the link to the selected lines', async () => (await vscode.env.clipboard.readText()) || null);
		assert(linesLink === 'https://gitlab.com/e2e-group/e2e-repo/-/blob/' + head + '/code.txt#L2-3', 'Unexpected link: ' + linesLink);

		// The hover in the editor (for screenshots): the cursor is at the end of the blamed line
		const blamedLine = document.lineAt(2);
		vscode.window.activeTextEditor.selection = new vscode.Selection(blamedLine.range.end, blamedLine.range.end);
		await sleep(1200);
		await vscode.commands.executeCommand('editor.action.showHover');
		await sleep(800);
		await screenshot('blame-hover');
		await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
		return 'Hover of line 3 (line 2 at ' + changedTwo.substring(0, 8) + '): ' + change.diff.join(' / ') + '; links: ' + links.join(', ') + '; remote links: ' + commitLink + ', ' + linesLink;
	});

	// The File Blame. The ways it could go wrong, which this check asserts don't happen: lines are annotated with the wrong commits (e.g. the
	// editor has uncommitted changes), the column repeats the commit on every line of a block, the heatmap doesn't show which commits are newer,
	// the annotations aren't updated when the file is changed (so they're on the wrong lines), and toggling it doesn't remove them.
	await check('file-blame', '[GitLens] Toggle File Blame annotates the blocks of lines with the date & author of the commit that last changed them, coloured by how recently it was made (a heatmap)', async () => {
		const view = await getView();
		const { FileBlame } = require(path.join(extension.extensionPath, 'out', 'fileBlame.js'));
		const repo = createScratchRepo('file-blame', { 'placeholder.txt': 'x\n' });
		const commitAt = (contents, message, name, email, date) => {
			fs.writeFileSync(path.join(repo, 'notes.md'), contents);
			git(repo, 'add', '-A');
			cp.execFileSync('git', ['commit', '-q', '-m', message], { cwd: repo, env: Object.assign({}, GIT_ENV, { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_AUTHOR_DATE: date }) });
		};
		commitAt('# Notes\none\ntwo\nthree\nfour\nfive\n', 'Add the notes', 'Second Author', 'second@example.com', '2020-01-01T12:00:00Z');
		commitAt('# Notes\none\ntwo\nTHREE\nFOUR\nfive\n', 'Shout three & four', 'E2E Author', 'author@example.com', '2024-06-01T12:00:00Z');
		await view.repoManager.registerRepo(repo, false);
		const uri = vscode.Uri.file(path.join(repo, 'notes.md')), fileBlame = FileBlame.getInstance();
		const document = await vscode.workspace.openTextDocument(uri);
		const editor = await vscode.window.showTextDocument(document);
		await editor.edit((builder) => builder.insert(new vscode.Position(0, 0), 'draft line\n'));

		await vscode.commands.executeCommand('git-map.toggleFileBlame');
		let annotations = await waitFor('the annotations', () => fileBlame.getAnnotations(uri) !== null && fileBlame.getAnnotations(uri).length === 7 ? fileBlame.getAnnotations(uri) : null);
		const labels = annotations.map((annotation) => annotation.label);
		assert(JSON.stringify(labels) === JSON.stringify(['Uncommitted You', '2020-01-01 Second Author', '', '', '2024-06-01 E2E Author', '', '2020-01-01 Second Author']), 'Unexpected labels: ' + JSON.stringify(labels));
		assert(annotations[0].heat === 1 && annotations[1].heat === 0 && annotations[4].heat === 1 && annotations[1].colour !== annotations[4].colour && annotations[1].colour.startsWith('hsla(215') && annotations[4].colour.startsWith('hsla(30'), 'Unexpected heatmap: ' + JSON.stringify(annotations.slice(0, 5).map((annotation) => [annotation.heat, annotation.colour])));
		await sleep(800);
		await screenshot('file-blame');

		// The annotations follow the lines when the file is changed
		await editor.edit((builder) => builder.delete(new vscode.Range(0, 0, 1, 0)));
		annotations = await waitFor('the annotations to be updated', () => fileBlame.getAnnotations(uri) !== null && fileBlame.getAnnotations(uri).length === 6 ? fileBlame.getAnnotations(uri) : null);
		assert(annotations[0].label === '2020-01-01 Second Author' && annotations[3].label === '2024-06-01 E2E Author', 'The annotations weren\'t updated: ' + JSON.stringify(annotations.map((annotation) => annotation.label)));

		await vscode.commands.executeCommand('git-map.toggleFileBlame');
		assert(fileBlame.getAnnotations(uri) === null, 'Toggling File Blame didn\'t remove the annotations');
		await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
		return 'Labels: ' + labels.filter((label) => label !== '').join(' | ') + '; heat: ' + annotations.map((annotation) => annotation.heat.toFixed(1)).join(' ');
	});

	// Navigating through the revisions of a file. The ways it could go wrong, which this check asserts don't happen: the previous revision
	// skips a commit or doesn't follow the file through a rename, the next revision isn't the next commit that changed the file, the first &
	// latest revisions aren't recognised, and the uncommitted changes aren't shown after the latest commit.
	await check('revision-navigation', '[GitLens] Show Previous / Next Revision step through the commits that changed a file (following it through renames), from its editor or the changes opened by Git Map', async () => {
		const view = await getView();
		const { decodeDiffDocUri } = require(path.join(extension.extensionPath, 'out', 'diffDocProvider.js'));
		const repo = createScratchRepo('revision-navigation', { 'other.txt': 'other\n' });
		const created = commitFile(repo, 'nav.txt', 'a\nb\n', 'Add nav.txt');
		const changed = commitFile(repo, 'nav.txt', 'a\nb (changed)\n', 'Change nav.txt');
		git(repo, 'mv', 'nav.txt', 'moved.txt');
		git(repo, 'commit', '-q', '-m', 'Rename nav.txt');
		const renamed = git(repo, 'rev-parse', 'HEAD');
		const latest = commitFile(repo, 'moved.txt', 'a\nb (changed)\nc\n', 'Change moved.txt');
		await view.repoManager.registerRepo(repo, false);
		const shown = () => {
			const tab = vscode.window.tabGroups.activeTabGroup.activeTab, input = tab ? tab.input : null;
			if (!(input instanceof vscode.TabInputTextDiff)) return null;
			if (input.modified.scheme === 'file') return { commit: '*', path: path.basename(input.modified.fsPath) };
			const modified = decodeDiffDocUri(input.modified), original = decodeDiffDocUri(input.original);
			return { commit: modified.commit, path: modified.filePath, originalPath: original.filePath, originalExists: original.exists };
		};
		const step = async (command, expected) => {
			await vscode.commands.executeCommand(command);
			return waitFor('the changes of ' + expected, () => shown() !== null && shown().commit === expected ? shown() : null, 10000)
				.catch((err) => { throw new Error(err.message + ' (shown: ' + JSON.stringify(shown()) + ')'); });
		};
		await vscode.window.showTextDocument(vscode.Uri.file(path.join(repo, 'moved.txt')));
		const steps = [];
		steps.push(await step('git-map.openPreviousRevision', latest));
		const renameStep = await step('git-map.openPreviousRevision', renamed);
		steps.push(renameStep);
		steps.push(await step('git-map.openPreviousRevision', changed));
		const createdStep = await step('git-map.openPreviousRevision', created);
		steps.push(createdStep);
		assert(renameStep.path === 'moved.txt' && renameStep.originalPath === 'nav.txt' && createdStep.originalExists === false, 'Unexpected changes: ' + JSON.stringify([renameStep, createdStep]));
		await vscode.commands.executeCommand('git-map.openPreviousRevision');
		await sleep(500);
		assert(shown().commit === created, 'The first revision isn\'t recognised');
		steps.push(await step('git-map.openNextRevision', changed));
		steps.push(await step('git-map.openNextRevision', renamed));
		steps.push(await step('git-map.openNextRevision', latest));
		await vscode.commands.executeCommand('git-map.openNextRevision');
		await sleep(500);
		assert(shown().commit === latest, 'The latest revision isn\'t recognised');
		// After the latest commit, the uncommitted changes
		fs.writeFileSync(path.join(repo, 'moved.txt'), 'a\nb (changed)\nc\nd (uncommitted)\n');
		steps.push(await step('git-map.openNextRevision', '*'));
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
		return 'Previous: ' + steps.slice(0, 4).map((value) => value.commit.substring(0, 8) + ' ' + (value.originalPath !== value.path ? value.originalPath + ' → ' : '') + value.path).join(' ← ') + '; next: ' + steps.slice(4).map((value) => value.commit === '*' ? 'uncommitted' : value.commit.substring(0, 8)).join(' → ');
	});

	// The Git CodeLens. The ways it could go wrong, which this check asserts don't happen: it's shown when it isn't enabled, the most recent
	// change & the number of authors of a function are wrong (e.g. including the lines of other functions), and clicking it doesn't show the
	// history of the function's lines.
	await check('code-lens', '[GitLens] The Git CodeLens (git-map.codeLens.enabled) shows who changed functions & classes most recently, and how many authors changed them', async () => {
		const view = await getView();
		const { LineHistory } = require(path.join(extension.extensionPath, 'out', 'lineHistory.js'));
		const repo = createScratchRepo('code-lens', { 'placeholder.txt': 'x\n' });
		const commitAt = (contents, message, name, email, date) => {
			fs.writeFileSync(path.join(repo, 'code.js'), contents);
			git(repo, 'add', '-A');
			cp.execFileSync('git', ['commit', '-q', '-m', message], { cwd: repo, env: Object.assign({}, GIT_ENV, { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_AUTHOR_DATE: date }) });
		};
		const code = (bodyB) => 'function first() {\n\treturn 1;\n}\n\nfunction second() {\n\treturn ' + bodyB + ';\n}\n';
		commitAt(code('2'), 'Add the functions', 'Second Author', 'second@example.com', '2020-01-01T12:00:00Z');
		commitAt(code('22'), 'Change second()', 'E2E Author', 'author@example.com', '2024-06-01T12:00:00Z');
		await view.repoManager.registerRepo(repo, false);
		const uri = vscode.Uri.file(path.join(repo, 'code.js'));
		await vscode.window.showTextDocument(uri);
		const config = vscode.workspace.getConfiguration('git-map');
		const ourLenses = async () => ((await vscode.commands.executeCommand('vscode.executeCodeLensProvider', uri, 10)) || []).filter((lens) => lens.command && lens.command.command === 'git-map.viewLineHistory');
		assert((await ourLenses()).length === 0, 'The CodeLens is shown while it isn\'t enabled');
		await config.update('codeLens.enabled', true, vscode.ConfigurationTarget.Global);
		try {
			const lenses = await waitFor('the CodeLenses', async () => {
				const value = await ourLenses();
				return value.length === 2 ? value : null;
			});
			const titles = lenses.map((lens) => lens.command.title);
			assert(/^Second Author, \d+ years ago · 1 author$/.test(titles[0]) && /^E2E Author, \d+ (years|months) ago · 2 authors$/.test(titles[1]) && lenses[1].range.start.line === 4, 'Unexpected CodeLenses: ' + JSON.stringify(titles));
			await vscode.commands.executeCommand(lenses[1].command.command, ...lenses[1].command.arguments);
			const shownHistory = await waitFor('the history of second()', () => {
				const value = LineHistory.getInstance().getShown();
				return value !== null && value.target.uri.toString() === uri.toString() && value.target.range.start === 5 && value.target.range.end === 7 ? value : null;
			});
			await config.update('codeLens.enabled', undefined, vscode.ConfigurationTarget.Global);
			await sleep(300);
			assert((await ourLenses()).length === 0, 'The CodeLens is still shown after it was disabled');
			await vscode.commands.executeCommand('workbench.action.closeAllEditors');
			return 'CodeLenses: ' + titles.join(' | ') + '; clicking the second showed the history of lines 5-7 (' + shownHistory.history.entries.length + ' changes)';
		} finally {
			await config.update('codeLens.enabled', undefined, vscode.ConfigurationTarget.Global);
		}
	});

	// Toggling the blame of the current line. The ways it could go wrong, which this check asserts don't happen: the blame isn't hidden or
	// shown again, and a workspace's setting (which overrides the user's) stops the toggle from changing anything.
	await check('line-blame-toggle', '[GitLens] Toggle Current Line Blame hides & shows the blame of the current line (changing the workspace\'s setting if it has one)', async () => {
		const view = await getView();
		const { LineBlame } = require(path.join(extension.extensionPath, 'out', 'lineBlame.js'));
		const repo = createScratchRepo('line-blame-toggle', { 'code.txt': 'one\ntwo\nthree\n' });
		await view.repoManager.registerRepo(repo, false);
		const uri = vscode.Uri.file(path.join(repo, 'code.txt')), lineBlame = LineBlame.getInstance();
		const config = () => vscode.workspace.getConfiguration('git-map');
		const shownLine = () => {
			const shown = lineBlame.getShownLine();
			return shown !== null && shown.uri.toString() === uri.toString() ? shown.line : null;
		};
		await vscode.window.showTextDocument(uri, { selection: new vscode.Selection(1, 0, 1, 0) });
		try {
			await waitFor('the blame of line 2', () => shownLine() === 1);
			await vscode.commands.executeCommand('git-map.toggleLineBlame');
			await waitFor('the blame to be hidden', () => shownLine() === null && config().inspect('blame.currentLine').globalValue === false);
			await vscode.commands.executeCommand('git-map.toggleLineBlame');
			await waitFor('the blame to be shown again', () => shownLine() === 1 && config().inspect('blame.currentLine').globalValue === true);
			// A workspace's setting overrides the user's, so it's the one that's changed
			await config().update('blame.currentLine', true, vscode.ConfigurationTarget.Workspace);
			await vscode.commands.executeCommand('git-map.toggleLineBlame');
			await waitFor('the blame to be hidden for the workspace', () => shownLine() === null && config().inspect('blame.currentLine').workspaceValue === false && config().inspect('blame.currentLine').globalValue === true);
			return 'Hidden & shown again (user setting); hidden by changing the workspace\'s setting';
		} finally {
			await config().update('blame.currentLine', undefined, vscode.ConfigurationTarget.Workspace);
			await config().update('blame.currentLine', undefined, vscode.ConfigurationTarget.Global);
			await vscode.commands.executeCommand('workbench.action.closeAllEditors');
		}
	});

	// Escape. The ways it could go wrong, which this check asserts don't happen: it doesn't close what was shown most recently first, it
	// closes the File Blame of a file that isn't in the active editor, it closes something that was already closed (instead of the next
	// thing), and its keybinding takes Escape from the editor's own uses (selections, widgets, suggestions).
	await check('escape', '[GitLens] Escape closes what Git Map showed most recently (the File Blame, the Line History inline window or drawer), returning to how it was before', async () => {
		const view = await getView();
		const { LineHistory } = require(path.join(extension.extensionPath, 'out', 'lineHistory.js'));
		const { FileBlame } = require(path.join(extension.extensionPath, 'out', 'fileBlame.js'));
		const repo = createScratchRepo('escape', { 'a.txt': 'one\ntwo\nthree\n', 'b.txt': 'b\n' });
		commitFile(repo, 'a.txt', 'one\ntwo (changed)\nthree\n', 'Change two');
		await view.repoManager.registerRepo(repo, false);
		const a = vscode.Uri.file(path.join(repo, 'a.txt')), b = vscode.Uri.file(path.join(repo, 'b.txt'));
		const lineHistory = LineHistory.getInstance(), fileBlame = FileBlame.getInstance(), config = vscode.workspace.getConfiguration('git-map');
		const binding = extension.packageJSON.contributes.keybindings.find((keybinding) => keybinding.command === 'git-map.escape');
		assert(binding.key === 'escape' && ['git-map:escapable', '!editorHasSelection', '!editorHasMultipleSelections', '!suggestWidgetVisible', '!findWidgetVisible', '!inlineSuggestionVisible', '!renameInputVisible'].every((term) => binding.when.split(' && ').includes(term)), 'Unexpected keybinding: ' + JSON.stringify(binding));
		const closed = [];
		try {
			// The drawer, then the File Blame of a.txt, then the inline window
			await vscode.window.showTextDocument(a, { selection: new vscode.Selection(1, 0, 1, 0) });
			await vscode.commands.executeCommand('git-map.viewLineHistory');
			await waitFor('the drawer', () => lineHistory.getDrawer().isVisible() && lineHistory.getShown() !== null && lineHistory.getShown().target.uri.toString() === a.toString());
			await vscode.window.showTextDocument(a);
			await vscode.commands.executeCommand('git-map.toggleFileBlame');
			await waitFor('the File Blame', () => fileBlame.getAnnotations(a) !== null);
			await config.update('lineHistory.location', 'Inline Window', vscode.ConfigurationTarget.Global);
			await vscode.commands.executeCommand('git-map.viewLineHistory');
			await waitFor('the inline window', () => lineHistory.getInline().getThread() !== null);

			await vscode.commands.executeCommand('git-map.escape');
			await waitFor('the inline window to close', () => lineHistory.getInline().getThread() === null);
			assert(fileBlame.getAnnotations(a) !== null && lineHistory.getDrawer().isVisible(), 'Escape closed more than the inline window');
			closed.push('inline window');
			// In another file's editor, Escape doesn't close the File Blame of a.txt (the drawer is closed instead)
			await vscode.window.showTextDocument(b);
			await vscode.commands.executeCommand('git-map.escape');
			await waitFor('the drawer to close', () => !lineHistory.getDrawer().isVisible());
			assert(fileBlame.getAnnotations(a) !== null, 'Escape closed the File Blame of a file that isn\'t in the active editor');
			closed.push('drawer (in b.txt, keeping the File Blame of a.txt)');
			await vscode.window.showTextDocument(a);
			await vscode.commands.executeCommand('git-map.escape');
			await waitFor('the File Blame to close', () => fileBlame.getAnnotations(a) === null);
			closed.push('File Blame of a.txt');
			return 'Escape closed: ' + closed.join(', then ');
		} finally {
			await config.update('lineHistory.location', undefined, vscode.ConfigurationTarget.Global);
			await vscode.commands.executeCommand('workbench.action.closeAllEditors');
		}
	});

	// The context menu of editors. The ways it could go wrong, which this check asserts don't happen: an action is shown both in the submenu &
	// directly (or neither, unless it's hidden), the submenu is shown when it's empty, and a setting that only sets some actions loses the
	// default of the others (the menus' conditions read each action's value).
	await check('editor-context-menu', '[GitLens] The Git Map actions of the context menu of editors are in a "Git Map" submenu, or directly in the context menu, or hidden, as set by git-map.editorContextMenu', async () => {
		const menus = extension.packageJSON.contributes.menus, actions = Object.keys(extension.packageJSON.contributes.configuration.properties['git-map.editorContextMenu'].properties);
		const submenuItems = menus['git-map.editorContext'], contextItems = menus['editor/context'];
		const submenuEntry = contextItems.find((item) => item.submenu === 'git-map.editorContext');
		const problems = actions.filter((action) => {
			const inSubmenu = submenuItems.find((item) => item.command === 'git-map.' + action), direct = contextItems.find((item) => item.command === 'git-map.' + action);
			return !inSubmenu || !direct || !inSubmenu.when.includes("editorContextMenu." + action + " == 'Submenu'") || !direct.when.includes("editorContextMenu." + action + " == 'Context Menu'") || !submenuEntry.when.includes("editorContextMenu." + action + " == 'Submenu'");
		});
		assert(actions.length === 8 && problems.length === 0, 'Unexpected menus for: ' + problems.join(', '));
		const config = vscode.workspace.getConfiguration('git-map');
		await config.update('editorContextMenu', { viewLineHistory: 'Context Menu', openLinesOnRemote: 'Hidden' }, vscode.ConfigurationTarget.Global);
		try {
			const value = (action) => vscode.workspace.getConfiguration().get('git-map.editorContextMenu.' + action);
			assert(value('viewLineHistory') === 'Context Menu' && value('openLinesOnRemote') === 'Hidden' && value('toggleFileBlame') === 'Submenu', 'The setting isn\'t merged with its default: ' + JSON.stringify(vscode.workspace.getConfiguration().get('git-map.editorContextMenu')));
		} finally {
			await config.update('editorContextMenu', undefined, vscode.ConfigurationTarget.Global);
		}
		return actions.length + ' actions, each in the submenu or directly in the context menu (exclusively); a partial setting keeps the defaults of the other actions';
	});

	await check('remote-links', '[GitLens] Links to lines & commits on the web pages of remote repositories (GitHub, GitLab, Bitbucket, Gitea / Forgejo, Azure DevOps)', async () => {
		const { getRemoteWebRepo, getRemoteFileUrl, getRemoteCommitUrl } = require(path.join(extension.extensionPath, 'out', 'remoteLinks.js'));
		const hash = 'a'.repeat(40), range = { start: 3, end: 5 }, line = { start: 7, end: 7 };
		const cases = [
			['git@github.com:owner/repo.git', 'dir/a b.ts', range, 'https://github.com/owner/repo/blob/' + hash + '/dir/a%20b.ts#L3-L5', 'https://github.com/owner/repo/commit/' + hash],
			['https://github.com/owner/repo', 'a.ts', line, 'https://github.com/owner/repo/blob/' + hash + '/a.ts#L7', null],
			['https://user@gitlab.com/group/sub/repo.git', 'a.ts', range, 'https://gitlab.com/group/sub/repo/-/blob/' + hash + '/a.ts#L3-5', 'https://gitlab.com/group/sub/repo/-/commit/' + hash],
			['git@bitbucket.org:owner/repo.git', 'a.ts', range, 'https://bitbucket.org/owner/repo/src/' + hash + '/a.ts#lines-3:5', 'https://bitbucket.org/owner/repo/commits/' + hash],
			['https://codeberg.org/owner/repo.git', 'a.ts', range, 'https://codeberg.org/owner/repo/src/commit/' + hash + '/a.ts#L3-L5', null],
			['git@ssh.dev.azure.com:v3/org/project/repo', 'src/a.ts', range, 'https://dev.azure.com/org/project/_git/repo?path=%2Fsrc%2Fa.ts&version=GC' + hash + '&line=3&lineEnd=6&lineStartColumn=1&lineEndColumn=1&lineStyle=plain&_a=contents', 'https://dev.azure.com/org/project/_git/repo/commit/' + hash],
			['ssh://git@git.example.com:2222/team/repo.git', 'a.ts', range, 'https://git.example.com/team/repo/blob/' + hash + '/a.ts#L3-L5', null]
		];
		const failures = cases.filter(([remote, file, lines, fileUrl, commitUrl]) => {
			const repo = getRemoteWebRepo(remote);
			return repo === null || getRemoteFileUrl(repo, hash, file, lines) !== fileUrl || (commitUrl !== null && getRemoteCommitUrl(repo, hash) !== commitUrl);
		}).map(([remote, file, lines]) => {
			const repo = getRemoteWebRepo(remote);
			return remote + ' -> ' + (repo !== null ? getRemoteFileUrl(repo, hash, file, lines) + ' / ' + getRemoteCommitUrl(repo, hash) : 'null');
		});
		assert(failures.length === 0 && getRemoteWebRepo('not a url') === null, 'Unexpected links: ' + failures.join('; '));
		return cases.length + ' remotes: ' + cases.map(([remote]) => remote.replace(/^.*?(github|gitlab|bitbucket|codeberg|azure|example).*$/, '$1')).join(', ');
	});

	await check('rebase-editor', '[GitLens] An interactive rebase runs the todo list chosen in the Rebase Editor (pick, reword, squash, fixup, drop & reorder) without opening an editor or running names / messages in a shell, and a rebase that stops can be continued or aborted', async () => {
		const view = await getView(), dataSource = view.dataSource;
		const repo = createScratchRepo('rebase-editor', { 'base.txt': 'base\n' }), base = git(repo, 'rev-parse', 'HEAD');
		const injection = 'pwn$(>rebase-injection-marker)', marker = path.join(repo, 'rebase-injection-marker');
		git(repo, 'branch', injection, base);
		git(repo, 'checkout', '-q', '-b', 'feature');
		const a = commitFile(repo, 'a.txt', 'a\n', 'Add a'), b = commitFile(repo, 'b.txt', 'b\n', 'Add b');
		const c = commitFile(repo, 'c.txt', 'c\n', 'Add c'), d = commitFile(repo, 'd.txt', 'd\n', 'Add d');
		const original = git(repo, 'rev-parse', 'HEAD');

		// The commits that are rebased (oldest first)
		const listed = await dataSource.getRebaseCommits(repo, injection);
		assert(listed.error === null && JSON.stringify(listed.commits.map((commit) => commit.hash)) === JSON.stringify([a, b, c, d]) && listed.commits[1].subject === 'Add b' && listed.commits[1].author === 'E2E Author', 'Unexpected commits: ' + JSON.stringify(listed));

		// Reorder, reword (with a message containing shell syntax), squash & drop
		const message = 'B reworded $(>rebase-message-marker)\n\nWith a body';
		const error = await dataSource.rebaseInteractive(repo, injection, [
			{ action: 'pick', hash: b, message: null },
			{ action: 'reword', hash: a, message: message },
			{ action: 'squash', hash: c, message: null },
			{ action: 'drop', hash: d, message: null }
		]);
		assert(error === null, 'The rebase failed: ' + error);
		const subjects = git(repo, 'log', '--format=%s', base + '..HEAD').split('\n');
		assert(JSON.stringify(subjects) === JSON.stringify(['B reworded $(>rebase-message-marker)', 'Add b']), 'Unexpected commits: ' + JSON.stringify(subjects));
		const squashed = git(repo, 'log', '-1', '--format=%B');
		assert(squashed.startsWith(message) && squashed.includes('Add c') && !squashed.includes('#'), 'Unexpected message of the squashed commit: ' + JSON.stringify(squashed));
		assert(fs.existsSync(path.join(repo, 'c.txt')) && !fs.existsSync(path.join(repo, 'd.txt')), 'The squashed / dropped commits are wrong');
		assert(!fs.existsSync(marker) && !fs.existsSync(path.join(repo, 'rebase-message-marker')), 'The branch name or message was run by the shell');
		assert(await dataSource.getOperationInProgress(repo) === null, 'The rebase is still in progress');

		// A rebase that stops because of a conflict can be aborted (and continued)
		git(repo, 'reset', '-q', '--hard', original);
		git(repo, 'checkout', '-q', '-b', 'conflicting', base);
		const conflicting = commitFile(repo, 'a.txt', 'a (conflict)\n', 'Conflicting a');
		git(repo, 'checkout', '-q', 'feature');
		const stopped = await dataSource.rebaseInteractive(repo, conflicting, [{ action: 'pick', hash: a, message: null }, { action: 'pick', hash: b, message: null }]);
		assert(stopped !== null && await dataSource.getOperationInProgress(repo) === 'rebase', 'The rebase didn\'t stop at the conflict: ' + stopped);
		const response = await (async () => {
			const count = record.responses.filter((msg) => msg.command === 'loadOperationInProgress').length;
			await view.respondToMessage({ command: 'loadOperationInProgress', repo: repo });
			return waitFor('the operation in progress', () => record.responses.filter((msg) => msg.command === 'loadOperationInProgress').slice(count).find((msg) => msg.repo === repo));
		})();
		assert(response.operation === 'rebase', 'Unexpected operation: ' + JSON.stringify(response));
		const aborted = await dataSource.controlOperation(repo, 'rebase', 'abort');
		assert(aborted === null && git(repo, 'rev-parse', 'HEAD') === original && await dataSource.getOperationInProgress(repo) === null, 'Aborting the rebase failed: ' + aborted);
		await dataSource.rebaseInteractive(repo, conflicting, [{ action: 'pick', hash: a, message: null }]);
		fs.writeFileSync(path.join(repo, 'a.txt'), 'a (resolved)\n');
		git(repo, 'add', 'a.txt');
		const continued = await dataSource.controlOperation(repo, 'rebase', 'continue');
		assert(continued === null && await dataSource.getOperationInProgress(repo) === null && git(repo, 'log', '-1', '--format=%s') === 'Add a', 'Continuing the rebase failed: ' + continued);
		return 'Rebased: ' + subjects.join(' ← ') + '; stopped at a conflict: aborted, then continued after resolving it';
	});

	await check('#932', 'An externally configured GIT_ASKPASS is used for authentication instead of Git Map\'s', async () => {
		const result = await withTimeout((await getView()).dataSource.fetch(main, 'httpauth', false, false), 30000, 'fetching from the remote requiring authentication (Git Map\'s own Askpass prompt would wait for input)');
		assert(result !== null, 'The fetch unexpectedly succeeded');
		assert(fs.existsSync(fixtures.askpassLog), 'The external Askpass program was not invoked. Fetch result: ' + result);
		const prompts = fs.readFileSync(fixtures.askpassLog, 'utf8').trim().split('\n');
		assert(prompts.some((prompt) => prompt.startsWith('Username')), 'Unexpected Askpass prompts: ' + prompts.join(' | '));
		return 'External Askpass prompts: ' + prompts.join(' | ');
	});

	for (const [id, title, repo] of [
		['#789', 'The view refreshes when a commit is made in a submodule from outside of Visual Studio Code', sub],
		['#668-watch', 'The view refreshes when a commit is made in a worktree from outside of Visual Studio Code', wt]
	]) {
		await check(id, title, async () => {
			let since = marker(record);
			await vscode.commands.executeCommand('git-map.view', { rootUri: vscode.Uri.file(repo) });
			await waitForCommitsLoaded(record, repo, since);
			await sleep(2500); // File events are muted for 1.5 seconds after the Git Map View has run Git commands

			since = marker(record);
			git(repo, 'commit', '-q', '--allow-empty', '-m', 'Commit made outside of Visual Studio Code');
			const newHead = git(repo, 'rev-parse', 'HEAD');
			await waitFor('the extension to tell the Webview to refresh', () => record.responses.slice(since.responses).some((msg) => msg.command === 'refresh'), 15000);
			const response = await waitForCommitsLoaded(record, repo, since);
			assert(response.commits.some((commit) => commit.hash === newHead), 'The new commit was not loaded');
			return 'Refreshed, and loaded the new commit ' + newHead.substring(0, 8);
		});
	}

	await check('#775', 'Selecting a graph colour preset re-renders the open Git Map View with the preset\'s colours', async () => {
		const commands = await vscode.commands.getCommands(true);
		assert(commands.includes('git-map.selectGraphColourPreset'), 'The "Select Graph Colour Preset" command is not registered');
		await vscode.commands.executeCommand('git-map.view', { rootUri: vscode.Uri.file(main) });
		await waitFor('the Git Map View to be visible', () => GitGraphView.currentPanel && GitGraphView.currentPanel.panel.visible);
		const colourOf = (html) => (html.match(/--git-graph-color0:([^;]+);/) || [])[1];
		try {
			const renders = record.html.length;
			await vscode.workspace.getConfiguration('git-map').update('graph.colourPreset', 'Tokyo Subway', vscode.ConfigurationTarget.Global);
			const html = await waitFor('the view to be re-rendered', () => record.html.slice(renders).find((html) => html.includes('id="view"')));
			assert(colourOf(html) === '#f62e36', 'Unexpected first graph colour: ' + colourOf(html));
		} finally {
			const renders = record.html.length;
			await vscode.workspace.getConfiguration('git-map').update('graph.colourPreset', undefined, vscode.ConfigurationTarget.Global);
			await waitFor('the view to be re-rendered with the default colours', () => record.html.slice(renders).some((html) => colourOf(html) === '#0085d9'));
		}
		return 'Tokyo Subway → --git-graph-color0: #f62e36, Default → #0085d9';
	});

	// Webview UI checks: run ./webview-harness.js inside a copy of the Git Map View's HTML, in a real Webview of this version of Visual Studio Code
	const runWebviewHarness = async (html, titlePrefix) => {
		if (ONLY !== null && !ONLY.includes('harness')) return;
		const start = Date.now();
		try {
			const nonce = html.match(/<script nonce="([^"]+)"/)[1];
			const harness = fs.readFileSync(path.join(__dirname, 'webview-harness.js'), 'utf8');
			const harnessHtml = html.replace(/<script nonce="[^"]+" src=/, (match) => '<script nonce="' + nonce + '">' + harness + '</script>' + match);

			const panel = vscode.window.createWebviewPanel('git-graph-e2e-harness', 'Git Map (E2E UI Harness)', vscode.ViewColumn.One, {
				enableScripts: true,
				localResourceRoots: [vscode.Uri.file(path.join(extension.extensionPath, 'media'))]
			});
			const harnessResults = new Promise((resolve) => panel.webview.onDidReceiveMessage((msg) => {
				if (msg.command === 'e2eResults') resolve(msg.results);
			}));
			panel.webview.html = harnessHtml;
			const uiResults = await withTimeout(harnessResults, 90000, 'the Webview UI harness to report its results');
			uiResults.forEach((result) => results.push(Object.assign({}, result, { title: titlePrefix + result.title, durationMs: Date.now() - start })));
			panel.dispose();
		} catch (err) {
			results.push({ id: 'webview-harness', title: titlePrefix + 'The Webview UI harness ran', pass: false, details: err && err.stack ? err.stack : String(err), durationMs: Date.now() - start });
		}
	};
	await getView();
	await runWebviewHarness(await waitFor('the Webview HTML', () => record.html.slice().reverse().find((html) => html.includes('id="view"'))), '[Webview UI] ');

	// Display the Git Map View, Status Bar Item & Webview UI in Simplified Chinese (git-map.language), as a user who has set it would see them
	let chineseHtml = null;
	await check('ui-settings-update', '[Redesign] The Repository Settings panel can only update its whitelisted Extension Settings, for all repositories', async () => {
		const view = await getView();
		const responses = () => record.responses.filter((msg) => msg.command === 'updateExtensionSetting');
		const send = async (key, value) => {
			const count = responses().length;
			await view.respondToMessage({ command: 'updateExtensionSetting', key: key, value: value });
			return waitFor('the response', () => responses().length > count ? responses()[responses().length - 1] : null);
		};
		try {
			const valid = await send('statusBarItemDisplay', 'Text');
			assert(valid.error === null && vscode.workspace.getConfiguration('git-map').inspect('statusBarItemDisplay').globalValue === 'Text', 'The valid setting wasn\'t updated: ' + valid.error);
			const invalidValue = await send('statusBarItemDisplay', 'Huge');
			const invalidKey = await send('repository.commits.initialLoad', '1');
			assert(invalidValue.error !== null && invalidKey.error !== null && vscode.workspace.getConfiguration('git-map').inspect('repository.commits.initialLoad').globalValue === undefined, 'An invalid setting was updated');
			// The settings that freeze the column headers & footer are booleans (a string isn't accepted)
			const freeze = await send('graph.freezeFooter', false);
			const freezeString = await send('graph.freezeColumnHeaders', 'false');
			const config = vscode.workspace.getConfiguration('git-map');
			assert(freeze.error === null && config.inspect('graph.freezeFooter').globalValue === false && freezeString.error !== null && config.inspect('graph.freezeColumnHeaders').globalValue === undefined, 'Unexpected boolean settings: ' + freeze.error + ' / ' + freezeString.error);
			return 'Valid: updated; invalid value: "' + invalidValue.error + '"; other setting: "' + invalidKey.error + '"; boolean: updated, as a string: "' + freezeString.error + '"';
		} finally {
			await vscode.workspace.getConfiguration('git-map').update('statusBarItemDisplay', undefined, vscode.ConfigurationTarget.Global);
			// Changing the setting re-renders the open view, which must happen before the next check waits for the view to be re-rendered
			const renders = record.html.length;
			await vscode.workspace.getConfiguration('git-map').update('graph.freezeFooter', undefined, vscode.ConfigurationTarget.Global);
			await waitFor('the view to be re-rendered', () => record.html.length > renders, 5000).catch(() => null);
			await new Promise((resolve) => setTimeout(resolve, 500));
		}
	});

	await check('l10n', 'Setting git-map.language to Simplified Chinese re-renders the open Git Map View & Status Bar Item in Simplified Chinese', async () => {
		const packageJson = JSON.parse(fs.readFileSync(path.join(extension.extensionPath, 'package.json'), 'utf8'));
		const nlsKeys = (file) => Object.keys(JSON.parse(fs.readFileSync(path.join(extension.extensionPath, file), 'utf8')));
		const placeholders = Array.from(new Set(JSON.stringify(packageJson.contributes).match(/"%[^"%]+%"/g).map((key) => key.slice(2, -2))));
		const missingNls = ['package.nls.json', 'package.nls.zh-cn.json'].flatMap((file) => placeholders.filter((key) => !nlsKeys(file).includes(key)).map((key) => file + ': ' + key));
		assert(missingNls.length === 0, 'The contributions are missing descriptions: ' + missingNls.join(', '));

		const { StatusBarItem } = require(path.join(extension.extensionPath, 'out', 'statusBarItem.js'));
		const { EventEmitter } = require(path.join(extension.extensionPath, 'out', 'utils', 'event.js'));
		const { Logger } = require(path.join(extension.extensionPath, 'out', 'logger.js'));
		const onDidChangeRepos = new EventEmitter(), onDidChangeConfiguration = new EventEmitter(), logger = new Logger();
		const statusBarItem = new StatusBarItem(1, onDidChangeRepos.subscribe, onDidChangeConfiguration.subscribe, logger);
		await vscode.commands.executeCommand('git-map.view', { rootUri: vscode.Uri.file(main) });
		await waitFor('the Git Map View to be visible', () => GitGraphView.currentPanel && GitGraphView.currentPanel.panel.visible);
		try {
			const tooltipBefore = statusBarItem.statusBarItem.tooltip;
			const renders = record.html.length;
			await vscode.workspace.getConfiguration('git-map').update('language', 'Simplified Chinese', vscode.ConfigurationTarget.Global);
			onDidChangeConfiguration.emit({ affectsConfiguration: (section) => section === 'git-map' || section === 'git-map.language' });
			chineseHtml = await waitFor('the view to be re-rendered', () => record.html.slice(renders).find((html) => html.includes('id="view"')));
			assert(tooltipBefore === 'View Git Map' && statusBarItem.statusBarItem.tooltip === '查看 Git Map', 'Unexpected Status Bar Item tooltips: ' + tooltipBefore + ' → ' + statusBarItem.statusBarItem.tooltip);
			assert(chineseHtml.includes('<html lang="zh-CN">'), 'The view isn\'t marked as Simplified Chinese');
			assert(chineseHtml.includes('仓库：') && chineseHtml.includes('"l10n":{'), 'The view wasn\'t rendered with the Simplified Chinese translations');
			return placeholders.length + ' contribution descriptions in package.nls.json & package.nls.zh-cn.json, Status Bar Item tooltip: ' + tooltipBefore + ' → ' + statusBarItem.statusBarItem.tooltip;
		} finally {
			statusBarItem.dispose();
			logger.dispose();
		}
	});
	if (chineseHtml !== null) {
		await runWebviewHarness(chineseHtml, '[Webview UI, 简体中文] ');
	}
	await check('l10n-reset', 'Resetting git-map.language re-renders the open Git Map View in the display language of Visual Studio Code (English)', async () => {
		await getView();
		const renders = record.html.length;
		await vscode.workspace.getConfiguration('git-map').update('language', undefined, vscode.ConfigurationTarget.Global);
		// The view can also be re-rendered (in the previous language) when it becomes visible again after the harness' Webview is closed
		const html = await waitFor('the view to be re-rendered in English', () => record.html.slice(renders).find((html) => html.includes('<html lang="en">'))).catch((err) => {
			throw new Error(err.message + '. Rendered: ' + record.html.slice(renders).map((html) => (html.match(/<html lang="([^"]+)">/) || [])[1]).join(', '));
		});
		assert(html.includes('data-label="Repo"') && html.includes('"l10n":null'), 'The view wasn\'t re-rendered in English');
		return 'vscode.env.language: ' + vscode.env.language;
	});

	const report = {
		date: new Date().toISOString(),
		vscodeVersion: vscode.version,
		gitVersion: fixtures.gitVersion,
		platform: process.platform + ' ' + process.arch,
		extensionHostNode: process.version,
		results: results
	};
	fs.writeFileSync(fixtures.report, JSON.stringify(report, null, '\t'));

	const failed = results.filter((result) => !result.pass);
	if (failed.length > 0) {
		throw new Error(failed.length + ' end-to-end check(s) failed: ' + failed.map((result) => result.id).join(', '));
	}
}

module.exports = { run };
