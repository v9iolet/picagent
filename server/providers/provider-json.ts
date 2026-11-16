export function parseProviderJson(text: string, apiKey: string, errorCode: string): unknown {
  try {
    return JSON.parse(text, (field, value: unknown) => {
      if (apiKey && (field === apiKey || (typeof value === "string" && value.includes(apiKey)))) {
        throw new Error("PROVIDER_RESPONSE_CONTAINS_CREDENTIAL");
      }
      return value;
    });
  } catch {
    throw new Error(errorCode);
  }
}
