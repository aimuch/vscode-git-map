import * as vscode from 'vscode';
import { getConfig } from './config';
import { Logger } from './logger';
import { RepoChangeEvent } from './repoManager';
import { StatusBarItemDisplay } from './types';
import { Disposable } from './utils/disposable';
import { Event } from './utils/event';
import { t } from './l10n';

/**
 * Manages the Git Map Status Bar Item, which allows users to open the Git Map View from the Visual Studio Code Status Bar.
 */
export class StatusBarItem extends Disposable {
	private readonly logger: Logger;
	private readonly statusBarItem: vscode.StatusBarItem;
	private isVisible: boolean = false;
	private numRepos: number = 0;

	/**
	 * Creates the Git Map Status Bar Item.
	 * @param repoManager The Git Map RepoManager instance.
	 * @param logger The Git Map Logger instance.
	 */
	constructor(initialNumRepos: number, onDidChangeRepos: Event<RepoChangeEvent>, onDidChangeConfiguration: Event<vscode.ConfigurationChangeEvent>, logger: Logger) {
		super();
		this.logger = logger;

		const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1);
		statusBarItem.name = 'Git Map';
		statusBarItem.text = getStatusBarItemText();
		statusBarItem.tooltip = t('View Git Map');
		statusBarItem.command = 'git-map.view';
		this.statusBarItem = statusBarItem;

		this.registerDisposables(
			onDidChangeRepos((event) => {
				this.setNumRepos(event.numRepos);
			}),
			onDidChangeConfiguration((event) => {
				if (event.affectsConfiguration('git-map.showStatusBarItem')) {
					this.refresh();
				}
				if (event.affectsConfiguration('git-map.statusBarItemDisplay') || event.affectsConfiguration('git-map.ui.iconColorStyle')) {
					this.statusBarItem.text = getStatusBarItemText();
				}
				if (event.affectsConfiguration('git-map.language')) {
					this.statusBarItem.tooltip = t('View Git Map');
				}
			}),
			statusBarItem
		);

		this.setNumRepos(initialNumRepos);
	}

	/**
	 * Sets the number of repositories known to Git Map, before refreshing the Status Bar Item.
	 * @param numRepos The number of repositories known to Git Map.
	 */
	private setNumRepos(numRepos: number) {
		this.numRepos = numRepos;
		this.refresh();
	}

	/**
	 * Show or hide the Status Bar Item according to the configured value of `git-map.showStatusBarItem`, and the number of repositories known to Git Map.
	 */
	private refresh() {
		const shouldBeVisible = getConfig().showStatusBarItem && this.numRepos > 0;
		if (this.isVisible !== shouldBeVisible) {
			if (shouldBeVisible) {
				this.statusBarItem.show();
				this.logger.log('Showing "Git Map" Status Bar Item');
			} else {
				this.statusBarItem.hide();
				this.logger.log('Hiding "Git Map" Status Bar Item');
			}
			this.isVisible = shouldBeVisible;
		}
	}
}

/**
 * Get the text of the Status Bar Item, according to the configured value of `git-map.statusBarItemDisplay`.
 * @returns The text, using the `git-map-logo` icon contributed by Git Map.
 */
function getStatusBarItemText() {
	const logo = getConfig().iconColorStyle === 'colorful' ? '$(git-map-logo-color)' : '$(git-map-logo)';
	switch (getConfig().statusBarItemDisplay) {
		case StatusBarItemDisplay.Icon:
			return logo;
		case StatusBarItemDisplay.Text:
			return 'Git Map';
		default:
			return logo + ' Git Map';
	}
}
