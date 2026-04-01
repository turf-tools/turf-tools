import { os } from "@orpc/server";
import { z } from "zod";

// Base procedure — all procedures will build on this
const pub = os.route({ method: "GET" });

export const router = {
  healthcheck: pub.input(z.object({}).optional()).handler(async () => {
    return { status: "ok" };
  }),
};

export type Router = typeof router;
