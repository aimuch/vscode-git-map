import * as crypto from 'crypto';
import { CustomRemoteConfig, CustomRemoteType, GitLineRange } from './types';

/**
 * The kinds of hosts of remote repositories, which link to files & commits differently.
 */
export const enum RemoteHost {
	GitHub, // Also used for hosts that aren't recognised
	GitLab,
	Bitbucket,
	Gitea, // Gitea, Forgejo & Codeberg
	AzureDevOps,
	Custom
}

/**
 * A remote repository's web page.
 */
export interface RemoteWebRepo {
	readonly url: string; // The URL of the repository's web page (e.g. https://github.com/owner/repo)
	readonly host: RemoteHost;
	readonly customUrls?: CustomRemoteConfig['urls'];
	readonly avatarUrl?: string;
}

function mapCustomTypeToHost(type: CustomRemoteType): RemoteHost {
	switch (type) {
		case 'gitlab': return RemoteHost.GitLab;
		case 'bitbucket': return RemoteHost.Bitbucket;
		case 'gitea': return RemoteHost.Gitea;
		case 'azure': return RemoteHost.AzureDevOps;
		case 'custom': return RemoteHost.Custom;
		default: return RemoteHost.GitHub;
	}
}

export function matchCustomRemote(
	remoteUrl: string,
	hostname: string,
	customRemotes?: ReadonlyArray<CustomRemoteConfig>
): CustomRemoteConfig | null {
	if (!Array.isArray(customRemotes) || customRemotes.length === 0) return null;
	const lowerHost = hostname.toLowerCase();
	for (let i = 0; i < customRemotes.length; i++) {
		const entry = customRemotes[i];
		if (!entry) continue;
		if (typeof entry.domain === 'string' && entry.domain.trim() !== '') {
			const domain = entry.domain.trim().toLowerCase();
			if (lowerHost === domain || lowerHost.endsWith('.' + domain)) {
				return entry;
			}
		}
		if (typeof entry.regex === 'string' && entry.regex.trim() !== '') {
			try {
				const re = new RegExp(entry.regex, 'i');
				if (re.test(remoteUrl) || (lowerHost !== '' && re.test(lowerHost))) {
					return entry;
				}
			} catch (_) {
				// Ignore invalid regex safely
			}
		}
	}
	return null;
}

function isSafeWebUrl(url: string): boolean {
	return /^https?:\/\//i.test(url.trim());
}

/**
 * Get the web page of a remote repository from its URL (HTTPS, SSH, or SCP-like, e.g. git@github.com:owner/repo.git).
 * @param remoteUrl The URL of the remote.
 * @param customRemotes Optional custom remote host rules.
 * @returns The web page of the repository, or NULL if the URL isn't recognised.
 */
