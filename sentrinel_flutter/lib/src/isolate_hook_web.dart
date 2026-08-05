/// Isolate errors, in a browser — where there are none to listen for.
///
/// Web has no `Isolate.current.addErrorListener`: web workers do not share an
/// error channel with the main context the way isolates do. Every error that
/// can reach Dart code on this platform already arrives through the zone
/// handler, so nothing is missed by having nothing to install here.
library;

class IsolateErrorSubscription {
  void close() {}
}

IsolateErrorSubscription? listenForIsolateErrors(
  void Function(String error, StackTrace? stack) onError,
) =>
    null;
