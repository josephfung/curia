# ADR-007: Anthropic as primary LLM with provider-agnostic interface

Date: 2026-02-05
Status: Accepted

## Context

The system needs an LLM provider for agent reasoning and tool use. The primary candidates at design time were Anthropic (Claude), OpenAI (GPT-4), and self-hosted models (Ollama). The decision had two parts: which provider to use by default, and whether to abstract the provider behind an interface.

## Decision

Anthropic (Claude) is the primary LLM provider. The `AgentRuntime` uses a provider-agnostic interface so that OpenAI and Ollama implementations can be registered alongside the Anthropic default.

**Why Anthropic as primary:**
- Claude's tool use (function calling) API is the most ergonomic for multi-step agent workflows at the time of design.
- Claude has stronger documented safety properties for an executive assistant use case — reduced likelihood of prompt injection following through to harmful actions.
- The existing `ceo-deploy` infrastructure already had Anthropic API credentials.

**Why a provider-agnostic interface:**
- Vendor lock-in at the architecture level is a significant long-term risk. Prices, quality, and API availability change.
- Different agents may benefit from different providers (e.g., a fast cheap model for classification, a capable model for complex reasoning).
- The interface cost is low — a thin adapter per provider, all conforming to the same `LLMProvider` contract.

The SDK list in `package.json` includes `@anthropic-ai/sdk`, `openai`, and `ollama` — all three are available for registration.

## Consequences

- Switching the primary provider or running agents on different providers requires only a config change, not code changes.
- Each new provider requires a thin adapter implementing the `LLMProvider` interface.
- The system is not fully provider-neutral — capabilities like tool use and streaming must be supported by whichever provider is used for a given agent.
- Anthropic API rate limits and pricing are a live operational concern; the interface makes it easy to add fallback providers if needed.
