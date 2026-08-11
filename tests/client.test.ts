// Resolving who called from proxy headers.
//
// Getting this wrong is quiet: every request records the load balancer's
// address, every country reads the same, and nothing looks broken.

import { describe, expect, test } from "bun:test";
import { clientIp, clientCountry, requestHost } from "../src/client";

const h = (obj: Record<string, string>) => new Headers(obj);

describe("clientIp", () => {
  test("takes the leftmost entry of an X-Forwarded-For chain", () => {
    // `client, proxy1, proxy2` — everything after the first was appended by a
    // hop, so only the first is the caller.
    expect(clientIp(h({ "x-forwarded-for": "203.0.113.7, 70.41.3.18, 150.172.238.178" }))).toBe(
      "203.0.113.7"
    );
  });

  test("prefers the header the edge vouches for over X-Forwarded-For", () => {
    const headers = h({
      "cf-connecting-ip": "203.0.113.7",
      "x-forwarded-for": "198.51.100.1, 203.0.113.7",
    });
    expect(clientIp(headers)).toBe("203.0.113.7");
  });

  test("handles IPv6 and nginx's X-Real-IP", () => {
    expect(clientIp(h({ "x-real-ip": "2001:db8::8a2e:370:7334" }))).toBe("2001:db8::8a2e:370:7334");
  });

  test("is undefined when the app sits behind no proxy", () => {
    expect(clientIp(h({}))).toBeUndefined();
  });

  test("ignores an empty header rather than returning a blank string", () => {
    expect(clientIp(h({ "x-forwarded-for": "" }))).toBeUndefined();
  });
});

describe("clientCountry", () => {
  test("reads the edge's country header", () => {
    expect(clientCountry(h({ "cf-ipcountry": "TZ" }))).toBe("TZ");
    expect(clientCountry(h({ "x-vercel-ip-country": "de" }))).toBe("DE");
  });

  // Cloudflare sends XX for "could not determine" and T1 for Tor. Storing
  // either as a country would put a fake flag on the row.
  test("rejects the placeholder codes", () => {
    expect(clientCountry(h({ "cf-ipcountry": "XX" }))).toBeUndefined();
    expect(clientCountry(h({ "cf-ipcountry": "T1" }))).toBeUndefined();
  });

  test("rejects anything that is not two letters", () => {
    expect(clientCountry(h({ "cf-ipcountry": "Tanzania" }))).toBeUndefined();
    expect(clientCountry(h({ "cf-ipcountry": "12" }))).toBeUndefined();
  });

  test("is undefined with no edge in front", () => {
    expect(clientCountry(h({}))).toBeUndefined();
  });
});

describe("requestHost", () => {
  test("reads the Host header", () => {
    expect(requestHost(h({ host: "api.example.com" }))).toBe("api.example.com");
  });

  test("is undefined when absent", () => {
    expect(requestHost(h({}))).toBeUndefined();
  });
});
