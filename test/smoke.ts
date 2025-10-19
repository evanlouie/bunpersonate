import {
  impersonatedRequest,
  fetchImpersonated,
  unloadCurlLibrary,
} from "../index.ts";

interface SmokeResult {
  name: string;
  success: boolean;
}

const DEFAULT_TARGET = "chrome124";
const TEST_TIMEOUT_MS = 6_000;

async function main() {
  const { worker, baseUrl } = await startSmokeServer();
  const results: SmokeResult[] = [];

  try {
    results.push(await runWithTimeout("legacy-basic-get", () => basicGetLegacy(baseUrl)));
    results.push(await runWithTimeout("fetch-basic-get", () => basicGetFetch(baseUrl)));
    results.push(
      await runWithTimeout("legacy-redirect-follow", () =>
        redirectFollowLegacy(baseUrl),
      ),
    );
    results.push(
      await runWithTimeout("fetch-redirect-follow", () =>
        redirectFollowFetch(baseUrl),
      ),
    );
    results.push(
      await runWithTimeout("fetch-redirect-manual", () =>
        redirectManualFetch(baseUrl),
      ),
    );
    results.push(
      await runWithTimeout("fetch-redirect-error", () =>
        redirectErrorFetch(baseUrl),
      ),
    );
    results.push(await runWithTimeout("legacy-post-echo", () => postEchoLegacy(baseUrl)));
    results.push(await runWithTimeout("fetch-post-echo", () => postEchoFetch(baseUrl)));
    results.push(
      await runWithTimeout("legacy-post-no-body", () => postNoBodyLegacy(baseUrl)),
    );
    results.push(
      await runWithTimeout("fetch-post-no-body", () => postNoBodyFetch(baseUrl)),
    );
    results.push(await runWithTimeout("legacy-timeout", () => timeoutLegacy(baseUrl)));
    results.push(await runWithTimeout("fetch-abort", () => abortFetch(baseUrl)));
    results.push(
      await runWithTimeout("fetch-alt-target", () => alternateTargetFetch(baseUrl)),
    );

    const failed = results.filter((result) => !result.success);
    if (failed.length > 0) {
      const details = failed.map((result) => `- ${result.name}`).join("\n");
      throw new Error(`Smoke tests failed:\n${details}`);
    }

    console.log("Smoke suite passed", results.map((result) => result.name));
  } finally {
    await stopSmokeServer(worker);
    unloadCurlLibrary();
  }
}

async function startSmokeServer(): Promise<{ worker: Worker; baseUrl: string }> {
  const worker = new Worker(
    new URL("./smokeServer.worker.ts", import.meta.url).href,
    { type: "module" },
  );
  const baseUrl = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Smoke server failed to start")), 1_000);
    worker.addEventListener("message", function handle(event) {
      const data = event.data as { type: string; port?: number };
      if (data?.type === "ready" && typeof data.port === "number") {
        clearTimeout(timer);
        worker.removeEventListener("message", handle);
        resolve(`http://127.0.0.1:${data.port}`);
      }
    });
    worker.onerror = (error) => {
      clearTimeout(timer);
      reject(error);
    };
  });
  return { worker, baseUrl };
}

async function stopSmokeServer(worker: Worker): Promise<void> {
  await new Promise<void>((resolve) => {
    worker.addEventListener("message", function handle(event) {
      const data = event.data as { type: string };
      if (data?.type === "closed") {
        worker.removeEventListener("message", handle);
        resolve();
      }
    });
    worker.postMessage("close");
  });
}

async function basicGetLegacy(baseUrl: string): Promise<SmokeResult> {
  try {
    const response = await impersonatedRequest({
      url: `${baseUrl}/ok`,
      target: DEFAULT_TARGET,
      followRedirects: false,
      timeoutMs: 1_000,
      insecureSkipVerify: true,
    });
    ensure(response.statusCode === 200, "legacy GET status");
    ensure(new TextDecoder().decode(response.body) === "ok", "legacy GET body");
    return { name: "legacy-basic-get", success: true };
  } catch (error) {
    console.error("legacy-basic-get failed", error);
    return { name: "legacy-basic-get", success: false };
  }
}

async function basicGetFetch(baseUrl: string): Promise<SmokeResult> {
  try {
    const response = await fetchImpersonated(`${baseUrl}/ok`, {
      target: DEFAULT_TARGET,
      redirect: "follow",
      timeoutMs: 1_000,
      insecureSkipVerify: true,
    });
    ensure(response.status === 200, "fetch GET status");
    ensure((await response.text()) === "ok", "fetch GET body");
    return { name: "fetch-basic-get", success: true };
  } catch (error) {
    console.error("fetch-basic-get failed", error);
    return { name: "fetch-basic-get", success: false };
  }
}

