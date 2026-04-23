import { completeSimple, type Message, type UserMessage } from "@mariozechner/pi-ai";
import { Text } from "@mariozechner/pi-tui";
import { serializeConversation } from "@mariozechner/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@mariozechner/pi-coding-agent";

const WIDGET_KEY = "session-synopsis";
const SETTINGS_ENTRY_TYPE = "session-synopsis-settings";
const SUMMARY_MODEL_CANDIDATES = [
	{ provider: "openai-codex", modelId: "gpt-5.4-mini" },
	{ provider: "openai", modelId: "gpt-5.4-mini" },
	{ provider: "openrouter", modelId: "openai/gpt-5.4-mini" },
] as const;

const MAX_RECENT_ENTRIES = 160;
const MAX_CONTEXT_CHARS = 12000;
const MAX_SUMMARY_GENERATION_TOKENS = 160;
const MAX_SUMMARY_LINE = 220;
const SUMMARY_IDLE_DELAY_MS = 30_000;

const SYNOPSIS_SYSTEM_PROMPT = `You are a coding session recap assistant.

Your job is to compress a coding conversation into one concise line that helps someone quickly recall what the session was actually about.

Focus on the real task, bug, feature, or decision being worked on.
Do not mention tool calls, edits, file operations, or generic activity unless that is the only concrete signal.
Return only the summary text with no label, bullets, or extra commentary.`;

interface SynopsisState {
	enabled: boolean;
	synopsis?: string;
	lastSummarizedLeafId?: string;
	generation: number;
	inFlight: boolean;
	pending: boolean;
	pendingCtx?: ExtensionContext;
	idleTimer?: ReturnType<typeof setTimeout>;
}

interface SummaryMessage {
	role: "user" | "assistant";
	content: Array<{ type: "text"; text: string }>;
	timestamp: number;
}

