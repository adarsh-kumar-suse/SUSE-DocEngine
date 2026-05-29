import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  applyVariableReplacements,
  buildBaseName,
  buildReferenceMainAdoc,
  buildReplacementCandidatesFromAttributes,
  buildTemplateFirstBody,
  listReferenceProfiles,
  resolveDocTokenMode,
  resolveReferenceProfile,
} from "../src/lib/referenceProfiles.ts";

const makeContext = (overrides: Partial<{
  baseName: string;
  docTypePrefix: string;
  docTokenMode: "doctitle" | "title";
  namingPattern: string;
  profileId: string;
  suseProductSlug: string;
  suseProductDisplay: string;
  partnerSlug: string;
  partnerDisplay: string;
  partnerProductSlug: string;
  partnerProductDisplay: string;
  pipelineName: string;
}> = {}) => ({
  baseName: "rc_suse-ai_clearml",
  docTypePrefix: "rc",
  docTokenMode: "doctitle" as const,
  namingPattern: "docType_suse_partnerProduct",
  profileId: "clearml",
  suseProductSlug: "suse-ai",
  suseProductDisplay: "SUSE AI",
  partnerSlug: "clearml",
  partnerDisplay: "ClearML",
  partnerProductSlug: "clearml",
  partnerProductDisplay: "ClearML",
  pipelineName: "ClearML Pipeline",
  ...overrides,
});

test("resolve profile for known partner", () => {
  const resolution = resolveReferenceProfile("wso2");
  assert.equal(resolution.profile.id, "wso2");
  assert.equal(resolution.fallbackUsed, false);
});

test("resolve profile fallback for unknown partner", () => {
  const resolution = resolveReferenceProfile("acme-partner");
  assert.equal(resolution.profile.id, "generic");
  assert.equal(resolution.fallbackUsed, true);
});

test("base name follows naming pattern", () => {
  const { profile } = resolveReferenceProfile("hitachi");
  const baseName = buildBaseName({
    profile,
    docTypePrefix: "gs",
    suseProductSlug: "virtualization",
    partnerProductSlug: "hitachi-storage",
  });
  assert.equal(baseName, "gs_virtualization_hitachi-storage");
});

test("template body mapping keeps unmatched content in deterministic section", () => {
  const { profile } = resolveReferenceProfile("wso2");
  const body = buildTemplateFirstBody(profile, [
    {
      heading: "Introduction",
      normalizedHeading: "introduction",
      lines: ["This is intro content."],
    },
    {
      heading: "Completely Custom Section",
      normalizedHeading: "completely custom section",
      lines: ["Custom content block."],
    },
  ]);

  assert.match(body, /== Introduction/);
  assert.match(body, /This is intro content\./);
  assert.match(body, /== Additional extracted content/);
  assert.match(body, /=== Completely Custom Section/);
});

test("main adoc generation preserves legal tail include markers", () => {
  const { profile } = resolveReferenceProfile("clearml");
  const adoc = buildReferenceMainAdoc({
    context: makeContext(),
    profile,
    bodyContent: "== Introduction\n\nGenerated body",
  });

  assert.match(adoc, /include::common_trd_legal_notice\.adoc\[\]/);
  assert.match(adoc, /include::common_gfdl1\.2_i\.adoc\[\]/);
  assert.match(adoc, /\/\/ stage-template-body-start/);
});

test("replacement candidates are derived from attributes and applied", () => {
  const attrs = new Map<string, string>([
    ["suse-product", "SUSE Rancher Prime"],
    ["partner-product", "Open Choreo"],
    ["too-short", "abc"],
    ["templated", "{partner-product}"],
  ]);
  const candidates = buildReplacementCandidatesFromAttributes(attrs);
  const transformed = applyVariableReplacements(
    "SUSE Rancher Prime integrates with Open Choreo.",
    candidates,
  );
  assert.match(transformed, /\{suse-product\}/);
  assert.match(transformed, /\{partner-product\}/);
  assert.doesNotMatch(transformed, /\{too-short\}/);
});

test("replacement stays boundary-safe for hyphenated and anchor-like tokens", () => {
  const transformed = applyVariableReplacements(
    "#install-clearml-agent-manager works with ClearML platform",
    [{ literal: "clearml", token: "{partner}" }],
  );

  assert.match(transformed, /#install-clearml-agent-manager/);
  assert.match(transformed, /\{partner\} platform/i);
  assert.doesNotMatch(transformed, /#install-\{partner\}-agent-manager/);
});

test("doc token mode switches for gs documents", () => {
  assert.equal(resolveDocTokenMode("gs"), "title");
  assert.equal(resolveDocTokenMode("rc"), "doctitle");
});

test("profile catalog is non-empty", () => {
  assert.ok(listReferenceProfiles().length >= 4);
});

test("canonical common files are vendored with non-placeholder content", () => {
  const root = process.cwd();
  const files = [
    "common/adoc/common_docinfo_vars.adoc",
    "common/adoc/common_trd_legal_notice.adoc",
    "common/adoc/common_gfdl1.2_i.adoc",
    "common/templates/template_main-rc",
  ];

  files.forEach((relativePath) => {
    const fullPath = path.join(root, relativePath);
    assert.equal(fs.existsSync(fullPath), true, `missing ${relativePath}`);
    const content = fs.readFileSync(fullPath, "utf8");
    assert.equal(content.includes("placeholder for local rendering"), false, `${relativePath} is placeholder`);
    assert.ok(content.trim().length > 100, `${relativePath} is unexpectedly short`);
  });
});
