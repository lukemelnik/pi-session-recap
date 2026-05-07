import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { completeSimple, type Api, type Message, type Model, type UserMessage } from "@mariozechner/pi-ai";
import { Text } from "@mariozechner/pi-tui";
import { getAgentDir, serializeConversation } from "@mariozechner/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@mariozechner/pi-coding-agent";

const WIDGET_KEY = "session-synopsis";
const SETTINGS_ENTRY_TYPE = "session-synopsis-settings";
const SYNOPSIS_STATE_ENTRY_TYPE = "session-synopsis-state";
const SUMMARY_MODEL_CANDIDATES = [
	{ provider: "openai-codex", modelId: "gpt-5.4-mini" },
	{ provider: "openai", modelId: "gpt-5.4-mini" },
	{ provider: "openrouter", modelId: "openai/gpt-5.4-mini" },
] as const;

const MAX_RECENT_ENTRIES = 160;
const MAX_CONTEXT_CHARS = 12000;
const MAX_SUMMARY_GENERATION_TOKENS = 160;
const MAX_SUMMARY_LINE = 220;
const DEFAULT_SUMMARY_DELAY_MS = 30_000;
const MAX_SUMMARY_DELAY_MS = 24 * 60 * 60 * 1000;
const CONFIG_PATH = join(getAgentDir(), "session-recap.json");

const SYNOPSIS_SYSTEM_PROMPT = `You are a coding session recap assistant.

Your job is to compress a coding conversation into one concise line that helps someone quickly recall what the session was actually about.

Focus on the real task, bug, feature, or decision being worked on.
Do not mention tool calls, edits, file operations, or generic activity unless that is the only concrete signal.
Return only the summary text with no label, bullets, or extra commentary.`;

type SummaryModelMode = "auto" | "current" | "fixed";

interface SynopsisSettings {
	enabled: boolean;
	delayMs: number;
	modelMode: SummaryModelMode;
	provider?: string;
	modelId?: string;
}

interface SynopsisState {
	settings: SynopsisSettings;
	synopsis?: string;
	lastSummarizedLeafId?: string;
	lastPersistedSynopsis?: string;
	lastPersistedLeafId?: string;
	generation: number;
	inFlight: boolean;
	pending: boolean;
	pendingCtx?: ExtensionContext;
	idleTimer?: ReturnType<typeof setTimeout>;
}

interface PersistedSynopsisState {
	schemaVersion: 1;
	synopsis: string;
	lastSummarizedLeafId?: string;
	updatedAt: number;
}

interface SummaryMessage {
	role: "user" | "assistant";
	content: Array<{ type: "text"; text: string }>;
	timestamp: number;
}

const DEFAULT_SETTINGS: SynopsisSettings = {
	enabled: true,
	delayMs: DEFAULT_SUMMARY_DELAY_MS,
	modelMode: "auto",
};

