/* File Tree Methods (for the Commit Details & Comparison Views) */

function generateFileViewHtml(folder: FileTreeFolder, gitFiles: ReadonlyArray<GG.GitFileChange>, lastViewedFile: string | null, fileContextMenuOpen: number, type: GG.FileViewType, isUncommitted: boolean) {
	fileViewMaxLinesChanged = gitFiles.reduce((max, file) => Math.max(max, (file.additions || 0) + (file.deletions || 0)), 1);
	return type === GG.FileViewType.List
		? generateFileListHtml(folder, gitFiles, lastViewedFile, fileContextMenuOpen, isUncommitted)
		: generateFileTreeHtml(folder, gitFiles, lastViewedFile, fileContextMenuOpen, isUncommitted, true);
}

function generateFileTreeHtml(folder: FileTreeFolder, gitFiles: ReadonlyArray<GG.GitFileChange>, lastViewedFile: string | null, fileContextMenuOpen: number, isUncommitted: boolean, topLevelFolder: boolean): string {
	const curFolderInfo = topLevelFolder || !initialState.config.commitDetailsView.fileTreeCompactFolders
		? { folder: folder, name: folder.name, pathSeg: folder.name }
		: getCurrentFolderInfo(folder, folder.name, folder.name);

	const children = sortFolderKeys(curFolderInfo.folder).map((key) => {
		const cur = curFolderInfo.folder.contents[key];
		return cur.type === 'folder'
			? generateFileTreeHtml(cur, gitFiles, lastViewedFile, fileContextMenuOpen, isUncommitted, false)
			: generateFileTreeLeafHtml(cur.name, cur, gitFiles, lastViewedFile, fileContextMenuOpen, isUncommitted);
	});

	return (topLevelFolder ? '' : '<li' + (curFolderInfo.folder.open ? '' : ' class="closed"') + ' data-pathseg="' + encodeURIComponent(curFolderInfo.pathSeg) + '"><span class="fileTreeFolder' + (curFolderInfo.folder.reviewed ? '' : ' pendingReview') + '" title="./' + escapeHtml(curFolderInfo.folder.folderPath) + '" data-folderpath="' + encodeURIComponent(curFolderInfo.folder.folderPath) + '"><span class="fileTreeFolderIcon">' + fileIcons.getFolderIcon(curFolderInfo.folder.name, curFolderInfo.folder.open) + '</span><span class="gitFolderName">' + escapeHtml(curFolderInfo.name) + '</span></span>') +
		'<ul class="fileTreeFolderContents' + (curFolderInfo.folder.open ? '' : ' hidden') + '">' + children.join('') + '</ul>' +
		(topLevelFolder ? '' : '</li>');
}

function getCurrentFolderInfo(folder: FileTreeFolder, name: string, pathSeg: string): { folder: FileTreeFolder, name: string, pathSeg: string } {
	const keys = Object.keys(folder.contents);
	let child: FileTreeNode;
	return keys.length === 1 && (child = folder.contents[keys[0]]).type === 'folder'
		? getCurrentFolderInfo(<FileTreeFolder>child, name + ' / ' + child.name, pathSeg + '/' + child.name)
		: { folder: folder, name: name, pathSeg: pathSeg };
}

/**
 * The maximum number of lines changed in a file of the file view being generated, used to scale the bars of the lines changed in each file.
 */
let fileViewMaxLinesChanged = 1;

/**
 * Get the HTML Element containing the file view of the Commit Details View.
 * @returns The HTML Element, or NULL if the Commit Details View isn't open.
 */
function getCdvFileViewElem() {
	return document.getElementById('cdvFileView') || document.getElementById('cdvFiles');
}

/**
 * Generate the HTML of a bar showing the proportion of lines added & deleted.
 * @param additions The number of lines added.
 * @param deletions The number of lines deleted.
 * @param width The width of the bar (in pixels), or NULL if it fills the available space.
 * @returns The HTML.
 */
function generateChangeBarHtml(additions: number, deletions: number, width: number | null) {
	return '<span class="changeBar"' + (width !== null ? ' style="width:' + width + 'px"' : '') + '><span class="changeBarAdd" style="flex-grow:' + additions + '"></span><span class="changeBarDel" style="flex-grow:' + deletions + '"></span></span>';
}

/**
 * Generate the HTML of the number of files changed, and the lines added & deleted, in the Commit Details View.
 * @param fileChanges The files changed.
 * @returns The HTML.
 */
