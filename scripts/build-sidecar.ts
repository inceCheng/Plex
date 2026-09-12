import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const outDir = join(root, "src-tauri", "binaries");

function detectHostTriple(): string {
  const result = Bun.spawnSync({
    cmd: ["rustc", "-vV"],
    stdout: "pipe",
    stderr: "pipe",
  });
  const host = result.stdout.toString().match(/^host:\s*(.+)$/m)?.[1]?.trim();
  if (host) {
    return host;
  }

  if (process.platform === "darwin") {
    return process.arch === "arm64"
      ? "aarch64-apple-darwin"
      : "x86_64-apple-darwin";
  }
  if (process.platform === "linux") {
    return process.arch === "arm64"
      ? "aarch64-unknown-linux-gnu"
      : "x86_64-unknown-linux-gnu";
  }
  return process.arch === "arm64"
    ? "aarch64-pc-windows-msvc"
    : "x86_64-pc-windows-msvc";
}

const triple = detectHostTriple();
const outfile = join(outDir, `plex-agent-${triple}`);

await mkdir(outDir, { recursive: true });

const build = Bun.spawnSync({
  cmd: [
    "bun",
    "build",
    "--compile",
    "--minify",
    "--outfile",
    outfile,
    join(root, "sidecar", "src", "main.ts"),
  ],
  cwd: root,
  stdout: "inherit",
  stderr: "inherit",
});

if (build.exitCode !== 0) {
  process.exit(build.exitCode ?? 1);
}

await chmod(outfile, 0o755);
console.log(`Sidecar built: ${outfile}`);
