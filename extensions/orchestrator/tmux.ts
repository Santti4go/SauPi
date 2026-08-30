import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface TmuxCommandRunner {
	exec(command: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }>;
}

export interface TmuxWorkerSpec {
	session: string;
	window: string;
	cwd: string;
	command: string[];
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function defaultTmuxSession(projectName: string, cwd: string): string {
	const slug = projectName.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").slice(0, 28) || "project";
	return `pi-${slug}-${createHash("sha256").update(cwd).digest("hex").slice(0, 6)}`;
}

export interface TmuxPaneInfo {
	target: string;
	currentCommand: string;
}

export class TmuxManager {
	constructor(private readonly runner: TmuxCommandRunner) {}

	async available(): Promise<boolean> {
		return (await this.runner.exec("tmux", ["-V"])).code === 0;
	}

	async currentTarget(pane = process.env.TMUX_PANE): Promise<string | undefined> {
		if (!pane) return undefined;
		const result = await this.runner.exec("tmux", [
			"display-message",
			"-p",
			"-t",
			pane,
			"#{session_name}:#{window_index}.#{pane_index}",
		]);
		return result.code === 0 && result.stdout.trim() ? result.stdout.trim() : undefined;
	}

	async hasSession(session: string): Promise<boolean> {
		return (await this.runner.exec("tmux", ["has-session", "-t", session])).code === 0;
	}

	async hasWindow(session: string, window: string): Promise<boolean> {
		const result = await this.runner.exec("tmux", ["list-windows", "-t", session, "-F", "#{window_name}"]);
		return result.code === 0 && result.stdout.split("\n").some((name) => name.trim() === window);
	}

	async paneInfo(session: string, window: string): Promise<TmuxPaneInfo | undefined> {
		const result = await this.runner.exec("tmux", [
			"display-message",
			"-p",
			"-t",
			`${session}:${window}`,
			"#{session_name}:#{window_index}.#{pane_index}\t#{pane_current_command}",
		]);
		if (result.code !== 0 || !result.stdout.trim()) return undefined;
		const [target = "", currentCommand = ""] = result.stdout.trim().split("\t");
		return { target, currentCommand };
	}

	async startWorker(spec: TmuxWorkerSpec): Promise<string> {
		const command = `exec ${spec.command.map(shellQuote).join(" ")}`;
		let createdSession = false;
		if (!(await this.hasSession(spec.session))) {
			const created = await this.runner.exec("tmux", [
				"new-session",
				"-d",
				"-s",
				spec.session,
				"-n",
				spec.window,
				"-c",
				spec.cwd,
				command,
			]);
			if (created.code === 0) createdSession = true;
			else if (!(await this.hasSession(spec.session))) {
				throw new Error(created.stderr.trim() || `Could not create tmux session ${spec.session}`);
			}
		}
		if (!createdSession && !(await this.hasWindow(spec.session, spec.window))) {
			const created = await this.runner.exec("tmux", [
				"new-window",
				"-d",
				"-t",
				spec.session,
				"-n",
				spec.window,
				"-c",
				spec.cwd,
				command,
			]);
			if (created.code !== 0) throw new Error(created.stderr.trim() || `Could not create tmux window ${spec.window}`);
		} else if (!createdSession) {
			const respawned = await this.runner.exec("tmux", [
				"respawn-window",
				"-k",
				"-t",
				`${spec.session}:${spec.window}`,
				"-c",
				spec.cwd,
				command,
			]);
			if (respawned.code !== 0) throw new Error(respawned.stderr.trim() || `Could not respawn tmux window ${spec.window}`);
		}

		await this.runner.exec("tmux", ["set-option", "-w", "-t", `${spec.session}:${spec.window}`, "remain-on-exit", "on"]);
		const target = await this.runner.exec("tmux", [
			"display-message",
			"-p",
			"-t",
			`${spec.session}:${spec.window}`,
			"#{session_name}:#{window_index}.#{pane_index}",
		]);
		if (target.code !== 0 || !target.stdout.trim()) throw new Error(`Could not resolve tmux target for ${spec.window}`);
		return target.stdout.trim();
	}

	async respawnWorker(session: string, window: string, cwd: string, command: string[]): Promise<void> {
		const result = await this.runner.exec("tmux", [
			"respawn-window",
			"-k",
			"-t",
			`${session}:${window}`,
			"-c",
			cwd,
			`exec ${command.map(shellQuote).join(" ")}`,
		]);
		if (result.code !== 0) throw new Error(result.stderr.trim() || `Could not respawn tmux window ${window}`);
	}

	async jump(target: string): Promise<void> {
		const result = await this.runner.exec("tmux", ["switch-client", "-t", target]);
		if (result.code !== 0) throw new Error(result.stderr.trim() || `Could not switch to ${target}`);
	}

	async stopWorker(session: string, window: string): Promise<void> {
		const result = await this.runner.exec("tmux", ["kill-window", "-t", `${session}:${window}`]);
		if (result.code !== 0) throw new Error(result.stderr.trim() || `Could not stop ${window}`);
	}

	async stopSession(session: string): Promise<void> {
		const result = await this.runner.exec("tmux", ["kill-session", "-t", session]);
		if (result.code !== 0) throw new Error(result.stderr.trim() || `Could not stop tmux session ${session}`);
	}
}

export function piTmuxRunner(pi: ExtensionAPI): TmuxCommandRunner {
	return {
		exec: async (command, args) => {
			const result = await pi.exec(command, args);
			return { stdout: result.stdout, stderr: result.stderr, code: result.code };
		},
	};
}
