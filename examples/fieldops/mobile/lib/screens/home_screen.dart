// Home — the cold-start path. One bootstrap call, plus the numbers a
// technician sees first. Pull-to-refresh re-runs it, which is an easy way to
// generate repeat traffic on a real trace.

import 'package:flutter/material.dart';
import 'package:sentrinel/sentrinel.dart';

import '../api_client.dart';
import '../config.dart';

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  final _api = FieldOpsApi();

  Map<String, dynamic>? _bootstrap;
  Map<String, dynamic>? _summary;
  List<dynamic> _notifications = const [];
  String? _error;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });

    try {
      // Three calls on one screen: each is its own trace, and each shows up in
      // the backend's endpoint table.
      final results = await Future.wait([
        _api.bootstrap(),
        _api.analyticsSummary(),
        _api.notifications(),
      ]);

      if (!mounted) return;
      setState(() {
        _bootstrap = results[0] as Map<String, dynamic>;
        _summary = results[1] as Map<String, dynamic>;
        _notifications = results[2] as List<dynamic>;
        _loading = false;
      });
    } catch (err, stack) {
      // Already reported by the client as a non-fatal; this only decides what
      // the screen shows.
      Sentrinel.warn('home failed to load', category: 'ui', attributes: {
        'error': err.toString(),
      });
      if (!mounted) return;
      setState(() {
        _error = err.toString();
        _loading = false;
      });
      debugPrint('$stack');
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('FieldOps'),
        actions: [
          IconButton(onPressed: _load, icon: const Icon(Icons.refresh)),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: _load,
        child: _loading
            ? const Center(child: CircularProgressIndicator())
            : ListView(
                padding: const EdgeInsets.all(16),
                children: [
                  if (_error != null)
                    Card(
                      color: Theme.of(context).colorScheme.errorContainer,
                      child: Padding(
                        padding: const EdgeInsets.all(12),
                        child: Text('Could not reach the backend:\n$_error'),
                      ),
                    ),
                  Card(
                    child: ListTile(
                      title: Text(Config.technicianId),
                      subtitle: Text(
                        'release ${Config.release} · env ${Config.env}',
                      ),
                      leading: const CircleAvatar(child: Icon(Icons.person)),
                    ),
                  ),
                  const SizedBox(height: 12),
                  if (_summary != null)
                    Row(
                      children: [
                        _stat('Open jobs', '${_summary!['openJobs'] ?? '—'}'),
                        const SizedBox(width: 12),
                        _stat('Low stock', '${_summary!['lowStockParts'] ?? '—'}'),
                      ],
                    ),
                  const SizedBox(height: 12),
                  if (_bootstrap != null)
                    Card(
                      child: ListTile(
                        title: const Text('My schedule'),
                        subtitle: Text(
                          '${(_bootstrap!['jobs'] as List?)?.length ?? 0} jobs assigned',
                        ),
                        leading: const Icon(Icons.event_note),
                      ),
                    ),
                  const SizedBox(height: 12),
                  Text('Notifications', style: Theme.of(context).textTheme.titleMedium),
                  for (final n in _notifications)
                    ListTile(
                      dense: true,
                      leading: Icon(
                        n['read'] == true ? Icons.mark_email_read : Icons.mark_email_unread,
                      ),
                      title: Text('${n['body']}'),
                      subtitle: Text('${n['kind']}'),
                    ),
                ],
              ),
      ),
    );
  }

  Widget _stat(String label, String value) => Expanded(
        child: Card(
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(value, style: Theme.of(context).textTheme.headlineMedium),
                Text(label, style: Theme.of(context).textTheme.bodySmall),
              ],
            ),
          ),
        ),
      );
}
