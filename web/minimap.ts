const MINIMAP_MAX_BARS = 120;
const MINIMAP_MIN_DAYS = 30; // The minimum number of days shown when the minimap isn't zoomed in
const MINIMAP_MIN_ZOOM_DAYS = 7; // The minimum number of days shown when the minimap is zoomed in
const MINIMAP_ZOOM_STEP = 1.6; // The factor the number of days shown changes by when the zoom buttons are clicked
const MINIMAP_AXIS_LABEL_SPACING = 96; // The minimum space (in pixels) between the labels of the axis
const MINIMAP_DEFAULT_HEIGHT = 58;
const MINIMAP_MIN_HEIGHT = 46;
const MINIMAP_MAX_HEIGHT = 240;
const MINIMAP_DRAG_THRESHOLD = 3; // The distance (in pixels) the mouse must move for a click to become a drag
const SECONDS_PER_DAY = 86400;

const MINIMAP_ICONS = {
	zoomIn: '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M8 3v10M3 8h10"/></svg>',
	zoomOut: '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M3 8h10"/></svg>',
	showAll: '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10"/></svg>',
	searchRange: '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/></svg>'
};

const enum MinimapPeriod {
	Day,
	Week,
	Month,
	Year
}

interface MinimapBucket {
	readonly start: number; // The local day number of the start of the bucket
	count: number;
	firstIndex: number; // The index of the newest commit in the bucket
}

interface MinimapMarker {
	readonly bucket: number;
	readonly kind: 'head' | 'branch' | 'tag';
	readonly colour: string;
	readonly title: string;
}

interface MinimapRange {
	readonly start: number; // The local day number of the start of the range (inclusive, can be fractional)
	readonly end: number; // The local day number of the end of the range (exclusive, can be fractional)
}

interface MinimapData {
	readonly commits: ReadonlyArray<GG.GitCommit>;
	readonly commitHead: string | null;
	readonly vertexColours: ReadonlyArray<number>;
	readonly colours: ReadonlyArray<string>;
}

/**
 * Implements the Minimap of the Git Map View: the number of loaded commits each day (or week / month / year when the commits span a long
 * time), where HEAD, branches & tags are, and the commits that are currently in view. Clicking on a bar scrolls to its commits, and
 * dragging the box of the commits in view scrolls the view. The minimap can be zoomed in on a range of dates (with the zoom buttons, or
 * Ctrl / Cmd + scrolling or pinching) and panned when it's zoomed in (by dragging it, or scrolling horizontally), and its height can be
 * changed by dragging its bottom edge.
 */
class Minimap {
	private readonly elem: HTMLElement;
	private readonly onClick: (commitIndex: number) => void;
	private readonly onScrollTo: (commitIndex: number) => void;
	private readonly onSearchRange: (after: string, before: string) => void;
	private data: MinimapData | null = null;
	private commitDays: number[] = [];
	private fullRange: MinimapRange = { start: 0, end: 0 };
	private range: MinimapRange | null = null; // The range of days that is zoomed in on, or NULL if all of the loaded commits are shown
	private buckets: MinimapBucket[] = [];
	private period: MinimapPeriod = MinimapPeriod.Day;
	private firstBucketKey: number = 0;
	private chartElem: HTMLElement | null = null;
	private viewportElem: HTMLElement | null = null;
	private barElems: HTMLElement[] = [];
	private lastViewportKey: string = '';
	private viewport: { first: number, last: number } | null = null; // The indices of the first & last commits in view
	private axisWidth: number = -1;
	private findMatches: ReadonlySet<string> = new Set(); // The hashes of the commits that match the Find Widget's criteria
	private renderChartFrame: number | null = null;
	private lastDragEnd: number = 0; // When a drag (or a click handled as part of one) last ended
	private lastResizeClick: number = 0; // When the bottom edge was last clicked (without being dragged)

