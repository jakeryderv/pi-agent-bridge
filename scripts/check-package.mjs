import { spawnSync } from "node:child_process";

const packed = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
  encoding: "utf8",
});
if (packed.status !== 0) {
  process.stderr.write(packed.stderr || packed.stdout);
  process.exit(packed.status ?? 1);
}

let reports;
try {
  reports = JSON.parse(packed.stdout);
} catch (error) {
  throw new Error("npm pack returned invalid JSON", { cause: error });
}
const report = reports[0];
if (!report) throw new Error("npm pack returned no package report");
const files = new Set(report.files.map((entry) => entry.path));
const required = [
  "package.json",
  "README.md",
  "LICENSE",
  "SECURITY.md",
  "dist/index.js",
  "dist/index.d.ts",
  "docs/architecture.md",
  "docs/development-lifecycle.md",
];
for (const path of required) {
  if (!files.has(path)) throw new Error(`Published package is missing ${path}`);
}

const forbiddenPrefixes = ["src/", "test/", "scripts/", ".github/", "node_modules/"];
for (const path of files) {
  if (forbiddenPrefixes.some((prefix) => path.startsWith(prefix))) {
    throw new Error(`Published package contains development-only path: ${path}`);
  }
}

process.stdout.write(`Package contents: ${files.size} files, ${report.size} packed bytes\n`);
