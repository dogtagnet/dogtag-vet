import {describe, expect, it} from "vitest";
import {readJsonBody} from "@/lib/bodyLimit";

function requestWithBody(body: string, contentLength?: string): Request {
  const headers: Record<string, string> = {};
  if (contentLength !== undefined) headers["content-length"] = contentLength;
  return new Request("http://localhost/v1/booking/book", {method: "POST", body, headers});
}

describe("readJsonBody", () => {
  it("parses a normal small JSON body", async () => {
    const result = await readJsonBody(requestWithBody(JSON.stringify({serviceId: "svc-1"})));
    expect(result).toEqual({ok: true, body: {serviceId: "svc-1"}});
  });

  it("rejects a body over the cap using a lying Content-Length header", async () => {
    const result = await readJsonBody(requestWithBody(JSON.stringify({a: 1}), "999999"), 16);
    expect(result).toEqual({ok: false, tooLarge: true});
  });

  it("rejects a body over the cap even without a Content-Length header, by measuring bytes read", async () => {
    const big = "x".repeat(1000);
    const result = await readJsonBody(requestWithBody(JSON.stringify({notes: big})), 16);
    expect(result).toEqual({ok: false, tooLarge: true});
  });

  it("accepts a body right at the cap", async () => {
    const body = JSON.stringify({a: "x".repeat(10)});
    const result = await readJsonBody(requestWithBody(body), Buffer.byteLength(body));
    expect(result.ok).toBe(true);
  });

  it("reports malformed JSON as not-too-large so callers can 400 rather than 413", async () => {
    const result = await readJsonBody(requestWithBody("{not json"));
    expect(result).toEqual({ok: false, tooLarge: false});
  });

  it("treats an empty body as a JSON null rather than throwing", async () => {
    const result = await readJsonBody(requestWithBody(""));
    expect(result).toEqual({ok: true, body: null});
  });
});
