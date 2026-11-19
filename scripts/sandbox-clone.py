#!/usr/bin/env python3
"""
Copy ONE store of a Kustomer Suite database into the sandbox schema, as a SQL file.

What it reads (read-only SELECTs, through `docker exec ... psql`): the store's conversations,
messages, tool execution logs, knowledge base passages (with their vectors) and the latest quota row.

What it does not copy, by construction: contacts, phone numbers or identities, IP addresses,
conversation metadata, user ids, and the tool logs' endpoint URLs, request headers, request bodies
and response bodies (they can hold credentials; the MCP never returns them either). The text that
remains (message content, previews, tool arguments and errors) goes through the redaction rules of
spec/tools.json, the same ones the server applies on the way out, so a phone number or an email is
not stored at all; names given with --mask are replaced too. The result is checked after the
scrub and the script refuses to write a file in which a pattern or a name is still found.

The output is real data from a real store. DO NOT COMMIT IT: a public git history keeps it forever.
Write it outside the repository (or to a path that is git-ignored) and apply it with psql.

  python3 scripts/sandbox-clone.py --docker kustomer-postgres-1 --store-id <uuid> --mask "Name One,Name Two" --out /path/not/in/git.sql
"""
import argparse, json, os, re, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
REPLACEMENT_NAME = "Budi"


