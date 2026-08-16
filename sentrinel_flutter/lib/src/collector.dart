/// Buffers telemetry in memory and flushes batches to the Sentrinel API.
///
/// The design constraint on a phone is different from a server: the network is
/// unreliable and expensive, and the app may be killed at any moment. So this
/// never blocks a request, never retries forever, and drops rather than grows
/// when it cannot reach the server — a monitoring SDK that causes the crash it
/// was installed to report is worse than no SDK.
library;

import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

import 'models.dart';

/// What the collector will not exceed while offline.
///
/// At the default flush interval this is several minutes of a busy app. Past
/// it the oldest records are dropped: bounded memory matters more than a
/// complete record of an outage the user cannot see anyway.
const int kMaxBufferedRequests = 500;
const int kMaxBufferedErrors = 200;
const int kMaxBufferedLogs = 500;
const int kMaxBufferedSpans = 500;

/// The server refuses a batch over 500 events, so buffering more than that
/// would only guarantee a 413. Matching the limit means the oldest are dropped
/// here, where the reason is visible in [droppedRecords].
const int kMaxBufferedEvents = 500;

class SentrinelCollector {
  SentrinelCollector({
    required this.serverUrl,
    required this.appName,
    required this.env,
    required this.apiKey,
    this.flushInterval = const Duration(seconds: 30),
    http.Client? client,
  }) : _client = client ?? http.Client();

  final String serverUrl;
  final String appName;
  final String env;
  final String? apiKey;
  final Duration flushInterval;
  final http.Client _client;

  final List<RequestRecord> _requests = [];
  final List<ErrorRecord> _errors = [];
  final List<LogRecord> _logs = [];
  final List<SpanRecord> _spans = [];
  final List<EventRecord> _events = [];

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

  Timer? _timer;
  bool _warned = false;

  /// How many records were dropped because the buffer was full. Surfaced so a
  /// host app can tell "quiet" from "silently discarding".
  int droppedRecords = 0;

  void start() {
    _timer?.cancel();
    _timer = Timer.periodic(flushInterval, (_) => flush());
  }

  Future<void> stop() async {
    _timer?.cancel();
    _timer = null;
    await flush();
  }

  void recordRequest(RequestRecord record) {
    _push(_requests, record, kMaxBufferedRequests);
  }

  void recordSpan(SpanRecord record) {
    _push(_spans, record, kMaxBufferedSpans);
  }

  void recordError(ErrorRecord record) {
    _push(_errors, record, kMaxBufferedErrors);
  }

  void recordLog(LogRecord record) {
    _push(_logs, record, kMaxBufferedLogs);
  }

  void recordEvent(EventRecord record) {
    _push(_events, record, kMaxBufferedEvents);
  }

  /// Sessions are keyed, not appended: a session reported at start and again at
  /// end must send one row, not two. The server upserts, but sending both from
  /// the same flush would be pure waste.
  final Map<String, SessionRecord> _sessions = {};

  void recordSession(SessionRecord record) {
    _sessions[record.sessionId] = record;
  }

  /// Records replayed from disk after a crash.
  ///
  /// Already-serialised JSON, kept verbatim: these were written at crash time
  /// and their timestamps belong to then, not to this launch. Re-building them
  /// into model objects would only risk changing them.
  final Map<String, List<Map<String, dynamic>>> _replayed = {};

  void recordRaw(String kind, Map<String, dynamic> json) {
    final bucket = _replayed.putIfAbsent(kind, () => []);
    if (bucket.length >= kMaxBufferedErrors) {
      bucket.removeAt(0);
      droppedRecords++;
      return;
    }
    bucket.add(json);
  }

