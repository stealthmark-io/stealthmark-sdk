// ═══════════════════════════════════════════════════════════════════
// @stealthmark/core — Request context for metered events
// Host normalisation and bounded event metadata, shared by every adapter.
// ═══════════════════════════════════════════════════════════════════

/** Longest valid DNS name (RFC 1035). */
export const MAX_HOST_LENGTH = 253;

/** Ingest API limit: a metadata string longer than this is truncated server side. */
const MAX_METADATA_STRING_LENGTH = 200;
/** Ingest API limit: metadata that serializes to more bytes rejects the whole batch. */
const MAX_METADATA_BYTES = 1024;
const MAX_METHOD_LENGTH = 16;

const HOSTNAME_PATTERN = /^[a-z0-9._-]+$/;
const IPV6_LITERAL_PATTERN = /^\[[0-9a-f:.]+\]$/;

type HeaderSource = Headers | Record<string, string | undefined>;

function readHeader(headers: HeaderSource, name: string): string | undefined {
  const value = headers instanceof Headers ? headers.get(name) : headers[name];
  return value ?? undefined;
}

function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/**
 * Normalises a Host or X-Forwarded-Host header value into a bare hostname.
 *
 * Takes the first entry of a comma separated list, lowercases it, strips the port and a trailing
 * dot, and caps it at 253 characters. Returns undefined for a missing, empty or malformed value
 * (anything that is not a hostname, an IPv4 address or a bracketed IPv6 literal).
 */
export function normalizeHost(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const first = value.split(',')[0].trim().toLowerCase();
  if (first === '') return undefined;

  let host: string;
  if (first.startsWith('[')) {
    const end = first.indexOf(']');
    if (end === -1) return undefined;
    host = first.slice(0, end + 1);
    if (!IPV6_LITERAL_PATTERN.test(host)) return undefined;
  } else {
    const colon = first.indexOf(':');
    host = colon === -1 ? first : first.slice(0, colon);
    if (host.endsWith('.')) host = host.slice(0, -1);
    if (!HOSTNAME_PATTERN.test(host)) return undefined;
  }

  return host.slice(0, MAX_HOST_LENGTH);
}

/**
 * Resolves the host a request was addressed to. By default only the Host header is read, because
 * X-Forwarded-Host is client controlled unless a trusted proxy overwrites it. With `trustForwardedHost`
 * the first X-Forwarded-Host value wins and the Host header is the fallback.
 * Returns undefined when no readable header carries a usable host.
 */
export function resolveRequestHost(
  headers: HeaderSource,
  options: { trustForwardedHost?: boolean } = {}
): string | undefined {
  const forwarded = options.trustForwardedHost ? normalizeHost(readHeader(headers, 'x-forwarded-host')) : undefined;
  return forwarded ?? normalizeHost(readHeader(headers, 'host'));
}

/**
 * Builds the metadata object of a metered event: path, method and, when known, host.
 *
 * The ingest API rejects a whole batch when one event's metadata serializes to more than 1024 bytes,
 * so the path is the part that gets shortened to fit. Host and method are never dropped.
 */
export function buildEventMetadata(input: { path: string; method?: string; host?: string }): Record<string, string> {
  const method = (input.method || 'GET').slice(0, MAX_METHOD_LENGTH);
  const host = input.host ? input.host.slice(0, MAX_HOST_LENGTH) : undefined;
  const assemble = (path: string): Record<string, string> =>
    host === undefined ? { path, method } : { path, method, host };

  let path = input.path.slice(0, MAX_METADATA_STRING_LENGTH);
  let metadata = assemble(path);
  while (path.length > 0 && utf8ByteLength(JSON.stringify(metadata)) > MAX_METADATA_BYTES) {
    path = path.slice(0, -1);
    metadata = assemble(path);
  }
  return metadata;
}
