// ─── FieldOps technician app ─────────────────────────────────────────────────
//
// The Flutter half of the Sentrinel end-to-end demo. Every SDK feature is wired
// here rather than sprinkled through the screens, so this file doubles as the
// integration reference:
//
//   * SentrinelFlutter.run   — one call: guarded zone, error handlers, app
//                              start and frame tracking, crash persistence
//   * navigatorObservers     — every route change becomes a breadcrumb, and
//                              sets the `screen` field on later records
//   * Sentrinel.setContext   — fields attached to everything after it
//   * Sentrinel.httpClient   — in api_client.dart; propagates traceparent
//
// Run it:
//   flutter run --dart-define=SENTRINEL_KEY=snt_dev_… \
//               --dart-define=SENTRINEL_URL=http://localhost:3001 \
//               --dart-define=FIELDOPS_API=http://localhost:4400

import 'package:flutter/material.dart';
import 'package:sentrinel_flutter/sentrinel_flutter.dart';

import 'config.dart';
import 'screens/home_screen.dart';
import 'screens/jobs_screen.dart';
import 'screens/parts_screen.dart';
import 'screens/diagnostics_screen.dart';

Future<void> main() async {
  await SentrinelFlutter.run(
    // Not const: the key resolves to null rather than empty when unset.
    options: SentrinelOptions(
      serverUrl: Config.sentrinelUrl,
      appName: Config.appName,
      env: Config.env,
      apiKey: Config.apiKey,
      module: Config.module,
      release: Config.release,
      // The FALLBACK, used before anyone signs in and again after they sign
      // out. A person is named by identify() below — set this to a user id and
      // never call identify(), and the Consumers page lists devices instead of
      // people.
      consumerIdentifier: 'fieldops_${Config.env}',
      // Two seconds so a demo run appears in the dashboard while you are still
      // looking at it. Ship the 30s default.
      flushInterval: const Duration(seconds: 2),
      trackFrames: true,
      trackAppStart: true,
    ),
    app: () {
      // Attached to every record from here on — the crash report from a screen
      // that has never heard of a technician still carries their id.
      // This demo has no login screen, so it identifies at startup. A real app
      // calls this wherever its sign-in succeeds — that one call is what makes
      // the Consumers page list people rather than platforms.
      Sentrinel.identify(Config.technicianId);

      Sentrinel.setContext({
        'technician.id': Config.technicianId,
        'app.release': Config.release,
        'app.flavour': 'demo',
      });
      Sentrinel.info('app booted', category: 'lifecycle', attributes: {
        'backend': Config.backendUrl,
      });

      runApp(const FieldOpsApp());
    },
  );
}

class FieldOpsApp extends StatelessWidget {
  const FieldOpsApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'FieldOps',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xFF0F766E)),
        useMaterial3: true,
      ),
      // Route changes become breadcrumbs, and stamp `screen` on every record
      // written afterwards — so a crash says which screen it happened on.
      navigatorObservers: [SentrinelNavigatorObserver()],
      home: const RootShell(),
    );
  }
}

class RootShell extends StatefulWidget {
  const RootShell({super.key});

  @override
  State<RootShell> createState() => _RootShellState();
}

class _RootShellState extends State<RootShell> {
  int _index = 0;

  static const _tabs = <String>['Home', 'Jobs', 'Parts', 'Diagnostics'];

  final _screens = const [
    HomeScreen(),
    JobsScreen(),
    PartsScreen(),
    DiagnosticsScreen(),
  ];

  void _onTap(int i) {
    Sentrinel.addBreadcrumb('tab -> ${_tabs[i]}', category: 'ui.tab');
    Sentrinel.setContext({'screen': _tabs[i]});
    setState(() => _index = i);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: IndexedStack(index: _index, children: _screens),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _index,
        onDestinationSelected: _onTap,
        destinations: const [
          NavigationDestination(icon: Icon(Icons.dashboard_outlined), label: 'Home'),
          NavigationDestination(icon: Icon(Icons.assignment_outlined), label: 'Jobs'),
          NavigationDestination(icon: Icon(Icons.inventory_2_outlined), label: 'Parts'),
          NavigationDestination(icon: Icon(Icons.bug_report_outlined), label: 'Diagnostics'),
        ],
      ),
    );
  }
}
