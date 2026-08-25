import { runBackendConformance } from "./conformance.ts";
import { FakeBackend } from "./fake-backend.ts";

runBackendConformance("FakeBackend (restart steering)", () => ({
  backend: new FakeBackend({
    script: [{ type: "text-start", id: "t1" }],
    holdOpen: true,
  }),
  turnContext: { cwd: "/tmp", prompt: "conformance" },
}));

runBackendConformance("FakeBackend (no steering)", () => ({
  backend: new FakeBackend({
    script: [{ type: "text-start", id: "t1" }],
    holdOpen: true,
    steering: "none",
  }),
  turnContext: { cwd: "/tmp", prompt: "conformance" },
}));
