import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// Bundle the TypeScript module without requiring a separate build or a TS loader.
const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL("../src/codex-reset-credits.ts", import.meta.url))],
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
  target: "node22",
});
const { consumeCodexResetCredit, fetchCodexResetCredits } = await import(
  `data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString("base64")}`
);

const consumeUrl = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume";
const creditId = "RateLimitResetCredit_selected";
let fetchMock;

beforeEach(() => {
  // Never use real credentials or allow network calls from these tests.
  fetchMock = mock.method(globalThis, "fetch", async () => {
    throw new Error("Unexpected fetch in banked-reset test.");
  });
});
afterEach(() => mock.restoreAll());

function context(headers = {}) {
  return {
    modelRegistry: {
      getAvailable: () => [{ id: "codex-test", provider: "openai-codex" }],
      getApiKeyAndHeaders: async () => ({
        ok: true,
        apiKey: "test-token",
        headers: { "ChatGPT-Account-ID": "test-account", ...headers },
      }),
    },
  };
}

function respond(payload, status = 200) {
  fetchMock.mock.mockImplementation(async () => new Response(JSON.stringify(payload), { status }));
}

test("consume sends the selected credit_id and a fresh redeem_request_id in one POST", async () => {
  respond({ code: "reset", windows_reset: 2 });
  await consumeCodexResetCredit(context(), 1000, creditId);

  assert.equal(fetchMock.mock.callCount(), 1);
  const [url, init] = fetchMock.mock.calls[0].arguments;
  assert.equal(url, consumeUrl);
  assert.equal(init.method, "POST");
  const body = JSON.parse(init.body);
  assert.deepEqual(body, { credit_id: creditId, redeem_request_id: body.redeem_request_id });
  assert.match(body.redeem_request_id, /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i);

  await consumeCodexResetCredit(context(), 1000, creditId);
  const secondBody = JSON.parse(fetchMock.mock.calls[1].arguments[1].body);
  assert.notEqual(secondBody.redeem_request_id, body.redeem_request_id);
});

for (const headers of [{}, { "oPeNaI-bEtA": "provider-beta", OrIgInAtOr: "provider-origin" }]) {
  test(`consume omits list-only headers, including inherited variants: ${JSON.stringify(headers)}`, async () => {
    respond({ code: "reset" });
    await consumeCodexResetCredit(context(headers), 1000, creditId);

    const sent = new Headers(fetchMock.mock.calls[0].arguments[1].headers);
    assert.equal(sent.has("OpenAI-Beta"), false);
    assert.equal(sent.has("originator"), false);
    assert.equal(sent.get("Authorization"), "Bearer test-token");
    assert.equal(sent.get("ChatGPT-Account-ID"), "test-account");
    assert.equal(sent.get("Content-Type"), "application/json");
    assert.equal(sent.get("Accept"), "application/json");
  });
}

test("listing reset credits retains its existing request headers", async () => {
  respond({ available_count: 1, credits: [{ id: creditId, status: "available" }] });
  const result = await fetchCodexResetCredits(context(), 1000);

  assert.equal(result.availableCount, 1);
  assert.equal(result.credits[0].id, creditId);
  assert.equal(fetchMock.mock.callCount(), 1);
  const [url, init] = fetchMock.mock.calls[0].arguments;
  assert.equal(url, "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits");
  assert.equal(init.method ?? "GET", "GET");
  const sent = new Headers(init.headers);
  assert.equal(sent.get("OpenAI-Beta"), "codex-1");
  assert.equal(sent.get("originator"), "Codex Desktop");
});

for (const status of [400, 401, 403, 404, 409, 422, 429, 503]) {
  test(`HTTP ${status} is surfaced with redaction and without guessing another payload`, async () => {
    respond({ error: "Bearer test-secret", access_token: "test-secret" }, status);
    await assert.rejects(consumeCodexResetCredit(context(), 1000, creditId), (error) => {
      assert.match(error.message, new RegExp(`Codex consume banked reset returned ${status}`));
      assert.equal(error.message.includes("test-secret"), false);
      return true;
    });
    assert.equal(fetchMock.mock.callCount(), 1);
  });
}

for (const [code, message] of [
  ["nothing_to_reset", /no usage windows to reset/i],
  ["no_credit", /no Codex banked reset credit is available/i],
  ["already_redeemed", /already processed/i],
  ["unexpected", /unrecognized banked reset result/i],
  [undefined, /unrecognized banked reset result/i],
]) {
  test(`HTTP 200 with code ${String(code)} does not report a consumed reset`, async () => {
    respond({ code });
    await assert.rejects(consumeCodexResetCredit(context(), 1000, creditId), message);
    assert.equal(fetchMock.mock.callCount(), 1);
  });
}

for (const body of ["not JSON", "[]"]) {
  test(`an invalid consume response is not treated as success: ${body}`, async () => {
    fetchMock.mock.mockImplementation(async () => new Response(body));
    await assert.rejects(consumeCodexResetCredit(context(), 1000, creditId), /Codex consume banked reset response/);
    assert.equal(fetchMock.mock.callCount(), 1);
  });
}

test("a network failure does not retry a potentially committed redemption", async () => {
  fetchMock.mock.mockImplementation(async () => {
    throw new Error("Connection closed");
  });
  await assert.rejects(consumeCodexResetCredit(context(), 1000, creditId), /Connection closed/);
  assert.equal(fetchMock.mock.callCount(), 1);
});

test("a timed-out consume request is not automatically retried", async () => {
  fetchMock.mock.mockImplementation(
    async (_url, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
  );
  await assert.rejects(
    consumeCodexResetCredit(context(), 10, creditId),
    /Timed out .* while fetching Codex consume banked reset/,
  );
  assert.equal(fetchMock.mock.callCount(), 1);
});
