const CLASS_GRAPH_VERTEX_ACTIVE = 'graphVertexActive';
const NULL_VERTEX_ID = -1;


/* Types */

interface Point {
	readonly x: number;
	readonly y: number;
}
interface Line {
	readonly p1: Point;
	readonly p2: Point;
	readonly lockedFirst: boolean; // TRUE => The line is locked to p1, FALSE => The line is locked to p2
}

interface Pixel {
	x: number;
	y: number;
}
interface PlacedLine {
	readonly p1: Pixel;
	readonly p2: Pixel;
	readonly isCommitted: boolean;
	readonly lockedFirst: boolean; // TRUE => The line is locked to p1, FALSE => The line is locked to p2
}

interface UnavailablePoint {
	readonly connectsTo: VertexOrNull;
	readonly onBranch: Branch;
}

type VertexOrNull = Vertex | null;


/* Branch Class */

class Branch {
	public readonly index: number;
	private readonly colour: number;
	private end: number = 0;
	private lines: Line[] = [];
	private numUncommitted: number = 0;

	constructor(colour: number, index: number) {
		this.colour = colour;
		this.index = index;
	}

	public addLine(p1: Point, p2: Point, isCommitted: boolean, lockedFirst: boolean) {
		this.lines.push({ p1: p1, p2: p2, lockedFirst: lockedFirst });
		if (isCommitted) {
			if (p2.x === 0 && p2.y < this.numUncommitted) this.numUncommitted = p2.y;
		} else {
			this.numUncommitted++;
		}
	}


	/* Get / Set */

	public getColour() {
		return this.colour;
	}

	public getStart() {
		return this.lines.length > 0 ? this.lines[0].p1.y : this.end;
	}

	public getEnd() {
		return this.end;
	}

	public setEnd(end: number) {
		this.end = end;
	}


	/* Rendering */

	public draw(svg: SVGElement, config: GG.GraphConfig, expandAt: number, branchElems: SVGElement[]) {
		let colour = config.colours[this.colour % config.colours.length], i, x1, y1, x2, y2, lines: PlacedLine[] = [], curPath = '', d = config.grid.y * (config.style === GG.GraphStyle.Angular ? 0.38 : 0.8), line, nextLine;

		// Convert branch lines into pixel coordinates, respecting expanded commit extensions
		for (i = 0; i < this.lines.length; i++) {
			line = this.lines[i];
			x1 = line.p1.x * config.grid.x + config.grid.offsetX; y1 = line.p1.y * config.grid.y + config.grid.offsetY;
			x2 = line.p2.x * config.grid.x + config.grid.offsetX; y2 = line.p2.y * config.grid.y + config.grid.offsetY;

			// If a commit is expanded, we need to stretch the graph for the height of the commit details view
			if (expandAt > -1) {
				if (line.p1.y > expandAt) { // If the line starts after the expansion, move the whole line lower
					y1 += config.grid.expandY;
					y2 += config.grid.expandY;
				} else if (line.p2.y > expandAt) { // If the line crosses the expansion
					if (x1 === x2) { // The line is vertical, extend the endpoint past the expansion
						y2 += config.grid.expandY;
					} else if (line.lockedFirst) { // If the line is locked to the first point, the transition stays in its normal position
						lines.push({ p1: { x: x1, y: y1 }, p2: { x: x2, y: y2 }, isCommitted: i >= this.numUncommitted, lockedFirst: line.lockedFirst }); // Display the normal transition
						lines.push({ p1: { x: x2, y: y1 + config.grid.y }, p2: { x: x2, y: y2 + config.grid.expandY }, isCommitted: i >= this.numUncommitted, lockedFirst: line.lockedFirst }); // Extend the line over the expansion from the transition end point
						continue;
					} else { // If the line is locked to the second point, the transition moves to after the expansion
						lines.push({ p1: { x: x1, y: y1 }, p2: { x: x1, y: y2 - config.grid.y + config.grid.expandY }, isCommitted: i >= this.numUncommitted, lockedFirst: line.lockedFirst }); // Extend the line over the expansion to the new transition start point
						y1 += config.grid.expandY; y2 += config.grid.expandY;
					}
				}
			}
			lines.push({ p1: { x: x1, y: y1 }, p2: { x: x2, y: y2 }, isCommitted: i >= this.numUncommitted, lockedFirst: line.lockedFirst });
		}

		// Simplify consecutive lines that are straight by removing the 'middle' point
		i = 0;
		while (i < lines.length - 1) {
			line = lines[i];
			nextLine = lines[i + 1];
			if (line.p1.x === line.p2.x && line.p2.x === nextLine.p1.x && nextLine.p1.x === nextLine.p2.x && line.p2.y === nextLine.p1.y && line.isCommitted === nextLine.isCommitted) {
				line.p2.y = nextLine.p2.y;
				lines.splice(i + 1, 1);
			} else {
				i++;
			}
		}

		// Iterate through all lines, producing and adding the svg paths to the DOM
		for (i = 0; i < lines.length; i++) {
			line = lines[i];
			x1 = line.p1.x; y1 = line.p1.y;
			x2 = line.p2.x; y2 = line.p2.y;

			// If the new point belongs to a different path, render the current path and reset it for the new path
			if (curPath !== '' && i > 0 && line.isCommitted !== lines[i - 1].isCommitted) {
				Branch.drawPath(svg, curPath, lines[i - 1].isCommitted, colour, config.uncommittedChanges, this.index, branchElems);
				curPath = '';
			}

			// If the path hasn't been started or the new point belongs to a different path, move to p1
			if (curPath === '' || (i > 0 && (x1 !== lines[i - 1].p2.x || y1 !== lines[i - 1].p2.y))) curPath += 'M' + x1.toFixed(0) + ',' + y1.toFixed(1);

			if (x1 === x2) { // If the path is vertical, draw a straight line
				curPath += 'L' + x2.toFixed(0) + ',' + y2.toFixed(1);
			} else { // If the path moves horizontal, draw the appropriate transition
				if (config.style === GG.GraphStyle.Angular) {
					curPath += 'L' + (line.lockedFirst ? (x2.toFixed(0) + ',' + (y2 - d).toFixed(1)) : (x1.toFixed(0) + ',' + (y1 + d).toFixed(1))) + 'L' + x2.toFixed(0) + ',' + y2.toFixed(1);
				} else {
					curPath += 'C' + x1.toFixed(0) + ',' + (y1 + d).toFixed(1) + ' ' + x2.toFixed(0) + ',' + (y2 - d).toFixed(1) + ' ' + x2.toFixed(0) + ',' + y2.toFixed(1);
				}
			}
		}

		if (curPath !== '') {
			Branch.drawPath(svg, curPath, lines[lines.length - 1].isCommitted, colour, config.uncommittedChanges, this.index, branchElems); // Draw the remaining path
		}
	}

