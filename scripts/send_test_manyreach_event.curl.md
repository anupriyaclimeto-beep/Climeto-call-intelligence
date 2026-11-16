# Curl smoke tests for Manyreach webhook

Set secret first (PowerShell):

```powershell
$env:MANYREACH_WEBHOOK_SECRET = "dev-secret"
$base = "http://localhost:4200"
```

Reply:

```powershell
curl -X POST "$base/api/webhooks/manyreach?token=$env:MANYREACH_WEBHOOK_SECRET" `
  -H "Content-Type: application/json" `
  -d "{\"id\":\"curl-reply-1\",\"event_type\":\"replied\",\"email\":\"procurement@abcpolymers.in\",\"campaign_name\":\"EPR Pricing Sequence\",\"timestamp\":\"2026-11-16T10:00:00Z\"}"
```

Click:

```powershell
curl -X POST "$base/api/webhooks/manyreach?token=$env:MANYREACH_WEBHOOK_SECRET" `
  -H "Content-Type: application/json" `
  -d "{\"id\":\"curl-click-1\",\"event_type\":\"clicked\",\"email\":\"procurement@abcpolymers.in\",\"url\":\"https://climeto.com/pricing-brochure.pdf\",\"campaign_name\":\"EPR Pricing Sequence\"}"
```

Open / Bounce:

```powershell
curl -X POST "$base/api/webhooks/manyreach?token=$env:MANYREACH_WEBHOOK_SECRET" -H "Content-Type: application/json" -d "{\"id\":\"curl-open-1\",\"event_type\":\"opened\",\"email\":\"admin@shreeindustries.in\"}"
curl -X POST "$base/api/webhooks/manyreach?token=$env:MANYREACH_WEBHOOK_SECRET" -H "Content-Type: application/json" -d "{\"id\":\"curl-bounce-1\",\"event_type\":\"bounced\",\"email\":\"bad@example.com\"}"
```

Inspect raw payload (mapping debug):

```powershell
curl "$base/api/webhooks/manyreach/debug?token=$env:MANYREACH_WEBHOOK_SECRET&limit=5"
```

Feed:

```powershell
curl "$base/api/campaigns/feed?limit=20"
```
