# Regional variation (Agentur-specific requirements)

BA requirements are mostly the same everywhere, but each Agentur für Arbeit has small
differences (extra fields, different document lists, different submission formats or
deadlines). The product must absorb these **without code changes**.

## Principle: fixed core, configurable edges

| Fixed (code) | Configurable (data) |
|---|---|
| Lifecycle states & allowed transitions | Required fields per step |
| Audit, permissions model | Required documents per step |
| Data model of core entities | Form & document templates (versioned) |
| Completeness engine (how rules are evaluated) | Completeness rules (what must be true) |
| | Deadlines, reminder rules, wording/help texts |

Do **not** build a generic workflow engine. Only the edges are configurable.

## Configuration model

```
RegionalTemplate (e.g. "Agentur Nürnberg", version 3)
  ├─ steps:
  │    data_collection:  requiredFields[], requiredDocuments[], fieldSchemas (Zod/JSON Schema)
  │    profiling:        requiredFields[], formTemplates[]
  │    agentur_submission: formTemplates[], submissionChannel, deadlineRule
  │    dsv:              documentTemplate, deadlineRule
  ├─ reminderRules[]
  └─ helpTexts{}

Project
  └─ appliedTemplate: RegionalTemplate@version  (copied/snapshotted at project creation)
  └─ projectOverrides: partial config (audited)
```

- Templates are **versioned**. A project snapshots the template version at creation; later
  template changes do not silently change running projects (PL can choose to upgrade).
- Every generated document records the **template version** used.
- **Resolution order:** base defaults → regional template → project overrides.
- Custom fields are stored as typed JSON (`jsonb`) validated by the resolved schema; core
  fields are real columns.

## To collect from Projektleiter (fill this table)

For each location/Agentur, list what differs from the base process. This table is the input
for the first regional templates.

| Location / Agentur | Step | Difference | Example / form name | Source (PL name, date) |
|---|---|---|---|---|
| _e.g. Nürnberg_ | _profiling_ | _additional field: …_ | _…_ | _…_ |
| | | | | |
| | | | | |

Questions to ask each PL:
1. Which forms do you submit to your Agentur, in which version, through which channel
   (paper, email, upload portal)?
2. Which fields/documents does your Agentur ask for that others don't?
3. Are there different deadlines (e.g. before TG start)?
4. What gets rejected most often, and why?
5. What do you track today in Excel that isn't required but you need?
