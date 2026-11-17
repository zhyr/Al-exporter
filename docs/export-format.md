# Export format & interop contract

Schema version: **1.1.0** · Contract: `al-exporter-interop` **1.0.0**

This document is the authoritative description of what `ai-exporter export` writes and how a
downstream consumer (for example Multi-Agent Timeline) can align and deduplicate records without
guessing from `meta.file_path`.

## 1. Archive layout

```
<output>/
├── manifest.json          # archive index + contract pointer
├── interop.json           # machine-readable capability report
├── .export_state.json     # incremental cursor (schema-version aware)
└── <source>/
    └── <source>-<slug>-<hash>.json
```

## 2. Record shape (v1.1.0)

All new fields are additive. Existing 1.0.0 consumers can keep reading `schema_version`,
`thread_id`, `messages`, `context`, `meta` unchanged.

```json
{
  "schema_version": "1.1.0",
  "thread_id": "…",
  "type": "thread",
  "session": {
    "native_id": "74d80a47-d27c-4006-857f-e9c044edd5a9",
    "native_id_kind": "uuid",
    "native_id_source": "file.basename",
    "cwd": "/Users/me/project",
    "cwd_source": "workbuddy.record",
    "git_remote": "git@github.com:zhyr/example.git",
    "git_remote_source": "cwd_git_config",
    "agent_version": "2.1.0"
  },
  "device": {
    "source_device_id": "dev_390dc1f61b07e31a",
    "source_device_id_basis": "export_host",
    "source_hostname": "host.local",
    "collector_device_id": "dev_390dc1f61b07e31a",
    "collector_hostname": "host.local",
    "collector_platform": "darwin"
  },
  "messages": [
    {
      "role": "assistant",
      "content": "[Tool Use] Bash\n{\"command\":\"ls\"}",
      "timestamp": "2026-01-01T00:00:01.000Z",
      "id": "u-2",
      "id_source": "uuid",
      "line": 2,
      "tool_call": { "name": "Bash", "status": null, "call_id": "toolu_1", "phase": "call" }
    }
  ],
  "context": { "files": [], "diffs": [] },
  "meta": { "source": "claude_code", "project": "example", "created_at": "…", "file_path": "…" }
}
```

### 2.1 `session`

| Field | Meaning | Provenance |
|---|---|---|
| `native_id` | Agent-native session/thread id | Source record (`sessionId` / `session_meta.id`), session file name, or session directory name |
| `native_id_kind` | `uuid` \| `native` \| `composer` \| `none` | How the id is shaped |
| `native_id_source` | Where it came from | `line.sessionId`, `record.session_id`, `file.basename`, `dir.basename`, `codex.session_meta.id`, `vscdb.composer_id` |
| `cwd` | Working directory recorded by the agent/IDE | Claude/Codex/WorkBuddy records, Cursor CLI `meta.json`, vscdb `workspace.json` |
| `cwd_source` | Where `cwd` came from | See values above |
| `git_remote` | Git remote URL | Source record, or `<cwd>/.git/config` when that path is readable locally |
| `git_remote_source` | `source_record` or `cwd_git_config` | `null` when unknown |
| `agent_version` | Agent CLI/app version | Only when the source records it |

`native_id` is never derived from a path hash. `thread_id` remains a stable content/path hash for
archive identity; alignment should use `session.native_id` first and `meta.file_path` only as a
fallback.

### 2.2 `device`

Device identity is separate from agent identity and from file paths.

| Field | Meaning |
|---|---|
| `source_device_id` | Device that owns the agent records |
| `source_device_id_basis` | `export_host` (assumed local) or `declared` (`--source-device`) |
| `source_hostname` | Hostname when the source is the local export host, otherwise `null` |
| `collector_device_id` | Device that ran this export |
| `collector_hostname` / `collector_platform` | Collector metadata |

Consequence: when exporting a mounted backup without `--source-device`, events are attributed to
the collector and `basis` makes that assumption visible. Pass `--source-device <id>` when the
records came from another machine.

### 2.3 `messages[]`

| Field | Meaning |
|---|---|
| `id` | Native per-message id (`uuid`, event id, bubble id, call id where the source provides one). When one source record expands into several messages (for example text + tool blocks), the first keeps the native id and later messages get `<id>#<n>` |
| `id_source` | Source key: `uuid`, `messageId`, `bubbleId`, `id`, `event.id`, `line`, … A `+block` suffix means the id was suffixed to keep it unique within one source record |
| `line` | 1-based line number in the source file; `null` for SQLite/blob stores |
| `timestamp` | Source timestamp only. File mtime is **never** substituted |
| `tool_call` | Structured tool call: `name`, `status`, `call_id`, `phase` (`call` \| `result`) |

