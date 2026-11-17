/* Commit Table Helpers */

/**
 * Generate the HTML of the files & lines changed by a commit, for the Changes column.
 * @param stats The stats of the commit (NULL if the commit doesn't change any files).
 * @returns The HTML.
 */
function generateCommitStatsHtml(stats: GG.GitCommitStats | null) {
	return stats !== null
		? '<span title="' + (stats.files !== 1 ? t('{0} files', stats.files) : t('{0} file', stats.files)) + '">' + generateChangeBarHtml(stats.additions, stats.deletions, 36) + '<span class="fileTreeFileAdd">+' + stats.additions + '</span><span class="fileTreeFileDel">\u2212' + stats.deletions + '</span></span>'
		: '';
}

/**
 * Generate the HTML of how many commits a branch is ahead / behind its upstream branch.
 * @param upstream The upstream of the branch (if it has one).
 * @returns The HTML.
 */
function generateTrackingHtml(upstream: GG.GitBranchUpstream | undefined) {
	if (typeof upstream === 'undefined' || upstream.gone || (upstream.ahead === 0 && upstream.behind === 0)) return '';
	const title = [upstream.ahead > 0 ? t('{0} commit(s) ahead of {1}', upstream.ahead, upstream.name) : null, upstream.behind > 0 ? t('{0} commit(s) behind {1}', upstream.behind, upstream.name) : null].filter((text) => text !== null).join(', ');
	return '<span class="gitRefTrack" title="' + escapeHtml(title) + '">' + (upstream.ahead > 0 ? '\u2191' + upstream.ahead : '') + (upstream.behind > 0 ? '\u2193' + upstream.behind : '') + '</span>';
}

/**
 * Get the commits that match a filter, with their parents rewritten to be their nearest ancestors that also match (as Git does when it
 * simplifies the history of a path), so that the graph of the matching commits remains connected.
 * @param commits The commits, ordered so that each commit is before its parents (as they're returned by Git).
 * @param filter The hashes of the commits that match.
 * @returns The matching commits.
 */
function filterCommits(commits: ReadonlyArray<GG.GitCommit>, filter: ReadonlySet<string>) {
	const lookup: { [hash: string]: number } = {}, nearestMatches: { [hash: string]: string[] } = {}, filtered: GG.GitCommit[] = [];
	commits.forEach((commit, index) => lookup[commit.hash] = index);
	const rewriteParents = (parents: ReadonlyArray<string>) => {
		const rewritten: string[] = [];
		parents.forEach((parent) => {
			// Parents that aren't loaded are kept, as the graph continues below the loaded commits
			(filter.has(parent) || typeof lookup[parent] !== 'number' ? [parent] : nearestMatches[parent] || []).forEach((hash) => {
				if (!rewritten.includes(hash)) rewritten.push(hash);
			});
		});
		return rewritten;
	};
	for (let i = commits.length - 1; i >= 0; i--) {
		const commit = commits[i];
		if (filter.has(commit.hash)) {
			filtered.push(Object.assign({}, commit, { parents: rewriteParents(commit.parents) }));
		} else {
			nearestMatches[commit.hash] = rewriteParents(commit.parents);
		}
	}
	return filtered.reverse();
}

/**
 * Generate the HTML of a unified diff (as output by git diff), limited to a number of lines.
 * @param diff The diff.
 * @param maxLines The maximum number of lines of the diff to show.
 * @returns The HTML.
 */
