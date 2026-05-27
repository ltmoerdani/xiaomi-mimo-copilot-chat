export const MIMO_VENDOR = "xiaomi-mimo" as const;

export type ProviderVendor = typeof MIMO_VENDOR;

export interface ProviderRoutingDefinition {
  vendor: ProviderVendor;
  chatCompletionsUrl: string;
  messagesUrl: string;
  modelsUrl: string;
  responsesUrl?: string;
}
