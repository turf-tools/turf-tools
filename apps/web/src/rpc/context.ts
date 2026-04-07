import { os } from "@orpc/server";
import type { Db } from "@field-tools/db";

export type ORPCContext = {
  db: Db;
  request?: Request;
};

// Base procedure with context — all procedures build on this
export const base = os.$context<ORPCContext>();

// Public procedure (no auth required)
export const pub = base.route({ method: "GET" });
