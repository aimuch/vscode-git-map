import * as vscode from 'vscode';
import { GitCodeLens } from './codeLens';
import { getConfig } from './config';
import { FileBlame } from './fileBlame';
import { FileChanges } from './fileChanges';
import { FileHeatmap } from './fileHeatmap';
import { t } from './l10n';
import { LineBlame } from './lineBlame';
import { EditorModeId, GitMapModeConfig } from './types';
import { Disposable } from './utils/disposable';

export function getBuiltInModes(): GitMapModeConfig[] {
	return [
		{ name: 'default', description: t('Use configured editor annotation settings') },
		{ name: 'zen', description: t('Hide all editor Git annotations for distraction-free coding'), annotations: 'off', codeLens: false, currentLine: false, statusBar: false, hovers: false },
		{ name: 'review', description: t('Enable inline blame, file changes, and heatmap for code review'), annotations: 'changes', codeLens: true, currentLine: true, statusBar: true, hovers: true }
	];
}

/**
 * Coordinates runtime annotation presets ("Modes" such as Default, Zen, Review, or user-defined modes) across all editor providers.
 */
export class EditorModeManager extends Disposable {
	private readonly lineBlame: LineBlame;
	private readonly codeLens: GitCodeLens;
	private readonly fileBlame: FileBlame;
	private readonly fileChanges: FileChanges;
	private readonly fileHeatmap: FileHeatmap;
	private statusBarItem: vscode.StatusBarItem;
	private statusBarAlignment: 'left' | 'right' = 'left';
	private activeMode: EditorModeId = 'default';

	constructor(
		lineBlame: LineBlame,
		codeLens: GitCodeLens,
		fileBlame: FileBlame,
		fileChanges: FileChanges,
		fileHeatmap: FileHeatmap
	) {
		super();
		this.lineBlame = lineBlame;
		this.codeLens = codeLens;
		this.fileBlame = fileBlame;
		this.fileChanges = fileChanges;
		this.fileHeatmap = fileHeatmap;
		const cfg = getConfig().modeConfig;
		this.statusBarAlignment = cfg.statusBarAlignment;
		this.statusBarItem = vscode.window.createStatusBarItem(
			'git-map.mode',
			this.statusBarAlignment === 'right' ? vscode.StatusBarAlignment.Right : vscode.StatusBarAlignment.Left,
			-10
		);
		this.statusBarItem.name = t('Git Map: Editor Mode');
		this.statusBarItem.command = 'git-map.switchMode';

		this.registerDisposables(
			{ dispose: () => this.statusBarItem.dispose() },
			vscode.commands.registerCommand('git-map.switchMode', (modeArg?: unknown) => this.switchModeCommand(modeArg)),
			vscode.workspace.onDidChangeConfiguration((e) => {
				if (e.affectsConfiguration('git-map.mode') || e.affectsConfiguration('git-map.modes') || e.affectsConfiguration('git-map.ui.iconColorStyle')) {
					this.syncFromConfig();
				}
			})
		);
		this.syncFromConfig();
	}

	public getActiveMode(): EditorModeId {
		return this.activeMode;
	}

	public getAllModes(): GitMapModeConfig[] {
		const builtIn = getBuiltInModes();
		const custom = getConfig().modeConfig.customModes;
		const merged = new Map<string, GitMapModeConfig>();
		builtIn.forEach((m) => merged.set(m.name, m));
		custom.forEach((m) => merged.set(m.name, m));
		return Array.from(merged.values());
	}

	public applyMode(modeName: EditorModeId) {
		const modes = this.getAllModes();
		const target = modes.find((m) => m.name === modeName) || modes[0];
		this.activeMode = target.name;

		if (target.name === 'default') {
			this.lineBlame.setModeOverride(null);
			this.codeLens.setModeOverride(null);
			this.fileBlame.setModeOverride(null);
			this.fileChanges.setModeOverride(null);
			this.fileHeatmap.setModeOverride(null);
		} else {
			this.lineBlame.setModeOverride({
				inline: target.currentLine,
				statusBar: target.statusBar,
				hovers: target.hovers
			});
			this.codeLens.setModeOverride(typeof target.codeLens === 'boolean' ? target.codeLens : null);
			if (target.annotations === 'off') {
				this.fileBlame.setModeOverride(false);
				this.fileChanges.setModeOverride(false);
				this.fileHeatmap.setModeOverride(false);
			} else if (target.annotations === 'blame') {
				this.fileBlame.setModeOverride(true);
				this.fileChanges.setModeOverride(false);
				this.fileHeatmap.setModeOverride(false);
			} else if (target.annotations === 'changes') {
				this.fileBlame.setModeOverride(false);
				this.fileChanges.setModeOverride(true);
				this.fileHeatmap.setModeOverride(false);
			} else if (target.annotations === 'heatmap') {
				this.fileBlame.setModeOverride(false);
				this.fileChanges.setModeOverride(false);
				this.fileHeatmap.setModeOverride(true);
			} else {
				this.fileBlame.setModeOverride(null);
				this.fileChanges.setModeOverride(null);
				this.fileHeatmap.setModeOverride(null);
			}
		}
		this.updateStatusBar();
	}

	private syncFromConfig() {
		const cfg = getConfig().modeConfig;
		if (cfg.statusBarAlignment !== this.statusBarAlignment) {
			this.statusBarAlignment = cfg.statusBarAlignment;
			this.statusBarItem.dispose();
			this.statusBarItem = vscode.window.createStatusBarItem(
				'git-map.mode',
				this.statusBarAlignment === 'right' ? vscode.StatusBarAlignment.Right : vscode.StatusBarAlignment.Left,
				-10
			);
			this.statusBarItem.name = t('Git Map: Editor Mode');
			this.statusBarItem.command = 'git-map.switchMode';
		}
		this.applyMode(cfg.active);
	}

	private updateStatusBar() {
		const cfg = getConfig().modeConfig;
		if (!cfg.statusBarEnabled) {
			this.statusBarItem.hide();
			return;
		}
		this.statusBarItem.text = '$(eye) ' + t('Mode: {0}', this.activeMode);
		this.statusBarItem.tooltip = t('Active Git Map editor mode (click to switch)');
		this.statusBarItem.color = getConfig().iconColorStyle === 'colorful'
			? new vscode.ThemeColor(this.activeMode === 'zen' ? 'charts.purple' : this.activeMode === 'review' ? 'charts.orange' : 'charts.green')
			: undefined;
		this.statusBarItem.show();
	}

	public async switchModeCommand(modeArg?: unknown): Promise<string | null> {
		if (typeof modeArg === 'string' && modeArg.trim() !== '') {
			this.applyMode(modeArg.trim());
			return this.activeMode;
		}
		if (typeof vscode.window.showQuickPick !== 'function') return null;
		const modes = this.getAllModes();
		const picked = await vscode.window.showQuickPick(
			modes.map((m) => ({
				label: (m.name === this.activeMode ? '$(check) ' : '') + m.name,
				description: m.description || '',
				modeName: m.name
			})),
			{
				title: t('Git Map: Switch Editor Mode'),
				placeHolder: t('Select an annotation mode preset'),
				ignoreFocusOut: true
			}
		);
		if (typeof picked === 'undefined') return null;
		this.applyMode(picked.modeName);
		return this.activeMode;
	}
}
