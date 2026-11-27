import * as vscode from './mocks/vscode';
jest.mock('vscode', () => vscode, { virtual: true });

import { countFileChanges, parseLsTreeSizes } from '../src/repoBrowser';

describe('parseLsTreeSizes', () => {
	it('Should return the files (not submodules) and their sizes, including paths with spaces & tabs', () => {
		const output = '100644 blob 1111111111111111111111111111111111111111     120\tsrc/a b.ts\0' +
			'160000 commit 2222222222222222222222222222222222222222       -\tvendor/lib\0' +
			'100755 blob 3333333333333333333333333333333333333333       7\tbin/run\tme\0';
		expect(parseLsTreeSizes(output)).toStrictEqual([
			{ path: 'src/a b.ts', size: 120 },
			{ path: 'bin/run\tme', size: 7 }
		]);
	});
});

describe('countFileChanges', () => {
	it('Should count how many commits changed each file', () => {
		const counts = countFileChanges('a.ts\nb.ts\n\na.ts\n\nc.ts\na.ts\n');
		expect(Array.from(counts.entries())).toStrictEqual([['a.ts', 3], ['b.ts', 1], ['c.ts', 1]]);
	});
});
