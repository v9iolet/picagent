export const CHANGE_TEXT_MAX_LENGTH = 500;
export const CHANGE_TEXT_MAX_OPERATIONS = 50;

export function normalizeChangeTextReplacement(text: string): string {
  return text.trim() === "" ? "" : text;
}
