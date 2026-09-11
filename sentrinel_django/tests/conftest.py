"""Django just configured enough to exercise the middleware."""

import django
from django.conf import settings

if not settings.configured:
    settings.configure(
        DEBUG=False,
        SECRET_KEY="test-only",
        ALLOWED_HOSTS=["*"],
        DATABASES={},
        INSTALLED_APPS=["django.contrib.contenttypes", "django.contrib.auth"],
        MIDDLEWARE=[],
        ROOT_URLCONF="tests.urls",
        USE_TZ=True,
    )
    django.setup()