def psql(cmd, sql):
    r = subprocess.run(cmd, shell=True, input=sql, capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit(f"psql failed: {r.stderr.strip()[:300]}")
    return r.stdout


def jsonl(cmd, sql):
    out = psql(cmd, "\\pset format unaligned\n\\pset tuples_only on\n" + sql)
    return [json.loads(l) for l in out.splitlines() if l.strip()]


def ts(col):
    return f"to_char({col} at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"')"


def tsu(col):
    # Full precision, for the columns the answers are ORDERED by. The API shows whole seconds; ordering by those would
    # make rows that differ by microseconds look equal and put them in the wrong order.
    return f"to_char({col} at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"')"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--psql")
    ap.add_argument("--docker")
    ap.add_argument("--db", default="kustomer")
    ap.add_argument("--store-id", required=True)
    ap.add_argument("--mask", default="", help="comma-separated names to replace (whole words, case-insensitive) in the text; list the longest first")
    ap.add_argument("--embedding-model", default="text-embedding-ada-002", help="the model the stored vectors were made with")
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    if a.docker:
        a.psql = f"docker exec -i {a.docker} sh -c 'psql -U \"${{POSTGRES_USER:-postgres}}\" -d {a.db} -v ON_ERROR_STOP=1 -q'"
    if not a.psql:
        sys.exit("give --psql or --docker")
    if not UUID.match(a.store_id):
        sys.exit("--store-id must be a uuid")
    if os.path.abspath(a.out).startswith(ROOT + os.sep) and not os.path.abspath(a.out).startswith(os.path.join(ROOT, "supabase", ".local")):
        sys.exit("refusing to write real data inside the repository; choose a path outside it (or under supabase/.local, which is git-ignored)")
    S = a.store_id

    rules = json.load(open(os.path.join(ROOT, "spec", "tools.json")))["redaction"]["rules"]
    rx = [(re.compile(r["pattern"]), r["replacement"], r["name"]) for r in rules]
    names = [n.strip() for n in a.mask.split(",") if n.strip()]
    nrx = [re.compile(r"(?<![A-Za-z0-9])" + re.escape(n) + r"(?![A-Za-z0-9])", re.I) for n in names]  # whole words: "Andi" must not hit "kandidat"
    # Links in the text point at systems that are not part of this repository (a partner's staging host, a payment page).
    url_rx = re.compile(r"https?://[^\s)\]\"'<>]+")
    counts = {r[2]: 0 for r in rx} | {"mask": 0, "url": 0}

    def scrub(s):
        if not isinstance(s, str):
            return s
        for pat, rep, name in rx:
            s, n = pat.subn(rep, s)
            counts[name] += n
        s, n = url_rx.subn("[link]", s)
        counts["url"] += n
        for pat in nrx:
            s, n = pat.subn(REPLACEMENT_NAME, s)
            counts["mask"] += n
        return s

    store = jsonl(a.psql, f"select row_to_json(t) from (select id, name from stores where id = '{S}') t;")
    if not store:
        sys.exit("no such store")

    convs = jsonl(a.psql, f"""select row_to_json(t) from (
      select c.id, c.store_id, c.channel, coalesce(c.handover_status, 'none') as handover_status,
             {tsu('c.started_at')} as started_at, {tsu('coalesce(c.last_message_at, c.started_at)')} as activity,
             jsonb_strip_nulls(jsonb_build_object(
               'id', c.id, 'store_id', c.store_id, 'started_at', {ts('c.started_at')}, 'ended_at', {ts('c.ended_at')},
               'message_count', c.message_count, 'total_tokens', c.total_tokens, 'status', c.status,
               'read_at', {ts('c.read_at')}, 'unread', (c.read_at is null or c.unread_count > 0),
               'handover_status', c.handover_status, 'handover_requested_at', {ts('c.handover_requested_at')},
               'channel', c.channel, 'last_message_at', {ts('c.last_message_at')},
               'last_message_preview', (select substring(m.content, 1, 120) from messages m where m.conversation_id = c.id order by m.created_at desc limit 1)
             )) as body
      from conversations c where c.store_id = '{S}') t;""")
    msgs = jsonl(a.psql, f"""select row_to_json(t) from (
      select m.id, m.conversation_id,
             row_number() over (partition by m.conversation_id order by m.created_at, m.id) - 1 as seq,
             jsonb_strip_nulls(jsonb_build_object(
               'id', m.id, 'role', m.role, 'content', m.content, 'kb_sources', m.kb_sources,
               'response_source', m.response_source, 'confidence', m.confidence, 'status', m.status, 'source', m.source,
               'is_historical', m.is_historical, 'message_type', m.message_type, 'created_at', {ts('m.created_at')},
               'sent_at', {ts('m.sent_at')}, 'tokens', m.tokens, 'prompt_tokens', m.prompt_tokens,
               'completion_tokens', m.completion_tokens, 'latency_ms', m.latency_ms)) as body
      from messages m join conversations c on c.id = m.conversation_id where c.store_id = '{S}') t;""")
    logs = jsonl(a.psql, f"""select row_to_json(t) from (
      select l.store_id, l.conversation_id, l.tool_name, {tsu('l.created_at')} as created_at,
             jsonb_strip_nulls(jsonb_build_object(
               'store_id', l.store_id, 'tool_name', l.tool_name, 'created_at', {ts('l.created_at')}, 'called_at', {ts('l.called_at')},
               'error_type', l.error_type, 'response_status', l.response_status, 'response_time_ms', l.response_time_ms,
               'conversation_id', l.conversation_id, 'ai_arguments', l.ai_arguments, 'error_message', l.error_message,
               'corrections', l.corrections)) as body
      from tool_execution_logs l where l.store_id = '{S}') t;""")
    kb = jsonl(a.psql, f"""select row_to_json(t) from (
      select ke.knowledge_base_id as kb_item_id, kb.title, ke.chunk_text, ke.embedding::text as embedding
      from knowledge_embeddings ke join knowledge_base kb on kb.id = ke.knowledge_base_id
      where kb.store_id = '{S}' and kb.status = 'indexed' and coalesce(kb.is_active, true) order by ke.id) t;""")
    quota = jsonl(a.psql, f"select to_jsonb(q) from (select * from quota_usage where store_id = '{S}' order by period_start desc limit 1) q;")

    # Scrub the text that stays. Only the fields that carry free text, never ids or timestamps.
    for c in convs:
        if "last_message_preview" in c["body"]:
            c["body"]["last_message_preview"] = scrub(c["body"]["last_message_preview"])
    for m in msgs:
        m["body"]["content"] = scrub(m["body"].get("content"))
    for l in logs:
        for k in ("ai_arguments", "error_message"):
            if k in l["body"]:
                l["body"][k] = scrub(l["body"][k])
    q = {}
    if quota:
        keep = ["store_id", "whatsapp_used", "whatsapp_limit", "telegram_used", "telegram_limit", "livechat_used", "livechat_limit",
                "instagram_used", "instagram_limit", "api_used", "api_limit", "whatsapp_conversations_used", "whatsapp_conversations_limit",
                "telegram_conversations_used", "telegram_conversations_limit", "instagram_conversations_used", "instagram_conversations_limit",
                "livechat_conversations_used", "livechat_conversations_limit", "api_conversations_used", "api_conversations_limit",
                "ai_tokens_used", "ai_tokens_billed", "ai_tokens_limit"]
        q = {k: quota[0].get(k) for k in keep if k in quota[0]}
        for k in ("period_start", "period_end"):
            v = str(quota[0][k]).replace("+00:00", "Z")  # the API answers RFC 3339 with Z
            q[k] = v if "T" in v else v + ("T00:00:00Z" if k == "period_start" else "T23:59:59Z")
        q["updated_at"] = str(quota[0].get("updated_at")).replace("+00:00", "Z")

    # Verify the scrub on the free-text fields (ids and timestamps are digits and can look like a phone number to the
    # pattern, which is why the server applies the rules to text only): nothing a rule matches, no masked name.
    texts = [c["body"].get("last_message_preview") for c in convs] + [m["body"].get("content") for m in msgs]
    texts += [l["body"].get(k) for l in logs for k in ("ai_arguments", "error_message")]
    text_blob = "\n".join(t for t in texts if isinstance(t, str))
    for pat, rep, name in rx:
        left = [m for m in pat.findall(text_blob) if m != rep]
        if left:
            sys.exit(f"scrub failed: {len(left)} '{name}' match(es) remain")
    for pat in nrx:
        if pat.search(text_blob):
            sys.exit("scrub failed: a masked name remains")
    if url_rx.search(text_blob):
        sys.exit("scrub failed: a link remains")
    # And nothing that must not be there at all, anywhere in what will be written.
    blob = json.dumps([[c["body"] for c in convs], [m["body"] for m in msgs], [l["body"] for l in logs]], ensure_ascii=False)
    for banned in ("request_headers", "request_body", "response_body", "endpoint_url", "ip_address", "contact_id", "external_id"):
        if banned in blob:
            sys.exit(f"scrub failed: '{banned}' is present")

    lit = lambda o: "'" + json.dumps(o, ensure_ascii=False).replace("'", "''") + "'"
    out = ["-- Generated by scripts/sandbox-clone.py. REAL DATA of one store, scrubbed. NOT for git.", "begin;",
           "truncate sandbox.messages, sandbox.conversations, sandbox.tool_logs, sandbox.knowledge, sandbox.meta restart identity cascade;",
           f"insert into sandbox.meta (key, value) values ('store', {lit(store[0])}::jsonb), ('quota', {lit(q)}::jsonb), ('embedding_model', {lit(a.embedding_model)}::jsonb);",
           f"""insert into sandbox.conversations (id, store_id, channel, handover_status, started_at, activity, body)
              select (x->>'id')::uuid, (x->>'store_id')::uuid, x->>'channel', x->>'handover_status', (x->>'started_at')::timestamptz, (x->>'activity')::timestamptz, x->'body'
              from jsonb_array_elements({lit(convs)}::jsonb) x;""",
           f"""insert into sandbox.messages (id, conversation_id, seq, body)
              select x->>'id', (x->>'conversation_id')::uuid, (x->>'seq')::int, x->'body' from jsonb_array_elements({lit(msgs)}::jsonb) x;""",
           f"""insert into sandbox.tool_logs (store_id, conversation_id, tool_name, created_at, body)
              select (x->>'store_id')::uuid, nullif(x->>'conversation_id', '')::uuid, x->>'tool_name', (x->>'created_at')::timestamptz, x->'body' from jsonb_array_elements({lit(logs)}::jsonb) x;""",
           f"""insert into sandbox.knowledge (store_id, kb_item_id, title, chunk_text, embedding)
              select '{S}'::uuid, x->>'kb_item_id', x->>'title', x->>'chunk_text', (x->>'embedding')::extensions.vector from jsonb_array_elements({lit(kb)}::jsonb) x;""",
           "commit;"]
    with open(a.out, "w") as f:
        f.write("\n".join(out) + "\n")
    os.chmod(a.out, 0o600)
    print(f"store: {store[0]['name']}")
    print(f"conversations {len(convs)}, messages {len(msgs)}, tool logs {len(logs)}, passages {len(kb)} (with vectors), quota row {'yes' if q else 'no'}")
    print(f"scrubbed: {counts}")
    print(f"wrote {a.out} ({os.path.getsize(a.out)} bytes, mode 600). Not for git.")


if __name__ == "__main__":
    main()
