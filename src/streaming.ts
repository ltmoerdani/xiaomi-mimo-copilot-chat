import * as vscode from "vscode";
import {
  buildMiMoRequestError,
  formatDuration,
  formatRateLimitSummary,
  MiMoRequestError,
  readRateLimitInfo,
  truncateForLog,
} from "./errors";
import {
  normalizeGoogleFullResponse,
  normalizeGoogleStreamEvent,
  normalizeResponsesFullResponse,
  normalizeResponsesStreamEvent,
} from "./routing";
import { createUsageDataParts } from "./chatParts";
import {
  clearContextWindowRequest,
  reportProgressWithContextWindowRequest,
  reportUsageToContextWindowForRequest,
  setContextWindowOutputBufferForRequest,
} from "./contextWindowHookBridge";
import { formatUsageLogLine } from "./usage";

export interface StreamRequestOptions {
  url: string;
  providerDisplayName: string;
  apiKey: string;
  modelId: string;
  body: unknown;
  requestHeaders: Record<string, string>;
  progress: vscode.Progress<vscode.LanguageModelResponsePart2>;
  token: vscode.CancellationToken;
  output?: vscode.OutputChannel;
  debugReasoning: boolean;
  requestTimeoutMs: number;
  streamIdleTimeoutMs: number;
  contextWindowOutputBuffer?: number;
  authHeaders?: Record<string, string>;
  onReasoningContent?: (toolCallIds: string[], reasoningContent: string) => void;
  capacityLimitedModelNotes?: Record<string, string>;
  onTransportSummary?: (summary: TransportRequestSummary) => void;
}

export interface TransportRequestSummary {
  providerDisplayName: string;
  modelId: string;
  url: string;
  requestId?: string;
  sessionId?: string;
  status?: number;
  contentType?: string;
  payloadBytes: number;
  totalBytes: number;
  totalEvents: number;
  durationMs: number;
  ttfbMs?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cachedTokens?: number;
  finishReason?: string;
  rateLimitSummary?: string;
  abortedReason?: "request-timeout" | "stream-idle-timeout" | "cancelled";
  errorMessage?: string;
}

export async function streamChatCompletions(
  options: StreamRequestOptions,
): Promise<void> {
  const extractor = new OpenAiResponseExtractor(
    options.onReasoningContent,
    createReasoningDebugger(options.output, options.debugReasoning),
  );

  await streamMiMoResponse({
    ...options,
    extractStreamParts: (data) => extractor.extractStreamParts(data),
    extractFullParts: extractChatCompletionParts,
  });

  extractor.flushReasoningFallback(
    options.progress,
    options.requestHeaders["x-mimo-request"],
  );
  options.output?.appendLine(
    `[stream-summary model=${options.modelId}] textChars=${extractor.emittedText} toolCalls=${extractor.emittedTools} reasoningChars=${extractor.reasoningChars}`,
  );
  if (extractor.emittedText === 0 && extractor.emittedTools === 0) {
    options.output?.appendLine(
      `[warn] empty response from model=${options.modelId} (no text, no tool calls, no reasoning).`,
    );
    options.output?.show(true);
  }
}

export async function streamAnthropicMessages(
  options: StreamRequestOptions,
): Promise<void> {
  const extractor = new AnthropicResponseExtractor(
    options.onReasoningContent,
    createReasoningDebugger(options.output, options.debugReasoning),
  );

  await streamMiMoResponse({
    ...options,
    extractStreamParts: (data) => extractor.extractStreamParts(data),
    extractFullParts: extractAnthropicParts,
  });

  extractor.flushReasoningFallback(
    options.progress,
    options.requestHeaders["x-mimo-request"],
  );
  options.output?.appendLine(
    `[stream-summary model=${options.modelId}] textChars=${extractor.emittedText} toolCalls=${extractor.emittedTools} reasoningChars=${extractor.reasoningChars}`,
  );
}

