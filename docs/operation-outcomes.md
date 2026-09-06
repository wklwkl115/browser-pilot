# Operation outcomes and continued observation

Browser execution, assertion verification, and business outcome are independent. A successful browser response or a `verified` assertion is not, by itself, a successful business task. For example, an assertion that an error message appeared can correctly return `verified` while an explicitly declared failure condition establishes `business.status: "failed"`.

## Result contract

Writes through `browser_execute`, `browser_command`, and mutating `browser_tabs` actions return an `operationId`, an `execution` receipt, and a `business` result alongside the existing tool result. `verification` remains the result of the caller's `expect`; each assertion result carries `scope: "assertion"`, `operationId`, and `checkedAt`.

| Field                                    | Meaning                                                                                                                                                                                            |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `execution.status: "not_dispatched"`     | The primary browser action did not enter its execution boundary. This includes cancellation while queued and an explicit browser rejection before dispatch. Review the cause before a new attempt. |
| `execution.status: "dispatched_unknown"` | Delivery or execution outcome is uncertain, including a lost response or an execution timeout. The operation may have produced side effects. Do not automatically replay it.                       |
| `execution.status: "returned"`           | A browser operation response was received; `response` distinguishes `success` from `error`. An error may follow partial side effects. Neither response proves business success or rollback.        |
| `verification.status`                    | `verified`, `unmet`, or `inconclusive` for exactly the supplied assertion. It does not classify the business task.                                                                                 |
| `business.status`                        | `succeeded`, `failed`, or `unknown`, based only on explicit `business.success` / `business.failure` declarations. No declaration means `unknown`.                                                  |
| `recovery`                               | `automaticReplay` is always false. `observe_only` calls for inspection or continued observation; `retry_after_review` is available for proven non-dispatch, not permission to retry indefinitely.  |
| `evidence.resourceUri`                   | When persistence succeeds, the operation receipt, assertion evidence and correlated bridge request phases are saved as a project artifact.                                                         |

An ACK identifies a protocol execution boundary; it is not a commit acknowledgement from the website. A missing ACK does not prove that a message was not delivered. If a response is lost between MCP and the daemon, the client still reports the operation ID allocated before the call, so an existing daemon record can be queried.

Business failure is established by a verified failure condition. Business success requires a verified success condition and, when a failure condition is declared, a conclusive unmet failure condition. If success and failure are both verified, the result is `unknown` with a conflict explanation. An unmet success condition alone never establishes failure. These conclusions are bounded by the declared evidence and its observation time; they are not predictions that the state can never change later.

## Declarative conditions

`expect` accepts the existing read-only JavaScript expression, existing `{ "ref": ..., "state": ... }` assertion, or the following declarative conditions. `business.success` and `business.failure` accept declarative conditions only.

| Condition         | Example                                                                                                                                                       | Evidence boundary                                                                                                                                                           |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Element state     | `{ "ref": "bp-ref://control/...", "state": { "checked": true } }`                                                                                             | Existing ref ownership and freshness checks apply.                                                                                                                          |
| Text              | `{ "text": { "selector": "#status", "match": { "equals": "Saved" } } }`                                                                                       | Exactly one element in the target document; `contains` is also supported. This is UI evidence.                                                                              |
| Input value       | `{ "value": { "selector": "#record-id", "equals": "CASE-001" } }`                                                                                             | Exactly one element, complete string value; password inputs are unavailable.                                                                                                |
| URL               | `{ "url": { "contains": "/records/CASE-001" } }`                                                                                                              | Current target URL; `equals` is also supported.                                                                                                                             |
| Captured response | `{ "request": { "url": "https://example.test/api/records/CASE-001", "method": "GET", "status": 200, "json": [{ "pointer": "/id", "equals": "CASE-001" }] } }` | A unique request captured after the pre-write recorder baseline. HTTP status can be checked once headers arrive; JSON Pointer comparisons require a complete response body. |
| All / any         | `{ "allOf": [condition1, condition2] }` or `{ "anyOf": [condition1, condition2] }`                                                                            | At most two combination levels, eight children per group. Observations are not an atomic server transaction.                                                                |

Selectors are data inside generated read expressions, not caller-supplied JavaScript. Missing or ambiguous elements, truncated values, unavailable response bodies, and incomplete observations produce `inconclusive`. Text/value selectors address the selected target document; they do not automatically traverse cross-origin frames.

