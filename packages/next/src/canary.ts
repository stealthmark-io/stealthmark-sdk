// ═══════════════════════════════════════════════════════════════════
// @stealthmark/next — Dotfile policy and Canary fixture
// ═══════════════════════════════════════════════════════════════════

/**
 * What the middleware answers on `/.env*` and `/.git/*`:
 * - `'block'` (default): 403, so the request never reaches your app or its static files.
 * - `'synthetic_fixture'`: 200 with synthetic values and a signed Canary URL. A client that later
 *   requests that URL shows up in your StealthMark console. Needs a Canary key.
 */
export type DotfilePolicy = 'block' | 'synthetic_fixture';

/** A Canary key as the StealthMark console issues it: `smck1.<organization UUID>.<key id>.<base64url of 32 bytes>`. */
const CANARY_KEY_PATTERN = /^smck1\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([A-Za-z0-9_-]{8,32})\.([A-Za-z0-9_-]{43})$/;
const CANARY_ENDPOINT = 'https://stealthmark.io/api/telemetry/canary';
const SCAN_URL = 'https://stealthmark.io/scan';
const MAX_TOKEN_PATH_LENGTH = 128;

const encoder = new TextEncoder();

export interface CanarySigner {
  org: string;
  kid: string;
  sign: (data: string) => Promise<ArrayBuffer>;
}

export function isDotfilePath(pathname: string): boolean {
  return pathname.startsWith('/.env') || pathname === '/.git' || pathname.startsWith('/.git/');
}

/** Returns null for a missing or malformed key. The HMAC key is imported on first use, not at startup. */
export function createCanarySigner(rawKey: string | undefined): CanarySigner | null {
  const match = rawKey?.trim().match(CANARY_KEY_PATTERN);
  if (!match) return null;
  const [, org, kid, secret] = match;
  let key: ReturnType<typeof crypto.subtle.importKey> | undefined;
  return {
    org,
    kid,
    async sign(data) {
      key ??= crypto.subtle.importKey('raw', base64UrlDecode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      return crypto.subtle.sign('HMAC', await key, encoder.encode(data));
    },
  };
}

/** `base64url(JSON payload) + "." + base64url(HMAC-SHA256(key, base64url(JSON payload)))`, verified by the StealthMark web app. */
export async function mintCanaryToken(signer: CanarySigner, host: string, path: string, now = Date.now()): Promise<string> {
  const payload = base64UrlEncode(
    encoder.encode(
      JSON.stringify({
        v: 1,
        kid: signer.kid,
        org: signer.org,
        host,
        path: path.slice(0, MAX_TOKEN_PATH_LENGTH),
        ts: Math.floor(now / 1000),
        nonce: base64UrlEncode(crypto.getRandomValues(new Uint8Array(12))),
      })
    )
  );
  return `${payload}.${base64UrlEncode(new Uint8Array(await signer.sign(payload)))}`;
}

/**
 * `/.git/HEAD` answers a plain ref, since git tools discard a HEAD that is not one; `/.git/config` carries the Canary URL
 * and every other dotfile path gets the env fixture.
 */
export async function canaryFixtureFor(signer: CanarySigner, host: string, path: string): Promise<string> {
  if (path === '/.git/HEAD') return 'ref: refs/heads/main\n';
  const token = await mintCanaryToken(signer, host, path);
  return path === '/.git/config' ? canaryGitConfigBody(host, token) : canaryFixtureBody(host, token);
}

/** The first line discloses the fixture; the values are synthetic and carry no instruction for agents. */
export function canaryFixtureBody(host: string, token: string): string {
  return [
    disclosureLine(host),
    'NODE_ENV=production',
    `APP_URL=https://${host}`,
    `HEALTHCHECK_URL=${CANARY_ENDPOINT}?t=${token}`,
    '',
  ].join('\n');
}

/** The token goes in the remote's path: git appends `/info/refs?service=...` to the URL, which would alter a query. */
export function canaryGitConfigBody(host: string, token: string): string {
  return [
    disclosureLine(host),
    '[core]',
    '\trepositoryformatversion = 0',
    '\tfilemode = true',
    '\tbare = false',
    '\tlogallrefupdates = true',
    '[remote "origin"]',
    `\turl = ${CANARY_ENDPOINT}/${token}.git`,
    '\tfetch = +refs/heads/*:refs/remotes/origin/*',
    '[branch "main"]',
    '\tremote = origin',
    '\tmerge = refs/heads/main',
    '',
  ].join('\n');
}

function disclosureLine(host: string): string {
  return `# Este dominio usa @stealthmark/next · ${SCAN_URL}?domain=${encodeURIComponent(host)}`;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), (char) => char.charCodeAt(0));
}
