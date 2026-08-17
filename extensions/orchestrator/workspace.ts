import { mkdir, stat } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentInstance } from "./registry.ts";

export interface PreparedWorkspace {
	path: string;
	root: string;
	branch?: string;
}

function branchName(id: string): string {
	return `pi-agent/${id}`;
}

export async function prepareWorkspace(
	pi: ExtensionAPI,
	instance: AgentInstance,
	worktreeRoot: string | undefined,
): Promise<PreparedWorkspace> {
	if (instance.definition.workspace === "shared") {
		const result = await pi.exec("git", ["-C", instance.definition.cwd, "rev-parse", "--show-toplevel"]);
		return { path: instance.definition.cwd, root: result.code === 0 ? result.stdout.trim() : instance.definition.cwd };
	}

	const gitRootResult = await pi.exec("git", ["-C", instance.definition.cwd, "rev-parse", "--show-toplevel"]);
	if (gitRootResult.code !== 0) throw new Error(`Agent ${instance.id} requires a Git repository for worktree isolation`);
	const gitRoot = gitRootResult.stdout.trim();
	const relativeCwd = relative(gitRoot, instance.definition.cwd);
	const root = worktreeRoot ?? resolve(dirname(gitRoot), ".pi-worktrees", basename(gitRoot));
	const worktreePath = resolve(root, instance.id);
	const path = resolve(worktreePath, relativeCwd);
	const branch = branchName(instance.id);
	await mkdir(root, { recursive: true, mode: 0o700 });

	const existing = await stat(worktreePath).catch(() => undefined);
	if (existing) {
		const valid = await pi.exec("git", ["-C", worktreePath, "rev-parse", "--show-toplevel"]);
		if (valid.code !== 0) throw new Error(`Worktree path exists but is not a Git worktree: ${worktreePath}`);
		return { path, root: worktreePath, branch };
	}

	const branchExists = (await pi.exec("git", ["-C", gitRoot, "show-ref", "--verify", `refs/heads/${branch}`])).code === 0;
	const args = branchExists
		? ["-C", gitRoot, "worktree", "add", worktreePath, branch]
		: ["-C", gitRoot, "worktree", "add", "-b", branch, worktreePath, "HEAD"];
	const created = await pi.exec("git", args);
	if (created.code !== 0) throw new Error(created.stderr.trim() || `Could not create worktree for ${instance.id}`);
	return { path, root: worktreePath, branch };
}
