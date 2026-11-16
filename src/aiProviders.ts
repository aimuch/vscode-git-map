import * as vscode from 'vscode';
import { getConfig } from './config';
import { t } from './l10n';

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
	OpenAICompatible = 'OpenAI Compatible'
}

interface AiProviderPreset {
	readonly name: string; // The name shown to the person (e.g. in the consent before a commit is sent)
	readonly baseUrl: string; // The default base URL of its API ('' => it must be set)
	readonly model: string; // The default model ('' => it must be set)
	readonly requiresApiKey: boolean;
}

const PRESETS: { readonly [provider: string]: AiProviderPreset } = {
	[AiProvider.DeepSeek]: { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', requiresApiKey: true },
	[AiProvider.Kimi]: { name: 'Kimi (Moonshot AI)', baseUrl: 'https://api.moonshot.cn/v1', model: '', requiresApiKey: true },
	[AiProvider.Doubao]: { name: 'Doubao (Volcengine Ark)', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: '', requiresApiKey: true },
	[AiProvider.Qwen]: { name: 'Qwen (Alibaba Cloud Model Studio)', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', requiresApiKey: true },
	[AiProvider.OpenAI]: { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: '', requiresApiKey: true },
	[AiProvider.Ollama]: { name: 'Ollama', baseUrl: 'http://localhost:11434/v1', model: '', requiresApiKey: false },
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
		baseUrl: (config.aiBaseUrl !== '' ? config.aiBaseUrl : preset.baseUrl).replace(/\/+$/, ''),
		model: config.aiModel !== '' ? config.aiModel : preset.model,
		requiresApiKey: preset.requiresApiKey
	};
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

/* API Keys (stored in the Secret Storage of Visual Studio Code, never in the Extension Settings) */

let secretStorage: vscode.SecretStorage | null = null;

/**
 * Set the Secret Storage that API keys are stored in (when Git Map is activated).
 */
export function setAiSecretStorage(secrets: vscode.SecretStorage | null) {
	secretStorage = secrets;
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
	return typeof key === 'string' && key !== '' ? key : null;
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
	if (typeof key !== 'string') vscode.window.showInformationMessage(t('The API key of {0} was stored.', config.name));
	return true;
}

/**
 * The method run when the `git-map.ai.clearApiKey` command is invoked: delete the API key of the provider configured.
 */
export async function clearApiKey() {
	const config = getDirectAiConfig();
	if (config === null || secretStorage === null) return;
	await secretStorage.delete(getSecretKey(config.provider));
	vscode.window.showInformationMessage(t('The API key of {0} was deleted.', config.name));
}

/* The OpenAI-compatible Chat Completions API */

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
	try {
		const headers: { [name: string]: string } = { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' };
		if (apiKey !== null) headers['Authorization'] = 'Bearer ' + apiKey;
		const response = await fetch(baseUrl.replace(/\/+$/, '') + '/chat/completions', {
			method: 'POST',
			headers: headers,
			body: JSON.stringify({ model: model, stream: true, messages: [{ role: 'user', content: prompt }] }),
			signal: controller.signal
		});
		if (!response.ok || response.body === null) {
			return t('The API returned an error ({0}): {1}', String(response.status), await getErrorMessage(response));
		}
		const decoder = new TextDecoder();
		const reader = response.body.getReader();
		let buffer = '', done = false;
		while (!done) {
			const chunk = await reader.read();
			if (chunk.done) break;
			buffer += decoder.decode(chunk.value, { stream: true });
			// Server-Sent Events: each event is a line "data: {json}", and the stream ends with "data: [DONE]"
			let newline: number;
			while ((newline = buffer.indexOf('\n')) > -1) {
				const line = buffer.substring(0, newline).trim();
				buffer = buffer.substring(newline + 1);
				if (!line.startsWith('data:')) continue;
				const data = line.substring(5).trim();
				if (data === '[DONE]') {
					done = true;
					break;
				}
				const event = parseJson(data);
				if (event === null) continue;
				if (typeof event.error === 'object' && event.error !== null) return t('The API returned an error: {0}', String(event.error.message || JSON.stringify(event.error)));
				const choice = Array.isArray(event.choices) ? event.choices[0] : null;
				const text = choice && choice.delta && typeof choice.delta.content === 'string' ? choice.delta.content : '';
				if (text !== '') onText(text);
			}
		}
		await reader.cancel().catch(() => { });
		return null;
	} catch (error) {
		if (token.isCancellationRequested) return null;
		return t('Unable to call the API at {0}: {1}', getHost(baseUrl), error instanceof Error ? ((<any>error).cause instanceof Error ? error.message + ' (' + (<any>error).cause.message + ')' : error.message) : String(error));
	} finally {
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
