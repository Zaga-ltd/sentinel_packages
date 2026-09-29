export interface FlutterTraceHeaders {
    traceparent: string;
    "x-trace-id": string;
    "x-consumer-id": string;
}
/**
 * Generates W3C traceparent and consumer headers for Flutter Dio Interceptor / http Client.
 */
export declare function createFlutterHeaderMap(clientName?: string): FlutterTraceHeaders;
