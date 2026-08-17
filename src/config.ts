/**
 * Persistent configuration for the extension.
 *
 * Stores two things: whether recovery is enabled, and which model acts as the
 * recovery LLM. Kept in the user-global pi config directory so the choice
 * follows the user across projects.
 */

import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { RecoverySelection } from "./recovery";

export interface RecoveryConfig {
  enabled: boolean;
  model: RecoverySelection | null;
  /**
   * Optional direct OpenAI-compatible endpoint. When set, it takes precedence
   * over the picker-selected provider and lets the recovery LLM be any
   * OpenAI-compatible server (including a local model or proxy) without a pi
   * provider. Configured via TOOLRECOVERY_BASE_URL / TOOLRECOVERY_API_KEY /
   * TOOLRECOVERY_MODEL_ID.
   */
  recoveryBaseUrl?: string;
  recoveryApiKey?: string;
  recoveryModelId?: string;
}

const DEFAULT_CONFIG: RecoveryConfig = { enabled: true, model: null };

export function configPath(): string {
  const override = process.env.PI_TOOL_RECOVERY_CONFIG;
  if (override) return override;
  return join(homedir(), ".pi", "agent", "tool-recovery.json");
}

export function loadConfig(): RecoveryConfig {
  try {
    const p = configPath();
    const file: Partial<RecoveryConfig> = existsSync(p)
      ? (JSON.parse(readFileSync(p, "utf8")) as Partial<RecoveryConfig>)
      : {};
    return {
      enabled: typeof file.enabled === "boolean" ? file.enabled : DEFAULT_CONFIG.enabled,
      model: file.model ?? null,
      recoveryBaseUrl: process.env.TOOLRECOVERY_BASE_URL ?? file.recoveryBaseUrl,
      recoveryApiKey: process.env.TOOLRECOVERY_API_KEY ?? file.recoveryApiKey,
      recoveryModelId: process.env.TOOLRECOVERY_MODEL_ID ?? file.recoveryModelId,
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(cfg: RecoveryConfig): void {
  const p = configPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(cfg, null, 2), "utf8");
}

export function updateConfig(patch: Partial<RecoveryConfig>): RecoveryConfig {
  const next = { ...loadConfig(), ...patch };
  saveConfig(next);
  return next;
}