export function getRemoteWebRepo(remoteUrl: string, customRemotes?: ReadonlyArray<CustomRemoteConfig>): RemoteWebRepo | null {
	const url = remoteUrl.trim();
	let match: RegExpMatchArray | null, webUrl: string;
	if ((match = url.match(/^git@ssh\.dev\.azure\.com:v3\/([^/]+)\/([^/]+)\/(.+?)\/?$/)) !== null || (match = url.match(/^[^@\s/]+@vs-ssh\.visualstudio\.com:v3\/([^/]+)\/([^/]+)\/(.+?)\/?$/)) !== null) {
		webUrl = 'https://dev.azure.com/' + match[1] + '/' + match[2] + '/_git/' + match[3];
	} else if ((match = url.match(/^(https?):\/\/(?:[^@/]+@)?(.+?)(?:\.git)?\/?$/)) !== null) {
		webUrl = match[1] + '://' + match[2];
	} else if ((match = url.match(/^ssh:\/\/(?:[^@/]+@)?([^:/]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/)) !== null) {
		webUrl = 'https://' + match[1] + '/' + match[2];
	} else if ((match = url.match(/^[^@\s/]+@([^:\s]+):(.+?)(?:\.git)?\/?$/)) !== null) {
		webUrl = 'https://' + match[1] + '/' + match[2];
	} else {
		return null;
	}

	const hostname = (webUrl.match(/^https?:\/\/([^/:]+)/) || ['', ''])[1].toLowerCase();
	const custom = matchCustomRemote(url, hostname, customRemotes);
	if (custom !== null) {
		if (typeof custom.protocol === 'string' && (custom.protocol === 'http' || custom.protocol === 'https')) {
			webUrl = webUrl.replace(/^https?:\/\//i, custom.protocol + '://');
		}
		if (custom.urls && typeof custom.urls.repository === 'string' && custom.urls.repository.trim() !== '') {
			const repoPath = webUrl.replace(/^https?:\/\/[^/]+\//i, '');
			const templated = custom.urls.repository
				.replace(/\$\{repo\}/g, repoPath)
				.replace(/\$\{host\}/g, hostname);
			if (isSafeWebUrl(templated)) webUrl = templated.replace(/\/+$/, '');
		}
		return {
			url: webUrl,
			host: mapCustomTypeToHost(custom.type),
			customUrls: custom.urls,
			avatarUrl: custom.avatarUrl
		};
	}

	const host = hostname === 'dev.azure.com' || hostname.endsWith('.visualstudio.com')
		? RemoteHost.AzureDevOps
		: hostname.includes('gitlab')
			? RemoteHost.GitLab
			: hostname.includes('bitbucket')
				? RemoteHost.Bitbucket
				: hostname.includes('gitea') || hostname.includes('forgejo') || hostname === 'codeberg.org'
					? RemoteHost.Gitea
					: RemoteHost.GitHub;
	return { url: webUrl, host: host };
}

/**
 * Resolve a commit author's custom avatar URL from matching `git-map.remotes` templates, if configured.
 */
export function resolveCustomRemoteAvatarUrl(
	remoteUrl: string,
	email: string,
	author: string,
	customRemotes?: ReadonlyArray<CustomRemoteConfig>
): string | null {
	const webRepo = getRemoteWebRepo(remoteUrl, customRemotes);
	if (webRepo === null || typeof webRepo.avatarUrl !== 'string' || webRepo.avatarUrl.trim() === '') return null;
	const cleanEmail = email.trim().toLowerCase();
	const emailHash = crypto.createHash('md5').update(cleanEmail).digest('hex');
	const resolved = webRepo.avatarUrl.trim()
		.replace(/\$\{emailHash\}/g, emailHash)
		.replace(/\$\{email\}/g, encodeURIComponent(cleanEmail))
		.replace(/\$\{author\}/g, encodeURIComponent(author.trim()));
	return isSafeWebUrl(resolved) ? resolved : null;
}

/**
 * Get the URL of a commit on the web page of a remote repository.
 * @param repo The remote repository.
 * @param hash The hash of the commit.
 * @returns The URL.
 */
export function getRemoteCommitUrl(repo: RemoteWebRepo, hash: string) {
	if (repo.host === RemoteHost.Custom && repo.customUrls && typeof repo.customUrls.commit === 'string') {
		const customUrl = repo.customUrls.commit
			.replace(/\$\{repo\}/g, repo.url)
			.replace(/\$\{id\}/g, encodeURIComponent(hash));
		if (isSafeWebUrl(customUrl)) return customUrl;
	}
	switch (repo.host) {
		case RemoteHost.GitLab:
			return repo.url + '/-/commit/' + hash;
		case RemoteHost.Bitbucket:
			return repo.url + '/commits/' + hash;
		default:
			return repo.url + '/commit/' + hash;
	}
}

/**
 * Get the URL of lines of a file at a commit, on the web page of a remote repository (a permanent link, as it refers to the commit).
 * @param repo The remote repository.
 * @param hash The hash of the commit.
 * @param filePath The path of the file in the commit (relative to the repository).
 * @param range The lines (or NULL to link to the whole file).
 * @returns The URL.
 */
export function getRemoteFileUrl(repo: RemoteWebRepo, hash: string, filePath: string, range: GitLineRange | null) {
	const path = filePath.split('/').map((segment) => encodeURIComponent(segment)).join('/');
	const single = range !== null && range.start === range.end;
	if (repo.host === RemoteHost.Custom && repo.customUrls) {
		const tmpl = range !== null
			? (single ? (repo.customUrls.fileLine || repo.customUrls.fileRange || repo.customUrls.fileInCommit || repo.customUrls.file) : (repo.customUrls.fileRange || repo.customUrls.fileInCommit || repo.customUrls.file))
			: (repo.customUrls.fileInCommit || repo.customUrls.file);
		if (typeof tmpl === 'string' && tmpl.trim() !== '') {
			const customUrl = tmpl
				.replace(/\$\{repo\}/g, repo.url)
				.replace(/\$\{id\}/g, encodeURIComponent(hash))
				.replace(/\$\{file\}/g, path)
				.replace(/\$\{line\}/g, range !== null ? String(range.start) : '')
				.replace(/\$\{lineEnd\}/g, range !== null ? String(range.end) : '');
			if (isSafeWebUrl(customUrl)) return customUrl;
		}
	}
	switch (repo.host) {
		case RemoteHost.GitLab:
			return repo.url + '/-/blob/' + hash + '/' + path + (range !== null ? '#L' + range.start + (single ? '' : '-' + range.end) : '');
		case RemoteHost.Bitbucket:
			return repo.url + '/src/' + hash + '/' + path + (range !== null ? '#lines-' + range.start + (single ? '' : ':' + range.end) : '');
		case RemoteHost.Gitea:
			return repo.url + '/src/commit/' + hash + '/' + path + (range !== null ? '#L' + range.start + (single ? '' : '-L' + range.end) : '');
		case RemoteHost.AzureDevOps:
			return repo.url + '?path=' + encodeURIComponent('/' + filePath) + '&version=GC' + hash +
				(range !== null ? '&line=' + range.start + '&lineEnd=' + (range.end + 1) + '&lineStartColumn=1&lineEndColumn=1&lineStyle=plain' : '') + '&_a=contents';
		default:
			return repo.url + '/blob/' + hash + '/' + path + (range !== null ? '#L' + range.start + (single ? '' : '-L' + range.end) : '');
	}
}
