/// Buffers telemetry in memory and flushes batches to the Sentrinel API.
///
/// The design constraint on a phone is different from a server: the network is
/// unreliable and expensive, and the app may be killed at any moment. So this
/// never blocks a request, never retries forever, and drops rather than grows
/// when it cannot reach the server — a monitoring SDK that causes the crash it
/// was installed to report is worse than no SDK.
///
/// The one exception is a record that is also on disk (a crash report, or one
/// replayed from an earlier run). Those are retried until the server has them,
/// because the disk copy already bounds them and losing a crash report to one
/// bad connection is exactly what the spool exists to prevent.
library;

import 'dart:async';
import 'dart:collection';

import 'package:http/http.dart' as http;

import 'device_facts.dart';
import 'json_safe.dart';
import 'metrics.dart';
import 'models.dart';

/// What the collector will not exceed while offline.
///
/// At the default flush interval this is several minutes of a busy app. Past
/// it the oldest records are dropped: bounded memory matters more than a
/// complete record of an outage the user cannot see anyway.
const int kMaxBufferedRequests = 500;
const int kMaxBufferedErrors = 200;
const int kMaxBufferedLogs = 500;

/// Also the most spans one flush sends, and so the most one batch carries —
/// well under the trace endpoint's 10,000.
const int kMaxBufferedSpans = 500;

/// The server refuses a batch over 500 events, so buffering more than that
/// would only guarantee a 413. Matching the limit means the oldest are dropped
/// here, where the reason is visible in [droppedRecords].
const int kMaxBufferedEvents = 500;

/// Requests in flight at once. A flush can touch eight endpoints; firing all of
/// them, plus a retry, on a phone that just regained one bar of signal is how a
/// monitoring SDK becomes the thing hogging the radio.
const int kMaxConcurrentPosts = 4;

/// Rewrites or drops a record before it leaves the device.
///
/// [kind] is `request`, `error`, `log`, `span` or `event`; [record] is the
/// exact JSON that would be sent. Return it (changed or not) to send it, or
/// null to drop it. Runs before a crash report is written to disk, so what it
/// removes is never stored either.
typedef BeforeSend = Map<String, dynamic>? Function(String kind, Map<String, dynamic> record);

/// A record plus the spool id that removes its disk copy once it is sent.
class _Entry {
  _Entry(this.json, [this.spoolId]);
  final Map<String, dynamic> json;
  final String? spoolId;
}

enum _Outcome {
  /// 2xx.
  delivered,

  /// The server read it and will never take it (400, 413, 422). Retrying
  /// would replay it on every launch forever.
  rejected,

  /// Offline, timed out, 5xx, 429, or an auth problem a new build may fix.
  failed,
}

class SentrinelCollector {
  SentrinelCollector({
    required this.serverUrl,
    required this.appName,
    required this.env,
    required this.apiKey,
    this.module,
    this.flushInterval = const Duration(seconds: 30),
    http.Client? client,
    this.userAgent,
    this.beforeSend,
    this.maxConcurrentPosts = kMaxConcurrentPosts,
  })  : _client = client ?? http.Client(),
        _ownsClient = client == null;

  final String serverUrl;
  final String appName;
  final String env;
  final String? apiKey;

  /// Which part of the project this client is — `mobile`, `tablet`, `kiosk`.
  /// Unset, the server names it after the API key.
  final String? module;
  final Duration flushInterval;
  final http.Client _client;

  /// Whether [dispose] may close [_client]. A client the app passed in is the
  /// app's: closing it on re-init broke whatever else the app used it for.
  final bool _ownsClient;

  /// Sent on every post where the platform allows it (not in a browser).
  /// Updated when the app reports better device facts.
  String? userAgent;
  final BeforeSend? beforeSend;
  final int maxConcurrentPosts;

  final List<Map<String, dynamic>> _requests = [];
  final List<_Entry> _errors = [];
  final List<Map<String, dynamic>> _logs = [];
  final List<Map<String, dynamic>> _spans = [];
  final List<Map<String, dynamic>> _events = [];

  /// Stable per-install id, set by [Sentrinel.init].
  ///
  /// Every event needs an identity or the server drops it — an event with
  /// nobody attached cannot appear in a funnel, and bucketing it under a
  /// synthetic id would read as one enormous user.
  String? anonymousId;