function generateFileDiffHtml(diff: string, maxLines: number, onlyChanges: boolean = false) {
	let html = '', shown = 0, hunks = 0, hiddenHunks = 0, oldLine = 0, newLine = 0, inHunk = false, truncatedHunk = false;
	const row = (oldNumber: number | null, newNumber: number | null, type: string, text: string) => {
		html += '<div class="cdvFileDiffLine ' + type + '"><span>' + (oldNumber !== null ? oldNumber : '') + '</span><span>' + (newNumber !== null ? newNumber : '') + '</span><span>' + (type === 'add' ? '+' : type === 'del' ? '\u2212' : ' ') + '</span><span>' + escapeHtml(text) + '</span></div>';
		shown++;
	};
	diff.split('\n').forEach((line) => {
		const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
		if (hunk !== null) {
			hunks++;
			if (shown >= maxLines) {
				hiddenHunks++;
				inHunk = false;
				return;
			}
			oldLine = parseInt(hunk[1]);
			newLine = parseInt(hunk[2]);
			inHunk = true;
			html += '<div class="cdvFileDiffHunk">' + escapeHtml(line) + '</div>';
			return;
		}
		if (!inHunk) return;
		if (shown >= maxLines) {
			truncatedHunk = true;
			return;
		}
		const type = line.charAt(0), text = line.substring(1);
		if (type === '+') {
			row(null, newLine++, 'add', text);
		} else if (type === '-') {
			row(oldLine++, null, 'del', text);
		} else if (type === ' ') {
			if (onlyChanges) {
				oldLine++;
				newLine++;
			} else {
				row(oldLine++, newLine++, 'context', text);
			}
		}
	});
	if (hunks === 0) {
		return '<div class="cdvFileDiffMessage">' + (/^Binary files /m.test(diff) ? t('This is a binary file') : t('There are no changes to display')) + '</div>';
	}
	return '<div class="cdvFileDiffLines">' + html + (truncatedHunk ? '<div class="cdvFileDiffLine context"><span></span><span></span><span></span><span>' + ELLIPSIS + '</span></div>' : '') + '</div>' +
		(truncatedHunk || hiddenHunks > 0 ? '<div class="cdvFileDiffMore">' + (hiddenHunks > 0 ? (hiddenHunks !== 1 ? t('{0} more changes', hiddenHunks) : t('1 more change')) + ' · ' : '') + '<span class="cdvFileDiffOpen">' + t('Open in Diff Editor to view all of the changes') + '</span></div>' : '');
}


/* Repository State Helpers */

function getCommitOrdering(repoValue: GG.RepoCommitOrdering): GG.CommitOrdering {
	switch (repoValue) {
		case GG.RepoCommitOrdering.Default:
			return initialState.config.commitOrdering;
		case GG.RepoCommitOrdering.Date:
			return GG.CommitOrdering.Date;
		case GG.RepoCommitOrdering.AuthorDate:
			return GG.CommitOrdering.AuthorDate;
		case GG.RepoCommitOrdering.Topological:
			return GG.CommitOrdering.Topological;
	}
}

function getShowRemoteBranches(repoValue: GG.BooleanOverride) {
	return repoValue === GG.BooleanOverride.Default
		? initialState.config.showRemoteBranches
		: repoValue === GG.BooleanOverride.Enabled;
}

function getShowStashes(repoValue: GG.BooleanOverride) {
	return repoValue === GG.BooleanOverride.Default
		? initialState.config.showStashes
		: repoValue === GG.BooleanOverride.Enabled;
}

function getShowTags(repoValue: GG.BooleanOverride) {
	return repoValue === GG.BooleanOverride.Default
		? initialState.config.showTags
		: repoValue === GG.BooleanOverride.Enabled;
}

function getIncludeCommitsMentionedByReflogs(repoValue: GG.BooleanOverride) {
	return repoValue === GG.BooleanOverride.Default
		? initialState.config.includeCommitsMentionedByReflogs
		: repoValue === GG.BooleanOverride.Enabled;
}

function getOnlyFollowFirstParent(repoValue: GG.BooleanOverride) {
	return repoValue === GG.BooleanOverride.Default
		? initialState.config.onlyFollowFirstParent
		: repoValue === GG.BooleanOverride.Enabled;
}

function getOnRepoLoadShowCheckedOutBranch(repoValue: GG.BooleanOverride) {
	return repoValue === GG.BooleanOverride.Default
		? initialState.config.onRepoLoad.showCheckedOutBranch
		: repoValue === GG.BooleanOverride.Enabled;
}

function getOnRepoLoadShowSpecificBranches(repoValue: string[] | null) {
	return repoValue === null
		? initialState.config.onRepoLoad.showSpecificBranches
		: repoValue;
}


