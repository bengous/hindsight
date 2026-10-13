import type { JsonObject, JsonValue } from "../domain/json.ts";

import { isJsonObject, parseJson } from "../domain/json.ts";

const decoder = new TextDecoder();

export async function readTranscriptText(path: string): Promise<string> {
  const bytes = await Bun.file(path).bytes();

  if (path.endsWith(".zst")) {
    return decoder.decode(Bun.zstdDecompressSync(bytes));
  }

  if (path.endsWith(".gz")) {
    return decoder.decode(Bun.gunzipSync(bytes));
  }

  return decoder.decode(bytes);
}

/**
 * Calls `visit` for each JSONL entry. A last line without its newline is a write in progress:
 * it is skipped and reported. Any other malformed line fails with its location.
 */
export async function forEachEntry(
  path: string,
  visit: (entry: JsonObject) => void,
): Promise<{ partialLine: boolean }> {
  const lines = (await readTranscriptText(path)).split("\n");

  for (const [index, line] of lines.entries()) {
    if (line.trim() === "") {
      continue;
    }

    let parsed: JsonValue;

    try {
      parsed = parseJson(line);
    } catch (error) {
      if (index === lines.length - 1) {
        return { partialLine: true };
      }

      throw new Error(`${path}:${index + 1}: invalid JSON line`, { cause: error });
    }

    if (!isJsonObject(parsed)) {
      throw new Error(`${path}:${index + 1}: entry is not a JSON object`);
    }

    visit(parsed);
  }

  return { partialLine: false };
}
