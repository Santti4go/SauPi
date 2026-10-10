import type { BuildSystemPromptOptions, BeforeAgentStartEvent } from "@earendil-works/pi-coding-agent";

/** Compact instruction prose, but preserve fenced and indented code verbatim. */
export function stripInstructionMarkdown(markdown: string): string {
	const parts: string[] = [];
	let prose: string[] = [];
	let fence: { marker: string; length: number } | undefined;
	let code: string[] = [];
	const flushProse = () => {
		const text = prose.join(" ").replace(/[ \t]+/g, " ").trim();
		if (text) parts.push(text);
		prose = [];
	};
	const flushCode = () => {
		if (code.length) parts.push(code.join("\n"));
		code = [];
	};
	for (const line of markdown.split(/\r\n|\n|\r/)) {
		if (fence) {
			code.push(line);
			const closing = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
			if (closing && closing[1]![0] === fence.marker && closing[1]!.length >= fence.length) {
				fence = undefined;
				flushCode();
			}
			continue;
		}
		const opening = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
		if (opening && !(opening[1]![0] === "`" && opening[2]!.includes("`"))) {
			flushProse();
			flushCode();
			fence = { marker: opening[1]![0]!, length: opening[1]!.length };
			code.push(line);
		} else if (/^( {4}|\t)/.test(line) && !line.trimStart().startsWith("<")) {
			flushProse();
			code.push(line);
		} else {
			flushCode();
			// Only Markdown headings: keep hashes in URLs, C#, and inline code.
			const heading = /^ {0,3}#{1,6}(?:[ \t]+|$)/;
			prose.push(heading.test(line)
				? line.replace(heading, "").replace(/[ \t]+#+[ \t]*$/, "")
				: line);
		}
	}
	flushProse();
	flushCode();
	return parts.join("\n");
}

export function stripInstructionOptions(options: BuildSystemPromptOptions): void {
	if (options.customPrompt !== undefined) options.customPrompt = stripInstructionMarkdown(options.customPrompt);
	if (options.appendSystemPrompt !== undefined) options.appendSystemPrompt = stripInstructionMarkdown(options.appendSystemPrompt);
	options.contextFiles = options.contextFiles?.map((file) => /\.md$/i.test(file.path)
		? { ...file, content: stripInstructionMarkdown(file.content) }
		: file) ?? [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Only provider instruction fields, never user/assistant text or tool arguments. */
export function stripProviderInstructions(payload: unknown): unknown {
	if (!isRecord(payload)) return payload;
	const compactContent = (content: unknown): unknown => {
		if (typeof content === "string") return stripInstructionMarkdown(content);
		if (!Array.isArray(content)) return content;
		return content.map((block) => isRecord(block) && typeof block.text === "string" &&
			(block.type === undefined || block.type === "text" || block.type === "input_text")
			? { ...block, text: stripInstructionMarkdown(block.text) } : block);
	};
	const result = { ...payload };
	if (typeof result.instructions === "string") result.instructions = compactContent(result.instructions);
	if (typeof result.system === "string" || Array.isArray(result.system)) result.system = compactContent(result.system);
	if (isRecord(result.systemInstruction)) {
		result.systemInstruction = { ...result.systemInstruction, parts: compactContent(result.systemInstruction.parts) };
	}
	for (const key of ["messages", "input"]) {
		if (Array.isArray(result[key])) {
			result[key] = result[key].map((message) => isRecord(message) &&
				(message.role === "system" || message.role === "developer")
				? { ...message, content: compactContent(message.content) } : message);
		}
	}
	return result;
}

/** Called by the existing instruction hook, not a separately loaded extension. */
export function compactAgentInstructions(event: Pick<BeforeAgentStartEvent, "systemPromptOptions" | "systemPrompt">) {
	const options = event.systemPromptOptions;
	// Older Pi versions expose options but do not rebuild after mutation.
	const originals = [options.customPrompt, options.appendSystemPrompt,
		...(options.contextFiles ?? []).filter((file) => /\.md$/i.test(file.path)).map((file) => file.content)]
		.filter((text): text is string => Boolean(text));
	stripInstructionOptions(options);
	if (!("sections" in options)) {
		let prompt = event.systemPrompt;
		for (const original of [...new Set(originals)].sort((a, b) => b.length - a.length)) {
			prompt = prompt.replaceAll(original, stripInstructionMarkdown(original));
		}
		if (prompt !== event.systemPrompt) return { systemPrompt: prompt };
	}
}
