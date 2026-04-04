import { expect } from "vite-plus/test";
import { rpcTest } from "./rpc.setup";

rpcTest("healthcheck returns ok with db connected", async ({ rpc }) => {
  const result = await rpc.caller.healthcheck();

  expect(result.status).toBe("ok");
  expect(result.db).toBe("connected");
});