export async function streamResponsesApi(
  options: StreamRequestOptions,
): Promise<void> {
  const extractor = new OpenAiResponseExtractor(
    options.onReasoningContent,
    createReasoningDebugger(options.output, options.debugReasoning),
  );

  await streamMiMoResponse({
    ...options,
    extractStreamParts: (data) =>
      extractor.extractStreamParts(normalizeResponsesStreamEvent(data)),
    extractFullParts: (data) =>
      extractChatCompletionParts(normalizeResponsesFullResponse(data)),
  });

  extractor.flushReasoningFallback(
    options.progress,
    options.requestHeaders["x-mimo-request"],
  );
  options.output?.appendLine(
    `[stream-summary model=${options.modelId}] textChars=${extractor.emittedText} toolCalls=${extractor.emittedTools} reasoningChars=${extractor.reasoningChars}`,
  );
}

export async function streamGoogleGenerateContent(
  options: StreamRequestOptions,
): Promise<void> {
  const extractor = new OpenAiResponseExtractor(
    options.onReasoningContent,
    createReasoningDebugger(options.output, options.debugReasoning),
  );

  await streamMiMoResponse({
    ...options,
    url: `${options.url}:streamGenerateContent?alt=sse`,
    extractStreamParts: (data) =>
      extractor.extractStreamParts(normalizeGoogleStreamEvent(data)),
    extractFullParts: (data) =>
      extractChatCompletionParts(normalizeGoogleFullResponse(data)),
  });

  extractor.flushReasoningFallback(
    options.progress,
    options.requestHeaders["x-mimo-request"],
  );
  options.output?.appendLine(
    `[stream-summary model=${options.modelId}] textChars=${extractor.emittedText} toolCalls=${extractor.emittedTools} reasoningChars=${extractor.reasoningChars}`,
  );
}

interface StreamMiMoResponseOptions extends StreamRequestOptions {
  extractStreamParts: (data: unknown) => vscode.LanguageModelResponsePart[];
  extractFullParts: (data: unknown) => vscode.LanguageModelResponsePart[];
}

interface RequestUsageSummary {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cachedTokens?: number;
  finishReason?: string;
}

function reportProgressPart(
  localRequestId: string | undefined,
  progress: vscode.Progress<vscode.LanguageModelResponsePart2>,
  part: vscode.LanguageModelResponsePart2,
): void {
  if (!localRequestId) {
    progress.report(part);
    return;
  }

  reportProgressWithContextWindowRequest(localRequestId, progress, part);
}