function normalizeWhitespace(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function truncateText(text: string, max: number): string {
	if (!text) return text;
	if (text.length <= max) return text;
	return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

type MessageLike = { role?: unknown; content?: unknown; timestamp?: unknown; toolName?: unknown };

function toTimestamp(value: unknown): number {
	if (typeof value === "number") return value;
	if (typeof value === "string") {
		const parsed = Date.parse(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return Date.now();
}

function extractTextFromContent(content: unknown): string {
	if (typeof content === "string") {
		return normalizeWhitespace(content);
	}
	if (!Array.isArray(content)) {
		return "";
	}

	const parts: string[] = [];
	let hasImage = false;

	for (const block of content) {
		if (typeof block === "string") {
			parts.push(normalizeWhitespace(block));
			continue;
		}
		if (!block || typeof block !== "object") continue;

		const kind = typeof (block as { type?: unknown }).type === "string" ? (block as { type: string }).type : "";
		if (kind === "text") {
			const text = typeof (block as { text?: unknown }).text === "string" ? (block as { text: string }).text : "";
			if (text) parts.push(normalizeWhitespace(text));
			continue;
		}

		if (kind === "toolCall") {
			continue;
		}

		if (kind === "image") {
			hasImage = true;
		}
	}

	const merged = normalizeWhitespace(parts.join(" "));
	if (merged) return merged;
	if (hasImage) return "[image attached]";
	return "";
}

function entryToSummaryMessages(entry: SessionEntry): SummaryMessage[] {
	switch (entry.type) {
		case "message": {
			const message = entry.message as MessageLike;
			if (!message || typeof message !== "object") return [];

			const role = message.role;
			const contentText = extractTextFromContent(message.content);
			const timestamp = toTimestamp(message.timestamp);

			if (role === "user" || role === "assistant") {
				if (!contentText) return [];
				return [{ role: role as "user" | "assistant", content: [{ type: "text", text: contentText }], timestamp }];
			}

			if (role === "toolResult") {
				return [];
			}

			return [];
		}
		case "custom_message": {
			const text = typeof entry.content === "string" ? normalizeWhitespace(entry.content) : extractTextFromContent(entry.content);
			if (!text) return [];
			return [
				{
					role: "user",
					content: [{ type: "text", text: `Context note (${entry.customType}): ${text}` }],
					timestamp: toTimestamp(entry.timestamp),
				},
			];
		}
		case "compaction": {
			if (!entry.summary) return [];
			return [
				{
					role: "user",
					content: [{ type: "text", text: `Compaction summary:
${entry.summary}` }],
					timestamp: toTimestamp(entry.timestamp),
				},
			];
		}
		case "branch_summary": {
			if (!entry.summary) return [];
			return [
				{
					role: "user",
					content: [{ type: "text", text: `Branch summary:
${entry.summary}` }],
					timestamp: toTimestamp(entry.timestamp),
				},
			];
		}
		default:
			return [];
	}
}

function buildConversationText(branchEntries: SessionEntry[], startAfterLeafId?: string): string {
	if (branchEntries.length === 0) return "";

	let entries = branchEntries;
	if (startAfterLeafId) {
		const startIndex = branchEntries.findIndex((entry) => entry.id === startAfterLeafId);
		if (startIndex >= 0) {
			entries = branchEntries.slice(startIndex + 1);
		}
	}

	if (entries.length > MAX_RECENT_ENTRIES) {
		entries = entries.slice(-MAX_RECENT_ENTRIES);
	}

	const messages = entries.flatMap(entryToSummaryMessages);
	if (messages.length === 0) return "";

	const text = serializeConversation(messages as Message[]);
	return text.length > MAX_CONTEXT_CHARS ? text.slice(-MAX_CONTEXT_CHARS) : text;
}

function buildSynopsisPrompt(conversationText: string, previousSynopsis?: string): string {
	const previous = previousSynopsis
		? `

Existing summary to update:
${previousSynopsis}`
		: "\n\nNo existing summary.";

	return `Based on the conversation snippet below, create one concise session synopsis.

Recent conversation:\n<conversation>\n${conversationText}\n</conversation>${previous}

Return exactly one line describing what the session was actually about.

Rules:
- Focus on the real task, bug, feature, or decision.
- Prefer concrete nouns like feature names, bugs, files, providers, or commands when helpful.
- Do not mention tool calls, patches, or generic editing activity.
- If context is incomplete, still make the best specific summary you can.
- Keep it under 220 characters.`.trim();
}

function getEntriesAfterLeafId(branchEntries: SessionEntry[], startAfterLeafId?: string): SessionEntry[] {
	if (!startAfterLeafId) return branchEntries;
	const startIndex = branchEntries.findIndex((entry) => entry.id === startAfterLeafId);
	return startIndex >= 0 ? branchEntries.slice(startIndex + 1) : branchEntries;
}

function shortenPath(path: string): string {
	const home = process.env.HOME;
	if (home && path.startsWith(home)) {
		return `~${path.slice(home.length)}`;
	}
	return path;
}

function isLowSignalUserText(text: string): boolean {
	const normalized = normalizeWhitespace(text).toLowerCase();
	if (!normalized) return true;
	if (normalized.length < 14) return true;
	if (
		normalized === "continue" ||
		normalized === "continue*" ||
		normalized === "then fix it" ||
		normalized === "fix it" ||
		normalized === "now" ||
		normalized === "now*" ||
		normalized === "ok" ||
		normalized === "reload"
	) {
		return true;
	}
	return false;
}

function parseSynopsis(summary?: string): string | undefined {
	if (!summary) return undefined;
	const lines = summary
		.split(/\r?\n/)
		.map((line) => normalizeWhitespace(line))
		.map((line) => line.replace(/^What was being worked on:\s*/i, ""))
		.map((line) => line.replace(/^Next steps:\s*/i, ""))
		.filter((line) => line.length > 0);
	return lines[0];
}

function isLowSignalSummary(text?: string): boolean {
	if (!text) return true;
	const normalized = normalizeWhitespace(text);
	if (!normalized) return true;
	return (
		normalized === "Context not available" ||
		normalized === "unknown" ||
		normalized === "(insufficient context)" ||
		normalized === "(uncertain)" ||
		normalized.startsWith("Tool result")
	);
}

function findLatestUserRequest(entries: SessionEntry[]): string | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "message") continue;
		const message = entry.message as MessageLike;
		if (message.role !== "user") continue;
		const text = extractTextFromContent(message.content);
		if (!text || isLowSignalUserText(text)) continue;
		return text;
	}
	return undefined;
}

function findRecentFilePath(entries: SessionEntry[]): string | undefined {
	const pathPattern = /(\/Users\/[^\s"'`),:;]+|~\/[^\s"'`),:;]+)/g;

	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "message") continue;
		const message = entry.message as MessageLike;
		const text = extractTextFromContent(message.content);
		if (!text) continue;
		const matches = text.match(pathPattern);
		if (matches && matches.length > 0) {
			return matches[0];
		}
	}
	return undefined;
}

function describeRecentWork(filePath: string): string {
	const shortPath = shortenPath(filePath);
	if (shortPath.endsWith("/session-name.ts") || shortPath.endsWith("/session-recap/src/index.ts")) {
		return `debugging the session recap extension in ${shortPath}`;
	}
	return `editing ${shortPath}`;
}

function buildFallbackSynopsis(
	branchEntries: SessionEntry[],
	startAfterLeafId?: string,
	previousSynopsis?: string,
): string {
	const deltaEntries = getEntriesAfterLeafId(branchEntries, startAfterLeafId);
	const previous = parseSynopsis(previousSynopsis);
	const deltaUserRequest = findLatestUserRequest(deltaEntries);
	const fullUserRequest = findLatestUserRequest(branchEntries);
	const recentFilePath = findRecentFilePath(deltaEntries) ?? findRecentFilePath(branchEntries);

	const summary = !isLowSignalSummary(previous)
		? previous
		: deltaUserRequest ?? fullUserRequest ?? (recentFilePath ? describeRecentWork(recentFilePath) : "Context not available");

	return truncateText(summary || "Context not available", MAX_SUMMARY_LINE);
}

function stripLinePrefix(line: string): string {
	return line
		.replace(/^\s*[-*•]\s*/u, "")
		.replace(/^\s*\d+\.\s*/u, "")
		.trim();
}

function extractByLabel(lines: string[], labelPattern: RegExp): string | undefined {
	for (const raw of lines) {
		const trimmed = stripLinePrefix(raw);
		const match = trimmed.match(labelPattern);
		if (match) {
			return trimText(trimmed);
		}
	}
	return undefined;
}

function trimText(text: string): string {
	return normalizeWhitespace(text);
}

function normalizeSynopsis(rawSynopsis: string): string {
	const raw = rawSynopsis.trim();
	if (!raw) {
		return "unknown";
	}

	const lines = raw
		.split(/\r?\n/)
		.map(stripLinePrefix)
		.map(trimText)
		.map((line) => line.replace(/^What was being worked on:\s*/i, ""))
		.map((line) => line.replace(/^Next steps:\s*/i, ""))
		.filter(Boolean);

	const workingMatch =
		extractByLabel(lines, /^(what\s+was\s+being\s+worked\s+on|what\s+I\s+was\s+working\s+on|working\s+on|current\s+focus|current\s*task|goal|what\s+is\s+it\s+about|status)\s*[:\-]\s*(.*)$/iu);

	const summary = workingMatch
		? workingMatch.replace(/^(?:What\s+was\s+being\s+worked\s+on|what\s+I\s+was\s+working\s+on|working\s+on|current\s+focus|current\s*task|goal|what\s+is\s+it\s+about|status)\s*[:\-]\s*/iu, "").trim()
		: lines.find((line) => !/^next\s+steps?\s*[:\-]/iu.test(line)) ?? lines[0] ?? "unknown";

	return truncateText(normalizeWhitespace(summary || "unknown"), MAX_SUMMARY_LINE);
}

function renderSynopsis(ctx: ExtensionContext, summary: string | undefined): void {
	if (!ctx.hasUI) return;
	if (!summary) {
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		return;
	}

	ctx.ui.setWidget(
		WIDGET_KEY,
		(_tui, theme) => new Text(theme.fg("muted", summary), 1, 0),
		{ placement: "aboveEditor" },
	);
}

function getPersistedEnabledState(ctx: ExtensionContext): boolean {
	const entries = ctx.sessionManager.getEntries();
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "custom" || entry.customType !== SETTINGS_ENTRY_TYPE) continue;
		const data = entry.data as { enabled?: unknown } | undefined;
		if (typeof data?.enabled === "boolean") {
			return data.enabled;
		}
	}
	return true;
}

