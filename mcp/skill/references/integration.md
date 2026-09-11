# Adding Sentrinel to an application

Shapes, invariants, and where the authoritative version lives. Nothing here is
a substitute for the docs: if a detail matters and you are not certain, read
the page linked at the end of the section rather than guessing an option name.
Inventing a config key produces a silent no-op, which is the worst possible
failure for monitoring.

Two rules hold for every platform:

- **The key goes in the environment**, never in source, never in a commit,
  never in a snippet you paste back to the user. See
  [keys.md](keys.md) for which kind to ask for.
- **`appName` and `env` must match what the key was issued for.** Ingest checks
  them and answers `403` on a mismatch. The SDK reports that once at startup
  and then goes quiet, so a wrong `env` looks exactly like "monitoring is fine,
  we just have no traffic."

## JavaScript and TypeScript

Installed from the public repo — not npm:

```bash
bun add "@sentrinel/plugin@github:Zaga-ltd/sentinel_packages"
```

Elysia:

```ts
import { sentrinelPlugin } from "@sentrinel/plugin";

new Elysia().use(
  sentrinelPlugin({
    serverUrl: "https://api.sentrinel.dev",
    appName: "my-api",
    env: process.env.NODE_ENV ?? "dev",
    apiKey: process.env.SENTRINEL_API_KEY,
  })
);
```

Express, Next.js and Bun are the same options behind a different entry point —
`@sentrinel/plugin/express` (`sentrinelExpressMiddleware`),
`@sentrinel/plugin/next` (`sentrinelNextMiddleware`, and `withSentrinel` for
`next.config`), `@sentrinel/plugin/bun` (`sentrinelBunMiddleware`).

Request logging is sampled; errors and slow requests are always kept. Bodies
are off until you turn them on, and sensitive headers are masked either way.

→ <https://docs.sentrinel.dev/reference/plugin/> and
<https://docs.sentrinel.dev/reference/config/>

## Browsers

The browser never holds a key. It posts to your own origin, and a tunnel route
on your server forwards it with the key attached:

```ts
import { initSentrinelBrowser } from "@sentrinel/plugin/browser";
initSentrinelBrowser({ endpoint: "/api/sentrinel", release: "2026.8.2" });
```

```ts
import { createSentrinelTunnel } from "@sentrinel/plugin/tunnel";
export const POST = createSentrinelTunnel({
  serverUrl: "https://api.sentrinel.dev",
  appName: "admin",
  env: "prod",
  apiKey: process.env.SENTRINEL_API_KEY!, // stays on the server
});
```

If you are about to put a key in client-side code, stop: that is what the
tunnel exists to avoid.

→ <https://docs.sentrinel.dev/reference/browser/>

## Django

No runtime dependencies; Django 3.1–5.2 on Python 3.8+.

```bash
pip install "git+https://github.com/Zaga-ltd/sentinel_packages.git#subdirectory=sentrinel_django"
```

```python
MIDDLEWARE = ["sentrinel_django.SentrinelMiddleware", ...]  # first

SENTRINEL = {
    "SERVER_URL": "https://api.sentrinel.dev",
    "APP_NAME": "orders",
    "ENV": "prod",
    "API_KEY": os.environ["SENTRINEL_API_KEY"],
}
```

**First in `MIDDLEWARE`**, deliberately: the middleware measures from where it
sits, so placed last it reports handler time and under-reports every request
that a slow middleware made slow. The build image needs `git` for that pip URL,
which many slim Python images lack.

Logs arrive correlated with their request by adding
`sentrinel_django.SentrinelLogHandler` to `LOGGING`.

→ <https://docs.sentrinel.dev/reference/django/>

## Flutter and Dart

```yaml
dependencies:
  sentrinel_flutter:
    git:
      url: https://github.com/Zaga-ltd/sentinel_packages
      path: sentrinel_flutter_integration
```

```dart
void main() => SentrinelFlutter.run(
      options: SentrinelOptions(
        serverUrl: 'https://api.sentrinel.dev',
        appName: 'mobile-app',
        env: 'prod',
        release: '1.4.2',
        apiKey: const String.fromEnvironment('SENTRINEL_API_KEY'),
      ),
      app: () => runApp(const MyApp()),
    );
```

Two things that are easy to get wrong and expensive to miss:

- **`runApp` goes inside the `app` callback.** Async errors are caught only
  within the guarded zone; calling `runApp` after the `run` call silently
  misses most of them.
- **`release` is required for crash-free rate**, which is per release. Without
  it every build is `unknown` and a regression is invisible.

A pure Dart CLI or server uses the `sentrinel` core package instead (path
`sentrinel_flutter`), which has no Flutter dependency. Native iOS and Android
have `sentrinel_swift` and `sentrinel_kotlin`.

→ <https://docs.sentrinel.dev/reference/mobile/>

## Postgres

A collector runs next to the database, not inside the app, and needs a
**database collector** key:

```bash
curl -fsSL https://sentrinel.dev/install-collector.sh | sudo bash
```

`pg_stat_statements` is what makes per-query aggregates possible; without it
you still get activity, waits, blocking and table stats.

→ <https://docs.sentrinel.dev/reference/database/>

## When nothing shows up

In order, because this is nearly always one of the first three:

1. **The key kind is wrong** for the integration, or `appName`/`env` do not
   match what it was issued for — a `403` the SDK reports once at startup.
2. **`serverUrl` is wrong** — pointing at localhost in a deployed app is the
   usual version.
3. **The middleware or plugin is not actually installed** on the running build
   (added to the wrong app instance, or not redeployed).
4. Only then look at sampling, filters, or the time window in the dashboard.

→ <https://docs.sentrinel.dev/reference/troubleshooting/>
