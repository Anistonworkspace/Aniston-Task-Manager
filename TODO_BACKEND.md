# Backend follow-ups for the Home page redesign

The bento-grid Home page (`client/src/pages/HomePage.jsx`) is intentionally
rendering skeleton placeholders in several places because the data isn't
exposed by the API yet. Once the endpoints below ship, the Home page will
animate the real values in automatically — no client changes required beyond
swapping `empty` props for the new fields.

---

## 1. Week-over-week completion delta — `/dashboard/stats`

**Current:** `stats.completionRate` is a number.
**Needed:** an object with current, previous, and delta values.

```jsonc
// GET /api/dashboard/stats
{
  "completionRate": {
    "current": 67,    // % completed in the current period
    "previous": 72,   // % completed in the prior period (same length)
    "delta": -5       // current - previous, as percentage points
  },
  // ...rest of stats unchanged
}
```

- Period definition: prefer rolling 7-day windows ending now, but a "current
  ISO week vs previous ISO week" definition is also acceptable as long as it
  is documented in the API.
- `delta === 0` and `delta === null` should both omit the trend chip on the
  client. The chip already handles this — see `showTrendChip` in HomePage.

**Backwards compat:** keep the legacy number form working (`stats.completionRate
= 67`) until clients are migrated. The Home page already supports both shapes.

---

## 2. 7-day daily series — `/dashboard/stats?range=7d`

The Completion Rate hero tile, the Total Tasks slim tile, and the In Progress
distribution strip all want a daily time series. Instead of three separate
endpoints, extend `/dashboard/stats` with a `range` parameter:

```jsonc
// GET /api/dashboard/stats?range=7d
{
  "completionRate": { "current": 67, "previous": 72, "delta": -5 },
  "trend": {
    "completion":  [62, 65, 60, 68, 70, 65, 67],   // % per day, oldest → newest
    "totalTasks":  [12, 14, 13, 15, 18, 17, 19],   // counts per day
    "inProgress": {                                 // distribution split
      "planning": 0.30,
      "doing":    0.50,
      "review":   0.20
    }
  }
}
```

- 7 numbers in each array (oldest first).
- `inProgress` ratios should sum to 1.0; the client renders them as a stacked
  bar at the bottom of the In Progress tile.
- For users who can't see team-wide data (`canManage === false`), the same
  endpoint should respond with personally-scoped values from the same query,
  not a separate route.

Once shipped, replace these placeholder calls in HomePage:

```jsx
<Sparkline empty />            →  <Sparkline data={stats.trend.completion} />
<MiniBars empty />             →  <MiniBars data={stats.trend.totalTasks} />
<div className="...bg-surface-100" />   →  real stacked bar from stats.trend.inProgress
```

---

## 3. Assignees on `/tasks?assignedTo=me` — `include=assignees`

The Team Tasks tile shows a stacked avatar group of teammates working on
tasks alongside the user. The `/tasks` endpoint currently returns the
primary assignee only — we need the full assignee list including supervisors
on each task so the client can dedupe and stack them.

```jsonc
// GET /api/tasks?assignedTo=me&include=assignees&limit=20
{
  "tasks": [
    {
      "id": "...",
      "title": "...",
      "assignees": [
        { "id": "u1", "name": "Maya Chen",  "avatar": "...", "role": "assignee"   },
        { "id": "u2", "name": "Alex Park",  "avatar": "...", "role": "supervisor" }
      ],
      // ...rest of task
    }
  ]
}
```

- Cap each task's `assignees` array at the top 5 by `assignedAt` desc to keep
  the payload bounded.
- The client will flatten + dedupe across all returned tasks and pass the
  result to `<AvatarStack users={...} />`.

---

## Reference: where each placeholder lives

| Placeholder                              | File                                                                | Trigger                                            |
|------------------------------------------|---------------------------------------------------------------------|----------------------------------------------------|
| Trend chip on Completion Rate hero       | `client/src/pages/HomePage.jsx` (`showTrendChip`)                   | Renders only when `stats.completionRate.delta` is a non-zero number |
| Sparkline under Completion Rate hero     | `client/src/pages/HomePage.jsx` (search `Sparkline empty`)          | Replace `empty` with `data={stats.trend.completion}` |
| MiniBars under Completed tile            | `client/src/pages/HomePage.jsx` (search `MiniBars empty`)           | Replace `empty` with `data={stats.trend.completed}` (or a derived view) |
| Distribution strip under In Progress     | `client/src/pages/HomePage.jsx` (search "Skeleton distribution")    | Replace flat track with stacked bar from `stats.trend.inProgress` |
| Sparkline under Total Tasks slim tile    | `client/src/pages/HomePage.jsx`                                     | Replace `empty` with `data={stats.trend.totalTasks}` |
| AvatarStack on Team Tasks tile           | `client/src/pages/HomePage.jsx` (search `AvatarStack empty`)        | Replace `empty` with `users={dedupedAssignees}` |
