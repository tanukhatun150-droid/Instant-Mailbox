import { randomBytes } from "node:crypto";
import { Router, type IRouter, type Request, type Response } from "express";

const router: IRouter = Router();
const MAIL_TM_API = "https://api.mail.tm";
const ONE_SEC_API = "https://www.1secmail.com/api/v1/";
const ONE_SEC_DOMAINS = [
  "1secmail.com",
  "1secmail.org",
  "1secmail.net",
  "wwjmp.com",
  "esiix.com",
  "xojxe.com",
  "yoggm.com",
];
type MailProvider = "1secmail" | "mailtm";

type MailRecord = Record<string, unknown>;

class MailApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function providerRequest(
  url: string,
  init: RequestInit = {},
  parentSignal?: AbortSignal,
  provider = "Email service",
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3_200);
  const abortFromParent = () => controller.abort();
  if (parentSignal?.aborted) controller.abort();
  else parentSignal?.addEventListener("abort", abortFromParent, { once: true });

  try {
    const response = await fetch(url, {
      ...init,
      headers: {
        Accept: "application/json",
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...init?.headers,
      },
      signal: controller.signal,
    });

    const text = await response.text();
    let body: unknown = {};
    try {
      body = text ? JSON.parse(text) as unknown : {};
    } catch {
      body = {};
    }
    if (!response.ok) {
      const record = body && typeof body === "object" ? body as MailRecord : {};
      const message =
        typeof record["detail"] === "string"
          ? record["detail"]
          : typeof record["hydra:description"] === "string"
            ? record["hydra:description"]
            : `${provider} request failed.`;
      throw new MailApiError(response.status, message);
    }
    return body;
  } catch (error) {
    if (error instanceof MailApiError) throw error;
    console.error(`[mail-api] ${provider} request failed: ${error instanceof Error ? error.message : String(error)}`);
    throw new MailApiError(502, `${provider} is temporarily unavailable. Please try again.`);
  } finally {
    clearTimeout(timeout);
    parentSignal?.removeEventListener("abort", abortFromParent);
  }
}

async function mailRequest(path: string, init?: RequestInit, signal?: AbortSignal): Promise<MailRecord> {
  return await providerRequest(`${MAIL_TM_API}${path}`, init, signal, "Mail.tm") as MailRecord;
}

async function oneSecRequest(params: Record<string, string>, signal?: AbortSignal): Promise<unknown> {
  const query = new URLSearchParams(params).toString();
  return providerRequest(`${ONE_SEC_API}?${query}`, {}, signal, "1secmail");
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

function idValue(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
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

function getProvider(req: Request): MailProvider {
  const value = req.header("x-mail-provider");
  return value?.toLowerCase() === "1secmail" ? "1secmail" : "mailtm";
}

function getOneSecMailbox(req: Request) {
  const login = req.header("x-mail-login")?.trim() ?? "";
  const domain = req.header("x-mail-domain")?.trim().toLowerCase() ?? "";
  if (!/^[a-z0-9._-]{1,64}$/i.test(login) || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) {
    throw new MailApiError(400, "The 1secmail mailbox details are invalid.");
  }
  return { login, domain };
}

function requireAuth(req: Request, res: Response): string | null {
  const token = getAuthToken(req);
  if (!token) {
    res.status(401).json({ error: "A mailbox session is required." });
    return null;
  }
  return token;
}

function normalizeOneSecPerson(value: unknown) {
  const raw = stringValue(value);
  const addressMatch = raw.match(/<([^>]+)>/);
  const address = addressMatch?.[1]?.trim() ?? raw.trim();
  const name = raw.replace(/<[^>]+>/g, "").trim();
  return { address, name: name && name !== address ? name : null };
}

function normalizeOneSecMessage(value: unknown) {
  const message = value && typeof value === "object" ? value as MailRecord : {};
  const attachments = Array.isArray(message["attachments"]) ? message["attachments"] : [];
  const recipients = Array.isArray(message["to"])
    ? message["to"].map(normalizeOneSecPerson)
    : [];
  const bodyHtml = stringValue(message["htmlBody"]);
  const bodyText = typeof message["textBody"] === "string" ? message["textBody"] : null;
  return {
    id: idValue(message["id"]),
    sender: normalizeOneSecPerson(message["from"]),
    subject: stringValue(message["subject"], "(no subject)"),
    preview: stringValue(message["intro"], bodyText ?? ""),
    date: stringValue(message["date"], new Date().toISOString()),
    bodyHtml,
    bodyText,
    seen: message["seen"] === true,
    hasAttachments: attachments.length > 0,
    recipients,
  };
}

function normalizeMailTmMessage(message: MailRecord) {
  return {
    id: stringValue(message["id"]),
    sender: normalizeSender(message["from"]),
    subject: stringValue(message["subject"], "(no subject)"),
    preview: stringValue(message["intro"]),
    date: stringValue(message["createdAt"], new Date().toISOString()),
    bodyHtml: "",
    bodyText: null,
    seen: message["seen"] === true,
    hasAttachments: message["hasAttachments"] === true,
    recipients: [],
  };
}

router.get("/mail/domains", async (_req, res) => {
  const [mailTmResult, oneSecResult] = await Promise.allSettled([
    mailRequest("/domains"),
    oneSecRequest({ action: "getDomainList" }),
  ]);
  const domains: { id: string; domain: string; provider: MailProvider }[] = [];

  if (mailTmResult.status === "fulfilled") {
    domains.push(...getMemberList(mailTmResult.value)
      .filter((item) => item["isActive"] === true && item["isPrivate"] !== true)
      .map((item) => ({
        id: stringValue(item["id"], stringValue(item["domain"])),
        domain: stringValue(item["domain"]),
        provider: "mailtm" as const,
      }))
      .filter((item) => item.domain.length > 0));
  }

  const oneSecDomains = oneSecResult.status === "fulfilled" && Array.isArray(oneSecResult.value)
    ? oneSecResult.value.filter((item): item is string => typeof item === "string")
    : [];
  const supportedOneSecDomains = oneSecDomains.length ? oneSecDomains : ONE_SEC_DOMAINS;
  domains.push(...supportedOneSecDomains.map((domain) => ({
    id: `1secmail:${domain}`,
    domain,
    provider: "1secmail" as const,
  })));

  res.json({
    domains: [
      ...domains.filter((entry) => entry.provider === "1secmail"),
      ...domains.filter((entry) => entry.provider === "mailtm"),
    ],
  });
});

router.post("/mail/mailbox", async (req, res) => {
  const domain = typeof req.body?.domain === "string" ? req.body.domain.trim() : "";
  const provider: MailProvider = req.body?.provider === "1secmail" ? "1secmail" : "mailtm";
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

  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 3_300);
  try {
    if (provider === "1secmail") {
      if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) {
        throw new MailApiError(400, "Choose a valid 1secmail domain.");
      }
      const generated = requestedUsername
        ? []
        : await oneSecRequest({ action: "genRandomMailbox", count: "1" }, controller.signal);
      const generatedAddress = Array.isArray(generated) && typeof generated[0] === "string"
        ? generated[0]
        : "";
      const login = requestedUsername || generatedAddress.split("@")[0] || `inbox${randomBytes(6).toString("hex")}`;
      const address = `${login}@${domain}`;
      res.status(201).json({ address, provider, login, domain });
      return;
    }

    const domainResponse = await mailRequest("/domains", {}, controller.signal);
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
        }, controller.signal);
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
    }, controller.signal);
    const token = stringValue(session["token"]);
    if (!token || !id) {
      throw new MailApiError(502, "Mail service did not return a complete mailbox session.");
    }
    res.status(201).json({ address, token, id, password, provider, domain });
  } catch (error) {
    sendError(res, error);
  } finally {
    clearTimeout(deadline);
  }
});

