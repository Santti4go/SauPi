import { existsSync, realpathSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { parse } from "yaml";

export interface ProtectedPathRule {
	source: string;
	absolutePath: string;
	directory: boolean;
}

export interface ProtectionPolicy {
	configPath: string;
	rules: ProtectedPathRule[];
}

const PATH_KEYS = new Set([
	"cwd",
	"destination",
	"destinations",
	"directory",
	"directories",
	"file",
	"filename",
	"files",
	"path",
	"paths",
	"target",
	"targets",
]);

function expandHome(value: string): string {
	if (value === "~") return homedir();
	if (value.startsWith(`~${sep}`) || value.startsWith("~/")) return resolve(homedir(), value.slice(2));
	return value;
}

function canonicalize(inputPath: string, cwd: string): string {
	const expanded = expandHome(inputPath.replace(/^@/, ""));
	const absolute = isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
	let existing = absolute;
	const suffix: string[] = [];

	while (!existsSync(existing)) {
		const parent = dirname(existing);
		if (parent === existing) return absolute;
		suffix.unshift(existing.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
		existing = parent;
	}

	return resolve(realpathSync(existing), ...suffix);
}

function configEntries(document: unknown): string[] {
	if (Array.isArray(document)) return validateEntries(document);
	if (!document || typeof document !== "object") {
		throw new Error("the YAML root must be a list or a mapping");
	}

	const mapping = document as Record<string, unknown>;
	const entries = mapping.protectedPaths ?? mapping.paths ?? mapping.files;
	if (!Array.isArray(entries)) {
		throw new Error('expected a "protectedPaths", "paths", or "files" list');
	}

	return validateEntries(entries);
}

function validateEntries(entries: unknown[]): string[] {
	return entries.map((entry, index) => {
		if (typeof entry !== "string" || entry.trim().length === 0) {
			throw new Error(`entry ${index + 1} must be a non-empty path string`);
		}
		return entry.trim();
	});
}

function createRule(source: string, cwd: string): ProtectedPathRule {
	const directoryHint = /[\\/]$/.test(source);
	const absolutePath = canonicalize(source, cwd);
	const directory = directoryHint || (existsSync(absolutePath) && statSync(absolutePath).isDirectory());
	return { source, absolutePath, directory };
}

export async function loadProtectionPolicy(configPath: string, cwd: string): Promise<ProtectionPolicy | undefined> {
	if (!existsSync(configPath)) return undefined;

	const document = parse(await readFile(configPath, "utf8"));
	const rules = configEntries(document).map((entry) => createRule(entry, cwd));
	rules.push({ source: configPath, absolutePath: canonicalize(configPath, cwd), directory: false });

	const uniqueRules = [...new Map(rules.map((rule) => [`${rule.absolutePath}:${rule.directory}`, rule])).values()];
	return { configPath, rules: uniqueRules };
}

function matchesRule(candidatePath: string, rule: ProtectedPathRule): boolean {
	if (candidatePath === rule.absolutePath) return true;
	if (!rule.directory) return false;
	const child = relative(rule.absolutePath, candidatePath);
	return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function addPathValue(value: unknown, output: string[]): void {
	if (typeof value === "string") output.push(value);
	if (Array.isArray(value)) {
		for (const item of value) addPathValue(item, output);
	}
}

export function collectPathArguments(input: unknown): string[] {
	const output: string[] = [];

	const visit = (value: unknown): void => {
		if (!value || typeof value !== "object" || Array.isArray(value)) return;
		for (const [key, child] of Object.entries(value)) {
			if (PATH_KEYS.has(key.toLowerCase())) addPathValue(child, output);
			if (child && typeof child === "object") visit(child);
		}
	};

	visit(input);
	return output;
}

export function collectShellPathCandidates(command: string): string[] {
	const tokens = command.match(/"(?:\\.|[^"\\])*"|'[^']*'|[^\s;&|()<>]+/g) ?? [];
	const candidates: string[] = [];

	for (const token of tokens) {
		const unquoted = token.replace(/^(['"])(.*)\1$/, "$2").replace(/\\ /g, " ");
		candidates.push(unquoted);
		const assignment = unquoted.indexOf("=");
		if (assignment >= 0 && assignment < unquoted.length - 1) candidates.push(unquoted.slice(assignment + 1));
	}

	return candidates;
}

export function findProtectedTarget(
	policy: ProtectionPolicy,
	input: unknown,
	cwd: string,
	shellCommand?: string,
): { candidate: string; rule: ProtectedPathRule } | undefined {
	const candidates = collectPathArguments(input);
	if (shellCommand) candidates.push(...collectShellPathCandidates(shellCommand));

	for (const candidate of candidates) {
		if (candidate.length === 0 || candidate === "-") continue;
		const absoluteCandidate = canonicalize(candidate, cwd);
		const rule = policy.rules.find((item) => matchesRule(absoluteCandidate, item));
		if (rule) return { candidate, rule };
	}

	return undefined;
}