async function streamMiMoResponse(
  options: StreamMiMoResponseOptions,
): Promise<void> {
  const controller = new AbortController();
  const startedAt = Date.now();
  const localRequestId = options.requestHeaders["x-mimo-request"];
  let firstByteAt: number | undefined;
  const usageSummary: RequestUsageSummary = {};
  let abortReason:
    | "request-timeout"
    | "stream-idle-timeout"
    | "cancelled"
    | undefined;
  let responseStatus: number | undefined;
  let responseContentType: string | undefined;
  let emittedSummary = false;
  const abort = (reason: typeof abortReason) => {
    abortReason ??= reason;
    controller.abort();
  };
  const cancellation = options.token.onCancellationRequested(() =>
    abort("cancelled"),
  );
  const requestTimeout = setTimeout(
    () => abort("request-timeout"),
    options.requestTimeoutMs,
  );
  let streamIdleTimeout: ReturnType<typeof setTimeout> | undefined;
  const resetStreamIdleTimeout = () => {
    if (streamIdleTimeout) {
      clearTimeout(streamIdleTimeout);
    }
    streamIdleTimeout = setTimeout(
      () => abort("stream-idle-timeout"),
      options.streamIdleTimeoutMs,
    );
  };
  const emitSummary = (
    totalBytes: number,
    totalEvents: number,
    extra?: Partial<TransportRequestSummary>,
  ) => {
    if (emittedSummary) {
      return;
    }
    emittedSummary = true;
    const summary: TransportRequestSummary = {
      providerDisplayName: options.providerDisplayName,
      modelId: options.modelId,
      url: options.url,
      requestId: options.requestHeaders["x-mimo-request"],
      sessionId: options.requestHeaders["x-mimo-session"],
      status: responseStatus,
      contentType: responseContentType,
      payloadBytes:
        typeof options.body === "string"
          ? options.body.length
          : new TextEncoder().encode(JSON.stringify(options.body)).byteLength,
      totalBytes,
      totalEvents,
      durationMs: Date.now() - startedAt,
      ...(firstByteAt === undefined ? {} : { ttfbMs: firstByteAt - startedAt }),
      ...(usageSummary.promptTokens === undefined
        ? {}
        : { promptTokens: usageSummary.promptTokens }),
      ...(usageSummary.completionTokens === undefined
        ? {}
        : { completionTokens: usageSummary.completionTokens }),
      ...(usageSummary.totalTokens === undefined
        ? {}
        : { totalTokens: usageSummary.totalTokens }),
      ...(usageSummary.cachedTokens === undefined
        ? {}
        : { cachedTokens: usageSummary.cachedTokens }),
      ...(usageSummary.finishReason === undefined
        ? {}
        : { finishReason: usageSummary.finishReason }),
      ...extra,
    };

    options.output?.appendLine(
      `[response-summary] status=${summary.status ?? "n/a"} durationMs=${summary.durationMs} ttfbMs=${summary.ttfbMs ?? "n/a"} promptTokens=${summary.promptTokens ?? "n/a"} completionTokens=${summary.completionTokens ?? "n/a"} totalTokens=${summary.totalTokens ?? "n/a"} cachedTokens=${summary.cachedTokens ?? "n/a"} finishReason=${summary.finishReason ?? "<unknown>"} totalBytes=${summary.totalBytes} totalEvents=${summary.totalEvents}`,
    );
    const usageLog = formatUsageLogLine({
      promptTokens: summary.promptTokens,
      completionTokens: summary.completionTokens,
      totalTokens: summary.totalTokens,
      cachedTokens: summary.cachedTokens,
      finishReason: summary.finishReason,
    });
    if (usageLog) {
      options.output?.appendLine(`[usage] ${usageLog}`);
    }
    options.onTransportSummary?.(summary);

    if (localRequestId) {
      reportUsageToContextWindowForRequest(localRequestId, {
        promptTokens: summary.promptTokens,
        completionTokens: summary.completionTokens,
        totalTokens: summary.totalTokens,
        cachedTokens: summary.cachedTokens,
        finishReason: summary.finishReason,
      });
    }

    const usageParts =
      summary.errorMessage || summary.abortedReason
        ? []
        : createUsageDataParts({
            promptTokens: summary.promptTokens,
            completionTokens: summary.completionTokens,
            totalTokens: summary.totalTokens,
            cachedTokens: summary.cachedTokens,
            finishReason: summary.finishReason,
          });
    for (const usagePart of usageParts) {
      reportProgressPart(localRequestId, options.progress, usagePart);
    }
  };

  try {
    if (localRequestId && options.contextWindowOutputBuffer !== undefined) {
      setContextWindowOutputBufferForRequest(
        localRequestId,
        options.contextWindowOutputBuffer,
      );
    }

    const payload = JSON.stringify(options.body);
    options.output?.appendLine(
      `[request] url=${options.url} payloadBytes=${payload.length} requestTimeoutMs=${options.requestTimeoutMs} streamIdleTimeoutMs=${options.streamIdleTimeoutMs}`,
    );
    const response = await fetch(options.url, {
      method: "POST",
      headers: {
        ...(options.authHeaders ?? { Authorization: `Bearer ${options.apiKey}` }),
        "Content-Type": "application/json",
        ...options.requestHeaders,
      },
      body: payload,
      signal: controller.signal,
    });

    responseStatus = response.status;
    responseContentType = response.headers.get("content-type") ?? "";
    options.output?.appendLine(
      `[http] ${response.status} ${response.statusText} content-type=${responseContentType || "<none>"}`,
    );
    const rateLimitSummary = formatRateLimitSummary(
      readRateLimitInfo(response.headers),
    );
    if (rateLimitSummary) {
      options.output?.appendLine(`[rate-limit] ${rateLimitSummary}`);
    }

    if (!response.ok) {
      const detail = await response.text();
      options.output?.appendLine(
        `[http-error-body] ${detail.trim() ? truncateForLog(detail) : "<empty>"}`,
      );
      const capacityHint =
        options.capacityLimitedModelNotes?.[options.modelId] && response.status >= 500
          ? ` — ${options.capacityLimitedModelNotes[options.modelId]}`
          : "";
      const requestError = buildMiMoRequestError(
        options.providerDisplayName,
        response,
        detail,
        options.modelId,
        payload.length,
        capacityHint,
      );
      emitSummary(new TextEncoder().encode(detail).byteLength, 0, {
        errorMessage: requestError.message,
        rateLimitSummary,
      });
      throw requestError;
    }

    if (!response.body || !responseContentType.includes("text/event-stream")) {
      const raw = await response.text();
      firstByteAt ??= Date.now();
      options.output?.appendLine(`[non-stream-body] ${truncateForLog(raw)}`);
      let data: unknown;
      try {
        data = JSON.parse(raw);
      } catch {
        data = undefined;
      }
      if (data !== undefined) {
        updateRequestUsageSummary(usageSummary, data);
        for (const part of options.extractFullParts(data)) {
          reportProgressPart(localRequestId, options.progress, part);
        }
      }
      emitSummary(new TextEncoder().encode(raw).byteLength, data === undefined ? 0 : 1, {
        rateLimitSummary,
      });
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let totalBytes = 0;
    let totalEvents = 0;
    resetStreamIdleTimeout();

    while (!options.token.isCancellationRequested) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      resetStreamIdleTimeout();

      totalBytes += value?.byteLength ?? 0;
      if (firstByteAt === undefined && (value?.byteLength ?? 0) > 0) {
        firstByteAt = Date.now();
      }
      const chunk = decoder.decode(value, { stream: true });
      if (options.debugReasoning && options.output && chunk) {
        options.output.appendLine(
          `[sse-raw bytes=${value?.byteLength ?? 0}] ${truncateForLog(chunk)}`,
        );
      }
      buffer += chunk;
      const events = buffer.split("\n\n");
      buffer = events.pop() ?? "";

      for (const event of events) {
        totalEvents += 1;
        if (options.debugReasoning && options.output && event.trim()) {
          options.output.appendLine(`[sse] ${truncateForLog(event)}`);
        }
        for (const part of parseServerSentEvent(
          event,
          options.extractStreamParts,
          (data) => updateRequestUsageSummary(usageSummary, data),
        )) {
          reportProgressPart(localRequestId, options.progress, part);
        }
      }
    }

    if (buffer.trim()) {
      if (options.debugReasoning && options.output) {
        options.output.appendLine(`[sse-tail] ${truncateForLog(buffer)}`);
      }
      for (const part of parseServerSentEvent(
        buffer,
        options.extractStreamParts,
        (data) => updateRequestUsageSummary(usageSummary, data),
      )) {
        reportProgressPart(localRequestId, options.progress, part);
      }
    }

    options.output?.appendLine(
      `[sse-stats] totalBytes=${totalBytes} totalEvents=${totalEvents} bufferTailLen=${buffer.length}`,
    );
    emitSummary(totalBytes, totalEvents, { rateLimitSummary });
  } catch (error) {
    if (abortReason === "cancelled") {
      emitSummary(0, 0, {
        abortedReason: "cancelled",
        errorMessage: "request cancelled",
      });
      return;
    }
    if (abortReason === "request-timeout") {
      const requestError = new MiMoRequestError(
        `${options.providerDisplayName} request timed out after ${formatDuration(options.requestTimeoutMs)}.`,
        `${options.providerDisplayName} did not start or finish the request within ${formatDuration(options.requestTimeoutMs)}. Try again later or reduce the request size.`,
      );
      emitSummary(0, 0, {
        abortedReason: "request-timeout",
        errorMessage: requestError.message,
      });
      throw requestError;
    }
    if (abortReason === "stream-idle-timeout") {
      const requestError = new MiMoRequestError(
        `${options.providerDisplayName} stream stalled for ${formatDuration(options.streamIdleTimeoutMs)} without new data.`,
        `${options.providerDisplayName} stopped sending stream data for ${formatDuration(options.streamIdleTimeoutMs)}, so the request was cancelled to avoid leaving Copilot stuck.`,
      );
      emitSummary(0, 0, {
        abortedReason: "stream-idle-timeout",
        errorMessage: requestError.message,
      });
      throw requestError;
    }
    emitSummary(0, 0, {
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    clearTimeout(requestTimeout);
    if (streamIdleTimeout) {
      clearTimeout(streamIdleTimeout);
    }
    cancellation.dispose();
    if (localRequestId) {
      clearContextWindowRequest(localRequestId);
    }
  }
}

function parseServerSentEvent(
  event: string,
  extractParts: (data: unknown) => vscode.LanguageModelResponsePart[],
  onData?: (data: unknown) => void,
): vscode.LanguageModelResponsePart[] {
  const lines = event
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim());

  const parts: vscode.LanguageModelResponsePart[] = [];

  for (const line of lines) {
    if (!line || line === "[DONE]") {
      continue;
    }

    try {
      const data = JSON.parse(line) as unknown;
      onData?.(data);
      parts.push(...extractParts(data));
    } catch {
      // Ignore malformed SSE lines; the API may send comments or keep-alive frames.
    }
  }

  return parts;
}

function createReasoningDebugger(
  output: vscode.OutputChannel | undefined,
  enabled: boolean,
): ((reasoningContent: string) => void) | undefined {
  if (!enabled || !output) {
    return undefined;
  }

  return (reasoningContent) => {
    output.appendLine("[reasoning_content]");
    output.appendLine(reasoningContent);
    output.appendLine("[/reasoning_content]");
  };
}

class OpenAiResponseExtractor {
  private readonly pendingToolCalls = new Map<number, PendingToolCall>();
  private reasoningContent = "";
  private emittedTextLength = 0;
  private emittedToolCallsCount = 0;

  constructor(
    private readonly onReasoningContent?: (
      toolCallIds: string[],
      reasoningContent: string,
    ) => void,
    private readonly onReasoningDebug?: (reasoningContent: string) => void,
  ) {}

  get emittedText(): number {
    return this.emittedTextLength;
  }

  get emittedTools(): number {
    return this.emittedToolCallsCount;
  }

  get reasoningChars(): number {
    return this.reasoningContent.length;
  }

  extractStreamParts(data: unknown): vscode.LanguageModelResponsePart[] {
    if (!isRecord(data) || !Array.isArray(data.choices)) {
      return [];
    }

    const first = data.choices[0];
    if (!isRecord(first)) {
      return [];
    }

    const parts: vscode.LanguageModelResponsePart[] = [];
    const delta = first.delta;
    if (isRecord(delta)) {
      const text = extractTextFromDelta(delta);
      if (text) {
        this.emittedTextLength += text.length;
        parts.push(new vscode.LanguageModelTextPart(text));
      }
      const reasoning = extractReasoningFromDelta(delta);
      if (reasoning) {
        this.reasoningContent += reasoning;
      }
      this.collectOpenAiToolCalls(delta.tool_calls);
    }

    const message = first.message;
    if (isRecord(message)) {
      const text = extractTextFromDelta(message);
      if (text) {
        this.emittedTextLength += text.length;
        parts.push(new vscode.LanguageModelTextPart(text));
      }
      const reasoning = extractReasoningFromDelta(message);
      if (reasoning) {
        this.reasoningContent += reasoning;
      }
      this.collectOpenAiToolCalls(message.tool_calls);
    }

    if (first.finish_reason === "tool_calls") {
      const toolParts = this.flushToolCalls();
      this.emittedToolCallsCount += toolParts.length;
      parts.push(...toolParts);
    }

    return parts;
  }

  flushReasoningFallback(
    progress: vscode.Progress<vscode.LanguageModelResponsePart2>,
    localRequestId?: string,
  ): void {
    const reasoning = this.reasoningContent.trim();
    if (!reasoning) {
      return;
    }
    if (this.emittedTextLength > 0 || this.emittedToolCallsCount > 0) {
      this.reasoningContent = "";
      return;
    }
    this.onReasoningDebug?.(this.reasoningContent);
    reportProgressPart(
      localRequestId,
      progress,
      new vscode.LanguageModelTextPart(reasoning),
    );
    this.emittedTextLength += reasoning.length;
    this.reasoningContent = "";
  }

  private collectOpenAiToolCalls(toolCalls: unknown): void {
    if (!Array.isArray(toolCalls)) {
      return;
    }

    for (const toolCall of toolCalls) {
      if (!isRecord(toolCall)) {
        continue;
      }

      const index =
        typeof toolCall.index === "number"
          ? toolCall.index
          : this.pendingToolCalls.size;
      const pending = this.pendingToolCalls.get(index) ?? {
        id: "",
        name: "",
        arguments: "",
      };
      if (typeof toolCall.id === "string") {
        pending.id = toolCall.id;
      }

      const fn = toolCall.function;
      if (isRecord(fn)) {
        if (typeof fn.name === "string") {
          pending.name += fn.name;
        }
        if (typeof fn.arguments === "string") {
          pending.arguments += fn.arguments;
        }
      }

      this.pendingToolCalls.set(index, pending);
    }
  }

  private flushToolCalls(): vscode.LanguageModelToolCallPart[] {
    const toolCalls = Array.from(this.pendingToolCalls.values()).filter(
      (toolCall) => toolCall.name,
    );
    const parts = toolCalls.map(
      (toolCall, index) =>
        new vscode.LanguageModelToolCallPart(
          toolCall.id || `mimo-tool-${Date.now()}-${index}`,
          toolCall.name,
          parseToolInput(toolCall.arguments),
        ),
    );

    if (this.reasoningContent.trim()) {
      this.onReasoningDebug?.(this.reasoningContent);
      this.onReasoningContent?.(
        parts.map((part) => part.callId),
        this.reasoningContent,
      );
    }

    this.pendingToolCalls.clear();
    this.reasoningContent = "";
    return parts;
  }
}

class AnthropicResponseExtractor {
  private readonly pendingToolCalls = new Map<number, PendingToolCall>();
  private reasoningContent = "";
  private emittedTextLength = 0;
  private emittedToolCallsCount = 0;

  constructor(
    private readonly onReasoningContent?: (
      toolCallIds: string[],
      reasoningContent: string,
    ) => void,
    private readonly onReasoningDebug?: (reasoningContent: string) => void,
  ) {}

  get emittedText(): number {
    return this.emittedTextLength;
  }

  get emittedTools(): number {
    return this.emittedToolCallsCount;
  }

  get reasoningChars(): number {
    return this.reasoningContent.length;
  }

  extractStreamParts(data: unknown): vscode.LanguageModelResponsePart[] {
    if (!isRecord(data)) {
      return [];
    }

    const parts: vscode.LanguageModelResponsePart[] = [];
    const delta = data.delta;
    if (!isRecord(delta)) {
      return parts;
    }

    if (typeof delta.text === "string" && delta.text.length > 0) {
      this.emittedTextLength += delta.text.length;
      parts.push(new vscode.LanguageModelTextPart(delta.text));
    }

    if (typeof delta.thinking === "string" && delta.thinking.length > 0) {
      this.reasoningContent += delta.thinking;
    }

    if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
      this.reasoningContent += delta.reasoning_content;
    }

    if (typeof delta.reasoning === "string" && delta.reasoning.length > 0) {
      this.reasoningContent += delta.reasoning;
    }

    if (typeof delta.type === "string") {
      if (delta.type === "tool_use") {
        const index = typeof delta.index === "number" ? delta.index : this.pendingToolCalls.size;
        const pending = this.pendingToolCalls.get(index) ?? {
          id: "",
          name: "",
          arguments: "",
        };
        if (typeof delta.id === "string") {
          pending.id = delta.id;
        }
        if (typeof delta.name === "string") {
          pending.name += delta.name;
        }
        if (typeof delta.input === "string") {
          pending.arguments += delta.input;
        } else if (isRecord(delta.input)) {
          pending.arguments += JSON.stringify(delta.input);
        }
        this.pendingToolCalls.set(index, pending);
      }

      if (delta.type === "message_delta" && isRecord(data.usage)) {
        updateRequestUsageSummary(this as unknown as RequestUsageSummary, data);
      }
    }

    if (data.type === "message_stop" || delta.stop_reason) {
      const toolParts = this.flushToolCalls();
      this.emittedToolCallsCount += toolParts.length;
      parts.push(...toolParts);
    }

    return parts;
  }

  flushReasoningFallback(
    progress: vscode.Progress<vscode.LanguageModelResponsePart2>,
    localRequestId?: string,
  ): void {
    const reasoning = this.reasoningContent.trim();
    if (!reasoning) {
      return;
    }
    if (this.emittedTextLength > 0 || this.emittedToolCallsCount > 0) {
      this.reasoningContent = "";
      return;
    }
    this.onReasoningDebug?.(this.reasoningContent);
    reportProgressPart(
      localRequestId,
      progress,
      new vscode.LanguageModelTextPart(reasoning),
    );
    this.emittedTextLength += reasoning.length;
    this.reasoningContent = "";
  }

  private flushToolCalls(): vscode.LanguageModelToolCallPart[] {
    const toolCalls = Array.from(this.pendingToolCalls.values()).filter(
      (toolCall) => toolCall.name,
    );
    const parts = toolCalls.map(
      (toolCall, index) =>
        new vscode.LanguageModelToolCallPart(
          toolCall.id || `mimo-tool-${Date.now()}-${index}`,
          toolCall.name,
          parseToolInput(toolCall.arguments),
        ),
    );

    if (this.reasoningContent.trim()) {
      this.onReasoningDebug?.(this.reasoningContent);
      this.onReasoningContent?.(
        parts.map((part) => part.callId),
        this.reasoningContent,
      );
    }

    this.pendingToolCalls.clear();
    this.reasoningContent = "";
    return parts;
  }
}

