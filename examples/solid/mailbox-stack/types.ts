// ghia-bench apps/ghia-solid-stack/src/types.ts at bench commit 44ca6cd, verbatim.
export interface Message {
  id: number
  fromName: string
  fromEmail: string
  subject: string
  snippet: string
  body: string[]
  time: string
  dateLong: string
  unread: boolean
  labels: string[]
}
