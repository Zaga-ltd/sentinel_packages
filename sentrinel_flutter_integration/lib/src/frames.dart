/// Frame timings — the difference between "the app works" and "the app is nice
/// to use".
///
/// A crash-free release that drops a third of its frames during checkout is
/// still a bad release, and nothing in error reporting will ever tell you so.
library;

import 'package:flutter/foundation.dart';
import 'package:flutter/scheduler.dart';
import 'package:sentrinel/sentrinel.dart';

/// The 60Hz budget — used when the display's refresh rate cannot be read.
///
/// A phone at 90 or 120Hz has a stricter budget, and a frame that misses it
/// is a visible stutter on that screen even if it would have been fine at
/// 60Hz. So the budget is taken from the display when it can be read.
const int kDefaultFrameBudgetMs = 16;

/// Past this the app has visibly stopped responding, not merely stuttered.
/// Matches the threshold Android's own tooling uses.
const int kFrozenFrameMs = 700;

/// The frame budget of the primary display, in milliseconds, or null.
///
/// Read through `dynamic`: `PlatformDispatcher.displays` does not exist on
/// every Flutter this package supports, and the answer on those is "unknown",
/// not a compile error.
double? displayFrameBudgetMs() {
  try {
    final displays = (PlatformDispatcher.instance as dynamic).displays as Iterable;
    if (displays.isEmpty) return null;
    final rate = ((displays.first as dynamic).refreshRate as num).toDouble();
    // A headless engine reports 0; anything under 30Hz is not a real screen
    // rate and would make every frame look fast.
    if (rate < 30 || rate > 500) return null;
    return 1000 / rate;
  } catch (_) {
    return null;
  }
}

/// Watches frame build+raster times and reports how many missed their budget.
///
/// Reported as a rolling summary rather than one record per frame: a 60fps app
/// produces 3,600 frames a minute, and shipping that would cost more battery
/// and bandwidth than the insight is worth.
class FrameTracker {
  /// [budgetMs] overrides the display's budget; leave it null to use the
  /// screen's refresh rate (16ms if it cannot be read).
  FrameTracker({
    num? budgetMs,
    this.reportEvery = const Duration(minutes: 1),
  }) : budgetMs = budgetMs?.toDouble() ?? displayFrameBudgetMs() ?? kDefaultFrameBudgetMs.toDouble();

  final double budgetMs;
  final Duration reportEvery;

  int _total = 0;
  int _slow = 0;
  int _frozen = 0;
  DateTime _windowStart = DateTime.now();
  bool _started = false;

  int get totalFrames => _total;
  int get slowFrames => _slow;
  int get frozenFrames => _frozen;

  void start() {
    if (_started) return;
    _started = true;
    SchedulerBinding.instance.addTimingsCallback(_onTimings);
  }

  void stop() {
    if (!_started) return;
    _started = false;
    SchedulerBinding.instance.removeTimingsCallback(_onTimings);
  }

  void _onTimings(List<FrameTiming> timings) {
    for (final t in timings) {
      _classify(t);
    }
    if (DateTime.now().difference(_windowStart) >= reportEvery) flushWindow();
  }

  void _classify(FrameTiming t) {
    _total++;
    // Build + raster is what the user waits for; either alone understates it.
    // Microseconds, because a 120Hz budget is 8.3ms and whole milliseconds
    // would round a missed frame into a met one.
    final ms = t.totalSpan.inMicroseconds / 1000.0;
    if (ms >= kFrozenFrameMs) {
      _frozen++;
    } else if (ms > budgetMs) {
      _slow++;
    }
  }

  /// Feed one timing directly.
  ///
  /// Frame callbacks only fire for frames the engine actually renders, so
  /// asserting on real ones would make this a timing test — slow on a loaded
  /// machine, flaky on a fast one, and unable to produce a 900ms frozen frame
  /// on demand at all.
  @visibleForTesting
  void consumeForTest(FrameTiming timing) => _classify(timing);

  /// Emit the current window and start a new one. Public so a host app can
  /// report on backgrounding, where the next timer tick may never come.
  void flushWindow() {
    if (_total == 0) {
      _windowStart = DateTime.now();
      return;
    }
    Sentrinel.log('info', 'frame timings', category: 'performance', attributes: {
      'frames.total': _total,
      'frames.slow': _slow,
      'frames.frozen': _frozen,
      'frames.slow_pct': ((_slow / _total) * 100).toStringAsFixed(2),
      'frames.frozen_pct': ((_frozen / _total) * 100).toStringAsFixed(2),
      'frames.budget_ms': double.parse(budgetMs.toStringAsFixed(2)),
      'window.seconds': DateTime.now().difference(_windowStart).inSeconds,
    });
    _total = 0;
    _slow = 0;
    _frozen = 0;
    _windowStart = DateTime.now();
  }
}
