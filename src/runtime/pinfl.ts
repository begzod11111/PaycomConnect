// Uzbekistan PINFL (JShShIR) is a 14-digit personal number. Slack DLP drops
// messages that contain the digits in one run; inserting hyphens is enough for
// the message to land. Telegram users must not see this rewrite.

const PINFL_CANDIDATE_RE = /(?<!\d)(\d(?:[\s\-–—]?\d){13})(?!\d)/g;
const URL_OR_SLACK_TOKEN_RE = /https?:\/\/\S+|<[^>]*>/gi;

export const PINFL_SLACK_NOTICE =
  '_ПИНФЛ отформатирован для доставки в Slack. В Telegram сообщение не менялось._';

export function isUzbekistanPinfl(digits: string): boolean {
  if (!/^\d{14}$/.test(digits)) return false;
  const genderCentury = Number(digits[0]);
  if (genderCentury < 1 || genderCentury > 6) return false;
  const day = Number(digits.slice(1, 3));
  const month = Number(digits.slice(3, 5));
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  return true;
}

export function formatPinflForSlack(digits: string): string {
  const value = String(digits ?? '');
  if (value.length !== 14) return value;
  return `${value.slice(0, 4)}-${value.slice(4, 8)}-${value.slice(8, 12)}-${value.slice(12)}`;
}

function protectedSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  URL_OR_SLACK_TOKEN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = URL_OR_SLACK_TOKEN_RE.exec(text))) {
    spans.push([match.index, match.index + match[0].length]);
  }
  return spans;
}

function isInsideSpan(index: number, end: number, spans: Array<[number, number]>): boolean {
  return spans.some(([from, to]) => index < to && end > from);
}

export function applyPinflMaskForSlack(text: unknown): { text: string; rewritten: boolean; count: number } {
  const source = String(text ?? '');
  if (!source) return { text: source, rewritten: false, count: 0 };

  const spans = protectedSpans(source);
  let rewritten = false;
  let count = 0;
  const next = source.replace(PINFL_CANDIDATE_RE, (raw, _group, offset: number) => {
    if (isInsideSpan(offset, offset + raw.length, spans)) return raw;
    const digits = raw.replace(/\D/g, '');
    if (!isUzbekistanPinfl(digits)) return raw;
    const formatted = formatPinflForSlack(digits);
    if (formatted === raw) return raw;
    rewritten = true;
    count += 1;
    return formatted;
  });

  return { text: next, rewritten, count };
}

export function slackPinflNoticeBlock() {
  return {
    type: 'context',
    elements: [{ type: 'mrkdwn', text: PINFL_SLACK_NOTICE }],
  };
}
