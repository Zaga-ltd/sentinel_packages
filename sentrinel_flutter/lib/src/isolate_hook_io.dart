/// Uncaught errors from other isolates, where isolates exist.
library;

import 'dart:isolate';

/// Handle for an installed listener, so a second [listenForIsolateErrors] can
/// replace the first instead of stacking duplicate reports.
class IsolateErrorSubscription {
  IsolateErrorSubscription(this._port);

  final RawReceivePort _port;

  /// Where a spawned isolate should send its uncaught errors.
  SendPort get errorPort => _port.sendPort;

  void close() {
    if (identical(_active, _port.sendPort)) _active = null;
    _port.close();
  }
}

SendPort? _active;

/// The port to hand `Isolate.spawn(onError:)`.
///
/// [Isolate.spawn] does not inherit the spawner's error listeners — a worker
/// started without `onError` prints its crash to stderr and reports nothing.
/// Passing this port is what connects it:
///
/// ```dart
/// await Isolate.spawn(work, message, onError: isolateErrorPort);
/// ```
///
/// Lives here rather than on `Sentrinel` so it can be typed `SendPort?`
/// without `sentrinel.dart` importing `dart:isolate`, which would break the
/// web build. Null before `Sentrinel.init`; `Isolate.spawn` accepts a null
/// `onError`, so it stays safe to pass either way.
SendPort? get isolateErrorPort => _active;

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
    _active = port.sendPort;
    return IsolateErrorSubscription(port);
  } catch (_) {
    // Not supported on every platform; nothing else depends on it.
    return null;
  }
}
