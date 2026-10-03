import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { createOpenAIModel } from "../../agent-loop/openai-model.ts";
import { handleMessage } from "./harness/handler.ts";
import { getEvents } from "./session/events.ts";
import { reduceSessionEvents } from "./session/facts.ts";
import { deriveSopState } from "./session/state.ts";
import { prepareSummaryEmail } from "./tools/send-summary-email.ts";
import type { Message } from "../../agent-loop/types.ts";

// ── Logging ───────────────────────────────────────────────────────────────────

const LOG_DIR = path.join(import.meta.dirname, "logs");
fs.mkdirSync(LOG_DIR, { recursive: true });

function makeLogger(sessionId: string) {
  const logFile = path.join(LOG_DIR, `${sessionId}.log`);
  const stream = fs.createWriteStream(logFile, { flags: "a" });
  return (line: string) => {
    stream.write(`[${new Date().toISOString()}] ${line}\n`);
  };
}

// ── Session store ─────────────────────────────────────────────────────────────

interface Session {
  id: string;
  history: Message[];
  log: (line: string) => void;
}

const sessions = new Map<string, Session>();

function getOrCreateSession(id: string): Session {
  if (!sessions.has(id)) {
    const log = makeLogger(id);
    log(`=== Session started: ${id} ===`);
    sessions.set(id, { id, history: [], log });
  }
  return sessions.get(id)!;
}

// ── Model ─────────────────────────────────────────────────────────────────────

const model = createOpenAIModel({});

// ── Request helpers ───────────────────────────────────────────────────────────

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function json(res: http.ServerResponse, status: number, data: unknown) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(body);
}

function cors(res: http.ServerResponse) {
  res.writeHead(204, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end();
}

// ── Static file server ────────────────────────────────────────────────────────

const PUBLIC_DIR = path.join(import.meta.dirname, "public");

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse) {
  const urlPath = req.url === "/" ? "/index.html" : (req.url ?? "/index.html");
  const filePath = path.join(PUBLIC_DIR, urlPath);

  // Prevent directory traversal
  if (!filePath.startsWith(PUBLIC_DIR)) {
    json(res, 403, { error: "Forbidden" });
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      json(res, 404, { error: "Not found" });
      return;
    }
    const ext = path.extname(filePath);
    const mime: Record<string, string> = {
      ".html": "text/html",
      ".css": "text/css",
      ".js": "application/javascript",
    };
    res.writeHead(200, {
      "Content-Type": mime[ext] ?? "application/octet-stream",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(data);
  });
}

// ── API handlers ──────────────────────────────────────────────────────────────

// POST /api/session → { session_id }
async function handleCreateSession(res: http.ServerResponse) {
  const sessionId = `session_${Date.now()}`;
  getOrCreateSession(sessionId);
  json(res, 200, { session_id: sessionId });
}