Request checks read an already active `network` recorder; they neither start recording nor issue the website's business requests. Start the recorder before the write and enable `captureBodies` when JSON fields are required. The website or an explicit task adapter must perform the save and readback. Use a unique business identifier in the URL or an explicit `requestId` when matching would otherwise be ambiguous. Recorder replacement or evidence overflow makes the condition inconclusive. HTTP 2xx by itself is weak evidence and does not prove persistence.

For example, after starting the recorder, a form whose own handler saves and reads back the record can use:

```json
{
  "command": { "cmd": "input.ref", "ref": "bp-ref://control/...", "action": "click" },
  "expect": { "text": { "selector": "#status", "match": { "equals": "Saved" } } },
  "business": {
    "success": {
      "allOf": [
        { "request": { "url": "https://example.test/api/records?key=unique-1", "method": "POST", "status": 201 } },
        {
          "request": {
            "url": "https://example.test/api/records/unique-1",
            "method": "GET",
            "status": 200,
            "json": [
              { "pointer": "/id", "equals": "unique-1" },
              { "pointer": "/title", "equals": "Expected title" }
            ]
          }
        }
      ]
    },
    "failure": {
      "request": { "url": "https://example.test/api/records?key=unique-1", "method": "POST", "status": 503 }
    }
  },
  "verificationWaitMs": 5000
}
```

An optimistic `Saved` message cannot satisfy this success declaration while the request is pending or has failed. Other undeclared failure responses can leave the business result unknown; the runtime does not invent additional business rules. If the site does not expose a suitable readback, do not claim database-level confirmation.

## Bounded waiting and recovery

`verificationWaitMs` on write tools controls the assertion/business observation budget, from 100 to 45,000 milliseconds (default 5,000), bounded by the operation deadline. It does not increase retry counts or replay the primary action. For longer asynchronous work, use the read-only `browser_operation` tool:

```json
{ "operationId": "<ID from the write result or error>", "action": "status" }
```

```json
{ "operationId": "<same ID>", "action": "wait", "waitMs": 5000 }
```

`status` returns the last receipt and evidence without reading the page. `wait` re-evaluates stored declarative conditions against the pinned target under a bounded budget. It keeps the same operation ID and never changes an uncertain execution receipt into a confirmed one merely because business state was later observed. A returned `business.status: "succeeded"` can therefore coexist with `execution.status: "dispatched_unknown"` after a successful readback.

The registry retains observation plans only, not the original write callback or script. Arbitrary legacy JavaScript expectations are not resumed by this tool; `continuation.available` reports whether declarative checks are available. If a business declaration accompanies a legacy expression, only the business declaration is re-evaluated; the legacy assertion retains its earlier `checkedAt`. Concurrent waits for an active operation are rejected. Queued or in-flight observation cancellation does not undo the original write.

Records are scoped to the command host and project, held in memory for up to 30 minutes, and bounded to 256 entries. Inactive records may be evicted earlier at capacity. Restarting the daemon loses the registry; saved operation artifacts remain subject to manual retention. An unavailable record is not proof of non-execution and never authorizes replay.

Operation IDs correlate calls and prevent reuse of an ID still retained by the local host. They are not third-party idempotency keys and do not guarantee exactly-once execution. A new attempt receives a new ID. Safe retry after uncertain execution depends on site-supported idempotency or authoritative business readback, not local deduplication alone.

## Request aggregation and document boundaries

Execution receipts aggregate dispatch-phase **write** requests. Auxiliary reads cannot establish write dispatch. An active outer dispatch remains uncertain until it finishes; a later rejected request cannot erase an earlier write, and an unknown later write keeps the combined result unknown. The bounded request evidence list retains a conservative aggregate after eviction. `returned` describes known execution responses, including a partially completed composite operation; it does not mean every intended step or the business transaction succeeded.

Text/value conditions bind to the document's pre-write `performance.timeOrigin`. An unidentified or different document yields `inconclusive`, including during `browser_operation` continuation. To validate a deliberate navigation, combine the DOM condition with an exact destination URL in the same `allOf`, for example `{ "allOf": [{ "url": { "equals": "https://example.test/invoices/INV-2048/saved" } }, { "text": { "selector": "#status", "match": { "equals": "Saved" } } }] }`. The DOM read checks its own URL in the same expression. A separate `anyOf` URL branch does not authorize unrelated DOM branches. Declare a unique record identifier or server readback when business identity matters: a matching URL or text alone cannot establish persistence or causation.
