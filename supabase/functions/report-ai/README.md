# `report-ai` Edge Function

The AI stage of the report pipeline. Two operations behind one function:

| `mode`  | In               | Out           | What the model does                                         |
| ------- | ---------------- | ------------- | ----------------------------------------------------------- |
| `plan`  | `UploadProfile`  | `ReportSpec`  | Decides **what to compute** — never a number                |
| `write` | `ComputedReport` | `ReportProse` | Writes prose **about** numbers `engine.ts` already computed |

Called from `src/lib/reports/ai.ts` via `supabase.functions.invoke`, so the
signed-in user's access token rides along automatically.

---

## Why this is a function and not a direct API call

This app ships as a **Tauri desktop binary to users' machines**. Everything Vite
bundles at build time — `VITE_*` env vars included — is readable in plain text
inside the `.app`/`.exe`. An Anthropic API key is a billing credential, so
shipping one in the bundle means handing every user an open tab on the agency's
Anthropic account.

This is the same reasoning `src/lib/supabase.ts` already applies to the
service-role key: the anon key is meant to be public, the privileged key is not.
The Anthropic key lives as a Supabase secret, the app calls this function, and
this function calls Anthropic.

---

## Deploy

The Supabase CLI is not vendored in this repo. Install it first:

```sh
brew install supabase/tap/supabase
```

If `supabase/config.toml` does not exist yet (it did not when this function was
written), initialise and link the project once:

```sh
cd "/Users/muradcheway/Voltris/Projects /Traccr/Tracker for us"
supabase init                              # creates supabase/config.toml
supabase link --project-ref <your-project-ref>
```

`<your-project-ref>` is the 20-character string in your Supabase dashboard URL
(`https://supabase.com/dashboard/project/<project-ref>`), and also the
subdomain in `VITE_SUPABASE_URL` inside `.env.local`.

### 1. Set the secret

```sh
supabase secrets set ANTHROPIC_API_KEY=sk-ant-... --project-ref <your-project-ref>
```

Verify it landed (values are never shown, only names and a digest):

```sh
supabase secrets list --project-ref <your-project-ref>
```

`SUPABASE_URL` and `SUPABASE_ANON_KEY` are injected by the platform — do **not**
set those yourself.

> Never put `ANTHROPIC_API_KEY` in `.env.local`. That file is bundled into the
> desktop build. `supabase secrets set` is the only correct home for it.

### 2. Deploy

```sh
supabase functions deploy report-ai --project-ref <your-project-ref>
```

Redeploy after changing the secret — running functions do not pick up new
secrets until they restart.

### 3. Smoke-test

```sh
# Should be 401: no token, so the function refuses. This is the check that it
# is not an open relay.
curl -i -X POST \
  "https://<your-project-ref>.supabase.co/functions/v1/report-ai" \
  -H "Content-Type: application/json" \
  -d '{"mode":"plan"}'
```

Logs:

```sh
supabase functions logs report-ai --project-ref <your-project-ref>
```

### Local run (optional)

```sh
supabase start
ANTHROPIC_API_KEY=sk-ant-... supabase functions serve report-ai --env-file /dev/null
```

Point the app at `http://localhost:54321` to exercise it end to end.

---

## Contract

**Request** — `POST`, `Authorization: Bearer <supabase access token>`:

```jsonc
{ "mode": "plan",  "profile": { /* UploadProfile */ } }
{ "mode": "write", "computed": { /* ComputedReport */ } }
```

**Success** — `200`:

```jsonc
{ "spec": { /* ReportSpec */ }, "retried": false }   // plan
{ "prose": { /* ReportProse */ } }                   // write
```

**Failure** — non-2xx, always the same shape. `details` is the actionable part
and `src/lib/reports/ai.ts` surfaces it verbatim:

```jsonc
{ "error": "The AI produced a report plan that does not match the report format.",
  "details": ["spec.sections[0].metrics[1].formula: cannot sum column \"Employee\" …"] }
```

| Status | Means |
| ------ | ----- |
| 400 | Bad mode, unparseable body, or a profile with no tables/columns |
| 401 | No or expired Supabase JWT |
| 413 | Prepared payload over 300,000 characters — split the upload |
| 422 | The model refused (`stop_reason: "refusal"`) |
| 500 | `ANTHROPIC_API_KEY` unset, or an outbound-payload safety check tripped |
| 502 | Provider error, truncated/empty/non-JSON response, or model output that failed validation |