function normalizeWhitespace(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function truncateText(text: string, max: number): string {
	if (!text) return text;
	if (text.length <= max) return text;
	return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function clampDelayMs(delayMs: number): number {
	if (!Number.isFinite(delayMs)) return DEFAULT_SUMMARY_DELAY_MS;
	return Math.max(0, Math.min(MAX_SUMMARY_DELAY_MS, Math.round(delayMs)));
}

function normalizeSettings(raw: unknown, base: SynopsisSettings = DEFAULT_SETTINGS): SynopsisSettings {
	if (!raw || typeof raw !== "object") {
		return { ...base };
	}

	const input = raw as {
		enabled?: unknown;
		delayMs?: unknown;
		modelMode?: unknown;
		provider?: unknown;
		modelId?: unknown;
	};
	const modelMode: SummaryModelMode =
		input.modelMode === "current" || input.modelMode === "fixed" || input.modelMode === "auto"
			? input.modelMode
			: base.modelMode;
	const provider = typeof input.provider === "string" && input.provider.trim() ? input.provider.trim() : base.provider;
	const modelId = typeof input.modelId === "string" && input.modelId.trim() ? input.modelId.trim() : base.modelId;

	return {
		enabled: typeof input.enabled === "boolean" ? input.enabled : base.enabled,
		delayMs: typeof input.delayMs === "number" ? clampDelayMs(input.delayMs) : base.delayMs,
		modelMode: modelMode === "fixed" && (!provider || !modelId) ? "auto" : modelMode,
		provider: modelMode === "fixed" ? provider : undefined,
		modelId: modelMode === "fixed" ? modelId : undefined,
	};
}

async function loadSettingsFromDisk(): Promise<SynopsisSettings> {
	try {
		const text = await readFile(CONFIG_PATH, "utf-8");
		return normalizeSettings(JSON.parse(text));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return { ...DEFAULT_SETTINGS };
		}
		throw error;
	}
}

async function saveSettingsToDisk(settings: SynopsisSettings): Promise<void> {
	await mkdir(dirname(CONFIG_PATH), { recursive: true });
	await writeFile(CONFIG_PATH, `${JSON.stringify(settings, null, "\t")}\n`, "utf-8");
}

function getPersistedSessionSettings(ctx: ExtensionContext): Partial<SynopsisSettings> {
	const entries = ctx.sessionManager.getBranch();
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "custom" || entry.customType !== SETTINGS_ENTRY_TYPE) continue;
		const data = entry.data;
		if (!data || typeof data !== "object") continue;
		const normalized = normalizeSettings(data, DEFAULT_SETTINGS);
		const result: Partial<SynopsisSettings> = {};
		if (typeof (data as { enabled?: unknown }).enabled === "boolean") result.enabled = normalized.enabled;
		if (typeof (data as { delayMs?: unknown }).delayMs === "number") result.delayMs = normalized.delayMs;
		if (typeof (data as { modelMode?: unknown }).modelMode === "string") {
			result.modelMode = normalized.modelMode;
			result.provider = normalized.provider;
			result.modelId = normalized.modelId;
		}
		return result;
	}
	return {};
}

function normalizePersistedSynopsisState(raw: unknown): Pick<SynopsisState, "synopsis" | "lastSummarizedLeafId"> {
	if (!raw || typeof raw !== "object") return {};

	const data = raw as { synopsis?: unknown; lastSummarizedLeafId?: unknown };
	if (typeof data.synopsis !== "string" || !data.synopsis.trim()) return {};

	const synopsis = normalizeSynopsis(data.synopsis);
	if (!synopsis) return {};

	return {
		synopsis,
		lastSummarizedLeafId: typeof data.lastSummarizedLeafId === "string" ? data.lastSummarizedLeafId : undefined,
	};
}

function getPersistedSynopsisState(ctx: ExtensionContext): Pick<SynopsisState, "synopsis" | "lastSummarizedLeafId"> {
	const entries = ctx.sessionManager.getBranch();
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "custom" || entry.customType !== SYNOPSIS_STATE_ENTRY_TYPE) continue;
		const result = normalizePersistedSynopsisState(entry.data);
		if (result.synopsis) return result;
	}
	return {};
}