function extractChatCompletionParts(
  data: unknown,
): vscode.LanguageModelResponsePart[] {
  if (!isRecord(data) || !Array.isArray(data.choices)) {
    return [];
  }

  const first = data.choices[0];
  if (!isRecord(first)) {
    return [];
  }

  const parts: vscode.LanguageModelResponsePart[] = [];
  const message = first.message;
  if (isRecord(message)) {
    const text = extractTextFromDelta(message);
    if (text) {
      parts.push(new vscode.LanguageModelTextPart(text));
    } else {
      const reasoning = extractReasoningFromDelta(message);
      if (reasoning.trim()) {
        parts.push(new vscode.LanguageModelTextPart(reasoning));
      }
    }
    for (const toolCallPart of toolCallPartsFromOpenAiMessage(
      message.tool_calls,
    )) {
      parts.push(toolCallPart);
    }
  }

  if (typeof first.text === "string") {
    parts.push(new vscode.LanguageModelTextPart(first.text));
  }

  return parts;
}

function extractTextFromDelta(delta: Record<string, unknown>): string {
  const candidates: unknown[] = [delta.content, delta.text, delta.output_text];
  let collected = "";
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.length > 0) {
      collected += candidate;
      continue;
    }
    if (Array.isArray(candidate)) {
      for (const part of candidate) {
        if (typeof part === "string") {
          collected += part;
        } else if (isRecord(part)) {
          const text = part.text ?? part.value ?? part.output_text;
          if (typeof text === "string") {
            collected += text;
          }
        }
      }
    }
  }
  return collected;
}

