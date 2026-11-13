/**
 * What a FastExportFilter did to the stream it filtered.
 */
export interface FastExportFilterStats {
	commits: number; // The number of commits in the stream
	commitsRewritten: number; // The commits that were changed (they changed one of the paths, or have an ancestor that was changed)
	commitsRemoved: number; // The commits that were removed, as they only changed the paths
	fileChangesRemoved: number; // The changes of the paths that were removed from commits
	tagsRewritten: number; // The annotated tags that now refer to a rewritten commit
	signaturesRemoved: number; // The signatures of rewritten commits & tags that were removed (as they're no longer valid)
	refsDeleted: string[]; // The references that no longer have any commits
}

const LF = 10;
const SIGNATURE_REGEX = /^-----BEGIN (PGP SIGNATURE|PGP MESSAGE|SSH SIGNATURE|SIGNED MESSAGE)-----$/gm;

/**
 * A commit that's being read from the stream.
 */
interface CommitBlock {
	readonly ref: string;
	readonly raw: Buffer[]; // Everything read of the commit, as it was in the stream
	readonly preamble: Buffer[]; // The mark, author, committer, encoding & message of the commit
	readonly signature: Buffer[]; // The signature of the commit (not part of the preamble)
	readonly parents: string[]; // The parents of the commit (the first parent is its "from")
	readonly changes: Buffer[]; // The file changes that are kept
	mark: number | null;
	hasFrom: boolean;
	removedChanges: number;
	readMessage: boolean;
}

/**
 * An annotated tag that's being read from the stream.
 */
interface TagBlock {
	readonly name: string;
	readonly raw: Buffer[];
	readonly lines: Buffer[]; // The lines of the tag before its message (except its "from")
	mark: number | null;
	from: string | null;
}

/**
 * Filters the stream produced by `git fast-export --no-data`, removing every change of a set of paths from it, so that importing the
 * filtered stream with `git fast-import` recreates the history without the paths (as if they had never been committed).
 *
 * - The changes of the paths are removed from every commit.
 * - Commits that only changed the paths are removed (their children are connected to their parents), as are merge commits that no longer
 *   merge anything. Commits that were already empty are kept.
 * - Commits & tags that aren't affected (they don't change the paths, and none of their ancestors do) are passed through unchanged, so
 *   that they're recreated with the same hash. The signatures of the commits & tags that are affected are removed, as they would no
 *   longer be valid.
 * - References whose commits were all removed are deleted.
 *
 * The stream is processed as it's received (commits are small, as `--no-data` excludes the contents of files), so the memory used
 * doesn't depend on the size of the repository's files.
 */
export class FastExportFilter {
	private readonly paths: ReadonlySet<string>;
	private readonly pathPrefixes: ReadonlyArray<string>;
	private readonly zeroOid: string;
	private readonly onCommit: ((commits: number) => void) | null;

	private pending: Buffer = Buffer.alloc(0);
	private commit: CommitBlock | null = null;
	private tag: TagBlock | null = null;
	private reset: { readonly ref: string, readonly raw: Buffer } | null = null;
	private signatureState: 'header' | 'data' | null = null; // The part of a commit's signature that was read last
	private done: boolean = false;

	/** The marks of the commits & tags that were removed: the mark that replaces them (their nearest kept ancestor), or NULL if there is none. */
	private readonly replacedMarks = new Map<number, string | null>();
	/** The marks of the commits & tags that were changed or removed. */
	private readonly changedMarks = new Set<number>();
	private readonly deletedRefs = new Set<string>();

	public readonly stats: FastExportFilterStats = { commits: 0, commitsRewritten: 0, commitsRemoved: 0, fileChangesRemoved: 0, tagsRewritten: 0, signaturesRemoved: 0, refsDeleted: [] };

