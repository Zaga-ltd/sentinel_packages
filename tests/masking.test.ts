// Secrets are masked with no configuration at all.
//
// The old rule — `maskHeaders ? maskHeaders(...) : rawHeaders` — meant the
// default configuration shipped every Authorization header and session cookie
// verbatim. User patterns now add to a built-in list that always applies.

import { describe, expect, test } from "bun:test";
import { maskBodyFields, maskHeaders, maskQueryParams, maskUrl, truncateBody } from "../src/masking";
import { isCapturableBody, readBoundedText } from "../src/body";

describe("headers", () => {
  test("credentials are masked with no patterns given", () => {
    const out = maskHeaders({
      authorization: "Bearer abc",
      cookie: "sid=1",
      "set-cookie": "sid=2",
      "x-api-key": "k",
      "proxy-authorization": "Basic x",
      "x-auth-token": "t",
      "x-amz-security-token": "s",
      "content-type": "application/json",
    })!;
    for (const k of ["authorization", "cookie", "set-cookie", "x-api-key", "proxy-authorization", "x-auth-token", "x-amz-security-token"]) {
      expect(out[k]).toBe("***");
    }
    expect(out["content-type"]).toBe("application/json");
  });

  test("user patterns add to the defaults rather than replacing them", () => {
    const out = maskHeaders({ authorization: "a", "x-tenant": "t" }, [/^x-tenant$/i])!;
    expect(out).toEqual({ authorization: "***", "x-tenant": "***" });
  });
});

describe("query strings", () => {
  test("reset tokens, OAuth codes and signed-URL parts are masked", () => {
    expect(
      maskQueryParams({ token: "a", code: "b", key: "c", api_key: "d", signature: "e", access_token: "f", page: "2" })
    ).toEqual({ token: "***", code: "***", key: "***", api_key: "***", signature: "***", access_token: "***", page: "2" });
  });

  test("maskUrl rewrites only the secret values and keeps everything else as written", () => {
    expect(maskUrl("https://s3.test/f.pdf?X-Amz-Signature=abc&X-Amz-Credential=AKIA%2F1&v=2")).toBe(
      "https://s3.test/f.pdf?X-Amz-Signature=***&X-Amz-Credential=***&v=2"
    );
    expect(maskUrl("/reset?token=abc&next=%2Fhome")).toBe("/reset?token=***&next=%2Fhome");
    // OAuth implicit flow returns the token in the fragment.
    expect(maskUrl("https://app.test/cb#access_token=xyz&state=1")).toBe("https://app.test/cb#access_token=***&state=1");
    // A route fragment is not a parameter list.
    expect(maskUrl("https://app.test/#/orders/1")).toBe("https://app.test/#/orders/1");
    expect(maskUrl("/plain/path")).toBe("/plain/path");
  });
});

describe("bodies", () => {
  test("JSON, at any depth, with no patterns given", () => {
    const out = JSON.parse(
      maskBodyFields(
        JSON.stringify({
          user: { email: "a@b.c", password: "p", newPassword: "q" },
          refresh_token: "r",
          accessToken: "s",
          card: { cardNumber: "4242", cvv: "123" },
          client_secret: "c",
          tokens_used: 1200,
        })
      )
    );
    expect(out.user).toEqual({ email: "a@b.c", password: "***", newPassword: "***" });
    expect(out.refresh_token).toBe("***");
    expect(out.accessToken).toBe("***");
    expect(out.card).toEqual({ cardNumber: "***", cvv: "***" });
    expect(out.client_secret).toBe("***");
    // An LLM token count is not a secret.
    expect(out.tokens_used).toBe(1200);
  });

  test("form-encoded bodies are masked, not passed through because they are not JSON", () => {
    expect(maskBodyFields("username=ann&password=hunter2&remember=1")).toBe("username=ann&password=***&remember=1");
    expect(maskBodyFields("a=1&api_key=zz", undefined, "application/x-www-form-urlencoded")).toBe("a=1&api_key=***");
  });

  test("a JSON body cut off at the capture limit is still masked", () => {
    const cut = '{"email":"a@b.c","password":"hunt';
    expect(maskBodyFields(cut, undefined, "application/json")).toBe('{"email":"a@b.c","password":"***"');
  });

  test("multipart text fields are masked by name", () => {
    const body = [
      "--b",
      'Content-Disposition: form-data; name="user"',
      "",
      "ann",
      "--b",
      'Content-Disposition: form-data; name="password"',
      "",
      "hunter2",
      "--b--",
    ].join("\r\n");
    const out = maskBodyFields(body, undefined, "multipart/form-data; boundary=b");
    expect(out).toContain("ann");
    expect(out).not.toContain("hunter2");
  });

  test("truncation reports the real size when it is known", () => {
    expect(truncateBody("abcdef", 3, 1_000)).toBe("abc... [truncated, 1000 bytes total]");
  });
});

describe("bounded body capture", () => {
  test("reads at most the limit and cancels the rest", async () => {
    let pulled = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        controller.enqueue(new TextEncoder().encode("x".repeat(1024)));
      },
      cancel() {
        cancelled = true;
      },
    });
    const out = (await readBoundedText(stream, 4_000))!;
    expect(out.text.length).toBe(4_000);
    expect(out.truncated).toBe(true);
    expect(cancelled).toBe(true);
    // An endless stream stopped after a handful of chunks, not never.
    expect(pulled).toBeLessThan(10);
  });

  test("files, media and streams are not captured at all", () => {
    expect(isCapturableBody("multipart/form-data; boundary=x")).toBe(false);
    expect(isCapturableBody("image/png")).toBe(false);
    expect(isCapturableBody("text/event-stream")).toBe(false);
    expect(isCapturableBody("application/json", "gzip")).toBe(false);
    expect(isCapturableBody("application/json; charset=utf-8")).toBe(true);
  });
});
