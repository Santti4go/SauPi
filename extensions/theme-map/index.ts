import { basename, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	loadThemeMapConfig,
	selectInitialProfile,
	type ThemeMapConfig,
	type ThemeProfile,
} from "./config.ts";

const DEFAULT_CONFIG_PATH = ".pi/theme-map.yaml";

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isMissingFile(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export default function themeMap(pi: ExtensionAPI): void {
	let config: ThemeMapConfig | undefined;
	let activeProfile: string | undefined;
	let originalTheme: Theme | undefined;

	// Pi expone las selecciones de arranque como flags propias de la extensión.
	pi.registerFlag("theme-map-config", {
		description: "Path to the project theme profile map",
		type: "string",
		default: DEFAULT_CONFIG_PATH,
	});
	pi.registerFlag("theme-profile", {
		description: "Theme profile to activate at startup",
		type: "string",
	});

	const configPath = (cwd: string): string => {
		const value = pi.getFlag("theme-map-config");
		return resolve(cwd, typeof value === "string" ? value : DEFAULT_CONFIG_PATH);
	};

	const applyTheme = (profileName: string, profile: ThemeProfile, ctx: ExtensionContext): boolean => {
		const selectedTheme = ctx.ui.getTheme(profile.theme);
		const fallbackTheme = config?.fallbackTheme ? ctx.ui.getTheme(config.fallbackTheme) : undefined;
		const theme = selectedTheme ?? fallbackTheme;
		if (!theme) {
			const fallback = config?.fallbackTheme ? `; fallback "${config.fallbackTheme}" is also unavailable` : "";
			ctx.ui.notify(`Theme map: theme "${profile.theme}" is unavailable${fallback}`, "error");
			return false;
		}

		// Pasar la instancia a setTheme aplica el perfil sin persistirlo en settings globales.
		const result = ctx.ui.setTheme(theme);
		if (!result.success) {
			ctx.ui.notify(`Theme map: ${result.error ?? `could not apply "${profile.theme}"`}`, "error");
			return false;
		}

		activeProfile = profileName;
		if (profile.title) ctx.ui.setTitle(profile.title);
		ctx.ui.setStatus("theme-map", `theme: ${profileName}`);
		return true;
	};

	const activate = (profileName: string, ctx: ExtensionContext): boolean => {
		const profile = config?.profiles[profileName];
		if (!profile) {
			ctx.ui.notify(`Theme map: unknown profile "${profileName}"`, "error");
			return false;
		}
		return applyTheme(profileName, profile, ctx);
	};

	const restore = (ctx: ExtensionContext): void => {
		if (originalTheme) ctx.ui.setTheme(originalTheme);
		activeProfile = undefined;
		ctx.ui.setStatus("theme-map", undefined);
		ctx.ui.setTitle(`π - ${basename(ctx.cwd)}`);
	};

	const loadConfig = async (ctx: ExtensionContext): Promise<boolean> => {
		try {
			config = await loadThemeMapConfig(configPath(ctx.cwd));
			return true;
		} catch (error) {
			config = undefined;
			if (isMissingFile(error)) return true;
			ctx.ui.notify(`Theme map config error: ${message(error)}`, "error");
			return false;
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI || ctx.ui.getAllThemes().length === 0) return;
		originalTheme = ctx.ui.theme;
		if (!(await loadConfig(ctx)) || !config) return;

		const requested = pi.getFlag("theme-profile");
		const profileName = selectInitialProfile(
			config,
			typeof requested === "string" ? requested : undefined,
			process.argv,
		);
		if (profileName) activate(profileName, ctx);
	});

	// El comando de Pi permite seleccionar, recargar o restaurar perfiles en caliente.
	pi.registerCommand("theme-map", {
		description: "Select a theme profile, reload its YAML, or restore the original theme",
		handler: async (args, ctx) => {
			if (!ctx.hasUI || ctx.ui.getAllThemes().length === 0) return;
			const action = args.trim();

			if (action === "reload") {
				if (!(await loadConfig(ctx)) || !config) return;
				if (activeProfile && config.profiles[activeProfile]) activate(activeProfile, ctx);
				ctx.ui.notify("Theme map reloaded", "info");
				return;
			}

			if (action === "off" || action === "reset") {
				restore(ctx);
				return;
			}

			if (!config && !(await loadConfig(ctx))) return;
			if (!config) return;
			if (action) {
				activate(action, ctx);
				return;
			}

			const options = [...Object.keys(config.profiles), "(restore original)"];
			const selected = await ctx.ui.select("Theme profile", options);
			if (!selected) return;
			if (selected === "(restore original)") restore(ctx);
			else activate(selected, ctx);
		},
	});
}