/* Miscellaneous Helper Methods */

function haveFilesChanged(oldFiles: ReadonlyArray<GG.GitFileChange> | null, newFiles: ReadonlyArray<GG.GitFileChange> | null) {
	if ((oldFiles === null) !== (newFiles === null)) {
		return true;
	} else if (oldFiles === null && newFiles === null) {
		return false;
	} else {
		return !arraysEqual(oldFiles!, newFiles!, (a, b) => a.additions === b.additions && a.deletions === b.deletions && a.newFilePath === b.newFilePath && a.oldFilePath === b.oldFilePath && a.type === b.type);
	}
}

function abbrevCommit(commitHash: string) {
	return commitHash.substring(0, 8);
}

function getRepoDropdownOptions(repos: Readonly<GG.GitRepoSet>) {
	const repoPaths = getSortedRepositoryPaths(repos, initialState.config.repoDropdownOrder);
	const paths: string[] = [], names: string[] = [], distinctNames: string[] = [], firstSep: number[] = [];
	const resolveAmbiguous = (indexes: number[]) => {
		// Find ambiguous names within indexes
		let firstOccurrence: { [name: string]: number } = {}, ambiguous: { [name: string]: number[] } = {};
		for (let i = 0; i < indexes.length; i++) {
			let name = distinctNames[indexes[i]];
			if (typeof firstOccurrence[name] === 'number') {
				// name is ambiguous
				if (typeof ambiguous[name] === 'undefined') {
					// initialise ambiguous array with the first occurrence
					ambiguous[name] = [firstOccurrence[name]];
				}
				ambiguous[name].push(indexes[i]); // append current ambiguous index
			} else {
				firstOccurrence[name] = indexes[i]; // set the first occurrence of the name
			}
		}

		let ambiguousNames = Object.keys(ambiguous);
		for (let i = 0; i < ambiguousNames.length; i++) {
			// For each ambiguous name, resolve the ambiguous indexes
			let ambiguousIndexes = ambiguous[ambiguousNames[i]], retestIndexes = [];
			for (let j = 0; j < ambiguousIndexes.length; j++) {
				let ambiguousIndex = ambiguousIndexes[j];
				let nextSep = paths[ambiguousIndex].lastIndexOf('/', paths[ambiguousIndex].length - distinctNames[ambiguousIndex].length - 2);
				if (firstSep[ambiguousIndex] < nextSep) {
					// prepend the addition path and retest
					distinctNames[ambiguousIndex] = paths[ambiguousIndex].substring(nextSep + 1);
					retestIndexes.push(ambiguousIndex);
				} else {
					distinctNames[ambiguousIndex] = paths[ambiguousIndex];
				}
			}
			if (retestIndexes.length > 1) {
				// If there are 2 or more indexes that may be ambiguous
				resolveAmbiguous(retestIndexes);
			}
		}
	};

	// Initialise recursion
	const indexes = [];
	for (let i = 0; i < repoPaths.length; i++) {
		firstSep.push(repoPaths[i].indexOf('/'));
		const repo = repos[repoPaths[i]];
		if (repo.name) {
			// A name has been set for the repository
			paths.push(repoPaths[i]);
			names.push(repo.name);
			distinctNames.push(repo.name);
		} else if (firstSep[i] === repoPaths[i].length - 1 || firstSep[i] === -1) {
			// Path has no slashes, or a single trailing slash ==> use the path as the name
			paths.push(repoPaths[i]);
			names.push(repoPaths[i]);
			distinctNames.push(repoPaths[i]);
		} else {
			paths.push(repoPaths[i].endsWith('/') ? repoPaths[i].substring(0, repoPaths[i].length - 1) : repoPaths[i]); // Remove trailing slash if it exists
			let name = paths[i].substring(paths[i].lastIndexOf('/') + 1);
			names.push(name);
			distinctNames.push(name);
			indexes.push(i);
		}
	}
	resolveAmbiguous(indexes);

	const options: DropdownOption[] = [];
	for (let i = 0; i < repoPaths.length; i++) {
		let hint;
		if (names[i] === distinctNames[i]) {
			// Name is distinct, no hint needed
			hint = '';
		} else {
			// Hint path is the prefix of the distinctName before the common suffix with name
			let hintPath = distinctNames[i].substring(0, distinctNames[i].length - names[i].length - 1);

			// Keep two informative directories
			let hintComps = hintPath.split('/');
			let keepDirs = hintComps[0] !== '' ? 2 : 3;
			if (hintComps.length > keepDirs) hintComps.splice(keepDirs, hintComps.length - keepDirs, '...');

			// Construct the hint
			hint = (distinctNames[i] !== paths[i] ? '.../' : '') + hintComps.join('/');
		}
		options.push({ name: names[i], value: repoPaths[i], hint: hint });
	}
	return options;
}

