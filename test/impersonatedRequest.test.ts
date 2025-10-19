import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  loadCurlImpersonate,
  impersonatedRequest,
  fetchImpersonated,
  unloadCurlLibrary,
  __bunpersonateInternals,
} from "../index.ts";

const {
  buildHeaderLines,
  buildHeadersFromLines,
  isRedirectStatus,
  applyResponseMetadata,
  buildFetchImpersonatedConfig,
  buildFetchResponse,
  normalizeRequestBody,
  buildRequestHeaderLines,
} = __bunpersonateInternals;

type FetchConfig = Awaited<ReturnType<typeof buildFetchImpersonatedConfig>>;

test("fetchImpersonated requires a target", async () => {
  await expect(
    fetchImpersonated("https://example.com", {} as unknown as any),
  ).rejects.toThrow(/target/i);
});

test("buildHeaderLines preserves insertion order", () => {
  const headers = new Headers();
  headers.append("X-First", "1");
  headers.append("X-Second", "2");
  const lines = buildHeaderLines(headers);
  expect(lines.length).toBe(2);
  expect(lines[0]?.toLowerCase()).toBe("x-first: 1");
  expect(lines[1]?.toLowerCase()).toBe("x-second: 2");
});

test("buildHeadersFromLines supports duplicate fields", () => {
  const headers = buildHeadersFromLines([
    "set-cookie: a=1",
    "set-cookie: b=2",
    "content-type: text/plain",
  ]);
  const setCookieEntries = Array.from(headers.entries()).filter(
    ([name]) => name === "set-cookie",
  );
  expect(setCookieEntries.length).toBe(2);
  expect(headers.get("content-type")).toBe("text/plain");
});

test("isRedirectStatus identifies redirect codes", () => {
  expect(isRedirectStatus(301)).toBe(true);
  expect(isRedirectStatus(200)).toBe(false);
});

test("applyResponseMetadata annotates Response", async () => {
  const response = new Response(new Uint8Array(), { status: 200 });
  applyResponseMetadata(response, "https://example.com/final", true);
  expect(response.url).toBe("https://example.com/final");
  expect(response.redirected).toBe(true);
});

test("buildFetchImpersonatedConfig maps request settings", async () => {
  const request = new Request("https://example.com/api", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ hello: "world" }),
    redirect: "manual",
  });

  const config = await buildFetchImpersonatedConfig(request, {
    target: "chrome124",
    timeoutMs: 5000,
    defaultHeaders: true,
  });

  expect(config.redirectMode).toBe("manual");
  expect(config.options.followRedirects).toBe(false);
  expect(config.options.method).toBe("POST");
  expect(config.options.body).toBeInstanceOf(Uint8Array);
  expect(config.options.headerList).toContain("content-type: application/json");
  expect(config.options.responseType).toBe("stream");
});

test("buildFetchImpersonatedConfig honors responseType override", async () => {
  const request = new Request("https://example.com/bodyless");
  const config = await buildFetchImpersonatedConfig(request, {
    target: "chrome124",
    responseType: "buffer",
  });
  expect(config.options.responseType).toBe("buffer");
});

test("buildFetchImpersonatedConfig propagates abort signal", async () => {
  const controller = new AbortController();
  controller.abort();
  const request = new Request("https://example.com/abort", {
    signal: controller.signal,
  });

  const config = await buildFetchImpersonatedConfig(request, {
    target: "chrome124",
  });

  expect(config.options.abortSignal?.aborted).toBe(true);
});

test("buildFetchResponse throws when redirect policy is error", () => {
  const config: FetchConfig = {
    redirectMode: "error",
    options: {
      url: "https://example.com/start",
      target: "chrome124",
      method: "GET",
      headerList: [],
      followRedirects: false,
      insecureSkipVerify: undefined,
      timeoutMs: undefined,
      defaultHeaders: undefined,
      abortSignal: undefined,
      body: undefined,
    },
  };

  const responseData = {
    statusCode: 302,
    headers: ["Location: https://example.com/final"],
    body: new Uint8Array(),
    effectiveUrl: "https://example.com/final",
  } satisfies Parameters<typeof buildFetchResponse>[0];

  expect(() =>
    buildFetchResponse(responseData, config, config.options.url),
  ).toThrow(/Redirect was blocked/i);
});

