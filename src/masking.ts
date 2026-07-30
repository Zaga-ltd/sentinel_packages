// ─── Data Masking Utilities ──────────────────────────────────────────────────────

const MASK_VALUE = "***";

/**
 * Check if a field name matches any of the provided patterns
 */
function matchesPattern(fieldName: string, patterns: (string | RegExp)[]): boolean {
  for (const pattern of patterns) {
    if (typeof pattern === "string") {
      if (fieldName.toLowerCase() === pattern.toLowerCase()) return true;
    } else if (pattern instanceof RegExp) {
      if (pattern.test(fieldName)) return true;
    }
  }
  return false;
}

/**
 * Mask specified query parameters
 */
export function maskQueryParams(
  params: Record<string, string> | undefined | null,
  patterns?: (string | RegExp)[]
): Record<string, string> | undefined {
  if (!params || !patterns?.length) return params ?? undefined;

  const masked: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    masked[key] = matchesPattern(key, patterns) ? MASK_VALUE : value;
  }
  return masked;
}

/**
 * Mask specified headers
 */
export function maskHeaders(
  headers: Record<string, string> | undefined | null,
  patterns?: (string | RegExp)[]
): Record<string, string> | undefined {
  if (!headers || !patterns?.length) return headers ?? undefined;

  const masked: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    masked[key] = matchesPattern(key, patterns) ? MASK_VALUE : value;
  }
  return masked;
}

/**
 * Deep mask specified fields in a body object
 */
export function maskBodyFields(
  body: any,
  patterns?: (string | RegExp)[]
): any {
  if (!body || !patterns?.length) return body;

  if (typeof body === "string") {
    try {
      const parsed = JSON.parse(body);
      const masked = maskObjectFields(parsed, patterns);
      return JSON.stringify(masked);
    } catch {
      return body;
    }
  }

  if (typeof body === "object") {
    return maskObjectFields(body, patterns);
  }

  return body;
}

/**
 * Recursively mask fields in an object
 */
function maskObjectFields(
  obj: any,
  patterns: (string | RegExp)[]
): any {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== "object") return obj;

  if (Array.isArray(obj)) {
    return obj.map((item) => maskObjectFields(item, patterns));
  }

  const masked: Record<string, any> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (matchesPattern(key, patterns)) {
      masked[key] = MASK_VALUE;
    } else if (typeof value === "object" && value !== null) {
      masked[key] = maskObjectFields(value, patterns);
    } else {
      masked[key] = value;
    }
  }
  return masked;
}

/**
 * Truncate a body string to the maximum allowed size
 */
export function truncateBody(
  body: string | undefined | null,
  maxSize: number = 10_000
): string | undefined {
  if (!body) return undefined;
  if (body.length <= maxSize) return body;
  return body.slice(0, maxSize) + `... [truncated, ${body.length} bytes total]`;
}