`tool_call.status` contains only a status the source explicitly stored (for example WorkBuddy
`completed`). A tool result without a status stays `null`; success is not inferred from the mere
existence of a result. An explicit error flag (`is_error: true`) becomes `"error"`.

## 3. `interop.json`

```json
{
  "contract": "al-exporter-interop",
  "contract_version": "1.0.0",
  "schema_version": "1.1.0",
  "exporter_version": "2.3.0",
  "generated_at": "…",
  "basis": "records_written_in_this_export",
  "records_total": 812,
  "messages_total": 20311,
  "state_skipped_files": 0,
  "device": { "…": "same shape as a record's device block" },
  "fields": {
    "session.native_id": {
      "schema_present": true,
      "scope": "record",
      "applicable": 812,
      "non_empty": 790,
      "empty": 22,
      "records_with_non_empty": 790,
      "status": "partial",
      "notes": "…"
    }
  },
  "capabilities": {
    "native_session_id": "partial",
    "native_message_id": "partial",
    "message_line_number": "partial",
    "message_timestamp": "partial",
    "session_cwd": "partial",
    "git_remote": "partial",
    "agent_version": "partial",
    "device_identity": "full",
    "tool_call_name": "partial",
    "tool_call_status": "empty",
    "tool_call_id": "partial"
  },
  "known_gaps": ["…"]
}
```

Status semantics:

| Status | Meaning |
|---|---|
| `full` | Every applicable record/message has a non-empty value |
| `partial` | Some do, some do not |
| `empty` | The field exists in the schema but is empty/null for every applicable record |
| `not_applicable` | There was nothing to measure (for example no messages) |
| `absent` | Reserved for a field a future exporter may not implement; `schema_present` would be `false` |

The distinction matters: `schema_present: true` + `status: "empty"` means “the exporter supports
this field but the source never provided it”, while `schema_present: false` would mean “this
exporter version has no such field at all”.

If an incremental re-export writes zero records, `interop.json` is carried forward with
`carried_forward: true` instead of being replaced by an empty report.

## 4. Compatibility & migration

- **Additive only.** No 1.0.0 field was removed or renamed.
- **Schema version** is `1.1.0`; `manifest.json` also carries `contract` and a device summary.
- **Re-export required to gain the new fields.** `.export_state.json` now stores
  `schema_version`; a mismatch invalidates the cursor automatically, so unchanged sources are
  re-read once after upgrading.
- **Content hashes change.** `hash` (and the written filename) is computed from the full record,
  which now includes `session`/`device`. Old files are not deleted; `manifest.json` is the
  authoritative index and points at the newly written files. Downstream consumers should read
  `manifest.json`, not glob the directory. Prefer a fresh output directory for a clean archive.
- **`thread_id` is unchanged** for a given source path/session, so downstream dedup keys remain
  stable.
- **Legacy archives remain readable.** Records with `schema_version: "1.0.0"` have no `session`
  or `device`; consumers must treat missing blocks as unknown, not as fabricated empty strings.

## 5. Known gaps (honest list)

| Gap | Behavior |
|---|---|
| Cursor agent transcripts have no per-message timestamp | `timestamp` is omitted; `interop.json` reports `message_timestamp: "partial"` |
| Cursor agent transcript project directory is stored in a lossy encoded folder name | `cwd` stays `null`; it is not decoded/guessed |
| Cursor vscdb rows may merge several composers | `native_id` is set only when the row has exactly one composer id |
| vscdb `aiService.generations` has no session id | `native_id: null`; `cwd` still comes from `workspace.json` |
| Non-session config/rule files have no session identity | `native_id: null`, `native_id_kind: "none"` |
| Most transcript formats do not store tool status | `tool_call.status: null`; no success is inferred |
| Git remote is not in most transcripts | Read from `<cwd>/.git/config` when locally readable, otherwise `null` |
| Mounted remote backups | `cwd` often points to another machine; git remote lookup fails and stays `null` |
| File mtime is not a message time | Never used as `messages[].timestamp` |

## 6. Verification

```bash
# unit + integration
npm test

# inspect a capability report
cat agent-backup/interop.json | jq '.capabilities, .known_gaps'
```

Sample verification against real local data is documented in the commit that introduced schema
1.1.0; it exports a small `HOME` subset so the full archive is not re-scanned.