	private static drawPath(svg: SVGElement, path: string, isCommitted: boolean, colour: string, uncommittedChanges: GG.GraphUncommittedChangesStyle, branchIndex: number, branchElems: SVGElement[]) {
		const shadow = svg.appendChild(document.createElementNS(SVG_NAMESPACE, 'path')), line = svg.appendChild(document.createElementNS(SVG_NAMESPACE, 'path'));
		shadow.setAttribute('class', 'shadow');
		shadow.setAttribute('d', path);
		line.setAttribute('class', 'line');
		line.setAttribute('d', path);
		line.dataset.branch = branchIndex.toString();
		line.setAttribute('stroke', isCommitted ? colour : '#808080');
		if (!isCommitted && uncommittedChanges === GG.GraphUncommittedChangesStyle.OpenCircleAtTheCheckedOutCommit) {
			line.setAttribute('stroke-dasharray', '2px');
		}
		branchElems.push(line);
	}
}


/* Vertex Class */

class Vertex {
	public readonly id: number;
	public readonly isStash: boolean;

	private x: number = 0;
	private children: Vertex[] = [];
	private parents: Vertex[] = [];
	private nextParent: number = 0;
	private onBranch: Branch | null = null;
	private isCommitted: boolean = true;
	private isCurrent: boolean = false;
	private nextX: number = 0;
	private connections: UnavailablePoint[] = [];

	constructor(id: number, isStash: boolean) {
		this.id = id;
		this.isStash = isStash;
	}


	/* Children */

	public addChild(vertex: Vertex) {
		this.children.push(vertex);
	}

	public getChildren(): ReadonlyArray<Vertex> {
		return this.children;
	}


	/* Parents */

	public addParent(vertex: Vertex) {
		this.parents.push(vertex);
	}

	public getParents(): ReadonlyArray<Vertex> {
		return this.parents;
	}

	public hasParents() {
		return this.parents.length > 0;
	}

	public getNextParent(): Vertex | null {
		if (this.nextParent < this.parents.length) return this.parents[this.nextParent];
		return null;
	}

	public getLastParent(): Vertex | null {
		if (this.nextParent < 1) return null;
		return this.parents[this.nextParent - 1];
	}

	public registerParentProcessed() {
		this.nextParent++;
	}

	public isMerge() {
		return this.parents.length > 1;
	}


	/* Branch */

	public addToBranch(branch: Branch, x: number) {
		if (this.onBranch === null) {
			this.onBranch = branch;
			this.x = x;
		}
	}

	public isNotOnBranch() {
		return this.onBranch === null;
	}

	public isOnThisBranch(branch: Branch) {
		return this.onBranch === branch;
	}

	public getBranch() {
		return this.onBranch;
	}


	/* Point */

	public getPoint(): Point {
		return { x: this.x, y: this.id };
	}

	public getNextPoint(): Point {
		return { x: this.nextX, y: this.id };
	}

	public getPointConnectingTo(vertex: VertexOrNull, onBranch: Branch) {
		for (let i = 0; i < this.connections.length; i++) {
			if (this.connections[i].connectsTo === vertex && this.connections[i].onBranch === onBranch) {
				return { x: i, y: this.id };
			}
		}
		return null;
	}
	public registerUnavailablePoint(x: number, connectsToVertex: VertexOrNull, onBranch: Branch) {
		if (x === this.nextX) {
			this.nextX = x + 1;
			this.connections[x] = { connectsTo: connectsToVertex, onBranch: onBranch };
		}
	}


	/* Get / Set State */

	public getColour() {
		return this.onBranch !== null ? this.onBranch.getColour() : 0;
	}

	public getIsCommitted() {
		return this.isCommitted;
	}

	public setNotCommitted() {
		this.isCommitted = false;
	}

	public setCurrent() {
		this.isCurrent = true;
	}


	/* Rendering */

	public draw(svg: SVGElement, config: GG.GraphConfig, expandOffset: boolean, highlighted: boolean, branchElems: SVGElement[] | null, avatar: VertexAvatar | null) {
		if (this.onBranch === null) return;
		const branchIndex = this.onBranch.index;

		const colour = this.isCommitted ? config.colours[this.onBranch.getColour() % config.colours.length] : '#808080';
		const cx = (this.x * config.grid.x + config.grid.offsetX).toString();
		const cy = (this.id * config.grid.y + config.grid.offsetY + (expandOffset ? config.grid.expandY : 0)).toString();

		const circle = document.createElementNS(SVG_NAMESPACE, 'circle');
		circle.dataset.id = this.id.toString();
		circle.dataset.branch = branchIndex.toString();
		circle.setAttribute('cx', cx);
		circle.setAttribute('cy', cy);
		circle.setAttribute('r', '4');
		let avatarElem: SVGElement | null = null;
		if (avatar !== null && this.isCommitted && !this.isStash) {
			// The author's avatar (or their initial until the avatar is loaded, or if they don't have one), in a circle outlined in the colour of the branch
			circle.setAttribute('r', '9');
			circle.setAttribute('class', 'avatar' + (this.isCurrent ? ' current' : ''));
			circle.style.fill = getAuthorColour(avatar.author);
			circle.style.stroke = colour;
			if (avatar.pattern !== null) {
				avatarElem = createAvatarElem(cx, cy, avatar.pattern);
			} else {
				avatarElem = document.createElementNS(SVG_NAMESPACE, 'text');
				avatarElem.setAttribute('x', cx);
				avatarElem.setAttribute('y', cy);
				avatarElem.setAttribute('class', 'avatarInitial');
				avatarElem.textContent = avatar.author.trim().length > 0 ? avatar.author.trim().charAt(0).toUpperCase() : '?';
			}
			avatarElem.dataset.branch = branchIndex.toString();
			avatarElem.dataset.email = avatar.email;
		} else if (this.isCurrent) {
			circle.setAttribute('class', 'current');
			circle.setAttribute('stroke', colour);
		} else {
			circle.setAttribute('fill', colour);
		}
		if (this.isStash && !this.isCurrent) {
			circle.setAttribute('r', '4.5');
			circle.setAttribute('class', 'stashOuter');
		}
		if (highlighted) {
			circle.classList.add('highlight');
			if (avatarElem !== null) avatarElem.classList.add('highlight');
		}
		svg.appendChild(circle);
		if (avatarElem !== null) svg.appendChild(avatarElem);
		if (branchElems !== null) {
			branchElems.push(circle);
			if (avatarElem !== null) branchElems.push(avatarElem);
		}

		if (this.isStash && !this.isCurrent) {
			const innerCircle = document.createElementNS(SVG_NAMESPACE, 'circle');
			innerCircle.setAttribute('cx', cx);
			innerCircle.setAttribute('cy', cy);
			innerCircle.setAttribute('r', '2');
			innerCircle.setAttribute('class', 'stashInner');
			svg.appendChild(innerCircle);
		}
	}
}


