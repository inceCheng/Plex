import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveReadPath,
  resolveWritePath,
  resolveWorkspace,
  toWorkspaceRelative,
  WorkspaceViolationError,
} from "../src/paths.ts";

describe("path guard", () => {
  test("允许访问工作目录内的文件", async () => {
    const root = await mkdtemp(join(tmpdir(), "plex-paths-"));
    try {
      const workspace = join(root, "workspace");
      await Bun.write(join(workspace, "docs", "a.md"), "# a");
      const resolvedRoot = await resolveWorkspace(workspace);
      const resolvedFile = await resolveReadPath(resolvedRoot, "docs/a.md");

      expect(toWorkspaceRelative(resolvedRoot, resolvedFile)).toBe("docs/a.md");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("拒绝 ../ 路径越界", async () => {
    const root = await mkdtemp(join(tmpdir(), "plex-paths-"));
    try {
      const workspace = join(root, "workspace");
      await Bun.write(join(workspace, "a.md"), "# a");
      await Bun.write(join(root, "secret.txt"), "secret");
      const resolvedRoot = await resolveWorkspace(workspace);

      await expect(
        resolveReadPath(resolvedRoot, "../secret.txt"),
      ).rejects.toBeInstanceOf(WorkspaceViolationError);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("拒绝通过符号链接逃出工作目录", async () => {
    const root = await mkdtemp(join(tmpdir(), "plex-paths-"));
    try {
      const workspace = join(root, "workspace");
      await Bun.write(join(workspace, ".keep"), "");
      await Bun.write(join(root, "outside.txt"), "outside");
      await symlink(join(root, "outside.txt"), join(workspace, "link.txt"));
      const resolvedRoot = await resolveWorkspace(workspace);

      await expect(
        resolveReadPath(resolvedRoot, "link.txt"),
      ).rejects.toBeInstanceOf(WorkspaceViolationError);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("新建文件时校验真实父目录", async () => {
    const root = await mkdtemp(join(tmpdir(), "plex-paths-"));
    try {
      const workspace = join(root, "workspace");
      await Bun.write(join(workspace, ".keep"), "");
      const resolvedRoot = await resolveWorkspace(workspace);
      const target = await resolveWritePath(resolvedRoot, "summary.md");

      expect(target).toBe(join(resolvedRoot, "summary.md"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
