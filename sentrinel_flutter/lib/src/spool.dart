/// Picks the spool that the target platform can actually build.
///
/// A browser has no filesystem, and `dart:io` does not report that by failing
/// to build — dart2js compiles the import and every member throws
/// `UnsupportedError` when first touched. So the old unconditional import blew
/// up at *runtime*, inside `Sentrinel.init`, as `Unsupported operation:
/// _Namespace` — far from anything that named a file. Resolving the platform at
/// import time means the browser never reaches that code at all.
///
/// See `spool_io.dart` for the durable queue and `spool_web.dart` for what the
/// browser gives up in exchange.
library;

export 'spool_record.dart';
export 'spool_web.dart' if (dart.library.io) 'spool_io.dart';