// POST /api/session/:id/message  body: { message: string }
// Streams SSE: data: { type, ... }
async function handleSendMessage(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  sessionId: string,
) {
  let body: { message?: string };
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    json(res, 400, { error: "Invalid JSON" });
    return;
  }

  const userMessage = (body.message ?? "").trim();
  if (!userMessage) {
    json(res, 400, { error: "message is required" });
    return;
  }

  const session = getOrCreateSession(sessionId);
  session.log(`[USER] ${userMessage}`);

  // SSE headers
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Access-Control-Allow-Origin": "*",
  });

  function send(data: unknown) {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }

  const nowIso = new Date().toISOString();

  try {
    const result = await handleMessage({
      sessionId,
      userMessage,
      model,
      priorMessages: session.history,
      nowIso,
      emit: async (event) => {
        if (event.type === "text_delta") {
          send({ type: "text_delta", delta: event.delta });
          if (event.delta) session.log(`[AGENT] ${event.delta.slice(0, 120)}`);
        }
        if (event.type === "agent_end") {
          if (event.reason !== "complete" && event.reason !== "stopped") {
            session.log(`[AGENT_END] reason=${event.reason} error=${event.error ?? "none"}`);
          }
        }
        if (event.type === "tool_execution_start") {
          session.log(`[TOOL] ${event.call.name} ${JSON.stringify(event.call.arguments)}`);
          send({ type: "tool_start", name: event.call.name });
        }
        if (event.type === "tool_execution_end") {
          session.log(`[TOOL RESULT] ${JSON.stringify(event.result.content).slice(0, 500)}`);
          send({ type: "tool_end", name: event.call.name });
          // Emit dedicated event when email is successfully sent
          if (event.call.name === "send_summary_email" && !event.result.isError) {
            try {
              const payload = JSON.parse(event.result.content);
              if (payload.status === "sent") {
                const facts = reduceSessionEvents(getEvents(sessionId));
                const draft = prepareSummaryEmail(sessionId);
                send({
                  type: "email_sent",
                  send_id: payload.send_id,
                  recipient: facts.customer_decisions.recipient_email ?? null,
                  subject: draft.status === "ok" ? draft.draft.subject : null,
                  body: draft.status === "ok" ? draft.draft.body : null,
                });
              }
            } catch { /* ignore parse errors */ }
          }
        }
      },
    });

    // Update history
    const newMessages = result.context.messages.slice(session.history.length);
    session.history.push(...newMessages);

    // Derive state for client
    const facts = reduceSessionEvents(getEvents(sessionId));
    const state = deriveSopState(facts);
    const fields = Object.keys(facts.identity.provided_fields);
    const fieldsLog = Object.entries(facts.identity.provided_fields).map(([k, v]) => `${k}=${v?.value}`).join(", ");

    session.log(`[STATE] phase=${state.phase} fields={${fieldsLog}} rev=${facts.identity.identity_revision} verification=${facts.identity.verification?.status ?? facts.identity.verification_failure?.status ?? "null"}`);

    send({
      type: "done",
      phase: state.phase,
      collected_fields: fields,
    });
  } catch (err) {
    session.log(`[ERROR] ${err instanceof Error ? err.message : String(err)}`);
    send({ type: "error", message: err instanceof Error ? err.message : "Unknown error" });
  }

  res.end();
}

// POST /api/session/:id/start → SSE: agent greeting (trigger not shown to user)
async function handleStartSession(res: http.ServerResponse, sessionId: string) {
  const session = getOrCreateSession(sessionId);

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Access-Control-Allow-Origin": "*",
  });

  function send(data: unknown) {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }

  const nowIso = new Date().toISOString();

  try {
    const result = await handleMessage({
      sessionId,
      userMessage: "[call_started]",
      model,
      priorMessages: [],
      nowIso,
      emit: async (event) => {
        if (event.type === "text_delta") {
          send({ type: "text_delta", delta: event.delta });
        }
      },
    });

    const newMessages = result.context.messages.slice(session.history.length);
    session.history.push(...newMessages);

    const facts = reduceSessionEvents(getEvents(sessionId));
    const state = deriveSopState(facts);
    send({ type: "done", phase: state.phase });
  } catch (err) {
    send({ type: "error", message: err instanceof Error ? err.message : "Unknown error" });
  }

  res.end();
}

// GET /api/session/:id/state → { phase, collected_fields }
function handleGetState(res: http.ServerResponse, sessionId: string) {
  const facts = reduceSessionEvents(getEvents(sessionId));
  const state = deriveSopState(facts);
  json(res, 200, {
    phase: state.phase,
    collected_fields: Object.keys(facts.identity.provided_fields),
    verification: facts.identity.verification?.status ?? null,
  });
}

// ── Router ────────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const url = req.url ?? "/";
  const method = req.method ?? "GET";

  if (method === "OPTIONS") { cors(res); return; }

  // API routes
  if (url === "/api/session" && method === "POST") {
    await handleCreateSession(res);
    return;
  }

  const msgMatch = url.match(/^\/api\/session\/([^/]+)\/message$/);
  if (msgMatch && method === "POST") {
    await handleSendMessage(req, res, msgMatch[1]!);
    return;
  }

  const stateMatch = url.match(/^\/api\/session\/([^/]+)\/state$/);
  if (stateMatch && method === "GET") {
    handleGetState(res, stateMatch[1]!);
    return;
  }

  // Static files
  serveStatic(req, res);
});

const PORT = parseInt(process.env.PORT ?? "3000", 10);
server.listen(PORT, () => {
  console.log(`\n── Insurance Claims Agent Server ──`);
  console.log(`   http://localhost:${PORT}`);
  console.log(`   OPENAI_MODEL: ${process.env.OPENAI_MODEL ?? "gpt-4.1"}`);
  console.log(`   Logs → ${LOG_DIR}\n`);
});
