import { describe, expect, test } from "bun:test";
import { DEFAULT_THEME, resolveTheme } from "../theme";

describe("theme", () => {
  test("默认使用白色主题", () => {
    expect(DEFAULT_THEME).toBe("light");
    expect(resolveTheme(null)).toBe("light");
    expect(resolveTheme("light")).toBe("light");
    expect(resolveTheme("unknown")).toBe("light");
  });

  test("可以恢复黑色主题", () => {
    expect(resolveTheme("dark")).toBe("dark");
  });
});