/**
 * The author of a commit, whose avatar is drawn on the graph.
 */
interface VertexAvatar {
	readonly author: string;
	readonly email: string;
	readonly pattern: string | null; // The id of the pattern of the author's avatar, or NULL if their avatar isn't available
}

/**
 * Create the element of an author's avatar on the graph: a circle filled with the pattern of their avatar (inside the circle of the
 * commit, within its outline). Each author's avatar image is only included once in the graph (in its pattern), however many commits
 * they have.
 * @param cx The x coordinate of the centre of the circle.
 * @param cy The y coordinate of the centre of the circle.
 * @param pattern The id of the pattern of the avatar.
 * @returns The element.
 */
function createAvatarElem(cx: string, cy: string, pattern: string) {
	const elem = document.createElementNS(SVG_NAMESPACE, 'circle');
	elem.setAttribute('cx', cx);
	elem.setAttribute('cy', cy);
	elem.setAttribute('r', '8');
	elem.setAttribute('fill', 'url(#' + pattern + ')');
	elem.setAttribute('class', 'avatarImage');
	return elem;
}


/* Graph Class */

class Graph {
	private readonly config: GG.GraphConfig;
	private readonly muteConfig: GG.MuteCommitsConfig;
	private vertices: Vertex[] = [];
	private branches: Branch[] = [];
	private availableColours: number[] = [];
	private maxWidth: number = -1;
	private readonly naturalGridX: number; // The spacing of the lanes when they fit within the maximum width
	private readonly minGridX: number; // The minimum spacing of the lanes when they're moved closer together to fit within the maximum width
	private renderedExpandedCommit: ExpandedCommit | null = null;

	private commits: ReadonlyArray<GG.GitCommit> = [];
	private commitHead: string | null = null;
	private commitLookup: { [hash: string]: number } = {};
	private onlyFollowFirstParent: boolean = false;
	private expandedCommitIndex: number = -1;
	private getAvatar: (email: string) => string | null = () => null;
	private readonly avatarPatterns: { [email: string]: { readonly id: string, readonly image: SVGImageElement } } = {};

	private readonly viewElem: HTMLElement;
	private readonly contentElem: HTMLElement;
	private readonly svg: SVGElement;
	private readonly defs: SVGDefsElement;
	private readonly maskRect: SVGRectElement;
	private readonly gradientStop1: SVGStopElement;
	private readonly gradientStop2: SVGStopElement;
	private group: SVGGElement | null = null;
	private branchGroup: SVGGElement | null = null;
	private vertexGroup: SVGGElement | null = null;
	private pathElemsByBranch: SVGElement[][] = [];
	private vertexElemsByBranch: SVGElement[][] = [];
	private highlightedBranch: number | null = null;
	private visibleRange: { start: number, end: number } | null = null;
	private pinnedIndices: ReadonlySet<number> | null = null;

	private tooltipId: number = -1;
	private tooltipElem: HTMLElement | null = null;
	private tooltipTimeout: number | null = null;
	private tooltipVertex: SVGElement | null = null;

	constructor(id: string, viewElem: HTMLElement, config: GG.GraphConfig, muteConfig: GG.MuteCommitsConfig) {
		this.viewElem = viewElem;
		this.config = config;
		this.muteConfig = muteConfig;
		this.naturalGridX = config.grid.x;
		this.minGridX = Math.min(config.grid.x, config.nodeStyle === GG.GraphNodeStyle.Avatar ? 14 : 8); // Avatars overlap when they're closer together

		const elem = document.getElementById(id)!;
		this.contentElem = elem.parentElement!;
		this.svg = document.createElementNS(SVG_NAMESPACE, 'svg');
		this.svg.addEventListener('mouseover', (e) => {
			const circle = e.target instanceof Element ? <SVGElement | null>e.target.closest('circle[data-id]') : null;
			if (circle !== null) this.vertexOver(circle);
		});
		this.svg.addEventListener('mouseout', (e) => {
			const circle = e.target instanceof Element ? <SVGElement | null>e.target.closest('circle[data-id]') : null;
			if (circle !== null && e.relatedTarget !== circle) this.closeTooltip();
		});
		let defs = this.svg.appendChild(document.createElementNS(SVG_NAMESPACE, 'defs'));

		let linearGradient = defs.appendChild(document.createElementNS(SVG_NAMESPACE, 'linearGradient'));
		linearGradient.setAttribute('id', 'GraphGradient');
		this.gradientStop1 = linearGradient.appendChild(document.createElementNS(SVG_NAMESPACE, 'stop'));
		this.gradientStop1.setAttribute('stop-color', 'white');
		this.gradientStop2 = linearGradient.appendChild(document.createElementNS(SVG_NAMESPACE, 'stop'));
		this.gradientStop2.setAttribute('stop-color', 'black');

		let mask = defs.appendChild(document.createElementNS(SVG_NAMESPACE, 'mask'));
		mask.setAttribute('id', 'GraphMask');
		this.maskRect = mask.appendChild(document.createElementNS(SVG_NAMESPACE, 'rect'));
		this.maskRect.setAttribute('fill', 'url(#GraphGradient)');

		this.defs = defs;

		this.setDimensions(0, 0);
		elem.appendChild(this.svg);
	}


	/* Graph Operations */

