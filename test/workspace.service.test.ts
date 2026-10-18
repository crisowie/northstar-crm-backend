import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import type { SupabaseClient } from "@supabase/supabase-js";
import { WorkspaceService } from "../src/workspace/workspace.service";

test("loads every workspace row when Supabase caps each response page", async () => {
  const contactRows = Array.from({ length: 270 }, (_, index) => ({
    payload: { id: `contact-${index}` },
  }));
  const client = {
    from(table: string) {
      const query = {
        select: () => query,
        eq: () => query,
        order: () => query,
        range: (from: number, to: number) => {
          const rows = table === "crm_contacts" ? contactRows : [];
          return Promise.resolve({
            data: rows.slice(from, Math.min(to + 1, from + 150)),
            error: null,
          });
        },
        maybeSingle: () => Promise.resolve({ data: null, error: null }),
      };
      return query;
    },
  };
  const config = {
    get: (key: string) => ({
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
      NODE_ENV: "test",
    })[key],
  };
  const service = new WorkspaceService(config as never);
  Object.defineProperty(service, "storageClient", { value: client as unknown as SupabaseClient });

  const { data } = await service.getWorkspace("user-id");

  assert.equal(data.contacts.length, 270);
  assert.equal(data.contacts[269].id, "contact-269");
});

test("workspace save migration never deletes records omitted from a client snapshot", () => {
  const migration = readFileSync(
    new URL("../supabase/migrations/007_preserve_workspace_records.sql", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(migration, /delete\s+from\s+public\.crm_/i);
  assert.equal((migration.match(/on conflict \(user_id, id\) do update set/gi) || []).length, 7);
});
