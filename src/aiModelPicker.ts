import * as vscode from 'vscode';
import { AI_PROVIDER_VALUES, AiProvider, DirectAiConfig, PRESETS, fetchProviderModels, getDefaultBaseUrl } from './aiProviders';
import { getConfig } from './config';
import { t } from './l10n';
import { AiTaskKey, AiTaskModelOverride } from './types';
import { showErrorMessage } from './utils';

/**
 * The tasks whose model can be chosen separately from the default model.
 */
export const AI_MODEL_TASKS: ReadonlyArray<AiTaskKey> = ['commitMessage', 'reviewChanges', 'resolveConflicts', 'explainAndSearch'];

type ProviderPick = vscode.QuickPickItem & { readonly provider: string | null };
type ModelPick = vscode.QuickPickItem & { readonly model: string | null };

/**
 * The method run when the `git-map.ai.switchModel` command is invoked: choose the provider & model of AI features (the default), or of one
 * task (which can use the default model). The models of the chosen provider are listed (from Visual Studio Code, or the provider's
 * `/models` endpoint), and any model can also be entered.
 * @param arg The task (`'default'` or an `AiTaskKey`, also as `{ task }`); otherwise the default.
 * @returns TRUE if a model was chosen.
 */
export async function switchAiModel(arg?: unknown): Promise<boolean> {
	if (typeof vscode.window.showQuickPick !== 'function') return false;
	const raw = typeof arg === 'object' && arg !== null ? (<{ task?: unknown, ref?: unknown }>arg).task || (<{ ref?: unknown }>arg).ref : arg;
	const task: AiTaskKey | null = typeof raw === 'string' && (<ReadonlyArray<string>>AI_MODEL_TASKS).includes(raw) ? <AiTaskKey>raw : null;
	const cfg = getConfig(), override = task !== null ? cfg.aiTaskModels[task] : undefined;
	const currentProvider = override && override.provider ? override.provider : cfg.aiProvider;

	// 1. The provider
	const providers: ProviderPick[] = AI_PROVIDER_VALUES.map((provider) => ({
		label: provider === AiProvider.VsCode ? t('VS Code (Built-in / Copilot)') : PRESETS[provider].name,
		description: provider === currentProvider && (task === null || (override && override.provider)) ? t('Current') : undefined,
		provider: provider
	}));
	if (task !== null) providers.unshift({ label: t('Use the Default Model'), description: getProviderName(cfg.aiProvider) + (cfg.aiModel !== '' ? ' — ' + cfg.aiModel : ''), provider: null });
	const providerPick = await vscode.window.showQuickPick(providers, { title: getTitle(task), placeHolder: t('Select the AI provider'), ignoreFocusOut: true });
	if (typeof providerPick === 'undefined') return false;
	if (providerPick.provider === null) {
		await saveTaskModel(task!, null);
		return true;
	}
	const provider = providerPick.provider;

	// 2. The model
	const models: ModelPick[] = [];
	let listError: string | null = null;
	if (provider === AiProvider.VsCode) {
		const api: any = vscode;
		if (typeof api.lm === 'object' && api.lm !== null && typeof api.lm.selectChatModels === 'function') {
			try {
				const available: { id: string, name: string, vendor: string, family?: string }[] = await api.lm.selectChatModels();
				available.forEach((m) => models.push({ label: m.name, description: m.vendor + (m.family ? ' · ' + m.family : ''), model: m.id }));
			} catch (error) {
				listError = String(error);
			}
		}
		models.unshift({ label: t('The First Available Model'), description: t('Chosen by Visual Studio Code'), model: '' });
	} else {
		const preset = PRESETS[provider];
		const direct: DirectAiConfig = {
			provider: <AiProvider>provider,
			name: preset.name,
			baseUrl: (provider === cfg.aiProvider && cfg.aiBaseUrl !== '' ? cfg.aiBaseUrl : getDefaultBaseUrl(<AiProvider>provider)).replace(/\/+$/, ''),
			model: '',
			requiresApiKey: preset.requiresApiKey
		};
		const result = await fetchProviderModels(direct);
		result.models.forEach((m) => models.push({ label: m, model: m }));
		if (result.error !== null) listError = result.error;
		if (preset.model !== '' && !result.models.includes(preset.model)) models.unshift({ label: preset.model, description: t('Default of {0}', preset.name), model: preset.model });
	}
	models.push({ label: '$(edit) ' + t('Enter a Model ID…'), description: listError !== null ? listError : undefined, model: null });
	const modelPick = await vscode.window.showQuickPick(models, { title: getTitle(task) + ' · ' + getProviderName(provider), placeHolder: t('Select the model'), ignoreFocusOut: true, matchOnDescription: true });
	if (typeof modelPick === 'undefined') return false;
	let model = modelPick.model;
	if (model === null) {
		const entered = await vscode.window.showInputBox({ title: getTitle(task) + ' · ' + getProviderName(provider), prompt: t('The model ID (or endpoint ID) sent to {0}.', getProviderName(provider)), ignoreFocusOut: true });
		if (typeof entered !== 'string') return false;
		model = entered.trim();
	}

	// 3. Save it
	if (task === null) {
		const config = vscode.workspace.getConfiguration('git-map');
		try {
			if (provider !== cfg.aiProvider) {
				await config.update('ai.provider', provider, vscode.ConfigurationTarget.Global);
				await config.update('ai.baseUrl', undefined, vscode.ConfigurationTarget.Global);
			}
			await config.update('ai.model', model, vscode.ConfigurationTarget.Global);
		} catch (error) {
			showErrorMessage(String(error));
			return false;
		}
	} else {
		await saveTaskModel(task, { provider: provider, model: model !== '' ? model : undefined });
	}
	return true;
}

/**
 * Save the provider & model of a task (NULL => the task uses the default model).
 */
async function saveTaskModel(task: AiTaskKey, value: AiTaskModelOverride | null) {
	const config = vscode.workspace.getConfiguration('git-map');
	const current = Object.assign({}, <{ [key: string]: unknown }>(config.get('ai.taskModels') || {}));
	if (value === null) delete current[task];
	else current[task] = value;
	try {
		await config.update('ai.taskModels', current, vscode.ConfigurationTarget.Global);
	} catch (error) {
		showErrorMessage(String(error));
	}
}

function getProviderName(provider: string) {
	return provider === AiProvider.VsCode ? 'VS Code' : typeof PRESETS[provider] !== 'undefined' ? PRESETS[provider].name : provider;
}

function getTitle(task: AiTaskKey | null) {
	switch (task) {
		case 'commitMessage': return t('Git Map: AI Model for Composing Commits');
		case 'reviewChanges': return t('Git Map: AI Model for Reviewing Changes');
		case 'resolveConflicts': return t('Git Map: AI Model for Resolving Conflicts');
		case 'explainAndSearch': return t('Git Map: AI Model for Explaining & Searching');
		default: return t('Git Map: Default AI Provider & Model');
	}
}
