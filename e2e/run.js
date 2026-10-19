/**
 * End-to-End Test Runner
 *
 * Builds fixture Git repositories, launches a real instance of Visual Studio Code with Git Map loaded from this
 * folder, and runs ./suite.js inside its Extension Host. Visual Studio Code runs with an isolated user data directory
 * & extensions directory, so the user's own profile is never touched.
 *
 * Usage: npm run compile && npm run test-e2e
 *
 * Environment variables:
 *  - VSCODE_E2E_EXECUTABLE: The Visual Studio Code executable to test against. Defaults to the locally installed
 *    Visual Studio Code (macOS), otherwise the latest stable release is downloaded.
 *  - E2E_EXTENSION_PATH: The (compiled) extension to test. Defaults to this folder. Used to confirm that the checks
 *    fail against a build without the fixes.
 *
 * Artifacts (e2e/.artifacts):
 *  - report.json: The result of every check, with the Visual Studio Code & Git versions used.
 *  - workspace/: The fixture repositories the checks were run against.
 */
const cp = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { downloadAndUnzipVSCode, runTests } = require('@vscode/test-electron');

const ROOT = path.resolve(__dirname, '..');
const ARTIFACTS = path.join(__dirname, '.artifacts');
const WORKSPACE = path.join(ARTIFACTS, 'workspace');
const MACOS_VSCODE = '/Applications/Visual Studio Code.app/Contents/MacOS/Code';

const GIT_ENV = Object.assign({}, process.env, {
	GIT_CONFIG_GLOBAL: '/dev/null',
	GIT_CONFIG_NOSYSTEM: '1',
	GIT_TERMINAL_PROMPT: '0',
	GIT_AUTHOR_NAME: 'E2E Author', GIT_AUTHOR_EMAIL: 'author@example.com',
	GIT_COMMITTER_NAME: 'E2E Committer', GIT_COMMITTER_EMAIL: 'committer@example.com'
});

function git(cwd, ...args) {
	return cp.execFileSync('git', args, { cwd: cwd, env: GIT_ENV, encoding: 'utf8' }).trim();
}

function rmrf(p) {
	fs.rmSync(p, { recursive: true, force: true });
}

/**
 * Create the fixture repositories:
 *  - workspace/main: A repository with a commit whose subject contains a raw CR character (#935), a branch whose name
 *    contains shell syntax (#940), a branch & tag with the same name pushed to a remote (#708), a remote requiring
 *    HTTP authentication (#932), and a submodule (#789).
 *  - workspace/wt: A worktree of workspace/main (#668).
 */
