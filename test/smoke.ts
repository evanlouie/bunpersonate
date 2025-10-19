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

async function main() {
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      switch (url.pathname) {
        case "/ok":
          return new Response("ok", { status: 200 });
        case "/redirect":
          return new Response(null, {
            status: 302,
            headers: {
              Location: `${url.origin}/redirect-final`,
            },
          });
        case "/redirect-chain":
          return new Response(null, {
            status: 302,
            headers: {
              Location: `${url.origin}/redirect`,
            },
          });
        case "/redirect-final":
          return new Response("redirected", {
            status: 200,
            headers: {
              "X-Redirected": "true",
            },
          });
        case "/echo": {
          const requestBody = await request.text();
          return Response.json({
            method: request.method,
            body: requestBody,
            headers: Object.fromEntries(request.headers),
          });
        }
        case "/slow":
          await Bun.sleep(2_000);
          return new Response("slow", { status: 200 });
        default:
          return new Response("not-found", { status: 404 });
      }
    },
  });

  const baseUrl = `http://127.0.0.1:${server.port}`;
  const results: SmokeResult[] = [];

  try {
    results.push(await basicGetLegacy(baseUrl));
    results.push(await basicGetFetch(baseUrl));
    results.push(await redirectFollowLegacy(baseUrl));
    results.push(await redirectFollowFetch(baseUrl));
    results.push(await redirectManualFetch(baseUrl));
    results.push(await redirectErrorFetch(baseUrl));
    results.push(await postEchoLegacy(baseUrl));
    results.push(await postEchoFetch(baseUrl));
    results.push(await timeoutLegacy(baseUrl));
    results.push(await abortFetch(baseUrl));
    results.push(await alternateTargetFetch(baseUrl));

    const failed = results.filter((result) => !result.success);
    if (failed.length > 0) {
      const details = failed.map((result) => `- ${result.name}`).join("\n");
      throw new Error(`Smoke tests failed:\n${details}`);
    }

    console.log("Smoke suite passed", results.map((result) => result.name));
  } finally {
    server.stop(true);
    unloadCurlLibrary();
  }
}

async function basicGetLegacy(baseUrl: string): Promise<SmokeResult> {
  try {
    const response = await impersonatedRequest({
      url: `${baseUrl}/ok`,
      target: DEFAULT_TARGET,
      followRedirects: false,
      timeoutMs: 5_000,
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
      timeoutMs: 5_000,
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
      timeoutMs: 5_000,
    });
    ensure(response.statusCode === 200, "legacy redirect final status");
    ensure(
      new TextDecoder().decode(response.body) === "redirected",
      "legacy redirect body",
    );
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
    });
    ensure(response.status === 200, "fetch follow status");
    ensure(response.redirected === true, "fetch follow redirected flag");
    ensure(response.headers.get("x-redirected") === "true", "redirect header");
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
    });
    ensure(response.status === 302, "manual redirect status");
    ensure(response.headers.get("location")?.endsWith("/redirect-final"), "manual redirect location");
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
      timeoutMs: 5_000,
    });
    ensure(response.statusCode === 200, "legacy POST status");
    const json = JSON.parse(new TextDecoder().decode(response.body));
    ensure(json.method === "POST", "legacy POST method");
    ensure(json.body === payload, "legacy POST body echo");
    ensure(json.headers["content-type"] === "application/json", "legacy POST header");
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
    });
    ensure(response.status === 200, "fetch POST status");
    const json: any = await response.json();
    ensure(json.method === "POST", "fetch POST method");
    ensure(json.body === payload, "fetch POST body");
    ensure(json.headers["content-type"] === "application/json", "fetch header propagation");
    return { name: "fetch-post-echo", success: true };
  } catch (error) {
    console.error("fetch-post-echo failed", error);
    return { name: "fetch-post-echo", success: false };
  }
}

async function timeoutLegacy(baseUrl: string): Promise<SmokeResult> {
  try {
    let timedOut = false;
    try {
      await impersonatedRequest({
        url: `${baseUrl}/slow`,
        target: DEFAULT_TARGET,
        timeoutMs: 250,
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
    const promise = fetchImpersonated(`${baseUrl}/slow`, {
      target: DEFAULT_TARGET,
      signal: controller.signal,
    });
    controller.abort();
    let aborted = false;
    try {
      await promise;
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

main().catch((error) => {
  console.error("Smoke test failed:", error);
  process.exit(1);
});
