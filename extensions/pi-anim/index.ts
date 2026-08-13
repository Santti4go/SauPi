import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";

const FRAME_INTERVAL_MS = 85;
const MAX_WIDTH = 76;

type Palette = {
	signal(text: string): string;
	ghost(text: string): string;
	glitch(text: string): string;
};

export function renderSineFrame(width: number, frame: number, palette: Palette): string[] {
	const canvasWidth = Math.max(0, Math.min(width, MAX_WIDTH));
	if (canvasWidth < 8) return [];

	const height = canvasWidth < 28 ? 3 : 5;
	const amplitude = (height - 1) / 2;
	const phase = frame * 0.42;
	const cells = Array.from({ length: height }, () => Array<string>(canvasWidth).fill(" "));

	for (let row = 0; row < height; row++) {
		for (let column = 0; column < canvasWidth; column++) {
			const noise = (column * 31 + row * 17 + Math.floor(frame / 3) * 13) % 97;
			if (noise === 0 || noise === 3) cells[row]![column] = palette.ghost(noise === 0 ? "0" : "1");
		}
	}

	const waveRows = Array.from({ length: canvasWidth }, (_, column) =>
		Math.round(amplitude + Math.sin(column * 0.32 + phase) * amplitude),
	);

	for (let column = 0; column < canvasWidth; column++) {
		const row = waveRows[column]!;
		const nextRow = waveRows[Math.min(column + 1, canvasWidth - 1)]!;
		const glyph = nextRow < row ? "╱" : nextRow > row ? "╲" : "─";
		const isGlitch = (column + frame * 5) % 43 === 0;
		cells[row]![column] = isGlitch ? palette.glitch("▓") : palette.signal(glyph);
	}

	return cells.map((row) => row.join(""));
}

class SineSignalComponent implements Component {
	private frame = 0;
	private readonly timer: ReturnType<typeof setInterval>;

	constructor(
		private readonly tui: TUI,
		private readonly palette: Palette,
	) {
		this.timer = setInterval(() => {
			this.frame++;
			this.tui.requestRender();
		}, FRAME_INTERVAL_MS);
		this.timer.unref?.();
	}

	render(width: number): string[] {
		return renderSineFrame(width, this.frame, this.palette);
	}

	invalidate(): void {
		this.tui.requestRender();
	}

	dispose(): void {
		clearInterval(this.timer);
	}
}

export default function piAnimation(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;

		// Pi conserva este mensaje personalizado entre recreaciones del loader.
		ctx.ui.setWorkingMessage("PHANTOM SIGNAL // MODEL PROCESSING");
	});

	pi.on("agent_start", (_event, ctx) => {
		if (!ctx.hasUI) return;

		// El widget de Pi se monta sólo durante el ciclo activo del agente.
		ctx.ui.setWidget("pi-anim", (tui, theme) =>
			new SineSignalComponent(tui, {
				signal: (text) => theme.fg("success", text),
				ghost: (text) => theme.fg("dim", text),
				glitch: (text) => theme.fg("error", text),
			}),
		);
	});

	const clearWidget = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		ctx.ui.setWidget("pi-anim", undefined);
	};

	pi.on("agent_end", (_event, ctx) => clearWidget(ctx));
	pi.on("session_shutdown", (_event, ctx) => clearWidget(ctx));
}