	/**
	 * Creates a FastExportFilter.
	 * @param paths The paths to remove (relative to the root of the repository, separated by "/"). A path of a directory removes everything in it.
	 * @param zeroOid The object id of all zeros in the repository's object format (used to delete references).
	 * @param onCommit A callback invoked with the number of commits read so far, each time a commit is read.
	 */
	constructor(paths: ReadonlyArray<string>, zeroOid: string = '0'.repeat(40), onCommit: ((commits: number) => void) | null = null) {
		const normalised = paths.map(normaliseHistoryPath).filter((path) => path !== '');
		if (normalised.length === 0) throw new Error('No paths were given to remove from the history.');
		this.paths = new Set(normalised);
		this.pathPrefixes = normalised.map((path) => path + '/');
		this.zeroOid = zeroOid;
		this.onCommit = onCommit;
	}

	/**
	 * Filter the next part of the stream.
	 * @param chunk The next part of the stream.
	 * @returns The filtered output that's ready (the output of a commit is only ready once all of the commit has been read).
	 */
	public push(chunk: Buffer): Buffer[] {
		const output: Buffer[] = [];
		this.pending = this.pending.length > 0 ? Buffer.concat([this.pending, chunk]) : chunk;
		let offset = 0;
		while (offset < this.pending.length) {
			const lineEnd = this.pending.indexOf(LF, offset);
			if (lineEnd === -1) break;
			let unitEnd = lineEnd + 1, data: Buffer | null = null;
			if (this.pending[offset] === 100 /* d */ && this.pending.toString('latin1', offset, Math.min(offset + 5, lineEnd)) === 'data ') {
				// The line is followed by the number of bytes it specifies (e.g. a commit message), which are never parsed as lines
				const length = this.pending.toString('latin1', offset + 5, lineEnd);
				if (!/^\d+$/.test(length)) throw new Error('Unsupported data command in the fast-export stream: data ' + length);
				unitEnd += parseInt(length);
				if (unitEnd > this.pending.length) break;
				data = this.pending.subarray(lineEnd + 1, unitEnd);
			}
			this.processUnit(this.pending.subarray(offset, unitEnd), this.pending.toString('utf8', offset, lineEnd), data, output);
			offset = unitEnd;
		}
		// The remainder is copied, so that the chunk it's part of can be released
		this.pending = offset < this.pending.length ? Buffer.from(this.pending.subarray(offset)) : Buffer.alloc(0);
		return output;
	}

	/**
	 * Finish filtering the stream.
	 * @returns The remaining filtered output.
	 * @throws If the stream is incomplete (it must end with "done", which `git fast-export --use-done-feature` produces).
	 */
	public end(): Buffer[] {
		const output: Buffer[] = [];
		this.finishBlock(output);
		if (this.pending.length > 0 || !this.done) throw new Error('The fast-export stream is incomplete.');
		this.stats.refsDeleted = Array.from(this.deletedRefs).sort();
		return output;
	}

	/**
	 * Process a line of the stream (with the data that follows it, if it's a data command).
	 * @param raw The line (and its data) as it is in the stream.
	 * @param line The line (without its line feed).
	 * @param data The data of a data command, otherwise NULL.
	 * @param output The filtered output is added to this array.
	 */
	private processUnit(raw: Buffer, line: string, data: Buffer | null, output: Buffer[]) {
		if (this.done) throw new Error('Unexpected content after the end of the fast-export stream.');
		if (this.commit !== null && this.processCommitLine(this.commit, raw, line, data, output)) return;
		if (this.tag !== null && this.processTagLine(this.tag, raw, line, data, output)) return;
		if (this.reset !== null) {
			const reset = this.reset;
			this.reset = null;
			if (line.startsWith('from ')) {
				this.writeReset(reset.ref, Buffer.concat([reset.raw, raw]), line.substring(5), output);
				return;
			}
			output.push(reset.raw);
		}
		this.finishBlock(output);

		if (line.startsWith('commit ')) {
			this.commit = { ref: line.substring(7), raw: [raw], preamble: [], signature: [], parents: [], changes: [], mark: null, hasFrom: false, removedChanges: 0, readMessage: false };
		} else if (line.startsWith('tag ')) {
			this.tag = { name: line.substring(4), raw: [raw], lines: [], mark: null, from: null };
		} else if (line.startsWith('reset ')) {
			this.reset = { ref: line.substring(6), raw: raw };
		} else if (line === 'blob') {
			// The contents of files are only in the stream if it wasn't produced with --no-data, which isn't supported
			throw new Error('The fast-export stream must be produced with --no-data.');
		} else {
			if (line === 'done') this.done = true;
			output.push(raw); // Blank lines, and the "feature", "progress" & "done" commands
		}
	}