function generateCdvStatsHtml(fileChanges: ReadonlyArray<GG.GitFileChange>) {
	let additions = 0, deletions = 0;
	fileChanges.forEach((file) => {
		additions += file.additions || 0;
		deletions += file.deletions || 0;
	});
	return '<div class="cdvStats"><span>' + (fileChanges.length !== 1 ? t('{0} files', fileChanges.length) : t('{0} file', fileChanges.length)) + '</span>' +
		'<span class="fileTreeFileAdd">+' + additions + '</span><span class="fileTreeFileDel">\u2212' + deletions + '</span>' + generateChangeBarHtml(additions, deletions, null) + '</div>';
}

function generateFileListHtml(folder: FileTreeFolder, gitFiles: ReadonlyArray<GG.GitFileChange>, lastViewedFile: string | null, fileContextMenuOpen: number, isUncommitted: boolean) {
	const sortLeaves = (folder: FileTreeFolder, folderPath: string) => {
		let keys = sortFolderKeys(folder);
		let items: { relPath: string, leaf: FileTreeLeaf }[] = [];
		for (let i = 0; i < keys.length; i++) {
			let cur = folder.contents[keys[i]];
			let relPath = (folderPath !== '' ? folderPath + '/' : '') + cur.name;
			if (cur.type === 'folder') {
				items = items.concat(sortLeaves(cur, relPath));
			} else {
				items.push({ relPath: relPath, leaf: cur });
			}
		}
		return items;
	};
	let sortedLeaves = sortLeaves(folder, '');
	let html = '';
	for (let i = 0; i < sortedLeaves.length; i++) {
		html += generateFileTreeLeafHtml(sortedLeaves[i].relPath, sortedLeaves[i].leaf, gitFiles, lastViewedFile, fileContextMenuOpen, isUncommitted);
	}
	return '<ul class="fileTreeFolderContents">' + html + '</ul>';
}

/**
 * Get the label displayed for the original path of a renamed file. Only the original file name is displayed if the file was renamed within the same directory.
 * @param oldFilePath The original path of the file.
 * @param newFilePath The new path of the file.
 * @returns The label.
 */
function getRenamedFromLabel(oldFilePath: string, newFilePath: string) {
	const oldDirectoryEnd = oldFilePath.lastIndexOf('/'), newDirectoryEnd = newFilePath.lastIndexOf('/');
	return oldFilePath.substring(0, oldDirectoryEnd + 1) === newFilePath.substring(0, newDirectoryEnd + 1)
		? oldFilePath.substring(oldDirectoryEnd + 1)
		: oldFilePath;
}

