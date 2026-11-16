/**
 * The maximum number of differences (lines added or removed) between the two versions of a file that are found exactly. If the versions
 * differ more, the lines between their common start & end are treated as changed.
 */
const MAX_DIFFERENCES = 2000;

/**
 * Map the lines of the current contents of a file (e.g. in an editor, with uncommitted changes) to the lines of a version of the file
 * (e.g. at HEAD), using the shortest edit script between them (Myers' diff algorithm).
 * @param base The lines of the version of the file.
 * @param current The lines of the current contents of the file.
 * @returns For each line of `current`, the index of the same line in `base`, or -1 if the line was added or changed.
 */
export function mapLines(base: ReadonlyArray<string>, current: ReadonlyArray<string>): Int32Array {
	const map = new Int32Array(current.length).fill(-1);

	// The lines at the start & end that are the same
	let start = 0, baseEnd = base.length, currentEnd = current.length;
	while (start < baseEnd && start < currentEnd && base[start] === current[start]) {
		map[start] = start;
		start++;
	}
	while (baseEnd > start && currentEnd > start && base[baseEnd - 1] === current[currentEnd - 1]) {
		baseEnd--;
		currentEnd--;
		map[currentEnd] = baseEnd;
	}

	const n = baseEnd - start, m = currentEnd - start;
	if (n === 0 || m === 0) return map;

	// Intern lines to 32-bit integer IDs so inner snake comparisons don't compare strings repeatedly
	const lineIds = new Map<string, number>();
	let nextId = 1;
	const a = new Int32Array(n), b = new Int32Array(m);
	for (let i = 0; i < n; i++) {
		const text = base[start + i];
		let id = lineIds.get(text);
		if (typeof id === 'undefined') {
			id = nextId++;
			lineIds.set(text, id);
		}
		a[i] = id;
	}
	for (let j = 0; j < m; j++) {
		const id = lineIds.get(current[start + j]);
		b[j] = typeof id !== 'undefined' ? id : 0; // 0 never matches any ID in `a`
	}

	// Find the furthest reaching path on each diagonal k (x - y) for each number of differences d, storing only the d + 1 active diagonals
	const max = Math.min(n + m, MAX_DIFFERENCES), v = new Int32Array(2 * max + 3), offset = max + 1, trace: Int32Array[] = [];
	for (let d = 0; d <= max; d++) {
		const step = new Int32Array(d + 1);
		for (let k = -d, idx = 0; k <= d; k += 2, idx++) {
			let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1, y = x - k;
			while (x < n && y < m && a[x] === b[y]) {
				x++;
				y++;
			}
			v[offset + k] = x;
			step[idx] = x;
			if (x >= n && y >= m) {
				trace.push(step);
				backtrack(trace, n, m, (baseIndex, currentIndex) => map[start + currentIndex] = start + baseIndex);
				return map;
			}
		}
		trace.push(step);
	}
	// The versions differ too much: the lines between the common start & end are treated as changed
	return map;
}

/**
 * Follow the furthest reaching paths back from the end of both versions, reporting the lines that are the same.
 * @param trace For each step d, the d + 1 end-of-snake x values at diagonals -d, -d + 2, ..., d.
 * @param n The number of lines of the base version.
 * @param m The number of lines of the current version.
 * @param onSame Called for each line that's the same in both versions.
 */
function backtrack(trace: ReadonlyArray<Int32Array>, n: number, m: number, onSame: (baseIndex: number, currentIndex: number) => void) {
	let x = n, y = m;
	for (let d = trace.length - 1; d >= 0; d--) {
		const k = x - y;
		let prevX = 0, prevY = 0;
		if (d > 0) {
			const prev = trace[d - 1], atPrev = (diag: number) => prev[(diag + d - 1) >> 1];
			const prevK = k === -d || (k !== d && atPrev(k - 1) < atPrev(k + 1)) ? k + 1 : k - 1;
			prevX = atPrev(prevK);
			prevY = prevX - prevK;
		}
		const startX = d === 0 ? 0 : (prevX - prevY < k ? prevX + 1 : prevX), startY = startX - k;
		while (x > startX && y > startY) {
			x--;
			y--;
			onSame(x, y);
		}
		x = prevX;
		y = prevY;
	}
}

/**
 * Get the lines of a version of a file (e.g. at HEAD) that correspond to a range of lines of its current contents: the lines that are the
 * same, and the lines replaced by changed lines at the start or end of the range (so a changed line's history is its previous version's).
 * @param map The mapping of the lines of the current contents to the lines of the version (from `mapLines`).
 * @param baseLength The number of lines of the version.
 * @param first The index of the first line of the range (in the current contents).
 * @param last The index of the last line of the range (in the current contents).
 * @returns The indexes of the first & last lines of the version, or NULL if the range only has added lines.
 */
export function getBaseRange(map: Int32Array, baseLength: number, first: number, last: number): { start: number, end: number } | null {
	let start = map[first], end = map[last];
	if (start < 0) {
		// The line before the start of the range that's the same in both versions
		let i = first - 1;
		while (i >= 0 && map[i] < 0) i--;
		start = (i >= 0 ? map[i] : -1) + 1;
	}
	if (end < 0) {
		// The line after the end of the range that's the same in both versions
		let i = last + 1;
		while (i < map.length && map[i] < 0) i++;
		end = (i < map.length ? map[i] : baseLength) - 1;
	}
	return start <= end && start < baseLength ? { start: start, end: Math.min(end, baseLength - 1) } : null;
}

/**
 * Get the diff of a range of lines between a version of a file and its current contents.
 * @param map The mapping of the lines of the current contents to the lines of the version (from `mapLines`).
 * @param base The lines of the version.
 * @param current The lines of the current contents.
 * @param first The index of the first line of the range (in the current contents).
 * @param last The index of the last line of the range (in the current contents).
 * @param baseRange The lines of the version that correspond to the range (from `getBaseRange`).
 * @returns The lines of the diff (each starting with ' ', '+' or '-'), with the lines removed before the lines added that replace them.
 */
export function getRangeDiff(map: Int32Array, base: ReadonlyArray<string>, current: ReadonlyArray<string>, first: number, last: number, baseRange: { start: number, end: number } | null) {
	const diff: string[] = [];
	let next = baseRange !== null ? baseRange.start : 0;
	const end = baseRange !== null ? baseRange.end : -1;
	const removeUntil = (index: number) => {
		while (next < index && next <= end) diff.push('-' + base[next++]);
	};
	for (let i = first; i <= last; i++) {
		if (map[i] >= 0) {
			removeUntil(map[i]);
			diff.push(' ' + current[i]);
			next = map[i] + 1;
		} else {
			// The lines of the version replaced by the added lines are removed first
			let j = i + 1;
			while (j <= last && map[j] < 0) j++;
			removeUntil(j <= last ? map[j] : end + 1);
			diff.push('+' + current[i]);
		}
	}
	removeUntil(end + 1);
	return diff;
}