	public loadCommits(commits: ReadonlyArray<GG.GitCommit>, commitHead: string | null, commitLookup: { [hash: string]: number }, onlyFollowFirstParent: boolean) {
		this.commits = commits;
		this.commitHead = commitHead;
		this.commitLookup = commitLookup;
		this.onlyFollowFirstParent = onlyFollowFirstParent;
		this.vertices = [];
		this.branches = [];
		this.availableColours = [];
		if (commits.length === 0) return;

		const nullVertex = new Vertex(NULL_VERTEX_ID, false);
		let i: number, j: number;
		for (i = 0; i < commits.length; i++) {
			this.vertices.push(new Vertex(i, commits[i].stash !== null));
		}
		for (i = 0; i < commits.length; i++) {
			for (j = 0; j < commits[i].parents.length; j++) {
				let parentHash = commits[i].parents[j];
				if (typeof commitLookup[parentHash] === 'number') {
					// Parent is the <commitLookup[parentHash]>th vertex
					this.vertices[i].addParent(this.vertices[commitLookup[parentHash]]);
					this.vertices[commitLookup[parentHash]].addChild(this.vertices[i]);
				} else if (!this.onlyFollowFirstParent || j === 0) {
					// Parent is not one of the vertices of the graph, and the parent isn't being hidden by the onlyFollowFirstParent condition.
					this.vertices[i].addParent(nullVertex);
				}
			}
		}

		if (commits[0].hash === UNCOMMITTED) {
			this.vertices[0].setNotCommitted();
		}

		if (commits[0].hash === UNCOMMITTED && this.config.uncommittedChanges === GG.GraphUncommittedChangesStyle.OpenCircleAtTheUncommittedChanges) {
			this.vertices[0].setCurrent();
		} else if (commitHead !== null && typeof commitLookup[commitHead] === 'number') {
			this.vertices[commitLookup[commitHead]].setCurrent();
		}

		i = 0;
		while (i < this.vertices.length) {
			if (this.vertices[i].getNextParent() !== null || this.vertices[i].isNotOnBranch()) {
				this.determinePath(i);
			} else {
				i++;
			}
		}
	}

	public render(expandedCommit: ExpandedCommit | null, visibleRange: { start: number, end: number } | null = this.visibleRange, pinned: ReadonlySet<number> | null = this.pinnedIndices) {
		this.renderedExpandedCommit = expandedCommit;
		this.expandedCommitIndex = expandedCommit !== null ? expandedCommit.index : -1;
		this.visibleRange = visibleRange;
		this.pinnedIndices = pinned;
		this.highlightedBranch = null;
		this.svg.classList.remove('branchHighlight');
		let group = document.createElementNS(SVG_NAMESPACE, 'g'), contentWidth = this.getContentWidth();
		group.setAttribute('mask', 'url(#GraphMask)');

		const branchGroup = document.createElementNS(SVG_NAMESPACE, 'g');
		group.appendChild(branchGroup);
		this.branchGroup = branchGroup;
		this.renderBranches(visibleRange);

		const vertexGroup = document.createElementNS(SVG_NAMESPACE, 'g');
		group.appendChild(vertexGroup);
		this.vertexGroup = vertexGroup;
		this.renderVertices(visibleRange, pinned);

		if (this.group !== null) this.svg.removeChild(this.group);
		this.svg.appendChild(group);
		this.group = group;
		this.setDimensions(contentWidth, this.getHeight(expandedCommit));
		this.applyMaxWidth(contentWidth);
		this.closeTooltip();
	}

	private renderBranches(visibleRange: { start: number, end: number } | null) {
		if (this.branchGroup === null) return;
		this.branchGroup.innerHTML = '';
		this.pathElemsByBranch = this.branches.map(() => []);
		const start = visibleRange !== null ? Math.max(0, visibleRange.start - 2) : 0;
		const end = visibleRange !== null ? visibleRange.end + 2 : this.vertices.length;
		for (let i = 0; i < this.branches.length; i++) {
			const branch = this.branches[i];
			if (visibleRange !== null && (branch.getEnd() < start || branch.getStart() > end)) continue;
			branch.draw(this.branchGroup, this.config, this.expandedCommitIndex, this.pathElemsByBranch[i]);
		}
	}

	/**
	 * Update the branches & vertices rendered when the virtualised window of rows changes on scroll.
	 */
	public updateVisibleVertices(visibleRange: { start: number, end: number } | null, pinned: ReadonlySet<number> | null) {
		this.visibleRange = visibleRange;
		this.pinnedIndices = pinned;
		if (this.vertexGroup === null) return;
		this.closeTooltip();
		this.renderBranches(visibleRange);
		this.renderVertices(visibleRange, pinned);
	}

	/**
	 * Serialize the commit graph (up to 120 rows) with commit labels into a clean standalone SVG document.
	 */
	public exportStandaloneSvg(commits: ReadonlyArray<GG.GitCommit>): string {
		const maxRows = Math.min(commits.length, 120);
		const graphWidth = Math.max(80, Math.round(this.getContentWidth()) + 16);
		const totalWidth = graphWidth + 680;
		const rowH = this.config.grid.y;
		const totalHeight = Math.max(60, Math.round(maxRows * rowH + this.config.grid.offsetY));
		const bg = getComputedStyle(document.body).backgroundColor || '#1e1e1e';
		const fg = getComputedStyle(document.body).color || '#d4d4d4';
		const clone = <SVGElement>this.svg.cloneNode(true);
		const innerSvg = clone.innerHTML;
		const labels: string[] = [];
		for (let i = 0; i < maxRows; i++) {
			const c = commits[i];
			const y = Math.round(i * rowH + this.config.grid.offsetY + 4);
			const refs = c.heads.concat(c.tags.map((tag) => tag.name)).slice(0, 3).map((r) => '[' + r + ']').join(' ');
			const lineText = (refs !== '' ? refs + ' ' : '') + c.message + ' (' + abbrevCommit(c.hash) + ' · ' + c.author + ')';
			labels.push('<text x="' + graphWidth + '" y="' + y + '" fill="' + escapeHtml(fg) + '" font-family="system-ui,-apple-system,sans-serif" font-size="12">' + escapeHtml(lineText.substring(0, 110)) + '</text>');
		}
		return '<?xml version="1.0" encoding="UTF-8"?>\n' +
			'<svg xmlns="http://www.w3.org/2000/svg" width="' + totalWidth + '" height="' + totalHeight + '" viewBox="0 0 ' + totalWidth + ' ' + totalHeight + '">' +
			'<rect width="100%" height="100%" fill="' + escapeHtml(bg) + '"/>' +
			innerSvg +
			'<g>' + labels.join('') + '</g></svg>';
	}

