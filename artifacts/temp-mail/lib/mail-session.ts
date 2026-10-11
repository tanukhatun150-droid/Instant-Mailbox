import { Platform } from 'react-native';

const MAIL_TM_API = 'https://api.mail.tm';

export type MailDomain = { id: string; domain: string };
export type MailSession = {
  address: string;
  token: string;
  id: string;
  password: string;
};
export type MailSender = { address: string; name: string | null };
export type MailRecipient = { address: string; name: string | null };
export type MailMessageSummary = {
  id: string;
  from: MailSender;
  subject: string;
  intro: string;
  createdAt: string;
  seen: boolean;
  hasAttachments: boolean;
};
export type MailMessageDetail = MailMessageSummary & {
  to: MailRecipient[];
  text: string | null;
  html: string[];
};
export type MailMessageList = { messages: MailMessageSummary[]; totalItems: number };

export class MailTmError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'MailTmError';
  }
}

let mailboxToken: string | null = null;

export function setMailboxToken(token: string | null) {
  mailboxToken = token;
}

export function getMailboxToken() {
  return mailboxToken;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asString(value: unknown, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function asMembers(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.map(asRecord);
  const members = asRecord(value)['hydra:member'];
  return Array.isArray(members) ? members.map(asRecord) : [];
}

function errorMessage(value: unknown, fallback: string) {
  const record = asRecord(value);
  return asString(record.detail) || asString(record['hydra:description']) || fallback;
}

async function mailRequest<T>(
  path: string,
  options: { method?: 'GET' | 'POST' | 'DELETE'; token?: string; body?: unknown } = {},
  baseUrl = MAIL_TM_API,
): Promise<T> {
  const method = options.method ?? 'GET';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);

  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    const raw = await response.text();
    let data: unknown = null;
    if (raw) {
      try {
        data = JSON.parse(raw) as unknown;
      } catch {
        data = { detail: raw };
      }
    }

    if (!response.ok) {
      throw new MailTmError(
        errorMessage(data, `Mail.tm returned HTTP ${response.status}.`),
        response.status,
      );
    }
    return data as T;
  } catch (error) {
    const failure = controller.signal.aborted
      ? new MailTmError('Mail.tm did not respond in time. Please try again.')
      : error instanceof Error
        ? error
        : new MailTmError('Could not connect to Mail.tm. Check your connection and try again.');
    console.error(`[mail-session] ${method} ${path} failed: ${failure.message}`);
    throw failure;
  } finally {
    clearTimeout(timeout);
  }
}

function getBridgeBaseUrl() {
  const configuredDomain = process.env.EXPO_PUBLIC_DOMAIN?.trim();
  if (!configuredDomain) {
    throw new MailTmError('The Mail.tm connection is not configured for this preview.');
  }
  const baseUrl = /^https?:\/\//i.test(configuredDomain)
    ? configuredDomain
    : `https://${configuredDomain}`;
  return baseUrl.replace(/\/+$/, '');
}

export async function listMailDomains(): Promise<{ domains: MailDomain[] }> {
  if (Platform.OS === 'web') {
    const response = asRecord(await mailRequest<unknown>(
      '/api/mail/domains',
      {},
      getBridgeBaseUrl(),
    ));
    return {
      domains: Array.isArray(response.domains)
        ? response.domains.map(asRecord).map((item) => ({
          id: asString(item.id, asString(item.domain)),
          domain: asString(item.domain),
        })).filter((item) => item.domain.length > 0)
        : [],
    };
  }

  const response = await mailRequest<unknown>('/domains');
  const domains = asMembers(response)
    .filter((item) => item.isActive === true && item.isPrivate !== true)
    .map((item) => ({
      id: asString(item.id, asString(item.domain)),
      domain: asString(item.domain),
    }))
    .filter((item) => item.domain.length > 0);

  if (domains.length === 0) {
    throw new MailTmError('Mail.tm has no active public email domains right now.');
  }
  return { domains };
}

function randomUsername() {
  return `user_${Math.random().toString(36).slice(2, 9)}`;
}

function randomPassword() {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  return Array.from({ length: 32 }, () =>
    alphabet[Math.floor(Math.random() * alphabet.length)],
  ).join('');
}

