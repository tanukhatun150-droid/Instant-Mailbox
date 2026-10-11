import { Platform } from 'react-native';
import {
  createMailMailbox as createBridgeMailbox,
  deleteMailMessage as deleteBridgeMessage,
  getMailMessage as getBridgeMessage,
  listMailDomains as listBridgeDomains,
  listMailMessages as listBridgeMessages,
} from '@workspace/api-client-react';
import {
  createMailMailbox as createMailTmMailbox,
  deleteMailMessage as deleteMailTmMessage,
  getMailMessage as getMailTmMessage,
  listMailDomains as listMailTmDomains,
  listMailMessages as listMailTmMessages,
} from '@/lib/mail-session';

export type EmailProvider = '1secmail' | 'mailtm';
export type EmailDomain = { id: string; domain: string; provider: EmailProvider };
export type EmailMailbox = {
  address: string;
  provider: EmailProvider;
  domain: string;
  token?: string;
  login?: string;
  id?: string;
  password?: string;
};
export type EmailPerson = { address: string; name: string | null };
export type EmailMessage = {
  id: string;
  sender: EmailPerson;
  subject: string;
  preview: string;
  date: string;
  bodyHtml: string;
  bodyText: string | null;
  seen: boolean;
  hasAttachments: boolean;
  recipients: EmailPerson[];
};
export type EmailMessageList = { messages: EmailMessage[]; totalItems: number };

const ONE_SEC_API = 'https://www.1secmail.com/api/v1/';
const ONE_SEC_DOMAINS = [
  '1secmail.com',
  '1secmail.org',
  '1secmail.net',
  'wwjmp.com',
  'esiix.com',
  'xojxe.com',
  'yoggm.com',
];
const PROVIDER_TIMEOUT_MS = 3500;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asString(value: unknown, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function asId(value: unknown) {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}

function normalizePerson(value: unknown): EmailPerson {
  if (typeof value === 'string') {
    const match = value.match(/<([^>]+)>/);
    const address = match?.[1]?.trim() ?? value.trim();
    const name = value.replace(/<[^>]+>/g, '').trim();
    return { address, name: name && name !== address ? name : null };
  }
  const person = asRecord(value);
  return {
    address: asString(person.address),
    name: typeof person.name === 'string' ? person.name : null,
  };
}

function normalizedDate(value: unknown) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) return value;
  return new Date().toISOString();
}

function normalizeApiMessage(value: unknown): EmailMessage {
  const message = asRecord(value);
  return {
    id: asId(message.id),
    sender: normalizePerson(message.sender ?? message.from),
    subject: asString(message.subject, '(no subject)'),
    preview: asString(message.preview ?? message.intro),
    date: normalizedDate(message.date ?? message.createdAt),
    bodyHtml: typeof message.bodyHtml === 'string'
      ? message.bodyHtml
      : Array.isArray(message.html) ? message.html.filter((part) => typeof part === 'string').join('\n') : '',
    bodyText: typeof message.bodyText === 'string'
      ? message.bodyText
      : typeof message.text === 'string' ? message.text : null,
    seen: message.seen === true,
    hasAttachments: message.hasAttachments === true,
    recipients: Array.isArray(message.recipients)
      ? message.recipients.map(normalizePerson)
      : Array.isArray(message.to) ? message.to.map(normalizePerson) : [],
  };
}

function normalizeOneSecMessage(value: unknown): EmailMessage {
  const message = asRecord(value);
  const bodyText = typeof message.textBody === 'string' ? message.textBody : null;
  const attachments = Array.isArray(message.attachments) ? message.attachments : [];
  return {
    id: asId(message.id),
    sender: normalizePerson(message.from),
    subject: asString(message.subject, '(no subject)'),
    preview: asString(message.intro, bodyText ?? ''),
    date: normalizedDate(message.date),
    bodyHtml: asString(message.htmlBody),
    bodyText,
    seen: message.seen === true,
    hasAttachments: attachments.length > 0,
    recipients: Array.isArray(message.to) ? message.to.map(normalizePerson) : [],
  };
}

function mailboxHeaders(mailbox: EmailMailbox): Record<string, string> {
  return {
    'X-Mail-Provider': mailbox.provider,
    ...(mailbox.login ? { 'X-Mail-Login': mailbox.login } : {}),
    'X-Mail-Domain': mailbox.domain,
    ...(mailbox.token ? { Authorization: `Bearer ${mailbox.token}` } : {}),
  };
}

