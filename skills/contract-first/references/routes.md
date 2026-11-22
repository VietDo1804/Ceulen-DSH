# Changing a party's model for one task

`delegate` takes no model argument: a role's route comes from the Ceulen
settings document, which `delegate` re-reads on every call. So the only per-task
knob is an edit of that document, and it applies to the next dispatch with no
restart. A route change never reaches a party that is already running.

Routes live in `~/.dsh/ceulen/settings.json`:
- `subagent.models.<role>`: `provider/model`; a `:effort` suffix wins over
  `subagent.thinking.<role>`; `*` inherits the lead session's route.
- `subagent.thinking.<role>`: the reasoning effort when the route has no suffix.
- `subagent.roles`: named chains a role can point at.

```
routes for this task
  planner   zai/glm-5.3-flash:max
  worker    opencode-go/deepseek-v4.1-flash:max      x2 (be, fe)
  reviewer  zai/glm-5.3-flash:max
  tester    opencode-go/deepseek-v4.1-flash:max
```

## Override, step by step

1. `cp ~/.dsh/ceulen/settings.json ~/.dsh/ceulen/settings.json.bak-<task>`
2. Set `subagent.models.<role>` to the route you want.
3. Read the file back and check that it still parses: malformed JSON silently
   falls back to the defaults, so a vanished override means the edit broke the
   file. In orchestrator mode the new route shows in the mode prompt on your next
   step; the user can confirm with `/subagent <role>`.
4. After the task, restore the backup or keep the change on purpose, and say
   which.

Log the override in `decisions.md` (role, old → new, backup path, who asked) and
copy the resulting routes into contract.md §2.

Every role shares its route: two worker parties cannot run on two models in the
same wave. Put them in different waves and change the route between them, or
give one of them another role.