async function redirectFollowLegacy(baseUrl: string): Promise<SmokeResult> {
  try {
    const response = await impersonatedRequest({
      url: `${baseUrl}/redirect`,
      target: DEFAULT_TARGET,
      followRedirects: true,
      timeoutMs: 1_000,
      insecureSkipVerify: true,
    });
    ensure(response.statusCode === 200, "legacy redirect final status");
    ensure(
      !response.headers.some((line) => line.toLowerCase().startsWith("location:")),
      "legacy redirect headers should not include intermediate location",
    );
    ensure(new TextDecoder().decode(response.body) === "redirected", "legacy redirect body");
    return { name: "legacy-redirect-follow", success: true };
  } catch (error) {
    console.error("legacy-redirect-follow failed", error);
    return { name: "legacy-redirect-follow", success: false };
  }
}

async function redirectFollowFetch(baseUrl: string): Promise<SmokeResult> {
  try {
    const response = await fetchImpersonated(`${baseUrl}/redirect-chain`, {
      target: DEFAULT_TARGET,
      redirect: "follow",
      timeoutMs: 1_000,
      insecureSkipVerify: true,
    });
    ensure(response.status === 200, "fetch follow status");
    ensure(response.redirected === true, "fetch follow redirected flag");
    ensure(response.headers.get("location") === null, "fetch follow location header cleared");
    ensure((await response.text()) === "redirected", "fetch follow body");
    return { name: "fetch-redirect-follow", success: true };
  } catch (error) {
    console.error("fetch-redirect-follow failed", error);
    return { name: "fetch-redirect-follow", success: false };
  }
}

async function redirectManualFetch(baseUrl: string): Promise<SmokeResult> {
  try {
    const response = await fetchImpersonated(`${baseUrl}/redirect`, {
      target: DEFAULT_TARGET,
      redirect: "manual",
      timeoutMs: 1_000,
      insecureSkipVerify: true,
    });
    ensure(response.status === 302, "manual redirect status");
    ensure(response.headers.get("location") === `${baseUrl}/redirect-final`, "manual redirect location");
    ensure(response.redirected === false, "manual redirect flag");
    return { name: "fetch-redirect-manual", success: true };
  } catch (error) {
    console.error("fetch-redirect-manual failed", error);
    return { name: "fetch-redirect-manual", success: false };
  }
}

async function redirectErrorFetch(baseUrl: string): Promise<SmokeResult> {
  try {
    let threw = false;
    try {
      await fetchImpersonated(`${baseUrl}/redirect`, {
        target: DEFAULT_TARGET,
        redirect: "error",
        timeoutMs: 1_000,
        insecureSkipVerify: true,
      });
    } catch (error) {
      threw = error instanceof Error && /redirect/i.test(error.message);
    }
    ensure(threw, "redirect error should throw");
    return { name: "fetch-redirect-error", success: true };
  } catch (error) {
    console.error("fetch-redirect-error failed", error);
    return { name: "fetch-redirect-error", success: false };
  }
}

async function postEchoLegacy(baseUrl: string): Promise<SmokeResult> {
  try {
    const payload = JSON.stringify({ hello: "world" });
    const response = await impersonatedRequest({
      url: `${baseUrl}/echo`,
      target: DEFAULT_TARGET,
      method: "POST",
      body: payload,
      headers: {
        "Content-Type": "application/json",
      },
      timeoutMs: 1_000,
      insecureSkipVerify: true,
    });
    ensure(response.statusCode === 200, "legacy POST status");
    const parsed = JSON.parse(new TextDecoder().decode(response.body));
    ensure(parsed.body === payload, "legacy POST body echo");
    ensure(parsed.method === "POST", "legacy POST method");
    ensure(parsed.headers["content-type"] === "application/json", "legacy POST header");
    return { name: "legacy-post-echo", success: true };
  } catch (error) {
    console.error("legacy-post-echo failed", error);
    return { name: "legacy-post-echo", success: false };
  }
}

async function postEchoFetch(baseUrl: string): Promise<SmokeResult> {
  try {
    const payload = JSON.stringify({ hi: "fetch" });
    const response = await fetchImpersonated(`${baseUrl}/echo`, {
      target: DEFAULT_TARGET,
      method: "POST",
      body: payload,
      headers: {
        "Content-Type": "application/json",
      },
      timeoutMs: 1_000,
      insecureSkipVerify: true,
    });
    ensure(response.status === 200, "fetch POST status");
    const json = (await response.json()) as any;
    ensure(json.body === payload, "fetch POST body");
    ensure(json.method === "POST", "fetch POST method");
    ensure(json.headers["content-type"] === "application/json", "fetch header propagation");
    return { name: "fetch-post-echo", success: true };
  } catch (error) {
    console.error("fetch-post-echo failed", error);
    return { name: "fetch-post-echo", success: false };
  }
}

