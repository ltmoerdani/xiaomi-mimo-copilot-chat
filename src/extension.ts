import * as vscode from "vscode";
import {
  MiMoRequestError,
} from "./errors";
import {
  MODEL_METADATA_CACHE_KEY,
  MODEL_METADATA_REVISION,
  MODELS_DEV_API_URL,
  bundledModelMetadataSnapshot,
  fallbackModelMetadata,
  hasExplicitModelLimits,
  isFreshModelMetadata,
  normalizeLiveModelMetadata,
  normalizeModelsDevSnapshot,
  resolveModelMetadata,
  toEffectiveModelId,
  type ModelsDevResponse,
} from "./metadata";
import {
  resolveModelRouting,
} from "./routing";
import { buildMiMoAuthHeaders } from "./mimoAuth";
import {
  streamAnthropicMessages as runStreamAnthropicMessages,
  streamChatCompletions as runStreamChatCompletions,
  streamGoogleGenerateContent as runStreamGoogleGenerateContent,
  streamResponsesApi as runStreamResponsesApi,
  type TransportRequestSummary,
} from "./streaming";
import { MIMO_VENDOR } from "./providerTypes";
import { isInternalDataPart } from "./chatParts";
import {
  disposeContextWindowHookBridge,
  initializeContextWindowHookBridge,
} from "./contextWindowHookBridge";
import {
  formatCacheHitRatio,
  formatUsageStatusBarText,
  formatUsageStatusBarTooltip,
  type UsageSnapshot,
} from "./usage";

const SECRET_KEY = "xiaomi-mimo.apiKey";
const RECENT_TRANSPORT_SUMMARY_LIMIT = 25;
const RECENT_TRANSPORT_SUMMARY_STORAGE_PREFIX = "xiaomi-mimo.recentTransportSummaries";

let usageStatusBarItem: vscode.StatusBarItem | undefined;

interface ProviderDefinition {
  vendor: typeof MIMO_VENDOR;
  displayName: string;
  modelNamePrefix: string;
  modelsUrl: string;
  chatCompletionsUrl: string;
  messagesUrl: string;
  responsesUrl?: string;
  categoryOrder: number;
  testModelId: string;
  fallbackModels: string[];
  filterModel?: (modelId: string) => boolean;
}

type ModelEndpointKind =
  | "chat-completions"
  | "messages"
  | "responses"
  | "google";

const FREE_ZEN_MODEL_IDS = new Set<string>([]);
const KNOWN_UNAVAILABLE_MODEL_IDS = new Set<string>([]);
const DEFAULT_REQUEST_TIMEOUT_MS = 2 * 60 * 1000;
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 90 * 1000;
const MIMO_CLIENT = "vscode-copilot-chat";
const MIMO_USER_AGENT = "xiaomi-mimo-copilot-chat/0.1.0 VSCode";

const MIMO_BASE_URL = "https://token-plan-sgp.xiaomimimo.com/v1";

function isSupportedMiMoChatModel(modelId: string): boolean {
  const normalized = modelId.toLowerCase();
  return normalized.startsWith("mimo-")
    && !normalized.includes("tts")
    && !normalized.includes("voiceclone")
    && !normalized.includes("voicedesign");
}

const PROVIDERS: Record<ProviderDefinition["vendor"], ProviderDefinition> = {
  [MIMO_VENDOR]: {
    vendor: MIMO_VENDOR,
    displayName: "MiMo (Xiaomi)",
    modelNamePrefix: "MiMo",
    modelsUrl: `${MIMO_BASE_URL}/models`,
    chatCompletionsUrl: `${MIMO_BASE_URL}/chat/completions`,
    messagesUrl: `${MIMO_BASE_URL}/chat/completions`,
    categoryOrder: 2,
    testModelId: "mimo-v2.5-pro",
    fallbackModels: [
      "mimo-v2.5",
      "mimo-v2.5-pro",
    ],
    filterModel: isSupportedMiMoChatModel,
  }
};

type ApiRole = "user" | "assistant" | "tool";

interface MiMoModel extends vscode.LanguageModelChatInformation {
  endpointKind: ModelEndpointKind;
  provider: ProviderDefinition;
  rawModelId?: string;
  category?: {
    label: string;
    order: number;
  };
  isUserSelectable?: boolean;
  configurationSchema?: vscode.LanguageModelConfigurationSchema;
}

interface ModelListEntry {
  id?: string;
  owned_by?: string;
  status?: string;
  deprecated?: boolean;
  limit?: {
    context?: number;
    output?: number;
  };
  context_window?: number;
  contextWindow?: number;
  max_output_tokens?: number;
  maxOutputTokens?: number;
  attachment?: boolean;
  image_input?: boolean;
  imageInput?: boolean;
  reasoning?: boolean;
  modalities?: {
    input?: string[];
    output?: string[];
  };
}

interface ModelListResponse {
  data?: ModelListEntry[];
}

interface ApiMessage {
  role: ApiRole;
  content: string | null | OpenAiContentPart[];
  reasoning_content?: string;
  tool_call_id?: string;
  tool_calls?: OpenAiToolCall[];
}

interface OpenAiContentPart {
  type: "text" | "image_url";
  text?: string;
  image_url?: {
    url: string;
  };
}

interface OpenAiToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

interface PendingToolCall {
  id: string;
  name: string;
  arguments: string;
}

interface ThinkingSettings {
  deepseek: "off" | "high" | "max";
  glm: "on" | "off";
  kimi: "on" | "off";
  qwen: "auto" | "on" | "off";
  qwenBudget: "auto" | "4096" | "16384" | "32768" | "81920";
}

interface ApiSettings {
  temperature: number;
  maxOutputTokensOverride: number;
  maxInputTokensOverride: number;
  debugReasoning: boolean;
  debugLogging: boolean;
  requestTimeoutMs: number;
  streamIdleTimeoutMs: number;
  thinking: ThinkingSettings;
}

interface LanguageModelConfiguration {
  apiKey?: unknown;
}

type ConfiguredLanguageModelInfoOptions = vscode.PrepareLanguageModelChatModelOptions & {
  configuration?: LanguageModelConfiguration;
};

type ConfiguredLanguageModelResponseOptions = vscode.ProvideLanguageModelChatResponseOptions & {
  configuration?: LanguageModelConfiguration;
};

interface BaseModelLimits {
  contextWindow: number;
  maxOutputTokens: number;
}

interface ModelLimits extends BaseModelLimits {
  advertisedContextWindow: number;
  advertisedMaxInputTokens: number;
  advertisedMaxOutputTokens: number;
}

interface ModelMetadataFields {
  contextWindow?: number;
  maxOutputTokens?: number;
  supportsVision?: boolean;
  reasoning?: boolean;
  status?: string;
}

interface CachedModelMetadataSnapshot {
  fetchedAt: number;
  providers: Record<
    ProviderDefinition["vendor"],
    Record<string, ModelMetadataFields>
  >;
}

interface ResolvedModelMetadata extends BaseModelLimits {
  supportsVision: boolean;
  reasoning: boolean;
  status?: string;
  source: "models.dev" | "live" | "fallback" | "default";
}

interface ModelRoutingFields {
  endpointKind: ModelEndpointKind;
  endpointUrl: string;
  sdkPackage?: string;
}

// Copilot surfaces combine input/output metadata differently across views.
// Reserve a modest UI output budget, while requests still use the real model max.
const UI_OUTPUT_TOKEN_RESERVE = 8192;
const MESSAGE_TOKEN_OVERHEAD = 4;
const MESSAGE_NAME_TOKEN_OVERHEAD = 1;
const TOOL_CALL_TOKEN_OVERHEAD = 10;
const TOOL_RESULT_TOKEN_OVERHEAD = 6;
const IMAGE_TOKEN_ESTIMATE = 1024;

type CopilotCompatibleCapabilities = vscode.LanguageModelChatCapabilities & {
  supportsToolCalling: boolean;
  supportsImageToText: boolean;
};

// Models with constrained capacity.
// ("Qwen 3.6 Plus — free, again. Round 2. We found more GPUs.") so they are
// NOT deprecated, but agentic workloads with long histories or large tool
// catalogs can still hit 5xx during traffic bursts. Surface this so users know
// to retry or fall back to another free model if the request fails.
const CAPACITY_LIMITED_MODEL_NOTES: Record<string, string> = {
  "qwen3.6-plus-free": "Free relaunch with limited GPU capacity. Stable for short prompts; bursty traffic or very large tool catalogs may return 5xx - retry or fall back to 'deepseek-v4-flash-free' / 'big-pickle'. Paid 'qwen3.6-plus' has no quota."
};

let modelMetadataSnapshot: CachedModelMetadataSnapshot | undefined;
let modelMetadataRefreshPromise: Promise<CachedModelMetadataSnapshot> | undefined;

interface OpenAiToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: object;
  };
}

interface AnthropicToolDefinition {
  name: string;
  description: string;
  input_schema: object;
}

interface AnthropicCacheControl {
  type: "ephemeral";
}

interface AnthropicTextBlock {
  type: "text";
  text: string;
  cache_control?: AnthropicCacheControl;
}

interface AnthropicImageSourceUrl {
  type: "url";
  url: string;
}

interface AnthropicImageSourceBase64 {
  type: "base64";
  media_type: string;
  data: string;
}

type AnthropicImageSource = AnthropicImageSourceUrl | AnthropicImageSourceBase64;

interface AnthropicImageBlock {
  type: "image";
  source: AnthropicImageSource;
  cache_control?: AnthropicCacheControl;
}

interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
  cache_control?: AnthropicCacheControl;
}

interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  cache_control?: AnthropicCacheControl;
}

type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock;

interface AnthropicRequestMessage {
  role: "user" | "assistant";
  content: AnthropicContentBlock[];
}

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

interface RecentTransportSummary extends TransportRequestSummary {
  recordedAt: string;
  endpointKind: string;
  metadataSource: string;
  requestInitiator?: string;
}