	private renderVertices(visibleRange: { start: number, end: number } | null, pinned: ReadonlySet<number> | null) {
		if (this.vertexGroup === null) return;
		this.vertexGroup.innerHTML = '';
		this.vertexElemsByBranch = this.branches.map(() => []);
		const avatars = this.config.nodeStyle === GG.GraphNodeStyle.Avatar;
		const drawVertex = (i: number) => {
			if (i < 0 || i >= this.vertices.length) return;
			const branch = this.vertices[i].getBranch();
			if (branch === null) return;
			const commit = avatars && i < this.commits.length ? this.commits[i] : null;
			this.vertices[i].draw(this.vertexGroup!, this.config, this.expandedCommitIndex > -1 && i > this.expandedCommitIndex, this.highlightedBranch === branch.index, this.vertexElemsByBranch[branch.index], commit !== null ? { author: commit.author, email: commit.email, pattern: this.getAvatarPattern(commit.email, null) } : null);
		};
		if (visibleRange === null) {
			for (let i = 0; i < this.vertices.length; i++) drawVertex(i);
		} else {
			const start = Math.max(0, visibleRange.start), end = Math.min(this.vertices.length, visibleRange.end);
			for (let i = start; i < end; i++) drawVertex(i);
			if (pinned !== null) {
				pinned.forEach((index) => {
					if (index < start || index >= end) drawVertex(index);
				});
			}
		}
	}


	/**
	 * Highlight the branch (line) of the graph that a commit is on, dimming the other branches.
	 * @param id The index of the commit, or NULL to remove the highlight.
	 */
	public highlightBranchOfCommit(id: number | null) {
		if (this.group === null) return;
		const branch = id !== null && id >= 0 && id < this.vertices.length ? this.vertices[id].getBranch() : null;
		const nextBranch = branch !== null ? branch.index : null;
		if (nextBranch === this.highlightedBranch) return;
		if (this.highlightedBranch !== null) {
			const prevPaths = this.pathElemsByBranch[this.highlightedBranch], prevVertices = this.vertexElemsByBranch[this.highlightedBranch];
			if (prevPaths) for (let i = 0; i < prevPaths.length; i++) prevPaths[i].classList.remove('highlight');
			if (prevVertices) for (let i = 0; i < prevVertices.length; i++) prevVertices[i].classList.remove('highlight');
		}
		if (nextBranch !== null) {
			const nextPaths = this.pathElemsByBranch[nextBranch], nextVertices = this.vertexElemsByBranch[nextBranch];
			if (nextPaths) for (let i = 0; i < nextPaths.length; i++) nextPaths[i].classList.add('highlight');
			if (nextVertices) for (let i = 0; i < nextVertices.length; i++) nextVertices[i].classList.add('highlight');
		}
		this.highlightedBranch = nextBranch;
		this.svg.classList.toggle('branchHighlight', nextBranch !== null);
	}


	/* Get */

	public getContentWidth() {
		return 2 * this.config.grid.offsetX + (this.getNumberOfLanes() - 1) * this.config.grid.x;
	}

	/**
	 * Get the width of the graph when its lanes aren't moved closer together to fit within the maximum width.
	 * @returns The width (in pixels).
	 */
	public getNaturalContentWidth() {
		return 2 * this.config.grid.offsetX + (this.getNumberOfLanes() - 1) * this.naturalGridX;
	}

	private getNumberOfLanes() {
		let x = 0, i, p;
		for (i = 0; i < this.vertices.length; i++) {
			p = this.vertices[i].getNextPoint();
			if (p.x > x) x = p.x;
		}
		return x;
	}

	public getHeight(expandedCommit: ExpandedCommit | null) {
		return this.vertices.length * this.config.grid.y + this.config.grid.offsetY - this.config.grid.y / 2 + (expandedCommit !== null ? this.config.grid.expandY : 0);
	}

	public getVertexColours() {
		let colours = [], i;
		for (i = 0; i < this.vertices.length; i++) {
			colours[i] = this.vertices[i].getColour() % this.config.colours.length;
		}
		return colours;
	}

	public getWidthsAtVertices() {
		let widths = [], i;
		for (i = 0; i < this.vertices.length; i++) {
			widths[i] = this.config.grid.offsetX + this.vertices[i].getNextPoint().x * this.config.grid.x - 2;
		}
		return widths;
	}


	/* Graph Queries */

	/**
	 * Determine whether a commit can be dropped.
	 * @param i Index of the commit to test.
	 * @returns TRUE => Commit can be dropped, FALSE => Commit can't be dropped
	 */
	public dropCommitPossible(i: number) {
		if (!this.vertices[i].hasParents()) {
			return false; // No parents
		}

		const isPossible = (v: Vertex): boolean | null => {
			if (v.isMerge()) {
				// Commit is a merge - fails topological test
				return null;
			}

			let children = v.getChildren();
			if (children.length > 1) {
				// Commit has multiple children - fails topological test
				return null;
			} else if (children.length === 1) {
				const recursivelyPossible = isPossible(children[0]);
				if (recursivelyPossible !== false) {
					// Topological tests failed (recursivelyPossible === NULL), or the HEAD has already been found (recursivelyPossible === TRUE)
					return recursivelyPossible;
				}
			}

			// Check if the current vertex is the HEAD if it has no children, or the HEAD has not been found in its recursive children.
			return this.commits[v.id].hash === this.commitHead;
		};

		return isPossible(this.vertices[i]) || false;
	}

	private getAllChildren(i: number) {
		let visited: { [id: string]: number } = {};
		const rec = (vertex: Vertex) => {
			const idStr = vertex.id.toString();
			if (typeof visited[idStr] !== 'undefined') return;

			visited[idStr] = vertex.id;
			let children = vertex.getChildren();
			for (let i = 0; i < children.length; i++) rec(children[i]);
		};
		rec(this.vertices[i]);
		return Object.keys(visited).map((key) => visited[key]).sort((a, b) => a - b);
	}

