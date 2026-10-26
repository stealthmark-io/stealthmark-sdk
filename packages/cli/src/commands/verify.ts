// ═══════════════════════════════════════════════════════════════════
// @stealthmark/cli — verify command
// Checks whether a live URL serves a StealthMark agent manifest
// ═══════════════════════════════════════════════════════════════════

export interface VerificationCheck {
  name: string;
  passed: boolean;
  details: string;
}

export interface VerificationReport {
  targetUrl: string;
  checks: VerificationCheck[];
  overallPassed: boolean;
}

const REQUEST_TIMEOUT_MS = 10_000;

const MANIFEST_CHECK = 'Manifest at /.well-known/agent.json';
const NEGOTIATION_CHECK = 'Manifest via Accept: application/agent+json';
const MARKER_CHECK = 'x-stealthmark-shield header';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function capabilityCount(count: number): string {
  return `${count} ${count === 1 ? 'capability' : 'capabilities'}`;
}

function get(baseUrl: string, pathname: string, accept: string): Promise<Response> {
  return fetch(new URL(pathname, baseUrl), {
    headers: { Accept: accept },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function checkManifestFile(baseUrl: string): Promise<VerificationCheck> {
  try {
    const res = await get(baseUrl, '/.well-known/agent.json', 'application/json');
    if (!res.ok) {
      return { name: MANIFEST_CHECK, passed: false, details: `HTTP ${res.status}: /.well-known/agent.json was not found` };
    }

    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('json')) {
      return { name: MANIFEST_CHECK, passed: false, details: `Content-Type is ${contentType || 'missing'}, expected JSON` };
    }

    let json: unknown;
    try {
      json = JSON.parse(await res.text());
    } catch {
      return { name: MANIFEST_CHECK, passed: false, details: 'Response is not JSON' };
    }

    if (!isRecord(json) || typeof json.name !== 'string' || typeof json.protocol !== 'string' || !Array.isArray(json.capabilities)) {
      return {
        name: MANIFEST_CHECK,
        passed: false,
        details: 'JSON found, but it is missing name, protocol or a capabilities array',
      };
    }

    return {
      name: MANIFEST_CHECK,
      passed: true,
      details: `HTTP ${res.status}, manifest for "${json.name}" with ${capabilityCount(json.capabilities.length)}`,
    };
  } catch (err: unknown) {
    return { name: MANIFEST_CHECK, passed: false, details: `Network error: ${errorMessage(err)}` };
  }
}

async function checkNegotiation(baseUrl: string): Promise<VerificationCheck[]> {
  let res: Response;
  try {
    res = await get(baseUrl, '/', 'application/agent+json');
  } catch (err: unknown) {
    const details = `Network error: ${errorMessage(err)}`;
    return [
      { name: NEGOTIATION_CHECK, passed: false, details },
      { name: MARKER_CHECK, passed: false, details },
    ];
  }

  const contentType = res.headers.get('content-type') || '';
  const marker = res.headers.get('x-stealthmark-shield');
  const negotiated = res.ok && contentType.includes('application/agent+json');

  return [
    {
      name: NEGOTIATION_CHECK,
      passed: negotiated,
      details: negotiated
        ? `HTTP ${res.status}, Content-Type: ${contentType}`
        : `Expected HTTP 200 with application/agent+json, received HTTP ${res.status} with ${contentType || 'no content type'}`,
    },
    {
      name: MARKER_CHECK,
      passed: Boolean(marker),
      details: marker ? `x-stealthmark-shield: ${marker}` : 'Header missing',
    },
  ];
}

export async function runVerify(targetUrl: string): Promise<VerificationReport> {
  const normalizedUrl = targetUrl.replace(/\/$/, '');
  const [manifestCheck, negotiationChecks] = await Promise.all([
    checkManifestFile(normalizedUrl),
    checkNegotiation(normalizedUrl),
  ]);
  const checks = [manifestCheck, ...negotiationChecks];

  return {
    targetUrl: normalizedUrl,
    checks,
    overallPassed: checks.every((c) => c.passed),
  };
}
