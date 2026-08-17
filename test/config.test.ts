import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, saveConfig, updateConfig, configPath } from "../src/config";

describe("config persistence", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tr-cfg-"));
    file = join(dir, "tool-recovery.json");
    process.env.PI_TOOL_RECOVERY_CONFIG = file;
  });

  afterEach(() => {
    delete process.env.PI_TOOL_RECOVERY_CONFIG;
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns defaults when no file exists", () => {
    const cfg = loadConfig();
    expect(cfg.enabled).toBe(true);
    expect(cfg.model).toBeNull();
  });

  it("round-trips enabled flag and model", () => {
    updateConfig({ enabled: false, model: { provider: "anthropic", id: "claude-x" } });
    const cfg = loadConfig();
    expect(cfg.enabled).toBe(false);
    expect(cfg.model).toEqual({ provider: "anthropic", id: "claude-x" });
  });

  it("writes a readable file at the configured path", () => {
    saveConfig({ enabled: true, model: { provider: "openai", id: "gpt-x" } });
    expect(configPath()).toBe(file);
    const cfg = loadConfig();
    expect(cfg.model?.id).toBe("gpt-x");
  });

  it("toggling only updates the provided fields", () => {
    updateConfig({ model: { provider: "openai", id: "gpt-x" } });
    updateConfig({ enabled: false });
    const cfg = loadConfig();
    expect(cfg.enabled).toBe(false);
    expect(cfg.model).toEqual({ provider: "openai", id: "gpt-x" });
  });
});