function generateFileTreeLeafHtml(name: string, leaf: FileTreeLeaf, gitFiles: ReadonlyArray<GG.GitFileChange>, lastViewedFile: string | null, fileContextMenuOpen: number, isUncommitted: boolean) {
	let encodedName = encodeURIComponent(name), escapedName = escapeHtml(name);
	if (leaf.type === 'file') {
		const fileTreeFile = gitFiles[leaf.index];
		const textFile = fileTreeFile.additions !== null && fileTreeFile.deletions !== null;
		const diffPossible = fileTreeFile.type === GG.GitFileStatus.Untracked || textFile;
		const changeTypeMessage = t(GIT_FILE_CHANGE_TYPES[fileTreeFile.type]) + (fileTreeFile.type === GG.GitFileStatus.Renamed ? ' (' + escapeHtml(fileTreeFile.oldFilePath) + ' → ' + escapeHtml(fileTreeFile.newFilePath) + ')' : '');
		const renamedFromHtml = fileTreeFile.type === GG.GitFileStatus.Renamed ? '<span class="gitFileRenamedFrom">← ' + escapeHtml(getRenamedFromLabel(fileTreeFile.oldFilePath, fileTreeFile.newFilePath)) + '</span>' : '';
		const dirEnd = name.lastIndexOf('/');
		const nameHtml = dirEnd > -1
			? '<span class="gitFileName ' + fileTreeFile.type + '">' + escapeHtml(name.substring(dirEnd + 1)) + '</span>' + renamedFromHtml + '<span class="gitFileDir">' + escapeHtml(name.substring(0, dirEnd)) + '</span>'
			: '<span class="gitFileName ' + fileTreeFile.type + '">' + escapedName + '</span>' + renamedFromHtml;
		const isLastViewed = fileTreeFile.newFilePath === lastViewedFile;
		return '<li data-pathseg="' + encodedName + '"><span class="fileTreeFileRecord' + (leaf.index === fileContextMenuOpen ? ' ' + CLASS_CONTEXT_MENU_ACTIVE : '') + (isLastViewed ? ' ' + CLASS_LAST_VIEWED_FILE : '') + '" data-index="' + leaf.index + '"><span class="fileTreeFile' + (diffPossible ? ' gitDiffPossible' : '') + (leaf.reviewed ? '' : ' ' + CLASS_PENDING_REVIEW) + '" title="' + (diffPossible ? t('Click to View Diff') : t('Unable to View Diff{0}', (fileTreeFile.type !== GG.GitFileStatus.Deleted ? t(' (this is a binary file)') : ''))) + ' • ' + changeTypeMessage + '"><span class="fileTreeFileBadge ' + fileTreeFile.type + '">' + fileTreeFile.type + '</span>' + fileIcons.getFileIcon(fileTreeFile.newFilePath) + '<span class="fileTreeFileText">' + nameHtml + '</span></span>' +
			(initialState.config.enhancedAccessibility ? '<span class="fileTreeFileType" title="' + changeTypeMessage + '">' + fileTreeFile.type + '</span>' : '') +
			(textFile ? '<span class="fileTreeFileAddDel">' + generateChangeBarHtml(fileTreeFile.additions!, fileTreeFile.deletions!, Math.round(8 + 52 * (fileTreeFile.additions! + fileTreeFile.deletions!) / fileViewMaxLinesChanged)) + '<span class="fileTreeFileAdd" title="' + (fileTreeFile.additions !== 1 ? t('{0} additions', fileTreeFile.additions) : t('{0} addition', fileTreeFile.additions)) + '">+' + fileTreeFile.additions + '</span><span class="fileTreeFileDel" title="' + (fileTreeFile.deletions !== 1 ? t('{0} deletions', fileTreeFile.deletions) : t('{0} deletion', fileTreeFile.deletions)) + '">\u2212' + fileTreeFile.deletions + '</span></span>' : '') +
			(isLastViewed ? '<span id="cdvLastFileViewed" title="' + t('Last File Viewed') + '">' + SVG_ICONS.eyeOpen + '</span>' : '') +
			'<span class="copyGitFile fileTreeFileAction" title="' + t('Copy Absolute File Path to Clipboard') + '">' + SVG_ICONS.copy + '</span>' +
			(fileTreeFile.type !== GG.GitFileStatus.Deleted
				? (diffPossible && !isUncommitted ? '<span class="viewGitFileAtRevision fileTreeFileAction" title="' + t('View File at this Revision') + '">' + SVG_ICONS.commit + '</span>' : '') +
				'<span class="openGitFile fileTreeFileAction" title="' + t('Open File') + '">' + SVG_ICONS.openFile + '</span>'
				: ''
			) + '</span></li>';
	} else {
		return '<li data-pathseg="' + encodedName + '"><span class="fileTreeRepo" data-path="' + encodeURIComponent(leaf.path) + '" title="' + t('Click to View Repository') + '"><span class="fileTreeRepoIcon">' + SVG_ICONS.closedFolder + '</span>' + escapedName + '</span></li>';
	}
}

function alterFileTreeFolderOpen(folder: FileTreeFolder, folderPath: string, open: boolean) {
	let path = folderPath.split('/'), i, cur = folder;
	for (i = 0; i < path.length; i++) {
		if (typeof cur.contents[path[i]] !== 'undefined') {
			cur = <FileTreeFolder>cur.contents[path[i]];
			if (i === path.length - 1) cur.open = open;
		} else {
			return;
		}
	}
}

function alterFileTreeFileReviewed(folder: FileTreeFolder, filePath: string, reviewed: boolean) {
	let path = filePath.split('/'), i, cur = folder, folders = [folder];
	for (i = 0; i < path.length; i++) {
		if (typeof cur.contents[path[i]] !== 'undefined') {
			if (i < path.length - 1) {
				cur = <FileTreeFolder>cur.contents[path[i]];
				folders.push(cur);
			} else {
				(<FileTreeFile>cur.contents[path[i]]).reviewed = reviewed;
			}
		} else {
			break;
		}
	}

	// Recalculate whether each of the folders leading to the file are now reviewed (deepest first).
	for (i = folders.length - 1; i >= 0; i--) {
		let keys = Object.keys(folders[i].contents), entireFolderReviewed = true;
		for (let j = 0; j < keys.length; j++) {
			let cur = folders[i].contents[keys[j]];
			if ((cur.type === 'folder' || cur.type === 'file') && !cur.reviewed) {
				entireFolderReviewed = false;
				break;
			}
		}
		folders[i].reviewed = entireFolderReviewed;
	}
}

