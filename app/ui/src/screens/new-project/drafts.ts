// Words for the "Continue a draft" list.

const CLOCK = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' });
const DAY = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });

/** "Today 02:40", "Yesterday 23:10" or "1 Nov 14:02"; empty when the time is unknown. */
export function draftWhen(savedAt: string, now: Date = new Date()): string {
  const at = new Date(savedAt);
  if (Number.isNaN(at.getTime())) return '';
  const days = Math.round(
    (new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() -
      new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime()) /
      864e5,
  );
  const day = days === 0 ? 'Today' : days === 1 ? 'Yesterday' : DAY.format(at);
  return `${day} ${CLOCK.format(at)}`;
}
