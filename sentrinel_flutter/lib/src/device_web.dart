/// Device facts and default storage, in a browser.
///
/// Returns nothing rather than guessing. The fields the `dart:io` version
/// reports — OS, OS version, locale, core count, Dart version — have no honest
/// browser equivalent: what a page can see is the user-agent string, which is
/// deliberately frozen and widely spoofed. Reading `navigator` would also mean
/// taking `package:web` and a Dart 3.3 floor to produce values less reliable
/// than the absence of them.
///
/// The server already records what it can see about a web caller, so an empty
/// map here loses nothing that is not recovered at the other end.
library;

Map<String, Object?> deviceContext() => const {};

/// No filesystem, and the web spool ignores the path it is handed.
String defaultStoragePath() => '';
