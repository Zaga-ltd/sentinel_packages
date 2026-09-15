// Jobs — the list, and the detail screen where the interesting write paths
// live. Completing a job is the deep trace: mobile tap -> backend request ->
// stock reservation -> invoice -> outbound notification, all on one waterfall.

import 'package:flutter/material.dart';
import 'package:sentrinel/sentrinel.dart';

import '../api_client.dart';

class JobsScreen extends StatefulWidget {
  const JobsScreen({super.key});

  @override
  State<JobsScreen> createState() => _JobsScreenState();
}

class _JobsScreenState extends State<JobsScreen> {
  final _api = FieldOpsApi();

  List<dynamic> _jobs = const [];
  String? _status;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _loading = true);
    try {
      final jobs = await _api.workOrders(status: _status);
      if (!mounted) return;
      setState(() {
        _jobs = jobs;
        _loading = false;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Jobs'),
        bottom: PreferredSize(
          preferredSize: const Size.fromHeight(52),
          child: SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            padding: const EdgeInsets.symmetric(horizontal: 8),
            child: Row(
              children: [
                for (final s in [null, 'draft', 'scheduled', 'in_progress', 'completed'])
                  Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 4),
                    child: ChoiceChip(
                      label: Text(s ?? 'all'),
                      selected: _status == s,
                      onSelected: (_) {
                        Sentrinel.addBreadcrumb('filter jobs: ${s ?? "all"}',
                            category: 'ui.filter');
                        setState(() => _status = s);
                        _load();
                      },
                    ),
                  ),
              ],
            ),
          ),
        ),
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : RefreshIndicator(
              onRefresh: _load,
              child: ListView.separated(
                itemCount: _jobs.length,
                separatorBuilder: (_, _) => const Divider(height: 1),
                itemBuilder: (context, i) {
                  final job = _jobs[i] as Map<String, dynamic>;
                  return ListTile(
                    title: Text('${job['title']}'),
                    subtitle: Text('${job['status']} · ${job['priority']}'),
                    trailing: const Icon(Icons.chevron_right),
                    onTap: () {
                      Sentrinel.addBreadcrumb('open job ${job['id']}', category: 'ui.nav');
                      Navigator.of(context).push(
                        MaterialPageRoute(
                          settings: const RouteSettings(name: '/job-detail'),
                          builder: (_) => JobDetailScreen(job: job),
                        ),
                      );
                    },
                  );
                },
              ),
            ),
    );
  }
}

class JobDetailScreen extends StatefulWidget {
  const JobDetailScreen({super.key, required this.job});

  final Map<String, dynamic> job;

  @override
  State<JobDetailScreen> createState() => _JobDetailScreenState();
}

class _JobDetailScreenState extends State<JobDetailScreen> {
  final _api = FieldOpsApi();
  String _log = '';
  bool _busy = false;

  Future<void> _run(String label, Future<void> Function() action) async {
    setState(() {
      _busy = true;
      _log = '$label…';
    });
    Sentrinel.addBreadcrumb(label, category: 'ui.action');
    try {
      await action();
      if (!mounted) return;
      setState(() => _log = '$label: ok');
    } catch (err) {
      // The API client already captured this as a non-fatal with its status
      // code and path; here we only decide what the screen says.
      if (!mounted) return;
      setState(() => _log = '$label failed: $err');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final id = '${widget.job['id']}';

    return Scaffold(
      appBar: AppBar(title: Text('${widget.job['title']}')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Text('id  $id'),
          Text('status  ${widget.job['status']}'),
          Text('priority  ${widget.job['priority']}'),
          const SizedBox(height: 20),

          FilledButton.icon(
            onPressed: _busy ? null : () => _run('start job', () => _api.startJob(id)),
            icon: const Icon(Icons.play_arrow),
            label: const Text('Start job'),
          ),
          const SizedBox(height: 8),

          // The deep trace. No parts, so it always succeeds.
          FilledButton.icon(
            onPressed: _busy
                ? null
                : () => _run('complete job', () => _api.completeJob(id, labourMinutes: 90)),
            icon: const Icon(Icons.check_circle),
            label: const Text('Complete (labour only)'),
          ),
          const SizedBox(height: 8),

          // Same path, but asking for stock that is not there — this is the one
          // that produces a grouped InsufficientStock issue on the backend.
          FilledButton.tonalIcon(
            onPressed: _busy
                ? null
                : () => _run(
                      'complete with parts',
                      () => _api.completeJob(id, partsUsed: [
                        {'partId': 'part_missing', 'qty': 9999},
                      ]),
                    ),
            icon: const Icon(Icons.warning_amber),
            label: const Text('Complete with impossible parts'),
          ),
          const SizedBox(height: 8),

          OutlinedButton.icon(
            onPressed: _busy
                ? null
                : () => _run('add note', () => _api.addNote(id, 'Checked unit, replaced filter')),
            icon: const Icon(Icons.note_add),
            label: const Text('Add note'),
          ),
          const SizedBox(height: 8),

          OutlinedButton.icon(
            onPressed:
                _busy ? null : () => _run('upload photo', () => _api.uploadPhoto(id, 400)),
            icon: const Icon(Icons.photo_camera),
            label: const Text('Upload 400KB photo'),
          ),
          const SizedBox(height: 8),

          OutlinedButton.icon(
            onPressed: _busy
                ? null
                : () => _run('oversized photo', () => _api.uploadPhoto(id, 2600)),
            icon: const Icon(Icons.photo_size_select_large),
            label: const Text('Upload 2.6MB photo (rejected)'),
          ),

          const SizedBox(height: 20),
          if (_log.isNotEmpty)
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
}