  /// Set by [Sentrinel.identify]; null until someone signs in.
  String? userId;

  /// Reported so events can be split by build the way sessions are.
  String? release;

  /// The device, sent on the events envelope so the server does not have to
  /// guess it from a User-Agent.
  DeviceFacts device = const DeviceFacts();

  /// Told the spool ids of records the server now has (or has refused for
  /// good), so their disk copies can go.
  void Function(List<String> spoolIds)? onDelivered;

  Timer? _timer;
  Timer? _soon;
  bool _warned = false;
  bool _warnedEncode = false;
  bool _warnedHook = false;
  bool _disposed = false;

  /// True after [dispose]: nothing is buffered or sent again.
  bool get isDisposed => _disposed;

  /// How many records were dropped because the buffer was full, a hook
  /// dropped them, or they could not be encoded. Surfaced so a host app can
  /// tell "quiet" from "silently discarding".
  int droppedRecords = 0;

  void start() {
    if (_disposed) return;
    _timer?.cancel();
    _timer = Timer.periodic(flushInterval, (_) => flush());
  }

  /// Stop the timer and send what is left.
  Future<void> stop() async {
    _timer?.cancel();
    _timer = null;
    _soon?.cancel();
    _soon = null;
    await flush();
  }

  /// Flush shortly, coalescing whatever else arrives in between.
  ///
  /// An unhandled error should not wait thirty seconds — the app may be
  /// backgrounded and killed first — but a build method that throws on every
  /// frame should not cost a request per frame either.
  void flushSoon([Duration delay = const Duration(seconds: 1)]) {
    if (_disposed || _soon != null) return;
    _soon = Timer(delay, () {
      _soon = null;
      flush();
    });
  }

  /// Run the app's [beforeSend] hook. Null means "do not send".
  ///
  /// A hook that throws drops the record: the hook exists to remove data, and
  /// sending the unfiltered record because the filter broke would do the
  /// opposite of what it was installed for.
  Map<String, dynamic>? applyBeforeSend(String kind, Map<String, dynamic> json) {
    final hook = beforeSend;
    if (hook == null) return json;
    try {
      final out = hook(kind, json);
      if (out == null) droppedRecords++;
      return out;
    } catch (e) {
      droppedRecords++;
      if (!_warnedHook) {
        _warnedHook = true;
        // ignore: avoid_print
        print('[sentrinel] beforeSend threw ($e); the record was dropped.');
      }
      return null;
    }
  }

  void recordRequest(RequestRecord record) =>
      _add('request', record.toJson(), _requests, kMaxBufferedRequests);

  void recordSpan(SpanRecord record) =>
      _add('span', record.toJson(), _spans, kMaxBufferedSpans);

  void recordLog(LogRecord record) => _add('log', record.toJson(), _logs, kMaxBufferedLogs);

  void recordEvent(EventRecord record) =>
      _add('event', record.toJson(), _events, kMaxBufferedEvents);

  void recordError(ErrorRecord record) {
    final json = applyBeforeSend('error', record.toJson());
    if (json != null) recordErrorJson(json);
  }

  /// An error that has already been through [applyBeforeSend] — and, when
  /// [spoolId] is set, written to disk under that id.
  void recordErrorJson(Map<String, dynamic> json, {String? spoolId}) {
    if (_disposed) return;
    _push(_errors, _Entry(json, spoolId), kMaxBufferedErrors);
  }

  void _add(String kind, Map<String, dynamic> json, List<Map<String, dynamic>> buffer, int max) {
    if (_disposed) return;
    final filtered = applyBeforeSend(kind, json);
    if (filtered == null) return;
    _push(buffer, filtered, max);
  }

  /// Sessions are keyed, not appended: a session reported at start and again at
  /// end must send one row, not two. The server upserts, but sending both from
  /// the same flush would be pure waste.
  final Map<String, SessionRecord> _sessions = {};

  void recordSession(SessionRecord record) {
    if (_disposed) return;
    _sessions[record.sessionId] = record;
  }

  /// Records replayed from disk after a crash.
  ///
  /// Already-serialised JSON, kept verbatim: these were written at crash time
  /// and their timestamps belong to then, not to this launch. Re-building them
  /// into model objects would only risk changing them.
  final Map<String, List<_Entry>> _replayed = {};