function runAction(msg: GG.RequestMessage, action: string) {
	dialog.showActionRunning(action);
	sendMessage(msg);
}

function getBranchLabels(heads: ReadonlyArray<string>, remotes: ReadonlyArray<GG.GitCommitRemote>) {
	let headLabels: { name: string; remotes: string[] }[] = [], headLookup: { [name: string]: number } = {}, remoteLabels: ReadonlyArray<GG.GitCommitRemote>;
	for (let i = 0; i < heads.length; i++) {
		headLabels.push({ name: heads[i], remotes: [] });
		headLookup[heads[i]] = i;
	}
	if (initialState.config.referenceLabels.combineLocalAndRemoteBranchLabels) {
		let remainingRemoteLabels = [];
		for (let i = 0; i < remotes.length; i++) {
			if (remotes[i].remote !== null) { // If the remote of the remote branch ref is known
				let branchName = remotes[i].name.substring(remotes[i].remote!.length + 1);
				if (typeof headLookup[branchName] === 'number') {
					headLabels[headLookup[branchName]].remotes.push(remotes[i].remote!);
					continue;
				}
			}
			remainingRemoteLabels.push(remotes[i]);
		}
		remoteLabels = remainingRemoteLabels;
	} else {
		remoteLabels = remotes;
	}
	return { heads: headLabels, remotes: remoteLabels };
}

function findCommitElemWithId(elems: HTMLCollectionOf<HTMLElement>, id: number | null) {
	if (id === null) return null;
	let findIdStr = id.toString();
	for (let i = 0; i < elems.length; i++) {
		if (findIdStr === elems[i].dataset.id) return elems[i];
	}
	return null;
}

function generateSignatureHtml(signature: GG.GitSignature) {
	return '<span class="signatureInfo ' + signature.status + '" title="' + t(GIT_SIGNATURE_STATUS_DESCRIPTIONS[signature.status]) + ': '
		+ t('Signed by {0} (GPG Key Id: {1})', escapeHtml(signature.signer !== '' ? signature.signer : t('<Unknown>')), escapeHtml(signature.key !== '' ? signature.key : t('<Unknown>'))) + '">'
		+ (signature.status === GG.GitSignatureStatus.GoodAndValid
			? SVG_ICONS.passed
			: signature.status === GG.GitSignatureStatus.Bad
				? SVG_ICONS.failed
				: SVG_ICONS.inconclusive)
		+ '</span>';
}

/**
 * Generate the HTML of a circle containing the initial of an author's name, coloured by the name (used when avatars aren't fetched).
 * @param name The name of the author.
 * @returns The HTML.
 */
function generateAuthorInitialHtml(name: string, asPseudoElement: boolean = false) {
	const initial = name.trim().length > 0 ? name.trim().charAt(0).toUpperCase() : '?';
	// The initial can be shown by CSS, so that it isn't part of the text content of the element containing it (e.g. a dropdown option)
	return asPseudoElement
		? '<span class="authorInitial" data-initial="' + escapeHtml(initial) + '" style="background-color:' + getAuthorColour(name) + '"></span>'
		: '<span class="authorInitial" style="background-color:' + getAuthorColour(name) + '">' + escapeHtml(initial) + '</span>';
}

function closeDialogAndContextMenu() {
	if (dialog.isOpen()) dialog.close();
	if (contextMenu.isOpen()) contextMenu.close();
}
