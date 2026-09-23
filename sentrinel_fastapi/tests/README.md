# Running the tests

```bash
python -m venv .venv && .venv/bin/pip install -e ".[dev]"
.venv/bin/python -m pytest tests/ -q
```

The suite runs against the **oldest and newest supported FastAPI** before every
release:

```bash
pip install "fastapi==0.100.1" "httpx<0.28" && python -m pytest tests/ -q
pip install -U fastapi httpx && python -m pytest tests/ -q
```

`test_shared_core.py` checks that the modules shared with the Django SDK are
identical to its copies. Those modules are edited in `sentrinel_django` and
copied here with `python3 scripts/sync-python-core.py` from the monorepo root.