  void recordRaw(String kind, Map<String, dynamic> json, {String? spoolId}) {
    if (_disposed) return;
    _push(_replayed.putIfAbsent(kind, () => []), _Entry(json, spoolId), kMaxBufferedErrors);
  }

  void _push<T>(List<T> buffer, T item, int max) {
    if (buffer.length >= max) {
      // Drop the oldest: the newest records are the ones a developer opening
      // the dashboard right now actually wants. The new one is always kept —
      // an earlier version removed the oldest *and* returned without adding.
      buffer.removeAt(0);
      droppedRecords++;
    }
    buffer.add(item);
  }

  /// Number of records waiting to be sent. Exposed for tests and diagnostics.
  int get pending =>
      _requests.length +
      _spans.length +
      _errors.length +
      _logs.length +
      _events.length +
      _sessions.length +
      _replayed.values.fold(0, (n, list) => n + list.length);

  /// Custom metrics fold here and drain on flush — one row per series, not one
  /// per call, which is what makes count() safe in a build method.
  final MetricRegistry metrics = MetricRegistry();

  Future<void>? _inProgress;

  /// Send everything buffered.
  ///
  /// Flushes run one after another, never interleaved: a caller awaiting
  /// `flush()` while a timer-driven one is mid-flight used to return at once
  /// with nothing to do, before the records it cared about had been sent.
  Future<void> flush() {
    final previous = _inProgress;
    late final Future<void> current;
    current = () async {
      if (previous != null) await previous;
      await _flushOnce();
    }()
        .whenComplete(() {
      if (identical(_inProgress, current)) _inProgress = null;
    });
    _inProgress = current;
    return current;
  }

  Map<String, dynamic> _envelope(String listKey, List<Object?> rows) => {
        'appName': appName,
        if (module != null) 'module': module,
        'env': env,
        'sdk': {'name': kSdkName, 'version': kSdkVersion},
        listKey: rows,
      };

  Future<void> _flushOnce() async {
    if (_disposed) return;
    // Metrics can be the only thing buffered: a screen that counts an event
    // without making a request still has something to send.
    if (pending == 0 && metrics.size == 0) return;

    // Taken before any await so records arriving mid-flush are not lost.
    final requests = List<Map<String, dynamic>>.from(_requests);
    final spans = List<Map<String, dynamic>>.from(_spans);
    final errors = List<_Entry>.from(_errors);
    final logs = List<Map<String, dynamic>>.from(_logs);
    final events = List<Map<String, dynamic>>.from(_events);
    final replayed = {for (final e in _replayed.entries) e.key: List<_Entry>.from(e.value)};
    final sessions = List<SessionRecord>.from(_sessions.values);
    _requests.clear();
    _spans.clear();
    _errors.clear();
    _logs.clear();
    _events.clear();
    _sessions.clear();
    _replayed.clear();

    final sends = <Future<void>>[];

    // Crash reports from a previous run travel with this run's records, on the
    // same endpoints — the server cannot tell the difference and should not.
    void sendKind(String path, String listKey, String kind, List<_Entry> live) {
      final entries = [...?replayed[kind], ...live];
      if (entries.isEmpty) return;
      sends.add(_send(path, _envelope(listKey, entries.map((e) => e.json).toList()), listKey,
          entries: entries, kind: kind));
    }

    sendKind('/api/ingest/requests', 'requests', 'request', requests.map(_Entry.new).toList());
    sendKind('/api/ingest/errors', 'errors', 'error', errors);
    sendKind('/api/ingest/logs', 'logs', 'log', logs.map(_Entry.new).toList());

    // Spans, grouped into their traces and sent in batches. One post per span
    // was the old shape: a screen that made twenty calls cost twenty requests
    // of its own every flush.
    for (final batch in _traceBatches(spans)) {
      sends.add(_send('/api/ingest/traces', _envelope('traces', batch), 'traces'));
    }

    // Custom metrics ride the same flush. Drained here rather than buffered per
    // call because the registry folds increments in memory.
    final points = metrics.drain(DateTime.now());
    if (points.isNotEmpty) {
      sends.add(_send(
        '/api/ingest/custom-metrics',
        {..._envelope('metrics', points), if (release != null) 'version': release},
        'metrics',
      ));
    }

    // Product events. The identity travels on the envelope rather than on each
    // row: every event in one flush came from the same install and the same
    // signed-in user, and repeating it per row would be pure payload. So does
    // the device — without it the server read `Dart/3.x (dart:io)` and filed
    // every phone under "desktop".
    if (events.isNotEmpty && (anonymousId != null || userId != null)) {
      sends.add(_send('/api/ingest/events', {
        'appName': appName,
        if (module != null) 'module': module,
        'env': env,
        if (anonymousId != null) 'anonymousId': anonymousId,
        if (userId != null) 'userId': userId,
        if (release != null) 'release': release,
        'platform': 'mobile',
        ...device.toEnvelope(),
        'events': events,
      }, 'events'));
    }

    final sessionEntries = [
      ...?replayed['session'],
      ...sessions.map((s) => _Entry(s.toJson())),
    ];
    if (sessionEntries.isNotEmpty) {
      sends.add(_send(
        '/api/ingest/sessions',
        _envelope('sessions', sessionEntries.map((e) => e.json).toList()),
        'sessions',
        entries: sessionEntries,
        kind: 'session',
      ));
    }

    // The per-endpoint rollup, alongside the individual rows above.
    //
    // Not redundant with them: the dashboard's headline numbers — request
    // count, error rate, p95, the Traffic and Performance charts — all read
    // the rollup, while the request rows feed the log view. Sending only the
    // rows meant a Flutter app that was reporting perfectly showed "0
    // requests, 0.0%, 0 ms" on the Apps page.
    //
    // No `version` here, deliberately: on /metrics it marks a deploy, and a
    // fleet of phones on mixed releases would flip it on every flush.
    final allRequests = [
      ...?replayed['request']?.map((e) => e.json),
      ...requests,
    ];
    if (allRequests.isNotEmpty) {
      sends.add(_send('/api/ingest/metrics', {
        ..._envelope('endpoints', _rollUpEndpoints(allRequests)),
        'timestamp': DateTime.now().toUtc().toIso8601String(),
        'consumers': _rollUpConsumers(allRequests),
      }, 'endpoints'));
    }

    await Future.wait(sends);
  }

