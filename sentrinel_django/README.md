# sentrinel-django

Sentrinel for Django. One middleware, and every request, error and log line
reaches your dashboard — correlated, so a log line opens the request that wrote
it and an error opens the user it happened to.

Tested on **Django 3.1 through 5.2**, Python 3.8+. No runtime dependencies.

```bash
pip install sentrinel-django
```

```python
# settings.py
MIDDLEWARE = [
    "sentrinel_django.SentrinelMiddleware",   # first: it measures what the user waited
    "django.middleware.security.SecurityMiddleware",
    ...
]

SENTRINEL = {
    "SERVER_URL": "https://api.sentrinel.dev",
    "APP_NAME": "orders",
    "ENV": "prod",
    "API_KEY": os.environ["SENTRINEL_API_KEY"],   # a Server key
}
```

That is the whole setup. Full reference, including logs, custom metrics and
masking: <https://docs.sentrinel.dev/reference/django/>
