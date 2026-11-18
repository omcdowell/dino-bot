---
title: Provider options
description: Sandboxing, permissions, and network rules for Codex, Claude, and OpenCode agents created from the SDK.
nav: Provider options
order: 55
category: TypeScript SDK
---

# Provider options

Provider options are an opaque `Record<string, unknown>` passed to the provider.
The provider decides how to validate and apply it. Pi reads `sessionDir` and
`rpcTimeoutMs`; plugin providers interpret their own keys. Providers without
option handling ignore the record.

You set options in two places:

- **Provider defaults:** `config.json` → `agents.providers.<id>.options`.
- **One agent:** `config.options` in `client.agents.create()`. Its wire name is
  `providerOptions`.

The daemon deep-merges the agent's options over the provider defaults at session
launch or resume. Plain objects merge recursively; arrays, scalars, and `null`
replace the base value. Only the agent's own options are stored. Changing
`config.json` defaults takes effect on the next launch or resume.

For example, set Pi defaults once:

```json
{
  "agents": {
    "providers": {
      "pi": {
        "options": {
          "rpcTimeoutMs": 60000,
          "sessionDir": "~/.pi/agent/sessions"
        }
      }
    }
  }
}
```

Then create one agent with `config.options: { rpcTimeoutMs: 120000 }`. It
receives `120000` and retains `sessionDir`. With no per-agent options it receives
the defaults above. Keys are provider-native.

Provider options are not a host boundary. They constrain the agent CLI, which runs as your user on your machine. For untrusted work, run the daemon in a container or on a separate machine. See [Security](/docs/security).

DinoBot deleted the Codex, Claude Agent SDK and OpenCode providers, and their option schemas with them.

## Modes and options

`modeId` picks a Paseo mode from the provider's published list, which the daemon shows in the app and reports through [provider discovery](/docs/sdk/providers). `options` is the provider's own configuration. They are separate controls and you can set both:

```ts
config: {
  provider: "codex/gpt-5.5",
  modeId: "full-access",
  options: {
    approval_policy: "never",
    sandbox_mode: "read-only",
  },
}
```

Where the two overlap, `options` wins. Above, Codex runs read-only even though `full-access` would otherwise grant more.