	public getMutedCommits(currentHash: string | null) {
		const muted = [];
		for (let i = 0; i < this.commits.length; i++) {
			muted[i] = false;
		}

		// Mute any merge commits if the Extension Setting is enabled
		if (this.muteConfig.mergeCommits) {
			for (let i = 0; i < this.commits.length; i++) {
				if (this.vertices[i].isMerge() && this.commits[i].stash === null) {
					// The commit is a merge, and is not a stash
					muted[i] = true;
				}
			}
		}

		// Mute any commits that are not ancestors of the commit head if the Extension Setting is enabled, and the head commit is in the graph
		if (this.muteConfig.commitsNotAncestorsOfHead && currentHash !== null && typeof this.commitLookup[currentHash] === 'number') {
			let ancestor: boolean[] = [];
			for (let i = 0; i < this.commits.length; i++) {
				ancestor[i] = false;
			}

			// Recursively discover ancestors of commit head
			const rec = (vertex: Vertex) => {
				if (vertex.id === NULL_VERTEX_ID || ancestor[vertex.id]) return;
				ancestor[vertex.id] = true;

				let parents = vertex.getParents();
				for (let i = 0; i < parents.length; i++) rec(parents[i]);
			};
			rec(this.vertices[this.commitLookup[currentHash]]);

			for (let i = 0; i < this.commits.length; i++) {
				if (!ancestor[i] && (this.commits[i].stash === null || typeof this.commitLookup[this.commits[i].stash!.baseHash] !== 'number' || !ancestor[this.commitLookup[this.commits[i].stash!.baseHash]])) {
					// Commit i is not an ancestor of currentHash, or a stash based on an ancestor of currentHash
					muted[i] = true;
				}
			}
		}

		return muted;
	}


	/**
	 * Get the index of the first parent of the commit at the specified index.
	 * @param i The index of the commit.
	 * @returns The index of the first parent, or -1 if there is no parent.
	 */
	public getFirstParentIndex(i: number) {
		const parents = this.vertices[i].getParents();
		return parents.length > 0
			? parents[0].id
			: -1;
	}

	/**
	 * Get the index of the alternative parent of the commit at the specified index.
	 * @param i The index of the commit.
	 * @returns The index of the alternative parent, or -1 if there is no parent.
	 */
	public getAlternativeParentIndex(i: number) {
		const parents = this.vertices[i].getParents();
		return parents.length > 1
			? parents[1].id
			: parents.length === 1
				? parents[0].id
				: -1;
	}

	/**
	 * Get the index of the first child of the commit at the specified index.
	 * @param i The index of the commit.
	 * @returns The index of the first child, or -1 if there is no child.
	 */
	public getFirstChildIndex(i: number) {
		const children = this.vertices[i].getChildren();
		if (children.length > 1) {
			// The vertex has multiple children
			const branch = this.vertices[i].getBranch();
			let childOnSameBranch: Vertex | undefined;
			if (branch !== null && (childOnSameBranch = children.find((child) => child.isOnThisBranch(branch)))) {
				// If a child could be found on the same branch as the vertex
				return childOnSameBranch.id;
			} else {
				// No child could be found on the same branch as the vertex
				return Math.max(...children.map((child) => child.id));
			}
		} else if (children.length === 1) {
			// The vertex has a single child
			return children[0].id;
		} else {
			// The vertex has no children
			return -1;
		}
	}

	/**
	 * Get the index of the alternative child of the commit at the specified index.
	 * @param i The index of the commit.
	 * @returns The index of the alternative child, or -1 if there is no child.
	 */
	public getAlternativeChildIndex(i: number) {
		const children = this.vertices[i].getChildren();
		if (children.length > 1) {
			// The vertex has multiple children
			const branch = this.vertices[i].getBranch();
			let childOnSameBranch: Vertex | undefined;
			if (branch !== null && (childOnSameBranch = children.find((child) => child.isOnThisBranch(branch)))) {
				// If a child could be found on the same branch as the vertex
				return Math.max(...children.filter(child => child !== childOnSameBranch).map((child) => child.id));
			} else {
				// No child could be found on the same branch as the vertex
				const childIndexes = children.map((child) => child.id).sort();
				return childIndexes[childIndexes.length - 2];
			}
		} else if (children.length === 1) {
			// The vertex has a single child
			return children[0].id;
		} else {
			// The vertex has no children
			return -1;
		}
	}


	/* Avatars */

	/**
	 * Set how the avatars of the authors are found (they are drawn on the commits when the git-map.graph.nodeStyle Extension Setting is "Avatar").
	 * @param getAvatar Returns the data URI of the avatar of an email address, or NULL if it isn't available.
	 */
	public setAvatarSource(getAvatar: (email: string) => string | null) {
		this.getAvatar = getAvatar;
	}

	/**
	 * Draw an avatar that has been loaded on the commits of its author (replacing their initial).
	 * @param email The email address of the author.
	 * @param image The data URI of the avatar.
	 */
	public loadAvatar(email: string, image: string) {
		const pattern = this.getAvatarPattern(email, image);
		if (this.group === null || pattern === null) return;
		this.group.querySelectorAll<SVGElement>('text.avatarInitial[data-email]').forEach((elem) => {
			if (elem.dataset.email !== email) return;
			const avatarElem = createAvatarElem(elem.getAttribute('x')!, elem.getAttribute('y')!, pattern);
			avatarElem.dataset.branch = elem.dataset.branch;
			avatarElem.dataset.email = email;
			if (elem.classList.contains('highlight')) avatarElem.classList.add('highlight');
			const branchIndex = typeof elem.dataset.branch === 'string' ? parseInt(elem.dataset.branch) : -1;
			if (branchIndex >= 0 && branchIndex < this.vertexElemsByBranch.length) {
				const idx = this.vertexElemsByBranch[branchIndex].indexOf(elem);
				if (idx > -1) this.vertexElemsByBranch[branchIndex][idx] = avatarElem;
			}
			elem.replaceWith(avatarElem);
		});
	}

	/**
	 * Get the pattern of an author's avatar (in the definitions of the graph), creating or updating it if required.
	 * @param email The email address of the author.
	 * @param image The data URI of the avatar, or NULL to use the avatar from the source of avatars.
	 * @returns The id of the pattern, or NULL if the avatar isn't available.
	 */
	private getAvatarPattern(email: string, image: string | null) {
		const avatar = image !== null ? image : this.getAvatar(email);
		if (avatar === null) return null;
		let pattern = this.avatarPatterns[email];
		if (typeof pattern === 'undefined') {
			const patternElem = this.defs.appendChild(document.createElementNS(SVG_NAMESPACE, 'pattern'));
			const id = 'Avatar' + Object.keys(this.avatarPatterns).length;
			patternElem.setAttribute('id', id);
			patternElem.setAttribute('width', '1');
			patternElem.setAttribute('height', '1');
			patternElem.setAttribute('patternContentUnits', 'objectBoundingBox');
			const imageElem = patternElem.appendChild(document.createElementNS(SVG_NAMESPACE, 'image'));
			imageElem.setAttribute('width', '1');
			imageElem.setAttribute('height', '1');
			imageElem.setAttribute('preserveAspectRatio', 'xMidYMid slice');
			pattern = this.avatarPatterns[email] = { id: id, image: imageElem };
		}
		if (pattern.image.getAttribute('href') !== avatar) pattern.image.setAttribute('href', avatar);
		return pattern.id;
	}