async function loadSettings(ctx: ExtensionContext): Promise<SynopsisSettings> {
	const diskSettings = await loadSettingsFromDisk();
	return normalizeSettings({ ...diskSettings, ...getPersistedSessionSettings(ctx) });
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

function formatDuration(ms: number): string {
	if (ms === 0) return "immediately";
	if (ms < 1000) return `${ms}ms`;
	if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
	if (ms % 60_000 === 0) return `${ms / 60_000}m`;
	if (ms % 1000 === 0) return `${ms / 1000}s`;
	return `${(ms / 1000).toFixed(1)}s`;
}

function parseDelay(value: string): number | "default" | undefined {
	const normalized = normalizeWhitespace(value).toLowerCase();
	if (normalized === "default" || normalized === "reset") return "default";
	const match = normalized.match(/^(\d+(?:\.\d+)?)\s*(ms|millisecond|milliseconds|s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours)?$/u);
	if (!match) return undefined;

	const amount = Number(match[1]);
	const unit = match[2] ?? "s";
	const multiplier = unit.startsWith("ms") || unit.startsWith("millisecond") ? 1 : unit.startsWith("m") ? 60_000 : unit.startsWith("h") ? 3_600_000 : 1000;
	return clampDelayMs(amount * multiplier);
}

function formatModelSpec(provider: string, modelId: string): string {
	return `${provider}/${modelId}`;
}

function formatModel(model: Model<Api>): string {
	return formatModelSpec(model.provider, model.id);
}

function parseModelSpec(value: string): { provider: string; modelId: string } | undefined {
	const normalized = normalizeWhitespace(value);
	const separator = normalized.indexOf("/");
	if (separator <= 0 || separator === normalized.length - 1) return undefined;
	return {
		provider: normalized.slice(0, separator),
		modelId: normalized.slice(separator + 1),
	};
}

function formatModelSetting(settings: SynopsisSettings): string {
	if (settings.modelMode === "current") return "current active model";
	if (settings.modelMode === "fixed" && settings.provider && settings.modelId) {
		return formatModelSpec(settings.provider, settings.modelId);
	}
	return "auto (cheap candidate, then current model)";
}

async function getAuthenticatedModel(
	ctx: ExtensionContext,
	model: Model<Api> | undefined,
): Promise<{ model: Model<Api>; auth: { ok: true; apiKey?: string; headers?: Record<string, string> } } | undefined> {
	if (!model) return undefined;
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) return undefined;
	return { model, auth };
}

async function resolveSummaryModel(
	ctx: ExtensionContext,
	settings: SynopsisSettings,
): Promise<{ model: Model<Api>; auth: { ok: true; apiKey?: string; headers?: Record<string, string> } } | undefined> {
	if (settings.modelMode === "fixed") {
		return getAuthenticatedModel(ctx, ctx.modelRegistry.find(settings.provider ?? "", settings.modelId ?? ""));
	}

	if (settings.modelMode === "current") {
		return getAuthenticatedModel(ctx, ctx.model);
	}

	for (const candidate of SUMMARY_MODEL_CANDIDATES) {
		const resolved = await getAuthenticatedModel(ctx, ctx.modelRegistry.find(candidate.provider, candidate.modelId));
		if (resolved) return resolved;
	}

	return getAuthenticatedModel(ctx, ctx.model);
}

