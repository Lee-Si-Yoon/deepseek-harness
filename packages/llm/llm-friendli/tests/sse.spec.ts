import { describe, expect, it } from 'vitest'
import { parseSse, DONE } from '../src/sse.ts'

/** Frame a list of SSE data payloads into a byte stream the parser reads. */
function sseStream(payloads: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const payload of payloads) controller.enqueue(encoder.encode(`data: ${payload}\n\n`))
      controller.close()
    },
  })
}

async function collect(stream: ReadableStream<Uint8Array>, onComment?: (c: string) => void) {
  const out: string[] = []
  for await (const data of parseSse(stream, onComment)) out.push(data)
  return out
}

describe('parseSse', () => {
  it('yields each data payload ending with the [DONE] sentinel', async () => {
    const out = await collect(sseStream(['{"a":1}', DONE]))
    expect(out).toEqual(['{"a":1}', DONE])
  })

  it('reports comments through the callback without yielding them', async () => {
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(': keepalive\n\n'))
        controller.enqueue(encoder.encode(`data: ${DONE}\n\n`))
        controller.close()
      },
    })
    const comments: string[] = []
    const out = await collect(stream, c => comments.push(c))
    expect(out).toEqual([DONE])
    expect(comments).toEqual(['keepalive'])
  })

  it('throws STREAM_CLOSED when the stream ends without [DONE]', async () => {
    await expect(collect(sseStream(['{"a":1}']))).rejects.toMatchObject({ failure: { code: 'STREAM_CLOSED' } })
  })
})
