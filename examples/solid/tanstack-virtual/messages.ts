import type { Message } from './types'

const SENDERS = ['Ada Lovelace', 'Grace Hopper', 'Alan Turing', 'Linus Torvalds', 'Margaret Hamilton', 'Dennis Ritchie']
const SUBJECTS = ['Quarterly numbers', 'Lunch on Friday?', 'Your receipt', 'Travel plans', 'Re: design review', 'Weekend project']

/** Deterministic mail for the list, with a different sender and subject on every row so a blank or stale row shows. */
export function makeMessages(count: number): Message[] {
  return Array.from({ length: count }, (_, id) => {
    const fromName = SENDERS[id % SENDERS.length]
    const subject = `${SUBJECTS[id % SUBJECTS.length]} #${id}`
    return {
      id,
      fromName,
      fromEmail: `${fromName.split(' ')[0].toLowerCase()}@example.com`,
      subject,
      snippet: `Snippet of message ${id}, which is long enough to be cut off by the row`,
      body: [`Body of message ${id}.`],
      time: `${(id % 12) + 1}:${String(id % 60).padStart(2, '0')} PM`,
      dateLong: 'Nov 10, 2026',
      unread: id % 3 === 0,
      labels: [],
    }
  })
}
