import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { FileIconTheme, FileIconThemeDefinition, FileIconThemeMappings } from './types';

/**
 * The file extensions & file names of each language, used to map the language ids of a file icon theme to files.
 */
export interface LanguageFiles {
	[languageId: string]: { extensions: string[], filenames: string[] };
}

/**
 * Get the file extensions & file names of each language contributed by the installed extensions (including the built-in extensions).
 * @returns The file extensions & file names of each language.
 */
export function getLanguageFiles(): LanguageFiles {
	const languages: LanguageFiles = {};
	vscode.extensions.all.forEach((extension) => {
		const contributes = extension.packageJSON && extension.packageJSON.contributes;
		if (!contributes || !Array.isArray(contributes.languages)) return;
		contributes.languages.forEach((language: any) => {
			if (typeof language !== 'object' || language === null || typeof language.id !== 'string') return;
			const files = languages[language.id] || (languages[language.id] = { extensions: [], filenames: [] });
			if (Array.isArray(language.extensions)) files.extensions.push(...language.extensions.filter((extension: any) => typeof extension === 'string'));
			if (Array.isArray(language.filenames)) files.filenames.push(...language.filenames.filter((filename: any) => typeof filename === 'string'));
		});
	});
	return languages;
}

/**
 * Get the root directories of all installed extensions that contribute file icon themes (whose resources the Webview must be able to load).
 * @returns The extension paths.
 */
export function getFileIconThemeExtensionPaths() {
	return vscode.extensions.all
		.filter((extension) => extension.packageJSON && extension.packageJSON.contributes && Array.isArray(extension.packageJSON.contributes.iconThemes))
		.map((extension) => extension.extensionPath);
}

/**
 * Find the definition of the file icon theme used by Visual Studio Code (the setting `workbench.iconTheme`).
 * @returns The id of the file icon theme & the path of its JSON definition, or NULL if no file icon theme is used (or it isn't installed).
 */
export function findFileIconTheme(): { id: string, path: string } | null {
	const id = vscode.workspace.getConfiguration('workbench').get<string | null>('iconTheme', 'vs-seti');
	if (typeof id !== 'string' || id === '') return null;
	for (const extension of vscode.extensions.all) {
		const themes = extension.packageJSON && extension.packageJSON.contributes && extension.packageJSON.contributes.iconThemes;
		if (!Array.isArray(themes)) continue;
		const theme = themes.find((theme: any) => typeof theme === 'object' && theme !== null && theme.id === id && typeof theme.path === 'string');
		if (typeof theme !== 'undefined') return { id: id, path: path.join(extension.extensionPath, theme.path) };
	}
	return null;
}

/**
 * Build the data the Webview needs to display the icons of a file icon theme.
 * @param id The id of the file icon theme.
 * @param jsonPath The path of the JSON definition of the file icon theme.
 * @param toUri A function that converts the absolute path of a resource of the theme (a font or an image) into a URI the Webview can load.
 * @param languages The file extensions & file names of each language (the theme's language ids are mapped to them).
 * @returns The file icon theme, or NULL if its definition couldn't be read.
 */