export default function (pi: ExtensionAPI) {
	const state: SynopsisState = {
		settings: { ...DEFAULT_SETTINGS },
		generation: 0,
		inFlight: false,
		pending: false,
	};
	let modelCompletionItems: Array<{ value: string; label: string; description?: string }> = [];

	const clearScheduledUpdate = (): void => {
		if (state.idleTimer) {
			clearTimeout(state.idleTimer);
			state.idleTimer = undefined;
		}
	};

	const reset = async (ctx: ExtensionContext) => {
		clearScheduledUpdate();
		try {
			state.settings = await loadSettings(ctx);
		} catch (error) {
			state.settings = { ...DEFAULT_SETTINGS };
			if (ctx.hasUI) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Failed to load session recap settings: ${message}`, "warning");
			}
		}
		const persistedSynopsis = getPersistedSynopsisState(ctx);
		state.generation += 1;
		state.synopsis = persistedSynopsis.synopsis;
		state.lastSummarizedLeafId = persistedSynopsis.lastSummarizedLeafId;
		state.lastPersistedSynopsis = persistedSynopsis.synopsis;
		state.lastPersistedLeafId = persistedSynopsis.lastSummarizedLeafId;
		state.inFlight = false;
		state.pending = false;
		state.pendingCtx = undefined;
		renderSynopsis(ctx, state.settings.enabled ? state.synopsis : undefined);
	};

	const persistSynopsis = (): void => {
		if (!state.synopsis) return;
		if (state.synopsis === state.lastPersistedSynopsis && state.lastSummarizedLeafId === state.lastPersistedLeafId) return;

		const data: PersistedSynopsisState = {
			schemaVersion: 1,
			synopsis: state.synopsis,
			lastSummarizedLeafId: state.lastSummarizedLeafId,
			updatedAt: Date.now(),
		};

		try {
			pi.appendEntry(SYNOPSIS_STATE_ENTRY_TYPE, data);
			state.lastPersistedSynopsis = state.synopsis;
			state.lastPersistedLeafId = state.lastSummarizedLeafId;
		} catch {
			// Recap persistence should never affect the session.
		}
	};

	const generateSynopsis = async (ctx: ExtensionContext, options: { force?: boolean } = {}) => {
		if (!ctx.hasUI || !state.settings.enabled || (!options.force && !ctx.isIdle())) return;
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
				renderSynopsis(ctx, state.settings.enabled ? state.synopsis : undefined);
				return;
			}

			const summaryModel = await resolveSummaryModel(ctx, state.settings);
			if (!summaryModel) {
				state.synopsis = buildFallbackSynopsis(branch, state.lastSummarizedLeafId, state.synopsis);
				state.lastSummarizedLeafId = branch.at(-1)?.id;
				persistSynopsis();
				renderSynopsis(ctx, state.synopsis);
				return;
			}
			const { model, auth } = summaryModel;

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

				if (generation !== state.generation || !ctx.hasUI || !state.settings.enabled || (!options.force && !ctx.isIdle())) {
					return;
				}
				if (response.stopReason === "error" || response.stopReason === "aborted") {
					state.synopsis = buildFallbackSynopsis(branch, state.lastSummarizedLeafId, state.synopsis);
					state.lastSummarizedLeafId = branch.at(-1)?.id;
					persistSynopsis();
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
					persistSynopsis();
					renderSynopsis(ctx, state.synopsis);
					return;
				}

				state.synopsis = normalizeSynopsis(raw);
				state.lastSummarizedLeafId = branch.at(-1)?.id;
				persistSynopsis();
				renderSynopsis(ctx, state.synopsis);
			} catch {
				state.synopsis = buildFallbackSynopsis(branch, state.lastSummarizedLeafId, state.synopsis);
				state.lastSummarizedLeafId = branch.at(-1)?.id;
				persistSynopsis();
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
		if (!ctx.hasUI || !state.settings.enabled) return;
		void generateSynopsis(ctx);
	};

	const scheduleIdleUpdate = (ctx: ExtensionContext): void => {
		clearScheduledUpdate();
		if (!ctx.hasUI || !state.settings.enabled) return;
		state.idleTimer = setTimeout(() => {
			state.idleTimer = undefined;
			void generateSynopsis(ctx);
		}, state.settings.delayMs);
	};

	const persistSettings = async (ctx: ExtensionContext): Promise<void> => {
		state.settings = normalizeSettings(state.settings);
		await saveSettingsToDisk(state.settings);
		pi.appendEntry(SETTINGS_ENTRY_TYPE, state.settings);
	};

	const setEnabled = async (ctx: ExtensionContext, enabled: boolean): Promise<void> => {
		clearScheduledUpdate();
		state.settings = { ...state.settings, enabled };
		await persistSettings(ctx);
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

	const refreshModelCompletions = (ctx: ExtensionContext): void => {
		const seen = new Set<string>();
		modelCompletionItems = [];
		for (const model of ctx.modelRegistry.getAvailable().slice().sort((a, b) => formatModel(a).localeCompare(formatModel(b)))) {
			const spec = formatModel(model);
			if (seen.has(spec)) continue;
			seen.add(spec);
			modelCompletionItems.push({
				value: `model ${spec}`,
				label: spec,
				description: model.name ? `${model.provider} — ${model.name}` : model.provider,
			});
		}
	};

	const getSessionRecapCompletions = (argumentPrefix: string) => {
		const prefix = argumentPrefix.replace(/\s+/g, " ").toLowerCase();
		const topLevel = [
			{ value: "on", label: "on", description: "Show the recap widget and refresh after agent turns" },
			{ value: "off", label: "off", description: "Hide the recap widget and stop refreshing" },
			{ value: "toggle", label: "toggle", description: "Toggle recap visibility" },
			{ value: "status", label: "status", description: "Show current session recap settings" },
			{ value: "refresh", label: "refresh", description: "Regenerate the recap immediately" },
			{ value: "model ", label: "model", description: "Pick or set the recap model" },
			{ value: "delay ", label: "delay", description: "Set refresh delay, e.g. 30s or 2m" },
		];

		if (prefix.startsWith("model ")) {
			const modelPrefix = prefix.slice("model ".length);
			return [
				{ value: "model auto", label: "auto", description: "Use cheap recap candidates, then the active model" },
				{ value: "model current", label: "current", description: "Always use the active Pi model" },
				...modelCompletionItems,
			].filter((item) => item.value.toLowerCase().startsWith("model " + modelPrefix));
		}

		if (prefix.startsWith("delay ")) {
			const delayPrefix = prefix.slice("delay ".length);
			return [
				{ value: "delay 10s", label: "10s", description: "Refresh ten seconds after each agent turn" },
				{ value: "delay 30s", label: "30s", description: "Default refresh delay" },
				{ value: "delay 1m", label: "1m", description: "Refresh one minute after each agent turn" },
				{ value: "delay 2m", label: "2m", description: "Refresh two minutes after each agent turn" },
				{ value: "delay 5m", label: "5m", description: "Refresh five minutes after each agent turn" },
				{ value: "delay default", label: "default", description: "Restore the default 30 second delay" },
			].filter((item) => item.value.toLowerCase().startsWith("delay " + delayPrefix));
		}

		return topLevel.filter((item) => item.value.toLowerCase().startsWith(prefix));
	};

	const chooseSummaryModel = async (ctx: ExtensionContext): Promise<SynopsisSettings | undefined> => {
		if (!ctx.hasUI) return undefined;

		const choices: Array<{ label: string; settings: SynopsisSettings }> = [
			{
				label: "Auto — first available recap model, then current active model",
				settings: { ...state.settings, modelMode: "auto", provider: undefined, modelId: undefined },
			},
			{
				label: ctx.model ? `Current active model — ${formatModel(ctx.model)}` : "Current active model",
				settings: { ...state.settings, modelMode: "current", provider: undefined, modelId: undefined },
			},
		];

		const availableModels = ctx.modelRegistry
			.getAvailable()
			.slice()
			.sort((a, b) => formatModel(a).localeCompare(formatModel(b)));
		for (const model of availableModels) {
			choices.push({
				label: formatModel(model),
				settings: { ...state.settings, modelMode: "fixed", provider: model.provider, modelId: model.id },
			});
		}

		const selected = await ctx.ui.select(
			"Select recap model:",
			choices.map((choice) => choice.label),
		);
		return choices.find((choice) => choice.label === selected)?.settings;
	};

	const setSummaryModel = async (ctx: ExtensionContext, spec: string): Promise<void> => {
		const normalizedSpec = normalizeWhitespace(spec).toLowerCase();
		if (!normalizedSpec) {
			const selected = await chooseSummaryModel(ctx);
			if (!selected) return;
			state.settings = normalizeSettings(selected);
		} else if (normalizedSpec === "auto") {
			state.settings = { ...state.settings, modelMode: "auto", provider: undefined, modelId: undefined };
		} else if (normalizedSpec === "current") {
			if (!ctx.model) {
				ctx.ui.notify("No current active model is selected.", "warning");
				return;
			}
			state.settings = { ...state.settings, modelMode: "current", provider: undefined, modelId: undefined };
		} else {
			const parsed = parseModelSpec(spec);
			if (!parsed) {
				ctx.ui.notify("Usage: /session-recap model [auto|current|provider/model-id]", "warning");
				return;
			}

			const model = ctx.modelRegistry.find(parsed.provider, parsed.modelId);
			if (!model) {
				ctx.ui.notify(`Model not found: ${formatModelSpec(parsed.provider, parsed.modelId)}`, "warning");
				return;
			}

			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (!auth.ok) {
				ctx.ui.notify(`No usable auth for ${formatModel(model)}: ${auth.error}`, "warning");
				return;
			}

			state.settings = {
				...state.settings,
				modelMode: "fixed",
				provider: model.provider,
				modelId: model.id,
			};
		}

		state.lastSummarizedLeafId = undefined;
		await persistSettings(ctx);
		ctx.ui.notify(`Recap model: ${formatModelSetting(state.settings)}`, "info");
		scheduleUpdate(ctx);
	};

	const setSummaryDelay = async (ctx: ExtensionContext, value: string): Promise<void> => {
		if (!value) {
			ctx.ui.notify(`Session recap delay: ${formatDuration(state.settings.delayMs)}`, "info");
			return;
		}

		const parsed = parseDelay(value);
		if (parsed === undefined) {
			ctx.ui.notify("Usage: /session-recap delay [30s|2m|500ms|default]", "warning");
			return;
		}

		state.settings = {
			...state.settings,
			delayMs: parsed === "default" ? DEFAULT_SUMMARY_DELAY_MS : parsed,
		};
		await persistSettings(ctx);
		ctx.ui.notify(`Session recap delay: ${formatDuration(state.settings.delayMs)}`, "info");
	};

	pi.registerCommand("session-recap", {
		description:
			"Configure the session recap (usage: /session-recap [on|off|toggle|status|refresh|model|delay])",
		getArgumentCompletions: getSessionRecapCompletions,
		handler: async (args, ctx) => {
			const normalizedArgs = normalizeWhitespace(args);
			const [actionRaw, ...restParts] = normalizedArgs ? normalizedArgs.split(" ") : ["status"];
			const action = actionRaw.toLowerCase();
			const rest = restParts.join(" ");

			if (action === "status") {
				ctx.ui.notify(
					[
						`Session recap: ${state.settings.enabled ? "on" : "off"}`,
						`Model: ${formatModelSetting(state.settings)}`,
						`Delay: ${formatDuration(state.settings.delayMs)}`,
						`Settings: ${CONFIG_PATH}`,
					].join("\n"),
					"info",
				);
				return;
			}

			if (action === "on") {
				await setEnabled(ctx, true);
				ctx.ui.notify("Session recap enabled", "info");
				return;
			}

			if (action === "off") {
				await setEnabled(ctx, false);
				ctx.ui.notify("Session recap hidden", "info");
				return;
			}

			if (action === "toggle") {
				const nextEnabled = !state.settings.enabled;
				await setEnabled(ctx, nextEnabled);
				ctx.ui.notify(nextEnabled ? "Session recap enabled" : "Session recap hidden", "info");
				return;
			}

			if (action === "refresh") {
				if (!state.settings.enabled) {
					ctx.ui.notify("Session recap is off. Run /session-recap on first.", "warning");
					return;
				}
				await ctx.waitForIdle();
				clearScheduledUpdate();
				state.lastSummarizedLeafId = undefined;
				await generateSynopsis(ctx, { force: true });
				ctx.ui.notify("Session recap refreshed", "info");
				return;
			}

			if (action === "model") {
				await setSummaryModel(ctx, rest);
				return;
			}

			if (action === "delay") {
				await setSummaryDelay(ctx, rest);
				return;
			}

			ctx.ui.notify("Usage: /session-recap [on|off|toggle|status|refresh|model|delay]", "warning");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		refreshModelCompletions(ctx);
		await reset(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		refreshModelCompletions(ctx);
		await reset(ctx);
		scheduleUpdate(ctx);
	});

	pi.on("model_select", (_event, ctx) => {
		refreshModelCompletions(ctx);
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