  void _push<T>(List<T> buffer, T item, int max) {
    if (buffer.length >= max) {
      // Drop the oldest: the newest records are the ones a developer opening
      // the dashboard right now actually wants.
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

  Future<void> flush() async {
    if (pending == 0) return;

    // Taken before any await so records arriving mid-flush are not lost.
    final requests = List<RequestRecord>.from(_requests);
    final spans = List<SpanRecord>.from(_spans);
    final errors = List<ErrorRecord>.from(_errors);
    final logs = List<LogRecord>.from(_logs);
    final events = List<EventRecord>.from(_events);
    final replayed = {
      for (final e in _replayed.entries) e.key: List<Map<String, dynamic>>.from(e.value)
    };
    final sessions = List<SessionRecord>.from(_sessions.values);
    _requests.clear();
    _spans.clear();
    _errors.clear();
    _logs.clear();
    _events.clear();
    _sessions.clear();
    _replayed.clear();

    // Crash reports from a previous run travel with this run's records, on the
    // same endpoints — the server cannot tell the difference and should not.
    final endpoints = {'request': 'requests', 'error': 'errors', 'log': 'logs'};
    final sends = <Future<void>>[];

    List<Map<String, dynamic>> combined(String kind, List<Map<String, dynamic>> live) =>
        [...?replayed[kind], ...live];

    final allRequests = combined('request', requests.map((r) => r.toJson()).toList());
    final allErrors = combined('error', errors.map((e) => e.toJson()).toList());
    final allLogs = combined('log', logs.map((l) => l.toJson()).toList());

    if (allRequests.isNotEmpty) {
      sends.add(_post('/api/ingest/${endpoints['request']}', {
        'appName': appName,
        'env': env,
        'requests': allRequests,
      }));
    }
    if (allErrors.isNotEmpty) {
      sends.add(_post('/api/ingest/${endpoints['error']}', {
        'appName': appName,
        'env': env,
        'errors': allErrors,
      }));
    }
    if (allLogs.isNotEmpty) {
      sends.add(_post('/api/ingest/${endpoints['log']}', {
        'appName': appName,
        'env': env,
        'logs': allLogs,
      }));
    }
    // One payload per span. The trace ingest route takes a trace and its
    // spans together, and a client span is the root of its own trace — the
    // server's span arrives separately and joins by parent id.
    for (final span in spans) {
      sends.add(_post('/api/ingest/traces', {
        'appName': appName,
        'env': env,
        'traceId': span.traceId,
        'name': span.name,
        'startTime': span.startTime.toUtc().toIso8601String(),
        'endTime': span.startTime
            .add(Duration(microseconds: (span.durationMs * 1000).round()))
            .toUtc()
            .toIso8601String(),
        'durationMs': span.durationMs,
        'statusCode': span.statusCode == 'ERROR' ? 500 : 200,
        'spans': [span.toJson()],
      }));
    }

    // Product events. The identity travels on the envelope rather than on each
    // row: every event in one flush came from the same install and the same
    // signed-in user, and repeating it per row would be pure payload.
    if (events.isNotEmpty && (anonymousId != null || userId != null)) {
      sends.add(_post('/api/ingest/events', {
        'appName': appName,
        'env': env,
        if (anonymousId != null) 'anonymousId': anonymousId,
        if (userId != null) 'userId': userId,
        if (release != null) 'release': release,
        'platform': 'mobile',
        'events': events.map((e) => e.toJson()).toList(),
      }));
    }

    final allSessions = [
      ...?replayed['session'],
      ...sessions.map((s) => s.toJson()),
    ];
    if (allSessions.isNotEmpty) {
      sends.add(_post('/api/ingest/sessions', {
        'appName': appName,
        'env': env,
        'sessions': allSessions,
      }));
    }

    // The per-endpoint rollup, alongside the individual rows above.
    //
    // Not redundant with them: the dashboard's headline numbers — request
    // count, error rate, p95, the Traffic and Performance charts — all read
    // the rollup, while the request rows feed the log view. Sending only the
    // rows meant a Flutter app that was reporting perfectly showed "0
    // requests, 0.0%, 0 ms" on the Apps page, which is the exact screen
    // someone opens to check whether their integration works.
    if (allRequests.isNotEmpty) {
      sends.add(_post('/api/ingest/metrics', {
        'appName': appName,
        'env': env,
        'timestamp': DateTime.now().toUtc().toIso8601String(),
        'endpoints': _rollUpEndpoints(allRequests),
        'consumers': _rollUpConsumers(allRequests),
      }));
    }

    await Future.wait(sends);
  }

  /// Groups this batch's requests by method+path into the shape
  /// `/api/ingest/metrics` stores.
  ///
  /// The percentiles are computed over one flush, which is a smaller window
  /// than a server's — but it is the same window the server plugin uses, and
  /// the API averages across rows when it charts them.
  List<Map<String, dynamic>> _rollUpEndpoints(List<Map<String, dynamic>> requests) {
    final groups = <String, List<Map<String, dynamic>>>{};
    for (final r in requests) {
      groups.putIfAbsent('${r['method']} ${r['path']}', () => []).add(r);
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
        if (status >= 400) errors++;
        requestSize += ((r['requestSize'] ?? 0) as num).toInt();
        responseSize += ((r['responseSize'] ?? 0) as num).toInt();
      }

      return {
        'method': rows.first['method'],
        'path': rows.first['path'],
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
      groups.putIfAbsent('$id ${r['method']} ${r['path']}', () => []).add(r);
    }

    return groups.values.map((rows) {
      var errors = 0;
      var total = 0.0;
      for (final r in rows) {
        if ((r['statusCode'] as num).toInt() >= 400) errors++;
        total += (r['responseTime'] as num).toDouble();
      }
      return {
        'identifier': rows.first['consumerIdentifier'],
        'method': rows.first['method'],
        'path': rows.first['path'],
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

  Future<void> _post(String path, Map<String, dynamic> body) async {
    final uri = Uri.parse('${serverUrl.replaceAll(RegExp(r'/$'), '')}$path');
    try {
      final res = await _client.post(
        uri,
        headers: {
          'content-type': 'application/json',
          if (apiKey != null) 'x-api-key': apiKey!,
        },
        body: jsonEncode(body),
      );
      if (res.statusCode >= 400) _warnOnce(res.statusCode, res.body);
    } catch (_) {
      // Offline, or the server is down. The batch is already gone from the
      // buffer — deliberately. Retrying would grow memory without bound on a
      // device that may be offline for hours, and stale telemetry is worth
      // less than a working app.
    }
  }

  /// One warning per process. A monitoring SDK that spams the console during an
  /// outage is its own kind of incident.
  void _warnOnce(int status, String body) {
    if (_warned) return;
    _warned = true;
    final hint = switch (status) {
      401 || 403 =>
        'Check apiKey, appName and env — the key must belong to this app and environment.',
      429 => 'Over quota.',
      _ => body.isEmpty ? '' : body,
    };
    // ignore: avoid_print
    print('[sentrinel] telemetry rejected ($status). $hint');
  }

  void dispose() {
    _timer?.cancel();
    _client.close();
  }
}
