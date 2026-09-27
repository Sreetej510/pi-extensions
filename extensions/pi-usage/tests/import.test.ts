import assert from "node:assert/strict";
import test from "node:test";
import usageExtension from "../src/index.js";

void test("exports a pi extension factory", () => {
  assert.equal(typeof usageExtension, "function");
});
