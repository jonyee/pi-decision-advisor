import { readStoredCredential, type ExtensionContext } from "@earendil-works/pi-coding-agent";

const REDACTED = "[REDACTED]";
const COMMON_VALUES = new Set(["password", "changeme", "undefined", "localhost", "example", "example-key", "placeholder", "your-api-key", "your_api_key", "development", "production"]);
const CREDENTIAL_PATTERNS = [
  /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z]+ )*PRIVATE KEY-----/g,
  /(?<![A-Za-z0-9_-])(?:sk-(?:ant-|proj-)?|gh[opusr]_|github_pat_|glpat-|xox[abprs]-|npm_|hf_|whsec_|[sr]k_(?:live|test)_)[A-Za-z0-9_-]{8,}(?![A-Za-z0-9_-])/g,
  /(?<![A-Za-z0-9_-])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Za-z0-9_-])/g,
  /(?<![A-Za-z0-9_-])AIza[A-Za-z0-9_-]{30,}(?![A-Za-z0-9_-])/g,
  /(?<![A-Za-z0-9_-])SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g,
  /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?![A-Za-z0-9_-])/g,
];
// Look ahead without consuming benign assignments, which can otherwise hide a nested sensitive name.
const ASSIGNMENT = /(?<![A-Za-z0-9_.-])(?=(["']?)([A-Za-z_][A-Za-z0-9_.-]*)\1(\s*(?:=|:)\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;"'{}\\]+))/g;
const ESCAPED_ASSIGNMENT = /(\\+")([A-Za-z_][A-Za-z0-9_.-]*)\1(\s*:\s*)(\\+")((?:\\.|[^"\\])*)\4/g;
const ESCAPED_VALUE_ASSIGNMENT = /(?<![A-Za-z0-9_.-])([A-Za-z_][A-Za-z0-9_.-]*)(\s*(?:=|:)\s*)(\\+")((?:\\.|[^"\\])*)\3/g;

function sensitiveName(name: string): boolean {
  const normalized = name.replace(/([a-z])([A-Z])/g, "$1_$2").replace(/[.-]/g, "_");
  return /(?:^|_)(?:api_?key|access_?key(?:_id)?|secret(?:_access_?key)?|client_?secret|private_?key|token|access_?token|refresh_?token|password|passwd|credential(?:s)?|authorization|auth|cookie|account_?key|shared_?access_?signature|sig|key|access|refresh)$/i.test(normalized);
}

function literalCredential(value: string | undefined): string | undefined {
  if (!value || value.startsWith("!")) return undefined;
  // Pi config values can be environment references; do not execute configured commands.
  if (/^[A-Z][A-Z0-9_]*$/.test(value) && process.env[value] !== undefined) return process.env[value];
  return value;
}

/** One-way redaction: placeholders are never restored into tools, reports or messages. */
export class SecretRedactor {
  readonly #values: readonly string[];

  constructor(values: readonly string[] = []) {
    this.#values = [...new Set(values.filter(value => value.length >= 8 && !COMMON_VALUES.has(value.toLowerCase())))].sort((a, b) => b.length - a.length);
  }

  redactText(text: string): string {
    // Redact JSON after decoding its strings, then let the encoder preserve quotes and escapes.
    const trimmed = text.trimStart();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        const parsed: unknown = JSON.parse(text);
        if (parsed && typeof parsed === "object") return JSON.stringify(this.redactObject(parsed));
      } catch {}
    }
    let result = text;
    for (const value of this.#values) result = result.split(value).join(REDACTED);
    for (const pattern of CREDENTIAL_PATTERNS) result = result.replace(pattern, REDACTED);
    result = result.replace(/(\b(?:Bearer|Basic)\s+)[A-Za-z0-9._~+/=-]+/gi, `$1${REDACTED}`);
    result = result.replace(/([a-z][a-z0-9+.-]*:\/\/[^\s/:@?#]*:)[^\s/?#@]+(@)/gi, `$1${REDACTED}$2`);
    result = result.replace(/([?&](?:sig|signature|token|access_token|api[_-]?key|x-amz-signature)=)[^&#\s"']+/gi, `$1${REDACTED}`);
    result = result.replace(ESCAPED_ASSIGNMENT, (match, nameQuote: string, name: string, separator: string, valueQuote: string) => {
      return sensitiveName(name) ? `${nameQuote}${name}${nameQuote}${separator}${valueQuote}${REDACTED}${valueQuote}` : match;
    });
    result = result.replace(ESCAPED_VALUE_ASSIGNMENT, (match, name: string, separator: string, quote: string) => {
      return sensitiveName(name) ? `${name}${separator}${quote}${REDACTED}${quote}` : match;
    });
    const spans: Array<{ start: number; end: number }> = [];
    for (const match of result.matchAll(ASSIGNMENT)) {
      const [, quote, name, separator, value] = match;
      if (!sensitiveName(name) || /^(?:null|undefined|true|false)$/i.test(value)) continue;
      const quoted = value.startsWith('"') || value.startsWith("'");
      const start = match.index + quote.length * 2 + name.length + separator.length + (quoted ? 1 : 0);
      spans.push({ start, end: start + value.length - (quoted ? 2 : 0) });
    }
    let cursor = 0;
    let sanitized = "";
    for (const span of spans) {
      if (span.start < cursor) continue;
      sanitized += result.slice(cursor, span.start) + REDACTED;
      cursor = span.end;
    }
    return sanitized + result.slice(cursor);
  }

  redactObject<T>(value: T): T {
    const visited = new WeakMap<object, unknown>();
    const walk = (item: unknown): unknown => {
      if (typeof item === "string") return this.redactText(item);
      if (!item || typeof item !== "object") return item;
      const previous = visited.get(item);
      if (previous) return previous;
      if (Array.isArray(item)) {
        const copy: unknown[] = [];
        visited.set(item, copy);
        for (const entry of item) copy.push(walk(entry));
        return copy;
      }
      if (item instanceof Date) return item;
      const copy: Record<string, unknown> = {};
      visited.set(item, copy);
      for (const [name, entry] of Object.entries(item)) {
        Object.defineProperty(copy, this.redactText(name), {
          enumerable: true, configurable: true, writable: true,
          value: sensitiveName(name) && typeof entry === "string" && entry.length > 0 ? REDACTED : walk(entry),
        });
      }
      return copy;
    };
    return walk(value) as T;
  }
}

/** Read only local/env credential values. No auth refresh, login, config commands or network calls. */
export async function createSecretRedactor(ctx: ExtensionContext): Promise<SecretRedactor> {
  const values: string[] = [];
  const add = (value: unknown) => { if (typeof value === "string" && value) values.push(value); };
  const envValues = (env: unknown) => {
    if (!env || typeof env !== "object" || Array.isArray(env)) return;
    for (const [name, value] of Object.entries(env)) if (sensitiveName(name)) add(value);
  };
  const headers = (entries: Record<string, string | null> | undefined) => {
    for (const [name, value] of Object.entries(entries ?? {})) {
      if (typeof value !== "string") continue;
      if (/^(?:accept|content-type|user-agent|anthropic-version|openai-version)$/i.test(name)) continue;
      add(literalCredential(value));
      const auth = /^(?:Bearer|Basic)\s+(.+)$/i.exec(value);
      if (auth) add(auth[1]);
    }
  };
  envValues(process.env);
  const models = ctx.modelRegistry.getAll();
  if (ctx.model && !models.includes(ctx.model)) models.push(ctx.model);
  const providers = new Set([...models.map(model => model.provider), ...ctx.modelRegistry.getRegisteredProviderIds()]);
  for (const model of models) headers(model.headers);
  for (const provider of providers) {
    headers(ctx.modelRegistry.getProvider(provider)?.headers);
    const config = ctx.modelRegistry.getRegisteredProviderConfig(provider);
    add(literalCredential(config?.apiKey));
    headers(config?.headers);
    for (const model of config?.models ?? []) headers(model.headers);
    const stored: unknown = readStoredCredential(provider);
    if (stored && typeof stored === "object" && "type" in stored) {
      if (stored.type === "api_key") {
        if ("key" in stored && typeof stored.key === "string") add(literalCredential(stored.key));
        if ("env" in stored) envValues(stored.env);
      } else if (stored.type === "oauth") {
        if ("access" in stored) add(stored.access);
        if ("refresh" in stored) add(stored.refresh);
      }
    }
  }
  return new SecretRedactor(values);
}