export default function (pi: ExtensionAPI) {
	const state: SynopsisState = {
		enabled: true,
		generation: 0,
		inFlight: false,
		pending: false,
	};

	const clearScheduledUpdate = (): void => {
		if (state.idleTimer) {
			clearTimeout(state.idleTimer);
			state.idleTimer = undefined;
		}
	};

	const reset = (ctx: ExtensionContext) => {
		clearScheduledUpdate();
		state.enabled = getPersistedEnabledState(ctx);
		state.generation += 1;
		state.synopsis = undefined;
		state.lastSummarizedLeafId = undefined;
		state.inFlight = false;
		state.pending = false;
		state.pendingCtx = undefined;
		renderSynopsis(ctx, undefined);
	};

	const generateSynopsis = async (ctx: ExtensionContext) => {
		if (!ctx.hasUI || !state.enabled || !ctx.isIdle()) return;
		if (state.inFlight) {
			state.pending = true;
			state.pendingCtx = ctx;
			return;
		}

		state.inFlight = true;
		const generation = ++state.generation;

		try {
			const branch = ctx.sessionManager.getBranch();
			const conversationText = buildConversationText(branch, state.lastSummarizedLeafId);
			if (!conversationText) {
				renderSynopsis(ctx, state.enabled ? state.synopsis : undefined);
				return;
			}

			let model: ReturnType<(typeof ctx.modelRegistry.find)> | null = null;
			let auth: Awaited<ReturnType<typeof ctx.modelRegistry.getApiKeyAndHeaders>> | undefined;

			for (const candidate of SUMMARY_MODEL_CANDIDATES) {
				const candidateModel = ctx.modelRegistry.find(candidate.provider, candidate.modelId);
				if (!candidateModel) {
					continue;
				}

				const candidateAuth = await ctx.modelRegistry.getApiKeyAndHeaders(candidateModel);
				if (candidateAuth.ok) {
					model = candidateModel;
					auth = candidateAuth;
					break;
				}
			}

			if (!model && ctx.model) {
				const fallbackAuth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
				if (fallbackAuth.ok) {
					model = ctx.model;
					auth = fallbackAuth;
				}
			}

			if (!model) {
				state.synopsis = buildFallbackSynopsis(branch, state.lastSummarizedLeafId, state.synopsis);
				state.lastSummarizedLeafId = branch.at(-1)?.id;
				renderSynopsis(ctx, state.synopsis);
				return;
			}
			if (!auth || !auth.ok) {
				state.synopsis = buildFallbackSynopsis(branch, state.lastSummarizedLeafId, state.synopsis);
				state.lastSummarizedLeafId = branch.at(-1)?.id;
				renderSynopsis(ctx, state.synopsis);
				return;
			}

			const userMessage: UserMessage = {
				role: "user",
				timestamp: Date.now(),
				content: [
					{
						type: "text",
						text: buildSynopsisPrompt(conversationText, state.synopsis),
					},
				],
			};

			try {
				const response = await completeSimple(
					model,
					{ systemPrompt: SYNOPSIS_SYSTEM_PROMPT, messages: [userMessage] },
					{
						apiKey: auth.apiKey,
						headers: auth.headers,
						maxTokens: MAX_SUMMARY_GENERATION_TOKENS,
						reasoning: "minimal",
					},
				);

				if (generation !== state.generation || !ctx.hasUI || !state.enabled || !ctx.isIdle()) {
					return;
				}
				if (response.stopReason === "error" || response.stopReason === "aborted") {
					state.synopsis = buildFallbackSynopsis(branch, state.lastSummarizedLeafId, state.synopsis);
					state.lastSummarizedLeafId = branch.at(-1)?.id;
					renderSynopsis(ctx, state.synopsis);
					return;
				}

				const raw = response.content
					.filter((block): block is { type: "text"; text: string } => block.type === "text")
					.map((block) => block.text)
					.join("\n")
					.trim();

				if (!raw) {
					state.synopsis = buildFallbackSynopsis(branch, state.lastSummarizedLeafId, state.synopsis);
					state.lastSummarizedLeafId = branch.at(-1)?.id;
					renderSynopsis(ctx, state.synopsis);
					return;
				}

				state.synopsis = normalizeSynopsis(raw);
				state.lastSummarizedLeafId = branch.at(-1)?.id;
				renderSynopsis(ctx, state.synopsis);
			} catch {
				state.synopsis = buildFallbackSynopsis(branch, state.lastSummarizedLeafId, state.synopsis);
				state.lastSummarizedLeafId = branch.at(-1)?.id;
				renderSynopsis(ctx, state.synopsis);
			}
		} finally {
			const retry = state.pending;
			const nextCtx = state.pendingCtx ?? ctx;
			state.inFlight = false;
			state.pending = false;
			state.pendingCtx = undefined;

			if (retry && nextCtx) {
				void generateSynopsis(nextCtx);
			}
		}
	};

	const scheduleUpdate = (ctx: ExtensionContext): void => {
		clearScheduledUpdate();
		if (!ctx.hasUI || !state.enabled) return;
		void generateSynopsis(ctx);
	};

	const scheduleIdleUpdate = (ctx: ExtensionContext): void => {
		clearScheduledUpdate();
		if (!ctx.hasUI || !state.enabled) return;
		state.idleTimer = setTimeout(() => {
			state.idleTimer = undefined;
			void generateSynopsis(ctx);
		}, SUMMARY_IDLE_DELAY_MS);
	};

	const setEnabled = (ctx: ExtensionContext, enabled: boolean): void => {
		clearScheduledUpdate();
		state.enabled = enabled;
		state.generation += 1;
		state.pending = false;
		state.pendingCtx = undefined;

		if (!enabled) {
			renderSynopsis(ctx, undefined);
			return;
		}

		renderSynopsis(ctx, state.synopsis);
		scheduleUpdate(ctx);
	};

	pi.registerCommand("summary", {
		description: "Show, hide, or toggle the session synopsis (usage: /summary [on|off|toggle|status])",
		handler: async (args, ctx) => {
			const action = normalizeWhitespace(args).toLowerCase() || "status";

			if (action === "status") {
				ctx.ui.notify(`Summary: ${state.enabled ? "on" : "off"}`, "info");
				return;
			}

			if (action === "on") {
				pi.appendEntry(SETTINGS_ENTRY_TYPE, { enabled: true });
				setEnabled(ctx, true);
				ctx.ui.notify("Summary enabled", "info");
				return;
			}

			if (action === "off") {
				pi.appendEntry(SETTINGS_ENTRY_TYPE, { enabled: false });
				setEnabled(ctx, false);
				ctx.ui.notify("Summary hidden", "info");
				return;
			}

			if (action === "toggle") {
				const nextEnabled = !state.enabled;
				pi.appendEntry(SETTINGS_ENTRY_TYPE, { enabled: nextEnabled });
				setEnabled(ctx, nextEnabled);
				ctx.ui.notify(nextEnabled ? "Summary enabled" : "Summary hidden", "info");
				return;
			}

			ctx.ui.notify("Usage: /summary [on|off|toggle|status]", "warning");
		},
	});

	pi.on("session_start", (_event, ctx) => {
		reset(ctx);
	});

	pi.on("session_tree", (_event, ctx) => {
		reset(ctx);
		scheduleUpdate(ctx);
	});

	pi.on("agent_start", () => {
		clearScheduledUpdate();
	});

	pi.on("agent_end", (_event, ctx) => {
		scheduleIdleUpdate(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		clearScheduledUpdate();
		state.pendingCtx = undefined;
		state.pending = false;
		state.inFlight = false;
		renderSynopsis(ctx, undefined);
	});
}
