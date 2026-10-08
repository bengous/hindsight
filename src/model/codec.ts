export type JsonSchema = Readonly<Record<string, unknown>>;

export class DecodeError extends Error {
  constructor(
    readonly path: string,
    readonly expected: string,
  ) {
    super(`${path}: expected ${expected}`);
    this.name = "DecodeError";
  }
}

/** A JSON schema for `--json-schema` and the hand-written check that enforces it on the parsed output. */
export type Codec<T> = {
  readonly schema: JsonSchema;
  readonly check: (value: unknown, path: string) => T;
};

export type Infer<C> = C extends Codec<infer T> ? T : never;

export function decode<T>(codec: Codec<T>, value: unknown): T {
  return codec.check(value, "$");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function string(options: { readonly minLength?: number; readonly maxLength?: number } = {}): Codec<string> {
  const minLength = options.minLength ?? 0;
  const maxLength = options.maxLength ?? Number.POSITIVE_INFINITY;
  return {
    schema: {
      type: "string",
      ...(options.minLength === undefined ? {} : { minLength }),
      ...(options.maxLength === undefined ? {} : { maxLength }),
    },
    check: (value, path) => {
      if (typeof value !== "string") {
        throw new DecodeError(path, "a string");
      }
      if (value.length < minLength || value.length > maxLength) {
        throw new DecodeError(path, `a string of length ${minLength}..${maxLength}, got ${value.length}`);
      }
      return value;
    },
  };
}

export function boolean(): Codec<boolean> {
  return {
    schema: { type: "boolean" },
    check: (value, path) => {
      if (typeof value !== "boolean") {
        throw new DecodeError(path, "a boolean");
      }
      return value;
    },
  };
}

export function oneOf<const T extends string>(values: readonly T[]): Codec<T> {
  return {
    schema: { type: "string", enum: values },
    check: (value, path) => {
      if (typeof value !== "string" || !values.includes(value as T)) {
        throw new DecodeError(path, `one of ${values.join(", ")}`);
      }
      return value as T;
    },
  };
}

export function nullable<T>(inner: Codec<T>): Codec<T | null> {
  return {
    schema: { anyOf: [inner.schema, { type: "null" }] },
    check: (value, path) => (value === null ? null : inner.check(value, path)),
  };
}

export function array<T>(item: Codec<T>, options: { readonly maxItems?: number } = {}): Codec<readonly T[]> {
  const maxItems = options.maxItems ?? Number.POSITIVE_INFINITY;
  return {
    schema: { type: "array", items: item.schema, ...(options.maxItems === undefined ? {} : { maxItems }) },
    check: (value, path) => {
      if (!Array.isArray(value)) {
        throw new DecodeError(path, "an array");
      }
      if (value.length > maxItems) {
        throw new DecodeError(path, `at most ${maxItems} items, got ${value.length}`);
      }
      return value.map((entry, index) => item.check(entry, `${path}[${index}]`));
    },
  };
}

type Shape = Readonly<Record<string, Codec<unknown>>>;
type Decoded<S extends Shape> = { readonly [K in keyof S]: S[K] extends Codec<infer T> ? T : never };

/** Every property is required and no other property is allowed, as structured outputs expect. */
export function object<S extends Shape>(shape: S): Codec<Decoded<S>> {
  const keys = Object.keys(shape);
  return {
    schema: {
      type: "object",
      properties: Object.fromEntries(keys.map((key) => [key, shape[key]?.schema])),
      required: keys,
      additionalProperties: false,
    },
    check: (value, path) => {
      if (!isRecord(value)) {
        throw new DecodeError(path, "an object");
      }
      const extra = Object.keys(value).filter((key) => !keys.includes(key));
      if (extra.length > 0) {
        throw new DecodeError(path, `no extra property, got ${extra.join(", ")}`);
      }
      const decoded: Record<string, unknown> = {};
      for (const key of keys) {
        const codec = shape[key];
        if (codec === undefined) {
          continue;
        }
        if (!(key in value)) {
          throw new DecodeError(`${path}.${key}`, "a required property");
        }
        decoded[key] = codec.check(value[key], `${path}.${key}`);
      }
      return decoded as Decoded<S>;
    },
  };
}
