import { test } from "node:test";
import assert from "node:assert/strict";
import * as dmRpc from "../shared/dm-rpc";
import * as homeRpc from "../shared/home-rpc";
import * as pushRpc from "../shared/push-rpc";
import * as quotaRpc from "../shared/quota-rpc";
import * as rpc from "../shared/rpc";
import * as workersRpc from "../shared/workers-rpc";
import * as roomsRpc from "../shared/rooms/rpc";
import * as manageRpc from "../shared/manage-rpc";
import * as avatarRpc from "../shared/avatar-rpc";
import * as timersRpc from "../shared/timers-rpc";

// The daemon refuses to load a plugin whose RPC method breaks this rule (plugin-process.ts).
const METHOD_RE = /^[a-z][a-z0-9._-]*$/;

test("every RPC method name is one the daemon accepts", () => {
  const contracts = [dmRpc, homeRpc, pushRpc, quotaRpc, rpc, workersRpc, roomsRpc, manageRpc, avatarRpc, timersRpc].flatMap((module) =>
    Object.values(module).filter(
      (value): value is { name: string } =>
        typeof value === "object" && value !== null && "name" in value && "input" in value,
    ),
  );
  assert.ok(contracts.length >= 10);
  for (const contract of contracts) assert.match(contract.name, METHOD_RE, contract.name);
});
