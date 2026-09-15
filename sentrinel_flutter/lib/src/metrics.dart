/// Custom metrics: the numbers only your app knows.
///
/// Videos watched, items added to a cart, seconds of buffering, tokens spent.
/// Tracing says why a call was slow; it cannot say how much of something
/// happened, because nothing in a span is a number you asked to be summed.
///
/// An increment does not touch the network. It mutates a map, and the whole map
/// folds into one row per series per flush — which is what makes [count] safe
/// to call in a build method or a scroll listener. On a phone that matters more
/// than on a server: a metric that cost a request would cost battery.
///
/// Mirrors the registries in `@sentrinel/plugin` and `sentrinel-django`,
/// including their caps, because a metric recorded from an app and from a
/// backend must mean the same thing and fold the same way — otherwise the chart
/// adds up two different things.
library;

import 'dart:convert';
import 'dart:math';

const int kMaxMetricName = 128;
const int kMaxLabelKeys = 12;
const int kMaxLabelValue = 128;

/// Distinct series held at once. Past this, new series are dropped rather than
/// growing without bound — a process that has invented thousands of series has
/// a label bug, usually an id where a category belongs.
const int kMaxSeries = 2000;

/// Raw values kept per histogram, for percentiles. Past this, samples are
/// replaced with decreasing probability so a percentile over a long window
/// stays representative instead of describing the first few seconds.
const int kMaxSamples = 512;

/// Sorted, so `{a,b}` and `{b,a}` are one series.
///
/// Without this, the same metric recorded from two call sites that happened to
/// write the keys in a different order charts as two unrelated lines, and
/// nothing tells you why the total is split in half.
String canonicalLabels(Map<String, Object?>? labels) {
  if (labels == null || labels.isEmpty) return '{}';
  final keys = labels.keys.toList()..sort();
  final out = <String, String>{};
  for (final key in keys.take(kMaxLabelKeys)) {
    final value = labels[key];
    if (value == null) continue;
    final text = value.toString();
    out[key] = text.length > kMaxLabelValue ? text.substring(0, kMaxLabelValue) : text;
  }
  return jsonEncode(out);
}

double _percentile(List<double> sorted, double q) {
  if (sorted.isEmpty) return 0;
  final idx = min(sorted.length - 1, max(0, (q * sorted.length).ceil() - 1));
  return sorted[idx];
}

class _Series {
  _Series(this.name, this.kind, this.labels, this.unit, double first)
      : min = first,
        max = first,
        last = first;

  final String name;
  final String kind;
  final String labels;
  String? unit;
  int count = 0;
  double sum = 0;
  double min;
  double max;
  double last;
  final List<double> samples = [];

  /// Total observations, so reservoir sampling stays uniform past [kMaxSamples].
  int seen = 0;
}

class MetricRegistry {
  final Map<String, _Series> _series = {};
  final Random _random = Random();

  /// Series dropped because [kMaxSeries] was reached. Surfaced for diagnostics.
  int droppedSeries = 0;

  int get size => _series.length;

  void record(
    String name,
    String kind,
    num value, {
    Map<String, Object?>? labels,
    String? unit,
  }) {
    if (name.trim().isEmpty) return;
    final v = value.toDouble();
    // NaN and Infinity would poison the sum for the whole window, and every
    // chart drawn from it afterwards.
    if (v.isNaN || v.isInfinite) return;

    var clean = name.trim();
    if (clean.length > kMaxMetricName) clean = clean.substring(0, kMaxMetricName);

    final canon = canonicalLabels(labels);
    final key = '$clean $kind $canon';

    var entry = _series[key];
    if (entry == null) {
      if (_series.length >= kMaxSeries) {
        droppedSeries++;
        return;
      }
      entry = _Series(clean, kind, canon, unit, v);
      _series[key] = entry;
    }

    entry.count++;
    entry.sum += v;
    entry.last = v;
    if (v < entry.min) entry.min = v;
    if (v > entry.max) entry.max = v;
    if (unit != null && entry.unit == null) entry.unit = unit;

    if (kind == 'histogram') {
      entry.seen++;
      if (entry.samples.length < kMaxSamples) {
        entry.samples.add(v);
      } else {
        final j = _random.nextInt(entry.seen);
        if (j < kMaxSamples) entry.samples[j] = v;
      }
    }
  }

  /// Take everything buffered and reset.
  ///
  /// Gauges reset with the rest: a gauge that stops being reported should leave
  /// a gap in the chart rather than a flat line implying its last value is
  /// still true.
  List<Map<String, dynamic>> drain(DateTime now) {
    if (_series.isEmpty) return const [];
    final timestamp = now.toUtc().toIso8601String();
    final out = <Map<String, dynamic>>[];
    for (final s in _series.values) {
      final sorted = List<double>.from(s.samples)..sort();
      out.add({
        'name': s.name,
        'kind': s.kind,
        'labels': s.labels,
        if (s.unit != null) 'unit': s.unit,
        'count': s.count,
        'sum': s.sum,
        'min': s.min,
        'max': s.max,
        'last': s.last,
        'p50': _percentile(sorted, 0.50),
        'p95': _percentile(sorted, 0.95),
        'p99': _percentile(sorted, 0.99),
        'timestamp': timestamp,
      });
    }
    _series.clear();
    return out;
  }
}
