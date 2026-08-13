import { readFile } from "node:fs/promises";
import { parse } from "yaml";

export interface ThemeProfile {
	theme: string;
	title?: string;
}

export interface ThemeMapConfig {
	activeProfile?: string;
	defaultProfile?: string;
	fallbackTheme?: string;
	profiles: Record<string, ThemeProfile>;
}

function optionalString(value: unknown, field: string): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`"${field}" must be a non-empty string`);
	}
	return value.trim();
}

function parseProfile(name: string, value: unknown): ThemeProfile {
	if (typeof value === "string") return { theme: optionalString(value, `profiles.${name}`)! };
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`profile "${name}" must be a theme name or mapping`);
	}

	const profile = value as Record<string, unknown>;
	const theme = optionalString(profile.theme, `profiles.${name}.theme`);
	if (!theme) throw new Error(`profile "${name}" is missing "theme"`);
	const title = optionalString(profile.title, `profiles.${name}.title`);
	return title ? { theme, title } : { theme };
}

export function parseThemeMapConfig(document: unknown): ThemeMapConfig {
	if (!document || typeof document !== "object" || Array.isArray(document)) {
		throw new Error("the YAML root must be a mapping");
	}

	const mapping = document as Record<string, unknown>;
	if (!mapping.profiles || typeof mapping.profiles !== "object" || Array.isArray(mapping.profiles)) {
		throw new Error('expected a "profiles" mapping');
	}

	const profiles = Object.fromEntries(
		Object.entries(mapping.profiles as Record<string, unknown>).map(([name, value]) => {
			if (name.trim().length === 0) throw new Error("profile names cannot be empty");
			return [name, parseProfile(name, value)];
		}),
	);
	if (Object.keys(profiles).length === 0) throw new Error('"profiles" cannot be empty');

	const activeProfile = optionalString(mapping.activeProfile, "activeProfile");
	const defaultProfile = optionalString(mapping.defaultProfile, "defaultProfile");
	const fallbackTheme = optionalString(mapping.fallbackTheme, "fallbackTheme");
	for (const [field, profile] of [
		["activeProfile", activeProfile],
		["defaultProfile", defaultProfile],
	] as const) {
		if (profile && !profiles[profile]) throw new Error(`"${field}" references unknown profile "${profile}"`);
	}

	return {
		...(activeProfile ? { activeProfile } : {}),
		...(defaultProfile ? { defaultProfile } : {}),
		...(fallbackTheme ? { fallbackTheme } : {}),
		profiles,
	};
}

export async function loadThemeMapConfig(path: string): Promise<ThemeMapConfig> {
	return parseThemeMapConfig(parse(await readFile(path, "utf8")));
}

export function explicitExtensionNames(argv: readonly string[]): string[] {
	const names: string[] = [];
	for (let index = 0; index < argv.length; index++) {
		const argument = argv[index]!;
		let path: string | undefined;
		if (argument === "-e" || argument === "--extension") path = argv[++index];
		else if (argument.startsWith("--extension=")) path = argument.slice("--extension=".length);
		if (!path) continue;

		const normalized = path.replace(/\\/g, "/").replace(/\/$/, "");
		const filename = normalized.slice(normalized.lastIndexOf("/") + 1);
		names.push(filename.replace(/\.[^.]+$/, ""));
	}
	return names;
}

export function selectInitialProfile(
	config: ThemeMapConfig,
	cliProfile: string | undefined,
	argv: readonly string[],
): string | undefined {
	if (cliProfile) return cliProfile;
	if (config.activeProfile) return config.activeProfile;
	const explicitMatch = explicitExtensionNames(argv).find((name) => config.profiles[name]);
	return explicitMatch ?? config.defaultProfile;
}