export async function createMailMailbox(domain: string, requestedUsername?: string): Promise<MailSession> {
  const normalizedDomain = domain.trim().toLowerCase();
  const normalizedUsername = requestedUsername?.trim().toLowerCase();
  if (!normalizedDomain) throw new MailTmError('Choose an active email domain.');
  if (normalizedUsername && !/^[a-z0-9._-]{1,64}$/.test(normalizedUsername)) {
    throw new MailTmError('Use 1–64 letters, numbers, dots, underscores, or hyphens.');
  }

  if (Platform.OS === 'web') {
    const session = asRecord(await mailRequest<unknown>(
      '/api/mail/mailbox',
      {
        method: 'POST',
        body: {
          domain: normalizedDomain,
          ...(normalizedUsername ? { username: normalizedUsername } : {}),
        },
      },
      getBridgeBaseUrl(),
    ));
    const result = {
      address: asString(session.address),
      token: asString(session.token),
      id: asString(session.id),
      password: asString(session.password),
    };
    if (!result.address || !result.token || !result.id || !result.password) {
      throw new MailTmError('The Mail.tm connection did not return a complete mailbox session.');
    }
    setMailboxToken(result.token);
    return result;
  }

  const attempts = normalizedUsername ? 1 : 6;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const username = normalizedUsername ?? randomUsername();
    const address = `${username}@${normalizedDomain}`;
    const password = randomPassword();

    try {
      const account = asRecord(await mailRequest<unknown>('/accounts', {
        method: 'POST',
        body: { address, password },
      }));
      const id = asString(account.id);
      const tokenResponse = asRecord(await mailRequest<unknown>('/token', {
        method: 'POST',
        body: { address, password },
      }));
      const token = asString(tokenResponse.token);

      if (!id || !token) {
        throw new MailTmError('Mail.tm did not return a mailbox ID and session token.');
      }
      const session = { address, token, id, password };
      setMailboxToken(token);
      return session;
    } catch (error) {
      if (
        !normalizedUsername &&
        error instanceof MailTmError &&
        error.status === 422 &&
        attempt < attempts - 1
      ) {
        continue;
      }
      throw error;
    }
  }
  throw new MailTmError('Could not reserve a unique email address. Please try again.');
}

function normalizePerson(value: unknown): MailSender {
  const person = asRecord(value);
  return {
    address: asString(person.address),
    name: typeof person.name === 'string' ? person.name : null,
  };
}

function normalizeMessage(value: unknown): MailMessageSummary {
  const message = asRecord(value);
  return {
    id: asString(message.id),
    from: normalizePerson(message.from),
    subject: asString(message.subject, '(no subject)'),
    intro: asString(message.intro),
    createdAt: asString(message.createdAt, new Date().toISOString()),
    seen: message.seen === true,
    hasAttachments: message.hasAttachments === true,
  };
}

export async function listMailMessages(token: string): Promise<MailMessageList> {
  const response = await mailRequest<unknown>(
    Platform.OS === 'web' ? '/api/mail/messages' : '/messages',
    { token },
    Platform.OS === 'web' ? getBridgeBaseUrl() : MAIL_TM_API,
  );
  const record = asRecord(response);
  const messages = asMembers(response).map(normalizeMessage);
  return {
    messages,
    totalItems: typeof record['hydra:totalItems'] === 'number'
      ? record['hydra:totalItems']
      : messages.length,
  };
}

export async function getMailMessage(token: string, messageId: string): Promise<MailMessageDetail> {
  const response = asRecord(await mailRequest<unknown>(
    `${Platform.OS === 'web' ? '/api/mail/messages' : '/messages'}/${encodeURIComponent(messageId)}`,
    { token },
    Platform.OS === 'web' ? getBridgeBaseUrl() : MAIL_TM_API,
  ));
  const summary = normalizeMessage(response);
  const recipients = Array.isArray(response.to) ? response.to.map(normalizePerson) : [];
  const htmlValue = response.html;
  return {
    ...summary,
    to: recipients,
    text: typeof response.text === 'string' ? response.text : null,
    html: Array.isArray(htmlValue)
      ? htmlValue.filter((item): item is string => typeof item === 'string')
      : typeof htmlValue === 'string' ? [htmlValue] : [],
  };
}

export async function deleteMailMessage(token: string, messageId: string): Promise<void> {
  await mailRequest<unknown>(
    `${Platform.OS === 'web' ? '/api/mail/messages' : '/messages'}/${encodeURIComponent(messageId)}`,
    { method: 'DELETE', token },
    Platform.OS === 'web' ? getBridgeBaseUrl() : MAIL_TM_API,
  );
}