function extractReasoningFromDelta(delta: Record<string, unknown>): string {
  const candidates: unknown[] = [
    delta.reasoning_content,
    delta.reasoning,
    delta.thinking,
    isRecord(delta.message)
      ? (delta.message as Record<string, unknown>).reasoning_content
      : undefined,
  ];
  let collected = "";
  for (const candidate of candidates) {
    if (typeof candidate === "string") {
      collected += candidate;
    } else if (isRecord(candidate) && typeof candidate.content === "string") {
      collected += candidate.content;
    } else if (Array.isArray(candidate)) {
      for (const part of candidate) {
        if (typeof part === "string") {
          collected += part;
        } else if (isRecord(part) && typeof part.text === "string") {
          collected += part.text;
        }
      }
    }
  }
  return collected;
}

function extractAnthropicParts(data: unknown): vscode.LanguageModelResponsePart[] {
  if (!isRecord(data) || !Array.isArray(data.content)) {
    return [];
  }

  const parts: vscode.LanguageModelResponsePart[] = [];
  const textParts: string[] = [];

  for (const block of data.content) {
    if (!isRecord(block)) {
      continue;
    }

    if (typeof block.text === "string" && block.text.length > 0) {
      textParts.push(block.text);
      continue;
    }

    if (block.type === "tool_use" && typeof block.name === "string") {
      const id = typeof block.id === "string" ? block.id : `mimo-tool-${Date.now()}`;
      const input = isRecord(block.input) ? block.input : parseToolInput(typeof block.input === "string" ? block.input : "{}");
      parts.push(new vscode.LanguageModelToolCallPart(id, block.name, input));
    }
  }

  const text = textParts.join("");
  if (text) {
    parts.unshift(new vscode.LanguageModelTextPart(text));
  }

  return parts;
}