	/**
	 * Process a line of the commit that's being read.
	 * @returns TRUE => The line is part of the commit, FALSE => The commit has ended (the line is the start of what follows it).
	 */
	private processCommitLine(commit: CommitBlock, raw: Buffer, line: string, data: Buffer | null, output: Buffer[]) {
		if (!commit.readMessage) {
			// The mark, author, committer, signature, encoding & message of the commit
			commit.raw.push(raw);
			if (line.startsWith('gpgsig ')) {
				commit.signature.push(raw);
				this.signatureState = 'header';
			} else if (data !== null && this.signatureState === 'header') {
				commit.signature.push(raw);
				this.signatureState = 'data';
			} else if (line === '' && this.signatureState === 'data') {
				// The line feed that ends the signature is part of it
				commit.signature.push(raw);
				this.signatureState = null;
			} else {
				this.signatureState = null;
				commit.preamble.push(raw);
				if (line.startsWith('mark :')) commit.mark = parseInt(line.substring(6));
				if (data !== null) commit.readMessage = true;
			}
			return true;
		}

		let path: string | null = null;
		if (line.startsWith('from ')) {
			commit.parents.unshift(line.substring(5));
			commit.hasFrom = true;
		} else if (line.startsWith('merge ')) {
			commit.parents.push(line.substring(6));
		} else if (line.startsWith('M ')) {
			// M <mode> <object> <path>
			const fields = /^M \S+ \S+ (.*)$/.exec(line);
			if (fields === null) throw new Error('Unable to parse the file change in the fast-export stream: ' + line);
			path = unquoteHistoryPath(fields[1]);
		} else if (line.startsWith('D ')) {
			path = unquoteHistoryPath(line.substring(2));
		} else if (line === '') {
			// A blank line ends the commit (a blank line is written at the end of the filtered commit)
			commit.raw.push(raw);
			this.commit = null;
			this.writeCommit(commit, output);
			return true;
		} else if (!/^(R|C|N) |^deleteall$/.test(line)) {
			return false;
		}

		commit.raw.push(raw);
		if (path !== null) {
			if (this.matches(path)) {
				commit.removedChanges++;
			} else {
				commit.changes.push(raw);
			}
		} else if (!line.startsWith('from ') && !line.startsWith('merge ')) {
			commit.changes.push(raw);
		}
		return true;
	}

	/**
	 * Process a line of the tag that's being read.
	 * @returns TRUE => The line is part of the tag, FALSE => The tag has ended (the line is the start of what follows it).
	 */
	private processTagLine(tag: TagBlock, raw: Buffer, line: string, data: Buffer | null, output: Buffer[]) {
		if (data !== null) {
			// The message of the tag is the end of it
			tag.raw.push(raw);
			this.tag = null;
			this.writeTag(tag, data, output);
			return true;
		}
		if (line.startsWith('from ')) {
			tag.from = line.substring(5);
		} else if (/^(mark|original-oid|tagger) /.test(line)) {
			tag.lines.push(raw);
			if (line.startsWith('mark :')) tag.mark = parseInt(line.substring(6));
		} else {
			return false;
		}
		tag.raw.push(raw);
		return true;
	}

	/**
	 * Finish the commit, tag or reset that's being read (as what follows it has been reached).
	 * @param output The filtered output is added to this array.
	 */
	private finishBlock(output: Buffer[]) {
		if (this.commit !== null) {
			const commit = this.commit;
			this.commit = null;
			this.writeCommit(commit, output);
		}
		if (this.tag !== null) throw new Error('The tag "' + this.tag.name + '" in the fast-export stream doesn\'t have a message.');
		if (this.reset !== null) {
			output.push(this.reset.raw);
			this.reset = null;
		}
	}

