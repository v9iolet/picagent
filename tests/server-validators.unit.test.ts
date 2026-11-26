import assert from "node:assert/strict";
import test from "node:test";
import { asPlainObject, hasValidUuids, isUuid, nonEmptyString, normalizeUuid, parsePagination } from "../server/http/validators.js";

test("UUID normalization preserves the accepted UUID shapes and rejects nonstrings", () => {
  const id = "ABCDEF12-3456-0000-0000-000000000000";
  assert.ok(isUuid(id));
  assert.equal(normalizeUuid(" " + id + " "), id.toLowerCase());
  assert.ok(hasValidUuids(id, id));
  for (const value of [null, {}, [], "", " " + id, "x" + id, id.slice(1)]) assert.equal(hasValidUuids(id, value), false);
  assert.equal(normalizeUuid("invalid"), null);
});

test("offset and page pagination produce bounded limits and safe offsets", () => {
  const parse = (query: string) => parsePagination(new URLSearchParams(query));
  assert.deepEqual(parse(""), { limit: 24, offset: 0 });
  assert.deepEqual(parse("limit=1&offset=0"), { limit: 1, offset: 0 });
  assert.deepEqual(parse("limit=100&offset=9007199254740991"), { limit: 100, offset: Number.MAX_SAFE_INTEGER });
  assert.deepEqual(parse("pageSize=25&page=3"), { limit: 25, offset: 50 });
  assert.deepEqual(parsePagination(new URLSearchParams("page=-1&limit="), { mode: "offset", defaultLimit: 20 }), { limit: 20, offset: 0 });
  for (const query of ["limit=0", "limit=101", "limit=2.5", "offset=-1", "offset=1e3", "offset=NaN", "page=0", "pageSize=101", "pageSize=0", "page=9007199254740991", "offset=9007199254740992"]) {
    assert.equal(parse(query), null, query);
  }
});

test("field validators distinguish plain records and trimmed non-empty strings", () => {
  const record = Object.create(null);
  assert.equal(asPlainObject(record), record);
  assert.deepEqual(asPlainObject({ x: 1 }), { x: 1 });
  for (const value of [null, [], new Date(), 1]) assert.equal(asPlainObject(value), null);
  assert.equal(nonEmptyString("  值  "), "值");
  for (const value of [undefined, "  ", 0]) assert.equal(nonEmptyString(value), null);
});