  /// Client spans grouped by trace, in batches the trace endpoint accepts.
  List<List<Map<String, dynamic>>> _traceBatches(List<Map<String, dynamic>> spans) {
    if (spans.isEmpty) return const [];
    final byTrace = <String, List<Map<String, dynamic>>>{};
    for (final span in spans) {
      final traceId = span['traceId'];
      if (traceId is! String || traceId.isEmpty) continue;
      byTrace.putIfAbsent(traceId, () => []).add(span);
    }

    final batches = <List<Map<String, dynamic>>>[];
    var current = <Map<String, dynamic>>[];
    var spanCount = 0;
    for (final entry in byTrace.entries) {
      final list = entry.value;
      if (current.isNotEmpty &&
          (current.length >= 500 || spanCount + list.length > kMaxBufferedSpans)) {
        batches.add(current);
        current = [];
        spanCount = 0;
      }
      current.add(_traceOf(entry.key, list));
      spanCount += list.length;
    }
    if (current.isNotEmpty) batches.add(current);
    return batches;
  }

  /// The trace row for a set of client spans. A client span is the root of its
  /// own trace; the server's spans for the same call arrive separately and join
  /// by parent id.
  Map<String, dynamic> _traceOf(String traceId, List<Map<String, dynamic>> spans) {
    DateTime? parse(Object? v) => v is String ? DateTime.tryParse(v) : null;
    final starts = spans.map((s) => parse(s['startTime'])).whereType<DateTime>().toList()..sort();
    final ends = spans.map((s) => parse(s['endTime'])).whereType<DateTime>().toList()..sort();
    final root = spans.firstWhere((s) => s['parentId'] == null, orElse: () => spans.first);
    final start = starts.isEmpty ? DateTime.now().toUtc() : starts.first;
    final end = ends.isEmpty ? start : ends.last;
    final attrs = root['attributes'];
    final status = attrs is Map ? attrs['http.status_code'] : null;
    return {
      'traceId': traceId,
      'name': root['name'] ?? 'request',
      'startTime': start.toUtc().toIso8601String(),
      'endTime': end.toUtc().toIso8601String(),
      'durationMs': end.difference(start).inMicroseconds / 1000.0,
      'statusCode': status is int
          ? status
          : (spans.any((s) => s['statusCode'] == 'ERROR') ? 500 : 200),
      'spans': spans,
    };
  }

