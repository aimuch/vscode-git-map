import * as vscode from 'vscode';
import { RepoLocalMetadata, ReviewSessionComment, ReviewSessionState, SavedFilterPreset } from './types';

const STORAGE_KEY = 'git-map.repoMetadata.v1';
const MAX_SESSIONS_PER_REPO = 12;
const MAX_COMMENTS_PER_SESSION = 100;
const MAX_PINNED_BRANCHES = 50;
const MAX_SAVED_FILTERS = 20;

type AllRepoMetadata = { [repo: string]: RepoLocalMetadata };

/**
 * Non-invasive local metadata store persisted in VS Code workspaceState.
 * Stores pinned branches and interactive review sessions per repository without
 * touching `.git/config` or any tracked workspace files.
 */
export class RepoMetadataStore {
	private readonly memento: vscode.Memento;
	private cache: AllRepoMetadata;

	constructor(memento: vscode.Memento) {
		this.memento = memento;
		const stored = memento.get<AllRepoMetadata>(STORAGE_KEY);
		this.cache = stored && typeof stored === 'object' ? Object.assign({}, stored) : {};
	}

	public getRepoMetadata(repo: string): RepoLocalMetadata {
		const entry = this.cache[repo];
		if (!entry || typeof entry !== 'object') {
			return { pinnedBranches: [], reviewSessions: {}, savedFilters: [] };
		}
		return {
			pinnedBranches: Array.isArray(entry.pinnedBranches) ? entry.pinnedBranches.slice() : [],
			reviewSessions: entry.reviewSessions && typeof entry.reviewSessions === 'object' ? Object.assign({}, entry.reviewSessions) : {},
			savedFilters: Array.isArray(entry.savedFilters) ? entry.savedFilters.slice() : []
		};
	}

	public saveFilterPreset(repo: string, name: string, query: string): SavedFilterPreset[] {
		const cleanName = name.trim().slice(0, 60);
		const cleanQuery = query.trim().slice(0, 300);
		const current = this.getRepoMetadata(repo);
		const existing = (current.savedFilters || []).slice();
		if (cleanName === '' || cleanQuery === '') return existing;
		const filtered = existing.filter((p) => p.name.toLowerCase() !== cleanName.toLowerCase() && p.query !== cleanQuery);
		const next: SavedFilterPreset[] = [{
			id: Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
			name: cleanName,
			query: cleanQuery
		}].concat(filtered).slice(0, MAX_SAVED_FILTERS);
		this.saveRepo(repo, { pinnedBranches: current.pinnedBranches, reviewSessions: current.reviewSessions, savedFilters: next });
		return next;
	}

	public deleteFilterPreset(repo: string, id: string): SavedFilterPreset[] {
		const current = this.getRepoMetadata(repo);
		const next = (current.savedFilters || []).filter((p) => p.id !== id);
		this.saveRepo(repo, { pinnedBranches: current.pinnedBranches, reviewSessions: current.reviewSessions, savedFilters: next });
		return next;
	}

	public togglePinnedBranch(repo: string, branch: string): string[] {
		const trimmed = branch.trim();
		if (trimmed === '') return this.getRepoMetadata(repo).pinnedBranches.slice();
		const current = this.getRepoMetadata(repo);
		const set = new Set(current.pinnedBranches);
		if (set.has(trimmed)) {
			set.delete(trimmed);
		} else {
			set.add(trimmed);
		}
		const pinnedBranches = Array.from(set).slice(0, MAX_PINNED_BRANCHES);
		this.saveRepo(repo, { pinnedBranches: pinnedBranches, reviewSessions: current.reviewSessions, savedFilters: current.savedFilters || [] });
		return pinnedBranches;
	}

	public getReviewSession(repo: string, scopeKey: string): ReviewSessionState {
		const meta = this.getRepoMetadata(repo);
		const existing = meta.reviewSessions[scopeKey];
		if (existing && typeof existing === 'object') {
			return {
				scopeKey: scopeKey,
				viewedFiles: Array.isArray(existing.viewedFiles) ? existing.viewedFiles.slice() : [],
				comments: Array.isArray(existing.comments) ? existing.comments.slice() : [],
				updatedAt: typeof existing.updatedAt === 'number' ? existing.updatedAt : Date.now()
			};
		}
		return { scopeKey: scopeKey, viewedFiles: [], comments: [], updatedAt: Date.now() };
	}

	public updateReviewSession(
		repo: string,
		scopeKey: string,
		update: {
			viewedFiles?: ReadonlyArray<string>,
			comments?: ReadonlyArray<ReviewSessionComment>,
			clear?: boolean
		}
	): ReviewSessionState {
		const current = this.getRepoMetadata(repo);
		const sessions: { [key: string]: ReviewSessionState } = Object.assign({}, current.reviewSessions);
		if (update.clear) {
			delete sessions[scopeKey];
			this.saveRepo(repo, { pinnedBranches: current.pinnedBranches, reviewSessions: sessions, savedFilters: current.savedFilters || [] });
			return { scopeKey: scopeKey, viewedFiles: [], comments: [], updatedAt: Date.now() };
		}
		const prev = this.getReviewSession(repo, scopeKey);
		const next: ReviewSessionState = {
			scopeKey: scopeKey,
			viewedFiles: Array.isArray(update.viewedFiles)
				? Array.from(new Set(update.viewedFiles.filter((f) => typeof f === 'string' && f !== '')))
				: prev.viewedFiles,
			comments: Array.isArray(update.comments)
				? update.comments.slice(0, MAX_COMMENTS_PER_SESSION)
				: prev.comments,
			updatedAt: Date.now()
		};
		sessions[scopeKey] = next;

		// Prune oldest sessions if above cap
		const keys = Object.keys(sessions);
		if (keys.length > MAX_SESSIONS_PER_REPO) {
			keys.sort((a, b) => (sessions[b].updatedAt || 0) - (sessions[a].updatedAt || 0));
			for (let i = MAX_SESSIONS_PER_REPO; i < keys.length; i++) {
				delete sessions[keys[i]];
			}
		}

		this.saveRepo(repo, { pinnedBranches: current.pinnedBranches, reviewSessions: sessions, savedFilters: current.savedFilters || [] });
		return next;
	}

	private saveRepo(repo: string, meta: RepoLocalMetadata) {
		this.cache[repo] = meta;
		this.memento.update(STORAGE_KEY, this.cache).then(() => { }, () => { });
	}
}