function setFileTreeReviewed(folder: FileTreeFolder, reviewed: boolean) {
	folder.reviewed = reviewed;
	let keys = Object.keys(folder.contents);
	for (let i = 0; i < keys.length; i++) {
		let cur = folder.contents[keys[i]];
		if (cur.type === 'folder') {
			setFileTreeReviewed(cur, reviewed);
		} else if (cur.type === 'file') {
			cur.reviewed = reviewed;
		}
	}
}

function calcFileTreeFoldersReviewed(folder: FileTreeFolder) {
	const calc = (folder: FileTreeFolder) => {
		let reviewed = true;
		let keys = Object.keys(folder.contents);
		for (let i = 0; i < keys.length; i++) {
			let cur = folder.contents[keys[i]];
			if ((cur.type === 'folder' && !calc(cur)) || (cur.type === 'file' && !cur.reviewed)) reviewed = false;
		}
		folder.reviewed = reviewed;
		return reviewed;
	};
	calc(folder);
}

function updateFileTreeHtml(elem: HTMLElement, folder: FileTreeFolder) {
	let ul = getChildUl(elem);
	if (ul === null) return;

	for (let i = 0; i < ul.children.length; i++) {
		let li = <HTMLLIElement>ul.children[i];
		let pathSeg = decodeURIComponent(li.dataset.pathseg!);
		let child = getChildByPathSegment(folder, pathSeg);
		if (child.type === 'folder') {
			alterClass(<HTMLSpanElement>li.children[0], CLASS_PENDING_REVIEW, !child.reviewed);
			updateFileTreeHtml(li, child);
		} else if (child.type === 'file') {
			alterClass(<HTMLSpanElement>li.children[0].children[0], CLASS_PENDING_REVIEW, !child.reviewed);
		}
	}
}

function updateFileTreeHtmlFileReviewed(elem: HTMLElement, folder: FileTreeFolder, filePath: string) {
	let path = filePath;
	const update = (elem: HTMLElement, folder: FileTreeFolder) => {
		let ul = getChildUl(elem);
		if (ul === null) return;

		for (let i = 0; i < ul.children.length; i++) {
			let li = <HTMLLIElement>ul.children[i];
			let pathSeg = decodeURIComponent(li.dataset.pathseg!);
			if (path === pathSeg || path.startsWith(pathSeg + '/')) {
				let child = getChildByPathSegment(folder, pathSeg);
				if (child.type === 'folder') {
					alterClass(<HTMLSpanElement>li.children[0], CLASS_PENDING_REVIEW, !child.reviewed);
					path = path.substring(pathSeg.length + 1);
					update(li, child);
				} else if (child.type === 'file') {
					alterClass(<HTMLSpanElement>li.children[0].children[0], CLASS_PENDING_REVIEW, !child.reviewed);
				}
				break;
			}
		}
	};
	update(elem, folder);
}

function getFilesInTree(folder: FileTreeFolder, gitFiles: ReadonlyArray<GG.GitFileChange>) {
	let files: string[] = [];
	const scanFolder = (folder: FileTreeFolder) => {
		let keys = Object.keys(folder.contents);
		for (let i = 0; i < keys.length; i++) {
			let cur = folder.contents[keys[i]];
			if (cur.type === 'folder') {
				scanFolder(cur);
			} else if (cur.type === 'file') {
				files.push(gitFiles[cur.index].newFilePath);
			}
		}
	};
	scanFolder(folder);
	return files;
}

function sortFolderKeys(folder: FileTreeFolder) {
	let keys = Object.keys(folder.contents);
	keys.sort((a, b) => folder.contents[a].type !== 'file' && folder.contents[b].type === 'file' ? -1 : folder.contents[a].type === 'file' && folder.contents[b].type !== 'file' ? 1 : folder.contents[a].name.localeCompare(folder.contents[b].name));
	return keys;
}

function getChildByPathSegment(folder: FileTreeFolder, pathSeg: string) {
	let cur: FileTreeNode = folder, comps = pathSeg.split('/');
	for (let i = 0; i < comps.length; i++) {
		cur = (<FileTreeFolder>cur).contents[comps[i]];
	}
	return cur;
}
