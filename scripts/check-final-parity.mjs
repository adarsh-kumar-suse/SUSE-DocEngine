import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const finalRoot = path.join(root, "final", "Suse-DocEngine");

const criticalFiles = [
  "server.ts",
  "src/lib/referenceProfiles.ts",
  "src/pages/ProjectSetup.tsx",
  "common/templates/template_DC",
  "common/templates/template_docinfo",
  "common/templates/template_vars",
  "common/templates/template_main-rc",
  "common/templates/template_main-gs",
  "common/adoc/common_docinfo_vars.adoc",
  "common/adoc/common_gfdl1.2_i.adoc",
  "common/adoc/common_sbp_legal_notice.adoc",
  "common/adoc/common_trd_legal_notice.adoc",
  "common/images/src/svg/suse.svg",
];

const mismatches = [];
const missing = [];

for (const relativePath of criticalFiles) {
  const left = path.join(root, relativePath);
  const right = path.join(finalRoot, relativePath);

  if (!fs.existsSync(left)) {
    missing.push(`missing in root: ${relativePath}`);
    continue;
  }
  if (!fs.existsSync(right)) {
    missing.push(`missing in final: ${relativePath}`);
    continue;
  }

  const leftBuf = fs.readFileSync(left);
  const rightBuf = fs.readFileSync(right);
  if (!leftBuf.equals(rightBuf)) {
    mismatches.push(relativePath);
  }
}

if (missing.length || mismatches.length) {
  if (missing.length) {
    console.error("Missing files:");
    missing.forEach((entry) => console.error(`  - ${entry}`));
  }
  if (mismatches.length) {
    console.error("Content mismatches:");
    mismatches.forEach((entry) => console.error(`  - ${entry}`));
  }
  process.exit(1);
}

console.log("Parity check passed for root and final/Suse-DocEngine critical files.");
