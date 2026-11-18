---
title: Custom providers
description: Configure custom providers, alternative endpoints, profiles and custom binaries in ~/.paseo/config.json.
nav: Custom providers
order: 22
category: Providers
---

# Custom providers

Paseo supports configuring custom agent providers through `config.json` (located at `$PASEO_HOME/config.json`, typically `~/.paseo/config.json`). You can create profiles of the built-in Pi provider, set custom binaries, and disable providers. DinoBot deleted the ACP, Codex, OpenCode, OMP and Claude Agent SDK providers; config entries that name them (by ID or `extends`) are skipped with a warning.

Provider definitions live under `agents.providers` in config.json:

```json
{
  "version": 1,
  "agents": {
    "providers": {
      "provider-id": { ... }
    }
  }
}
```

Provider IDs must be lowercase alphanumeric with hyphens (`/^[a-z][a-z0-9-]*$/`).

Each provider catalog refresh waits up to 2 minutes. If a provider loads many plugins or a large
agent catalog during startup, raise the limit in milliseconds:

```json
{
  "agents": {
    "catalogRefreshTimeoutMs": 180000
  }
}
```

The limit applies independently to every provider refresh and covers availability plus the entire
catalog probe. `PASEO_PROVIDER_REFRESH_TIMEOUT_MS` sets it when the config field is absent.

## Provider options

Set provider defaults in `agents.providers.<id>.options`. At agent creation, use
`providerOptions` on the wire or `config.options` in the SDK. Both are opaque
`Record<string, unknown>` values: the provider owns validation and application.
Providers without option handling ignore the record.

The daemon deep-merges the agent's options over the provider defaults at each
session launch or resume. Plain objects merge recursively; arrays, scalars, and
`null` replace the base value. Only the agent's own options are persisted, so edits
to provider defaults apply on the next launch or resume. A profile inherits its
base provider's options unless it sets its own options record.

---

## Extending the built-in provider

Use `extends` to create a new provider entry that inherits from `pi`. The new provider gets its own entry in the provider list, with its own label, environment, and model definitions.

```json
{
  "agents": {
    "providers": {
      "pi-work": {
        "extends": "pi",
        "label": "Pi (Work)",
        "env": {
          "PI_CODING_AGENT_DIR": "~/.pi-work/agent"
        }
      }
    }
  }
}
```

Required fields for custom providers:

- `extends` — the built-in provider to inherit from (`pi`)
- `label` — display name in the UI

---

## Custom binary and Pi-compatible forks

For providers that keep Pi's `--mode rpc` API but use another binary or write sessions somewhere else, extend `pi`, replace the command, and provide the JSONL session directory:

```json
{
  "agents": {
    "providers": {
      "my-pi-fork": {
        "extends": "pi",
        "label": "My Pi Fork",
        "command": ["my-pi-fork"],
        "options": {
          "sessionDir": "~/.my-pi-fork/sessions",
          "rpcTimeoutMs": 60000
        }
      }
    }
  }
}
```

`options.sessionDir` is import-only. Launching and resuming still go through the configured command, so this example resumes with `my-pi-fork --mode rpc --session <session-file>`. `options.rpcTimeoutMs` overrides the 60-second Pi control-plane RPC deadline.

---

## Disabling a provider

Set `enabled: false` to hide a provider from the provider list. The provider will not appear in the app or CLI.

```json
{
  "agents": {
    "providers": {
      "pi": { "enabled": false }
    }
  }
}
```

This works for both built-in and custom providers. To re-enable, set `enabled: true` or remove the `enabled` field entirely.

---

## Provider override reference

Every entry under `agents.providers` accepts these fields:

| Field              | Type                      | Required          | Description                                                        |
| ------------------ | ------------------------- | ----------------- | ------------------------------------------------------------------ |
| `extends`          | `string`                  | Yes (custom only) | Built-in provider ID to inherit from (`pi`)                        |
| `label`            | `string`                  | Yes (custom only) | Display name in the UI                                             |
| `description`      | `string`                  | No                | Short description shown in the UI                                  |
| `command`          | `string[]`                | No                | Command to spawn the agent process                                 |
| `env`              | `Record<string, string>`  | No                | Environment variables to set for the agent process                 |
| `options`          | `Record<string, unknown>` | No                | Provider-specific options such as `supportsMcpServers: false`      |
| `models`           | `ProviderProfileModel[]`  | No                | Static model list (overrides runtime discovery)                    |
| `additionalModels` | `ProviderProfileModel[]`  | No                | Static model additions (merged with runtime discovery or `models`) |
| `disallowedTools`  | `string[]`                | No                | Tool names to disable for this provider (e.g. `["WebSearch"]`)     |
| `enabled`          | `boolean`                 | No                | Set to `false` to hide the provider (default: `true`)              |
| `order`            | `number`                  | No                | Sort order in the provider list                                    |

### Model definition

Each entry in the `models` array:

| Field             | Type               | Required | Description                           |
| ----------------- | ------------------ | -------- | ------------------------------------- |
| `id`              | `string`           | Yes      | Model identifier sent to the provider |
| `label`           | `string`           | Yes      | Display name in the UI                |
| `description`     | `string`           | No       | Short description                     |
| `isDefault`       | `boolean`          | No       | Mark as the default model selection   |
| `thinkingOptions` | `ThinkingOption[]` | No       | Available thinking/reasoning levels   |

### Thinking option

| Field         | Type      | Required | Description                         |
| ------------- | --------- | -------- | ----------------------------------- |
| `id`          | `string`  | Yes      | Thinking option identifier          |
| `label`       | `string`  | Yes      | Display name                        |
| `description` | `string`  | No       | Short description                   |
| `isDefault`   | `boolean` | No       | Mark as the default thinking option |

### Valid `extends` values

Built-in providers: `pi`
