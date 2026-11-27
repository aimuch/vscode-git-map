import * as path from 'path';
import * as vscode from 'vscode';
import { escapeCompanionHtml, resolveTargetRepo } from './companionPanelBase';
import { getConfig } from './config';
import { DataSource } from './dataSource';
import { ExtensionState } from './extensionState';
import { runGit } from './historyRewrite';
import { getLanguage, t } from './l10n';
import { Logger } from './logger';
import { RepoManager } from './repoManager';
import { abbrevCommit, getNonce, getRepoName, showErrorMessage, showInformationMessage, viewFileAtRevision } from './utils';
import { Disposable } from './utils/disposable';

const HASH_REGEXP = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const MAX_TREEMAP_FILES = 600; // The largest files (or most changed files) shown in the treemap
const CHURN_COMMITS = 1000; // How many of the latest commits are counted for the churn of files

/**
 * A file shown in the Files Treemap.
 */
export interface TreemapFile {
	readonly path: string;
	readonly size: number; // In bytes
	readonly commits: number; // How many of the latest commits changed it
}

/**
 * Parse the output of `git ls-tree -r -l -z <revision>` into the files (blobs) and their sizes.
 */
export function parseLsTreeSizes(output: string): { path: string, size: number }[] {
	return output.split('\0').filter((record) => record !== '').map((record) => {
		const tab = record.indexOf('\t');
		const fields = record.substring(0, tab).trim().split(/\s+/);
		return fields[1] === 'blob' ? { path: record.substring(tab + 1), size: parseInt(fields[3]) || 0 } : null;
	}).filter((file): file is { path: string, size: number } => file !== null);
}

/**
 * Count how many commits changed each file, from the output of `git log --name-only --format=`.
 */
export function countFileChanges(output: string): Map<string, number> {
	const counts = new Map<string, number>();
	output.split(/\r?\n/).forEach((line) => {
		if (line !== '') counts.set(line, (counts.get(line) || 0) + 1);
	});
	return counts;
}

/**
 * "Browse Files at this Commit…" (a Quick Pick of the files of a revision, which opens the chosen file as it was at the revision), and the
 * Files Treemap (the files of a repository as nested blocks, sized by their size or by how often they're changed).
 */
export class RepoBrowser extends Disposable {
	private readonly dataSource: DataSource;
	private readonly repoManager: RepoManager;
	private readonly extensionState: ExtensionState;
	private readonly logger: Logger;
	private panel: vscode.WebviewPanel | null = null;
	private panelRepo: string | null = null;

	constructor(dataSource: DataSource, repoManager: RepoManager, extensionState: ExtensionState, logger: Logger) {
		super();
		this.dataSource = dataSource;
		this.repoManager = repoManager;
		this.extensionState = extensionState;
		this.logger = logger;
		this.registerDisposables(
			vscode.commands.registerCommand('git-map.browseRevision', (arg?: unknown) => this.browseRevision(arg)),
			vscode.commands.registerCommand('git-map.filesTreemap', (arg?: unknown) => this.showTreemap(arg)),
			{ dispose: () => { if (this.panel !== null) this.panel.dispose(); } }
		);
	}

	/**
	 * The method run when the `git-map.browseRevision` command is invoked: choose a file of a revision (`{ repo, commitHash }`, otherwise
	 * HEAD of the repository) in a Quick Pick, and open it as it was at the revision.
	 */
	public async browseRevision(arg?: unknown) {
		const repo = resolveTargetRepo(this.repoManager, this.extensionState, arg);
		if (repo === null) {
			showErrorMessage(t('No Git repositories were found in the current workspace.'));
			return;
		}
		const given = typeof arg === 'object' && arg !== null && typeof (<any>arg).commitHash === 'string' ? <string>(<any>arg).commitHash : 'HEAD';
		const resolved = await runGit(this.dataSource, repo, ['rev-parse', '-q', '--verify', (given.startsWith('-') ? 'HEAD' : given) + '^{commit}']);
		const hash = resolved.stdout.toString().trim();
		if (resolved.code !== 0 || !HASH_REGEXP.test(hash)) {
			showErrorMessage(t('Unable to resolve "{0}" to a commit.', given));
			return;
		}
		const tree = await runGit(this.dataSource, repo, ['-c', 'core.quotepath=false', 'ls-tree', '-r', '-l', '-z', hash]);
		if (tree.code !== 0) {
			showErrorMessage(tree.stderr || t('Unable to read the files of {0}.', abbrevCommit(hash)));
			return;
		}
		const files = parseLsTreeSizes(tree.stdout.toString());
		if (files.length === 0) {
			showInformationMessage(t('There are no files at {0}.', abbrevCommit(hash)));
			return;
		}
		if (typeof vscode.window.showQuickPick !== 'function') return;
		const picked = await vscode.window.showQuickPick(files.map((file) => ({
			label: path.posix.basename(file.path),
			description: path.posix.dirname(file.path) !== '.' ? path.posix.dirname(file.path) : '',
			detail: undefined,
			filePath: file.path
		})), {
			title: t('Browse Files at {0} ({1})', abbrevCommit(hash), getRepoName(repo)),
			placeHolder: t('Search the {0} files of the commit', files.length),
			matchOnDescription: true,
			ignoreFocusOut: false
		});
		if (typeof picked === 'undefined') return;
		await viewFileAtRevision(repo, hash, picked.filePath);
	}

