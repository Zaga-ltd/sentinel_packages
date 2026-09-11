# Running the tests

No test runner config to install — Django is configured in `conftest.py`.

```bash
python -m venv .venv && .venv/bin/pip install -e ".[dev]"
.venv/bin/python -m pytest tests/ -q
```

The suite is run against the **oldest and newest supported Django** before every
release, because the whole point of having no dependencies is working on the
version a project is already stuck on:

```bash
pip install "django==3.1.1" && python -m pytest tests/ -q
pip install "django>=5.2"  && python -m pytest tests/ -q
```
