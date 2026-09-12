import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  describeWrite,
  listDirectory,
  readTextFile,
  searchText,
  writeTextFileChecked,
} from "../src/tools.ts";
import { resolveWorkspace } from "../src/paths.ts";

describe("file tools", () => {
  test("列出目录、搜索和读取文本", async () => {
    const root = await mkdtemp(join(tmpdir(), "plex-tools-"));
    try {
      const workspacePath = join(root, "workspace");
      await Bun.write(join(workspacePath, "docs", "a.md"), "# Alpha\ntodo: 写概览");
      await Bun.write(join(workspacePath, "docs", "b.txt"), "beta");
      const workspace = await resolveWorkspace(workspacePath);

      const listing = await listDirectory(workspace, "docs");
      expect(listing.entries).toHaveLength(2);

      const search = await searchText(workspace, "todo", ".");
      expect(search.matches).toEqual([
        { path: "docs/a.md", line: 2, text: "todo: 写概览" },
      ]);

      const file = await readTextFile(workspace, "docs/a.md");
      expect(file.content).toBe("# Alpha\ntodo: 写概览");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("审批快照与磁盘状态不一致时拒绝写入", async () => {
    const root = await mkdtemp(join(tmpdir(), "plex-tools-"));
    try {
      const workspacePath = join(root, "workspace");
      await Bun.write(join(workspacePath, "summary.md"), "old");
      const workspace = await resolveWorkspace(workspacePath);

      const preview = await describeWrite(
        workspace,
        "summary.md",
        "approved content",
      );
      await Bun.write(join(workspace, "summary.md"), "external change");

      await expect(
        writeTextFileChecked(
          workspace,
          "summary.md",
          "approved content",
          preview.hash,
        ),
      ).rejects.toMatchObject({ code: "FILE_CHANGED_SINCE_APPROVAL" });

      expect(
        await Bun.file(join(workspace, "summary.md")).text(),
      ).toBe("external change");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
