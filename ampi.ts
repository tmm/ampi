import { execute, type AssistantMessage as AmpAssistantMessage, type UserMessage as AmpUserMessage, type Usage as AmpUsage } from "@sourcegraph/amp-sdk"
import { createAssistantMessageEventStream, type Api, type AssistantMessage, type AssistantMessageEventStream, type Context, type Message, type Model, type SimpleStreamOptions, type ToolCall, type Usage } from "@mariozechner/pi-ai"
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"

const AMP_PROVIDER = "amp"
const AMP_API = "amp-sdk"
const AMP_STATUS_KEY = "amp-provider"

const MODELS = [
  {
    id: "smart",
    name: "Amp Smart",
    reasoning: false,
  },
  {
    id: "rush",
    name: "Amp Rush",
    reasoning: false,
  },
  {
    id: "deep",
    name: "Amp Deep",
    reasoning: true,
  },
] as const

let ampThreadId: string | null = null
let uiContext: import("@mariozechner/pi-coding-agent").ExtensionContext | null = null

export default function ampHeadlessPoc(pi: ExtensionAPI): void {
  pi.registerProvider(AMP_PROVIDER, {
    baseUrl: "https://ampcode.com/sdk",
    apiKey: "amp-sdk-managed",
    api: AMP_API,
    models: MODELS.map((model) => ({
      id: model.id,
      name: model.name,
      reasoning: model.reasoning,
      input: ["text"] as const,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 256000,
      maxTokens: 32000,
    })),
    streamSimple: streamFromAmp,
  })

  pi.on("session_start", async (_event, ctx) => {
    uiContext = ctx

    if (!ctx.hasUI) {
      return
    }

    ctx.ui.notify("Amp provider loaded. Switch models with /model amp/smart, amp/rush, or amp/deep.", "info")
  })

}

function streamFromAmp(model: Model<Api>, context: Context, options?: SimpleStreamOptions) {
  const stream = createAssistantMessageEventStream()
  const output = createEmptyAssistantMessage(model)

  ;(async () => {
    const prompt = buildAmpPrompt(context)
    const mode = toAmpMode(model.id)
    const ampTextByBlock = new Map<number, string>()
    const seenToolUses = new Set<string>()
    let textBlockIndex: number | null = null
    let sawAssistantText = false

    const ensureTextBlock = () => {
      if (textBlockIndex !== null) {
        return textBlockIndex
      }

      output.content.push({ type: "text", text: "" })
      textBlockIndex = output.content.length - 1
      stream.push({ type: "text_start", contentIndex: textBlockIndex, partial: output })
      return textBlockIndex
    }

    const closeTextBlock = () => {
      if (textBlockIndex === null) {
        return
      }

      const content = output.content[textBlockIndex]
      if (content.type === "text") {
        stream.push({ type: "text_end", contentIndex: textBlockIndex, content: content.text, partial: output })
      }

      textBlockIndex = null
    }

    const appendText = (delta: string) => {
      if (!delta) {
        return
      }

      const index = ensureTextBlock()
      const content = output.content[index]
      if (content.type !== "text") {
        throw new Error("Amp provider text block was replaced unexpectedly")
      }

      content.text += delta
      stream.push({ type: "text_delta", contentIndex: index, delta, partial: output })
      sawAssistantText = true
    }

    const setWorking = (message?: string) => {
      if (uiContext?.hasUI) {
        uiContext.ui.setWorkingMessage(message)
      }
    }

    stream.push({ type: "start", partial: output })

    try {
      for await (const message of execute({
        prompt,
        signal: options?.signal,
        options: {
          cwd: process.cwd(),
          dangerouslyAllowAll: true,
          mode,
          systemPrompt: context.systemPrompt,
          ...(ampThreadId ? { continue: ampThreadId } : {}),
        },
      })) {
        if (!ampThreadId && message.session_id) {
          ampThreadId = message.session_id
        }

        if (message.type === "assistant") {
          absorbAssistantMessage(message, ampTextByBlock, seenToolUses, stream, output, appendText, closeTextBlock, setWorking)
          output.usage = mapAmpUsage(message.message.usage)
          continue
        }

        if (message.type === "user") {
          absorbUserMessage(message, appendText)
          continue
        }

        if (message.type === "result") {
          output.usage = mapAmpUsage(message.usage)

          if (message.is_error) {
            throw new Error(message.error)
          }

          if (!sawAssistantText && message.result) {
            appendText(message.result)
          }
        }
      }

      closeTextBlock()
      setWorking()

      output.stopReason = "stop"
      stream.push({ type: "done", reason: output.stopReason, message: output })
      stream.end()
    } catch (error: unknown) {
      setWorking()
      output.stopReason = options?.signal?.aborted ? "aborted" : "error"
      output.errorMessage = error instanceof Error ? error.message : String(error)
      stream.push({ type: "error", reason: output.stopReason, error: output })
      stream.end()
    }
  })()

  return stream
}