	/* Width Adjustment Methods */

	public limitMaxWidth(maxWidth: number) {
		this.maxWidth = maxWidth;
		// When the lanes don't fit within the maximum width, they're moved closer together (to a minimum spacing), so that all of the commits remain visible
		const lanes = this.getNumberOfLanes();
		let gridX = this.naturalGridX;
		if (maxWidth > -1 && lanes > 1 && this.getNaturalContentWidth() > maxWidth) {
			gridX = Math.min(Math.max(Math.floor((maxWidth - 2 * this.config.grid.offsetX) / (lanes - 1) * 10) / 10, this.minGridX), this.naturalGridX);
		}
		if (gridX !== this.config.grid.x) {
			this.config.grid.x = gridX;
			if (this.group !== null) {
				this.render(this.renderedExpandedCommit);
				return;
			}
		}
		this.applyMaxWidth(this.getContentWidth());
	}

	private setDimensions(contentWidth: number, height: number) {
		this.setSvgWidth(contentWidth);
		this.svg.setAttribute('height', height.toString());
		this.maskRect.setAttribute('width', contentWidth.toString());
		this.maskRect.setAttribute('height', height.toString());
	}

	private applyMaxWidth(contentWidth: number) {
		this.setSvgWidth(contentWidth);
		let offset1 = this.maxWidth > -1 ? (this.maxWidth - 12) / contentWidth : 1;
		let offset2 = this.maxWidth > -1 ? this.maxWidth / contentWidth : 1;
		this.gradientStop1.setAttribute('offset', offset1.toString());
		this.gradientStop2.setAttribute('offset', offset2.toString());
	}

	private setSvgWidth(contentWidth: number) {
		let width = this.maxWidth > -1 ? Math.min(contentWidth, this.maxWidth) : contentWidth;
		this.svg.setAttribute('width', width.toString());
	}


	/* Graph Layout Methods */

	private determinePath(startAt: number) {
		let i = startAt;
		let vertex = this.vertices[i], parentVertex = this.vertices[i].getNextParent(), curVertex;
		let lastPoint = vertex.isNotOnBranch() ? vertex.getNextPoint() : vertex.getPoint(), curPoint;

		if (parentVertex !== null && parentVertex.id !== NULL_VERTEX_ID && vertex.isMerge() && !vertex.isNotOnBranch() && !parentVertex.isNotOnBranch()) {
			// Branch is a merge between two vertices already on branches
			let foundPointToParent = false, parentBranch = parentVertex.getBranch()!;
			for (i = startAt + 1; i < this.vertices.length; i++) {
				curVertex = this.vertices[i];
				curPoint = curVertex.getPointConnectingTo(parentVertex, parentBranch); // Check if there is already a point connecting the ith vertex to the required parent
				if (curPoint !== null) {
					foundPointToParent = true; // Parent was found
				} else {
					curPoint = curVertex.getNextPoint(); // Parent couldn't be found, choose the next available point for the vertex
				}
				parentBranch.addLine(lastPoint, curPoint, vertex.getIsCommitted(), !foundPointToParent && curVertex !== parentVertex ? lastPoint.x < curPoint.x : true);
				curVertex.registerUnavailablePoint(curPoint.x, parentVertex, parentBranch);
				lastPoint = curPoint;

				if (foundPointToParent) {
					vertex.registerParentProcessed();
					break;
				}
			}
		} else {
			// Branch is normal
			let branch = new Branch(this.getAvailableColour(startAt), this.branches.length);
			vertex.addToBranch(branch, lastPoint.x);
			vertex.registerUnavailablePoint(lastPoint.x, vertex, branch);
			for (i = startAt + 1; i < this.vertices.length; i++) {
				curVertex = this.vertices[i];
				curPoint = parentVertex === curVertex && !parentVertex.isNotOnBranch() ? curVertex.getPoint() : curVertex.getNextPoint();
				branch.addLine(lastPoint, curPoint, vertex.getIsCommitted(), lastPoint.x < curPoint.x);
				curVertex.registerUnavailablePoint(curPoint.x, parentVertex, branch);
				lastPoint = curPoint;

				if (parentVertex === curVertex) {
					// The parent of <vertex> has been reached, progress <vertex> and <parentVertex> to continue building the branch
					vertex.registerParentProcessed();
					let parentVertexOnBranch = !parentVertex.isNotOnBranch();
					parentVertex.addToBranch(branch, curPoint.x);
					vertex = parentVertex;
					parentVertex = vertex.getNextParent();
					if (parentVertex === null || parentVertexOnBranch) {
						// There are no more parent vertices, or the parent was already on a branch
						break;
					}
				}
			}
			if (i === this.vertices.length && parentVertex !== null && parentVertex.id === NULL_VERTEX_ID) {
				// Vertex is the last in the graph, so no more branch can be formed to the parent
				vertex.registerParentProcessed();
			}
			branch.setEnd(i);
			this.branches.push(branch);
			this.availableColours[branch.getColour()] = i;
		}
	}

	private getAvailableColour(startAt: number) {
		for (let i = 0; i < this.availableColours.length; i++) {
			if (startAt > this.availableColours[i]) {
				return i;
			}
		}
		this.availableColours.push(0);
		return this.availableColours.length - 1;
	}


	/* Vertex Info */

	private vertexOver(vertexElem: SVGElement) {
		this.closeTooltip();

		const id = parseInt(vertexElem.dataset.id!);
		this.tooltipId = id;
		const commitElem = findCommitElemWithId(getCommitElems(), id);
		if (commitElem !== null) commitElem.classList.add(CLASS_GRAPH_VERTEX_ACTIVE);

		if (id < this.commits.length && this.commits[id].hash !== UNCOMMITTED) { // Only show tooltip for commits (not the uncommitted changes)
			this.tooltipTimeout = setTimeout(() => {
				this.tooltipTimeout = null;
				let vertexScreenY = vertexElem.getBoundingClientRect().top + 4; // Get center of the circle
				if (vertexScreenY >= 5 && vertexScreenY <= this.viewElem.clientHeight - 5) {
					// Vertex is completely visible on the screen (not partially off)
					this.tooltipVertex = vertexElem;
					closeDialogAndContextMenu();
					this.showTooltip(id, vertexScreenY);
				}
			}, 100);
		}
	}