	/**
	 * Write a commit that has been read, without the changes of the paths (or remove it, if it only changed the paths).
	 * @param commit The commit.
	 * @param output The filtered output is added to this array.
	 */
	private writeCommit(commit: CommitBlock, output: Buffer[]) {
		this.stats.commits++;
		this.stats.fileChangesRemoved += commit.removedChanges;
		if (this.onCommit !== null) this.onCommit(this.stats.commits);
		if (!commit.readMessage) throw new Error('A commit on "' + commit.ref + '" in the fast-export stream doesn\'t have a message.');

		const affected = commit.removedChanges > 0 || commit.parents.some((parent) => this.isChanged(parent));
		if (!affected) {
			output.push(...commit.raw);
			return;
		}
		if (commit.mark !== null) this.changedMarks.add(commit.mark);

		// The parents that still exist (a removed parent is replaced by its nearest kept ancestor)
		const parents: string[] = [];
		commit.parents.forEach((parent) => {
			const resolved = this.resolve(parent);
			if (resolved !== null && !parents.includes(resolved)) parents.push(resolved);
		});
		const firstParent = commit.hasFrom ? this.resolve(commit.parents[0]) : null;

		if (commit.changes.length === 0 && parents.length <= 1 && (commit.removedChanges > 0 || commit.parents.length > 1)) {
			// The commit only changed the paths (or is a merge that no longer merges anything), so it's removed. The reference it was
			// written to is moved to its parent, as this commit may be the last one written to it.
			this.stats.commitsRemoved++;
			if (commit.mark !== null) this.replacedMarks.set(commit.mark, parents.length === 1 ? parents[0] : null);
			if (parents.length === 1) {
				this.deletedRefs.delete(commit.ref);
				output.push(Buffer.from('reset ' + commit.ref + '\nfrom ' + parents[0] + '\n\n'));
			} else {
				this.deletedRefs.add(commit.ref);
				output.push(Buffer.from('reset ' + commit.ref + '\nfrom ' + this.zeroOid + '\n\n'));
			}
			return;
		}

		this.stats.commitsRewritten++;
		this.stats.signaturesRemoved += commit.signature.length > 0 ? 1 : 0;
		this.deletedRefs.delete(commit.ref);
		if (commit.hasFrom && firstParent === null) {
			// The commit no longer has a first parent, so the reference is reset (otherwise the commit would be added to its current commit)
			output.push(Buffer.from('reset ' + commit.ref + '\n'));
		}
		output.push(commit.raw[0], ...commit.preamble);
		parents.forEach((parent, index) => output.push(Buffer.from((index === 0 ? 'from ' : 'merge ') + parent + '\n')));
		if (parents.length > 0 && parents[0] !== firstParent) {
			// The file changes are relative to the first parent, which was removed with all of its ancestors (so it didn't have any
			// files left). As another parent has taken its place, the commit must start without any files.
			output.push(Buffer.from('deleteall\n'));
		}
		output.push(...commit.changes, Buffer.from('\n'));
	}

	/**
	 * Write an annotated tag that has been read (referring to the commit that replaces the one it referred to, if that was rewritten).
	 * @param tag The tag.
	 * @param message The message of the tag.
	 * @param output The filtered output is added to this array.
	 */
	private writeTag(tag: TagBlock, message: Buffer, output: Buffer[]) {
		if (tag.from === null) throw new Error('The tag "' + tag.name + '" in the fast-export stream doesn\'t refer to an object.');
		if (!this.isChanged(tag.from)) {
			output.push(...tag.raw);
			return;
		}
		if (tag.mark !== null) this.changedMarks.add(tag.mark);
		const target = this.resolve(tag.from);
		if (target === null) {
			// The commit the tag referred to was removed with all of its ancestors
			if (tag.mark !== null) this.replacedMarks.set(tag.mark, null);
			this.deletedRefs.add('refs/tags/' + tag.name);
			output.push(Buffer.from('reset refs/tags/' + tag.name + '\nfrom ' + this.zeroOid + '\n\n'));
			return;
		}

		// The signature of the tag is removed, as it's no longer valid
		const text = message.toString('latin1');
		let signatureIndex = -1, match: RegExpExecArray | null;
		SIGNATURE_REGEX.lastIndex = 0;
		while ((match = SIGNATURE_REGEX.exec(text)) !== null) signatureIndex = match.index;
		if (signatureIndex > -1) {
			message = message.subarray(0, signatureIndex);
			this.stats.signaturesRemoved++;
		}
		this.stats.tagsRewritten++;
		this.deletedRefs.delete('refs/tags/' + tag.name);
		output.push(tag.raw[0]);
		// The mark of the tag is written before what it refers to, and the tagger after it
		tag.lines.filter((line) => line.toString('latin1', 0, 5) === 'mark ').forEach((line) => output.push(line));
		output.push(Buffer.from('from ' + target + '\n'));
		tag.lines.filter((line) => line.toString('latin1', 0, 5) !== 'mark ').forEach((line) => output.push(line));
		output.push(Buffer.from('data ' + message.length + '\n'), message);
	}

