import type { BridgeConfig } from "../../src/config.js";

export const fixtureBridgeConfig: BridgeConfig = {
  defaults: { permissions: "workspace-write" },
  security: { allowOutsideCwd: false },
  codex: {
    enabled: true,
    command: "codex-fixture",
    args: ["app-server"],
  },
  claude: {
    enabled: true,
    maxTurns: 3,
  },
};
