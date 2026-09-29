/// Device facts and default storage, in a browser.
///
/// Returns nothing rather than guessing. The fields the `dart:io` version
/// reports — OS, OS version, locale, core count, Dart version — have no honest
/// browser equivalent: what a page can see is the user-agent string, which is
/// deliberately frozen and widely spoofed. Reading `navigator` would also mean
/// taking `package:web` and a Dart 3.3 floor to produce values less reliable
/// than the absence of them.
///
/// The server already reads the browser's own User-Agent, so an empty answer
/// here loses nothing that is not recovered at the other end.
library;

import 'device_facts.dart';

/// True here. Decides same-origin propagation, and that no User-Agent is set —
/// a browser forbids it, and the real one is better anyway.
const bool runningOnWeb = true;

Map<String, Object?> deviceContext() => const {};

DeviceFacts platformFacts() => const DeviceFacts();

/// No filesystem, and the web spool ignores the path it is handed.
String defaultStoragePath() => '';
