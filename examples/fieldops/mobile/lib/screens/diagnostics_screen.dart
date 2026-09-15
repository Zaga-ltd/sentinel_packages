// Diagnostics — every failure mode on one screen.
//
// The rest of the app fails only when its own rules are broken, which makes it
// awkward to prove a particular dashboard panel works. These buttons take that
// argument away: one tap per telemetry type.

import 'dart:async';
import 'dart:isolate';

import 'package:flutter/material.dart';
import 'package:sentrinel_flutter/sentrinel_flutter.dart';

import '../api_client.dart';

/// A domain error with a stable name, so it groups as one issue.
class InspectionFailedError extends Error {
  InspectionFailedError(this.jobId);
  final String jobId;
  @override
  String toString() => 'InspectionFailedError: checklist incomplete on $jobId';
}

class DiagnosticsScreen extends StatefulWidget {
  const DiagnosticsScreen({super.key});

  @override
  State<DiagnosticsScreen> createState() => _DiagnosticsScreenState();
}

class _DiagnosticsScreenState extends State<DiagnosticsScreen> {
  final _api = FieldOpsApi();
  String _log = 'Pick a failure.';

  void _say(String msg) {
    if (mounted) setState(() => _log = msg);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Diagnostics')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          _section('Crashes & errors'),

          _tile(
            'Non-fatal error',
            'Captured and reported; the app keeps running.',
            () {
              Sentrinel.captureError(
                InspectionFailedError('wo_demo_1'),
                StackTrace.current,
                path: '/diagnostics/non-fatal',
                attributes: {'severity': 'low', 'recoverable': true},
              );
              _say('Non-fatal reported.');
            },
          ),

          _tile(
            'Fatal error (persisted)',
            'Written to disk synchronously, so it survives the process.',
            () {
              Sentrinel.captureError(
                StateError('FatalSyncFailure: local database is unreadable'),
                StackTrace.current,
                path: '/diagnostics/fatal',
                fatal: true,
                mechanism: 'manual.fatal',
                attributes: {'db.path': '/local/fieldops.sqlite'},
              );
              _say('Fatal reported and spooled to disk.');
            },
          ),

          _tile(
            'Uncaught async error',
            'Escapes to the guarded zone — nothing catches this one.',
            () {
              _say('Throwing async…');
              Future<void>.delayed(
                const Duration(milliseconds: 120),
                () => throw TimeoutException('sync worker never returned'),
              );
            },
          ),

          _tile(
            'Framework error',
            'Thrown during build; caught by FlutterError.onError.',
            () {
              _say('Rendering a widget that throws…');
              showDialog<void>(
                context: context,
                builder: (_) => const _ExplodingWidget(),
              );
            },
          ),

          _tile(
            'Isolate crash',
            'Background isolate dies; reported via Sentrinel.isolateErrorPort.',
            () async {
              _say('Spawning a doomed isolate…');
              // The onError port is the whole trick: Isolate.spawn does not
              // inherit the spawner's error listeners, so without it the worker
              // dies to stderr and the dashboard shows nothing at all.
              await Isolate.spawn(
                _doomedIsolate,
                'fieldops',
                onError: isolateErrorPort,
              );
            },
          ),

          _section('Performance'),

          _tile(
            'Jank the main thread',
            'A 1.2s busy loop — produces slow and frozen frames.',
            () {
              _say('Blocking the UI thread…');
              final until = DateTime.now().add(const Duration(milliseconds: 1200));
              // Deliberately synchronous: this is the whole point.
              while (DateTime.now().isBefore(until)) {}
              final f = SentrinelFlutter.frames;
              _say('Done. frames total=${f?.totalFrames} '
                  'slow=${f?.slowFrames} frozen=${f?.frozenFrames}');
            },
          ),

          _tile(
            'Report frame stats',
            'Reads the tracker without causing jank.',
            () {
              final f = SentrinelFlutter.frames;
              final stats = 'total=${f?.totalFrames} slow=${f?.slowFrames} '
                  'frozen=${f?.frozenFrames}';
              Sentrinel.info('frame stats', category: 'perf', attributes: {'stats': stats});
              _say(stats);
            },
          ),

          _section('Backend failures'),

          _tile(
            'Slow request (2.5s)',
            'Trips the backend slow-request threshold.',
            () => _call('slow', () => _api.slow(2500)),
          ),

          _tile(
            'Flaky request (80% fail)',
            'Mostly 503s — good for the error-rate chart.',
            () => _call('flaky', () => _api.flaky(0.8)),
          ),

          _tile(
            'Server 500',
            'Throws for real on the backend; rotates through four error classes.',
            () => _call('boom', () => _api.boom()),
          ),

          _tile(
            'Log storm (60 lines)',
            'Backend emits at every level, for the Logs page filters.',
            () => _call('logstorm', () => _api.logStorm(60)),
          ),

          _section('Local logs'),

          _tile(
            'Emit all four levels',
            'debug, info, warn, error — from the device.',
            () {
              Sentrinel.debug('diagnostic debug line', category: 'diag');
              Sentrinel.info('diagnostic info line', category: 'diag');
              Sentrinel.warn('diagnostic warning line', category: 'diag');
              Sentrinel.error('diagnostic error line', category: 'diag');
              _say('Four log records queued.');
            },
          ),

          _tile(
            'Flush now',
            'Force a send rather than waiting for the interval.',
            () async {
              await Sentrinel.flush();
              _say('Flushed.');
            },
          ),

          const SizedBox(height: 24),
          Card(
            child: Padding(
              padding: const EdgeInsets.all(12),
              child: Text(_log),
            ),
          ),
        ],
      ),
    );
  }

  Future<void> _call(String label, Future<void> Function() fn) async {
    _say('$label…');
    try {
      await fn();
      _say('$label: ok');
    } catch (err) {
      _say('$label: $err');
    }
  }

  Widget _section(String title) => Padding(
        padding: const EdgeInsets.only(top: 20, bottom: 8),
        child: Text(title, style: Theme.of(context).textTheme.titleMedium),
      );

  Widget _tile(String title, String subtitle, VoidCallback onTap) => Card(
        child: ListTile(
          title: Text(title),
          subtitle: Text(subtitle),
          trailing: const Icon(Icons.play_arrow),
          onTap: () {
            Sentrinel.addBreadcrumb('diagnostic: $title', category: 'ui.diag');
            onTap();
          },
        ),
      );
}

/// Throws during build, which is what FlutterError.onError is for.
class _ExplodingWidget extends StatelessWidget {
  const _ExplodingWidget();

  @override
  Widget build(BuildContext context) {
    throw StateError('RenderFailure: exploding widget built on purpose');
  }
}

/// Runs on a background isolate and dies there.
void _doomedIsolate(String label) {
  throw StateError('IsolateFailure: background worker for $label crashed');
}