async function postNoBodyLegacy(baseUrl: string): Promise<SmokeResult> {
  try {
    const response = await impersonatedRequest({
      url: `${baseUrl}/echo`,
      target: DEFAULT_TARGET,
      method: "POST",
      timeoutMs: 1_000,
      insecureSkipVerify: true,
    });
    ensure(response.statusCode === 200, "legacy POST without body status");
    const parsed = JSON.parse(new TextDecoder().decode(response.body));
    ensure(parsed.body === "", "legacy POST without body payload");
    ensure(
      parsed.headers["content-length"] === "0" ||
        parsed.headers["content-length"] === undefined,
      "legacy POST without body content-length",
    );
    return { name: "legacy-post-no-body", success: true };
  } catch (error) {
    console.error("legacy-post-no-body failed", error);
    return { name: "legacy-post-no-body", success: false };
  }
}

async function postNoBodyFetch(baseUrl: string): Promise<SmokeResult> {
  try {
    const response = await fetchImpersonated(`${baseUrl}/echo`, {
      target: DEFAULT_TARGET,
      method: "POST",
      timeoutMs: 1_000,
      insecureSkipVerify: true,
    });
    ensure(response.status === 200, "fetch POST without body status");
    const json = (await response.json()) as any;
    ensure(json.body === "", "fetch POST without body payload");
    ensure(
      json.headers["content-length"] === "0" ||
        json.headers["content-length"] === undefined,
      "fetch POST without body content-length",
    );
    return { name: "fetch-post-no-body", success: true };
  } catch (error) {
    console.error("fetch-post-no-body failed", error);
    return { name: "fetch-post-no-body", success: false };
  }
}

async function timeoutLegacy(baseUrl: string): Promise<SmokeResult> {
  try {
    let timedOut = false;
    try {
      await impersonatedRequest({
        url: `${baseUrl}/slow`,
        target: DEFAULT_TARGET,
        timeoutMs: 150,
        insecureSkipVerify: true,
      });
    } catch (error) {
      timedOut = error instanceof Error && /timed out|timeout/i.test(error.message);
    }
    ensure(timedOut, "legacy timeout should throw");
    return { name: "legacy-timeout", success: true };
  } catch (error) {
    console.error("legacy-timeout failed", error);
    return { name: "legacy-timeout", success: false };
  }
}

async function abortFetch(baseUrl: string): Promise<SmokeResult> {
  try {
    const controller = new AbortController();
    controller.abort("pre-aborted");
    let aborted = false;
    try {
      await fetchImpersonated(`${baseUrl}/slow`, {
        target: DEFAULT_TARGET,
        signal: controller.signal,
        timeoutMs: 1_000,
        insecureSkipVerify: true,
      });
    } catch (error) {
      aborted = error instanceof Error && /abort/i.test(error.message);
    }
    ensure(aborted, "fetch abort should reject");
    return { name: "fetch-abort", success: true };
  } catch (error) {
    console.error("fetch-abort failed", error);
    return { name: "fetch-abort", success: false };
  }
}

async function alternateTargetFetch(baseUrl: string): Promise<SmokeResult> {
  const targets = ["chrome116", "chrome120", "chrome124"];
  for (const target of targets) {
    try {
      const response = await fetchImpersonated(`${baseUrl}/ok`, {
        target,
        timeoutMs: 1_000,
        insecureSkipVerify: true,
      });
      ensure(response.status === 200, `alt target ${target} status`);
      return { name: `fetch-alt-target-${target}`, success: true };
    } catch (error) {
      console.warn(`fetch-alt-target-${target} failed, trying next`, error);
    }
  }
  return { name: "fetch-alt-target", success: false };
}

function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

async function runWithTimeout(
  name: string,
  task: () => Promise<SmokeResult>,
  timeoutMs = TEST_TIMEOUT_MS,
): Promise<SmokeResult> {
  let timer: number | undefined;
  const timeoutPromise = new Promise<SmokeResult>((resolve) => {
    timer = setTimeout(() => {
      console.error(`${name} timed out after ${timeoutMs}ms`);
      resolve({ name, success: false });
    }, timeoutMs);
  });
  const result = await Promise.race([task(), timeoutPromise]);
  if (timer !== undefined) {
    clearTimeout(timer);
  }
  return result;
}

main().catch((error) => {
  console.error("Smoke test failed:", error);
  process.exit(1);
});