---

## The two guarantees, and where they live in the code

### 1. Raw rows never leave the machine

Asserted in code, not just documented.

- `sanitizeProfile()` and `sanitizeComputed()` **rebuild** the outbound payload
  field by field from a whitelist. Anything the caller sends that is not named
  there — `RawTable.rows` included — is structurally dropped, not filtered.
- `assertNoRawRows()` then walks the rebuilt payload and throws on any
  array-of-arrays (the shape of parsed spreadsheet rows) or any key named
  `rows` / `headers` / `rawRows` / `sourceRows` / `cells` / `data`.
- In `write` mode, sections of `kind: "table"` hold near-verbatim source rows,
  so their rows are replaced by a count and a `rowsWithheld` flag. Aggregated
  sections (scorecard, ranking, trend) send grouped values only, capped at 60
  groups.

What *does* travel: column names, inferred types, counts, and the ≤5 sample
values per column that `types.ts` documents as "for the planner to read" —
plus, in write mode, computed aggregates and their group labels (employee
names), which the coach notes cannot be written without.

### 2. Model output is validated before it is returned

`validateReportSpec()` is a hand-written validator over the `ReportSpec` type.
It parses each metric's formula, checks every section `kind`, every resulting
`Aggregation.op` and `Predicate`, and resolves every `tableId` and column name
against the profile the spec was planned from. It also rejects:

- a literal number where a formula belongs (the failure this whole pipeline
  exists to prevent),
- `sum`/`mean`/`median` over a column the profile types as text,
- a target whose `source` is anything but `"proposed"` — the user owns targets,
- `unmappedColumns` naming a column that is not in the upload,
- a field that does not belong to its section kind (a `groupBy` on `statCards`),
- duplicate section ids and duplicate metric keys.

It collects **every** problem rather than stopping at the first: a re-plan costs
a few cents, so one round trip listing six faults beats six round trips.
`validateReportProse()` does the equivalent for write mode, and rejects
commentary keyed to a section id that is not in the report.

The same function also **lowers the wire format to the contract**: formula
strings become `Aggregation` objects, condition strings become `Predicate`s, and
`sortDir` / `limit` are defaulted. Everything downstream — `engine.ts`,
`store.ts`, the renderer — receives exactly the `ReportSpec` that `types.ts`
declares. Nothing outside this function knows the wire format exists.

Since `Section` became a discriminated union, most of these checks are now a
**backstop** for what the schema already makes unrepresentable. They stay: the
schema cannot express "this column exists in this table", "this column is
numeric", or "this `sortBy` names a metric in this same section", and those are
the checks that catch a plausible-looking plan that would render as nonsense.

### 3. A rejected plan is handed back once, not thrown away

Some faults survive the schema — a hallucinated column name, a `sum` over a text
column, a `sortBy` pointing at nothing. The validator's messages name the field,
the problem and the fix, which is exactly what a model needs to correct itself.

So on a validation failure `runPlan()` sends a follow-up turn — the rejected
plan as an assistant turn, then a user turn with the numbered error list — and
validates the result again.

- **Two attempts, maximum.** `MAX_PLAN_ATTEMPTS = 2`. Not a loop: a model that
  fails the same check twice will fail it a third time, and every attempt is
  billed and waited on.
- If the retry also fails, the response carries the errors from the **final**
  attempt in exactly the same `{ error, details }` shape as a single-attempt
  failure, with a closing line saying a retry was already spent.
- The success response carries **`retried: boolean`** alongside the spec, and
  the function logs a line on every retry. `planReport()` keeps its signature
  and still returns a plain `ReportSpec`, but it `console.warn`s when `retried`
  is true. If retries become routine that is a signal the planner prompt needs
  work, and it should be visible rather than hidden.

Write mode does not retry. Its failure mode is a wrong section id, the numbers
are unaffected, and the caller is told it can simply regenerate.

---

## Anthropic request shape

Deliberately minimal, and current as of writing:

- Model `claude-opus-5`, `max_tokens: 16000`, non-streaming.
- Structured output via `output_config: { format: { type: 'json_schema', schema } }`.
  The old top-level `output_format` parameter is deprecated.
