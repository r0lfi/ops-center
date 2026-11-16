# Mistral AI provider

Ops Center can run native agents on Mistral AI (La Plateforme,
`https://api.mistral.ai`), next to Anthropic, OpenAI, Ollama and
OpenAI-compatible endpoints.

## Setup
1. Migration `0058` seeds a provider row `mistral` (kind `mistral`,
   display name "Mistral AI", default model `mistral-large-4`). It is
   disabled and has no key. No agent is moved.
2. Settings -> AI Providers -> Mistral AI -> Configure: paste the API key,
   tick **Enabled**, save. The key is stored under the secrets root like the
   other provider keys, never in the database.
3. AI Agents -> an agent -> pick the Mistral AI provider and, if wanted, a model.

## Models and budget
The shared weekly AI budget prices only reviewed models and fails closed for
everything else (see `backend/app/core/ai_pricing.py`). Reviewed on
2026-11-12 from https://docs.mistral.ai/inference/pricing:

| Model id | Input USD/MTok | Output USD/MTok |
|---|---|---|
| `mistral-large-4` | 0.70 | 2.10 |
| `mistral-small-2603` | 0.15 | 0.60 |

Cached input is billed at 0.1x; Mistral does not charge for cache writes.
`-latest` aliases are not priced because their target can change. A
custom base URL for kind `mistral` is also blocked by the budget.

Mistral is a cloud provider: Nova sources only reach it when the source
allows cloud models.

## Implementation
`worker_ai/ai/providers/mistral.py` reuses the OpenAI chat parsing with
Mistral's differences: `max_tokens`, no `service_tier`, tool arguments as
an object, content as a list of chunks (only text chunks are kept),
`model_length` as a length stop, and `name` on tool result messages.