router.get("/mail/messages", async (req, res) => {
  try {
    if (getProvider(req) === "1secmail") {
      const { login, domain } = getOneSecMailbox(req);
      const response = await oneSecRequest({ action: "getMessages", login, domain });
      const messages = Array.isArray(response) ? response.map(normalizeOneSecMessage) : [];
      res.json({ messages, totalItems: messages.length });
      return;
    }

    const token = getAuthToken(req);
    if (!token) {
      res.status(401).json({ error: "A mailbox session is required." });
      return;
    }
    const response = await mailRequest("/messages", {
      headers: { Authorization: `Bearer ${token}` },
    });
    const messages = getMemberList(response).map(normalizeMailTmMessage);
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
  try {
    if (getProvider(req) === "1secmail") {
      const { login, domain } = getOneSecMailbox(req);
      const response = await oneSecRequest({
        action: "readMessage",
        login,
        domain,
        id: req.params.messageId,
      });
      const detail = normalizeOneSecMessage(response);
      if (!detail.id) {
        res.status(404).json({ error: "Message not found." });
        return;
      }
      res.json(detail);
      return;
    }

    const token = getAuthToken(req);
    if (!token) {
      res.status(401).json({ error: "A mailbox session is required." });
      return;
    }
    const response = await mailRequest(
      `/messages/${encodeURIComponent(req.params.messageId)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const normalized = normalizeMailTmMessage(response);
    const rawHtml = response["html"];
    const rawRecipients = Array.isArray(response["to"]) ? response["to"] : [];
    res.json({
      ...normalized,
      bodyHtml: Array.isArray(rawHtml)
        ? rawHtml.filter((item): item is string => typeof item === "string").join("\n")
        : typeof rawHtml === "string" ? rawHtml : "",
      bodyText: typeof response["text"] === "string" ? response["text"] : null,
      recipients: rawRecipients.map(normalizeSender),
    });
  } catch (error) {
    sendError(res, error);
  }
});

router.delete("/mail/messages/:messageId", async (req, res) => {
  try {
    if (getProvider(req) === "1secmail") {
      throw new MailApiError(405, "This provider does not support deleting individual messages.");
    }
    const token = getAuthToken(req);
    if (!token) {
      res.status(401).json({ error: "A mailbox session is required." });
      return;
    }
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
