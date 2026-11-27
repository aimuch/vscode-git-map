import * as vscode from './mocks/vscode';
jest.mock('vscode', () => vscode, { virtual: true });

import { formatBlameTemplate, getStatusBarCommand } from '../src/lineBlame';
import { formatDatePattern } from '../src/utils';
import { GitLineBlame } from '../src/types';

// 2026-11-24 21:05:07 in the local time zone
const DATE = new Date(2026, 10, 24, 21, 5, 7).getTime() / 1000;

const BLAME: GitLineBlame = {
	hash: '1a2b3c4d5e6f7a8b9c0d1a2b3c4d5e6f7a8b9c0d',
	committed: true,
	author: 'Alex',
	authorEmail: 'alex@example.com',
	authorDate: DATE,
	summary: 'Supercharge the parser',
	originalLine: 3,
	originalFilePath: 'src/parser.ts'
};

describe('formatDatePattern', () => {
	it('Should format the tokens like Moment.js, keeping the text in brackets', () => {
		expect(formatDatePattern(DATE, 'YYYY-MM-DD HH:mm:ss', 'en')).toBe('2026-11-24 21:05:07');
		expect(formatDatePattern(DATE, 'MMMM Do, YYYY h:mma', 'en')).toBe('November 24th, 2026 9:05pm');
		expect(formatDatePattern(DATE, 'ddd D MMM [at] hh:mm A', 'en')).toBe('Tue 24 Nov at 09:05 PM');
		expect(formatDatePattern(DATE, 'YY/M/D', 'en')).toBe('26/11/24');
	});

	it('Should use the ordinal suffixes of English', () => {
		const day = (d: number) => formatDatePattern(new Date(2026, 0, d).getTime() / 1000, 'Do', 'en');
		expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 31].map(day)).toStrictEqual(['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '23rd', '31st']);
	});

	it('Should use the short date of the locale when the pattern is empty', () => {
		expect(formatDatePattern(DATE, '', 'en-US')).toBe(new Date(DATE * 1000).toLocaleDateString('en-US'));
	});
});

describe('formatBlameTemplate', () => {
	it('Should show absolute dates with the date format when the date style is absolute', () => {
		expect(formatBlameTemplate('${author}, ${agoOrDate}', BLAME, null, { style: 'absolute', format: 'YYYY-MM-DD', locale: 'en' })).toBe('Alex, 2026-11-24');
		expect(formatBlameTemplate('${date}', BLAME, null, { style: 'relative', format: 'MMM D', locale: 'en' })).toBe('Nov 24');
	});

	it('Should pad a value to a width with |N- (and truncate it to the width)', () => {
		expect(formatBlameTemplate('${author|8-}|', BLAME, null)).toBe('Alex\u00a0\u00a0\u00a0\u00a0|');
		expect(formatBlameTemplate('${message|10-}', BLAME, null)).toBe('Superchar…');
	});
});

describe('getStatusBarCommand', () => {
	const uri = vscode.Uri.file('/repo/src/parser.ts');

	it('Should run the command chosen for the blame in the Status Bar', () => {
		expect(getStatusBarCommand('inspect', '/repo', BLAME, <any>uri, 3)).toMatchObject({ command: 'git-map.inspect', arguments: ['/repo', BLAME.hash] });
		expect(getStatusBarCommand('viewCommitInGitMap', '/repo', BLAME, <any>uri, 3)).toMatchObject({ command: 'git-map.viewCommitInGitMap', arguments: ['/repo', BLAME.hash] });
		expect(getStatusBarCommand('openLineChanges', '/repo', BLAME, <any>uri, 3)).toMatchObject({ command: 'git-map.openLineChanges', arguments: ['/repo', BLAME.hash, 'src/parser.ts', 3] });
		expect(getStatusBarCommand('toggleFileHeatmap', '/repo', BLAME, <any>uri, 3)).toMatchObject({ command: 'git-map.toggleFileHeatmap' });
		expect(getStatusBarCommand('toggleCodeLens', '/repo', BLAME, <any>uri, 3)).toMatchObject({ command: 'git-map.toggleCodeLens' });
		expect(getStatusBarCommand('viewLineHistory', '/repo', BLAME, <any>uri, 3)).toMatchObject({ command: 'git-map.viewLineHistory' });
	});

	it('Should show the history of the line for uncommitted lines when the command needs a commit', () => {
		expect(getStatusBarCommand('inspect', '/repo', Object.assign({}, BLAME, { committed: false }), <any>uri, 3)).toMatchObject({ command: 'git-map.viewLineHistory' });
	});
});
