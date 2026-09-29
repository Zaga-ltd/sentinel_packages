export declare const MASK_VALUE = "***";
export type MaskPattern = string | RegExp;
export declare function shouldMaskHeader(name: string, patterns?: readonly MaskPattern[]): boolean;
export declare function shouldMaskField(name: string, patterns?: readonly MaskPattern[]): boolean;
export declare function shouldMaskQueryKey(name: string, patterns?: readonly MaskPattern[]): boolean;
/**
 * Mask query parameters. The built-in list always applies; `patterns` adds to
 * it.
 */
export declare function maskQueryParams(params: Record<string, string> | undefined | null, patterns?: MaskPattern[]): Record<string, string> | undefined;
/** Mask headers. The built-in list always applies; `patterns` adds to it. */
export declare function maskHeaders(headers: Record<string, string> | undefined | null, patterns?: MaskPattern[]): Record<string, string> | undefined;
/**
 * Mask sensitive fields in a body.
 *
 * Accepts a parsed object or the raw text. Text is handled as JSON when it
 * parses, as `application/x-www-form-urlencoded` or multipart when it looks
 * like one, and otherwise by a JSON-shaped text scan — see the header of this
 * file for why "it did not parse" must never mean "send it unmasked".
 *
 * The built-in list always applies; `patterns` adds to it.
 */
export declare function maskBodyFields(body: any, patterns?: MaskPattern[], contentType?: string): any;
/**
 * Mask the sensitive query (and fragment) parameters of a URL, leaving the
 * rest exactly as written.
 *
 * The fragment is included because OAuth's implicit flow returns
 * `#access_token=…`, and a single-page app's `location.href` carries it until
 * the router rewrites it. Works on absolute and relative URLs alike, and on
 * strings that are not URLs at all (returned unchanged).
 */
export declare function maskUrl(url: string, patterns?: MaskPattern[]): string;
/**
 * Truncate a body string to the maximum allowed size.
 *
 * `totalBytes` is the real size when the caller knows it (a content-length, or
 * a capture that stopped early); without it the marker says only that the
 * body was cut.
 */
export declare function truncateBody(body: string | undefined | null, maxSize?: number, totalBytes?: number): string | undefined;
