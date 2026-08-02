# Org onboarding map

This is an **onboarding map to verify in 1:1s, not a performance review**. Every
number below is a structural proxy computed mechanically from a Jira
export — no model read any message. Treat each figure as a question to ask, not a
verdict. People are never ranked or scored; there is no composite number here.

## Metric formulas

Every metric carries its formula and source (a number never appears without its
derivation):

- **ticketCount** — formula: count of Jira issues assigned to the person.
- **storyPointsTotal** — formula: sum of customfield_10016 over assigned issues.
- **complexityMix** — formula: story-point band per issue: lo <=2, med =3, hi >=5 (fallback: issue type).
- **medianCycleDays** — formula: median of (resolutiondate - created)/86400000 over resolved issues, split at the data midpoint.
- **reopenRate** — formula: 100 * (assigned issues with a Reopened status transition) / ticketCount.
- **reassignments** — formula: count of changelog assignee changes (given = from-person, received = to-person).
- **helpGiven / helpReceived** — formula: help-edge degree: a thread reply carrying a mention or later thanks.
- **weekendOffHoursShare** — formula: 100 * (off-hours timestamps) / (all timestamps), off-hours = weekend OR hour<7 OR hour>=22 UTC.

## Per-person metrics

| accountId | name | active | tickets | storyPoints | hi/med/lo | reopen% | reassign g/r | helpGiven | helpReceived | offHours% | cycle 1st/2nd |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| acc_ann | Ann Alvarez | yes | 2 | 8 | 1/1/0 | 50 | 1/0 | n/a | n/a | 0 | 3/2.3 |
| acc_bea | Bea Brandt | yes | 1 | 2 | 0/0/1 | 0 | 0/1 | n/a | n/a | 0 | 0/0.4 |

## Tracker-view vs chat-view

The Jira tracker view (tickets, story points) and the Slack chat view (help
given/received) can diverge sharply: a mid-pack story-point total can hide a top
help hub, and a high ticket count can hide low-weight work with no help given.
Read the two columns together, never one alone.

## Not evaluated without a Slack export

No Slack export was provided, so the following chat-derived signals could not
be evaluated and are omitted rather than guessed:

- help given / received per person (shown as `n/a`)
- KNOWLEDGE FLOW help hubs
- INVISIBLE VALUE (chat help versus tracker weight)
- Slack-only incidents and the approval-vacuum pattern

## Findings

### 1. WORKLOAD CONCENTRATION

Top 2 by story points carry 100% of the team total (10/10). Formula: sum(storyPoints) per assignee, top-2 share of the grand total.

Evidence pointer:

```json
{
  "accountIds": [
    "acc_ann",
    "acc_bea"
  ],
  "names": [
    "Ann Alvarez",
    "Bea Brandt"
  ],
  "topStoryPoints": 10,
  "totalStoryPoints": 10,
  "sharePct": 100
}
```

### 2. INVISIBLE VALUE (chat help vs tracker weight)

Not evaluated: no Slack export was provided, so chat help versus tracker weight (helpGiven) could not be measured.

Evidence pointer:

```json
{
  "notEvaluated": true,
  "reason": "no Slack export"
}
```

### 3. PROCESS GAPS (Slack-only incidents + ticket-less deploys)

Not evaluated: no Slack export was provided, so Slack-only incidents and ticket-less deploy threads could not be measured.

Evidence pointer:

```json
{
  "notEvaluated": true,
  "reason": "no Slack export"
}
```

### 4. APPROVAL VACUUM (post-departure deploys)

Not evaluated: no Slack export was provided, so the post-departure approval vacuum in deploy threads could not be measured.

Evidence pointer:

```json
{
  "notEvaluated": true,
  "reason": "no Slack export"
}
```

### 5. BUS FACTOR (per-service ownership)

Distinct assignee set per service; a small set concentrates knowledge risk. Formula: count of distinct assignees per Jira component (>=5 issues = meaningful owner).

Evidence pointer:

```json
{
  "services": [
    {
      "id": "cart",
      "distinctAssignees": 1,
      "busFactor": 0,
      "assignees": [
        {
          "accountId": "acc_ann",
          "displayName": "Ann Alvarez",
          "count": 1
        }
      ]
    },
    {
      "id": "checkout",
      "distinctAssignees": 1,
      "busFactor": 0,
      "assignees": [
        {
          "accountId": "acc_ann",
          "displayName": "Ann Alvarez",
          "count": 1
        }
      ]
    },
    {
      "id": "pricing",
      "distinctAssignees": 1,
      "busFactor": 0,
      "assignees": [
        {
          "accountId": "acc_bea",
          "displayName": "Bea Brandt",
          "count": 1
        }
      ]
    }
  ]
}
```

### 6. KNOWLEDGE FLOW (help hubs)

Not evaluated: no Slack export was provided, so help-graph hubs (help interactions) could not be measured.

Evidence pointer:

```json
{
  "notEvaluated": true,
  "reason": "no Slack export"
}
```