function createFixtures(httpPort) {
	rmrf(ARTIFACTS);
	fs.mkdirSync(WORKSPACE, { recursive: true });
	const fixtures = { workspace: WORKSPACE };

	// Workspace settings under their names before version 2.1.0 (a resource setting, and a legacy name), copied to git-map.* in the workspace
	fs.mkdirSync(path.join(WORKSPACE, '.vscode'));
	fs.writeFileSync(path.join(WORKSPACE, '.vscode', 'settings.json'), JSON.stringify({ 'git-graph.fileEncoding': 'utf8', 'git-graph.commitOrdering': 'date' }, null, '\t'));

	// A bare repository used as a remote
	const remote = path.join(ARTIFACTS, 'remote.git');
	git(ARTIFACTS, 'init', '--bare', '-q', '-b', 'main', remote);

	// The repository used as a submodule
	const subSource = path.join(ARTIFACTS, 'sub-source');
	git(ARTIFACTS, 'init', '-q', '-b', 'main', subSource);
	git(subSource, 'commit', '-q', '--allow-empty', '-m', 'Submodule initial commit');

	// The main repository
	const main = path.join(WORKSPACE, 'main');
	git(WORKSPACE, 'init', '-q', '-b', 'main', main);
	git(main, 'config', 'sequence.editor', 'true'); // Interactive rebases run without user interaction
	git(main, 'config', 'core.editor', 'true');
	git(main, 'config', 'commit.gpgsign', 'false');
	fs.writeFileSync(path.join(main, 'file.txt'), 'one\n');
	git(main, 'add', 'file.txt');
	git(main, 'commit', '-q', '-m', 'First commit');
	fixtures.firstCommit = git(main, 'rev-parse', 'HEAD');

	const crMessageFile = path.join(ARTIFACTS, 'cr-message.txt');
	fs.writeFileSync(crMessageFile, 'Subject containing a raw\rCR character\n');
	fs.writeFileSync(path.join(main, 'file.txt'), 'two\n');
	git(main, 'commit', '-q', '-a', '-F', crMessageFile);
	fixtures.crCommit = git(main, 'rev-parse', 'HEAD');
	const crSubject = git(main, 'log', '-1', '--format=%s');
	if (!crSubject.includes('\r')) throw new Error('Fixture error: the commit subject doesn\'t contain a raw CR character.');

	fs.writeFileSync(path.join(main, 'file.txt'), 'three\n');
	git(main, 'commit', '-q', '-a', '-m', 'Commit after the CR commit');

	// A commit by another author, whose name contains regular expression characters (#171)
	fixtures.secondAuthor = 'Dr. Q+A (Second)';
	fs.writeFileSync(path.join(main, 'file.txt'), 'four\n');
	cp.execFileSync('git', ['commit', '-q', '-a', '-m', 'Commit by the second author'], { cwd: main, env: Object.assign({}, GIT_ENV, { GIT_AUTHOR_NAME: fixtures.secondAuthor, GIT_AUTHOR_EMAIL: 'second@example.com' }) });
	fixtures.secondAuthorCommit = git(main, 'rev-parse', 'HEAD');

	git(main, '-c', 'protocol.file.allow=always', 'submodule', '--quiet', 'add', subSource, 'sub');
	git(main, 'commit', '-q', '-m', 'Add submodule');
	fixtures.headCommit = git(main, 'rev-parse', 'HEAD');

	// A branch whose name contains a command substitution, and a branch & tag sharing the same name
	fixtures.injectionBranch = 'pwn$(>e2e-injection-marker)';
	fixtures.injectionMarker = path.join(main, 'e2e-injection-marker');
	git(main, 'check-ref-format', '--branch', fixtures.injectionBranch);
	git(main, 'branch', fixtures.injectionBranch, fixtures.firstCommit);
	git(main, 'branch', 'asd', fixtures.firstCommit);
	git(main, 'tag', 'asd', fixtures.crCommit);
	git(main, 'remote', 'add', 'origin', remote);
	git(main, 'push', '-q', 'origin', 'refs/heads/main', 'refs/heads/asd', 'refs/tags/asd');
	git(main, 'remote', 'add', 'httpauth', 'http://127.0.0.1:' + httpPort + '/repo.git');

	// A worktree of the main repository
	const wt = path.join(WORKSPACE, 'wt');
	git(main, 'worktree', 'add', '-q', '-b', 'wt-branch', wt);

	// An external Askpass program (like those provided by remote development environments)
	const askpass = path.join(ARTIFACTS, 'external-askpass.sh');
	fs.writeFileSync(askpass, '#!/bin/sh\necho "$1" >> "' + path.join(ARTIFACTS, 'external-askpass.log') + '"\ncase "$1" in Username*) echo e2e-user ;; *) echo e2e-pass ;; esac\n');
	fs.chmodSync(askpass, 0o755);

	Object.assign(fixtures, {
		remote: remote,
		main: main,
		sub: path.join(main, 'sub'),
		wt: wt,
		askpass: askpass,
		askpassLog: path.join(ARTIFACTS, 'external-askpass.log'),
		report: path.join(ARTIFACTS, 'report.json'),
		gitVersion: git(ARTIFACTS, '--version'),
		iconThemeExtension: createIconThemeExtension()
	});
	return fixtures;
}

/**
 * Create an extension contributing a file icon theme of SVG images (like vscode-icons), whose definition is in a subfolder with paths
 * relative to it. Its definition is invalid until the file-icon-theme-svg check writes it (as when an extension like vscode-icons is
 * writing it while Git Map reads it).
 * @returns The folder of the extension.
 */
