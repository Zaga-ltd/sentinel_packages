/// Keeping URLs' secrets out of telemetry.
///
/// Query strings are where tokens, emails and one-time codes live —
/// `?token=…`, `?email=…`, `?code=…` — and userinfo is a password by
/// definition. A span attribute or an error message is kept for weeks and read
/// by everyone with dashboard access, so none of that belongs in one. Stripped
/// by default; an app that wants something back can add it in `beforeSend`
/// from its own, safer source.
library;

/// `scheme://host[:port]/path` — no userinfo, query or fragment.
String sanitizeUrl(Uri url) {
  if (!url.hasScheme || url.host.isEmpty) {
    return url.path.isEmpty ? '/' : url.path;
  }
  final port = url.hasPort ? ':${url.port}' : '';
  return '${url.scheme}://${url.host}$port${url.path}';
}

final _urlInText = RegExp(
  r'([a-zA-Z][a-zA-Z0-9+.\-]*://)([^/\s@]*@)?([^\s?#,)\]]*)([?#][^\s,)\]]*)?',
);

/// Every URL inside [text] with its userinfo, query and fragment removed.
///
/// For error messages the app did not write: `ClientException.toString()`
/// ends in `uri=https://api.example.com/v1/login?token=…`, and that string was
/// stored verbatim as the error message.
String scrubUrls(String text) => text.replaceAllMapped(_urlInText, (m) => '${m[1]}${m[3]}');
