// TEST-ONLY — lives on the `validation/*` branch. See VALIDATION_BUILD.md.
//
// "Delete account" is not a local action. executeAccountDeletion calls
// deleteRemoteAccount() first, and that issues a real
// DELETE /api/auth/delete-account, so an isolated profile does not protect a
// tester's live OpenWhispr account. Every renderer cloud call travels through
// main's handler in src/helpers/cloudApiRequest.js, which is where a validation
// build refuses that one call.

const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");

const {
  refuseValidationDestructiveCloudCall,
  VALIDATION_BLOCKED_CLOUD_CALLS,
  VALIDATION_BLOCKED_CLOUD_CALL_REFUSAL,
} = require("../../src/helpers/validationBuildPolicy");

const DELETE_PATH = "/api/auth/delete-account";

test("an ordinary build refuses nothing", () => {
  assert.equal(
    refuseValidationDestructiveCloudCall({
      isValidationBuild: false,
      method: "DELETE",
      path: DELETE_PATH,
    }),
    null
  );
  assert.equal(refuseValidationDestructiveCloudCall(), null, "no arguments");
});

test("a validation build refuses the account deletion call", () => {
  const refusal = refuseValidationDestructiveCloudCall({
    isValidationBuild: true,
    method: "DELETE",
    path: DELETE_PATH,
  });
  assert.equal(refusal, VALIDATION_BLOCKED_CLOUD_CALL_REFUSAL);
  assert.equal(refusal.success, false);
  assert.equal(refusal.code, "VALIDATION_BUILD_BLOCKED_CLOUD_CALL");
  assert.match(refusal.error, /will not delete your OpenWhispr account/);
  assert.ok(Object.isFrozen(refusal));
  assert.ok(Object.isFrozen(VALIDATION_BLOCKED_CLOUD_CALLS));
});

test("a query string, fragment, trailing slash or lowercase method cannot slip it past", () => {
  for (const candidate of [
    { method: "DELETE", path: `${DELETE_PATH}?confirm=1` },
    { method: "DELETE", path: `${DELETE_PATH}#x` },
    { method: "DELETE", path: `${DELETE_PATH}/` },
    { method: "DELETE", path: `${DELETE_PATH}//` },
    { method: "delete", path: DELETE_PATH },
    { method: "Delete", path: `${DELETE_PATH}/?a=b` },
  ]) {
    assert.equal(
      refuseValidationDestructiveCloudCall({ isValidationBuild: true, ...candidate }),
      VALIDATION_BLOCKED_CLOUD_CALL_REFUSAL,
      `${candidate.method} ${candidate.path}`
    );
  }
});

test("the guard stays narrow: ordinary cloud calls are untouched", () => {
  for (const candidate of [
    { method: "GET", path: DELETE_PATH },
    { method: "POST", path: DELETE_PATH },
    { method: "DELETE", path: "/api/auth/delete-account-data" },
    { method: "DELETE", path: "/api/notes/123" },
    { method: "POST", path: "/api/transcribe" },
    { method: "GET", path: "/api/auth/session" },
    { method: undefined, path: "/api/auth/session" },
  ]) {
    assert.equal(
      refuseValidationDestructiveCloudCall({ isValidationBuild: true, ...candidate }),
      null,
      `${candidate.method} ${candidate.path} must still be allowed`
    );
  }
});

// --- integration: the main-process handler actually consults the policy -----

const handlerPath = require.resolve("../../src/helpers/cloudApiRequest.js");
const policyPath = require.resolve("../../src/helpers/validationBuildPolicy.js");
const originalLoad = Module._load;

function createHandler({ isValidationBuild }) {
  const fetches = [];
  delete require.cache[handlerPath];
  Module._load = function loadWithMocks(request, parent, isMain) {
    if (request === "./validationBuildPolicy") {
      const real = originalLoad.call(this, policyPath, parent, isMain);
      return { ...real, IS_VALIDATION_BUILD: isValidationBuild };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  const { createCloudApiRequestHandler } = require(handlerPath);
  const handler = createCloudApiRequestHandler({
    getApiUrl: () => "https://api.example.test",
    getAppVersion: () => "1.10.3",
    proxyFetch: async (url, options) => {
      fetches.push({ url, method: options.method });
      return { ok: true, status: 200, json: async () => ({}), text: async () => "" };
    },
    tokenStore: { getToken: () => null, getGeneration: () => 0 },
    logger: { warn() {}, error() {}, info() {}, debug() {} },
  });
  return { handler, fetches };
}

test.afterEach(() => {
  Module._load = originalLoad;
  delete require.cache[handlerPath];
});

test("the handler in a validation build never reaches the network for that call", async () => {
  const { handler, fetches } = createHandler({ isValidationBuild: true });

  const result = await handler({ method: "DELETE", path: DELETE_PATH, public: true });

  assert.equal(result.success, false);
  assert.equal(result.code, "VALIDATION_BUILD_BLOCKED_CLOUD_CALL");
  assert.deepEqual(fetches, [], "no request was issued");
});

test("the handler still rejects a malformed path before the validation guard", async () => {
  const { handler, fetches } = createHandler({ isValidationBuild: true });

  const result = await handler({ method: "DELETE", path: "api/auth/delete-account" });

  assert.equal(result.success, false);
  assert.equal(result.error, "Invalid API path", "the existing path check keeps its message");
  assert.deepEqual(fetches, []);
});

test("cloudApiRequest.js routes the decision through the policy", () => {
  const fs = require("node:fs");
  const source = fs.readFileSync(
    path.resolve(__dirname, "..", "..", "src", "helpers", "cloudApiRequest.js"),
    "utf8"
  );
  assert.match(source, /refuseValidationDestructiveCloudCall\(/);
  // The guard must sit before anything that could issue the request.
  const guardIndex = source.indexOf("refuseValidationDestructiveCloudCall({");
  const fetchIndex = source.indexOf("proxyFetch(");
  assert.ok(guardIndex > 0 && fetchIndex > 0, "expected both the guard and the fetch call");
  assert.ok(guardIndex < fetchIndex, "the guard must precede the request");
});