export function activate(context: vscode.ExtensionContext) {
  ensureUsageStatusBar(context);
  void syncExperimentalContextIndicator();
  const mimoProvider = new MiMoProvider(context, PROVIDERS[MIMO_VENDOR]);

  context.subscriptions.push(
    vscode.lm.registerLanguageModelChatProvider(MIMO_VENDOR, mimoProvider),
    vscode.commands.registerCommand("xiaomi-mimo.manage", () => mimoProvider.manage()),
    vscode.commands.registerCommand("xiaomi-mimo.diagnostics", () => mimoProvider.showDiagnostics()),
    vscode.commands.registerCommand("xiaomi-mimo.setApiKey", () => mimoProvider.setApiKey()),
    vscode.commands.registerCommand("xiaomi-mimo.modelPickerDiagnostics", () => showModelPickerDiagnostics()),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("xiaomi-mimo.showUsageStatusBar")) {
        resetUsageStatusBar();
      }
      if (event.affectsConfiguration("xiaomi-mimo.experimentalContextIndicator")) {
        void syncExperimentalContextIndicator();
      }
    }),
  );

  void warmModelPickerMetadata();
}

async function warmModelPickerMetadata(): Promise<void> {
  await Promise.allSettled([
    vscode.lm.selectChatModels({ vendor: MIMO_VENDOR }),
  ]);
}

async function showModelPickerDiagnostics(): Promise<void> {
  const vendors = [MIMO_VENDOR, "copilot"];
  const sections: string[] = [];

  for (const vendor of vendors) {
    const models = await vscode.lm.selectChatModels({ vendor });
    sections.push(`## vendor: ${vendor}`, "", `models: ${models.length}`, "");
    for (const model of models) {
      const internalModel = model as unknown as { configurationSchema?: unknown; detail?: unknown };
      const schema = internalModel.configurationSchema;
      sections.push(
        `### ${model.name}`,
        "",
        `- id: \`${model.id}\``,
        `- family: \`${model.family}\``,
        `- version: \`${model.version}\``,
        `- vendor: \`${model.vendor}\``,
        `- detail: \`${typeof internalModel.detail === "string" ? internalModel.detail : ""}\``,
        `- schema:`,
        "```json",
        JSON.stringify(schema ?? null, null, 2),
        "```",
        ""
      );
    }
  }

  const doc = await vscode.workspace.openTextDocument({
    content: ["# MiMo Model Picker Diagnostics", "", ...sections].join("\n"),
    language: "markdown"
  });
  await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
}

async function showThinkingEffortPicker(): Promise<void> {
  const families: { label: string; key: keyof ThinkingSettings; options: string[] }[] = [
    { label: "DeepSeek (deepseek-v4-*)", key: "deepseek", options: ["off", "high", "max"] },
    { label: "GLM (glm-5, glm-5.1)", key: "glm", options: ["on", "off"] },
    { label: "Kimi (kimi-k2.*)", key: "kimi", options: ["on", "off"] },
    { label: "Qwen (qwen3.*)", key: "qwen", options: ["auto", "on", "off"] },
    { label: "Qwen Thinking Budget", key: "qwenBudget", options: ["auto", "4096", "16384", "32768", "81920"] }
  ];
  const settings = getSettings().thinking;
  const family = await vscode.window.showQuickPick(
    families.map(f => ({ label: f.label, description: `current: ${settings[f.key]}`, family: f })),
    { placeHolder: "Pick a model family to configure Thinking" }
  );
  if (!family) return;
  const choice = await vscode.window.showQuickPick(family.family.options, {
    placeHolder: `Set ${family.family.label} → Thinking value`
  });
  if (!choice) return;
  const cfg = vscode.workspace.getConfiguration("xiaomi-mimo.thinking");
  await cfg.update(family.family.key, choice, vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage(`MiMo Thinking — ${family.family.label}: ${choice}`);
}

export async function deactivate(): Promise<void> {
  await disposeContextWindowHookBridge();
}

function ensureUsageStatusBar(
  context: vscode.ExtensionContext,
): vscode.StatusBarItem {
  if (!usageStatusBarItem) {
    usageStatusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      95,
    );
    context.subscriptions.push(usageStatusBarItem);
  }

  resetUsageStatusBar();
  return usageStatusBarItem;
}

function shouldShowUsageStatusBar(): boolean {
  return vscode.workspace
    .getConfiguration("xiaomi-mimo")
    .get("showUsageStatusBar", true);
}

function isExperimentalContextIndicatorEnabled(): boolean {
  return vscode.workspace
    .getConfiguration("xiaomi-mimo")
    .get("experimentalContextIndicator", false);
}

let hookDiagnosticChannel: vscode.OutputChannel | undefined;

function getHookDiagnosticChannel(): vscode.OutputChannel {
  if (!hookDiagnosticChannel) {
    hookDiagnosticChannel = vscode.window.createOutputChannel("MiMo");
  }
  return hookDiagnosticChannel;
}

function hookDiagnostic(message: string): void {
  getHookDiagnosticChannel().appendLine(
    `[${new Date().toISOString()}] [contextWindowHook] ${message}`,
  );
}

async function syncExperimentalContextIndicator(): Promise<void> {
  if (isExperimentalContextIndicatorEnabled()) {
    const ok = await initializeContextWindowHookBridge(hookDiagnostic);
    if (!ok) {
      hookDiagnostic(
        "experimentalContextIndicator is enabled but the bridge could not activate. " +
        "The Copilot Chat footer will show default (estimated) usage. " +
        "This is expected if VS Code internals changed — check for extension updates.",
      );
    }
    return;
  }

  await disposeContextWindowHookBridge();
}

function resetUsageStatusBar(): void {
  if (!usageStatusBarItem) {
    return;
  }

  if (!shouldShowUsageStatusBar()) {
    usageStatusBarItem.hide();
    return;
  }

  usageStatusBarItem.text = "MiMo";
  usageStatusBarItem.tooltip = "MiMo usage summary";
  usageStatusBarItem.show();
}

function updateUsageStatusBar(
  providerDisplayName: string,
  modelId: string,
  summary: TransportRequestSummary,
): void {
  if (!usageStatusBarItem) {
    return;
  }

  if (!shouldShowUsageStatusBar()) {
    usageStatusBarItem.hide();
    return;
  }

  const usage: UsageSnapshot = {
    promptTokens: summary.promptTokens,
    completionTokens: summary.completionTokens,
    totalTokens: summary.totalTokens,
    cachedTokens: summary.cachedTokens,
    finishReason: summary.finishReason,
  };
  const text = formatUsageStatusBarText(providerDisplayName, usage);

  usageStatusBarItem.text = text ?? providerDisplayName;
  usageStatusBarItem.tooltip = formatUsageStatusBarTooltip(
    providerDisplayName,
    modelId,
    usage,
  );
  usageStatusBarItem.show();
}

