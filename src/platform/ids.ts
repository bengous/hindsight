import { normalizeLesson } from "../domain/text.ts";

export function sha1(text: string): string {
  return new Bun.CryptoHasher("sha1").update(text).digest("hex");
}

/** The Ledger's key: the target file and the lesson up to case and punctuation. */
export function fingerprint(targetPath: string, lesson: string): string {
  return sha1(`${targetPath}\n${normalizeLesson(lesson)}`);
}

export function newId(): string {
  return crypto.randomUUID();
}
