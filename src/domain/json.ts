export type JsonValue = string | number | boolean | null | readonly JsonValue[] | JsonObject;

export type JsonObject = { readonly [key: string]: JsonValue };

export const isString = (value: unknown): value is string => typeof value === "string";

export const isNumber = (value: unknown): value is number => typeof value === "number";

export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return true;
  }

  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }

  return typeof value === "object" && Object.values(value).every(isJsonValue);
}

export const isJsonObject = (value: JsonValue | undefined): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function parseJson(text: string): JsonValue {
  const parsed: unknown = JSON.parse(text);

  if (!isJsonValue(parsed)) {
    throw new TypeError("JSON.parse returned a value outside JSON");
  }

  return parsed;
}

export function textField(source: JsonValue | undefined, key: string): string | null {
  const value = isJsonObject(source) ? source[key] : undefined;

  return isString(value) ? value : null;
}

export function numberField(source: JsonValue | undefined, key: string): number | null {
  const value = isJsonObject(source) ? source[key] : undefined;

  return isNumber(value) ? value : null;
}
