/**
 * Answering "which models can this endpoint serve?" for the configuration
 * surface's "fetch available models" action, and building the shipped default
 * catalog from the same listing shape.
 *
 * FriendliAI's serverless `GET /models` discloses more than an id: it carries
 * `context_length` and `max_completion_tokens`, so an adopted model arrives
 * sized rather than guessed. A `deprecation_date` marks a model scheduled for
 * or past removal; those are skipped, because a listing membership is not a
 * promise of access — account, permission, and deprecation all decide whether
 * a request to that model actually succeeds.
 *
 * Nothing here is stored: the request carries a draft the user is still
 * editing, and the reply is candidate metadata the surface offers for
 * adoption. The settings document remains the only thing that decides what a
 * route serves.
 *
 * @module dsh-llm-friendli/discovery
 */

import { LlmError } from '@deepseek-ai/dsh-llm'
import type { LlmDiscoveredModel, LlmModelDiscoveryRequest } from '@deepseek-ai/dsh-llm'
import { attributionHeaders } from '@deepseek-ai/dsh-llm'
import type { WireModelListingEntry } from './types.ts'

/**
 * Endpoint replies larger than this are refused. The endpoint is whatever URL
 * the user typed, so the ceiling holds on the bytes actually read rather than
 * on the length the server claims; a truncated model listing is not parseable,
 * so overflow rejects instead of truncating.
 */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024

/** A positive integer field of a listing entry, or `undefined` when absent or unusable. */
function capacity(candidate: unknown): number | undefined {
  return typeof candidate === 'number' && Number.isInteger(candidate) && candidate > 0 ? candidate : undefined
}

/** A non-empty string field of a listing entry, or `undefined`. */
function label(candidate: unknown): string | undefined {
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : undefined
}

/**
 * Join the endpoint base with the listing path. The base is treated as a
 * prefix rather than a URL to resolve against, so a deployment path such as
 * `https://gateway.example/serverless/v1` keeps its segments instead of losing
 * them to `URL` resolution.
 */
function listingUrl(baseURL: string): string {
  return `${baseURL.replace(/\/+$/, '')}/models`
}

/**
 * Read a reply body, refusing one that outgrows the ceiling. A declared length
 * is checked first so an honest server is turned away without transferring
 * anything; the accumulated total is what actually enforces the bound, because
 * a server that under-declares (or streams) tells us nothing up front.
 */
async function readBounded(response: Response, url: string): Promise<string> {
  const oversized = (): LlmError =>
    new LlmError(`${url} answered with more than ${MAX_RESPONSE_BYTES} bytes`, 'DISCOVERY_FAILED')
  const declared = Number(response.headers.get('content-length') ?? Number.NaN)
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel()
    throw oversized()
  }
  /* v8 ignore next -- fetch always exposes a body stream on a 2xx Response; the null guard is defensive. */
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_RESPONSE_BYTES) throw oversized()
      chunks.push(value)
    }
  } finally {
    /* v8 ignore next 4 -- cancel() after a completed or abandoned read settles without rejecting; unobserved best-effort cleanup. */
    await reader.cancel().catch(() => {
      // Cancel after a drained read, or after this function walked away from
      // an oversized one, is cleanup; the reply is already decided either way.
    })
  }
  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(body)
}

/**
 * Read one FriendliAI listing reply. Entries without a usable id, and entries
 * carrying a `deprecation_date`, are skipped rather than failing the whole
 * interrogation: a single unusable row should not deny the user the rest of a
 * working endpoint's catalog.
 * @param body - the parsed JSON reply.
 * @returns the adoptable models, sized where the endpoint disclosed capacities.
 */
export function readListing(body: unknown): LlmDiscoveredModel[] {
  const data = (body as { data?: unknown } | null)?.data
  if (!Array.isArray(data)) {
    throw new LlmError(
      'the endpoint\'s model listing has no "data" array; enter this provider\'s models by hand',
      'DISCOVERY_FAILED',
    )
  }
  const models: LlmDiscoveredModel[] = []
  for (const raw of data) {
    const entry = raw as WireModelListingEntry
    const id = label(entry.id)
    if (id === undefined) continue
    // A listing membership is not access: a deprecated model still appears,
    // but a request to it is refused, so it is not offered for adoption.
    if (entry.deprecation_date !== undefined && entry.deprecation_date !== null) continue
    const name = label(entry.name)
    const contextWindow = capacity(entry.context_length)
    const maxTokens = capacity(entry.max_completion_tokens)
    models.push({
      id,
      ...name === undefined || name === id ? {} : { name },
      ...contextWindow === undefined ? {} : { contextWindow },
      ...maxTokens === undefined ? {} : { maxTokens },
    })
  }
  return models
}

/**
 * Interrogate a FriendliAI-compatible endpoint's `GET /models` listing.
 * @param request - the draft being edited: endpoint and a per-interrogation credential.
 * @param storedApiKey - resolves the credential a named route already holds, for a draft carrying none.
 * @returns the adoptable models the endpoint reports.
 * @throws LlmError coded `DISCOVERY_FAILED` (unreachable, non-2xx, non-JSON, or shapeless) or `ABORTED`.
 */
export async function discoverModels(
  request: LlmModelDiscoveryRequest,
  storedApiKey: () => Promise<string | undefined>,
): Promise<LlmDiscoveredModel[]> {
  if (request.baseURL === undefined || request.baseURL.length === 0) {
    throw new LlmError(
      'model discovery needs an endpoint; set this provider\'s baseURL before fetching its models',
      'DISCOVERY_FAILED',
    )
  }
  const url = listingUrl(request.baseURL)
  const apiKey = request.apiKey ?? await storedApiKey()
  let response: Response
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: {
        'accept': 'application/json',
        ...attributionHeaders(),
        ...apiKey === undefined || apiKey.length === 0 ? {} : { authorization: `Bearer ${apiKey}` },
      },
      ...request.signal === undefined ? {} : { signal: request.signal },
    })
  } catch (error: unknown) {
    if (request.signal?.aborted) {
      throw new LlmError('model discovery aborted by caller', 'ABORTED', { cause: error })
    }
    throw new LlmError(`could not reach ${url}`, 'DISCOVERY_FAILED', { cause: error })
  }
  if (!response.ok) {
    throw new LlmError(
      `${url} answered ${response.status}${response.status === 401 || response.status === 403 ? '; check the API key' : ''}`,
      'DISCOVERY_FAILED',
    )
  }
  let text: string
  try {
    text = await readBounded(response, url)
  } catch (error: unknown) {
    if (request.signal?.aborted) {
      throw new LlmError('model discovery aborted by caller', 'ABORTED', { cause: error })
    }
    throw error
  }
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch (error: unknown) {
    throw new LlmError(`${url} did not answer with JSON`, 'DISCOVERY_FAILED', { cause: error })
  }
  return readListing(body)
}
