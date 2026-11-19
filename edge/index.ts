import { handleMcp } from "./handler.js";

// Entry point for Supabase Edge Functions (Deno). Secrets, set with
// `supabase secrets set`: DEMO_TOKEN (required), DEMO_FIXTURE (hard | basic).
declare const Deno: { serve(h: (req: Request) => Response | Promise<Response>): void; env: { get(k: string): string | undefined } };

Deno.serve((req) =>
  handleMcp(req, {
    token: Deno.env.get("DEMO_TOKEN"),
    fixture: Deno.env.get("DEMO_FIXTURE") === "basic" ? "basic" : "hard",
  }),
);