	/**
	 * Construct a new Minimap instance.
	 * @param elem The HTML Element that the minimap is rendered in.
	 * @param onClick A callback invoked with the index of the newest commit of the bar that was clicked.
	 * @param onScrollTo A callback invoked with the index of the commit that should be scrolled to the top of the view, as the box of the
	 * commits in view is dragged.
	 * @param onSearchRange A callback invoked with the first day of the range of dates that is zoomed in on, and the day after it
	 * (YYYY-MM-DD), to search for the commits in it.
	 */
	constructor(elem: HTMLElement, onClick: (commitIndex: number) => void, onScrollTo: (commitIndex: number) => void, onSearchRange: (after: string, before: string) => void) {
		this.elem = elem;
		this.onClick = onClick;
		this.onScrollTo = onScrollTo;
		this.onSearchRange = onSearchRange;
		this.setHeight(typeof globalState.minimapHeight === 'number' ? globalState.minimapHeight : MINIMAP_DEFAULT_HEIGHT);

		this.elem.addEventListener('click', (e) => {
			const zoomBtn = e.target instanceof Element ? <HTMLElement | null>e.target.closest('.minimapZoomBtn') : null;
			if (zoomBtn !== null) {
				if (!zoomBtn.classList.contains(CLASS_DISABLED)) this.zoomWithButton(zoomBtn.dataset.zoom!);
			} else if (performance.now() - this.lastDragEnd > 300) {
				// A mouse button released after dragging (or after a click that was already handled when it was released) isn't a click
				this.clickAt(e.target, e.clientX, e.clientY);
			}
		});
		this.elem.addEventListener('mousedown', (e) => this.startDrag(e));
		this.elem.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });

		// The labels of the axis depend on the width of the minimap
		new ResizeObserver(() => {
			if (this.chartElem !== null && this.chartElem.clientWidth !== this.axisWidth) this.renderAxis();
		}).observe(this.elem);
	}

	/**
	 * Render the minimap for the loaded commits. The range of dates that is zoomed in on is kept (within the dates of the loaded commits).
	 * @param commits The loaded commits.
	 * @param commitHead The hash of the commit referenced by HEAD.
	 * @param vertexColours The colour index of each commit's vertex on the graph.
	 * @param colours The colours of the graph.
	 * @param enabled Is the minimap enabled (the `git-map.graph.minimap` Extension Setting).
	 */
	public render(commits: ReadonlyArray<GG.GitCommit>, commitHead: string | null, vertexColours: ReadonlyArray<number>, colours: ReadonlyArray<string>, enabled: boolean) {
		this.commitDays = commits.map((commit) => Minimap.getLocalDay(commit.date));
		const days = this.commitDays.filter((_, i) => commits[i].hash !== UNCOMMITTED);
		alterClass(this.elem, 'active', enabled && days.length > 0);
		if (!enabled || days.length === 0) {
			this.data = null;
			this.buckets = [];
			this.chartElem = null;
			this.viewportElem = null;
			this.barElems = [];
			this.lastViewportKey = '';
			this.elem.innerHTML = '';
			return;
		}

		this.data = { commits: commits, commitHead: commitHead, vertexColours: vertexColours, colours: colours };
		const newestDay = Math.max.apply(null, days), oldestDay = Math.min.apply(null, days);
		this.fullRange = { start: Math.min(oldestDay, newestDay + 1 - MINIMAP_MIN_DAYS), end: newestDay + 1 };
		if (this.range !== null) this.range = this.clampRange(this.range.start, this.range.end - this.range.start);
		this.renderChart();
	}

	/**
	 * Show all of the loaded commits on the minimap (e.g. when a different repository is loaded).
	 */
	public resetZoom() {
		this.range = null;
	}

	/**
	 * Set the commits that match the Find Widget's criteria, which are marked below their bars.
	 * @param hashes The hashes of the matching commits.
	 */
	public setFindMatches(hashes: ReadonlyArray<string>) {
		if (hashes.length === this.findMatches.size && hashes.every((hash) => this.findMatches.has(hash))) return;
		this.findMatches = new Set(hashes);
		this.scheduleRender();
	}

	/**
	 * Render the minimap in the next frame (so that it's rendered at most once each frame while it's zoomed, panned or dragged).
	 */
	private scheduleRender() {
		if (this.renderChartFrame !== null || this.data === null) return;
		this.renderChartFrame = requestAnimationFrame(() => {
			this.renderChartFrame = null;
			this.renderChart();
		});
	}

	/**
	 * Cancel the rendering of the minimap that's scheduled for the next frame (as it's rendered now).
	 */
	private cancelScheduledRender() {
		if (this.renderChartFrame === null) return;
		cancelAnimationFrame(this.renderChartFrame);
		this.renderChartFrame = null;
	}

	/**
	 * Render the bars, markers & axis of the range of dates that is shown.
	 */
	private renderChart() {
		const data = this.data;
		if (data === null) return;
		// The range can be fractional (as it's panned), but the bars are whole days
		this.cancelScheduledRender();
		const range = this.range !== null ? this.range : this.fullRange;
		const startDay = Math.round(range.start), endDay = startDay + Math.round(range.end - range.start) - 1;

		// Each bar is a day, week, month or year, so that there are at most MINIMAP_MAX_BARS bars
		const numDays = endDay - startDay + 1;
		this.period = numDays <= MINIMAP_MAX_BARS ? MinimapPeriod.Day
			: numDays <= MINIMAP_MAX_BARS * 7 ? MinimapPeriod.Week
				: Minimap.getMonthKey(endDay) - Minimap.getMonthKey(startDay) < MINIMAP_MAX_BARS ? MinimapPeriod.Month : MinimapPeriod.Year;
		this.firstBucketKey = this.getBucketKey(startDay);
		const numBuckets = this.getBucketKey(endDay) - this.firstBucketKey + 1;
		this.buckets = [];
		for (let i = 0; i < numBuckets; i++) {
			this.buckets.push({ start: this.getBucketStart(this.firstBucketKey + i), count: 0, firstIndex: -1 });
		}

		const markers: MinimapMarker[] = [], markedBuckets: { [key: string]: boolean } = {};
		const addMarker = (marker: MinimapMarker) => {
			const key = marker.bucket + marker.kind + marker.colour;
			if (!markedBuckets[key]) {
				markedBuckets[key] = true;
				markers.push(marker);
			}
		};
		const commits = data.commits, colours = data.colours, findMatches: number[] = this.buckets.map(() => 0);
		for (let i = 0; i < commits.length; i++) {
			if (commits[i].hash === UNCOMMITTED) continue;
			const bucketIndex = this.getBucketIndex(this.commitDays[i]), bucket = this.buckets[bucketIndex];
			if (typeof bucket === 'undefined') continue;
			bucket.count++;
			if (bucket.firstIndex === -1) bucket.firstIndex = i;
			if (this.findMatches.has(commits[i].hash)) findMatches[bucketIndex]++;

			if (commits[i].hash === data.commitHead) {
				addMarker({ bucket: bucketIndex, kind: 'head', colour: 'var(--vscode-focusBorder)', title: 'HEAD' });
			}
			if (commits[i].heads.length > 0 || commits[i].remotes.length > 0) {
				addMarker({ bucket: bucketIndex, kind: 'branch', colour: colours[data.vertexColours[i] % colours.length], title: commits[i].heads.concat(commits[i].remotes.map((remote) => remote.name)).join(', ') });
			}
			if (commits[i].tags.length > 0) {
				addMarker({ bucket: bucketIndex, kind: 'tag', colour: 'var(--vscode-descriptionForeground)', title: commits[i].tags.map((tag) => tag.name).join(', ') });
			}
		}

		const maxCount = Math.max(1, Math.max.apply(null, this.buckets.map((bucket) => bucket.count)));
		const left = (bucketIndex: number) => ((bucketIndex + 0.5) / this.buckets.length * 100).toFixed(3) + '%';
		const unit = this.period === MinimapPeriod.Day ? t('Commits per day') : this.period === MinimapPeriod.Week ? t('Commits per week') : this.period === MinimapPeriod.Month ? t('Commits per month') : t('Commits per year');
		const zoomedIn = this.range !== null, canZoomIn = range.end - range.start > MINIMAP_MIN_ZOOM_DAYS;
		const zoomBtn = (zoom: string, title: string, icon: string, enabled: boolean) => '<button type="button" class="minimapZoomBtn' + (enabled ? '' : ' ' + CLASS_DISABLED) + '" data-zoom="' + zoom + '" title="' + title + '" aria-label="' + title + '" aria-disabled="' + !enabled + '">' + icon + '</button>';
		const barWidth = 100 / this.buckets.length, hasFindMatches = findMatches.some((count) => count > 0);
		const modifier = /Mac/.test(navigator.platform) ? '⌘' : 'Ctrl';
		this.elem.innerHTML = '<div class="minimapTitle"><div class="minimapTitleRow"><span>' + t('Activity') + '</span><span class="minimapZoom">'
			+ zoomBtn('out', t('Zoom Out'), MINIMAP_ICONS.zoomOut, zoomedIn)
			+ zoomBtn('in', t('Zoom In'), MINIMAP_ICONS.zoomIn, canZoomIn)
			+ zoomBtn('all', t('Show All Loaded Commits'), MINIMAP_ICONS.showAll, zoomedIn)
			+ zoomBtn('search', t('Search for the Commits in this Range of Dates'), MINIMAP_ICONS.searchRange, zoomedIn)
			+ '</span></div><span class="minimapUnit">' + unit + '</span></div>'
			+ '<div class="minimapChart' + (zoomedIn ? ' zoomedIn' : '') + '" title="' + escapeHtml(t('{0} + scroll (or pinch) to zoom in on a range of dates.', modifier) + (zoomedIn ? ' ' + t('Drag to pan.') : '')) + '">'
			+ '<div class="minimapMarkers">' + markers.map((marker) => '<span class="minimapMarker ' + marker.kind + '" style="left:' + left(marker.bucket) + ';background-color:' + escapeHtml(marker.colour) + '" title="' + escapeHtml(marker.title) + '"></span>').join('') + '</div>'
			+ '<div class="minimapBars' + (this.buckets.length > 60 ? ' thin' : '') + '">' + this.buckets.map((bucket, i) => '<span class="minimapBar' + (bucket.count > 0 ? '' : ' empty') + '" data-index="' + i + '" title="' + escapeHtml(this.getBucketLabel(bucket, false) + ': ' + (bucket.count !== 1 ? t('{0} commits', bucket.count) : t('{0} commit', bucket.count))) + '" style="height:' + (bucket.count > 0 ? 'max(3px, ' + (100 * Math.sqrt(bucket.count / maxCount)).toFixed(1) + '%)' : '1px') + '"></span>').join('') + '</div>'
			+ '<div class="minimapFindMatches">' + findMatches.map((count, i) => count > 0 ? '<span class="minimapFindMatch" style="left:' + (i * barWidth).toFixed(3) + '%;width:' + barWidth.toFixed(3) + '%" title="' + escapeHtml(this.getBucketLabel(this.buckets[i], false) + ': ' + (count !== 1 ? t('{0} matching commits', count) : t('{0} matching commit', count))) + '"></span>' : '').join('') + '</div>'
			+ '<div id="minimapViewport"></div>'
			+ '<div class="minimapAxis"></div>'
			+ '</div>'
			+ '<div class="minimapLegend"><span><i class="viewport"></i>' + t('In view') + '</span><span><i class="minimapMarker head"></i>HEAD</span><span><i class="minimapMarker branch" style="background-color:' + escapeHtml(colours[1 % colours.length]) + '"></i>' + t('Branches') + '</span><span><i class="minimapMarker tag"></i>' + t('Tags') + '</span>' + (hasFindMatches ? '<span><i class="findMatch"></i>' + t('Find Matches') + '</span>' : '') + '</div>'
			+ '<div class="minimapResize" title="' + t('Drag to resize the minimap, double-click to reset its height') + '"></div>';
		this.chartElem = <HTMLElement>this.elem.querySelector('.minimapChart');
		this.viewportElem = document.getElementById('minimapViewport');
		this.barElems = Array.from(this.elem.querySelectorAll<HTMLElement>('.minimapBar'));
		this.lastViewportKey = '';
		this.renderAxis();
		if (this.viewport !== null) this.setViewport(this.viewport.first, this.viewport.last, false);
	}

	/**
	 * Render the labels of the axis: evenly spaced bars (counting back from the newest), as many as fit in the width of the minimap. The
	 * year is only included in a label when it's different to the year of the previous label.
	 */
	private renderAxis() {
		const axisElem = this.chartElem !== null ? this.chartElem.querySelector('.minimapAxis') : null;
		if (axisElem === null || this.buckets.length === 0) return;
		this.axisWidth = this.chartElem!.clientWidth;
		const lastIndex = this.buckets.length - 1, currentYear = new Date().getFullYear();
		const getYear = (index: number) => new Date(this.buckets[index].start * SECONDS_PER_DAY * 1000).getUTCFullYear();
		const getLabel = (index: number, prevIndex: number) => this.getBucketLabel(this.buckets[index], true, prevIndex === -1
			? getYear(index) !== currentYear || this.period === MinimapPeriod.Month
			: getYear(index) !== getYear(prevIndex));

		// The labels are spaced far enough apart for the longest label (estimating the width of each character)
		const estimateWidth = (label: string) => label.split('').reduce((width, char) => width + (char.charCodeAt(0) > 0x2E7F ? 10.5 : 6.2), 0);
		const longest = Math.max(estimateWidth(getLabel(0, -1)), estimateWidth(getLabel(lastIndex, -1)));
		const maxLabels = Math.max(2, Math.floor(this.axisWidth / Math.max(MINIMAP_AXIS_LABEL_SPACING, longest * 1.5 + 12)) + 1);
		const step = Math.max(1, Math.ceil(lastIndex / (maxLabels - 1)));
		const indexes: number[] = [];
		for (let index = lastIndex; index >= 0; index -= step) indexes.unshift(index);
		// The oldest bar is always labelled (instead of the oldest label counting back from the newest bar, which would be too close to it)
		indexes[0] = 0;

		axisElem.innerHTML = indexes.map((index, i) => {
			// The first & last labels are aligned to the edges of the minimap, and the others are centred below their bar
			const position = i === 0 ? 'left:0' : i === indexes.length - 1 ? 'right:0' : 'left:' + ((index + 0.5) / this.buckets.length * 100).toFixed(3) + '%;transform:translateX(-50%)';
			return '<span style="' + position + '">' + escapeHtml(getLabel(index, i > 0 ? indexes[i - 1] : -1)) + '</span>';
		}).join('');
	}

	/**
	 * Show which commits are currently in view on the minimap.
	 * @param firstIndex The index of the first commit in view.
	 * @param lastIndex The index of the last commit in view.
	 * @param follow Should the minimap be panned (when it's zoomed in) if none of the commits in view are in the range of dates shown.
	 */
	public setViewport(firstIndex: number, lastIndex: number, follow: boolean = true) {
		if (firstIndex < 0 || lastIndex < firstIndex || lastIndex >= this.commitDays.length) return;
		this.viewport = { first: firstIndex, last: lastIndex };
		if (this.viewportElem === null || this.buckets.length === 0) return;

		// The commits aren't always in date order (e.g. topological order), so the newest & oldest dates of the commits in view are found
		let newestDay = this.commitDays[firstIndex], oldestDay = newestDay;
		for (let i = firstIndex + 1; i <= lastIndex; i++) {
			newestDay = Math.max(newestDay, this.commitDays[i]);
			oldestDay = Math.min(oldestDay, this.commitDays[i]);
		}
		let newestBucket = this.getBucketIndex(newestDay), oldestBucket = this.getBucketIndex(oldestDay);
		const lastBucket = this.buckets.length - 1;
		if (newestBucket < 0 || oldestBucket > lastBucket) {
			if (follow && this.range !== null) {
				// Pan the minimap to the commits in view
				const span = this.range.end - this.range.start;
				this.range = this.clampRange(newestBucket < 0 ? newestDay + 1 - span : oldestDay, span);
				this.scheduleRender();
			} else {
				this.viewportElem.style.display = 'none';
				this.lastViewportKey = 'hidden';
				for (let i = 0; i < this.barElems.length; i++) this.barElems[i].classList.remove('visible');
			}
			return;
		}

		newestBucket = Math.min(newestBucket, lastBucket);
		oldestBucket = Math.max(oldestBucket, 0);
		const count = lastIndex - firstIndex + 1, key = oldestBucket + ':' + newestBucket + ':' + count;
		if (key === this.lastViewportKey) return;
		this.lastViewportKey = key;
		this.viewportElem.style.display = '';
		this.viewportElem.style.left = (oldestBucket / this.buckets.length * 100).toFixed(3) + '%';
		this.viewportElem.style.width = ((newestBucket - oldestBucket + 1) / this.buckets.length * 100).toFixed(3) + '%';
		const oldest = this.getBucketLabel(this.buckets[oldestBucket], false), newest = this.getBucketLabel(this.buckets[newestBucket], false);
		this.viewportElem.title = t('The commits in view: {0}', (oldest === newest ? oldest : oldest + ' – ' + newest) + ' (' + (count !== 1 ? t('{0} commits', count) : t('{0} commit', count)) + ')') + '\n' + t('Drag to scroll through the commits.');
		for (let i = 0; i < this.barElems.length; i++) alterClass(this.barElems[i], 'visible', i >= oldestBucket && i <= newestBucket);
	}


	/* Zooming & Panning */

	/**
	 * Get a range of dates that is within the dates of the loaded commits.
	 * @param start The start of the range.
	 * @param span The number of days in the range.
	 * @returns The range, or NULL if the range includes all of the loaded commits.
	 */
	private clampRange(start: number, span: number): MinimapRange | null {
		const fullSpan = this.fullRange.end - this.fullRange.start;
		if (span >= fullSpan) return null;
		span = Math.max(span, Math.min(MINIMAP_MIN_ZOOM_DAYS, fullSpan));
		start = Math.min(Math.max(start, this.fullRange.start), this.fullRange.end - span);
		return { start: start, end: start + span };
	}

	/**
	 * Get the date at a horizontal position on the minimap.
	 * @param fraction The position, as a fraction of the width of the minimap (can be outside of 0 - 1).
	 * @returns The local day number (fractional).
	 */
	private getDayAt(fraction: number) {
		const start = this.buckets[0].start, end = this.getBucketStart(this.firstBucketKey + this.buckets.length);
		return start + fraction * (end - start);
	}

	/**
	 * Zoom in or out, keeping the date at a position on the minimap in the same place.
	 * @param factor The factor to multiply the number of days shown by (< 1 zooms in, > 1 zooms out).
	 * @param fraction The position, as a fraction of the width of the minimap.
	 */
	private zoom(factor: number, fraction: number) {
		if (this.data === null || this.buckets.length === 0) return;
		const current = this.range !== null ? this.range : this.fullRange, span = current.end - current.start;
		const day = this.getDayAt(fraction), relative = Math.min(Math.max((day - current.start) / span, 0), 1);
		const newSpan = span * factor;
		const range = this.clampRange(day - relative * newSpan, newSpan);
		if (range === null && this.range === null) return;
		if (range !== null && this.range !== null && Math.abs(range.start - this.range.start) < 1e-6 && Math.abs(range.end - this.range.end) < 1e-6) return;
		this.range = range;
		this.scheduleRender();
	}

	/**
	 * Zoom in or out with one of the zoom buttons, around the commits in view (if they're shown), or the centre of the minimap.
	 * @param zoom The zoom button: "in", "out" or "all".
	 */
	private zoomWithButton(zoom: string) {
		if (zoom === 'all') {
			this.range = null;
			this.scheduleRender();
			return;
		} else if (zoom === 'search') {
			if (this.range !== null) {
				const startDay = Math.round(this.range.start), endDay = startDay + Math.round(this.range.end - this.range.start);
				this.onSearchRange(Minimap.formatDay(startDay), Minimap.formatDay(endDay));
			}
			return;
		}
		let fraction = 0.5;
		if (this.viewportElem !== null && this.viewportElem.style.display !== 'none' && this.chartElem !== null) {
			const chartRect = this.chartElem.getBoundingClientRect(), viewportRect = this.viewportElem.getBoundingClientRect();
			if (chartRect.width > 0) fraction = (viewportRect.left + viewportRect.width / 2 - chartRect.left) / chartRect.width;
		}
		this.zoom(zoom === 'in' ? 1 / MINIMAP_ZOOM_STEP : MINIMAP_ZOOM_STEP, fraction);
	}

	/**
	 * Pan the minimap (when it's zoomed in).
	 * @param days The number of days to move the range of dates shown by (positive => later dates).
	 */
	private pan(days: number) {
		if (this.range === null) return;
		const range = this.clampRange(this.range.start + days, this.range.end - this.range.start);
		if (range === null || Math.abs(range.start - this.range.start) < 1e-6) return;
		this.range = range;
		this.scheduleRender();
	}

	/**
	 * Zoom (Ctrl / Cmd + scroll, or pinch) or pan (scroll horizontally when zoomed in) the minimap with the mouse wheel or trackpad.
	 * Scrolling vertically without a modifier scrolls the view as usual.
	 * @param e The wheel event.
	 */
	private onWheel(e: WheelEvent) {
		if (this.data === null || this.chartElem === null || this.buckets.length === 0) return;
		const chartRect = this.chartElem.getBoundingClientRect();
		if (chartRect.width === 0) return;
		const toPixels = (delta: number) => e.deltaMode === WheelEvent.DOM_DELTA_LINE ? delta * 32 : e.deltaMode === WheelEvent.DOM_DELTA_PAGE ? delta * chartRect.width : delta;
		if (e.ctrlKey || e.metaKey) {
			e.preventDefault();
			this.zoom(Math.exp(toPixels(e.deltaY) * 0.0025), (e.clientX - chartRect.left) / chartRect.width);
		} else if (this.range !== null && (Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.shiftKey)) {
			e.preventDefault();
			const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
			this.pan(toPixels(delta) / chartRect.width * (this.getDayAt(1) - this.getDayAt(0)));
		}
	}


	/* Clicking & Dragging */

	/**
	 * Scroll to the commits of the bar at a position on the minimap.
	 * @param target The element that was clicked.
	 * @param clientX The horizontal position.
	 * @param clientY The vertical position.
	 */
	private clickAt(target: EventTarget | null, clientX: number, clientY: number) {
		// The box of the commits in view is above the bars, so the bar below a click on it is found
		const barTarget = target instanceof Element ? <HTMLElement | null>target.closest('.minimapBar') : null;
		const barElem = barTarget !== null ? barTarget : <HTMLElement | undefined>document.elementsFromPoint(clientX, clientY).find((elem) => elem.classList.contains('minimapBar'));
		if (typeof barElem === 'undefined' || typeof barElem.dataset.index !== 'string') return;
		const bucket = this.buckets[parseInt(barElem.dataset.index)];
		if (typeof bucket !== 'undefined' && bucket.count > 0) this.onClick(bucket.firstIndex);
	}

	/**
	 * Start dragging: the bottom edge of the minimap (resizing it), the box of the commits in view (scrolling the view), or the minimap when
	 * it's zoomed in (panning it). A mouse button that's released without moving is a click.
	 * @param e The mousedown event.
	 */
	private startDrag(e: MouseEvent) {
		if (e.button !== 0 || !(e.target instanceof Element) || this.chartElem === null) return;
		if (e.target.closest('.minimapResize') !== null) {
			this.startResize(e);
			return;
		}
		const onViewport = e.target.closest('#minimapViewport') !== null;
		if (e.target.closest('.minimapChart') === null || (!onViewport && this.range === null)) return;
		e.preventDefault();

		const target = e.target, startX = e.clientX, startY = e.clientY;
		const grabOffset = onViewport ? this.viewportElem!.getBoundingClientRect().right - startX : 0;
		let dragging = false, prevX = startX;
		const move: EventListener = (event) => {
			const mouseEvent = <MouseEvent>event;
			if (!dragging) {
				if (Math.abs(mouseEvent.clientX - startX) < MINIMAP_DRAG_THRESHOLD) return;
				dragging = true;
				alterClass(this.elem, 'dragging', true);
			}
			if (this.chartElem === null || this.buckets.length === 0) return;
			const chartRect = this.chartElem.getBoundingClientRect();
			if (chartRect.width === 0) return;
			if (onViewport) {
				// The right edge of the box (the newest commit in view) follows the mouse, panning the minimap when it's dragged past its edges
				const fraction = (mouseEvent.clientX + grabOffset - chartRect.left) / chartRect.width;
				if (this.range !== null && (fraction < 0 || fraction > 1)) {
					const day = this.getDayAt(fraction);
					this.pan(fraction < 0 ? day - this.range.start : day - this.range.end);
					this.scrollToDay(Math.min(Math.max(day, this.fullRange.start), this.fullRange.end));
				} else {
					this.scrollToDay(this.getDayAt(Math.min(Math.max(fraction, 0), 1)));
				}
			} else {
				this.pan((prevX - mouseEvent.clientX) / chartRect.width * (this.getDayAt(1) - this.getDayAt(0)));
			}
			prevX = mouseEvent.clientX;
		};
		const stop: EventListener = () => {
			eventOverlay.remove();
			alterClass(this.elem, 'dragging', false);
			if (!dragging) this.clickAt(target, startX, startY);
			this.lastDragEnd = performance.now();
		};
		eventOverlay.create('grabbing', move, stop);
	}

	/**
	 * Scroll the view to the newest commit on or before a date.
	 * @param day The local day number (fractional).
	 */
	private scrollToDay(day: number) {
		if (this.data === null) return;
		for (let i = 0; i < this.commitDays.length; i++) {
			if (this.commitDays[i] < day) {
				this.onScrollTo(i);
				return;
			}
		}
		this.onScrollTo(this.commitDays.length - 1);
	}

	/**
	 * Start resizing the minimap by dragging its bottom edge (the height is remembered for all repositories). Double-clicking the bottom
	 * edge resets the height.
	 * @param e The mousedown event.
	 */
	private startResize(e: MouseEvent) {
		e.preventDefault();
		const startY = e.clientY, startHeight = this.elem.offsetHeight;
		let height = startHeight, moved = false;
		eventOverlay.create('rowResize', (event) => {
			moved = true;
			height = this.setHeight(startHeight + (<MouseEvent>event).clientY - startY);
		}, () => {
			eventOverlay.remove();
			// The overlay receives the clicks while resizing, so a double-click is detected here
			const now = performance.now();
			if (moved) {
				if (height !== startHeight) updateGlobalViewState('minimapHeight', height);
			} else if (now - this.lastResizeClick < 400) {
				this.setHeight(MINIMAP_DEFAULT_HEIGHT);
				updateGlobalViewState('minimapHeight', undefined);
			}
			this.lastResizeClick = moved ? 0 : now;
		});
	}

	/**
	 * Set the height of the minimap.
	 * @param height The height (in pixels).
	 * @returns The height that was set (within the minimum & maximum heights).
	 */
	private setHeight(height: number) {
		height = Math.round(Math.min(Math.max(height, MINIMAP_MIN_HEIGHT), MINIMAP_MAX_HEIGHT));
		this.elem.style.height = height + 'px';
		return height;
	}


	/* Periods */

	/**
	 * Get the index of the bar (bucket) containing a day.
	 * @param day The local day number.
	 * @returns The index.
	 */
	private getBucketIndex(day: number) {
		return this.getBucketKey(day) - this.firstBucketKey;
	}

	/**
	 * Get the key of the period containing a day: the day, week (starting on a Monday), month or year number.
	 * @param day The local day number.
	 * @returns The key.
	 */
	private getBucketKey(day: number) {
		switch (this.period) {
			case MinimapPeriod.Day:
				return day;
			case MinimapPeriod.Week:
				return Math.floor((day + 3) / 7); // Day 0 (1 Jan 1970) was a Thursday
			case MinimapPeriod.Month:
				return Minimap.getMonthKey(day);
			default:
				return new Date(day * SECONDS_PER_DAY * 1000).getUTCFullYear();
		}
	}

	/**
	 * Get the first day of a period.
	 * @param key The key of the period.
	 * @returns The local day number.
	 */
	private getBucketStart(key: number) {
		switch (this.period) {
			case MinimapPeriod.Day:
				return key;
			case MinimapPeriod.Week:
				return key * 7 - 3;
			case MinimapPeriod.Month:
				return Math.round(Date.UTC(Math.floor(key / 12), key % 12, 1) / 1000 / SECONDS_PER_DAY);
			default:
				return Math.round(Date.UTC(key, 0, 1) / 1000 / SECONDS_PER_DAY);
		}
	}

	/**
	 * Get the label of a bar.
	 * @param bucket The bucket of the bar.
	 * @param short Is the label for the axis (short), or a tooltip.
	 * @param withYear Should the short label include the year.
	 * @returns The label.
	 */
	private getBucketLabel(bucket: MinimapBucket, short: boolean, withYear: boolean = true) {
		const date = new Date(bucket.start * SECONDS_PER_DAY * 1000), year = date.getUTCFullYear(), month = t(MONTHS[date.getUTCMonth()]);
		const today = Minimap.getLocalDay(Math.round(Date.now() / 1000));
		switch (this.period) {
			case MinimapPeriod.Day:
				return short && bucket.start === today ? t('Today') : short && !withYear ? t('{0} {1}', date.getUTCDate(), month) : t('{0} {1} {2}', date.getUTCDate(), month, year);
			case MinimapPeriod.Week:
				return short ? (withYear ? t('{0} {1} {2}', date.getUTCDate(), month, year) : t('{0} {1}', date.getUTCDate(), month)) : t('Week of {0}', t('{0} {1} {2}', date.getUTCDate(), month, year));
			case MinimapPeriod.Month:
				return short && !withYear ? month : t('{1} {0}', year, month);
			default:
				return year.toString();
		}
	}

	/**
	 * Get the number of the local day (since 1 Jan 1970) of a Unix timestamp.
	 * @param unixTimestamp The Unix timestamp (in seconds).
	 * @returns The day number.
	 */
	private static getLocalDay(unixTimestamp: number) {
		const offset = -new Date(unixTimestamp * 1000).getTimezoneOffset() * 60;
		return Math.floor((unixTimestamp + offset) / SECONDS_PER_DAY);
	}

	/**
	 * Format a local day as YYYY-MM-DD.
	 * @param day The local day number.
	 * @returns The formatted day.
	 */
	private static formatDay(day: number) {
		const date = new Date(day * SECONDS_PER_DAY * 1000), pad = (value: number) => (value < 10 ? '0' : '') + value;
		return date.getUTCFullYear() + '-' + pad(date.getUTCMonth() + 1) + '-' + pad(date.getUTCDate());
	}

	/**
	 * Get the month number (since January of year 0) of a local day.
	 * @param day The local day number.
	 * @returns The month number.
	 */
	private static getMonthKey(day: number) {
		const date = new Date(day * SECONDS_PER_DAY * 1000);
		return date.getUTCFullYear() * 12 + date.getUTCMonth();
	}
}


