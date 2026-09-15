// Smoke tests for the demo app shell.
//
// These do not talk to the backend — the screens fail their loads against a
// dead host and render their error state, which is itself worth asserting: a
// technician on a bad connection should get a screen, not a white void.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:fieldops_mobile/main.dart';

void main() {
  testWidgets('shell renders all four tabs', (WidgetTester tester) async {
    await tester.pumpWidget(const FieldOpsApp());
    await tester.pump();

    expect(find.text('Home'), findsWidgets);
    expect(find.text('Jobs'), findsWidgets);
    expect(find.text('Parts'), findsWidgets);
    expect(find.text('Diagnostics'), findsWidgets);
  });

  testWidgets('diagnostics tab lists its failure levers', (WidgetTester tester) async {
    await tester.pumpWidget(const FieldOpsApp());
    await tester.pump();

    await tester.tap(find.byIcon(Icons.bug_report_outlined));
    await tester.pump();

    expect(find.text('Non-fatal error'), findsOneWidget);
    expect(find.text('Fatal error (persisted)'), findsOneWidget);

    // The performance levers are below the fold, and the ListView builds
    // lazily — scroll before asserting or the finder sees nothing.
    await tester.scrollUntilVisible(find.text('Jank the main thread'), 200);
    expect(find.text('Jank the main thread'), findsOneWidget);
  });
}