- **No** `temperature` / `top_p` / `top_k` — this model returns HTTP 400 for them.
- **No** `thinking: {type:'enabled', budget_tokens: N}` — also a 400. Thinking is
  on by default, so the parameter is omitted entirely.
- `stop_reason === 'refusal'` is checked **before** `response.content` is read.
  A refusal is HTTP 200 with empty or partial content, so code that indexes
  `content[0]` unconditionally crashes instead of explaining itself.

### Why Aggregation and Predicate are formula strings

Read this before editing `REPORT_SPEC_SCHEMA`. Two structured-output limits were
hit in succession here, and they pull against each other.

Modelling `Aggregation` (11 ops), `Section` (7 kinds) and `Predicate` as `anyOf`
discriminated unions, with the recursive ones unrolled to fixed depth:

```text
400 invalid_request_error
Schemas contains too many parameters with union types (86 parameters with type
arrays or anyOf). This causes exponential compilation cost. Reduce the number of
nullable or union-typed parameters (limit: 16 parameters with unions)
```

Flattening each union to one permissive object with every variant field optional
fixed that — and immediately broke the adjacent limit, because flattening is
exactly the operation that turns variant fields into optional ones:

```text
400 invalid_request_error
Schemas contains too many optional parameters (105), which would make grammar
compilation inefficient. Reduce the number of optional parameters in your tool
schemas (limit: 24)
```

For a recursive union like `Aggregation`, neither side of that trade fits. So it
is not in the schema at all. A metric carries a **formula string**, and a
recursive-descent parser in the function lowers it to the `Aggregation` object
`types.ts` already defines. `Predicate` travels the same way as a condition
string. Both then contribute zero unions and zero optional parameters.

```text
count()
sum("Total spend")            mean(...)  median(...)  min(...)  max(...)
distinctCount("Fan name")
shareOfTotal("Total spend", 5)
passthrough("Sales per hour")
ratio(sum("Sales"), sum("Clocked hours"))          -> as: "number"
ratioPercent(sum("Tips"), sum("Total spend"))      -> as: "percent"
countWhere("Total spend" > 100)

conditions:  "Col" > 100   "Col" == "text"   nonEmpty("Col")   isEmpty("Col")
             all(cond, cond)   any(cond, cond)
operators:   ==  !=  >  >=  <  <=
```

Column names are **always** quoted. This is not stylistic: real headers contain
both spaces and parentheses — `Response time (based on clocked hours)` — and are
unparseable bare. A malformed formula is a validation error naming the position
and what was expected, never a crash.

### Section is a discriminated union, and that is where the freed budget went

`sections.items` is an `anyOf` of **seven closed branches**, one per kind, each
with `kind` as a single-value enum and only its own fields present. The earlier
flattened version listed every kind-specific field as optional on one object,
which told the model that a ranking may carry `columns` and a scorecard may carry
`tone` — and it did exactly that, in two consecutive live runs, in spite of a
prompt saying otherwise. Structure beats prose: inside a branch the wrong field
is unrepresentable, so no instruction is needed and the validator becomes a
backstop rather than the only gate.

Three faults that are now structural rather than advisory:

- **`columns` and `tone` on a `ranking`** — those properties do not exist in that
  branch, and `additionalProperties: false` closes it.
- **An empty `metrics` array** — `metrics` is required with `minItems: 1` on the
  three kinds that take an array of them. This was the most repeated fault
  across both live failures.
- **A ranking with two metrics** — that branch takes a singular required
  `metric`, which is also exactly what `types.ts` declares, so no lowering is
  needed. `maxItems` is not supported, so a one-element array could not have been
  enforced.

Current budget, measured by the test suite rather than estimated:

| Schema                | Unions (limit 16) | Optional params (limit 24) | Bytes |
| --------------------- | ----------------- | -------------------------- | ----- |
| `REPORT_SPEC_SCHEMA`  | 1                 | 9                          | 4,631 |
| `REPORT_PROSE_SCHEMA` | 0                 | 2                          | 923   |

The whole seven-branch union costs **one** union parameter, and optional
parameters went *down* from 11 to 9 — most fields became required inside their
own branch rather than optional across a union of all of them. There is room for
several more section kinds before either limit is a concern.

