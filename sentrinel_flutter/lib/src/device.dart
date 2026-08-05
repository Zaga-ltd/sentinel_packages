/// Device context and default storage path, per platform.
///
/// Web is the default branch so that a target without `dart:io` still
/// compiles; `dart:io` is opted into where it exists.
library;

export 'device_web.dart' if (dart.library.io) 'device_io.dart';