test("buildFetchResponse marks redirected responses", () => {
  const config: FetchConfig = {
    redirectMode: "follow",
    options: {
      url: "https://example.com/start",
      target: "chrome124",
      method: "GET",
      headerList: [],
      followRedirects: true,
      insecureSkipVerify: undefined,
      timeoutMs: undefined,
      defaultHeaders: undefined,
      abortSignal: undefined,
      body: undefined,
    },
  };

  const responseData = {
    statusCode: 200,
    headers: ["content-type: text/plain"],
    body: new TextEncoder().encode("ok"),
    effectiveUrl: "https://example.com/final",
  } satisfies Parameters<typeof buildFetchResponse>[0];

  const response = buildFetchResponse(responseData, config, config.options.url);

  expect(response.redirected).toBe(true);
  expect(response.url).toBe("https://example.com/final");
});

test("buildFetchResponse streams body when provided", async () => {
  const config: FetchConfig = {
    redirectMode: "follow",
    options: {
      url: "https://example.com/start",
      target: "chrome124",
      method: "GET",
      headerList: [],
      followRedirects: true,
      insecureSkipVerify: undefined,
      timeoutMs: undefined,
      defaultHeaders: undefined,
      abortSignal: undefined,
      body: undefined,
      responseType: "stream",
    },
  };

  const chunk = new TextEncoder().encode("streamed");
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(chunk);
      controller.close();
    },
  });

  const responseData = {
    statusCode: 200,
    headers: ["content-type: text/plain"],
    body: new Uint8Array(),
    bodyStream: stream,
    effectiveUrl: "https://example.com/final",
  } satisfies Parameters<typeof buildFetchResponse>[0];

  const response = buildFetchResponse(responseData, config, config.options.url);
  expect(await response.text()).toBe("streamed");
});

test("normalizeRequestBody handles FormData payloads", async () => {
  const form = new FormData();
  form.append("field", "value");
  form.append("file", new Blob(["hello"], { type: "text/plain" }), "demo.txt");

  const normalized = await normalizeRequestBody(form, "POST");
  expect(normalized.bytes).toBeInstanceOf(Uint8Array);
  expect(normalized.bytes?.byteLength).toBeGreaterThan(0);
  expect(normalized.impliedContentType?.startsWith("multipart/form-data")).toBe(
    true,
  );
});

test("buildRequestHeaderLines adds implied content-type when missing", () => {
  const lines = buildRequestHeaderLines(
    undefined,
    { "x-test": "1" },
    "text/plain",
  );
  expect(lines).toContain("Content-Type: text/plain");
});

test("buildRequestHeaderLines respects existing content-type", () => {
  const lines = buildRequestHeaderLines(
    ["Content-Type: application/json"],
    undefined,
    "text/plain",
  );
  const matches = lines.filter((line) =>
    line.toLowerCase().startsWith("content-type:"),
  );
  expect(matches.length).toBe(1);
  expect(matches[0]).toBe("Content-Type: application/json");
});

let libraryAvailable = false;
let detectionError: Error | null = null;

try {
  loadCurlImpersonate();
  libraryAvailable = true;
} catch (error) {
  detectionError = error instanceof Error ? error : new Error(String(error));
  console.warn(
    `Skipping curl-impersonate integration tests: ${detectionError.message}`,
  );
} finally {
  unloadCurlLibrary();
}

const runTest = libraryAvailable ? test : test.skip;

beforeAll(() => {
  if (!libraryAvailable) {
    return;
  }
  loadCurlImpersonate();
});

afterAll(() => {
  unloadCurlLibrary();
});

runTest.serial("loadCurlImpersonate exposes required symbols", () => {
  const lib = loadCurlImpersonate();
  expect(typeof lib.symbols.curl_easy_init).toBe("function");
  expect(typeof lib.symbols.curl_easy_perform).toBe("function");
});

runTest.serial.skip(
  "impersonatedRequest performs a GET to example.com",
  async () => {
    /*
      Bun's test workers currently abort the process when running networked FFI
      requests, so the full smoke test lives in test/smoke.ts instead.
    */
  },
);
