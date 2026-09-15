// Parts — inventory, and the reserve action. Reserving more than is available
// throws on the backend and comes back as a 500, so this screen is the easiest
// way to put a real grouped issue in front of yourself.

import 'package:flutter/material.dart';
import 'package:sentrinel/sentrinel.dart';

import '../api_client.dart';

class PartsScreen extends StatefulWidget {
  const PartsScreen({super.key});

  @override
  State<PartsScreen> createState() => _PartsScreenState();
}

class _PartsScreenState extends State<PartsScreen> {
  final _api = FieldOpsApi();

  List<dynamic> _parts = const [];
  bool _lowStockOnly = false;
  bool _loading = true;
  String? _message;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _loading = true);
    try {
      final parts = await _api.parts(lowStock: _lowStockOnly);
      if (!mounted) return;
      setState(() {
        _parts = parts;
        _loading = false;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() => _loading = false);
    }
  }

  Future<void> _reserve(Map<String, dynamic> part, int qty) async {
    Sentrinel.addBreadcrumb('reserve ${part['sku']} x$qty', category: 'ui.action');
    try {
      await _api.reservePart('${part['id']}', qty);
      if (!mounted) return;
      setState(() => _message = 'Reserved $qty × ${part['sku']}');
      _load();
    } catch (err) {
      if (!mounted) return;
      setState(() => _message = 'Failed: $err');
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Parts'),
        actions: [
          Row(
            children: [
              const Text('Low only'),
              Switch(
                value: _lowStockOnly,
                onChanged: (v) {
                  setState(() => _lowStockOnly = v);
                  _load();
                },
              ),
            ],
          ),
        ],
      ),
      body: Column(
        children: [
          if (_message != null)
            Padding(
              padding: const EdgeInsets.all(12),
              child: Text(_message!),
            ),
          Expanded(
            child: _loading
                ? const Center(child: CircularProgressIndicator())
                : ListView.separated(
                    itemCount: _parts.length,
                    separatorBuilder: (_, _) => const Divider(height: 1),
                    itemBuilder: (context, i) {
                      final part = _parts[i] as Map<String, dynamic>;
                      final onHand = (part['onHand'] ?? 0) as int;
                      final reserved = (part['reserved'] ?? 0) as int;
                      return ListTile(
                        title: Text('${part['name']}  ·  ${part['sku']}'),
                        subtitle: Text('on hand $onHand · reserved $reserved'),
                        trailing: Wrap(
                          spacing: 4,
                          children: [
                            OutlinedButton(
                              onPressed: () => _reserve(part, 1),
                              child: const Text('+1'),
                            ),
                            // Guaranteed to exceed stock — the whole point.
                            OutlinedButton(
                              onPressed: () => _reserve(part, 100000),
                              child: const Text('100k'),
                            ),
                          ],
                        ),
                      );
                    },
                  ),
          ),
        ],
      ),
    );
  }
}