function toolCallPartsFromOpenAiMessage(
  toolCalls: unknown,
): vscode.LanguageModelToolCallPart[] {
  if (!Array.isArray(toolCalls)) {
    return [];
  }

  return toolCalls
    .filter(isRecord)
    .map((toolCall, index) => {
      const fn = toolCall.function;
      const id =
        typeof toolCall.id === "string"
          ? toolCall.id
          : `mimo-tool-${Date.now()}-${index}`;
      const name = isRecord(fn) && typeof fn.name === "string" ? fn.name : "";
      const args =
        isRecord(fn) && typeof fn.arguments === "string" ? fn.arguments : "{}";
      return name
        ? new vscode.LanguageModelToolCallPart(id, name, parseToolInput(args))
        : undefined;
    })
    .filter(
      (part): part is vscode.LanguageModelToolCallPart => Boolean(part),
    );
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

function updateRequestUsageSummary(
  summary: RequestUsageSummary,
  data: unknown,
): void {
  if (!isRecord(data)) {
    return;
  }

  const usage = isRecord(data.usage) ? data.usage : undefined;
  if (usage) {
    const promptTokens =
      typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : undefined;
    const completionTokens =
      typeof usage.completion_tokens === "number"
        ? usage.completion_tokens
        : undefined;
    const totalTokens =
      typeof usage.total_tokens === "number" ? usage.total_tokens : undefined;
    const promptTokenDetails = isRecord(usage.prompt_tokens_details)
      ? usage.prompt_tokens_details
      : undefined;
    const cachedTokens =
      promptTokenDetails &&
      typeof promptTokenDetails.cached_tokens === "number"
        ? promptTokenDetails.cached_tokens
        : undefined;

    if (promptTokens !== undefined) {
      summary.promptTokens = promptTokens;
    }
    if (completionTokens !== undefined) {
      summary.completionTokens = completionTokens;
    }
    if (totalTokens !== undefined) {
      summary.totalTokens = totalTokens;
    }
    if (cachedTokens !== undefined) {
      summary.cachedTokens = cachedTokens;
    }
  }

  const firstChoice =
    Array.isArray(data.choices) && isRecord(data.choices[0])
      ? data.choices[0]
      : undefined;
  if (firstChoice && typeof firstChoice.finish_reason === "string") {
    summary.finishReason = firstChoice.finish_reason;
  }
}

interface PendingToolCall {
  id: string;
  name: string;
  arguments: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