	private showTooltip(id: number, vertexScreenY: number) {
		if (this.tooltipVertex !== null) {
			this.tooltipVertex.setAttribute('r', this.tooltipVertex.classList.contains('stashOuter') ? '5.5' : '5');
		}

		const children = this.getAllChildren(id);
		let heads: string[] = [], remotes: GG.GitCommitRemote[] = [], stashes: string[] = [], tags: string[] = [], childrenIncludesHead = false;
		for (let i = 0; i < children.length; i++) {
			let commit = this.commits[children[i]];
			for (let j = 0; j < commit.heads.length; j++) heads.push(commit.heads[j]);
			for (let j = 0; j < commit.remotes.length; j++) remotes.push(commit.remotes[j]);
			for (let j = 0; j < commit.tags.length; j++) tags.push(commit.tags[j].name);
			if (commit.stash !== null) stashes.push(commit.stash.selector.substring(5));
			if (commit.hash === this.commitHead) childrenIncludesHead = true;
		}

		const getLimitedRefs = (htmlRefs: string[]) => {
			if (htmlRefs.length > 10) htmlRefs.splice(5, htmlRefs.length - 10, ' ' + ELLIPSIS + ' ');
			return htmlRefs.join('');
		};

		let html = '<div class="graphTooltipTitle">' + t('Commit {0}', abbrevCommit(this.commits[id].hash)) + '</div>';
		if (this.commitHead !== null && typeof this.commitLookup[this.commitHead] === 'number') {
			html += '<div class="graphTooltipSection">' + (childrenIncludesHead ? t('This commit is included in {0}', '<span class="graphTooltipRef">HEAD</span>') : t('This commit is <b><i>not</i></b> included in {0}', '<span class="graphTooltipRef">HEAD</span>')) + '</div>';
		}
		if (heads.length > 0 || remotes.length > 0) {
			let branchLabels = getBranchLabels(heads, remotes), htmlRefs: string[] = [];
			branchLabels.heads.forEach((head) => {
				let html = head.remotes.reduce((prev, remote) => prev + '<span class="graphTooltipCombinedRef">' + escapeHtml(remote) + '</span>', '');
				htmlRefs.push('<span class="graphTooltipRef">' + escapeHtml(head.name) + html + '</span>');
			});
			branchLabels.remotes.forEach((remote) => htmlRefs.push('<span class="graphTooltipRef">' + escapeHtml(remote.name) + '</span>'));
			html += '<div class="graphTooltipSection">' + t('Branches:') + ' ' + getLimitedRefs(htmlRefs) + '</div>';
		}
		if (tags.length > 0) {
			let htmlRefs = tags.map((tag) => '<span class="graphTooltipRef">' + escapeHtml(tag) + '</span>');
			html += '<div class="graphTooltipSection">' + t('Tags:') + ' ' + getLimitedRefs(htmlRefs) + '</div>';
		}
		if (stashes.length > 0) {
			let htmlRefs = stashes.map((stash) => '<span class="graphTooltipRef">' + escapeHtml(stash) + '</span>');
			html += '<div class="graphTooltipSection">' + t('Stashes:') + ' ' + getLimitedRefs(htmlRefs) + '</div>';
		}

		const point = this.vertices[id].getPoint(), color = 'var(--git-graph-color' + (this.vertices[id].getColour() % this.config.colours.length) + ')';
		const anchor = document.createElement('div'), pointer = document.createElement('div'), content = document.createElement('div'), shadow = document.createElement('div');
		const pixel: Pixel = {
			x: point.x * this.config.grid.x + this.config.grid.offsetX,
			y: point.y * this.config.grid.y + this.config.grid.offsetY + (this.expandedCommitIndex > -1 && id > this.expandedCommitIndex ? this.config.grid.expandY : 0)
		};

		anchor.setAttribute('id', 'graphTooltip');
		anchor.style.opacity = '0';
		pointer.setAttribute('id', 'graphTooltipPointer');
		pointer.style.backgroundColor = color;
		content.setAttribute('id', 'graphTooltipContent');
		content.style.borderColor = color;
		content.innerHTML = html;
		content.style.maxWidth = Math.min(this.contentElem.getBoundingClientRect().width - pixel.x - 35, 600) + 'px'; // Tooltip Offset [23px] + Tooltip Border [2 * 2px] + Right Page Margin [8px] = 35px
		shadow.setAttribute('id', 'graphTooltipShadow');
		anchor.appendChild(shadow);
		anchor.appendChild(pointer);
		anchor.appendChild(content);
		anchor.style.left = pixel.x + 'px';
		anchor.style.top = pixel.y + 'px';
		this.contentElem.appendChild(anchor);
		this.tooltipElem = anchor;

		let tooltipRect = content.getBoundingClientRect();
		let relativeOffset = -tooltipRect.height / 2; // Center the tooltip vertically on the vertex
		if (vertexScreenY + relativeOffset + tooltipRect.height > this.viewElem.clientHeight - 4) {
			// Not enough height below the vertex to fit the vertex, shift it up.
			relativeOffset = (this.viewElem.clientHeight - vertexScreenY - 4) - tooltipRect.height;
		}
		if (vertexScreenY + relativeOffset < 4) {
			// Not enough height above the vertex to fit the tooltip, shift it down.
			relativeOffset = -vertexScreenY + 4;
		}
		pointer.style.top = (-relativeOffset) + 'px';
		anchor.style.top = (pixel.y + relativeOffset) + 'px';
		shadow.style.width = tooltipRect.width + 'px';
		shadow.style.height = tooltipRect.height + 'px';
		anchor.style.opacity = '1';
	}

	private closeTooltip() {
		if (this.tooltipId > -1) {
			const commitElem = findCommitElemWithId(getCommitElems(), this.tooltipId);
			if (commitElem !== null) commitElem.classList.remove(CLASS_GRAPH_VERTEX_ACTIVE);
			this.tooltipId = -1;
		}

		if (this.tooltipElem !== null) {
			this.tooltipElem.remove();
			this.tooltipElem = null;
		}

		if (this.tooltipTimeout !== null) {
			clearTimeout(this.tooltipTimeout);
			this.tooltipTimeout = null;
		}

		if (this.tooltipVertex !== null) {
			this.tooltipVertex.setAttribute('r', this.tooltipVertex.classList.contains('stashOuter') ? '4.5' : '4');
			this.tooltipVertex = null;
		}
	}
}