function absorbAssistantMessage(
  message: AmpAssistantMessage,
  textByBlock: Map<number, string>,
  seenToolUses: Set<string>,
  stream: AssistantMessageEventStream,
  output: AssistantMessage,
  appendText: (delta: string) => void,
  closeTextBlock: () => void,
) {
  for (const [index, content] of message.message.content.entries()) {
    if (content.type === "text") {
      const previous = textByBlock.get(index) ?? ""
      const next = content.text ?? ""
      const delta = getAppendOnlyDelta(previous, next)
      textByBlock.set(index, next)
      appendText(delta)
      continue
    }

    if (!seenToolUses.has(content.id)) {
      seenToolUses.add(content.id)

      // Surface tool activity as text so pi shows what Amp is doing
      appendText(`\n🔧 ${content.name}\n`)
      closeTextBlock()

      const toolCall: ToolCall = {
        type: "toolCall",
        id: content.id,
        name: content.name,
        arguments: content.input as Record<string, any>,
      }

      output.content.push(toolCall)
      const contentIndex = output.content.length - 1
      stream.push({ type: "toolcall_start", contentIndex, partial: output })
      stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: output })
    }
  }
}

function absorbUserMessage(
  message: AmpUserMessage,
  appendText: (delta: string) => void,
) {
  for (const content of message.message.content) {
    if (content.type === "tool_result") {
      const label = content.is_error ? "Tool Error" : "Tool Result"
      const body = content.content.length > 200 ? `${content.content.slice(0, 197)}...` : content.content
      appendText(`\n[${label}: ${body}]\n`)
    }
  }
}

function buildAmpPrompt(context: Context): string {
  // When continuing an existing Amp thread, only send the latest user message
  // since Amp already has prior context. Send the full transcript only on the
  // first turn to establish the system framing.
  if (ampThreadId) {
    const lastUserMessage = findLastUserMessage(context.messages)
    return lastUserMessage ?? ""
  }

  const transcript = context.messages
    .map(renderTranscriptMessage)
    .filter((message): message is string => Boolean(message))
    .join("\n\n")

  return [
    "# User State\n",
    "You are running behind the pi terminal UI through a thin Amp SDK adapter.",
    "Treat the transcript below as the full pi conversation state for this turn.",
    "Do not ask pi to execute tools for you; use your own Amp tools directly when you need them.",
    "Keep continuity with the transcript and respond to the latest user request.",
    "",
    transcript || "No prior pi conversation was provided.",
  ].join("\n")
}

function findLastUserMessage(messages: Message[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.role === "user") {
      return readPiMessageText(message)
    }
  }

  return null
}

function renderTranscriptMessage(message: Message): string | null {
  if (message.role === "user") {
    return renderLabeledBlock("User", readPiMessageText(message))
  }

  if (message.role === "assistant") {
    return renderLabeledBlock("Assistant", readPiAssistantText(message))
  }

  if (message.role === "toolResult") {
    const toolResult = readPiToolResultText(message)
    return renderLabeledBlock(`Tool Result (${message.toolName})`, toolResult)
  }

  return null
}

function renderLabeledBlock(label: string, body: string): string | null {
  const normalized = body.trim()
  if (!normalized) {
    return null
  }

  return `${label}:\n${normalized}`
}

function readPiMessageText(message: Extract<Message, { role: "user" }>): string {
  if (typeof message.content === "string") {
    return message.content
  }

  return message.content
    .map((content) => (content.type === "text" ? content.text : `[image omitted: ${content.mimeType}]`))
    .join("\n")
}

function readPiAssistantText(message: Extract<Message, { role: "assistant" }>): string {
  return message.content
    .map((content) => {
      if (content.type === "text") {
        return content.text
      }

      if (content.type === "toolCall") {
        return `[pi tool call: ${content.name} ${truncateJson(content.arguments)}]`
      }

      return ""
    })
    .filter(Boolean)
    .join("\n")
}

function readPiToolResultText(message: Extract<Message, { role: "toolResult" }>): string {
  const body = message.content
    .map((content) => (content.type === "text" ? content.text : `[image omitted: ${content.mimeType}]`))
    .join("\n")

  if (message.isError) {
    return `${body}\n[tool returned an error]`.trim()
  }

  return body
}

function getAppendOnlyDelta(previous: string, next: string): string {
  if (!next) {
    return ""
  }

  if (!previous) {
    return next
  }

  if (next.startsWith(previous)) {
    return next.slice(previous.length)
  }

  return `\n${next}`
}

function truncateJson(value: unknown): string {
  try {
    const json = JSON.stringify(value)
    if (!json) {
      return "{}"
    }

    if (json.length <= 240) {
      return json
    }

    return `${json.slice(0, 237)}...`
  } catch {
    return "[unserializable input]"
  }
}

function toAmpMode(modelId: string): "smart" | "rush" | "deep" {
  if (modelId === "rush") {
    return "rush"
  }

  if (modelId === "deep") {
    return "deep"
  }

  return "smart"
}

function createEmptyAssistantMessage(model: Model<Api>): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: createEmptyUsage(),
    stopReason: "stop",
    timestamp: Date.now(),
  }
}

function createEmptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  }
}

function mapAmpUsage(usage: AmpUsage | undefined): Usage {
  if (!usage) {
    return createEmptyUsage()
  }

  const input = usage.input_tokens
  const output = usage.output_tokens
  const cacheRead = usage.cache_read_input_tokens ?? 0
  const cacheWrite = usage.cache_creation_input_tokens ?? 0

  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  }
}
