// Faithful, low-distortion text conversion between Telegram and Slack.
//
// The two platforms use different escaping and markup rules, so forwarding raw
// text between them corrupts links, ampersands and angle brackets ("distortion").
// These helpers translate text in both directions while preserving the original
// content and (where possible) the original formatting/links.

export interface TelegramTextEntity {
  type: string;
  offset: number;
  length: number;
  url?: string;
  user?: { id?: number | string };
}

// Slack treats `&`, `<` and `>` as control characters in message text and in
// mrkdwn. Any literal occurrence must be HTML-escaped or Slack silently drops or
// reinterprets it (this is what mangles URLs and plain text today).
export function escapeSlackText(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// A URL that goes inside Slack's `<url|label>` link syntax must not contain the
// delimiter characters, otherwise the link breaks apart.
function escapeSlackLinkUrl(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '%3C')
    .replace(/>/g, '%3E')
    .replace(/\|/g, '%7C');
}

interface MarkerInsert {
  pos: number;
  text: string;
  kind: 'open' | 'close';
  order: number;
}

// Convert Telegram message text + entities into Slack mrkdwn without distortion.
//
// - Every non-entity character is Slack-escaped so `&`, `<`, `>` survive intact.
// - Telegram rich entities (bold/italic/strike/code/pre/links) are mapped to the
//   equivalent Slack mrkdwn so formatting and, crucially, hyperlinks are kept.
// - Entity offsets/lengths are UTF-16 code unit indices, which match JavaScript
//   string indexing directly, so nested/adjacent ranges are handled correctly.
export function telegramEntitiesToSlackMrkdwn(text: unknown, entities: TelegramTextEntity[] = []): string {
  const raw = String(text ?? '');
  if (!raw) return '';
  if (!Array.isArray(entities) || entities.length === 0) return escapeSlackText(raw);

  const inserts: MarkerInsert[] = [];
  entities.forEach((entity, index) => {
    const start = Number(entity?.offset) || 0;
    const length = Number(entity?.length) || 0;
    if (length <= 0 || start < 0 || start >= raw.length) return;
    const end = Math.min(start + length, raw.length);

    let open = '';
    let close = '';
    switch (entity.type) {
      case 'bold':
        open = close = '*';
        break;
      case 'italic':
        open = close = '_';
        break;
      case 'strikethrough':
        open = close = '~';
        break;
      case 'code':
        open = close = '`';
        break;
      case 'pre':
        open = '```\n';
        close = '\n```';
        break;
      case 'text_link':
        if (!entity.url) return;
        open = `<${escapeSlackLinkUrl(entity.url)}|`;
        close = '>';
        break;
      default:
        // url / mention / hashtag / underline / spoiler / etc.: leave the text
        // as-is (Slack auto-links bare URLs) so nothing is lost.
        return;
    }

    inserts.push({ pos: start, text: open, kind: 'open', order: index });
    inserts.push({ pos: end, text: close, kind: 'close', order: index });
  });

  if (!inserts.length) return escapeSlackText(raw);

  inserts.sort((a, b) => {
    if (a.pos !== b.pos) return a.pos - b.pos;
    if (a.kind !== b.kind) return a.kind === 'close' ? -1 : 1;
    // Close inner (later-opened) entities first; open outer entities first.
    return a.kind === 'close' ? b.order - a.order : a.order - b.order;
  });

  let result = '';
  let cursor = 0;
  for (const insert of inserts) {
    if (insert.pos > cursor) {
      result += escapeSlackText(raw.slice(cursor, insert.pos));
      cursor = insert.pos;
    }
    result += insert.text;
  }
  if (cursor < raw.length) result += escapeSlackText(raw.slice(cursor));
  return result;
}

// Escape text for Telegram's HTML parse mode.
export function escapeTelegramHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export interface TelegramMentionInfo {
  telegramId?: string;
  displayName?: string;
}

// Only `"` needs handling for an href attribute value; Slack has already escaped
// `&`, `<`, `>` in the token, so re-escaping them would corrupt the URL.
function escapeHrefAttribute(url: string): string {
  return url.replace(/"/g, '%22');
}

// Render a single Slack angle-bracket token (`<...>`) as Telegram HTML.
//
// The substrings that originate from Slack (URLs, link labels, channel names,
// command labels) are already Slack-escaped, which is valid Telegram HTML, so
// they are passed through untouched. Only values that come from our own database
// (mention display names) are escaped here.
function renderSlackToken(inner: string, mentions: Map<string, TelegramMentionInfo>): string {
  // User mention: <@U123> or <@U123|display>
  if (inner.startsWith('@')) {
    const body = inner.slice(1);
    const [id, label] = body.split('|');
    const info = mentions.get(id);
    if (info?.telegramId) {
      const name = info.displayName ? escapeTelegramHtml(info.displayName) : label || id;
      return `<a href="tg://user?id=${escapeTelegramHtml(info.telegramId)}">@${name}</a>`;
    }
    return `@${label || id}`;
  }

  // Channel mention: <#C123|name>
  if (inner.startsWith('#')) {
    const body = inner.slice(1);
    const [id, label] = body.split('|');
    return `#${label || id}`;
  }

  // Special mention / command: <!here>, <!channel>, <!subteam^S1|@grp>, <!date^...>
  if (inner.startsWith('!')) {
    const body = inner.slice(1);
    const [command, label] = body.split('|');
    if (label) return label;
    if (command === 'here' || command === 'channel' || command === 'everyone') {
      return `@${command}`;
    }
    return command.split('^')[0];
  }

  // Link: <https://url> or <https://url|label>
  const [url, label] = inner.split('|');
  return `<a href="${escapeHrefAttribute(url)}">${label || url}</a>`;
}

// Convert Slack message text into Telegram HTML without distortion.
//
// Slack already HTML-escapes `&`, `<`, `>` in the plain-text portions of its
// payload (`&amp;`, `&lt;`, `&gt;`), which happen to be valid Telegram HTML, so
// those segments are passed through untouched instead of being escaped a second
// time (the previous behavior turned `&amp;` into `&amp;amp;`). Slack's
// `<...>` control tokens (links, user/channel mentions, special commands) are
// translated into their Telegram HTML equivalents.
export function slackTextToTelegramHtml(text: unknown, mentions: Map<string, TelegramMentionInfo> = new Map()): string {
  const source = String(text ?? '');
  if (!source) return '';

  const tokenRe = /<([^<>]+)>/g;
  let result = '';
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = tokenRe.exec(source)) !== null) {
    result += source.slice(lastIndex, match.index);
    result += renderSlackToken(match[1], mentions);
    lastIndex = tokenRe.lastIndex;
  }
  result += source.slice(lastIndex);
  return result;
}

// Collect the unique Slack user ids referenced by `<@U..>` mentions in a message.
export function extractSlackMentionIds(text: unknown): string[] {
  const source = String(text ?? '');
  const ids = new Set<string>();
  for (const match of source.matchAll(/<@([A-Z0-9]+)(?:\|[^>]+)?>/g)) {
    ids.add(match[1]);
  }
  return [...ids];
}