	/**
	 * Write a reset of a reference to a commit (to the commit that replaces it, if it was rewritten).
	 * @param ref The reference.
	 * @param raw The reset as it was in the stream.
	 * @param from The commit the reference is reset to.
	 * @param output The filtered output is added to this array.
	 */
	private writeReset(ref: string, raw: Buffer, from: string, output: Buffer[]) {
		if (!this.isChanged(from)) {
			output.push(raw);
			return;
		}
		const target = this.resolve(from);
		if (target === null) {
			this.deletedRefs.add(ref);
		} else {
			this.deletedRefs.delete(ref);
		}
		output.push(Buffer.from('reset ' + ref + '\nfrom ' + (target !== null ? target : this.zeroOid) + '\n'));
	}

	/**
	 * Was the commit or tag that a mark refers to changed or removed.
	 * @param reference A mark (e.g. ":12"), or an object id.
	 */
	private isChanged(reference: string) {
		return reference.startsWith(':') && this.changedMarks.has(parseInt(reference.substring(1)));
	}

	/**
	 * Get what replaces a reference to a commit or tag.
	 * @param reference A mark (e.g. ":12"), or an object id.
	 * @returns The reference that replaces it (itself, unless it was removed), or NULL if it was removed with all of its ancestors.
	 */
	private resolve(reference: string) {
		if (!reference.startsWith(':')) return reference;
		const replacement = this.replacedMarks.get(parseInt(reference.substring(1)));
		return typeof replacement === 'undefined' ? reference : replacement;
	}

	/**
	 * Is a path one of the paths that are removed (or in one of the directories that are removed).
	 * @param path The path.
	 */
	private matches(path: string) {
		return this.paths.has(path) || this.pathPrefixes.some((prefix) => path.startsWith(prefix));
	}
}

/**
 * Normalise a path that's removed from the history: separated by "/", without "./" at its start or "/" at its ends.
 * @param path The path (relative to the root of the repository).
 * @returns The normalised path.
 */
export function normaliseHistoryPath(path: string) {
	return path.replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/^\/+|\/+$/g, '');
}

/**
 * Get the path from how it's written in a fast-export stream: paths containing special characters are quoted as a C string, with
 * the bytes of characters that aren't ASCII as octal escapes.
 * @param path The path as it's written in the stream.
 * @returns The path.
 */
export function unquoteHistoryPath(path: string) {
	if (!path.startsWith('"') || !path.endsWith('"') || path.length < 2) return path;
	const escapes: { [char: string]: number } = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13 };
	const source = Buffer.from(path.substring(1, path.length - 1), 'utf8'), bytes: number[] = [];
	for (let i = 0; i < source.length; i++) {
		if (source[i] !== 92 /* \ */ || i + 1 >= source.length) {
			bytes.push(source[i]);
			continue;
		}
		const char = String.fromCharCode(source[++i]);
		if (char >= '0' && char <= '7') {
			let value = 0, digits = 0;
			while (digits < 3 && i < source.length && source[i] >= 48 && source[i] <= 55) {
				value = value * 8 + (source[i] - 48);
				i++;
				digits++;
			}
			i--;
			bytes.push(value & 255);
		} else {
			bytes.push(typeof escapes[char] === 'number' ? escapes[char] : source[i]);
		}
	}
	return Buffer.from(bytes).toString('utf8');
}