export function buildFileIconTheme(id: string, jsonPath: string, toUri: (absolutePath: string) => string, languages: LanguageFiles): FileIconTheme | null {
	let json: any;
	try {
		json = JSON.parse(stripJsonComments(fs.readFileSync(jsonPath, 'utf8')));
	} catch (_) {
		return null;
	}
	if (typeof json !== 'object' || json === null) return null;

	// The paths of a theme's resources are relative to its JSON definition
	const directory = path.dirname(jsonPath);
	const fonts = Array.isArray(json.fonts)
		? json.fonts.filter((font: any) => typeof font === 'object' && font !== null && typeof font.id === 'string' && Array.isArray(font.src) && font.src.length > 0 && typeof font.src[0].path === 'string').map((font: any) => ({
			id: font.id,
			src: toUri(path.join(directory, font.src[0].path)),
			format: typeof font.src[0].format === 'string' ? font.src[0].format : null,
			weight: typeof font.weight === 'string' ? font.weight : null,
			style: typeof font.style === 'string' ? font.style : null,
			size: typeof font.size === 'string' ? font.size : null
		}))
		: [];

	const definitions: { [id: string]: FileIconThemeDefinition } = {};
	if (typeof json.iconDefinitions === 'object' && json.iconDefinitions !== null) {
		Object.keys(json.iconDefinitions).forEach((key) => {
			const definition = json.iconDefinitions[key];
			if (typeof definition !== 'object' || definition === null) return;
			definitions[key] = {
				fontCharacter: typeof definition.fontCharacter === 'string' ? decodeFontCharacter(definition.fontCharacter) : null,
				fontColor: typeof definition.fontColor === 'string' ? definition.fontColor : null,
				fontId: typeof definition.fontId === 'string' ? definition.fontId : null,
				fontSize: typeof definition.fontSize === 'string' ? definition.fontSize : null,
				iconPath: typeof definition.iconPath === 'string' ? toUri(path.join(directory, definition.iconPath)) : null
			};
		});
	}

	const getMappings = (section: any): FileIconThemeMappings => {
		const fileExtensions = lowerCaseKeys(section.fileExtensions), fileNames = lowerCaseKeys(section.fileNames);
		// A file's language is used when the theme doesn't have an icon for its name or extension, so the language ids are mapped to the
		// file extensions & names of each language with a lower priority
		if (typeof section.languageIds === 'object' && section.languageIds !== null) {
			Object.keys(section.languageIds).forEach((languageId) => {
				const definition = section.languageIds[languageId], files = languages[languageId];
				if (typeof definition !== 'string' || typeof files === 'undefined') return;
				files.extensions.forEach((extension) => {
					const key = extension.replace(/^\./, '').toLowerCase();
					if (key !== '' && typeof fileExtensions[key] === 'undefined') fileExtensions[key] = definition;
				});
				files.filenames.forEach((filename) => {
					const key = filename.toLowerCase();
					if (typeof fileNames[key] === 'undefined') fileNames[key] = definition;
				});
			});
		}
		return {
			file: typeof section.file === 'string' ? section.file : null,
			folder: typeof section.folder === 'string' ? section.folder : null,
			folderExpanded: typeof section.folderExpanded === 'string' ? section.folderExpanded : null,
			fileExtensions: fileExtensions,
			fileNames: fileNames,
			folderNames: lowerCaseKeys(section.folderNames),
			folderNamesExpanded: lowerCaseKeys(section.folderNamesExpanded)
		};
	};

	return Object.assign({
		id: id,
		fonts: fonts,
		definitions: definitions,
		light: typeof json.light === 'object' && json.light !== null ? getMappings(json.light) : null,
		highContrast: typeof json.highContrast === 'object' && json.highContrast !== null ? getMappings(json.highContrast) : null
	}, getMappings(json));
}

/**
 * Decode the font character of an icon definition, which is the hexadecimal code point of the character escaped with a backslash (e.g. `\E001`).
 * @param fontCharacter The font character.
 * @returns The character.
 */
function decodeFontCharacter(fontCharacter: string) {
	const match = fontCharacter.match(/^\\([0-9a-fA-F]{1,6})$/);
	return match !== null ? String.fromCodePoint(parseInt(match[1], 16)) : fontCharacter;
}

/**
 * Copy the string values of an object, with lower case keys (file names & extensions are matched case-insensitively).
 * @param value The object.
 * @returns The copy.
 */
function lowerCaseKeys(value: any) {
	const result: { [key: string]: string } = {};
	if (typeof value === 'object' && value !== null) {
		Object.keys(value).forEach((key) => {
			if (typeof value[key] === 'string') result[key.toLowerCase()] = value[key];
		});
	}
	return result;
}

/**
 * Remove the comments (and trailing commas) from JSON, as some file icon themes include them.
 * @param text The JSON.
 * @returns The JSON without comments.
 */
function stripJsonComments(text: string) {
	const parts: string[] = [];
	let start = 0, i = 0, inString = false;
	while (i < text.length) {
		const char = text[i];
		if (inString) {
			if (char === '\\') {
				i += 2;
				continue;
			}
			if (char === '"') inString = false;
			i++;
		} else if (char === '"') {
			inString = true;
			i++;
		} else if (char === '/' && text[i + 1] === '/') {
			if (i > start) parts.push(text.slice(start, i));
			while (i < text.length && text[i] !== '\n') i++;
			start = i;
		} else if (char === '/' && text[i + 1] === '*') {
			if (i > start) parts.push(text.slice(start, i));
			const end = text.indexOf('*/', i + 2);
			i = end === -1 ? text.length : end + 2;
			start = i;
		} else {
			i++;
		}
	}
	if (start < text.length) parts.push(text.slice(start));
	return parts.join('').replace(/,(\s*[}\]])/g, '$1');
}
