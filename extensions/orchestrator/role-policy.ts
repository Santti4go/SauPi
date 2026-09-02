import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, matchesGlob, relative, resolve, sep } from "node:path";
import { parse } from "yaml";

export interface RoleRules {
	allow: string[];
	deny: string[];
	allowOutside: string[];
}

export interface RolePolicy {
	configPath: string;
	roles: Map<string, RoleRules>;
}

function mapping(value: unknown, field: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`"${field}" must be a mapping`);
	return value as Record<string, unknown>;
}

function patterns(value: unknown, field: string, outside = false): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !(item as string).trim())) {
		throw new Error(`"${field}" must be a list of non-empty path globs`);
	}
	return [...new Set(value.map((item) => {
		const pattern = (item as string).trim().replaceAll("\\", "/");
		if (outside ? !isAbsolute(pattern) : isAbsolute(pattern) || pattern.split("/").includes("..")) {
			throw new Error(`"${field}" contains an invalid ${outside ? "absolute" : "project-relative"} path glob: ${pattern}`);
		}
		return pattern;
	}))];
}

export async function loadRolePolicy(configPath: string): Promise<RolePolicy | undefined> {
	if (!existsSync(configPath)) return undefined;
	const source = mapping(parse(await readFile(configPath, "utf8")), "root");
	if (source.version !== 1) throw new Error('"version" must be 1');
	const roles = mapping(source.roles, "roles");
	const parsed = new Map<string, RoleRules>();
	for (const [role, value] of Object.entries(roles)) {
		if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(role)) throw new Error(`invalid role name "${role}"`);
		const rules = mapping(value, `roles.${role}`);
		parsed.set(role, {
			allow: patterns(rules.allow, `roles.${role}.allow`),
			deny: patterns(rules.deny, `roles.${role}.deny`),
			allowOutside: patterns(rules.allowOutside, `roles.${role}.allowOutside`, true),
		});
	}
	return { configPath, roles: parsed };
}

function inside(root: string, path: string): boolean {
	const child = relative(root, path);
	return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

function glob(patterns: string[], path: string): string | undefined {
	return patterns.find((pattern) => matchesGlob(path, pattern));
}

export function evaluateRolePath(rules: RoleRules, root: string, path: string): { allowed: boolean; reason: string; rule?: string } {
	if (inside(root, path)) {
		const projectPath = relative(root, path).replaceAll(sep, "/") || ".";
		const denied = glob(rules.deny, projectPath);
		if (denied) return { allowed: false, reason: "deny", rule: denied };
		const allowed = glob(rules.allow, projectPath) ?? (projectPath === "." ? glob(rules.allow, "**") : undefined);
		return allowed ? { allowed: true, reason: "allow", rule: allowed } : { allowed: false, reason: "no-allow" };
	}
	const denied = glob(rules.deny, path.replaceAll(sep, "/"));
	if (denied) return { allowed: false, reason: "deny", rule: denied };
	const allowed = glob(rules.allowOutside, path.replaceAll(sep, "/"));
	return allowed ? { allowed: true, reason: "allow-outside", rule: allowed } : { allowed: false, reason: "outside-root" };
}

export function policyPath(projectRoot: string): string {
	return resolve(projectRoot, ".pi", "orchestrator-policy.yaml");
}
