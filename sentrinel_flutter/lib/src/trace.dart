/// W3C trace context.
///
/// This is the whole reason a mobile SDK is worth having rather than just
/// counting requests locally: when the app sends `traceparent`, the backend
/// plugin continues that trace instead of starting a new one, and the tap and
/// the server work that followed it end up on one timeline.
library;

import 'dart:math';

final _rand = Random.secure();

String _hex(int bytes) {
  final buffer = StringBuffer();
  for (var i = 0; i < bytes; i++) {
    buffer.write(_rand.nextInt(256).toRadixString(16).padLeft(2, '0'));
  }
  return buffer.toString();
}

/// 32 lowercase hex characters, as the spec requires.
String generateTraceId() => _hex(16);

/// 16 lowercase hex characters.
String generateSpanId() => _hex(8);

/// One trace, and the span the app is currently inside.
class TraceContext {
  TraceContext({String? traceId, String? spanId})
      : traceId = traceId ?? generateTraceId(),
        spanId = spanId ?? generateSpanId();

  final String traceId;
  final String spanId;

  /// `00-<trace>-<span>-01` — version 0, sampled.
  ///
  /// The sampled flag is always set: this SDK only creates a context for a
  /// request it is already recording, so telling the backend to drop it would
  /// leave the mobile half of the trace with no server half.
  String get traceparent => '00-$traceId-$spanId-01';

  /// Parse an inbound header, or null if it is malformed.
  ///
  /// Lenient on version — a future version still carries a usable trace id in
  /// the same positions, and dropping the correlation over an unknown version
  /// byte would lose more than it protects.
  static TraceContext? parse(String? header) {
    if (header == null) return null;
    final parts = header.trim().split('-');
    if (parts.length < 4) return null;
    final traceId = parts[1];
    final spanId = parts[2];
    if (traceId.length != 32 || spanId.length != 16) return null;
    if (!_isHex(traceId) || !_isHex(spanId)) return null;
    // An all-zero id is defined as invalid.
    if (traceId == '0' * 32 || spanId == '0' * 16) return null;
    return TraceContext(traceId: traceId, spanId: spanId);
  }

  static bool _isHex(String s) =>
      RegExp(r'^[0-9a-f]+$').hasMatch(s.toLowerCase());
}
