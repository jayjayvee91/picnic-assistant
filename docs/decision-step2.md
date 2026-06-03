# Decision: Picnic integration path

**Date:** 2026-06-03
**Step:** 2a investigation
**Status:** Decided
**Decision:** Use **MRVDH `picnic-api` directly** (no `mcp-picnic` sidecar). Level C (slot reservation) is included in v1.

## Context

The plan reached Step 2 with a fork: either depend on MRVDH `picnic-api` directly, or run
[`ivo-toby/mcp-picnic`](https://github.com/ivo-toby/mcp-picnic) as an MCP sidecar process. The
sidecar option was attractive primarily because the original (incomplete) MRVDH README didn't
mention slot reservation, and `mcp-picnic` advertised a `picnic_set_delivery_slot` tool —
suggesting it had reverse-engineered the endpoint, which would be expensive to do ourselves.

## Investigation findings

1. **`mcp-picnic` wraps `picnic-api@^4.0.0` under the hood.** It does not implement its own Picnic
   client. It is a thin TypeScript layer that exposes `picnic-api` methods as MCP tools.
2. **MRVDH `picnic-api` v4 already exposes slot reservation as a public method.** Verified by
   reading the source of `src/domains/cart/service.ts`:
   ```ts
   setDeliverySlot(slotId: string): Promise<Cart>
   ```
   It also exposes `confirmOrder()`, which would enable Level D (auto-checkout) — explicitly out
   of scope for v1 but worth knowing.
3. The MRVDH README is simply incomplete; the capability has always been there in v4.

The premise that slot reservation required either a sidecar or reverse-engineering was wrong.

## Reassessment

With slot reservation available directly, the trade-off changes:

| Factor | MRVDH-direct | mcp-picnic sidecar |
|---|---|---|
| Level C in v1 | ✅ via `setDeliverySlot` | ✅ via the MCP tool, which calls the same method |
| Architecture | Single process | Two processes (bot + sidecar) |
| Tool surface | Tailored — we expose exactly what we need | Fixed at 26 tools; some noise for the LLM |
| `DRY_RUN` gating | Clean — gate at our `PicnicClient` layer | Awkward — must intercept MCP write calls |
| 2FA implementation | We write it (~50 lines) | Already done by `mcp-picnic` |
| Session persistence | We write it (~30 lines) | Already done by `mcp-picnic` |
| Maintenance offload | None — we follow MRVDH directly | Partial — `mcp-picnic` may patch faster |
| Third-party dependency | One (MRVDH) | Two (MRVDH + `mcp-picnic`) |
| Operational complexity | Low — one systemd unit | Higher — sidecar to start, monitor, restart |
| Fit with project constraints (<10 hrs/wk, tight scope) | Better | Worse |

The convenience `mcp-picnic` offers is real but small (~1 day of writing thin wrappers).
The complexity it adds is structural (extra process, MCP plumbing, DRY_RUN awkwardness, an extra
dependency on a personal project's maintenance lifecycle).

## Decision

**MRVDH `picnic-api` v4 directly.** Implement the `PicnicClient` wrapper in
`src/picnic/client.ts` exposing the small set of methods we actually use, including
`setDeliverySlot`. Level C (slot reservation) is included in v1.

## Consequences for the plan

- Step 2 collapses from 2a/2b/2c branches to a single linear implementation (the 2c path).
- Level C moves out of the v2 backlog and into v1.
- "Cart automation" in the Critical Decisions table changes from "Level B baseline; Level C if
  mcp-picnic adopted" to a flat "Level B + Level C".
- The agent gains a `reserve_delivery_slot` tool, used by the weekly draft flow to
  pre-book a slot when the cart is committed.
- No need to evaluate MCP-client integration with the Anthropic SDK at this stage.

## Open follow-ups

- Verify in a smoke test (Step 2 implementation) that `setDeliverySlot` actually behaves as
  expected end-to-end. The signature is right; the behaviour needs real-account confirmation.
- If MRVDH ever breaks and the maintainer is slow to patch, revisit `mcp-picnic` (which depends
  on the same library, so it would likely also be broken — same boat).