  /// The route a request row groups under: the one it carries, or its path
  /// with the ids collapsed — by the server's own rules, so the rollup row and
  /// the stored endpoint are the same row.
  static String _routeOf(Map<String, dynamic> r) {
    final route = r['route'];
    if (route is String && route.isNotEmpty) return route;
    final path = normaliseRoutePath(r['path'] as String?);
    return path.isEmpty ? '/' : path;
  }

  /// Groups this batch's requests by method+route into the shape
  /// `/api/ingest/metrics` stores.
  ///
  /// Keyed on the route, not the raw path: grouped by path, `/orders/1` and
  /// `/orders/2` became two rows that the server then normalised to the same
  /// endpoint — two partial rows for one route in the same minute.
  List<Map<String, dynamic>> _rollUpEndpoints(List<Map<String, dynamic>> requests) {
    final groups = <String, List<Map<String, dynamic>>>{};
    for (final r in requests) {
      groups.putIfAbsent('${r['method']} ${_routeOf(r)}', () => []).add(r);
    }

    return groups.values.map((rows) {
      final times = rows.map((r) => (r['responseTime'] as num).toDouble()).toList()..sort();
      final statusCodes = <String, int>{};
      var errors = 0;
      var requestSize = 0;
      var responseSize = 0;
      for (final r in rows) {
        final status = (r['statusCode'] as num).toInt();
        statusCodes['$status'] = (statusCodes['$status'] ?? 0) + 1;
        if (status >= 400 || status == 0) errors++;
        requestSize += ((r['requestSize'] ?? 0) as num).toInt();
        responseSize += ((r['responseSize'] ?? 0) as num).toInt();
      }

      return {
        'method': rows.first['method'],
        'path': _routeOf(rows.first),
        'requestCount': rows.length,
        'successCount': rows.length - errors,
        'errorCount': errors,
        'avgResponseTime': times.reduce((a, b) => a + b) / times.length,
        'minResponseTime': times.first,
        'maxResponseTime': times.last,
        'p50ResponseTime': _percentile(times, 0.5),
        'p95ResponseTime': _percentile(times, 0.95),
        'p99ResponseTime': _percentile(times, 0.99),
        'totalRequestSize': requestSize,
        'totalResponseSize': responseSize,
        'statusCodes': statusCodes,
      };
    }).toList();
  }

  /// One row per consumer per endpoint, matching the server plugin. Requests
  /// with no consumer identifier are left out rather than bucketed under a
  /// placeholder, which would invent a consumer nobody can act on.
  List<Map<String, dynamic>> _rollUpConsumers(List<Map<String, dynamic>> requests) {
    final groups = <String, List<Map<String, dynamic>>>{};
    for (final r in requests) {
      final id = r['consumerIdentifier'];
      if (id == null || (id is String && id.isEmpty)) continue;
      groups.putIfAbsent('$id ${r['method']} ${_routeOf(r)}', () => []).add(r);
    }

    return groups.values.map((rows) {
      var errors = 0;
      var total = 0.0;
      for (final r in rows) {
        final status = (r['statusCode'] as num).toInt();
        if (status >= 400 || status == 0) errors++;
        total += (r['responseTime'] as num).toDouble();
      }
      return {
        'identifier': rows.first['consumerIdentifier'],
        'method': rows.first['method'],
        'path': _routeOf(rows.first),
        'requestCount': rows.length,
        'errorCount': errors,
        'totalResponseTime': total,
      };
    }).toList();
  }

  /// Linear-interpolated percentile over an already-sorted list — the same
  /// method the server plugin uses, so a Flutter app's p95 and a backend's
  /// mean the same thing.
  double _percentile(List<double> sorted, double q) {
    if (sorted.isEmpty) return 0;
    if (sorted.length == 1) return sorted.first;
    final pos = (sorted.length - 1) * q;
    final lower = pos.floor();
    final upper = pos.ceil();
    if (lower == upper) return sorted[lower];
    return sorted[lower] + (sorted[upper] - sorted[lower]) * (pos - lower);
  }

