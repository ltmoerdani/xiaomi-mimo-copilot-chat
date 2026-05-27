export type MiMoEndpointKind =
  | "chat-completions"
  | "messages"
  | "responses"
  | "google";

export function buildMiMoAuthHeaders(
  _endpointKind: MiMoEndpointKind,
  apiKey: string,
): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
  };
}