Rules for anyone editing the schema:

1. **Spend unions only on a discriminated union.** The budget is 16 and the
   count is 1 — the `Section` union. Do not reintroduce one for `Aggregation` or
   `Predicate`; that is what put the count at 86. No `type: [...]` arrays either.
2. **Optional properties are the scarce resource.** Both limits count *per
   occurrence* in the expanded schema, not per unique node — an object inlined
   in three places is paid for three times. Before adding an optional field, ask
   whether code can default it. `sortDir`, `limit`, `subtitle` and `description`
   were all removed on that basis and are applied in `validateReportSpec`.
3. **No recursion, and no `additionalProperties` other than `false`.** Both are
   rejected outright.
4. Also unsupported, and so absent here: `minimum` / `maximum` / `multipleOf`,
   `minLength` / `maxLength`, `maxItems`, `minItems` other than 0 or 1, external
   `$ref`, and `enum` values that are not scalars. `required: []` is undocumented,
   so `obj()` omits the key entirely when nothing is required.

Separately, `ReportProse.sectionCommentary` and `perGroupNotes` are
`Record<string, …>`, which a JSON schema cannot express at all:
`additionalProperties` may only be `false`. The model emits arrays of pairs and
`validateReportProse()` maps them back to the shape `types.ts` declares.

Cost: roughly $5/$25 per million input/output tokens, so a report is a few
cents. There is no caching or batching here on purpose — it would be complexity
bought for nothing.

---

## Testing

The parser and the validator are pure functions with no network dependency, so
they are exercised directly. The retry path is driven through the exported
`handler()` with a stubbed Anthropic client.

**Parser** — every verb, nested `ratio`, whitespace tolerance, quoted names
containing spaces, parentheses, commas, em dashes and escaped quotes, all six
comparison operators, `all`/`any` nesting, and sixteen malformed inputs
(unbalanced parens, unknown verb, unquoted column, missing comma, wrong arity,
trailing junk, a bare `2.14`, empty string, empty column name, non-integer
`topN`, missing ratio operand, unterminated quote, single-condition `all()`,
`=` as an operator, missing value, missing column).

**Schema** — asserts the union is actually discriminating: seven branches, each
with a single-value `kind` enum and `additionalProperties: false`; `metrics`
required with `minItems: 1` on exactly the three kinds that take an array of
them; `ranking` carrying a singular required `metric`; `columns` / `tone` /
`brief` / `body` / `bucketBy` each existing only in the branch that owns them;
`tableId` absent from `narrative` and `callout`; and the exact optional-field set
per branch. Then both counters against both limits.

**Validator** — one valid spec and sixteen malformed ones: bad verb, unknown
column, missing `kind`, a literal number as the formula (both as a string and as
a raw number), a target claiming `source: "user"`, unknown `tableId`, a `sum`
over a text column, unbalanced parens, a malformed filter, a filter naming an
unknown column, a `groupBy` on `statCards`, a `tableId` on `narrative`, a ranking
sending a `metrics` array, a `sortDir` that is not in the schema, and one spec with three
faults at once to prove errors are collected rather than short-circuited.

It then asserts the **lowering** is correct — formulas became `Aggregation`
objects, no `formula` key survives, a column name with parentheses round-trips,
the filter became a `Predicate`, `sortDir`/`limit` defaulted, ranking
`metrics[0]` became `metric` — and that both schema counters stay under their
limits, with self-checks proving the counters actually see what they claim to.

**Retry** — three scenarios through `handler()`, with the model stubbed and
every request recorded:

1. Valid first time: one model call, `retried: false`.
2. Invalid then corrected: two calls, HTTP 200, `retried: true`, the corrected
   spec returned. Asserts the second call is a three-turn conversation whose
   assistant turn echoes the rejected plan and whose user turn carries the
   numbered errors — checked against the exact messages from the live failure
   (`a "scorecard" section does not take a "tone"`, `expected a non-empty array
   of metrics`, `a narrative section needs a brief`).
3. Invalid twice: **exactly two** model calls and never a third (a third stub
   response is queued and asserted to go unused), HTTP 502, and the details are
   the final attempt's errors rather than the first attempt's.