	/**
	 * Load the files of HEAD with their sizes & how many of the latest commits changed them.
	 */
	public async loadTreemapFiles(repo: string): Promise<{ files: TreemapFile[], error: string | null }> {
		const [tree, log] = await Promise.all([
			runGit(this.dataSource, repo, ['-c', 'core.quotepath=false', 'ls-tree', '-r', '-l', '-z', 'HEAD']),
			runGit(this.dataSource, repo, ['-c', 'core.quotepath=false', '-c', 'log.showSignature=false', 'log', '--no-merges', '--max-count=' + CHURN_COMMITS, '--name-only', '--format=', 'HEAD', '--'])
		]);
		if (tree.code !== 0) return { files: [], error: tree.stderr || t('Unable to read the files of HEAD.') };
		const counts = countFileChanges(log.code === 0 ? log.stdout.toString() : '');
		return { files: parseLsTreeSizes(tree.stdout.toString()).map((file) => ({ path: file.path, size: file.size, commits: counts.get(file.path) || 0 })), error: null };
	}

	/**
	 * The method run when the `git-map.filesTreemap` command is invoked: show the Files Treemap of a repository.
	 */
	public async showTreemap(arg?: unknown) {
		const repo = resolveTargetRepo(this.repoManager, this.extensionState, arg);
		if (repo === null) {
			showErrorMessage(t('No Git repositories were found in the current workspace.'));
			return;
		}
		const result = await this.loadTreemapFiles(repo);
		if (result.error !== null) {
			showErrorMessage(result.error);
			return;
		}
		const bySize = result.files.slice().sort((a, b) => b.size - a.size).slice(0, MAX_TREEMAP_FILES);
		const byChurn = result.files.filter((file) => file.commits > 0).sort((a, b) => b.commits - a.commits).slice(0, MAX_TREEMAP_FILES);
		const title = t('Files Treemap: {0}', getRepoName(repo));
		if (this.panel === null) {
			this.panel = vscode.window.createWebviewPanel('git-map.filesTreemap', title, getConfig().openNewTabEditorGroup, { enableScripts: true, localResourceRoots: [], retainContextWhenHidden: true });
			const created = this.panel;
			const messages = created.webview.onDidReceiveMessage((msg: { command?: unknown, path?: unknown }) => {
				if (msg && msg.command === 'open' && typeof msg.path === 'string' && this.panelRepo !== null) {
					const abs = path.resolve(this.panelRepo, msg.path), rel = path.relative(this.panelRepo, abs);
					if (rel.startsWith('..') || path.isAbsolute(rel)) return;
					vscode.commands.executeCommand('vscode.open', vscode.Uri.file(abs)).then(() => { }, () => { });
				}
			});
			const disposed = created.onDidDispose(() => {
				messages.dispose();
				disposed.dispose();
				if (this.panel === created) this.panel = null;
			});
		} else {
			this.panel.title = title;
			this.panel.reveal();
		}
		this.panelRepo = repo;
		this.panel.webview.html = getTreemapHtml(getRepoName(repo), bySize, byChurn, result.files.length, this.panel.webview.cspSource);
		this.logger.log('Showing the Files Treemap of ' + repo);
	}
}

/**
 * Get the HTML of the Files Treemap.
 */
