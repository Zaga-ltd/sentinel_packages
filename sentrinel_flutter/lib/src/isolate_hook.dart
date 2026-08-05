/// Cross-isolate error reporting, where the platform has isolates.
library;

export 'isolate_hook_web.dart' if (dart.library.io) 'isolate_hook_io.dart';