  /// Post one batch, then settle what was on disk.
  ///
  /// [entries] carry the spool ids: on a 2xx (or a permanent refusal) their
  /// disk copies are acknowledged; on a failure the ones with a disk copy go
  /// back into the replay buffer for the next flush, and the disk copy stays
  /// for the next launch if this one never gets through.
  Future<void> _send(
    String path,
    Map<String, dynamic> body,
    String listKey, {
    List<_Entry>? entries,
    String? kind,
  }) async {
    final outcome = await _post(path, body, listKey);
    // Disposed means dead: nothing that happens afterwards may touch the disk
    // on this collector's behalf.
    if (_disposed) return;
    final durable = entries?.where((e) => e.spoolId != null).toList() ?? const <_Entry>[];
    if (durable.isEmpty) return;

    if (outcome == _Outcome.failed) {
      if (kind == null) return;
      for (final e in durable) {
        _push(_replayed.putIfAbsent(kind, () => []), e, kMaxBufferedErrors);
      }
      return;
    }
    onDelivered?.call(durable.map((e) => e.spoolId!).toList());
  }

  int _active = 0;
  final Queue<Completer<void>> _waiting = Queue();

  Future<T> _limited<T>(Future<T> Function() task) async {
    while (_active >= maxConcurrentPosts) {
      final slot = Completer<void>();
      _waiting.add(slot);
      await slot.future;
    }
    _active++;
    try {
      return await task();
    } finally {
      _active--;
      if (_waiting.isNotEmpty) _waiting.removeFirst().complete();
    }
  }

  Future<_Outcome> _post(String path, Map<String, dynamic> body, String listKey) async {
    if (_disposed) return _Outcome.failed;
    final encoded = encodeBatch(body, listKey, onDropped: (n) {
      droppedRecords += n;
      _warnEncodeOnce();
    });
    if (encoded == null) {
      _warnEncodeOnce();
      return _Outcome.rejected;
    }

    final uri = Uri.parse('${serverUrl.replaceAll(RegExp(r'/$'), '')}$path');
    return _limited(() async {
      try {
        final res = await _client
            .post(
              uri,
              headers: {
                'content-type': 'application/json',
                if (apiKey != null) 'x-api-key': apiKey!,
                if (userAgent != null) 'user-agent': userAgent!,
              },
              body: encoded,
            )
            // A request that never answers must not hold a slot forever.
            .timeout(const Duration(seconds: 30));
        if (res.statusCode < 300) return _Outcome.delivered;
        _warnOnce(res.statusCode, res.body);
        return switch (res.statusCode) {
          400 || 413 || 422 => _Outcome.rejected,
          _ => _Outcome.failed,
        };
      } catch (_) {
        // Offline, or the server is down. A live batch is gone from the buffer
        // — deliberately. Retrying would grow memory without bound on a device
        // that may be offline for hours, and stale telemetry is worth less
        // than a working app. Records with a disk copy are the exception; see
        // [_send].
        return _Outcome.failed;
      }
    });
  }

  /// One warning per process. A monitoring SDK that spams the console during an
  /// outage is its own kind of incident.
  void _warnOnce(int status, String body) {
    if (_warned) return;
    _warned = true;
    final hint = switch (status) {
      401 || 403 => 'Check apiKey and env — the key must be issued for this environment.',
      429 => 'Over quota.',
      _ => body.isEmpty ? '' : body,
    };
    // ignore: avoid_print
    print('[sentrinel] telemetry rejected ($status). $hint');
  }

  void _warnEncodeOnce() {
    if (_warnedEncode) return;
    _warnedEncode = true;
    // ignore: avoid_print
    print('[sentrinel] a record could not be encoded as JSON (a cycle in its '
        'attributes?) and was dropped; the rest of its batch was sent.');
  }

  /// Stop for good: no timer, no buffer, no further sends.
  ///
  /// What a dead process looks like from the outside, which is why the tests
  /// use it to simulate one. It does not flush — call [stop] first for that.
  void dispose() {
    _disposed = true;
    _timer?.cancel();
    _timer = null;
    _soon?.cancel();
    _soon = null;
    _requests.clear();
    _spans.clear();
    _errors.clear();
    _logs.clear();
    _events.clear();
    _sessions.clear();
    _replayed.clear();
    if (_ownsClient) _client.close();
  }
}