function getTreemapHtml(repoName: string, bySize: ReadonlyArray<TreemapFile>, byChurn: ReadonlyArray<TreemapFile>, total: number, cspSource: string) {
	const nonce = getNonce();
	const strings = {
		size: t('Size'),
		churn: t('Changes'),
		sizeHint: t('Blocks are sized by file size, and coloured by file type.'),
		churnHint: t('Blocks are sized by how many of the latest {0} commits changed the file: the hottest are red.', CHURN_COMMITS),
		empty: t('No files to show.'),
		commits: t('commits'),
		shown: t('Showing {0} of {1} files.', '{0}', total)
	};
	const data = JSON.stringify({ size: bySize, churn: byChurn }).replace(/</g, '\\u003c');
	return '<!DOCTYPE html><html lang="' + (getLanguage() === 'zh-cn' ? 'zh-CN' : 'en') + '"><head><meta charset="UTF-8">' +
		'<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src ' + cspSource + ' \'unsafe-inline\'; script-src \'nonce-' + nonce + '\';">' +
		'<meta name="viewport" content="width=device-width, initial-scale=1.0"><style>' +
		'html,body{height:100%;margin:0}body{display:flex;flex-direction:column;color:var(--vscode-foreground);font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);background:var(--vscode-editor-background)}' +
		'header{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--vscode-widget-border,rgba(128,128,128,.3))}h1{font-size:14px;margin:0}' +
		'.seg{display:inline-flex;border:1px solid var(--vscode-widget-border,rgba(128,128,128,.4));border-radius:4px;overflow:hidden}.seg button{background:none;border:0;color:inherit;padding:3px 10px;cursor:pointer;font:inherit}.seg button.on{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}' +
		'.hint{color:var(--vscode-descriptionForeground);font-size:12px}.grow{flex:1}#map{position:relative;flex:1;margin:10px 14px 14px;overflow:hidden}' +
		'.cell{position:absolute;box-sizing:border-box;border:1px solid var(--vscode-editor-background);overflow:hidden;font-size:11px;line-height:14px;padding:2px 4px;color:#fff;text-shadow:0 1px 1px rgba(0,0,0,.6);cursor:pointer;white-space:nowrap;text-overflow:ellipsis}.cell:hover{outline:2px solid var(--vscode-focusBorder);z-index:1}' +
		'</style></head><body><header><h1>' + escapeCompanionHtml(t('Files Treemap')) + ' · ' + escapeCompanionHtml(repoName) + '</h1>' +
		'<div class="seg" role="radiogroup"><button type="button" data-mode="size" class="on">' + escapeCompanionHtml(strings.size) + '</button><button type="button" data-mode="churn">' + escapeCompanionHtml(strings.churn) + '</button></div>' +
		'<span class="hint" id="hint"></span><span class="grow"></span><span class="hint" id="shown"></span></header><div id="map"></div>' +
		'<script nonce="' + nonce + '">(function(){var vscode=acquireVsCodeApi(),DATA=' + data + ',S=' + JSON.stringify(strings).replace(/</g, '\\u003c') + ',mode="size";' +
		'function esc(s){return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");}' +
		'function hue(p){var e=p.lastIndexOf(".")>-1?p.substring(p.lastIndexOf(".")+1):p,h=0;for(var i=0;i<e.length;i++)h=(h*31+e.charCodeAt(i))%360;return h;}' +
		'function worst(row,w){var s=0,mx=0,mn=Infinity;row.forEach(function(r){s+=r.a;mx=Math.max(mx,r.a);mn=Math.min(mn,r.a);});return Math.max(w*w*mx/(s*s),(s*s)/(w*w*mn));}' +
		'function squarify(items,x,y,w,h,out){var rest=items.slice();while(rest.length>0){var short=Math.min(w,h),row=[rest[0]],i=1;while(i<rest.length&&worst(row.concat([rest[i]]),short)<=worst(row,short)){row.push(rest[i]);i++;}rest=rest.slice(i);var s=row.reduce(function(a,r){return a+r.a;},0);' +
		'if(w>=h){var cw=s/h,cy=y;row.forEach(function(r){var ch=r.a/cw;out.push({f:r.f,x:x,y:cy,w:cw,h:ch});cy+=ch;});x+=cw;w-=cw;}else{var rh=s/w,cx=x;row.forEach(function(r){var rw=r.a/rh;out.push({f:r.f,x:cx,y:y,w:rw,h:rh});cx+=rw;});y+=rh;h-=rh;}}}' +
		'function render(){var map=document.getElementById("map"),files=DATA[mode],W=map.clientWidth,H=map.clientHeight;document.getElementById("hint").textContent=mode==="size"?S.sizeHint:S.churnHint;document.getElementById("shown").textContent=S.shown.replace("{0}",files.length);' +
		'if(files.length===0||W<=0||H<=0){map.innerHTML="<p class=\\"hint\\">"+esc(S.empty)+"</p>";return;}var val=function(f){return mode==="size"?Math.max(f.size,1):f.commits;},total=files.reduce(function(a,f){return a+val(f);},0),max=files.reduce(function(a,f){return Math.max(a,f.commits);},1);' +
		'var items=files.map(function(f){return {f:f,a:val(f)*W*H/total};}),out=[];squarify(items,0,0,W,H,out);' +
		'map.innerHTML=out.map(function(c){var f=c.f,col=mode==="size"?"hsl("+hue(f.path)+",45%,38%)":"hsl("+Math.round(220-220*Math.sqrt(f.commits/max))+",65%,40%)",name=f.path.substring(f.path.lastIndexOf("/")+1),tip=f.path+" \\u00b7 "+(f.size>=1024?(f.size/1024).toFixed(1)+" KB":f.size+" B")+" \\u00b7 "+f.commits+" "+S.commits;' +
		'return "<div class=\\"cell\\" data-path=\\""+esc(f.path)+"\\" title=\\""+esc(tip)+"\\" style=\\"left:"+c.x+"px;top:"+c.y+"px;width:"+c.w+"px;height:"+c.h+"px;background:"+col+"\\">"+(c.w>40&&c.h>14?esc(name):"")+"</div>";}).join("");}' +
		'document.querySelector(".seg").addEventListener("click",function(e){var b=e.target.closest("button");if(!b)return;mode=b.getAttribute("data-mode");document.querySelectorAll(".seg button").forEach(function(x){x.classList.toggle("on",x===b);});render();});' +
		'document.getElementById("map").addEventListener("click",function(e){var c=e.target.closest(".cell");if(c)vscode.postMessage({command:"open",path:c.getAttribute("data-path")});});' +
		'window.addEventListener("resize",render);render();})();</script></body></html>';
}
