/// Uncaught errors from other isolates, where isolates exist.
library;

import 'dart:isolate';

/// Handle for an installed listener, so a second [listenForIsolateErrors] can
/// replace the first instead of stacking duplicate reports.
class IsolateErrorSubscription {
  IsolateErrorSubscription(this._port);

  final RawReceivePort _port;

  void close() => _port.close();
}

/// Errors thrown on other isolates never reach a zone handler on this one.
///
/// Returns null when the embedder does not allow the listener; nothing else
/// depends on it.
IsolateErrorSubscription? listenForIsolateErrors(
  void Function(String error, StackTrace? stack) onError,
) {
  try {
    final port = RawReceivePort((dynamic pair) {
      // Isolate errors arrive as [errorString, stackString].
      if (pair is List && pair.length >= 2) {
        onError(
          pair[0]?.toString() ?? 'Isolate error',
          pair[1] == null ? null : StackTrace.fromString(pair[1].toString()),
        );
      }
    });
    Isolate.current.addErrorListener(port.sendPort);
    return IsolateErrorSubscription(port);
  } catch (_) {
    // Not supported on every platform; nothing else depends on it.
    return null;
  }
}
