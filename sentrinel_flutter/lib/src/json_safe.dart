/// JSON encoding that cannot be broken by what the app hands it.
///
/// Attributes, event properties and breadcrumb data are the app's values, and
/// apps put anything in them: a `DateTime`, an enum, a model object, a `NaN`
/// from a division by zero. Plain `jsonEncode` throws on every one of those —
/// and it used to throw inside a `catch (_) {}`, so one `DateTime` in one
/// property silently dropped the whole batch it rode in, and in the crash spool
/// it marked the directory unusable for the rest of the run. This turns each
/// such value into something JSON can carry instead.
library;

import 'dart:convert';

/// `jsonEncode`, but every value has a representation.
///
/// * `DateTime` → ISO-8601 in UTC, the format every other timestamp uses.
/// * `NaN` / `±Infinity` → `null`: JSON has no spelling for them.
/// * an enum → its name.
/// * anything with a `toJson()` → that.
/// * anything else → `toString()`.
///
/// A cycle still throws `JsonCyclicError`; callers that must not fail catch it
/// and drop only the record that contained it.
String safeJsonEncode(Object? value) => jsonEncode(value, toEncodable: _encodable);

Object? _encodable(Object? value) {
  if (value is DateTime) return value.toUtc().toIso8601String();
  // Only reached for a number JSON cannot hold; finite ones never get here.
  if (value is num) return null;
  if (value is Enum) return value.name;
  if (value is Uri) return value.toString();
  if (value is Set) return value.toList();
  try {
    final json = (value as dynamic).toJson();
    // Guard against a toJson() that returns itself, which would loop.
    if (!identical(json, value)) return json;
  } catch (_) {
    // No toJson, or it threw. Fall through to the string form.
  }
  try {
    return value.toString();
  } catch (_) {
    return '<unencodable ${value.runtimeType}>';
  }
}

/// Encode a batch envelope whose [listKey] holds the records.
///
/// Tries the whole thing first — the normal case costs one encode. If that
/// fails (a cycle, a toJson that returns garbage), each record is encoded on
/// its own and only the ones that fail are left out, so one bad record costs
/// itself rather than its hundred neighbours. Returns null only when not even
/// the envelope can be encoded. [onDropped] is told how many were left out.
String? encodeBatch(
  Map<String, dynamic> envelope,
  String listKey, {
  void Function(int dropped)? onDropped,
}) {
  try {
    return safeJsonEncode(envelope);
  } catch (_) {
    final list = envelope[listKey];
    if (list is! List) return null;
    final kept = <Object?>[];
    var dropped = 0;
    for (final item in list) {
      try {
        kept.add(jsonDecode(safeJsonEncode(item)));
      } catch (_) {
        dropped++;
      }
    }
    if (dropped > 0) onDropped?.call(dropped);
    try {
      return safeJsonEncode({...envelope, listKey: kept});
    } catch (_) {
      return null;
    }
  }
}
