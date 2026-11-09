/**
 * Test: locales/*.json are in sync with the catalogs (generated on build) and
 * es/en cover the same keys. Untranslated pt/fr/zh-CN keys only warn.
 * Run: pnpm --filter @promedia/hub exec tsx scripts/test-i18n.mts
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LOCALES, getCatalog, t } from "../../../packages/i18n/dist/index.js";

const localesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/i18n/locales");
const es = Object.keys(getCatalog("es"));

for (const locale of LOCALES) {
  const json = JSON.parse(await readFile(path.join(localesDir, `${locale}.json`), "utf8"));
  assert.deepEqual(json, getCatalog(locale), `locales/${locale}.json is stale — run pnpm run build:packages`);
}

const en = new Set(Object.keys(getCatalog("en")));
assert.deepEqual(es.filter((k) => !en.has(k)), [], "en is missing keys that es has");

for (const locale of LOCALES) {
  const have = new Set(Object.keys(getCatalog(locale)));
  const missing = es.filter((k) => !have.has(k));
  if (missing.length) console.warn(`  ⚠ ${locale}: ${missing.length} key(s) not translated yet (fall back to es)`);
}

assert.equal(t("pt", "control.close").length > 0, true);
assert.notEqual(t("es", "control.envIssuesTitle"), "control.envIssuesTitle");
console.log("TEST_OK test-i18n");