class MiMoProvider implements vscode.LanguageModelChatProvider<MiMoModel> {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation = this.changeEmitter.event;
  private readonly apiKeysByModelId = new Map<string, string>();
  private readonly reasoningContentByToolCallId = new Map<string, string>();
  private readonly liveModelMetadataById = new Map<string, ModelMetadataFields>();
  private readonly recentTransportSummaries: RecentTransportSummary[] = [];
  private outputChannel: vscode.OutputChannel | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly definition: ProviderDefinition
  ) {
    this.restoreRecentTransportSummaries();
  }

  private getOutputChannel(): vscode.OutputChannel {
    if (!this.outputChannel) {
      this.outputChannel = vscode.window.createOutputChannel("MiMo");
      this.context.subscriptions.push(this.outputChannel);
    }
    return this.outputChannel;
  }

  private log(message: string): void {
    this.getOutputChannel().appendLine(`[${new Date().toISOString()}] ${message}`);
  }

  private debugLog(message: string): void {
    if (getSettings().debugLogging) {
      this.log(message);
    }
  }

  private async getMetadataSnapshot(): Promise<CachedModelMetadataSnapshot> {
    return getMiMoModelMetadata(
      this.context,
      getSettings().debugLogging ? this.getOutputChannel() : undefined,
    );
  }

  private resolveModelMetadata(
    modelId: string,
    snapshot: CachedModelMetadataSnapshot,
  ): ResolvedModelMetadata {
    return resolveModelMetadata(
      modelId,
      this.definition.vendor,
      snapshot,
      this.liveModelMetadataById,
    );
  }

  private replaceLiveModelMetadata(entries: ModelListEntry[] | undefined): void {
    this.liveModelMetadataById.clear();
    for (const entry of entries ?? []) {
      if (typeof entry.id !== "string" || !entry.id) {
        continue;
      }
      const metadata = normalizeLiveModelMetadata(entry);
      if (metadata) {
        this.liveModelMetadataById.set(entry.id, metadata);
      }
    }
  }

  private recentTransportSummariesStorageKey(): string {
    return `${RECENT_TRANSPORT_SUMMARY_STORAGE_PREFIX}.${this.definition.vendor}`;
  }

  private restoreRecentTransportSummaries(): void {
    const stored = this.context.globalState.get<RecentTransportSummary[]>(
      this.recentTransportSummariesStorageKey(),
      [],
    );

    if (!Array.isArray(stored) || !stored.length) {
      return;
    }

    this.recentTransportSummaries.push(
      ...stored.slice(-RECENT_TRANSPORT_SUMMARY_LIMIT),
    );
  }

  private persistRecentTransportSummaries(): void {
    void this.context.globalState.update(
      this.recentTransportSummariesStorageKey(),
      this.recentTransportSummaries,
    );
  }

  private recordTransportSummary(
    summary: TransportRequestSummary,
    endpointKind: string,
    metadataSource: string,
    requestInitiator: unknown,
  ): void {
    const initiator = typeof requestInitiator === "string"
      ? requestInitiator
      : requestInitiator === undefined || requestInitiator === null
        ? undefined
        : String(requestInitiator);

    this.recentTransportSummaries.push({
      ...summary,
      recordedAt: new Date().toISOString(),
      endpointKind,
      metadataSource,
      ...(initiator ? { requestInitiator: initiator } : {}),
    });

    if (this.recentTransportSummaries.length > RECENT_TRANSPORT_SUMMARY_LIMIT) {
      this.recentTransportSummaries.splice(
        0,
        this.recentTransportSummaries.length - RECENT_TRANSPORT_SUMMARY_LIMIT,
      );
    }

    this.persistRecentTransportSummaries();
  }

  private recentTransportDiagnosticsLines(): string[] {
    if (!this.recentTransportSummaries.length) {
      return ["No requests recorded in this extension host yet.", ""];
    }

    return this.recentTransportSummaries
      .slice()
      .reverse()
      .flatMap((summary, index) => {
        const status = summary.status ?? summary.abortedReason ?? "n/a";
        const cacheHitRatio = formatCacheHitRatio({
          promptTokens: summary.promptTokens,
          cachedTokens: summary.cachedTokens,
        });
        const lines = [
          `### ${index + 1}. ${summary.modelId}`,
          "",
          `- time: ${summary.recordedAt}`,
          `- endpoint: ${summary.endpointKind}`,
          `- initiator: ${summary.requestInitiator ?? "unknown"}`,
          `- metadataSource: ${summary.metadataSource}`,
          `- status: ${status}`,
          `- durationMs: ${summary.durationMs}`,
          `- ttfbMs: ${summary.ttfbMs ?? "n/a"}`,
          `- totalBytes: ${summary.totalBytes}`,
          `- totalEvents: ${summary.totalEvents}`,
          `- tokens: prompt=${summary.promptTokens ?? "n/a"}, completion=${summary.completionTokens ?? "n/a"}, total=${summary.totalTokens ?? "n/a"}, cached=${summary.cachedTokens ?? "n/a"}`,
          `- cacheHitRatio: ${cacheHitRatio ?? "n/a"}`,
          `- finishReason: ${summary.finishReason ?? "n/a"}`,
          `- requestId: ${summary.requestId ?? "n/a"}`,
          `- sessionId: ${summary.sessionId ?? "n/a"}`,
          `- url: ${summary.url}`,
        ];

        if (summary.rateLimitSummary) {
          lines.push(`- rateLimit: ${summary.rateLimitSummary}`);
        }
        if (summary.errorMessage) {
          lines.push(`- error: ${summary.errorMessage}`);
        }

        lines.push("");
        return lines;
      });
  }

  private async refreshMetadataAndModels(): Promise<void> {
    const apiKey = await this.context.secrets.get(SECRET_KEY);
    await clearMiMoModelMetadataCache(this.context);
    await this.fetchModels(apiKey, { showNotification: true });
  }

  async manage(): Promise<void> {
    const apiKey = await this.context.secrets.get(SECRET_KEY);

    if (!apiKey) {
      await this.setApiKey();
      return;
    }

    const choice = await vscode.window.showQuickPick(
      [
        { label: "Set API Key", action: "set" as const },
        { label: "Clear API Key", action: "clear" as const },
        { label: "Test Connection", action: "test" as const },
        { label: "Refresh Models", action: "refresh" as const }
      ],
      {
        title: `Manage ${this.definition.displayName}`,
        placeHolder: "Choose an action"
      }
    );

    if (!choice) {
      return;
    }

    if (choice.action === "set") {
      await this.setApiKey();
      return;
    }

    if (choice.action === "clear") {
      await this.context.secrets.delete(SECRET_KEY);
      this.changeEmitter.fire();
      vscode.window.showInformationMessage("MiMo API key cleared.");
      return;
    }

    if (choice.action === "test") {
      await this.testConnection();
      return;
    }

    await this.refreshMetadataAndModels();
    this.changeEmitter.fire();
    vscode.window.showInformationMessage(`${this.definition.displayName} models refreshed.`);
  }

  async testConnection(): Promise<void> {
    const apiKey = await this.context.secrets.get(SECRET_KEY);
    if (!apiKey) {
      vscode.window.showErrorMessage(`${this.definition.displayName}: No API key set. Use 'Set API Key' first.`);
      return;
    }

    const statusBar = vscode.window.setStatusBarMessage(`$(loading~spin) Testing ${this.definition.displayName} connection...`);
    this.log(`Testing connection to ${this.definition.chatCompletionsUrl}`);

    try {
      const response = await fetch(this.definition.chatCompletionsUrl, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: this.definition.testModelId,
          messages: [{ role: "user", content: "reply with just: ok" }],
          max_tokens: 10,
          stream: false
        })
      });

      const responseText = await response.text();
      statusBar.dispose();
      this.log(`Test response (${response.status}): ${responseText}`);
      this.getOutputChannel().show(true);

      if (response.ok) {
        vscode.window.showInformationMessage(`${this.definition.displayName}: Connection OK (HTTP ${response.status}). Check Output panel for details.`);
      } else {
        vscode.window.showErrorMessage(`${this.definition.displayName}: Connection failed (HTTP ${response.status}). Check Output panel for details.`);
      }
    } catch (error) {
      statusBar.dispose();
      const message = error instanceof Error ? error.message : String(error);
      this.log(`Test connection error: ${message}`);
      this.getOutputChannel().show(true);
      vscode.window.showErrorMessage(`${this.definition.displayName}: Connection error - ${message}`);
    }
  }

  async setApiKey(): Promise<void> {
    const apiKey = await vscode.window.showInputBox({
      title: "MiMo API Key",
      prompt: "Paste your MiMo API key. It will be stored securely in VS Code SecretStorage.",
      password: true,
      ignoreFocusOut: true
    });

    if (!apiKey) {
      return;
    }

    await this.context.secrets.store(SECRET_KEY, apiKey.trim());
    this.changeEmitter.fire();
    vscode.window.showInformationMessage("MiMo API key saved.");
  }

  async showDiagnostics(): Promise<void> {
    const models = await vscode.lm.selectChatModels({ vendor: this.definition.vendor });
    const metadataSnapshot = await this.getMetadataSnapshot();
    const lines = models.map((model) => {
      const rawModelId = resolveRawModelId(model.id);
      const metadata = this.resolveModelMetadata(rawModelId, metadataSnapshot);
      const limits = modelLimits(metadata);
      return [
      `- ${rawModelId}`,
      `  rawModelId: ${rawModelId}`,
      `  name: ${model.name}`,
      `  family: ${model.family}`,
      `  vendor: ${model.vendor}`,
      `  version: ${model.version}`,
      `  maxInputTokens: ${model.maxInputTokens}`,
      `  advertisedMaxOutputTokens: ${limits.advertisedMaxOutputTokens}`,
      `  advertisedContextWindow: ${limits.advertisedContextWindow}`,
      `  apiMaxOutputTokens: ${limits.maxOutputTokens}`,
      `  metadataSource: ${metadata.source}`,
      `  supportsVision: ${metadata.supportsVision}`,
      `  status: ${metadata.status ?? "active"}`,
      `  thinkingFamily: ${thinkingFamily(rawModelId) ?? "none"}`,
      `  configurationSchema: ${JSON.stringify((model as unknown as { configurationSchema?: unknown }).configurationSchema ?? null)}`,
      ...(hasExplicitModelLimits(rawModelId, this.definition.vendor) ? [] : ["  limits: using bundled fallback"])
      ].join("\n");
    });

    const content = [
      `# ${this.definition.displayName} Diagnostics`,
      "",
      "## Recent Requests",
      "",
      ...this.recentTransportDiagnosticsLines(),
      `## Models`,
      "",
      `Models visible through vscode.lm.selectChatModels({ vendor: "${this.definition.vendor}" }): ${models.length}`,
      "",
      ...lines
    ].join("\n");

    const doc = await vscode.workspace.openTextDocument({ content, language: "markdown" });
    await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
  }

  async provideLanguageModelChatInformation(
    options: vscode.PrepareLanguageModelChatModelOptions,
    token: vscode.CancellationToken
  ): Promise<MiMoModel[]> {
    const apiKey =
      getConfiguredApiKey(options as ConfiguredLanguageModelInfoOptions)
      ?? await this.context.secrets.get(SECRET_KEY);

    if (!apiKey) {
      return [];
    }

    if (token.isCancellationRequested) {
      return [];
    }

    const models = await this.fetchModels(apiKey);
    const settings = getSettings();
    const metadataSnapshot = await this.getMetadataSnapshot();

    return models.map((modelId) => {
      const metadata = this.resolveModelMetadata(modelId, metadataSnapshot);
      const routing = resolveModelRouting(modelId, this.definition);
      const effectiveModelId = toEffectiveModelId(modelId, this.definition.vendor);
      const limits = modelLimits(metadata, settings);
      this.apiKeysByModelId.set(modelId, apiKey);
      this.apiKeysByModelId.set(effectiveModelId, apiKey);

      const capacityNote = CAPACITY_LIMITED_MODEL_NOTES[modelId];
      const baseDetail = this.definition.displayName;
      const baseTooltip = `${this.definition.displayName} model: ${modelId}`;
      const configurationSchema = modelConfigurationSchema(modelId);

      const info: MiMoModel = {
        id: effectiveModelId,
        rawModelId: modelId,
        name: `${this.definition.modelNamePrefix} / ${formatModelName(modelId)}`,
        family: `${this.definition.vendor}-${modelId}-${MODEL_METADATA_REVISION}`,
        // Include effective limits in version so VS Code invalidates stale
        // picker metadata after limit changes (eg. 2M -> 262K corrections).
        version: `1.2.0-${MODEL_METADATA_REVISION}-${limits.contextWindow}-${limits.maxOutputTokens}`,
        detail: capacityNote ? `${baseDetail} • Limited capacity` : baseDetail,
        tooltip: capacityNote ? `${baseTooltip}\n\nℹ ${capacityNote}` : baseTooltip,
        category: {
          label: this.definition.displayName,
          order: this.definition.categoryOrder
        },
        isUserSelectable: true,
        maxInputTokens: limits.advertisedMaxInputTokens,
        maxOutputTokens: limits.advertisedMaxOutputTokens,
        capabilities: modelCapabilities(metadata),
        endpointKind: routing.endpointKind,
        provider: this.definition,
        // Inline so Copilot Chat picks up the Thinking submenu directly
        // Generate a stable per-session id.
        ...(configurationSchema ? { configurationSchema } : {})
      };

      this.debugLog(`Model registered: id=${info.id} family=${info.family} metadataSource=${metadata.source} endpointKind=${routing.endpointKind} endpointUrl=${routing.endpointUrl} configurationSchema=${configurationSchema ? JSON.stringify(configurationSchema) : "none"}`);

      return info;
    });
  }

  async provideLanguageModelChatResponse(
    model: MiMoModel,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart2>,
    token: vscode.CancellationToken
  ): Promise<void> {
    const apiKey =
      getConfiguredApiKey(options as ConfiguredLanguageModelResponseOptions)
      ?? this.apiKeysByModelId.get(model.id)
      ?? await this.context.secrets.get(SECRET_KEY);

    if (!apiKey) {
      throw new Error(`${this.definition.displayName} API key is required. Use the ${this.definition.displayName} gear icon in Language Models to configure it, then reload the window.`);
    }

    const apiMessages = normalizeMessages(messages.flatMap((message) => convertMessage(message, this.reasoningContentByToolCallId)));
    const baseSettings = getSettings();
    const rawModelId = model.rawModelId ?? resolveRawModelId(model.id);
    // Apply per-request Thinking selection (from Copilot Chat submenu) on top
    // of the workspace default. The override only affects the current model
    // family; other families remain at their global defaults.
    const requestOverride = getRequestModelConfiguration(options);
    const settings: ApiSettings = {
      ...baseSettings,
      thinking: applyRequestThinkingOverride(rawModelId, baseSettings.thinking, requestOverride)
    };
    const metadataSnapshot = await this.getMetadataSnapshot();
    const metadata = this.resolveModelMetadata(rawModelId, metadataSnapshot);
    const routing = resolveModelRouting(rawModelId, this.definition);
    const limits = modelLimits(metadata, settings);
    const hasImageInput = messagesHaveImages(apiMessages);
    const thinkingPayload = buildThinkingPayload(rawModelId, settings.thinking, hasImageInput);
    const requestHeaders = buildMiMoRequestHeaders(
      messages,
      options,
      rawModelId,
    );
    const outputChannel =
      settings.debugLogging || settings.debugReasoning
        ? this.getOutputChannel()
        : undefined;
    const onTransportSummary = (summary: TransportRequestSummary) => {
      this.recordTransportSummary(
        summary,
        routing.endpointKind,
        metadata.source,
        options.requestInitiator,
      );
      updateUsageStatusBar(this.definition.displayName, rawModelId, summary);
    };

    this.debugLog(`Request: initiator=${options.requestInitiator} model=${model.id} rawModel=${rawModelId} endpoint=${routing.endpointKind} metadataSource=${metadata.source} messages=${apiMessages.length} session=${requestHeaders["x-mimo-session"]} request=${requestHeaders["x-mimo-request"]} modelConfiguration=${JSON.stringify(pickThinkingModelConfiguration(requestOverride))} thinking=${JSON.stringify(settings.thinking)} thinkingPayload=${JSON.stringify(thinkingPayload)}`);
    if (settings.debugReasoning) {
      this.log("Reasoning debug is enabled. Provider reasoning_content will be written to this output channel when available.");
    }

    try {
      const contextWindowOutputBuffer = limits.advertisedMaxOutputTokens;

      if (routing.endpointKind === "messages") {
        await runStreamAnthropicMessages({
          url: routing.endpointUrl,
          providerDisplayName: this.definition.displayName,
          apiKey,
          modelId: rawModelId,
          body: buildAnthropicMessagesRequestBody(rawModelId, apiMessages, options, settings, limits),
          requestHeaders,
          progress,
          token,
          output: outputChannel,
          debugReasoning: settings.debugReasoning,
          debugTransport: settings.debugLogging,
          requestTimeoutMs: settings.requestTimeoutMs,
          streamIdleTimeoutMs: settings.streamIdleTimeoutMs,
          contextWindowOutputBuffer,
          authHeaders: buildMiMoAuthHeaders("messages", apiKey),
          capacityLimitedModelNotes: CAPACITY_LIMITED_MODEL_NOTES,
          onTransportSummary,
        });
        return;
      }

      if (routing.endpointKind === "responses") {
        await runStreamResponsesApi({
          url: routing.endpointUrl,
          providerDisplayName: this.definition.displayName,
          apiKey,
          modelId: rawModelId,
          body: buildResponsesRequestBody(rawModelId, apiMessages, options, settings, limits),
          authHeaders: buildMiMoAuthHeaders("responses", apiKey),
          requestHeaders,
          progress,
          token,
          output: outputChannel,
          debugReasoning: settings.debugReasoning,
          debugTransport: settings.debugLogging,
          requestTimeoutMs: settings.requestTimeoutMs,
          streamIdleTimeoutMs: settings.streamIdleTimeoutMs,
          contextWindowOutputBuffer,
          capacityLimitedModelNotes: CAPACITY_LIMITED_MODEL_NOTES,
          onTransportSummary,
          onReasoningContent: (toolCallIds, reasoningContent) => {
          for (const toolCallId of toolCallIds) {
            this.reasoningContentByToolCallId.set(toolCallId, reasoningContent);
          }
          }
        });
        this.debugLog(`Request completed: model=${model.id}`);
        return;
      }

      if (routing.endpointKind === "google") {
        await runStreamGoogleGenerateContent({
          url: routing.endpointUrl,
          providerDisplayName: this.definition.displayName,
          apiKey,
          modelId: rawModelId,
          body: buildGoogleGenerateContentBody(apiMessages, options, settings, limits),
          requestHeaders,
          progress,
          token,
          output: outputChannel,
          debugReasoning: settings.debugReasoning,
          debugTransport: settings.debugLogging,
          requestTimeoutMs: settings.requestTimeoutMs,
          streamIdleTimeoutMs: settings.streamIdleTimeoutMs,
          contextWindowOutputBuffer,
          authHeaders: buildMiMoAuthHeaders("google", apiKey),
          capacityLimitedModelNotes: CAPACITY_LIMITED_MODEL_NOTES,
          onTransportSummary,
          onReasoningContent: (toolCallIds, reasoningContent) => {
          for (const toolCallId of toolCallIds) {
            this.reasoningContentByToolCallId.set(toolCallId, reasoningContent);
          }
          }
        });
        return;
      }

      await runStreamChatCompletions({
        url: routing.endpointUrl,
        providerDisplayName: this.definition.displayName,
        apiKey,
        modelId: rawModelId,
        body: buildChatCompletionsRequestBody(rawModelId, apiMessages, options, settings, limits),
        authHeaders: buildMiMoAuthHeaders("chat-completions", apiKey),
        requestHeaders,
        progress,
        token,
        output: outputChannel,
        debugReasoning: settings.debugReasoning,
        debugTransport: settings.debugLogging,
        requestTimeoutMs: settings.requestTimeoutMs,
        streamIdleTimeoutMs: settings.streamIdleTimeoutMs,
        contextWindowOutputBuffer,
        capacityLimitedModelNotes: CAPACITY_LIMITED_MODEL_NOTES,
        onTransportSummary,
        onReasoningContent: (toolCallIds, reasoningContent) => {
          for (const toolCallId of toolCallIds) {
            this.reasoningContentByToolCallId.set(toolCallId, reasoningContent);
          }
        }
      });
      this.debugLog(`Request completed: model=${model.id}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`ERROR model=${model.id}: ${message}`);
      this.getOutputChannel().show(true);
      if (error instanceof MiMoRequestError) {
        vscode.window.showErrorMessage(error.userMessage);
      }
      throw error;
    }
  }

  async provideTokenCount(
    _model: MiMoModel,
    text: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken
  ): Promise<number> {
    return typeof text === "string"
      ? estimateTokenCount(text)
      : estimateChatMessageTokenCount(text);
  }

  private async fetchModels(
    apiKey?: string,
    options?: { showNotification?: boolean },
  ): Promise<string[]> {
    const showNotification = options?.showNotification ?? false;
    try {
      const headers: Record<string, string> = {
        "User-Agent": MIMO_USER_AGENT,
      };
      if (apiKey) {
        headers["Authorization"] = `Bearer ${apiKey}`;
      }
      const response = await fetch(this.definition.modelsUrl, { headers });

      if (!response.ok) {
        throw new Error(`Model list request failed (${response.status}): ${response.statusText}`);
      }

      const data = await response.json() as ModelListResponse;
      this.replaceLiveModelMetadata(data.data);
      const ids = data.data
        ?.map((model) => model.id)
        .filter((id): id is string => typeof id === "string" && id.length > 0)
        .filter((id) => this.definition.filterModel?.(id) ?? true);

      return this.filterAvailableModels(ids?.length ? ids : this.definition.fallbackModels);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const warning = `Could not fetch ${this.definition.displayName} model list. Using bundled model list. ${message}`;
      this.log(`WARN ${warning}`);
      if (showNotification) {
        vscode.window.showWarningMessage(warning);
      }
      return this.filterAvailableModels(this.definition.fallbackModels);
    }
  }

  private async filterAvailableModels(modelIds: string[]): Promise<string[]> {
    const uniqueModelIds = [...new Set(modelIds)];

    try {
      const metadataSnapshot = await this.getMetadataSnapshot();
      const filteredModelIds = uniqueModelIds.filter((modelId) =>
        !KNOWN_UNAVAILABLE_MODEL_IDS.has(modelId)
        && !shouldHideDeprecatedModel(modelId, this.definition.vendor, metadataSnapshot)
      );

      const removedModelIds = uniqueModelIds.filter((modelId) => !filteredModelIds.includes(modelId));
      if (removedModelIds.length) {
        this.debugLog(`Filtered unavailable/deprecated models: ${removedModelIds.join(", ")}`);
      }

      return filteredModelIds;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.debugLog(`Could not fetch model status metadata from models.dev. Applying local unavailable model filter only. ${message}`);
      return uniqueModelIds.filter((modelId) => !KNOWN_UNAVAILABLE_MODEL_IDS.has(modelId));
    }
  }

}

function getConfiguredApiKey(options?: { configuration?: LanguageModelConfiguration }): string | undefined {
  const configuredApiKey = options?.configuration?.apiKey;
  return typeof configuredApiKey === "string" && configuredApiKey.trim() ? configuredApiKey.trim() : undefined;
}

async function clearMiMoModelMetadataCache(
  context: vscode.ExtensionContext,
): Promise<void> {
  modelMetadataSnapshot = undefined;
  modelMetadataRefreshPromise = undefined;
  await context.globalState.update(MODEL_METADATA_CACHE_KEY, undefined);
}

async function getMiMoModelMetadata(
  context: vscode.ExtensionContext,
  output?: vscode.OutputChannel,
): Promise<CachedModelMetadataSnapshot> {
  const cached =
    modelMetadataSnapshot ??
    context.globalState.get<CachedModelMetadataSnapshot>(
      MODEL_METADATA_CACHE_KEY,
    );
  if (cached) {
    modelMetadataSnapshot = cached;
    if (isFreshModelMetadata(cached)) {
      return cached;
    }
    void refreshMiMoModelMetadata(context, output);
    return cached;
  }

  return refreshMiMoModelMetadata(context, output);
}

async function refreshMiMoModelMetadata(
  context: vscode.ExtensionContext,
  output?: vscode.OutputChannel,
): Promise<CachedModelMetadataSnapshot> {
  if (modelMetadataRefreshPromise) {
    return modelMetadataRefreshPromise;
  }

  modelMetadataRefreshPromise = (async () => {
    const response = await fetch(MODELS_DEV_API_URL, {
      signal: AbortSignal.timeout(10_000)
    });

    if (!response.ok) {
      throw new Error(`models.dev request failed (${response.status}): ${response.statusText}`);
    }

    const data = await response.json() as ModelsDevResponse;
    const snapshot = normalizeModelsDevSnapshot(data);
    modelMetadataSnapshot = snapshot;
    await context.globalState.update(MODEL_METADATA_CACHE_KEY, snapshot);
    output?.appendLine(
      `[metadata] refreshed models.dev cache mimo=${Object.keys(snapshot.providers[MIMO_VENDOR]).length}`,
    );
    return snapshot;
  })()
    .catch((error) => {
      const cached =
        modelMetadataSnapshot ??
        context.globalState.get<CachedModelMetadataSnapshot>(
          MODEL_METADATA_CACHE_KEY,
        );
      if (cached) {
        const message = error instanceof Error ? error.message : String(error);
        output?.appendLine(
          `[metadata] refresh failed, using cached snapshot: ${message}`,
        );
        modelMetadataSnapshot = cached;
        return cached;
      }

      const message = error instanceof Error ? error.message : String(error);
      const fallback = bundledModelMetadataSnapshot();
      output?.appendLine(
        `[metadata] refresh failed, using bundled snapshot: ${message}`,
      );
      modelMetadataSnapshot = fallback;
      return fallback;
    })
    .finally(() => {
      modelMetadataRefreshPromise = undefined;
    });

  return modelMetadataRefreshPromise;
}

function buildChatCompletionsRequestBody(
  modelId: string,
  messages: ApiMessage[],
  options: vscode.ProvideLanguageModelChatResponseOptions,
  settings: ApiSettings,
  limits: ModelLimits,
): Record<string, unknown> {
  const tools = mapOpenAiTools(options.tools);
  const thinkingPayload = buildThinkingPayload(modelId, settings.thinking, messagesHaveImages(messages));

  return {
    model: modelId,
    messages,
    temperature: settings.temperature,
    max_tokens: limits.maxOutputTokens,
    stream: true,
    stream_options: { include_usage: true },
    ...thinkingPayload,
    ...(tools.length ? { tools, tool_choice: toolChoice(options.toolMode) } : {}),
  };
}

function buildAnthropicMessagesRequestBody(
  modelId: string,
  messages: ApiMessage[],
  options: vscode.ProvideLanguageModelChatResponseOptions,
  settings: ApiSettings,
  limits: ModelLimits,
): Record<string, unknown> {
  const tools = mapAnthropicTools(options.tools);
  const thinkingPayload = buildThinkingPayload(modelId, settings.thinking, messagesHaveImages(messages));
  const anthropicMessages = buildAnthropicMessages(messages);

  return {
    model: modelId,
    temperature: settings.temperature,
    max_tokens: limits.maxOutputTokens,
    stream: true,
    messages: anthropicMessages,
    ...thinkingPayload,
    ...(tools.length
      ? { tools, tool_choice: anthropicToolChoice(options.toolMode) }
      : {}),
  };
}

function buildAnthropicMessages(messages: ApiMessage[]): AnthropicRequestMessage[] {
  let cacheControlCount = 0;
  const nextCacheControl = (): { cache_control?: AnthropicCacheControl } => {
    cacheControlCount += 1;
    return cacheControlCount <= 4
      ? { cache_control: { type: "ephemeral" } }
      : {};
  };

  const anthropicMessages: AnthropicRequestMessage[] = [];

  for (const message of messages) {
    if (message.role === "user") {
      const userBlocks = anthropicUserBlocks(message.content, nextCacheControl);
      if (userBlocks.length) {
        anthropicMessages.push({ role: "user", content: userBlocks });
      }
      continue;
    }

    if (message.role === "assistant") {
      const assistantBlocks = anthropicAssistantBlocks(message, nextCacheControl);
      if (assistantBlocks.length) {
        anthropicMessages.push({ role: "assistant", content: assistantBlocks });
      }
      continue;
    }

    if (message.role === "tool" && message.tool_call_id) {
      anthropicMessages.push({
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: message.tool_call_id,
          content: joinedTextContent(message.content, "\n"),
          ...nextCacheControl(),
        }],
      });
    }
  }

  if (!anthropicMessages.length) {
    anthropicMessages.push({
      role: "user",
      content: [{ type: "text", text: "Continue the conversation.", ...nextCacheControl() }],
    });
  }

  return anthropicMessages;
}

function anthropicUserBlocks(
  content: ApiMessage["content"],
  nextCacheControl: () => { cache_control?: AnthropicCacheControl },
): AnthropicContentBlock[] {
  if (typeof content === "string") {
    return content.trim()
      ? [{ type: "text", text: content, ...nextCacheControl() }]
      : [];
  }

  if (!Array.isArray(content)) {
    return [];
  }

  const blocks: AnthropicContentBlock[] = [];
  for (const part of content) {
    if (part.type === "text" && typeof part.text === "string" && part.text.length > 0) {
      blocks.push({ type: "text", text: part.text, ...nextCacheControl() });
      continue;
    }

    if (part.type === "image_url") {
      const source = anthropicImageSource(part);
      if (source) {
        blocks.push({ type: "image", source, ...nextCacheControl() });
      }
    }
  }

  return blocks;
}

function anthropicAssistantBlocks(
  message: ApiMessage,
  nextCacheControl: () => { cache_control?: AnthropicCacheControl },
): AnthropicContentBlock[] {
  const blocks: AnthropicContentBlock[] = [];

  const text = joinedTextContent(message.content);
  if (text) {
    blocks.push({ type: "text", text, ...nextCacheControl() });
  }

  for (const toolCall of message.tool_calls ?? []) {
    blocks.push({
      type: "tool_use",
      id: toolCall.id || `toolu_${Math.random().toString(36).slice(2)}`,
      name: toolCall.function.name,
      input: anthropicToolCallInput(toolCall.function.arguments),
      ...nextCacheControl(),
    });
  }

  return blocks;
}

function anthropicToolCallInput(argumentsText: string): unknown {
  if (!argumentsText.trim()) {
    return {};
  }

  try {
    return JSON.parse(argumentsText);
  } catch {
    return argumentsText;
  }
}

function anthropicImageSource(
  part: OpenAiContentPart,
): AnthropicImageSource | undefined {
  if (part.type !== "image_url") {
    return undefined;
  }

  const url = part.image_url?.url;
  if (typeof url !== "string" || !url) {
    return undefined;
  }

  const match = /^data:([^;]+);base64,(.*)$/i.exec(url);
  if (match) {
    return {
      type: "base64",
      media_type: match[1],
      data: match[2],
    };
  }

  return { type: "url", url };
}

function mapResponsesTools(tools: readonly vscode.LanguageModelChatTool[] | undefined): Array<Record<string, unknown>> {
  return (tools ?? []).map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: sanitizeToolSchema(tool.inputSchema),
  }));
}

function buildResponsesRequestBody(
  modelId: string,
  messages: ApiMessage[],
  options: vscode.ProvideLanguageModelChatResponseOptions,
  settings: ApiSettings,
  limits: ModelLimits,
): Record<string, unknown> {
  const input = messages.flatMap((message) => responsesInputItemsFromMessage(message));
  const tools = mapResponsesTools(options.tools);

  return {
    model: modelId,
    input,
    max_output_tokens: limits.maxOutputTokens,
    temperature: settings.temperature,
    stream: true,
    ...(tools.length ? { tools, tool_choice: toolChoice(options.toolMode) } : {}),
    text: { verbosity: modelId === "gpt-5-codex" ? "medium" : "low" },
  };
}

function responsesInputItemsFromMessage(message: ApiMessage): Array<Record<string, unknown>> {
  if (message.role === "user") {
    const content = responsesUserContent(message.content);
    return content.length ? [{ role: "user", content }] : [];
  }

  if (message.role === "assistant") {
    const items: Array<Record<string, unknown>> = [];
    const text = responsesAssistantText(message.content);
    if (text) {
      items.push({ role: "assistant", content: [{ type: "output_text", text }] });
    }

    for (const toolCall of message.tool_calls ?? []) {
      items.push({
        type: "function_call",
        id: toolCall.id,
        call_id: toolCall.id,
        name: toolCall.function.name,
        arguments: toolCall.function.arguments,
      });
    }

    return items;
  }

  if (message.role === "tool") {
    return [{
      type: "function_call_output",
      call_id: message.tool_call_id ?? `tool-${Date.now()}`,
      output: typeof message.content === "string"
        ? message.content
        : JSON.stringify(message.content ?? ""),
    }];
  }

  return [];
}

function responsesUserContent(content: ApiMessage["content"]): Array<Record<string, unknown>> {
  if (typeof content === "string") {
    return content ? [{ type: "input_text", text: content }] : [];
  }

  if (!Array.isArray(content)) {
    return [];
  }

  return content.flatMap((part): Array<Record<string, unknown>> => {
    if (part.type === "text" && typeof part.text === "string") {
      return [{ type: "input_text", text: part.text }];
    }

    if (part.type === "image_url" && part.image_url?.url) {
      return [{ type: "input_image", image_url: { url: part.image_url.url } }];
    }

    return [];
  });
}

function responsesAssistantText(content: ApiMessage["content"]): string {
  return joinedTextContent(content);
}

function joinedTextContent(
  content: ApiMessage["content"],
  separator = "",
): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .filter((part): part is OpenAiContentPart & { text: string } => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join(separator);
}

function buildGoogleGenerateContentBody(
  messages: ApiMessage[],
  options: vscode.ProvideLanguageModelChatResponseOptions,
  settings: ApiSettings,
  limits: ModelLimits,
): Record<string, unknown> {
  const tools = mapGoogleTools(options.tools);

  return {
    contents: googleContentsFromMessages(messages),
    generationConfig: {
      maxOutputTokens: limits.maxOutputTokens,
      temperature: settings.temperature,
    },
    ...(tools.length ? { tools: [{ functionDeclarations: tools }], toolConfig: googleToolConfig(options.toolMode) } : {}),
  };
}

function mapGoogleTools(tools: readonly vscode.LanguageModelChatTool[] | undefined): Array<Record<string, unknown>> {
  return (tools ?? []).map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: sanitizeToolSchema(tool.inputSchema),
  }));
}

function googleToolConfig(mode: vscode.LanguageModelChatToolMode): Record<string, unknown> {
  return {
    functionCallingConfig: {
      mode: mode === vscode.LanguageModelChatToolMode.Required ? "ANY" : "AUTO",
    },
  };
}

function googleContentsFromMessages(messages: ApiMessage[]): Array<Record<string, unknown>> {
  const toolNamesById = new Map<string, string>();
  const contents: Array<Record<string, unknown>> = [];

  for (const message of messages) {
    if (message.role === "user") {
      const parts = googleUserParts(message.content);
      if (parts.length) {
        contents.push({ role: "user", parts });
      }
      continue;
    }

    if (message.role === "assistant") {
      const parts: Array<Record<string, unknown>> = [];
      if (typeof message.reasoning_content === "string" && message.reasoning_content.trim()) {
        parts.push({ text: message.reasoning_content, thought: true });
      }
      const text = responsesAssistantText(message.content);
      if (text) {
        parts.push({ text });
      }
      for (const toolCall of message.tool_calls ?? []) {
        const args = parseToolInput(toolCall.function.arguments);
        parts.push({ functionCall: { name: toolCall.function.name, args } });
        toolNamesById.set(toolCall.id, toolCall.function.name);
      }
      if (parts.length) {
        contents.push({ role: "model", parts });
      }
      continue;
    }

    if (message.role === "tool" && message.tool_call_id) {
      const name = toolNamesById.get(message.tool_call_id) ?? "tool";
      const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? "");
      contents.push({
        role: "user",
        parts: [{
          functionResponse: {
            name,
            response: { name, content },
          },
        }],
      });
    }
  }

  return contents;
}

function googleUserParts(content: ApiMessage["content"]): Array<Record<string, unknown>> {
  if (typeof content === "string") {
    return content ? [{ text: content }] : [];
  }

  if (!Array.isArray(content)) {
    return [];
  }

  return content.flatMap((part): Array<Record<string, unknown>> => {
    if (part.type === "text" && typeof part.text === "string") {
      return [{ text: part.text }];
    }

    if (part.type === "image_url" && part.image_url?.url) {
      const inlineData = dataUrlToInlineData(part.image_url.url);
      return inlineData ? [{ inlineData }] : [];
    }

    return [];
  });
}

function dataUrlToInlineData(url: string): { mimeType: string; data: string } | undefined {
  const match = /^data:(.+?);base64,(.+)$/i.exec(url);
  if (!match) {
    return undefined;
  }
  return {
    mimeType: match[1],
    data: match[2],
  };
}

function parseToolInput(value: string): object {
  if (!value.trim()) {
    return {};
  }

  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

// The MiMo extension sends these headers on every request.
// The gateway reads x-mimo-session first, then converts that sticky identifier
// into provider-specific affinity headers such as x-session-affinity upstream.
//
// VS Code's provider API does not currently expose a guaranteed public session
// identifier everywhere, so we first probe a few known internal fields and then
// fall back to a stable hash of the first messages in the conversation. That
// preserves sticky routing and cache affinity without depending on hidden state.
function buildMiMoRequestHeaders(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
  options: vscode.ProvideLanguageModelChatResponseOptions,
  modelId: string,
): Record<string, string> {
  const sessionId = cleanHeaderValue(
    findStringOption(options, [
      "sessionId",
      "sessionID",
      "chatSessionId",
      "chatSessionID",
      "conversationId",
      "conversationID",
      "threadId",
      "threadID",
      "session.id",
      "chatSession.id",
    ]) ?? `vscode-${stableHash(conversationAnchor(messages, modelId))}`,
  );
  const requestId = cleanHeaderValue(
    findStringOption(options, [
      "requestId",
      "requestID",
      "messageId",
      "messageID",
    ]) ??
      `req-${stableHash(`${Date.now()}-${Math.random()}-${sessionId}-${modelId}`)}`,
  );

  return {
    "x-mimo-session": sessionId,
    "x-mimo-request": requestId,
    "x-mimo-client": MIMO_CLIENT,
    "User-Agent": MIMO_USER_AGENT,
  };
}

function findStringOption(
  options: unknown,
  paths: string[],
): string | undefined {
  for (const path of paths) {
    const value = readPath(options, path.split("."));
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function readPath(value: unknown, path: string[]): unknown {
  let current = value;
  for (const segment of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

function conversationAnchor(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
  modelId: string,
): string {
  const anchorMessages = messages
    .slice(0, 3)
    .map((message) => `${message.role}:${messageText(message).slice(0, 2048)}`);
  return anchorMessages.length ? anchorMessages.join("\n") : modelId;
}

function cleanHeaderValue(value: string): string {
  const cleaned = value.replace(/[\r\n]/g, " ").trim();
  return cleaned ? cleaned.slice(0, 256) : "unknown";
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function mapOpenAiTools(tools: readonly vscode.LanguageModelChatTool[] | undefined): OpenAiToolDefinition[] {
  return (tools ?? []).map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: sanitizeToolSchema(tool.inputSchema)
    }
  }));
}

function mapAnthropicTools(tools: readonly vscode.LanguageModelChatTool[] | undefined): AnthropicToolDefinition[] {
  return (tools ?? []).map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: sanitizeToolSchema(tool.inputSchema)
  }));
}

function sanitizeToolSchema(schema: unknown): object {
  const root = isRecord(schema) ? schema : { type: "object", properties: {} };
  const sanitized = sanitizeJsonSchemaNode(root, root, new Set());
  if (!isRecord(sanitized)) {
    return { type: "object", properties: {} };
  }

  return {
    type: sanitized.type === "object" ? "object" : "object",
    properties: isRecord(sanitized.properties) ? sanitized.properties : {},
    ...(Array.isArray(sanitized.required) ? { required: sanitized.required } : {})
  };
}

function sanitizeJsonSchemaNode(value: unknown, root: Record<string, unknown>, seenRefs: Set<string>): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeJsonSchemaNode(item, root, seenRefs));
  }

  if (!isRecord(value)) {
    return value;
  }

  const ref = typeof value.$ref === "string" ? value.$ref : undefined;
  if (ref?.startsWith("#/") && !seenRefs.has(ref)) {
    const target = resolveJsonPointer(root, ref);
    if (target !== undefined) {
      const nextSeenRefs = new Set(seenRefs);
      nextSeenRefs.add(ref);
      const siblings = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "$ref"));
      const resolved = sanitizeJsonSchemaNode(target, root, nextSeenRefs);
      return isRecord(resolved)
        ? sanitizeJsonSchemaNode({ ...resolved, ...siblings }, root, nextSeenRefs)
        : sanitizeJsonSchemaNode(siblings, root, nextSeenRefs);
    }
  }

  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "$schema" || key === "$id" || key === "$ref" || key === "$defs" || key === "definitions") {
      continue;
    }

    if (key === "properties" && isRecord(child)) {
      result.properties = Object.fromEntries(
        Object.entries(child).map(([propertyName, propertySchema]) => [
          propertyName,
          sanitizeJsonSchemaNode(propertySchema, root, seenRefs)
        ])
      );
      continue;
    }

    if (key === "items" || key === "additionalProperties") {
      result[key] = sanitizeJsonSchemaNode(child, root, seenRefs);
      continue;
    }

    if ((key === "anyOf" || key === "oneOf" || key === "allOf") && Array.isArray(child)) {
      result[key] = child.map((item) => sanitizeJsonSchemaNode(item, root, seenRefs));
      continue;
    }

    if (["type", "description", "enum", "required", "minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems"].includes(key)) {
      result[key] = child;
    }
  }

  return result;
}

function resolveJsonPointer(root: Record<string, unknown>, pointer: string): unknown {
  return pointer
    .slice(2)
    .split("/")
    .reduce<unknown>((current, segment) => {
      if (!isRecord(current)) {
        return undefined;
      }
      return current[segment.replace(/~1/g, "/").replace(/~0/g, "~")];
    }, root);
}

function toolChoice(mode: vscode.LanguageModelChatToolMode): "auto" | "required" {
  return mode === vscode.LanguageModelChatToolMode.Required ? "required" : "auto";
}

function anthropicToolChoice(mode: vscode.LanguageModelChatToolMode): { type: "auto" | "any" } {
  return { type: mode === vscode.LanguageModelChatToolMode.Required ? "any" : "auto" };
}

function convertMessage(
  message: vscode.LanguageModelChatRequestMessage,
  reasoningContentByToolCallId: ReadonlyMap<string, string>
): ApiMessage[] {
  const role = message.role === vscode.LanguageModelChatMessageRole.Assistant ? "assistant" : "user";
  const textParts: string[] = [];
  const imageParts: OpenAiContentPart[] = [];
  const toolCalls: OpenAiToolCall[] = [];
  const toolResults: ApiMessage[] = [];

  for (const part of message.content) {
    if (part instanceof vscode.LanguageModelToolCallPart) {
      toolCalls.push({
        id: part.callId,
        type: "function",
        function: {
          name: part.name,
          arguments: JSON.stringify(part.input ?? {})
        }
      });
      continue;
    }

    if (part instanceof vscode.LanguageModelToolResultPart) {
      toolResults.push({
        role: "tool",
        tool_call_id: part.callId,
        content: part.content.map(partToText).filter(Boolean).join("\n")
      });
      continue;
    }

    if (part instanceof vscode.LanguageModelDataPart && part.mimeType.startsWith("image/")) {
      const base64 = dataPartToBase64(part.data);
      imageParts.push({
        type: "image_url",
        image_url: { url: `data:${part.mimeType};base64,${base64}` }
      });
      continue;
    }

    if (part instanceof vscode.LanguageModelDataPart && isInternalDataPart(part)) {
      continue;
    }

    const text = partToText(part);
    if (text) {
      textParts.push(text);
    }
  }

  // Build content: use multimodal array if images present, otherwise plain string
  const hasImages = imageParts.length > 0;
  const textContent = textParts.join("\n");

  let content: string | null | OpenAiContentPart[] = textContent;
  if (hasImages) {
    const multimodal: OpenAiContentPart[] = [];
    if (textContent) {
      multimodal.push({ type: "text", text: textContent });
    }
    multimodal.push(...imageParts);
    content = multimodal;
  }

  if (role === "assistant" && toolCalls.length) {
    return [{
      role,
      content: typeof content === "string" ? content || null : content,
      reasoning_content: reasoningForToolCalls(toolCalls, reasoningContentByToolCallId),
      tool_calls: toolCalls
    }];
  }

  if (toolResults.length) {
    return content ? [{ role, content }, ...toolResults] : toolResults;
  }

  return [{ role, content }];
}

function dataPartToBase64(data: Uint8Array): string {
  let output = "";

  for (let index = 0; index < data.length; index += 3) {
    const first = data[index] ?? 0;
    const second = data[index + 1] ?? 0;
    const third = data[index + 2] ?? 0;
    const chunk = (first << 16) | (second << 8) | third;

    output += BASE64_ALPHABET[(chunk >> 18) & 63];
    output += BASE64_ALPHABET[(chunk >> 12) & 63];
    output += index + 1 < data.length ? BASE64_ALPHABET[(chunk >> 6) & 63] : "=";
    output += index + 2 < data.length ? BASE64_ALPHABET[chunk & 63] : "=";
  }

  return output;
}

function reasoningForToolCalls(
  toolCalls: OpenAiToolCall[],
  reasoningContentByToolCallId: ReadonlyMap<string, string>
): string | undefined {
  const reasoning = toolCalls
    .map((toolCall) => reasoningContentByToolCallId.get(toolCall.id))
    .filter((value): value is string => Boolean(value?.trim()));

  return reasoning.length ? reasoning.join("\n") : undefined;
}

function messageText(message: vscode.LanguageModelChatRequestMessage): string {
  return message.content.map(partToText).filter(Boolean).join("\n");
}

function estimateChatMessageTokenCount(message: vscode.LanguageModelChatRequestMessage): number {
  const role = typeof message.role === "string" ? message.role : String(message.role);
  const name = typeof message.name === "string" ? message.name : "";
  const contentTokens = message.content
    .map(partToTokenCount)
    .reduce((total, count) => total + count, 0);

  return MESSAGE_TOKEN_OVERHEAD
    + estimateTokenCount(role)
    + (name ? MESSAGE_NAME_TOKEN_OVERHEAD + estimateTokenCount(name) : 0)
    + contentTokens;
}

function partToTokenCount(part: vscode.LanguageModelInputPart | unknown): number {
  if (part instanceof vscode.LanguageModelTextPart) {
    return estimateTokenCount(part.value);
  }

  if (part instanceof vscode.LanguageModelToolResultPart) {
    const contentTokens = part.content
      .map(partToTokenCount)
      .reduce((total, count) => total + count, 0);
    return TOOL_RESULT_TOKEN_OVERHEAD
      + estimateTokenCount(part.callId)
      + contentTokens;
  }

  if (part instanceof vscode.LanguageModelToolCallPart) {
    return TOOL_CALL_TOKEN_OVERHEAD
      + estimateTokenCount(part.callId)
      + estimateTokenCount(part.name)
      + estimateStructuredTokenCount(part.input);
  }

  if (part instanceof vscode.LanguageModelDataPart) {
    return isInternalDataPart(part) ? 0 : estimateDataPartTokenCount(part);
  }

  if (typeof part === "string") {
    return estimateTokenCount(part);
  }

  if (isRecord(part)) {
    return estimateStructuredTokenCount(part);
  }

  return 0;
}

function estimateStructuredTokenCount(value: unknown): number {
  try {
    return estimateTokenCount(JSON.stringify(value));
  } catch {
    return 0;
  }
}

function estimateDataPartTokenCount(part: vscode.LanguageModelDataPart): number {
  if (part.mimeType.startsWith("image/")) {
    return IMAGE_TOKEN_ESTIMATE;
  }

  if (part.mimeType.startsWith("text/") || part.mimeType === "application/json") {
    return estimateTokenCount(Buffer.from(part.data).toString("utf8"));
  }

  return Math.max(1, Math.ceil(part.data.byteLength / 4));
}

function partToText(part: vscode.LanguageModelInputPart | unknown): string {
  if (part instanceof vscode.LanguageModelTextPart) {
    return part.value;
  }

  if (part instanceof vscode.LanguageModelToolResultPart) {
    return part.content.map(partToText).filter(Boolean).join("\n");
  }

  if (part instanceof vscode.LanguageModelToolCallPart) {
    return `[Tool call: ${part.name} ${JSON.stringify(part.input)}]`;
  }

  if (part instanceof vscode.LanguageModelDataPart && isInternalDataPart(part)) {
    return "";
  }

  if (typeof part === "string") {
    return part;
  }

  return "";
}

function normalizeMessages(messages: ApiMessage[]): ApiMessage[] {
  const normalized: ApiMessage[] = [];

  for (const message of messages) {
    if (!hasMessagePayload(message)) {
      continue;
    }

    const previous = normalized.at(-1);
    const prevContent = previous?.content;
    const msgContent = message.content;
    const prevIsString = typeof prevContent === "string";
    const msgIsString = typeof msgContent === "string";
    const prevHasToolCalls = !!(previous?.tool_calls?.length || previous?.tool_call_id);
    const msgHasToolCalls = !!(message.tool_calls?.length || message.tool_call_id);

    if (
      previous?.role === message.role
      && message.role !== "tool"
      && prevIsString && msgIsString
      && !prevHasToolCalls && !msgHasToolCalls
    ) {
      previous.content = `${prevContent ?? ""}\n\n${msgContent ?? ""}`.trim();
    } else {
      normalized.push({ ...message });
    }
  }

  if (normalized[0]?.role === "assistant") {
    normalized.unshift({
      role: "user",
      content: "Continue the conversation based on the prior assistant message."
    });
  }

  return normalized.length ? normalized : [{ role: "user", content: "" }];
}

function messagesHaveImages(messages: readonly ApiMessage[]): boolean {
  return messages.some((message) =>
    Array.isArray(message.content)
    && message.content.some((part) => part.type === "image_url")
  );
}

function hasMessagePayload(message: ApiMessage): boolean {
  if (message.tool_calls?.length || message.tool_call_id) {
    return true;
  }

  if (typeof message.content === "string") {
    return message.content.trim().length > 0;
  }

  if (Array.isArray(message.content)) {
    return message.content.length > 0;
  }

  return false;
}

// Detect which Thinking family a raw model id belongs to. Used both to render
// the per-model picker submenu (configurationSchema) and to map the user's
// per-request selection back to the right MiMo request field.
type ThinkingFamily = "deepseek" | "glm" | "kimi" | "qwen" | null;
function thinkingFamily(modelId: string): ThinkingFamily {
  if (/^deepseek-/i.test(modelId)) return "deepseek";
  if (/^glm-/i.test(modelId)) return "glm";
  if (/^kimi-/i.test(modelId)) return "kimi";
  if (/^qwen3(?:\.|-)/i.test(modelId)) return "qwen";
  return null;
}

// Per-family JSON-Schema describing the native model-picker controls rendered
// by VS Code 1.120. Keep the primary property name aligned with VS Code's
// BYOK reasoning control so builds with narrower assumptions still recognize it.
function modelConfigurationSchema(modelId: string): vscode.LanguageModelConfigurationSchema | undefined {
  const family = thinkingFamily(modelId);
  if (!family) return undefined;

  if (family === "deepseek") {
    return {
      type: "object",
      properties: {
        reasoningEffort: {
          type: "string",
          title: "Thinking Effort",
          enum: ["off", "high", "max"],
          enumItemLabels: ["Off", "High", "Max"],
          enumDescriptions: [
            "Fastest responses",
            "More reasoning",
            "Maximum reasoning"
          ],
          default: "off",
          group: "navigation"
        }
      }
    };
  }

  if (family === "glm" || family === "kimi") {
    return {
      type: "object",
      properties: {
        reasoningEffort: {
          type: "string",
          title: "Thinking Effort",
          enum: ["off", "on"],
          enumItemLabels: ["Off", "On"],
          enumDescriptions: [
            "Fastest responses",
            "Enable thinking"
          ],
          default: "off",
          group: "navigation"
        }
      }
    };
  }

  // qwen
  return {
    type: "object",
    properties: {
      reasoningEffort: {
        type: "string",
        title: "Thinking Effort",
        enum: ["off", "auto", "on"],
        enumItemLabels: ["Off", "Auto", "On"],
        enumDescriptions: [
          "Fastest responses",
          "Model decides",
          "Enable thinking"
        ],
        default: "off",
        group: "navigation"
      },
      thinkingBudget: {
        type: "string",
        title: "Thinking Budget",
        enum: ["auto", "4096", "16384", "32768", "81920"],
        enumItemLabels: ["Auto", "4K", "16K", "32K", "80K"],
        enumDescriptions: [
          "Provider default",
          "Small budget",
          "Medium budget",
          "Large budget",
          "Maximum budget"
        ],
        default: "auto"
      }
    }
  };
}

// Merge per-request modelConfiguration (from the Copilot Chat submenu) onto
// the global ThinkingSettings, so the picker selection wins over the workspace
// default. Only the field for the model's own family is touched.
function applyRequestThinkingOverride(
  modelId: string,
  base: ThinkingSettings,
  override: Record<string, unknown> | undefined
): ThinkingSettings {
  if (!override) return base;
  const family = thinkingFamily(modelId);
  if (!family) return base;

  const next: ThinkingSettings = { ...base };
  const reasoningEffort = override.reasoningEffort;
  const thinkingMode = override.thinkingMode;
  const thinkingBudget = override.thinkingBudget;

  if (family === "deepseek" && typeof reasoningEffort === "string") {
    if (reasoningEffort === "off" || reasoningEffort === "high" || reasoningEffort === "max") {
      next.deepseek = reasoningEffort;
    }
  }
  if (family === "glm" && typeof thinkingMode === "string") {
    if (thinkingMode === "on" || thinkingMode === "off") next.glm = thinkingMode;
  }
  if (family === "glm" && typeof reasoningEffort === "string") {
    if (reasoningEffort === "on" || reasoningEffort === "off") next.glm = reasoningEffort;
  }
  if (family === "kimi" && typeof thinkingMode === "string") {
    if (thinkingMode === "on" || thinkingMode === "off") next.kimi = thinkingMode;
  }
  if (family === "kimi" && typeof reasoningEffort === "string") {
    if (reasoningEffort === "on" || reasoningEffort === "off") next.kimi = reasoningEffort;
  }
  if (family === "qwen") {
    if (typeof thinkingMode === "string" && (thinkingMode === "auto" || thinkingMode === "on" || thinkingMode === "off")) {
      next.qwen = thinkingMode;
    }
    if (typeof reasoningEffort === "string" && (reasoningEffort === "auto" || reasoningEffort === "on" || reasoningEffort === "off")) {
      next.qwen = reasoningEffort;
    }
    if (typeof thinkingBudget === "string" && ["auto", "4096", "16384", "32768", "81920"].includes(thinkingBudget)) {
      next.qwenBudget = thinkingBudget as ThinkingSettings["qwenBudget"];
    }
  }
  return next;
}

function getRequestModelConfiguration(options: vscode.ProvideLanguageModelChatResponseOptions): Record<string, unknown> | undefined {
  // The field is `modelConfiguration` in the current proposed API; older
  // builds shipped it under `configuration` alongside the auth config. Accept
  // both shapes defensively so the picker keeps working across VS Code
  // versions.
  const opts = options as vscode.ProvideLanguageModelChatResponseOptions & {
    modelConfiguration?: Record<string, unknown>;
    configuration?: Record<string, unknown>;
  };
  return opts.modelConfiguration ?? opts.configuration;
}

function pickThinkingModelConfiguration(override: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!override) return undefined;
  const picked: Record<string, unknown> = {};
  for (const key of ["reasoningEffort", "thinkingMode", "thinkingBudget"]) {
    const value = override[key];
    if (typeof value === "string") {
      picked[key] = value;
    }
  }
  return Object.keys(picked).length ? picked : undefined;
}

function getSettings(): ApiSettings {
  const config = vscode.workspace.getConfiguration("xiaomi-mimo");

  return {
    temperature: config.get("temperature", 0.2),
    maxOutputTokensOverride: config.get("maxTokens", 0),
    maxInputTokensOverride: config.get("maxInputTokens", 0),
    debugReasoning: config.get("debugReasoning", false),
    debugLogging: config.get("debugLogging", false),
    requestTimeoutMs:
      Math.max(config.get("requestTimeoutSeconds", DEFAULT_REQUEST_TIMEOUT_MS / 1000), 1) * 1000,
    streamIdleTimeoutMs:
      Math.max(
        config.get(
          "streamIdleTimeoutSeconds",
          DEFAULT_STREAM_IDLE_TIMEOUT_MS / 1000,
        ),
        1,
      ) * 1000,
    thinking: {
      deepseek: config.get<ThinkingSettings["deepseek"]>("thinking.deepseek", "off"),
      glm: config.get<ThinkingSettings["glm"]>("thinking.glm", "off"),
      kimi: config.get<ThinkingSettings["kimi"]>("thinking.kimi", "off"),
      qwen: config.get<ThinkingSettings["qwen"]>("thinking.qwen", "off"),
      qwenBudget: config.get<ThinkingSettings["qwenBudget"]>("thinking.qwenBudget", "auto")
    }
  };
}

// Maps the per-family Thinking settings to the request fields each MiMo
// model family expects. Returns an object to spread into the request body.
// Anything returned here is merged into the OpenAI- or Anthropic-style payload.
function buildThinkingPayload(modelId: string, thinking: ThinkingSettings, hasImageInput = false): Record<string, unknown> {
  if (/^deepseek-/i.test(modelId)) {
    if (thinking.deepseek === "off") {
      return {};
    }
    return { reasoning_effort: thinking.deepseek };
  }

  if (/^glm-/i.test(modelId)) {
    return { thinking: { type: thinking.glm === "on" ? "enabled" : "disabled" } };
  }

  if (/^kimi-/i.test(modelId)) {
    return { thinking: { type: thinking.kimi === "on" ? "enabled" : "disabled" } };
  }

  if (/^qwen3(?:\.|-)/i.test(modelId)) {
    if (thinking.qwen === "auto") {
      // Let the model decide; don't send enable_thinking. Budget is only
      // meaningful when thinking is active, so honor it here as well. Vision
      // requests are already token-heavy; keep "auto" truly automatic so the
      // provider can stay under its image quota/token limits.
      if (hasImageInput) {
        return {};
      }
      return thinking.qwenBudget === "auto"
        ? {}
        : { thinking_budget: Number(thinking.qwenBudget) };
    }
    if (thinking.qwen === "on") {
      return thinking.qwenBudget === "auto"
        ? { enable_thinking: true }
        : { enable_thinking: true, thinking_budget: Number(thinking.qwenBudget) };
    }
    return { enable_thinking: false };
  }

  return {};
}

function modelLimits(
  metadata: ResolvedModelMetadata,
  settings = getSettings(),
): ModelLimits {
  const contextWindow = positiveOverride(settings.maxInputTokensOverride) ?? metadata.contextWindow;
  const maxOutputTokens = positiveOverride(settings.maxOutputTokensOverride) ?? metadata.maxOutputTokens;
  const apiMaxOutputTokens = Math.min(maxOutputTokens, contextWindow);
  // advertisedContextWindow = actual model context window (not inflated).
  // Adding apiMaxOutputTokens here inflates the value above the real limit,
  // which causes VS Code to round up and display "2M" instead of "1M" for a
  // 1M-context model, and worse: VS Code may try to send payloads larger than
  // the model's actual total context window.
  const advertisedContextWindow = contextWindow;
  const advertisedMaxOutputTokens = Math.max(1, Math.min(apiMaxOutputTokens, UI_OUTPUT_TOKEN_RESERVE));

  return {
    contextWindow,
    maxOutputTokens: apiMaxOutputTokens,
    advertisedContextWindow,
    advertisedMaxInputTokens: Math.max(1, advertisedContextWindow - advertisedMaxOutputTokens),
    advertisedMaxOutputTokens
  };
}

function estimateTokenCount(value: string): number {
  if (!value) {
    return 0;
  }

  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return 0;
  }

  const cjkCharacters = normalized.match(/[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/gu)?.length ?? 0;
  const words = normalized.match(/[A-Za-z0-9_]+|[^\sA-Za-z0-9_]/gu)?.length ?? 0;
  const charEstimate = Math.ceil(normalized.length / 4);

  return Math.max(1, Math.ceil(Math.max(words * 1.15, charEstimate, cjkCharacters)));
}

function positiveOverride(value: number): number | undefined {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function modelCapabilities(metadata: ResolvedModelMetadata): CopilotCompatibleCapabilities {
  const supportsVision = metadata.supportsVision;
  return {
    imageInput: supportsVision,
    toolCalling: 128,
    supportsImageToText: supportsVision,
    supportsToolCalling: true
  };
}

function shouldHideDeprecatedModel(
  modelId: string,
  vendor: ProviderDefinition["vendor"],
  snapshot: CachedModelMetadataSnapshot,
): boolean {
  return snapshot.providers[vendor][modelId]?.status === "deprecated";
}

function resolveRawModelId(modelId: string): string {
  const [base] = modelId.split("::");
  const prefix = `${MIMO_VENDOR}:`;
  if (base.startsWith(prefix)) {
    return base.slice(prefix.length);
  }
  return base;
}

function isFreeZenModel(_modelId: string): boolean {
  return false;
}

function formatModelName(modelId: string): string {
  const parts = modelId.split("-");
  const displayParts: string[] = [];

  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];

    if (/^\d+$/.test(part) && /^\d+$/.test(parts[index + 1] ?? "")) {
      const versionParts = [part];

      while (/^\d+$/.test(parts[index + 1] ?? "")) {
        versionParts.push(parts[index + 1]);
        index += 1;
      }

      displayParts.push(versionParts.join("."));
      continue;
    }

    displayParts.push(part);
  }

  return displayParts
    .map((part) => part.toUpperCase() === part ? part : part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
