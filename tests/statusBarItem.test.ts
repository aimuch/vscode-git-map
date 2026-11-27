import * as vscode from './mocks/vscode';
jest.mock('vscode', () => vscode, { virtual: true });
jest.mock('../src/logger');

import { ConfigurationChangeEvent } from 'vscode';
import { Logger } from '../src/logger';
import { RepoChangeEvent } from '../src/repoManager';
import { StatusBarItem } from '../src/statusBarItem';
import { EventEmitter } from '../src/utils/event';

const vscodeStatusBarItem = vscode.mocks.statusBarItem;
let onDidChangeRepos: EventEmitter<RepoChangeEvent>;
let onDidChangeConfiguration: EventEmitter<ConfigurationChangeEvent>;
let logger: Logger;

beforeAll(() => {
	onDidChangeRepos = new EventEmitter<RepoChangeEvent>();
	onDidChangeConfiguration = new EventEmitter<ConfigurationChangeEvent>();
	logger = new Logger();
});

afterAll(() => {
	logger.dispose();
});

describe('StatusBarItem', () => {
	it('Should show the Status Bar Item on vscode startup', () => {
		// Setup
		vscode.mockExtensionSettingReturnValue('showStatusBarItem', true);

		// Run
		const statusBarItem = new StatusBarItem(1, onDidChangeRepos.subscribe, onDidChangeConfiguration.subscribe, logger);

		// Assert
		expect(vscodeStatusBarItem.text).toBe('$(git-map-logo) Git Map');
		expect(vscodeStatusBarItem.tooltip).toBe('View Git Map');
		expect(vscodeStatusBarItem.command).toBe('git-map.view');
		expect(vscodeStatusBarItem.show).toHaveBeenCalledTimes(1);
		expect(vscodeStatusBarItem.hide).toHaveBeenCalledTimes(0);

		// Teardown
		statusBarItem.dispose();

		// Asset
		expect(vscodeStatusBarItem.dispose).toHaveBeenCalledTimes(1);
		expect(onDidChangeRepos['listeners']).toHaveLength(0);
		expect(onDidChangeConfiguration['listeners']).toHaveLength(0);
	});

	it('Should hide the Status Bar Item after the number of repositories becomes zero', () => {
		// Setup
		vscode.mockExtensionSettingReturnValue('showStatusBarItem', true);

		// Run
		const statusBarItem = new StatusBarItem(1, onDidChangeRepos.subscribe, onDidChangeConfiguration.subscribe, logger);

		// Assert
		expect(vscodeStatusBarItem.show).toHaveBeenCalledTimes(1);
		expect(vscodeStatusBarItem.hide).toHaveBeenCalledTimes(0);

		// Run
		onDidChangeRepos.emit({
			repos: {},
			numRepos: 0,
			loadRepo: null
		});

		// Assert
		expect(vscodeStatusBarItem.show).toHaveBeenCalledTimes(1);
		expect(vscodeStatusBarItem.hide).toHaveBeenCalledTimes(1);

		// Teardown
		statusBarItem.dispose();
	});

	it('Should show the Status Bar Item after the number of repositories increases above zero', () => {
		// Setup
		vscode.mockExtensionSettingReturnValue('showStatusBarItem', true);

		// Run
		const statusBarItem = new StatusBarItem(0, onDidChangeRepos.subscribe, onDidChangeConfiguration.subscribe, logger);

		// Assert
		expect(vscodeStatusBarItem.show).toHaveBeenCalledTimes(0);
		expect(vscodeStatusBarItem.hide).toHaveBeenCalledTimes(0);

		// Run
		onDidChangeRepos.emit({
			repos: {},
			numRepos: 1,
			loadRepo: null
		});

		// Assert
		expect(vscodeStatusBarItem.show).toHaveBeenCalledTimes(1);
		expect(vscodeStatusBarItem.hide).toHaveBeenCalledTimes(0);

		// Teardown
		statusBarItem.dispose();
	});

	it('Should hide the Status Bar Item the extension setting git-map.showStatusBarItem becomes disabled', () => {
		// Setup
		vscode.mockExtensionSettingReturnValue('showStatusBarItem', true);

		// Run
		const statusBarItem = new StatusBarItem(1, onDidChangeRepos.subscribe, onDidChangeConfiguration.subscribe, logger);

		// Assert
		expect(vscodeStatusBarItem.show).toHaveBeenCalledTimes(1);
		expect(vscodeStatusBarItem.hide).toHaveBeenCalledTimes(0);

		// Run
		vscode.mockExtensionSettingReturnValue('showStatusBarItem', false);
		onDidChangeConfiguration.emit({
			affectsConfiguration: () => true
		});

		// Assert
		expect(vscodeStatusBarItem.show).toHaveBeenCalledTimes(1);
		expect(vscodeStatusBarItem.hide).toHaveBeenCalledTimes(1);

		// Teardown
		statusBarItem.dispose();
	});

	it('Should ignore extension setting changes unrelated to git-map.showStatusBarItem', () => {
		// Setup
		vscode.mockExtensionSettingReturnValue('showStatusBarItem', true);

		// Run
		const statusBarItem = new StatusBarItem(1, onDidChangeRepos.subscribe, onDidChangeConfiguration.subscribe, logger);

		// Assert
		expect(vscodeStatusBarItem.show).toHaveBeenCalledTimes(1);
		expect(vscodeStatusBarItem.hide).toHaveBeenCalledTimes(0);

		// Run
		onDidChangeConfiguration.emit({
			affectsConfiguration: () => false
		});

		// Assert
		expect(vscodeStatusBarItem.show).toHaveBeenCalledTimes(1);
		expect(vscodeStatusBarItem.hide).toHaveBeenCalledTimes(0);

		// Teardown
		statusBarItem.dispose();
	});

	it('Should switch to the multi-colour logo icon without tinting text when git-map.ui.iconColorStyle is colorful', () => {
		vscode.mockExtensionSettingReturnValue('showStatusBarItem', true);
		vscode.mockExtensionSettingReturnValue('ui.iconColorStyle', 'colorful');

		const statusBarItem = new StatusBarItem(1, onDidChangeRepos.subscribe, onDidChangeConfiguration.subscribe, logger);

		expect(vscodeStatusBarItem.text).toBe('$(git-map-logo-color) Git Map');
		expect(vscodeStatusBarItem.color).toBeUndefined();
		expect(vscodeStatusBarItem.backgroundColor).toBeUndefined();

		vscode.mockExtensionSettingReturnValue('ui.iconColorStyle', 'monochrome');
		onDidChangeConfiguration.emit({
			affectsConfiguration: (section: string) => section === 'git-map.ui.iconColorStyle'
		});
		expect(vscodeStatusBarItem.text).toBe('$(git-map-logo) Git Map');

		statusBarItem.dispose();
	});
});