function createIconThemeExtension() {
	const folder = path.join(ARTIFACTS, 'icon-theme-extension');
	fs.mkdirSync(path.join(folder, 'dist'), { recursive: true });
	fs.mkdirSync(path.join(folder, 'icons'), { recursive: true });
	fs.writeFileSync(path.join(folder, 'package.json'), JSON.stringify({
		name: 'e2e-icon-theme', publisher: 'e2e', version: '1.0.0', engines: { vscode: '*' },
		contributes: { iconThemes: [{ id: 'e2e-svg-icons', label: 'E2E SVG Icons', path: './dist/theme.json' }] }
	}, null, '\t'));
	['file', 'python', 'excel'].forEach((name) => fs.writeFileSync(path.join(folder, 'icons', name + '.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="3" fill="#' + (name === 'file' ? '888888' : name === 'python' ? '3572a5' : '1d6f42') + '"/></svg>'));
	fs.writeFileSync(path.join(folder, 'dist', 'theme.json'), '{ "iconDefinitions": { "_file": ');
	return folder;
}

/**
 * Write the settings of the isolated Visual Studio Code profile.
 */
function writeUserSettings(userDataDir) {
	const settingsDir = path.join(userDataDir, 'User');
	fs.mkdirSync(settingsDir, { recursive: true });
	fs.writeFileSync(path.join(settingsDir, 'settings.json'), JSON.stringify({
		// Git Map's settings under their names before version 2.1.0 (git-graph.*), which are copied to git-map.* when it starts (the
		// settings-migration check): a legacy name, an array, and a setting that's already set under its new name (which is kept)
		'git-graph.integratedTerminalShell': '/bin/sh',
		'git-graph.maxDepthOfRepoSearch': 2,
		'git-graph.muteMergeCommits': true,
		'git-graph.customEmojiShortcodeMappings': [{ shortcode: ':e2e-migrated:', emoji: '✅' }],
		'git-graph.tabIconColourTheme': 'grey',
		'git-map.tabIconColourTheme': 'colour',
		'git.autofetch': false,
		'git.openRepositoryInParentFolders': 'never',
		'security.workspace.trust.enabled': false,
		'terminal.integrated.confirmOnExit': 'never', // A terminal left running by a failed check must not block Visual Studio Code from exiting
		'terminal.integrated.confirmOnKill': 'never',
		'terminal.integrated.enablePersistentSessions': false,
		'update.mode': 'none',
		'window.restoreWindows': 'none',
		'workbench.startupEditor': 'none'
	}, null, '\t'));
}

async function main() {
	// An HTTP server that always requires authentication (used to check which Askpass program Git uses)
	const server = http.createServer((req, res) => {
		res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="git-graph-e2e"' });
		res.end();
	});
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

	let exitCode = 0;
	try {
		const fixtures = createFixtures(server.address().port);
		const userDataDir = path.join(ARTIFACTS, 'user-data');
		writeUserSettings(userDataDir);

		const vscodeExecutablePath = process.env.VSCODE_E2E_EXECUTABLE
			|| (process.platform === 'darwin' && fs.existsSync(MACOS_VSCODE) ? MACOS_VSCODE : await downloadAndUnzipVSCode('stable'));
		console.log('Visual Studio Code: ' + vscodeExecutablePath);
		console.log('Fixtures: ' + WORKSPACE);

		await runTests({
			vscodeExecutablePath: vscodeExecutablePath,
			extensionDevelopmentPath: [process.env.E2E_EXTENSION_PATH ? path.resolve(process.env.E2E_EXTENSION_PATH) : ROOT, fixtures.iconThemeExtension],
			extensionTestsPath: path.join(__dirname, 'suite.js'),
			launchArgs: [
				WORKSPACE,
				'--user-data-dir=' + userDataDir,
				'--extensions-dir=' + path.join(ARTIFACTS, 'extensions'),
				'--disable-workspace-trust',
				'--skip-welcome',
				'--skip-release-notes',
				'--disable-telemetry',
				'--remote-debugging-port=0' // The checks take screenshots of the workbench through the DevTools protocol (the port is in DevToolsActivePort)
			],
			extensionTestsEnv: {
				E2E_FIXTURES: JSON.stringify(fixtures),
				E2E_ONLY: process.env.E2E_ONLY || '',
				GIT_ASKPASS: fixtures.askpass,
				GIT_CEILING_DIRECTORIES: ARTIFACTS, // The fixtures are within this repository, which Git must not discover as their parent
				GIT_CONFIG_GLOBAL: '/dev/null',
				GIT_CONFIG_NOSYSTEM: '1',
				GIT_TERMINAL_PROMPT: '0'
			}
		});
	} catch (err) {
		console.error(err);
		exitCode = 1;
	} finally {
		server.close();
	}

	const reportPath = path.join(ARTIFACTS, 'report.json');
	if (fs.existsSync(reportPath)) {
		const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
		console.log('\nVisual Studio Code ' + report.vscodeVersion + ', ' + report.gitVersion);
		report.results.forEach((result) => {
			console.log((result.pass ? 'PASS' : 'FAIL') + '  ' + result.id + '  ' + result.title + (result.pass ? '' : '\n      ' + result.details));
		});
		const failed = report.results.filter((result) => !result.pass).length;
		console.log('\n' + (report.results.length - failed) + ' passed, ' + failed + ' failed. Report: ' + path.relative(ROOT, reportPath));
		if (failed > 0) exitCode = 1;
	} else {
		console.error('No report was produced.');
		exitCode = 1;
	}
	process.exit(exitCode);
}

main();
