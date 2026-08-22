import { createPiAgentBridgeExtension } from "../../src/extension.js";
import { fixtureBridgeConfig } from "./bridge-config.js";
import { FakeExternalAgent } from "./fake-adapter.js";

export default createPiAgentBridgeExtension({
  adapterFactory: (provider) => new FakeExternalAgent(provider),
  configLoader: async () => fixtureBridgeConfig,
});
