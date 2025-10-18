import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  loadCurlImpersonate,
  impersonatedRequest,
  unloadCurlLibrary,
} from "../index.ts";

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
