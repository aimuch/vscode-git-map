import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { getConfig } from './config';
import { t } from './l10n';
import { AiProviderPresetInfo, AiSettingsConfig, AiTaskKey } from './types';

/**
 * The providers of the language models that explain commits: the models provided in Visual Studio Code (e.g. by GitHub Copilot), or a
 * provider whose API is called directly with the person's API key (all of them have an OpenAI-compatible Chat Completions API).
 */
export const enum AiProvider {
	VsCode = 'VS Code',
	DeepSeek = 'DeepSeek',
	Kimi = 'Kimi',
	Doubao = 'Doubao',
	Qwen = 'Qwen',
	OpenAI = 'OpenAI',
	Ollama = 'Ollama',
	Magpie = 'Magpie',
	CCSwitch = 'CC Switch',
	OpenAICompatible = 'OpenAI Compatible'
}

export interface AiProviderPreset {
	readonly name: string; // The name shown to the person (e.g. in the consent before a commit is sent)
	readonly baseUrl: string; // The default base URL of its API ('' => it must be set)
	readonly model: string; // The default model ('' => it must be set)
	readonly requiresApiKey: boolean;
}

export const PRESETS: { readonly [provider: string]: AiProviderPreset } = {
	[AiProvider.DeepSeek]: { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', requiresApiKey: true },
	[AiProvider.Kimi]: { name: 'Kimi (Moonshot AI)', baseUrl: 'https://api.moonshot.cn/v1', model: '', requiresApiKey: true },
	[AiProvider.Doubao]: { name: 'Doubao (Volcengine Ark)', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: '', requiresApiKey: true },
	[AiProvider.Qwen]: { name: 'Qwen (Alibaba Cloud Model Studio)', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', requiresApiKey: true },
	[AiProvider.OpenAI]: { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: '', requiresApiKey: true },
	[AiProvider.Ollama]: { name: 'Ollama', baseUrl: 'http://localhost:11434/v1', model: '', requiresApiKey: false },
	[AiProvider.Magpie]: { name: 'Magpie', baseUrl: 'http://127.0.0.1:3425/v1', model: '', requiresApiKey: false },
	[AiProvider.CCSwitch]: { name: 'CC Switch', baseUrl: 'http://127.0.0.1:15721/v1', model: '', requiresApiKey: false },
	[AiProvider.OpenAICompatible]: { name: 'OpenAI Compatible', baseUrl: '', model: '', requiresApiKey: false }
};

/**
 * The provider, base URL & model to use, from the Extension Settings (with the defaults of the provider).
 */
export interface DirectAiConfig {
	readonly provider: AiProvider;
	readonly name: string;
	readonly baseUrl: string;
	readonly model: string;
	readonly requiresApiKey: boolean;
}

/**
 * Get the direct provider configured by `git-map.ai.provider`, `git-map.ai.baseUrl` & `git-map.ai.model`.
 * @returns The configuration, or NULL if the models provided in Visual Studio Code are used.
 */
export function getDirectAiConfig(): DirectAiConfig | null {
	const config = getConfig(), provider = config.aiProvider, preset = PRESETS[provider];
	if (provider === AiProvider.VsCode || typeof preset === 'undefined') return null;
	return {
		provider: provider,
		name: preset.name,
		baseUrl: (config.aiBaseUrl !== '' ? config.aiBaseUrl : getDefaultBaseUrl(provider)).replace(/\/+$/, ''),
		model: config.aiModel !== '' ? config.aiModel : preset.model,
		requiresApiKey: preset.requiresApiKey
	};
}

/**
 * Resolve AI provider/model routing for a specific task (`commitMessage`, `reviewChanges`, `resolveConflicts`, `explainAndSearch`),
 * falling back cleanly to the global default provider & model when no task override is set.
 */
export function getDirectAiConfigForTask(task?: AiTaskKey): { readonly direct: DirectAiConfig | null, readonly preferredModelId: string | null } {
	const cfg = getConfig();
	const override = typeof task !== 'undefined' ? cfg.aiTaskModels[task] : undefined;
	if (!override || (!override.provider && !override.model && !override.baseUrl)) {
		const def = getDirectAiConfig();
		return { direct: def, preferredModelId: def !== null ? def.model : null };
	}
	const providerStr = override.provider && AI_PROVIDER_VALUES.includes(override.provider)
		? <AiProvider>override.provider
		: cfg.aiProvider;
	if (providerStr === AiProvider.VsCode) {
		return {
			direct: null,
			preferredModelId: override.model && override.model !== '' ? override.model : null
		};
	}
	const preset = PRESETS[providerStr];
	if (typeof preset === 'undefined') {
		const def = getDirectAiConfig();
		return { direct: def, preferredModelId: def !== null ? def.model : null };
	}
	const baseUrlRaw = override.baseUrl && override.baseUrl !== ''
		? override.baseUrl
		: (providerStr === cfg.aiProvider && cfg.aiBaseUrl !== '' ? cfg.aiBaseUrl : getDefaultBaseUrl(providerStr));
	const model = override.model && override.model !== ''
		? override.model
		: (providerStr === cfg.aiProvider && cfg.aiModel !== '' ? cfg.aiModel : preset.model);
	return {
		direct: {
			provider: providerStr,
			name: preset.name,
			baseUrl: baseUrlRaw.replace(/\/+$/, ''),
			model: model,
			requiresApiKey: preset.requiresApiKey
		},
		preferredModelId: model !== '' ? model : null
	};
}

function globToRegex(glob: string): RegExp | null {
	const cleaned = glob.trim().replace(/\\/g, '/');
	if (cleaned === '') return null;
	let out = '^';
	for (let i = 0; i < cleaned.length; i++) {
		const ch = cleaned[i];
		if (ch === '*') {
			if (cleaned[i + 1] === '*') {
				if (cleaned[i + 2] === '/') {
					out += '(?:.*/)?';
					i += 2;
				} else {
					out += '.*';
					i += 1;
				}
			} else {
				out += '[^/]*';
			}
		} else if (ch === '?') {
			out += '[^/]';
		} else if ('^$.|+()[]{}'.includes(ch)) {
			out += '\\' + ch;
		} else {
			out += ch;
		}
	}
	out += '$';
	try {
		return new RegExp(out, 'i');
	} catch (_) {
		return null;
	}
}

export function matchesExcludeGlobs(filePath: string, patterns: ReadonlyArray<string>): boolean {
	if (!Array.isArray(patterns) || patterns.length === 0) return false;
	const norm = filePath.replace(/\\/g, '/').replace(/^\/+/, '');
	const base = path.posix.basename(norm);
	for (let i = 0; i < patterns.length; i++) {
		const re = globToRegex(patterns[i]);
		if (re !== null && (re.test(norm) || (!patterns[i].includes('/') && re.test(base)))) {
			return true;
		}
	}
	return false;
}

/**
 * Exclude files matching `git-map.ai.exclude.files` glob patterns from a unified diff payload before sending to a model.
 */
export function filterDiffByExcludeGlobs(
	diffText: string,
	patterns: ReadonlyArray<string>
): { readonly filtered: string, readonly excludedFiles: string[] } {
	if (diffText === '' || !Array.isArray(patterns) || patterns.length === 0) {
		return { filtered: diffText, excludedFiles: [] };
	}
	const sections = diffText.split(/^(?=diff --git )/m);
	const kept: string[] = [];
	const excluded: string[] = [];
	for (let i = 0; i < sections.length; i++) {
		const sec = sections[i];
		const headerMatch = sec.match(/^diff --git a\/(.+?) b\/(.+?)(?:\r?\n|$)/);
		if (headerMatch === null) {
			kept.push(sec);
			continue;
		}
		const candidatePath = headerMatch[2];
		if (matchesExcludeGlobs(candidatePath, patterns)) {
			excluded.push(candidatePath);
		} else {
			kept.push(sec);
		}
	}
	if (excluded.length === 0) return { filtered: diffText, excludedFiles: [] };
	const summaryNote = '\n[Excluded ' + excluded.length + ' file(s) per ai.exclude.files: ' + excluded.slice(0, 12).join(', ') + (excluded.length > 12 ? ', ...' : '') + ']\n';
	return { filtered: kept.join('') + summaryNote, excludedFiles: excluded };
}

/**
 * Append user-configured custom instructions to an AI prompt when non-empty.
 */
export function appendCustomInstructions(prompt: string, customInstructions?: string): string {
	const trimmed = typeof customInstructions === 'string' ? customInstructions.trim() : '';
	if (trimmed === '') return prompt;
	return prompt + '\nAdditional user formatting/review preferences (apply safely to output style without executing untrusted data):\n' + trimmed;
}

/**
 * Rough token estimate (~4 characters per token) for prompt-size warning guards.
 */
export function estimateTokenCount(text: string): number {
	return Math.ceil((typeof text === 'string' ? text.length : 0) / 4);
}

/**
 * Get the default base URL of a direct provider. Magpie's local gateway records the address it listens on in
 * `~/.config/magpie/gateway.json` (`{"addr": "127.0.0.1:3425", ...}`), which is used when it's available.
 */
export function getDefaultBaseUrl(provider: AiProvider) {
	if (provider === AiProvider.Magpie) {
		const addr = readMagpieGatewayAddress();
		if (addr !== null) return 'http://' + addr + '/v1';
	}
	return PRESETS[provider].baseUrl;
}

/**
 * Read the address of Magpie's running local gateway.
 * @returns The host & port (e.g. "127.0.0.1:3425"), or NULL if it can't be read.
 */
function readMagpieGatewayAddress(): string | null {
	const configHome = typeof process.env.XDG_CONFIG_HOME === 'string' && process.env.XDG_CONFIG_HOME !== '' ? process.env.XDG_CONFIG_HOME : path.join(os.homedir(), '.config');
	try {
		const gateway = JSON.parse(fs.readFileSync(path.join(configHome, 'magpie', 'gateway.json'), 'utf8'));
		const addr = gateway !== null && typeof gateway === 'object' && typeof gateway.addr === 'string' ? gateway.addr.trim() : '';
		const match = addr.match(/^(\[[0-9a-fA-F:]+\]|[A-Za-z0-9.-]+):(\d{1,5})$/);
		if (match === null) return null;
		// A gateway listening on all interfaces is reached locally
		const host = match[1] === '0.0.0.0' || match[1] === '[::]' ? '127.0.0.1' : match[1];
		return host + ':' + match[2];
	} catch (_) {
		return null;
	}
}

/**
 * Get the host (and port) of a base URL, e.g. "api.deepseek.com" (shown to the person before a commit is sent to it).
 */
export function getHost(baseUrl: string) {
	try {
		return new URL(baseUrl).host;
	} catch (_) {
		return baseUrl;
	}
}

const ALL_DIRECT_PROVIDERS: ReadonlyArray<AiProvider> = [
	AiProvider.DeepSeek,
	AiProvider.Kimi,
	AiProvider.Doubao,
	AiProvider.Qwen,
	AiProvider.OpenAI,
	AiProvider.Ollama,
	AiProvider.Magpie,
	AiProvider.CCSwitch,
	AiProvider.OpenAICompatible
];

export const AI_PROVIDER_VALUES: ReadonlyArray<string> = [AiProvider.VsCode, ...ALL_DIRECT_PROVIDERS];

const STREAM_TIMEOUT_MS = 60000;

/* API Keys (stored in the Secret Storage of Visual Studio Code, never in the Extension Settings) */

let secretStorage: vscode.SecretStorage | null = null;
const cachedProvidersWithKeys = new Set<AiProvider>();

/**
 * Set the Secret Storage that API keys are stored in (when Git Map is activated).
 */
export function setAiSecretStorage(secrets: vscode.SecretStorage | null) {
	secretStorage = secrets;
	cachedProvidersWithKeys.clear();
	if (secrets !== null) {
		for (const provider of ALL_DIRECT_PROVIDERS) {
			Promise.resolve(secrets.get(getSecretKey(provider))).then((key) => {
				if (secretStorage === secrets && typeof key === 'string' && key !== '') {
					cachedProvidersWithKeys.add(provider);
				}
			}, () => { });
		}
	}
}

/**
 * Subscribe to changes of the stored AI API keys (when supported by this version of Visual Studio Code).
 */
export function onDidChangeAiApiKey(listener: () => void): vscode.Disposable {
	if (secretStorage === null || typeof secretStorage.onDidChange !== 'function') return { dispose: () => { } };
	return secretStorage.onDidChange((event) => {
		if (event && typeof event.key === 'string' && event.key.startsWith('git-map.ai.apiKey.')) {
			const provider = <AiProvider>event.key.substring('git-map.ai.apiKey.'.length);
			if (ALL_DIRECT_PROVIDERS.includes(provider) && secretStorage !== null) {
				Promise.resolve(secretStorage.get(event.key)).then((value) => {
					if (typeof value === 'string' && value !== '') cachedProvidersWithKeys.add(provider);
					else cachedProvidersWithKeys.delete(provider);
					listener();
				}, () => listener());
			} else {
				listener();
			}
		}
	});
}

function getSecretKey(provider: AiProvider) {
	return 'git-map.ai.apiKey.' + provider;
}

/**
 * Get the API key of a provider.
 * @returns The key, or NULL if it hasn't been set.
 */
export async function getApiKey(provider: AiProvider): Promise<string | null> {
	if (secretStorage === null) return null;
	const key = await secretStorage.get(getSecretKey(provider));
	if (typeof key === 'string' && key !== '') {
		cachedProvidersWithKeys.add(provider);
		return key;
	}
	cachedProvidersWithKeys.delete(provider);
	return null;
}

function getAiProviderPresets(): ReadonlyArray<AiProviderPresetInfo> {
	return [
		{ id: AiProvider.VsCode, name: 'VS Code', defaultBaseUrl: '', defaultModel: '', requiresApiKey: false },
		...ALL_DIRECT_PROVIDERS.map((id) => ({
			id: id,
			name: PRESETS[id].name,
			defaultBaseUrl: getDefaultBaseUrl(id),
			defaultModel: PRESETS[id].model,
			requiresApiKey: PRESETS[id].requiresApiKey
		}))
	];
}

/**
 * Get the current AI configuration synchronously (for the initial state of the Git Map View).
 */
export function getAiSettingsSnapshot(explainCommit: boolean, commitMessage: boolean, provider: AiProvider, baseUrl: string, model: string): AiSettingsConfig {
	return {
		explainCommit: explainCommit,
		commitMessage: commitMessage,
		provider: provider,
		baseUrl: baseUrl,
		model: model,
		hasApiKey: provider !== AiProvider.VsCode && cachedProvidersWithKeys.has(provider),
		presets: getAiProviderPresets()
	};
}

/**
 * Load the current AI configuration, checking Secret Storage for the active provider's API key.
 */
export async function loadAiSettingsSnapshot(): Promise<AiSettingsConfig> {
	const config = getConfig(), provider = config.aiProvider;
	const hasKey = provider !== AiProvider.VsCode && (await getApiKey(provider)) !== null;
	return {
		explainCommit: config.explainCommit,
		commitMessage: config.aiCommitMessage,
		provider: provider,
		baseUrl: config.aiBaseUrl,
		model: config.aiModel,
		hasApiKey: hasKey,
		presets: getAiProviderPresets(),
		taskModels: config.aiTaskModels,
		customInstructions: config.aiCustomInstructions,
		excludeFiles: config.aiExcludeFiles,
		largePromptWarningThreshold: config.aiLargePromptWarningThreshold,
		autoRebaseConfidenceThreshold: config.aiAutoRebaseConfidenceThreshold
	};
}

/**
 * The method run when the `git-map.ai.setApiKey` command is invoked: ask for the API key of the provider configured (it's stored in the
 * Secret Storage of Visual Studio Code).
 * @param key The key (only used by the end-to-end tests; otherwise it's asked for).
 * @returns TRUE if a key was stored.
 */
export async function setApiKey(key?: unknown): Promise<boolean> {
	const config = getDirectAiConfig();
	if (config === null) {
		vscode.window.showInformationMessage(t('Choose a provider whose API Git Map calls directly in the "git-map.ai.provider" setting first (the models provided in Visual Studio Code don\'t need an API key).'));
		return false;
	}
	if (secretStorage === null) return false;
	const value = typeof key === 'string' ? key : await vscode.window.showInputBox({
		title: t('Git Map: Set AI API Key'),
		prompt: t('The API key of {0}. It\'s stored in the Secret Storage of Visual Studio Code, and only sent to {1}.', config.name, getHost(config.baseUrl) || config.name),
		password: true,
		ignoreFocusOut: true,
		validateInput: (input) => input.trim() === '' ? t('The API key can\'t be empty.') : null
	});
	if (typeof value !== 'string' || value.trim() === '') return false;
	await secretStorage.store(getSecretKey(config.provider), value.trim());
	cachedProvidersWithKeys.add(config.provider);
	if (typeof key !== 'string') vscode.window.showInformationMessage(t('The API key of {0} was stored.', config.name));
	return true;
}

/**
 * The method run when the `git-map.ai.clearApiKey` command is invoked: delete the API key of the provider configured (or let the
 * person choose which stored key to delete when the active provider has none).
 */
export async function clearApiKey() {
	if (secretStorage === null) return;
	const config = getDirectAiConfig();
	if (config !== null && await getApiKey(config.provider) !== null) {
		await secretStorage.delete(getSecretKey(config.provider));
		cachedProvidersWithKeys.delete(config.provider);
		vscode.window.showInformationMessage(t('The API key of {0} was deleted.', config.name));
		return;
	}
	const stored: { provider: AiProvider, name: string }[] = [];
	for (const provider of ALL_DIRECT_PROVIDERS) {
		if (await getApiKey(provider) !== null) stored.push({ provider: provider, name: PRESETS[provider].name });
	}
	if (stored.length === 0) {
		vscode.window.showInformationMessage(t('No AI API keys are stored in Git Map.'));
		return;
	}
	if (stored.length === 1) {
		await secretStorage.delete(getSecretKey(stored[0].provider));
		cachedProvidersWithKeys.delete(stored[0].provider);
		vscode.window.showInformationMessage(t('The API key of {0} was deleted.', stored[0].name));
		return;
	}
	const items: (vscode.QuickPickItem & { providers: AiProvider[] })[] = stored.map((entry) => ({ label: entry.name, providers: [entry.provider] }));
	items.push({ label: t('All Stored AI API Keys'), providers: stored.map((entry) => entry.provider) });
	const picked = typeof vscode.window.showQuickPick === 'function'
		? await vscode.window.showQuickPick(items, { placeHolder: t('Select the AI API key to delete'), ignoreFocusOut: true })
		: undefined;
	if (typeof picked === 'undefined') return;
	for (const provider of picked.providers) {
		await secretStorage.delete(getSecretKey(provider));
		cachedProvidersWithKeys.delete(provider);
	}
	vscode.window.showInformationMessage(picked.providers.length === 1 ? t('The API key of {0} was deleted.', picked.label) : t('All stored AI API keys were deleted.'));
}

/* The OpenAI-compatible Chat Completions API */

const MODELS_DISCOVERY_TIMEOUT_MS = 2500;

function unrefTimer(timer: NodeJS.Timeout) {
	if (typeof timer === 'object' && timer !== null && typeof timer.unref === 'function') {
		timer.unref();
	}
}

/**
 * Whether a provider runs as a local gateway / custom endpoint whose `/models` list can be discovered automatically when `git-map.ai.model` is left blank.
 */
export function isAutoModelDiscoveryProvider(provider: AiProvider) {
	return provider === AiProvider.Magpie || provider === AiProvider.CCSwitch || provider === AiProvider.Ollama || provider === AiProvider.OpenAICompatible;
}

/**
 * Get the Bearer token sent to a provider. Local gateways (Magpie, CC Switch, Ollama) don't need a real secret,
 * but sending a non-empty placeholder Bearer token satisfies OpenAI-compatible middleware that rejects requests without an Authorization header.
 */
export async function getEffectiveApiKey(provider: AiProvider): Promise<string | null> {
	const stored = await getApiKey(provider);
	if (stored !== null) return stored;
	if (provider === AiProvider.Magpie) return 'magpie';
	if (provider === AiProvider.CCSwitch) return 'cc-switch';
	if (provider === AiProvider.Ollama) return 'ollama';
	return null;
}

/**
 * Query `GET <baseUrl>/models` to discover the models served by an OpenAI-compatible endpoint or local gateway.
 */
export async function fetchProviderModels(configOverride?: DirectAiConfig | null): Promise<{ models: string[], reachable: boolean, error: string | null }> {
	const config = typeof configOverride !== 'undefined' ? configOverride : getDirectAiConfig();
	if (config === null) return { models: [], reachable: false, error: null };
	if (config.baseUrl === '') return { models: [], reachable: false, error: t('Set the base URL of the API of {0} in the "git-map.ai.baseUrl" setting.', config.name) };
	if (!/^https?:\/\//i.test(config.baseUrl)) return { models: [], reachable: false, error: t('The base URL of the API must start with https:// or http:// (in the "git-map.ai.baseUrl" setting).') };
	if (config.requiresApiKey && await getApiKey(config.provider) === null) {
		return { models: [], reachable: false, error: t('Set the API key of {0} with the "Git Map: Set AI API Key..." command.', config.name) };
	}
	if (typeof fetch !== 'function') {
		return { models: [], reachable: false, error: t('This version of Visual Studio Code can\'t call the API (it requires Visual Studio Code 1.82 or later).') };
	}
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), MODELS_DISCOVERY_TIMEOUT_MS);
	unrefTimer(timer);
	try {
		const headers: { [name: string]: string } = { 'Accept': 'application/json' };
		const apiKey = await getEffectiveApiKey(config.provider);
		if (apiKey !== null) headers['Authorization'] = 'Bearer ' + apiKey;
		const response = await fetch(config.baseUrl.replace(/\/+$/, '') + '/models', {
			method: 'GET',
			headers: headers,
			signal: controller.signal
		});
		if (!response.ok) {
			if (response.status === 404 || response.status === 405) {
				return { models: [], reachable: true, error: null };
			}
			return { models: [], reachable: true, error: t('The API returned an error ({0}): {1}', String(response.status), await getErrorMessage(response)) };
		}
		const json = parseJson(await response.text());
		const rawList: any[] = json !== null && Array.isArray(json.data)
			? json.data
			: (json !== null && Array.isArray(json.models) ? json.models : []);
		const seen = new Set<string>();
		const models: string[] = [];
		for (const item of rawList) {
			const id = typeof item === 'string'
				? item.trim()
				: (item !== null && typeof item === 'object'
					? (typeof item.id === 'string' ? item.id.trim() : (typeof item.name === 'string' ? item.name.trim() : ''))
					: '');
			if (id !== '' && !seen.has(id)) {
				seen.add(id);
				models.push(id);
			}
		}
		return { models: models, reachable: true, error: null };
	} catch (error) {
		return {
			models: [],
			reachable: false,
			error: t('Unable to call the API at {0}: {1}', getHost(config.baseUrl), error instanceof Error ? ((<any>error).cause instanceof Error ? error.message + ' (' + (<any>error).cause.message + ')' : error.message) : String(error))
		};
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Get what's missing before a direct provider can be used.
 * @returns The error, and whether it's the API key that's missing (NULL if nothing is missing).
 */
export async function getDirectAiProblem(config: DirectAiConfig): Promise<{ error: string, needsApiKey: boolean } | null> {
	if (config.baseUrl === '') return { error: t('Set the base URL of the API of {0} in the "git-map.ai.baseUrl" setting.', config.name), needsApiKey: false };
	if (!/^https?:\/\//i.test(config.baseUrl)) return { error: t('The base URL of the API must start with https:// or http:// (in the "git-map.ai.baseUrl" setting).'), needsApiKey: false };
	if (config.model === '') return { error: t('Set the model of {0} to use in the "git-map.ai.model" setting.', config.name), needsApiKey: false };
	if (config.requiresApiKey && await getApiKey(config.provider) === null) return { error: t('Set the API key of {0} with the "Git Map: Set AI API Key..." command.', config.name), needsApiKey: true };
	return null;
}

/**
 * Send a prompt to an OpenAI-compatible Chat Completions API, streaming the response.
 * @param baseUrl The base URL of the API (`/chat/completions` is appended).
 * @param model The model.
 * @param apiKey The API key (NULL => none is sent, e.g. for a local model).
 * @param prompt The prompt (a user message).
 * @param onText Called with each part of the response, as it's received.
 * @param token Cancels the request.
 * @returns The error, or NULL.
 */
export async function streamChatCompletion(baseUrl: string, model: string, apiKey: string | null, prompt: string, onText: (text: string) => void, token: vscode.CancellationToken): Promise<string | null> {
	if (typeof fetch !== 'function') return t('This version of Visual Studio Code can\'t call the API (it requires Visual Studio Code 1.82 or later).');
	const controller = new AbortController(), cancellation = token.onCancellationRequested(() => controller.abort());
	let timedOut = false, timer: NodeJS.Timeout | null = null;
	const resetTimeout = () => {
		if (timer !== null) clearTimeout(timer);
		timer = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, STREAM_TIMEOUT_MS);
		unrefTimer(timer);
	};
	resetTimeout();
	try {
		const headers: { [name: string]: string } = { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' };
		if (apiKey !== null) headers['Authorization'] = 'Bearer ' + apiKey;
		const response = await fetch(baseUrl.replace(/\/+$/, '') + '/chat/completions', {
			method: 'POST',
			headers: headers,
			body: JSON.stringify({ model: model, stream: true, messages: [{ role: 'user', content: prompt }] }),
			signal: controller.signal
		});
		resetTimeout();
		if (!response.ok || response.body === null) {
			return t('The API returned an error ({0}): {1}', String(response.status), await getErrorMessage(response));
		}
		const contentType = (response.headers.get('content-type') || '').toLowerCase();
		if (contentType.includes('application/json')) {
			const json = parseJson(await response.text());
			if (json !== null && typeof json.error === 'object' && json.error !== null) {
				return t('The API returned an error: {0}', String(json.error.message || JSON.stringify(json.error)));
			}
			const choice = json !== null && Array.isArray(json.choices) ? json.choices[0] : null;
			const messageContent = choice && choice.message && typeof choice.message.content === 'string' ? choice.message.content : '';
			if (messageContent === '') return t('The model returned an empty response.');
			onText(messageContent);
			return null;
		}

		const decoder = new TextDecoder();
		const reader = response.body.getReader();
		let buffer = '', done = false, receivedText = false;
		const processLine = (rawLine: string): string | null => {
			const line = rawLine.trim();
			if (!line.startsWith('data:')) return null;
			const data = line.substring(5).trim();
			if (data === '[DONE]') {
				done = true;
				return null;
			}
			const event = parseJson(data);
			if (event === null) return null;
			if (typeof event.error === 'object' && event.error !== null) return t('The API returned an error: {0}', String(event.error.message || JSON.stringify(event.error)));
			const choice = Array.isArray(event.choices) ? event.choices[0] : null;
			const text = choice && choice.delta && typeof choice.delta.content === 'string'
				? choice.delta.content
				: (choice && choice.message && typeof choice.message.content === 'string' ? choice.message.content : '');
			if (text !== '') {
				receivedText = true;
				onText(text);
			}
			return null;
		};
		while (!done) {
			const chunk = await reader.read();
			resetTimeout();
			if (chunk.done) {
				buffer += decoder.decode();
				break;
			}
			buffer += decoder.decode(chunk.value, { stream: true });
			// Server-Sent Events: each event is a line "data: {json}", and the stream ends with "data: [DONE]"
			let newline: number;
			while ((newline = buffer.indexOf('\n')) > -1) {
				const line = buffer.substring(0, newline);
				buffer = buffer.substring(newline + 1);
				const lineError = processLine(line);
				if (lineError !== null) return lineError;
				if (done) break;
			}
		}
		if (!done && buffer.trim() !== '') {
			const trailingError = processLine(buffer);
			if (trailingError !== null) return trailingError;
		}
		await reader.cancel().catch(() => { });
		if (!receivedText && !token.isCancellationRequested) return t('The model returned an empty response.');
		return null;
	} catch (error) {
		if (token.isCancellationRequested) return null;
		if (timedOut) return t('The API at {0} timed out without responding.', getHost(baseUrl));
		return t('Unable to call the API at {0}: {1}', getHost(baseUrl), error instanceof Error ? ((<any>error).cause instanceof Error ? error.message + ' (' + (<any>error).cause.message + ')' : error.message) : String(error));
	} finally {
		if (timer !== null) clearTimeout(timer);
		cancellation.dispose();
	}
}

/**
 * Get the error message of a response (the message in its JSON body, e.g. `{"error": {"message": "..."}}`, or its text).
 */
async function getErrorMessage(response: Response) {
	const text = await response.text().catch(() => '');
	const json = parseJson(text);
	if (json !== null && typeof json.error === 'object' && json.error !== null && typeof json.error.message === 'string') return json.error.message;
	if (json !== null && typeof json.message === 'string') return json.message;
	return text.trim() !== '' ? text.trim().substring(0, 500) : response.statusText;
}

function parseJson(text: string): any {
	try {
		return JSON.parse(text);
	} catch (_) {
		return null;
	}
}
