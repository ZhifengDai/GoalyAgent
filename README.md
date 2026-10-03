# Insurance Claims SOP Agent

An AI-powered insurance claims support agent that follows a strict Standard Operating Procedure (SOP) while maintaining natural conversation.

## Overview

The agent enforces a 4-phase workflow:

```
VERIFY_ID → RESOLVE_INTENT → PROCESS_CASE → POST_PROCESS → DONE
                                                          ↘ HUMAN_HANDOFF
```

**Key design principle:** strict where the SOP demands it, flexible where reasoning helps.

- **VERIFY_ID** — collects ≥3 PII fields before revealing any claim data; remembers case hints said early
- **RESOLVE_INTENT** — interprets natural language, resolves ambiguous case references
- **PROCESS_CASE** — answers grounded in claim data only; handles emotional escalation with empathy
- **POST_PROCESS** — offers email summary; routes to human agent when needed

## Quick Start (Docker)

```bash
docker run -e OPENAI_API_KEY=<your-key> -p 3000:3000 insurance-claims-agent
```

Then open [http://localhost:3000](http://localhost:3000).

## Quick Start (Local)

Requires **Node.js 22+** (no npm install needed — zero external dependencies).

```bash
# 1. Set your OpenAI API key
export OPENAI_API_KEY=sk-...

# 2. Start the server
node --experimental-strip-types apps/insurance_claims/server.ts
```

Then open [http://localhost:3000](http://localhost:3000).

## Build Docker Image

```bash
docker build -t insurance-claims-agent .
docker run -e OPENAI_API_KEY=<your-key> -p 3000:3000 insurance-claims-agent
```

## Configuration

| Environment Variable | Default | Description |
|---|---|---|
| `OPENAI_API_KEY` | *(required)* | OpenAI API key |
| `OPENAI_MODEL` | `gpt-4.1` | Model name |
| `OPENAI_TIMEOUT_MS` | `60000` | Request timeout in milliseconds |
| `PORT` | `3000` | HTTP server port |

## Test Data

**Sample call (full workflow):**
> "I'm the policyholder. My name is Margaret Chen, policy POL-9921. I'm calling about my denied healthcare claim from January. DOB is 1985-03-15, SSN last four is 4472."

Expected: agent verifies identity, remembers the denied-claim hint from VERIFY_ID, resolves intent in PROCESS_CASE without re-asking, then offers an email summary.

**Representative call:**
> "Hi, I'm David Chen calling on behalf of my mother Margaret Chen. Policy POL-9921. Her DOB is 1985-03-15, SSN last four 4472."

Expected: agent records both names separately, verifies the policyholder's identity, processes the case normally.

More test accounts are in `apps/insurance_claims/data/policyholders.json`.

## Architecture

```
agent-loop/          # Generic model-agnostic agent loop (ModelFn, tool runner)
apps/insurance_claims/
  server.ts          # HTTP + SSE server
  harness/
    handler.ts       # Per-message orchestration (state → tools → loop)
    guard.ts         # Pre-tool safety gate (phase enforcement)
    persist.ts       # Post-tool event writer (side effects → event log)
  session/
    events.ts        # Append-only event log
    facts.ts         # Event → SessionFacts reducer
    state.ts         # Facts → SOP phase derivation
  prompts/
    system-prompt.ts # System prompt with SOP rules
    context-builder.ts # Runtime context injected per turn
  tools/             # Tool definitions (record_user_information, verify_identity, etc.)
  data/              # Policyholders and claims JSON
  public/index.html  # Chat UI (SSE streaming, phase progress bar, email consent)
```

## Key Technical Decisions

- **Event sourcing** — all session state derived from an append-only event log; no mutable session objects
- **Phase-gated tools** — `guard.ts` blocks tool calls not allowed in the current phase
- **`finishTurn` loop control** — agent loop stops immediately when phase reaches DONE or HUMAN_HANDOFF, preventing OpenAI 400 errors from empty tool arrays
- **Zero npm dependencies** — runs on Node.js 22 built-ins + native fetch; Docker image stays minimal