async function oneSecRequest(action: string, values: Record<string, string>, signal: AbortSignal) {
  const params = new URLSearchParams({ action, ...values });
  try {
    const response = await fetch(`${ONE_SEC_API}?${params.toString()}`, {
      headers: { Accept: 'application/json' },
      signal,
    });
    if (!response.ok) throw new Error(`1secmail returned HTTP ${response.status}.`);
    return await response.json() as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Network request failed.';
    console.error(`[email-engine] 1secmail ${action} request failed: ${message}`);
    throw new Error(message);
  }
}

async function withProviderDeadline<T>(
  provider: EmailProvider,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(controller.signal),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error(`${provider} timed out after 3.5 seconds.`));
        }, PROVIDER_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    console.error(`[email-engine] ${provider} provider attempt failed: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    if (!controller.signal.aborted) controller.abort();
  }
}

function staticOneSecDomains(): EmailDomain[] {
  return ONE_SEC_DOMAINS.map((domain) => ({
    id: `1secmail:${domain}`,
    domain,
    provider: '1secmail',
  }));
}

export async function listEmailDomains(): Promise<{ domains: EmailDomain[] }> {
  if (Platform.OS === 'web') {
    try {
      const response = await withProviderDeadline(
        'mailtm',
        (signal) => listBridgeDomains({ signal }),
      );
      const domains = response.domains.map((domain) => ({
        id: domain.id,
        domain: domain.domain,
        provider: domain.provider,
      }));
      return { domains: domains.length ? domains : staticOneSecDomains() };
    } catch {
      return { domains: staticOneSecDomains() };
    }
  }

  const [mailTmResult, oneSecResult] = await Promise.allSettled([
    withProviderDeadline('mailtm', (signal) => listMailTmDomains(signal)),
    withProviderDeadline('1secmail', (signal) =>
      oneSecRequest('getDomainList', {}, signal)),
  ]);
  const domains: EmailDomain[] = [];

  if (mailTmResult.status === 'fulfilled') {
    domains.push(...mailTmResult.value.domains.map((domain) => ({
      id: domain.id,
      domain: domain.domain,
      provider: 'mailtm' as const,
    })));
  }
  if (oneSecResult.status === 'fulfilled' && Array.isArray(oneSecResult.value)) {
    domains.push(...oneSecResult.value
      .filter((domain): domain is string => typeof domain === 'string')
      .map((domain) => ({ id: `1secmail:${domain}`, domain, provider: '1secmail' as const })));
  }
  const oneSecAvailable = domains.some((domain) => domain.provider === '1secmail');
  if (!oneSecAvailable) domains.push(...staticOneSecDomains());
  return {
    domains: [
      ...domains.filter((entry) => entry.provider === '1secmail'),
      ...domains.filter((entry) => entry.provider === 'mailtm'),
    ],
  };
}

async function createForProvider(
  provider: EmailProvider,
  domain: EmailDomain,
  username: string | undefined,
  signal: AbortSignal,
): Promise<EmailMailbox> {
  if (Platform.OS === 'web') {
    const response = await createBridgeMailbox(
      { provider, domain: domain.domain, ...(username ? { username } : {}) },
      { signal },
    );
    return {
      address: response.address,
      provider: response.provider,
      domain: response.domain,
      ...(response.token ? { token: response.token } : {}),
      ...(response.login ? { login: response.login } : {}),
      ...(response.id ? { id: response.id } : {}),
      ...(response.password ? { password: response.password } : {}),
    };
  }

  if (provider === 'mailtm') {
    const session = await createMailTmMailbox(domain.domain, username, signal);
    return { ...session, provider, domain: domain.domain };
  }

  let login = username;
  if (!login) {
    const generated = await oneSecRequest('genRandomMailbox', { count: '1' }, signal);
    const generatedAddress = Array.isArray(generated) && typeof generated[0] === 'string'
      ? generated[0]
      : '';
    login = generatedAddress.split('@')[0];
  }
  if (!login) throw new Error('1secmail did not return an address.');
  return { address: `${login}@${domain.domain}`, provider, login, domain: domain.domain };
}

export async function createEmailMailbox(
  preferredDomain: EmailDomain,
  username: string | undefined,
  allDomains: EmailDomain[],
): Promise<EmailMailbox> {
  const primary = preferredDomain;
  const alternateProvider: EmailProvider = primary.provider === '1secmail' ? 'mailtm' : '1secmail';
  let fallbackDomain = allDomains.find((entry) => entry.provider === alternateProvider);
  if (!fallbackDomain && alternateProvider === '1secmail') {
    fallbackDomain = staticOneSecDomains()[0];
  }
  if (!fallbackDomain && alternateProvider === 'mailtm') {
    try {
      const available = Platform.OS === 'web'
        ? await withProviderDeadline('mailtm', (signal) => listBridgeDomains({ signal }))
        : await withProviderDeadline('mailtm', (signal) => listMailTmDomains(signal));
      const selected = available.domains.find((entry) => entry.domain);
      if (selected) fallbackDomain = { ...selected, provider: 'mailtm' };
    } catch (error) {
      console.error('[email-engine] Could not load Mail.tm fallback domains:', error);
    }
  }

  const attempts = [{ provider: primary.provider, domain: primary }];
  if (fallbackDomain) attempts.push({ provider: alternateProvider, domain: fallbackDomain });
  let lastError: unknown;
  for (const attempt of attempts) {
    try {
      return await withProviderDeadline(attempt.provider, (signal) =>
        createForProvider(attempt.provider, attempt.domain, username, signal));
    } catch (error) {
      lastError = error;
    }
  }
  const detail = lastError instanceof Error ? lastError.message : '';
  console.error('[email-engine] All mailbox providers failed.', detail);
  throw new Error('Email services are temporarily unavailable. Tap Retry to try again.');
}

export async function listEmailMessages(mailbox: EmailMailbox): Promise<EmailMessageList> {
  if (Platform.OS === 'web') {
    const response = await withProviderDeadline(mailbox.provider, (signal) =>
      listBridgeMessages({ headers: mailboxHeaders(mailbox), signal }));
    return {
      messages: response.messages.map(normalizeApiMessage),
      totalItems: response.totalItems,
    };
  }

  if (mailbox.provider === 'mailtm') {
    if (!mailbox.token) throw new Error('This Mail.tm session has expired. Create a new address.');
    const response = await withProviderDeadline('mailtm', (signal) =>
      listMailTmMessages(mailbox.token!, signal));
    return {
      messages: response.messages.map(normalizeApiMessage),
      totalItems: response.totalItems,
    };
  }

  if (!mailbox.login) throw new Error('The 1secmail mailbox details are missing.');
  const response = await withProviderDeadline('1secmail', (signal) =>
    oneSecRequest('getMessages', { login: mailbox.login!, domain: mailbox.domain }, signal));
  const messages = Array.isArray(response) ? response.map(normalizeOneSecMessage) : [];
  return { messages, totalItems: messages.length };
}

export async function getEmailMessage(mailbox: EmailMailbox, messageId: string): Promise<EmailMessage> {
  if (Platform.OS === 'web') {
    return normalizeApiMessage(await withProviderDeadline(mailbox.provider, (signal) =>
      getBridgeMessage(messageId, { headers: mailboxHeaders(mailbox), signal })));
  }

  if (mailbox.provider === 'mailtm') {
    if (!mailbox.token) throw new Error('This Mail.tm session has expired. Create a new address.');
    return normalizeApiMessage(await withProviderDeadline('mailtm', (signal) =>
      getMailTmMessage(mailbox.token!, messageId, signal)));
  }

  if (!mailbox.login) throw new Error('The 1secmail mailbox details are missing.');
  const response = await withProviderDeadline('1secmail', (signal) =>
    oneSecRequest('readMessage', {
      login: mailbox.login!,
      domain: mailbox.domain,
      id: messageId,
    }, signal));
  const message = normalizeOneSecMessage(response);
  if (!message.id) throw new Error('Message not found.');
  return message;
}

export async function deleteEmailMessage(mailbox: EmailMailbox, messageId: string): Promise<void> {
  if (mailbox.provider === '1secmail') {
    throw new Error('This provider does not support deleting individual messages.');
  }
  if (!mailbox.token) throw new Error('This Mail.tm session has expired. Create a new address.');

  if (Platform.OS === 'web') {
    await withProviderDeadline('mailtm', (signal) =>
      deleteBridgeMessage(messageId, { headers: mailboxHeaders(mailbox), signal }));
  } else {
    await withProviderDeadline('mailtm', (signal) =>
      deleteMailTmMessage(mailbox.token!, messageId, signal));
  }
}

export function normalizeStoredMailbox(value: unknown): EmailMailbox | null {
  const stored = asRecord(value);
  const address = asString(stored.address);
  if (!address) return null;
  const domain = asString(stored.domain, address.split('@')[1] ?? '');
  const provider = stored.provider === '1secmail' ? '1secmail' : 'mailtm';
  const token = asString(stored.token);
  const login = asString(stored.login, address.split('@')[0] ?? '');
  if (provider === 'mailtm' && !token) return null;
  return {
    address,
    provider,
    domain,
    ...(token ? { token } : {}),
    ...(provider === '1secmail' && login ? { login } : {}),
    ...(asString(stored.id) ? { id: asString(stored.id) } : {}),
    ...(asString(stored.password) ? { password: asString(stored.password) } : {}),
  };
}