/**
 * Implements the markers on the right edge of the Git Map View (alongside its scrollbar), that show where HEAD, branches, tags, stashes
 * & find matches are in the loaded commits.
 */
class ScrollMarkers {
	private readonly elem: HTMLElement;
	private readonly viewElem: HTMLElement;

	/**
	 * Construct a new ScrollMarkers instance.
	 * @param viewElem The scrolling element of the Git Map View.
	 */
	constructor(viewElem: HTMLElement) {
		this.viewElem = viewElem;
		this.elem = document.createElement('div');
		this.elem.id = 'scrollMarkers';
		document.body.appendChild(this.elem);
	}

	/**
	 * Render the markers.
	 * @param commits The loaded commits.
	 * @param commitHead The hash of the commit referenced by HEAD.
	 * @param vertexColours The colour index of each commit's vertex on the graph.
	 * @param colours The colours of the graph.
	 * @param findMatches The hashes of the commits that match the Find Widget's criteria.
	 * @param getVirtualRowCentre Get the position of the centre of the row of a commit (in the content of the view) when the rows are
	 * virtualised (as they aren't all rendered), or NULL when all rows are rendered.
	 */
	public render(commits: ReadonlyArray<GG.GitCommit>, commitHead: string | null, vertexColours: ReadonlyArray<number>, colours: ReadonlyArray<string>, findMatches: ReadonlyArray<string>, getVirtualRowCentre: (index: number) => number | null) {
		const viewRect = this.viewElem.getBoundingClientRect(), scrollHeight = this.viewElem.scrollHeight;
		this.elem.style.top = viewRect.top + 'px';
		this.elem.style.height = viewRect.height + 'px';
		this.elem.style.right = Math.max(window.innerWidth - viewRect.right, 0) + 'px';
		if (commits.length === 0 || scrollHeight <= this.viewElem.clientHeight) {
			this.elem.innerHTML = '';
			return;
		}

		const commitElems = getCommitElems(), viewTop = viewRect.top - this.viewElem.scrollTop, matches: { [hash: string]: boolean } = {};
		findMatches.forEach((hash) => matches[hash] = true);
		let html = '';
		for (let i = 0, j = 0; i < commits.length; i++) {
			const commit = commits[i];
			const kinds: { kind: string, colour: string }[] = [];
			if (matches[commit.hash]) kinds.push({ kind: 'findMatch', colour: 'var(--vscode-editorOverviewRuler-findMatchForeground, #d18616)' });
			if (commit.hash === commitHead) kinds.push({ kind: 'head', colour: 'var(--vscode-focusBorder)' });
			if (commit.hash === UNCOMMITTED || commit.stash !== null) kinds.push({ kind: 'other', colour: 'var(--vscode-descriptionForeground)' });
			if (commit.heads.length > 0 || commit.remotes.length > 0) kinds.push({ kind: 'branch', colour: colours[vertexColours[i] % colours.length] });
			if (commit.tags.length > 0) kinds.push({ kind: 'tag', colour: 'var(--vscode-descriptionForeground)' });
			if (kinds.length === 0) continue;

			let centre = getVirtualRowCentre(i);
			if (centre === null) {
				const idStr = i.toString();
				while (j < commitElems.length && commitElems[j].dataset.id !== idStr) j++;
				if (j === commitElems.length) break;
				const rowRect = commitElems[j].getBoundingClientRect();
				centre = rowRect.top + rowRect.height / 2 - viewTop;
			}
			const top = (centre / scrollHeight * 100).toFixed(3) + '%';
			html += kinds.map((marker) => '<span class="scrollMarker ' + marker.kind + '" style="top:' + top + ';background-color:' + escapeHtml(marker.colour) + '"></span>').join('');
		}
		this.elem.innerHTML = html;
	}
}
