import { FastExportFilter, normaliseHistoryPath, unquoteHistoryPath } from '../src/historyFilter';

const ZERO = '0'.repeat(40);

/**
 * Filter a stream, given to the filter in chunks of a number of bytes.
 */
function filter(stream: string, paths: string[], chunkSize: number = 1 << 20) {
	const fastExportFilter = new FastExportFilter(paths, ZERO), input = Buffer.from(stream), output: Buffer[] = [];
	for (let i = 0; i < input.length; i += chunkSize) {
		output.push(...fastExportFilter.push(input.subarray(i, i + chunkSize)));
	}
	output.push(...fastExportFilter.end());
	return { output: Buffer.concat(output).toString(), stats: fastExportFilter.stats };
}

function commit(ref: string, mark: number, message: string, lines: string[]) {
	return 'commit ' + ref + '\nmark :' + mark + '\nauthor A <a@example.com> 1700000000 +0000\ncommitter A <a@example.com> 1700000000 +0000\ndata ' + Buffer.byteLength(message) + '\n' + message + lines.map((line) => line + '\n').join('') + '\n';
}

const BLOB = 'b'.repeat(40);

describe('FastExportFilter', () => {
	it('Should pass a stream that doesn\'t change the paths through unchanged (however it\'s split into chunks)', () => {
		const stream = 'feature done\nreset refs/heads/main\n' +
			commit('refs/heads/main', 1, 'first\n', ['M 100644 ' + BLOB + ' a.txt']) +
			commit('refs/heads/main', 2, 'second\n', ['from :1', 'M 100644 ' + BLOB + ' b.txt', 'D a.txt']) +
			'reset refs/heads/other\nfrom :1\n\n' +
			'tag v1\nmark :3\nfrom :2\ntagger A <a@example.com> 1700000000 +0000\ndata 4\ntag\n\n' +
			'done\n';

		[1, 7, 64, 1 << 20].forEach((chunkSize) => {
			const result = filter(stream, ['secret.bin'], chunkSize);
			expect(result.output).toBe(stream);
			expect(result.stats).toStrictEqual({ commits: 2, commitsRewritten: 0, commitsRemoved: 0, fileChangesRemoved: 0, tagsRewritten: 0, signaturesRemoved: 0, refsDeleted: [] });
		});
	});

	it('Should remove the changes of the paths (files, quoted paths & everything in a directory), and only those', () => {
		const stream = 'feature done\nreset refs/heads/main\n' +
			commit('refs/heads/main', 1, 'first\n', [
				'M 100644 ' + BLOB + ' a.txt',
				'M 100644 ' + BLOB + ' secret.bin',
				'M 100644 ' + BLOB + ' secret.bin2',
				'M 100644 ' + BLOB + ' "my dir/sp ace.txt"',
				'M 100644 ' + BLOB + ' "my dir2/keep.txt"',
				'M 100644 ' + BLOB + ' "\\345\\220\\215\\345\\255\\227.txt"',
				'M 100644 ' + BLOB + ' nested/secret.bin'
			]) +
			commit('refs/heads/main', 2, 'second\n', ['from :1', 'D secret.bin', 'D "my dir/sp ace.txt"', 'M 100644 ' + BLOB + ' a.txt']) +
			'done\n';

		const result = filter(stream, ['secret.bin', './my dir/', '名字.txt'], 5);

		expect(result.output).toBe('feature done\nreset refs/heads/main\n' +
			commit('refs/heads/main', 1, 'first\n', [
				'M 100644 ' + BLOB + ' a.txt',
				'M 100644 ' + BLOB + ' secret.bin2',
				'M 100644 ' + BLOB + ' "my dir2/keep.txt"',
				'M 100644 ' + BLOB + ' nested/secret.bin'
			]) +
			commit('refs/heads/main', 2, 'second\n', ['from :1', 'M 100644 ' + BLOB + ' a.txt']) +
			'done\n');
		expect(result.stats).toStrictEqual({ commits: 2, commitsRewritten: 2, commitsRemoved: 0, fileChangesRemoved: 5, tagsRewritten: 0, signaturesRemoved: 0, refsDeleted: [] });
	});

	it('Should never parse the message of a commit as commands', () => {
		const message = 'M 100644 ' + BLOB + ' secret.bin\nD secret.bin\ndata 1000\ncommit refs/heads/evil\n';
		const stream = 'feature done\nreset refs/heads/main\n' + commit('refs/heads/main', 1, message, ['M 100644 ' + BLOB + ' a.txt']) + 'done\n';

		const result = filter(stream, ['secret.bin'], 3);

		expect(result.output).toBe(stream);
		expect(result.stats.fileChangesRemoved).toBe(0);
	});

	it('Should remove a commit that only changed the paths, connecting its children to its parent', () => {
		const stream = 'feature done\nreset refs/heads/main\n' +
			commit('refs/heads/main', 1, 'first\n', ['M 100644 ' + BLOB + ' a.txt']) +
			commit('refs/heads/main', 2, 'only secret\n', ['from :1', 'M 100644 ' + BLOB + ' secret.bin']) +
			commit('refs/heads/main', 3, 'third\n', ['from :2', 'M 100644 ' + BLOB + ' c.txt']) +
			commit('refs/heads/topic', 4, 'only secret again\n', ['from :3', 'D secret.bin']) +
			'reset refs/heads/other\nfrom :4\n\n' +
			'done\n';

		const result = filter(stream, ['secret.bin']);

		expect(result.output).toBe('feature done\nreset refs/heads/main\n' +
			commit('refs/heads/main', 1, 'first\n', ['M 100644 ' + BLOB + ' a.txt']) +
			'reset refs/heads/main\nfrom :1\n\n' +
			commit('refs/heads/main', 3, 'third\n', ['from :1', 'M 100644 ' + BLOB + ' c.txt']) +
			'reset refs/heads/topic\nfrom :3\n\n' +
			'reset refs/heads/other\nfrom :3\n\n' +
			'done\n');
		expect(result.stats).toStrictEqual({ commits: 4, commitsRewritten: 1, commitsRemoved: 2, fileChangesRemoved: 2, tagsRewritten: 0, signaturesRemoved: 0, refsDeleted: [] });
	});

	it('Should keep a commit that was already empty', () => {
		const stream = 'feature done\nreset refs/heads/main\n' +
			commit('refs/heads/main', 1, 'first\n', ['M 100644 ' + BLOB + ' secret.bin', 'M 100644 ' + BLOB + ' a.txt']) +
			commit('refs/heads/main', 2, 'empty\n', ['from :1']) +
			'done\n';

		const result = filter(stream, ['secret.bin']);

		expect(result.output).toBe('feature done\nreset refs/heads/main\n' +
			commit('refs/heads/main', 1, 'first\n', ['M 100644 ' + BLOB + ' a.txt']) +
			commit('refs/heads/main', 2, 'empty\n', ['from :1']) +
			'done\n');
		expect(result.stats.commitsRemoved).toBe(0);
	});

	it('Should make the child of a removed root commit the new root commit, and delete a reference that has no commits left', () => {
		const stream = 'feature done\nreset refs/heads/main\n' +
			commit('refs/heads/main', 1, 'only secret\n', ['M 100644 ' + BLOB + ' secret.bin']) +
			commit('refs/heads/main', 2, 'second\n', ['from :1', 'M 100644 ' + BLOB + ' a.txt']) +
			'reset refs/heads/secrets\nfrom :1\n\n' +
			'tag gone\nmark :3\nfrom :1\ntagger A <a@example.com> 1700000000 +0000\ndata 4\ntag\n\n' +
			'done\n';

		const result = filter(stream, ['secret.bin']);

		expect(result.output).toBe('feature done\nreset refs/heads/main\n' +
			'reset refs/heads/main\nfrom ' + ZERO + '\n\n' +
			'reset refs/heads/main\n' +
			commit('refs/heads/main', 2, 'second\n', ['M 100644 ' + BLOB + ' a.txt']) +
			'reset refs/heads/secrets\nfrom ' + ZERO + '\n\n' +
			'reset refs/tags/gone\nfrom ' + ZERO + '\n\n\n' +
			'done\n');
		expect(result.stats.refsDeleted).toStrictEqual(['refs/heads/secrets', 'refs/tags/gone']);
	});

	it('Should remove a merge commit that no longer merges anything, and keep one that still does', () => {
		const stream = 'feature done\nreset refs/heads/main\n' +
			commit('refs/heads/main', 1, 'first\n', ['M 100644 ' + BLOB + ' a.txt']) +
			commit('refs/heads/main', 2, 'only secret\n', ['from :1', 'M 100644 ' + BLOB + ' secret.bin']) +
			commit('refs/heads/main', 3, 'merge secret\n', ['from :1', 'merge :2', 'M 100644 ' + BLOB + ' secret.bin']) +
			commit('refs/heads/main', 4, 'side\n', ['from :1', 'M 100644 ' + BLOB + ' b.txt']) +
			commit('refs/heads/main', 5, 'merge side\n', ['from :3', 'merge :4', 'M 100644 ' + BLOB + ' b.txt']) +
			'done\n';

		const result = filter(stream, ['secret.bin']);

		expect(result.output).toBe('feature done\nreset refs/heads/main\n' +
			commit('refs/heads/main', 1, 'first\n', ['M 100644 ' + BLOB + ' a.txt']) +
			'reset refs/heads/main\nfrom :1\n\n' +
			'reset refs/heads/main\nfrom :1\n\n' +
			commit('refs/heads/main', 4, 'side\n', ['from :1', 'M 100644 ' + BLOB + ' b.txt']) +
			commit('refs/heads/main', 5, 'merge side\n', ['from :1', 'merge :4', 'M 100644 ' + BLOB + ' b.txt']) +
			'done\n');
		expect(result.stats.commitsRemoved).toBe(2);
		expect(result.stats.commitsRewritten).toBe(1);
	});

	it('Should start a commit without any files when another parent replaces its removed first parent', () => {
		const stream = 'feature done\nreset refs/heads/main\n' +
			commit('refs/heads/main', 1, 'only secret\n', ['M 100644 ' + BLOB + ' secret.bin']) +
			'reset refs/heads/side\n' +
			commit('refs/heads/side', 2, 'side root\n', ['M 100644 ' + BLOB + ' b.txt']) +
			commit('refs/heads/main', 3, 'merge\n', ['from :1', 'merge :2', 'M 100644 ' + BLOB + ' b.txt', 'M 100644 ' + BLOB + ' c.txt']) +
			'done\n';

		const result = filter(stream, ['secret.bin']);

		expect(result.output).toBe('feature done\nreset refs/heads/main\n' +
			'reset refs/heads/main\nfrom ' + ZERO + '\n\n' +
			'reset refs/heads/side\n' +
			commit('refs/heads/side', 2, 'side root\n', ['M 100644 ' + BLOB + ' b.txt']) +
			'reset refs/heads/main\n' +
			commit('refs/heads/main', 3, 'merge\n', ['from :2', 'deleteall', 'M 100644 ' + BLOB + ' b.txt', 'M 100644 ' + BLOB + ' c.txt']) +
			'done\n');
		expect(result.stats.refsDeleted).toStrictEqual([]);
	});

	it('Should remove the signatures of the commits & tags that are rewritten, and keep those of the ones that aren\'t', () => {
		const signature = '-----BEGIN SSH SIGNATURE-----\nAAAA\n-----END SSH SIGNATURE-----\n';
		const signedCommit = (mark: number, lines: string[]) => 'commit refs/heads/main\nmark :' + mark + '\nauthor A <a@example.com> 1700000000 +0000\ncommitter A <a@example.com> 1700000000 +0000\ngpgsig sha1 ssh\ndata ' + (signature.length - 1) + '\n' + signature + 'data 7\nsigned\n' + lines.map((line) => line + '\n').join('') + '\n';
		const signedTag = (name: string, mark: number, from: number) => 'tag ' + name + '\nmark :' + mark + '\nfrom :' + from + '\ntagger A <a@example.com> 1700000000 +0000\ndata ' + (8 + signature.length) + '\nrelease\n' + signature + '\n';
		const stream = 'feature done\nreset refs/heads/main\n' +
			signedCommit(1, ['M 100644 ' + BLOB + ' a.txt']) +
			signedTag('before', 2, 1) +
			signedCommit(3, ['from :1', 'M 100644 ' + BLOB + ' secret.bin', 'M 100644 ' + BLOB + ' b.txt']) +
			signedCommit(4, ['from :3', 'M 100644 ' + BLOB + ' c.txt']) +
			signedTag('after', 5, 4) +
			'done\n';

		const result = filter(stream, ['secret.bin'], 11);

		expect(result.output).toBe('feature done\nreset refs/heads/main\n' +
			signedCommit(1, ['M 100644 ' + BLOB + ' a.txt']) +
			signedTag('before', 2, 1) +
			commit('refs/heads/main', 3, 'signed\n', ['from :1', 'M 100644 ' + BLOB + ' b.txt']) +
			commit('refs/heads/main', 4, 'signed\n', ['from :3', 'M 100644 ' + BLOB + ' c.txt']) +
			'tag after\nmark :5\nfrom :4\ntagger A <a@example.com> 1700000000 +0000\ndata 8\nrelease\n\n' +
			'done\n');
		expect(result.stats).toStrictEqual({ commits: 3, commitsRewritten: 2, commitsRemoved: 0, fileChangesRemoved: 1, tagsRewritten: 1, signaturesRemoved: 3, refsDeleted: [] });
	});

	it('Should move a tag of a removed commit to the commit that replaces it', () => {
		const stream = 'feature done\nreset refs/heads/main\n' +
			commit('refs/heads/main', 1, 'first\n', ['M 100644 ' + BLOB + ' a.txt']) +
			commit('refs/heads/main', 2, 'only secret\n', ['from :1', 'M 100644 ' + BLOB + ' secret.bin']) +
			'tag v1\nmark :3\nfrom :2\ntagger A <a@example.com> 1700000000 +0000\ndata 4\ntag\n\n' +
			'reset refs/tags/light\nfrom :2\n\n' +
			'done\n';

		const result = filter(stream, ['secret.bin']);

		expect(result.output).toBe('feature done\nreset refs/heads/main\n' +
			commit('refs/heads/main', 1, 'first\n', ['M 100644 ' + BLOB + ' a.txt']) +
			'reset refs/heads/main\nfrom :1\n\n' +
			'tag v1\nmark :3\nfrom :1\ntagger A <a@example.com> 1700000000 +0000\ndata 4\ntag\n\n' +
			'reset refs/tags/light\nfrom :1\n\n' +
			'done\n');
		expect(result.stats.tagsRewritten).toBe(1);
	});

	it('Should reject a stream that is incomplete, contains the contents of files, or isn\'t given any paths', () => {
		const complete = 'feature done\nreset refs/heads/main\n' + commit('refs/heads/main', 1, 'first\n', ['M 100644 ' + BLOB + ' a.txt']) + 'done\n';

		expect(() => filter(complete.substring(0, complete.length - 5), ['a.txt'])).toThrow('The fast-export stream is incomplete.');
		expect(() => filter(complete.substring(0, 120), ['a.txt'])).toThrow();
		expect(() => filter('blob\nmark :1\ndata 1\nx\ndone\n', ['a.txt'])).toThrow('The fast-export stream must be produced with --no-data.');
		expect(() => filter(complete, ['', './'])).toThrow('No paths were given to remove from the history.');
	});
});

describe('normaliseHistoryPath', () => {
	it('Should normalise paths', () => {
		expect(normaliseHistoryPath('a/b.txt')).toBe('a/b.txt');
		expect(normaliseHistoryPath('./a/b/')).toBe('a/b');
		expect(normaliseHistoryPath('a\\b\\c.txt')).toBe('a/b/c.txt');
		expect(normaliseHistoryPath('/')).toBe('');
	});
});

describe('unquoteHistoryPath', () => {
	it('Should unquote paths', () => {
		expect(unquoteHistoryPath('a/b.txt')).toBe('a/b.txt');
		expect(unquoteHistoryPath('"dir/sp ace.txt"')).toBe('dir/sp ace.txt');
		expect(unquoteHistoryPath('"\\345\\220\\215\\345\\255\\227.txt"')).toBe('名字.txt');
		expect(unquoteHistoryPath('"a\\"b\\\\c\\td.txt"')).toBe('a"b\\c\td.txt');
		expect(unquoteHistoryPath('"')).toBe('"');
	});
});
