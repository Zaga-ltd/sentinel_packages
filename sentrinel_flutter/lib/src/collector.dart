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

  void recordError(ErrorRecord record) {
    _push(_errors, record, kMaxBufferedErrors);
  }

  void recordLog(LogRecord record) {
    _push(_logs, record, kMaxBufferedLogs);
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
      _errors.length +
      _logs.length +
      _sessions.length +
      _replayed.values.fold(0, (n, list) => n + list.length);

  Future<void> flush() async {
    if (pending == 0) return;

    // Taken before any await so records arriving mid-flush are not lost.
    final requests = List<RequestRecord>.from(_requests);
    final errors = List<ErrorRecord>.from(_errors);
    final logs = List<LogRecord>.from(_logs);
    final replayed = {
      for (final e in _replayed.entries) e.key: List<Map<String, dynamic>>.from(e.value)
    };
    final sessions = List<SessionRecord>.from(_sessions.values);
    _requests.clear();
    _errors.clear();
    _logs.clear();
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
    await Future.wait(sends);
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
