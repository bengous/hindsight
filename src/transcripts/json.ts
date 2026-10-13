import type { JsonObject, JsonValue } from "../domain/json.ts";

import { isJsonObject, isString, textField } from "../domain/json.ts";

export function recordField(record: JsonObject, key: string): JsonObject | null {
  const value = record[key];

  return isJsonObject(value) ? value : null;
}

export function recordsField(record: JsonObject, key: string): readonly JsonObject[] {
  const value = record[key];

  return Array.isArray(value) ? value.filter(isJsonObject) : [];
}

export function contentText(content: JsonValue | undefined): string {
  if (isString(content)) {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .filter(isJsonObject)
    .filter((block) => block["type"] === "text")
    .map((block) => textField(block, "text") ?? "")
    .join("\n");
}
