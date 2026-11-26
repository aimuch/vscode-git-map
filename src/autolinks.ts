import { AutolinkRule } from './types';

export interface CompiledAutolinkRule {
	readonly rule: AutolinkRule;
	readonly regex: RegExp;
}

export interface AutolinkMatch {
	readonly start: number;
	readonly end: number;
	readonly text: string;
	readonly num: string;
	readonly url: string;
	readonly title: string;
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function isSafeAutolinkUrl(url: string): boolean {
	return /^(?:https?:\/\/|mailto:)/i.test(url.trim());
}

/**
 * Compile configured Autolink rules into validated prefix-matching regexes.
 */
export function compileAutolinkRules(rules: ReadonlyArray<AutolinkRule>): CompiledAutolinkRule[] {
	const compiled: CompiledAutolinkRule[] = [];
	for (let i = 0; i < rules.length; i++) {
		const rule = rules[i];
		if (!rule || typeof rule.prefix !== 'string' || typeof rule.url !== 'string') continue;
		const prefix = rule.prefix;
		const url = rule.url.trim();
		if (prefix === '' || url === '' || !url.includes('<num>') || !isSafeAutolinkUrl(url)) continue;
		const numGroup = rule.alphanumeric ? '([A-Za-z0-9]+)' : '([0-9]+)';
		const flags = rule.ignoreCase ? 'gi' : 'g';
		const pattern = '(^|[\\s(\\[{\'".,;:])(' + escapeRegExp(prefix) + numGroup + ')(?=$|[\\s)\\]}\'".,;:!?])';
		try {
			compiled.push({
				rule: {
					prefix: prefix,
					url: url,
					title: typeof rule.title === 'string' && rule.title.trim() !== '' ? rule.title.trim() : prefix + '<num>',
					alphanumeric: !!rule.alphanumeric,
					ignoreCase: !!rule.ignoreCase
				},
				regex: new RegExp(pattern, flags)
			});
		} catch (_) {
			// Ignore invalid patterns safely
		}
	}
	return compiled;
}

/**
 * Find non-overlapping autolink matches in a plain text string.
 */
export function findAutolinkMatches(text: string, rules: ReadonlyArray<AutolinkRule>): AutolinkMatch[] {
	if (text === '' || !Array.isArray(rules) || rules.length === 0) return [];
	const compiled = compileAutolinkRules(rules);
	if (compiled.length === 0) return [];

	const rawMatches: AutolinkMatch[] = [];
	for (let i = 0; i < compiled.length; i++) {
		const entry = compiled[i];
		entry.regex.lastIndex = 0;
		let match: RegExpExecArray | null;
		while ((match = entry.regex.exec(text)) !== null) {
			const leadingLen = match[1].length;
			const start = match.index + leadingLen;
			const fullText = match[2];
			const num = match[3];
			const end = start + fullText.length;
			const url = entry.rule.url.replace(/<num>/g, encodeURIComponent(num));
			const title = (entry.rule.title || (entry.rule.prefix + '<num>')).replace(/<num>/g, num);
			if (isSafeAutolinkUrl(url)) {
				rawMatches.push({
					start: start,
					end: end,
					text: fullText,
					num: num,
					url: url,
					title: title
				});
			}
			if (match.index === entry.regex.lastIndex) entry.regex.lastIndex++;
		}
	}

	rawMatches.sort((a, b) => a.start !== b.start ? a.start - b.start : (b.end - b.start) - (a.end - a.start));
	const filtered: AutolinkMatch[] = [];
	let cursor = 0;
	for (let i = 0; i < rawMatches.length; i++) {
		const item = rawMatches[i];
		if (item.start >= cursor) {
			filtered.push(item);
			cursor = item.end;
		}
	}
	return filtered;
}

function escapeMarkdownText(text: string): string {
	return text.replace(/([\\`*_{}[\]()#+\-.!|>])/g, '\\$1');
}

function escapeMarkdownTitle(title: string): string {
	return title.replace(/["\\]/g, '\\$&');
}

/**
 * Render plain text to safe Markdown with matched autolinks converted into clickable links.
 */
export function applyAutolinksToMarkdown(text: string, rules: ReadonlyArray<AutolinkRule>): string {
	const matches = findAutolinkMatches(text, rules);
	if (matches.length === 0) return escapeMarkdownText(text);

	let out = '';
	let cursor = 0;
	for (let i = 0; i < matches.length; i++) {
		const m = matches[i];
		if (m.start > cursor) {
			out += escapeMarkdownText(text.substring(cursor, m.start));
		}
		out += '[' + escapeMarkdownText(m.text) + '](' + m.url + ' "' + escapeMarkdownTitle(m.title) + '")';
		cursor = m.end;
	}
	if (cursor < text.length) {
		out += escapeMarkdownText(text.substring(cursor));
	}
	return out;
}

function slugifyBranchSegment(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9/._-]+/g, '-')
		.replace(/-{2,}/g, '-')
		.replace(/\/{2,}/g, '/')
		.replace(/^[-./]+|[-./]+$/g, '');
}

/**
 * Format and normalize a Git-safe branch name from a Start Work template (e.g. `${id}-${title}`).
 */
export function formatStartWorkBranchName(template: string, id: string, title: string): string {
	const rawTemplate = template.trim() !== '' ? template.trim() : '${id}-${title}';
	const cleanId = id.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
	const cleanTitle = slugifyBranchSegment(title.replace(/\//g, '-'));

	let combined = rawTemplate
		.replace(/\$\{id\}/g, cleanId)
		.replace(/\$\{title\}/g, cleanTitle);

	// Sanitize segments while preserving intentional `/` branch prefixes (e.g. feat/ABC-123-fix)
	const segments = combined.split('/')
		.map((seg) => seg
			.replace(/[\s~^:?*[\]\\@{}"'`<>|]+/g, '-')
			.replace(/\.{2,}/g, '.')
			.replace(/\.lock$/i, '')
			.replace(/-{2,}/g, '-')
			.replace(/^[.-]+|[.-]+$/g, ''))
		.filter((seg) => seg !== '');

	let normalized = segments.join('/');
	if (normalized === '' || normalized === 'HEAD') {
		normalized = cleanId !== '' ? cleanId : 'work-branch';
	}
	if (normalized.length > 120) {
		normalized = normalized.substring(0, 120).replace(/[.-]+$/g, '');
	}
	return normalized;
}
