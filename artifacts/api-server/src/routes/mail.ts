import { randomBytes } from "node:crypto";
import { Router, type IRouter, type Request, type Response } from "express";

const router: IRouter = Router();
const MAIL_TM_API = "https://api.mail.tm";

type MailRecord = Record<string, unknown>;

class MailApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function mailRequest(path: string, init?: RequestInit): Promise<MailRecord> {
  let response: globalThis.Response;
  try {
    response = await fetch(`${MAIL_TM_API}${path}`, {
      ...init,
      headers: {
        Accept: "application/json",
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...init?.headers,
      },
    });
  } catch {
    throw new MailApiError(502, "Mail service is temporarily unavailable.");
  }

  const body = await response.json().catch(() => ({})) as MailRecord;
  if (!response.ok) {
    const message =
      typeof body["detail"] === "string"
        ? body["detail"]
        : typeof body["hydra:description"] === "string"
          ? body["hydra:description"]
          : "Mail service request failed.";
    throw new MailApiError(response.status, message);
  }
  return body;
}

function sendError(res: Response, error: unknown) {
  const status = error instanceof MailApiError ? error.status : 502;
  const message =
    error instanceof Error ? error.message : "Mail service request failed.";
  res.status(status).json({ error: message });
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function normalizeSender(value: unknown) {
  const sender = value && typeof value === "object" ? value as MailRecord : {};
  return {
    address: stringValue(sender["address"]),
    name: typeof sender["name"] === "string" ? sender["name"] : null,
  };
}

function getMemberList(response: MailRecord): MailRecord[] {
  if (Array.isArray(response)) {
    return response.filter(
      (member): member is MailRecord =>
        Boolean(member) && typeof member === "object" && !Array.isArray(member),
    );
  }
  const members = response["hydra:member"];
  return Array.isArray(members)
    ? members.filter(
        (member): member is MailRecord =>
          Boolean(member) && typeof member === "object" && !Array.isArray(member),
      )
    : [];
}

function getAuthToken(req: Request): string | null {
  const authorization = req.headers.authorization;
  if (!authorization?.match(/^Bearer\s+\S+/i)) return null;
  return authorization.replace(/^Bearer\s+/i, "").trim();
}

function requireAuth(req: Request, res: Response): string | null {
  const token = getAuthToken(req);
  if (!token) {
    res.status(401).json({ error: "A mailbox session is required." });
    return null;
  }
  return token;
}

router.get("/mail/domains", async (_req, res) => {
  try {
    const response = await mailRequest("/domains");
    const domains = getMemberList(response)
      .filter((item) => item["isActive"] === true && item["isPrivate"] !== true)
      .map((item) => ({
        id: stringValue(item["id"], stringValue(item["domain"])),
        domain: stringValue(item["domain"]),
      }))
      .filter((item) => item.domain.length > 0);
    res.json({ domains });
  } catch (error) {
    sendError(res, error);
  }
});

router.post("/mail/mailbox", async (req, res) => {
  const domain = typeof req.body?.domain === "string" ? req.body.domain.trim() : "";
  const requestedUsername =
    typeof req.body?.username === "string"
      ? req.body.username.trim().toLowerCase()
      : "";
  if (!domain) {
    res.status(400).json({ error: "Choose an active email domain." });
    return;
  }
  if (requestedUsername && !/^[a-z0-9._-]{1,64}$/.test(requestedUsername)) {
    res.status(400).json({
      error: "Use 1–64 letters, numbers, dots, underscores, or hyphens.",
    });
    return;
  }

  try {
    const domainResponse = await mailRequest("/domains");
    const isActive = getMemberList(domainResponse).some(
      (item) =>
        item["domain"] === domain &&
        item["isActive"] === true &&
        item["isPrivate"] !== true,
    );
    if (!isActive) {
      res.status(400).json({ error: "That email domain is no longer available." });
      return;
    }

    let address = "";
    let password = "";
    let id = "";
    let accountCreated = false;
    for (let attempt = 0; attempt < 5 && !accountCreated; attempt += 1) {
      const username =
        requestedUsername || `inbox${randomBytes(8).toString("hex")}`;
      address = `${username}@${domain}`;
      password = randomBytes(24).toString("base64url");
      try {
        const account = await mailRequest("/accounts", {
          method: "POST",
          body: JSON.stringify({ address, password }),
        });
        id = stringValue(account["id"]);
        accountCreated = true;
      } catch (error) {
        if (!(error instanceof MailApiError) || error.status !== 422) throw error;
        if (requestedUsername) {
          throw new MailApiError(409, "That username is already in use.");
        }
      }
    }
    if (!accountCreated) {
      throw new MailApiError(502, "Could not reserve a unique email address. Try again.");
    }

    const session = await mailRequest("/token", {
      method: "POST",
      body: JSON.stringify({ address, password }),
    });
    const token = stringValue(session["token"]);
    if (!token || !id) {
      throw new MailApiError(502, "Mail service did not return a complete mailbox session.");
    }
    res.status(201).json({ address, token, id, password });
  } catch (error) {
    sendError(res, error);
  }
});

router.get("/mail/messages", async (req, res) => {
  const token = requireAuth(req, res);
  if (!token) return;
  try {
    const response = await mailRequest("/messages", {
      headers: { Authorization: `Bearer ${token}` },
    });
    const messages = getMemberList(response).map((item) => ({
      id: stringValue(item["id"]),
      from: normalizeSender(item["from"]),
      subject: stringValue(item["subject"], "(no subject)"),
      intro: stringValue(item["intro"]),
      createdAt: stringValue(item["createdAt"], new Date().toISOString()),
      seen: item["seen"] === true,
      hasAttachments: item["hasAttachments"] === true,
    }));
    res.json({
      messages,
      totalItems:
        typeof response["hydra:totalItems"] === "number"
          ? response["hydra:totalItems"]
          : messages.length,
    });
  } catch (error) {
    sendError(res, error);
  }
});

router.get("/mail/messages/:messageId", async (req, res) => {
  const token = requireAuth(req, res);
  if (!token) return;
  try {
    const response = await mailRequest(
      `/messages/${encodeURIComponent(req.params.messageId)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const rawHtml = response["html"];
    const recipients = Array.isArray(response["to"]) ? response["to"] : [];
    res.json({
      id: stringValue(response["id"]),
      from: normalizeSender(response["from"]),
      to: recipients.map(normalizeSender),
      subject: stringValue(response["subject"], "(no subject)"),
      intro: stringValue(response["intro"]),
      text: typeof response["text"] === "string" ? response["text"] : null,
      html: Array.isArray(rawHtml)
        ? rawHtml.filter((item): item is string => typeof item === "string")
        : typeof rawHtml === "string" ? [rawHtml] : [],
      createdAt: stringValue(response["createdAt"], new Date().toISOString()),
      seen: response["seen"] === true,
    });
  } catch (error) {
    sendError(res, error);
  }
});

router.delete("/mail/messages/:messageId", async (req, res) => {
  const token = requireAuth(req, res);
  if (!token) return;
  try {
    await mailRequest(`/messages/${encodeURIComponent(req.params.messageId)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    res.status(204).end();
  } catch (error) {
    sendError(res, error);
  }
});

export default router;
