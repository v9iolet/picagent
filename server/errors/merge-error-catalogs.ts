export function mergeErrorCatalogs(
  ...catalogs: Readonly<Record<string, string>>[]
): Record<string, string> {
  const messages: Record<string, string> = {};
  for (const catalog of catalogs) {
    for (const [code, message] of Object.entries(catalog)) {
      if (Object.hasOwn(messages, code)) {
        throw new Error(`Duplicate error code: ${code}`);
      }
      messages[code] = message;
    }
  }
  return messages;
}
